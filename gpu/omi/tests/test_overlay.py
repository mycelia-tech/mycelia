"""Run inside the built compatibility image with an isolated temporary root."""

import importlib.util
import json
import tempfile
import unittest
import uuid
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dev_harness import cli, config, local_provider_relay, local_stt_services
from utils import offline_audio_capture as capture


class CaptureCheckpointTests(unittest.TestCase):
    def new_capture(self, root: Path) -> capture.OfflineAudioCapture:
        return capture.OfflineAudioCapture(
            session_id=str(uuid.uuid4()), source="omi", input_codec="opus_fs320", root=root
        )

    def test_checkpoint_rate_and_exact_final_metadata(self):
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(capture.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(capture, "_atomic_json", wraps=capture._atomic_json) as write:
            sink = self.new_capture(Path(directory))
            frame = b"\x01\x00" * 320
            for _ in range(50):
                sink.record_decoded_frame(encoded_bytes=18, pcm=frame)
            self.assertEqual(write.call_count, 2)  # Initial metadata and first packet.
            clock[0] = 1.0
            sink.record_decode_error(encoded_bytes=7)
            self.assertEqual(write.call_count, 3)
            final = sink.finalize()
            self.assertEqual(write.call_count, 4)
            self.assertEqual(final["frames_received"], 51)
            self.assertEqual(final["decode_errors"], 1)
            self.assertEqual(final["decoded_pcm_bytes"], len(frame) * 50)
            self.assertEqual(json.loads(sink.metadata_path.read_text()), final)

    def test_crash_recovery_uses_actual_pcm_tail(self):
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(capture.time, "monotonic", side_effect=lambda: clock[0]):
            sink = self.new_capture(Path(directory))
            frame = b"\x02\x00" * 320
            sink.record_decoded_frame(encoded_bytes=18, pcm=frame)
            clock[0] = 0.5
            sink.record_decoded_frame(encoded_bytes=18, pcm=frame)
            checkpoint = json.loads(sink.metadata_part_path.read_text())
            self.assertEqual(checkpoint["decoded_pcm_bytes"], len(frame))
            sink._pcm.close()  # Simulate process death before finalization.
            self.assertTrue(capture._recover_one(sink.pcm_part_path))
            recovered = json.loads(sink.metadata_path.read_text())
            self.assertEqual(recovered["status"], "recovered")
            self.assertEqual(recovered["decoded_pcm_bytes"], len(frame) * 2)
            with wave.open(str(sink.wav_path), "rb") as audio:
                self.assertEqual(audio.readframes(audio.getnframes()), frame * 2)


class OwnerReadinessRetryTests(unittest.TestCase):
    def helper(self, owner_check, clock):
        spec = importlib.util.spec_from_file_location("omi_docker_runtime_for_test", "/opt/omiloc/docker/runtime.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.time = clock
        module.local_mac = SimpleNamespace(ensure_owner_profile=owner_check)
        return module.wait_for_owner_profile

    def test_only_transient_timeouts_retry_until_success(self):
        elapsed = [0.0]
        calls = []

        def owner_check(cfg, uid):
            calls.append((cfg, uid))
            if len(calls) < 3:
                raise TimeoutError()

        clock = SimpleNamespace(monotonic=lambda: elapsed[0], sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        cfg = object()
        self.helper(owner_check, clock)(cfg, "owner", stopped=lambda: False)
        self.assertEqual(calls, [(cfg, "owner")] * 3)
        self.assertEqual(elapsed[0], 4.0)

    def test_nontransient_error_fails_without_retry(self):
        calls = []

        def owner_check(cfg, uid):
            calls.append((cfg, uid))
            raise ValueError("nontransient")

        clock = SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda _: self.fail("must not sleep"))
        with self.assertRaises(ValueError):
            self.helper(owner_check, clock)(object(), "owner", stopped=lambda: False)
        self.assertEqual(len(calls), 1)

    def test_retry_is_bounded_and_obeys_stop(self):
        elapsed = [0.0]

        def timeout_owner(_cfg, _uid):
            raise TimeoutError()

        clock = SimpleNamespace(monotonic=lambda: elapsed[0], sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        with self.assertRaises(TimeoutError):
            self.helper(timeout_owner, clock)(object(), "owner", stopped=lambda: False)
        self.assertEqual(elapsed[0], 120.0)

        stopped = [False]
        clock = SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda _: stopped.__setitem__(0, True))
        with self.assertRaises(RuntimeError):
            self.helper(timeout_owner, clock)(object(), "owner", stopped=lambda: stopped[0])


class InfrastructureReadinessTests(unittest.TestCase):
    def helper(self, port_check, clock):
        spec = importlib.util.spec_from_file_location("omi_docker_runtime_infrastructure_test", "/opt/omiloc/docker/runtime.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.time = clock
        module.cli = SimpleNamespace(_port_open=port_check)
        return module.wait_for_infrastructure

    def test_all_three_ports_required_after_slow_auth_start(self):
        elapsed = [0.0]
        observed = []

        def port_check(host, port):
            self.assertEqual(host, "127.0.0.1")
            observed.append(port)
            return port != 2 or elapsed[0] >= 10.0

        clock = SimpleNamespace(monotonic=lambda: elapsed[0], sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        cfg = SimpleNamespace(firestore_port=1, auth_port=2, redis_port=3)
        self.helper(port_check, clock)(cfg, stopped=lambda: False)
        self.assertEqual(elapsed[0], 10.0)
        self.assertEqual(observed, [1, 2, 3] * 21)

    def test_timeout_names_closed_port_and_stop_is_respected(self):
        elapsed = [0.0]
        clock = SimpleNamespace(monotonic=lambda: elapsed[0], sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        cfg = SimpleNamespace(firestore_port=1, auth_port=2, redis_port=3)
        helper = self.helper(lambda _host, port: port != 2, clock)
        with self.assertRaisesRegex(RuntimeError, "did not become ready: auth"):
            helper(cfg, stopped=lambda: False)
        self.assertEqual(elapsed[0], 300.0)

        stopped = [False]
        clock = SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda _: stopped.__setitem__(0, True))
        helper = self.helper(lambda _host, port: port != 2, clock)
        with self.assertRaisesRegex(RuntimeError, "did not become ready: auth"):
            helper(cfg, stopped=lambda: stopped[0])


class RelayReadinessTests(unittest.TestCase):
    def run_relay(self, healthy_after):
        elapsed = [0.0]
        checks = []
        cfg = SimpleNamespace(
            instance="test", local_transport="lan", provider_mode="offline",
            layout=SimpleNamespace(state_root=Path("/tmp/test-state")),
            repo_root=Path("/tmp"), backend_port=21000,
            firestore_port=21002, auth_port=21003, redis_port=21004,
            desktop_backend_port=21005, typesense_port=21006, llm_gateway_port=21007,
        )

        def health(_cfg, service):
            checks.append(service)
            return healthy_after is not None and len(checks) > healthy_after, "relay readiness"

        clock = SimpleNamespace(
            monotonic=lambda: elapsed[0],
            sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds),
        )
        with patch.object(local_stt_services, "time", clock), \
                patch.object(local_stt_services, "health", side_effect=health), \
                patch.object(cli, "_start_process"), \
                patch.object(config, "child_env_for", return_value={}), \
                patch.object(local_provider_relay, "port", return_value=21004):
            if healthy_after is None:
                with self.assertRaises(local_stt_services.ServiceError):
                    local_stt_services.start_provider_relay(cfg)
            else:
                local_stt_services.start_provider_relay(cfg)
        return elapsed[0], checks

    def test_relay_can_become_ready_after_old_six_second_limit(self):
        elapsed, checks = self.run_relay(20)
        self.assertEqual(elapsed, 10.0)
        self.assertEqual(checks, ["provider-relay"] * 21)

    def test_relay_unready_is_bounded_and_fails_closed(self):
        elapsed, checks = self.run_relay(None)
        self.assertEqual(elapsed, 60.0)
        self.assertEqual(checks, ["provider-relay"] * 120)


if __name__ == "__main__":
    unittest.main()
