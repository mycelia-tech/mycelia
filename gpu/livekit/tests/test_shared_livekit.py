import asyncio
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = Path(os.environ.get("WLK_UPSTREAM", "/private/tmp/whisperlivekit-upstream"))


def load_helper():
    spec = importlib.util.spec_from_file_location("shared_livekit", ROOT / "shared_livekit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SharedLiveKitTests(unittest.TestCase):
    def test_remote_settings_fail_closed_and_select_model(self):
        helper = load_helper()
        with self.assertRaises(ValueError):
            helper.remote_settings({"OPENAI_API_KEY": "token"})
        with self.assertRaises(ValueError):
            helper.remote_settings({"OPENAI_BASE_URL": "http://live-asr:8002/v1"})
        with self.assertRaises(ValueError):
            helper.remote_settings({"OPENAI_BASE_URL": "https://api.openai.com/v1", "OPENAI_API_KEY": "token"})
        settings = helper.remote_settings({
            "OPENAI_BASE_URL": "http://live-asr:8002/v1",
            "OPENAI_API_KEY": "token",
            "WLK_ASR_MODEL": "large-v3-turbo",
        })
        self.assertEqual(settings.model, "large-v3-turbo")
        self.assertEqual(settings.timeout, 15.0)
        self.assertEqual(settings.max_retries, 1)

    def test_capability_requires_loaded_sortformer_and_remote_asr(self):
        helper = load_helper()
        self.assertEqual(helper.config_message(True, "full", True, "sortformer", "openai-api", True), {
            "type": "config", "useAudioWorklet": True, "mode": "full",
            "diarization": True, "stt_provider": "whisperlivekit-remote",
        })
        self.assertNotIn("diarization", helper.config_message(True, "full", True, "sortformer", "openai-api", False))
        self.assertNotIn("diarization", helper.config_message(True, "full", False, "sortformer", "openai-api", True))

    def test_only_one_session_and_slot_released(self):
        helper = load_helper()
        gate = helper.SessionGate()
        self.assertTrue(gate.try_acquire())
        self.assertFalse(gate.try_acquire())
        gate.release()
        self.assertTrue(gate.try_acquire())

    def test_cancelled_remote_call_drains_thread_before_release(self):
        helper = load_helper()
        started = threading.Event()
        finish = threading.Event()

        def blocking_remote_call():
            started.set()
            finish.wait(2)
            return "done"

        async def scenario():
            calls = helper.TrackedRemoteCalls()
            caller = asyncio.create_task(calls.run(blocking_remote_call))
            await asyncio.to_thread(started.wait, 2)
            caller.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await caller
            drain = asyncio.create_task(calls.drain())
            await asyncio.sleep(0.02)
            self.assertFalse(drain.done())
            drain.cancel()  # cleanup must still join HTTP on server shutdown
            await asyncio.sleep(0.02)
            self.assertFalse(drain.done())
            finish.set()
            await drain

        try:
            asyncio.run(scenario())
        finally:
            finish.set()

    def test_short_sortformer_tail_is_padded_and_clipped_before_silence(self):
        helper = load_helper()

        class FakeSortformer:
            chunk_duration_seconds = 1.0
            sample_rate = 16000
            buffer_audio = [1] * 8000
            _chunk_index = 0
            global_time_offset = 0.0

            async def diarize(self):
                self.processed_samples = len(self.buffer_audio)
                self.buffer_audio = []
                self._chunk_index += 1
                return [SimpleNamespace(start=0.0, end=1.0, speaker=0)]

        sortformer = FakeSortformer()
        segments = asyncio.run(helper.flush_sortformer_tail(sortformer, lambda audio, padding: audio + [0] * padding[1]))
        self.assertEqual(sortformer.processed_samples, 16000)
        self.assertEqual(segments[0].end, 0.5)
        self.assertEqual(sortformer.global_time_offset, -0.5)
        sortformer.global_time_offset += 2.0  # upstream insert_silence(2.0)
        next_start = sortformer._chunk_index * sortformer.chunk_duration_seconds + sortformer.global_time_offset
        self.assertEqual(next_start, 2.5)

    def test_patch_applies_to_exact_upstream_and_preserves_eof_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in ("basic_server.py", "local_agreement/backends.py", "audio_processor.py", "timed_objects.py", "tokens_alignment.py", "diarization/sortformer_backend.py"):
                destination = target / "whisperlivekit" / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((UPSTREAM / "whisperlivekit" / name).read_bytes())
            result = subprocess.run([sys.executable, str(ROOT / "patch_upstream.py"), str(target)], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            server = (target / "whisperlivekit/basic_server.py").read_text()
            backend = (target / "whisperlivekit/local_agreement/backends.py").read_text()
            processor = (target / "whisperlivekit/audio_processor.py").read_text()
            alignment = (target / "whisperlivekit/tokens_alignment.py").read_text()
            self.assertIn('await audio_processor.process_audio(message)', server)
            self.assertIn('"ready_to_stop"', server)
            self.assertIn('code=4409', server)
            self.assertIn('remote_settings', backend)
            self.assertIn('self._fatal_asr_error = True', processor)
            self.assertIn('self._fatal_diarization_error = True', processor)
            self.assertIn('await self._remote_calls.drain()', processor)
            self.assertIn('await self._update_diarization_state(await self.diarization.flush())', processor)
            self.assertIn('processing_done = self.is_stopping and self._processing_tasks_done()', processor)
            self.assertIn('if processing_done:', processor)
            self.assertIn('raise RuntimeError("remote ASR failed")', processor)
            self.assertIn('return (speaker if speaker is not None else -1)', alignment)
            self.assertIn('route.path not in {"/v1/listen", "/v1/audio/transcriptions"}', server)
            spec = importlib.util.spec_from_file_location("wlk_timed_objects", target / "whisperlivekit/timed_objects.py")
            timed = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = timed
            spec.loader.exec_module(timed)
            unknown = timed.Segment(start=0, end=1, text="hello", speaker=-1)
            self.assertIsNone(unknown.to_dict()["speaker"])
            subprocess.run([sys.executable, "-m", "compileall", "-q", str(target)], check=True)
            # A drifted source must stop the build before any patched image is produced.
            with (target / "whisperlivekit/basic_server.py").open("a") as source:
                source.write("\n# drift\n")
            result = subprocess.run([sys.executable, str(ROOT / "patch_upstream.py"), str(target)], capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
