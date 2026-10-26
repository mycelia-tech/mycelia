import asyncio
import ast
import importlib.util
import logging
import os
import subprocess
import sys
import tempfile
import threading
import traceback
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


def patched_methods(relative, class_name, method_names, extra=None):
    """Execute real patched methods without importing CUDA/ASR dependencies."""
    spec = importlib.util.spec_from_file_location("wlk_patch", ROOT / "patch_upstream.py")
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    source = (UPSTREAM / "whisperlivekit" / relative).read_text()
    source = (patch.patch_sortformer(source) if class_name == "SortformerDiarizationOnline"
              else patch.patch_processor(source))
    tree = ast.parse(source)
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    methods = [node for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
               and node.name in method_names]
    if len(methods) != len(method_names):
        raise AssertionError("missing patched methods")
    helper = load_helper()
    namespace = {"asyncio": asyncio, "logger": logging.getLogger("wlk_reliability_test"),
                 "processing_failure": helper.processing_failure,
                 "flush_sortformer_tail": helper.flush_sortformer_tail, **(extra or {})}
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
                             *methods], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(UPSTREAM / relative), "exec"), namespace)
    return {name: namespace[name] for name in method_names}, helper


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

            def _diarize_sync(self):
                self.processed_samples = len(self.buffer_audio)
                self.buffer_audio = []
                self._chunk_index += 1
                return [SimpleNamespace(start=0.0, end=1.0, speaker=0)]

        sortformer = FakeSortformer()
        segments = helper.flush_sortformer_tail(sortformer, lambda audio, padding: audio + [0] * padding[1])
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
            self.assertIn('self._fatal_asr_error = processing_failure("remote ASR", e)', processor)
            self.assertIn('self._fatal_diarization_error = processing_failure("Sortformer diarization", e)', processor)
            self.assertIn('await self._remote_calls.drain()', processor)
            self.assertIn('await self.diarization.drain()', processor)
            self.assertIn('await self._update_diarization_state(await self.diarization.flush())', processor)
            self.assertIn('processing_done = self.is_stopping and self._processing_tasks_done()', processor)
            self.assertIn('if processing_done:', processor)
            self.assertIn('raise self._fatal_asr_error from None', processor)
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

    def test_sortformer_worker_keeps_loop_responsive_and_cleanup_joins_before_close(self):
        methods, helper = patched_methods("diarization/sortformer_backend.py", "SortformerDiarizationOnline",
                                         {"diarize", "drain"})
        cleanup, _ = patched_methods("audio_processor.py", "AudioProcessor", {"cleanup"})
        started, release = threading.Event(), threading.Event()
        closed = []
        gate = helper.SessionGate()

        class FakeSortformer:
            diarize = methods["diarize"]
            drain = methods["drain"]

            def __init__(self):
                self._worker_calls = helper.TrackedWorkerCalls()

            def _diarize_sync(self):
                started.set()
                if not release.wait(2):
                    raise RuntimeError("test worker deadline")
                return []

            def close(self):
                closed.append(True)

        async def scenario():
            online = FakeSortformer()
            self.assertTrue(gate.try_acquire())
            inference = asyncio.create_task(online.diarize())
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            # The event loop can respond while synchronous native work is held.
            heartbeat = asyncio.Event()
            asyncio.get_running_loop().call_soon(heartbeat.set)
            await asyncio.wait_for(heartbeat.wait(), .2)
            processor = SimpleNamespace(
                all_tasks_for_cleanup=[inference], _remote_calls=helper.TrackedRemoteCalls(),
                args=SimpleNamespace(diarization_backend="sortformer"), diarization=online,
                is_pcm_input=True, metrics=SimpleNamespace(log_summary=lambda: None),
                total_pcm_samples=0, sample_rate=16000,
            )

            async def disconnect():
                await cleanup["cleanup"](processor)
                gate.release()

            ending = asyncio.create_task(disconnect())
            await asyncio.sleep(.02)
            self.assertFalse(gate.try_acquire())
            self.assertFalse(closed)
            self.assertFalse(ending.done())
            ending.cancel()  # repeated shutdown must not orphan the CUDA thread
            await asyncio.sleep(.02)
            self.assertFalse(ending.done())
            release.set()
            await asyncio.wait_for(ending, 1)
            self.assertTrue(closed)
            self.assertTrue(gate.try_acquire())

        try:
            asyncio.run(scenario())
        finally:
            release.set()

    def test_sortformer_tail_restores_clock_after_cancelled_compute_finishes(self):
        def pad(audio, padding):
            return audio + [0] * padding[1]
        methods, helper = patched_methods("diarization/sortformer_backend.py", "SortformerDiarizationOnline",
                                         {"flush", "drain"}, {"np": SimpleNamespace(pad=pad)})
        started, release = threading.Event(), threading.Event()
        offsets = []

        class FakeSortformer:
            flush, drain = methods["flush"], methods["drain"]
            sample_rate, chunk_duration_seconds = 16000, 1.0
            _chunk_index, global_time_offset = 0, 0.0
            buffer_audio = [1] * 8000

            def __init__(self):
                self._worker_calls = helper.TrackedWorkerCalls()

            def _diarize_sync(self):
                started.set()
                if not release.wait(2):
                    raise RuntimeError("test worker deadline")
                offsets.append(self.global_time_offset)
                self.buffer_audio = []
                self._chunk_index += 1
                return [SimpleNamespace(start=0.0, end=1.0, speaker=0)]

        async def scenario():
            online = FakeSortformer()
            flush = asyncio.create_task(online.flush())
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            flush.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await flush
            # Cancellation cannot restore the offset underneath native inference.
            self.assertEqual(online.global_time_offset, 0.0)
            release.set()
            await online.drain()
            self.assertEqual(offsets, [0.0])
            self.assertEqual(online.global_time_offset, -0.5)

        try:
            asyncio.run(scenario())
        finally:
            release.set()

    def test_worker_calls_remain_serial_after_first_caller_cancelled(self):
        helper = load_helper()
        started, release, second_started = threading.Event(), threading.Event(), threading.Event()

        def first():
            started.set()
            if not release.wait(2):
                raise RuntimeError("test worker deadline")

        async def scenario():
            calls = helper.TrackedWorkerCalls()
            caller = asyncio.create_task(calls.run(first))
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            caller.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await caller
            second = asyncio.create_task(calls.run(second_started.set))
            await asyncio.sleep(.02)
            self.assertFalse(second_started.is_set())
            release.set()
            await second
            await calls.drain()
            self.assertTrue(second_started.is_set())

        try:
            asyncio.run(scenario())
        finally:
            release.set()

    def test_failures_retain_original_type_status_location_without_private_message(self):
        secret = "TRANSCRIPT_AND_AUTHORIZATION_MUST_NOT_APPEAR"

        class UpstreamFailure(RuntimeError):
            status_code = 502

        try:
            raise UpstreamFailure(secret)
        except UpstreamFailure as error:
            original = error

        async def broken_queue(queue):
            raise original

        methods, helper = patched_methods("audio_processor.py", "AudioProcessor",
            {"transcription_processor", "diarization_processor", "results_formatter"},
            {"get_all_from_queue": broken_queue, "resolve_coalesce_min_s": lambda value: value})

        async def scenario(kind):
            processor = SimpleNamespace(
                args=SimpleNamespace(backend="openai-api"), transcription_queue=object(),
                diarization_queue=object(), diarization=SimpleNamespace(),
                _fatal_asr_error=False, _fatal_diarization_error=False,
            )
            with self.assertLogs("wlk_reliability_test", level="ERROR") as logged:
                with self.assertRaises(helper.ProcessingFailure) as raised:
                    await methods[kind + "_processor"](processor)
            failure = raised.exception
            self.assertIs(failure.original_error, original)
            self.assertIn("UpstreamFailure HTTP 502", str(failure))
            self.assertIn("test_shared_livekit.py:", str(failure))
            self.assertNotIn(secret, "\n".join(logged.output))
            generator = methods["results_formatter"](processor)
            with self.assertRaises(helper.ProcessingFailure) as forwarded:
                await generator.__anext__()
            self.assertIs(forwarded.exception, failure)
            # This is what logger.exception in the WebSocket handler emits.
            self.assertNotIn(secret, "".join(traceback.format_exception(forwarded.exception)))
            await generator.aclose()

        asyncio.run(scenario("transcription"))
        asyncio.run(scenario("diarization"))


if __name__ == "__main__":
    unittest.main()
