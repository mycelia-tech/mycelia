"""Acceptance checks must distinguish Omi heartbeats from failed streams."""

import asyncio
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verifier", Path(__file__).parents[1] / "verify_shared_audio.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class VerifierTests(unittest.TestCase):
    def test_repeat_pcm_is_exact_and_paced_through_final_sample(self):
        async def scenario(duration, oversleep=0):
            clock = SimpleNamespace(now=0.0)

            async def sleep(delay):
                clock.now += delay + oversleep
                await asyncio.sleep(0)

            class Socket:
                def __init__(self):
                    self.eof = asyncio.Event()
                    self.sent = []
                    self.eof_time = None

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    pass

                async def send(self, data):
                    if data:
                        self.sent.append((clock.now, data))
                    else:
                        self.eof_time = clock.now
                        self.eof.set()

                def __aiter__(self):
                    return self.frames()

                async def frames(self):
                    yield '{"type":"config","diarization":true}'
                    await self.eof.wait()
                    yield '{"type":"ready_to_stop"}'

            socket = Socket()
            pcm = bytes(range(250)) * 4 + b'\x01\x02'  # 501 samples: not a 100 ms frame.
            count = round(duration * verifier.RATE)
            with (patch.dict(sys.modules, {"websockets": SimpleNamespace(connect=lambda *a, **kw: socket)}),
                  patch.object(verifier, "time", SimpleNamespace(monotonic=lambda: clock.now)),
                  patch.object(verifier, "asyncio", SimpleNamespace(
                      **{name: getattr(asyncio, name) for name in ("create_task", "timeout", "gather", "CancelledError")},
                      sleep=sleep)), redirect_stdout(io.StringIO())):
                report = await verifier.stream("ws://localhost/asr", "test-only", pcm, duration, False, "en")
            received = b''.join(data for _, data in socket.sent)
            expected = (pcm * ((count * 2 + len(pcm) - 1) // len(pcm)))[:count * 2]
            self.assertEqual(received, expected)
            self.assertEqual(report["audio_samples_sent"], count)
            self.assertEqual(report["target_audio_samples"], count)
            self.assertAlmostEqual(report["audio_sent_s"], count / verifier.RATE, places=6)
            self.assertEqual(report["opus_padding_s"], 0)
            self.assertAlmostEqual(report["audio_pacing_elapsed_s"], count / verifier.RATE + oversleep)
            self.assertEqual(report["pacing_lag"]["count"], len(socket.sent))
            self.assertAlmostEqual(report["pacing_lag"]["max_s"], oversleep)
            self.assertAlmostEqual(socket.eof_time - socket.sent[0][0], count / verifier.RATE)
            offset = 0
            for sent_at, frame in socket.sent:
                self.assertAlmostEqual(sent_at - socket.sent[0][0], offset / 32000)
                offset += len(frame)
            self.assertTrue(report["eof_ack"])

        for duration in (1 / verifier.RATE, 0.23125, 1.33701, 600):
            with self.subTest(duration=duration):
                asyncio.run(scenario(duration))
        asyncio.run(scenario(0.23125, oversleep=0.025))

    def test_eof_failure_is_not_success_even_after_all_audio_sent(self):
        async def scenario(reader_error):
            class Socket:
                def __init__(self):
                    self.eof = asyncio.Event()

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    pass

                async def send(self, data):
                    if not data:
                        self.eof.set()

                def __aiter__(self):
                    return self.frames()

                async def frames(self):
                    yield '{"type":"config","diarization":true}'
                    await self.eof.wait()
                    if reader_error:
                        error = RuntimeError("private transcript and token must stay private")
                        error.rcvd = SimpleNamespace(code=1009, reason="private peer reason")
                        raise error

            args = SimpleNamespace(fixture=None, token_file=None, omi_url=None,
                                   wlk_url="ws://localhost/asr", batch_url=None, duration=0.001,
                                   language="en", reconnect_check=False)
            with (patch.dict(sys.modules, {"websockets": SimpleNamespace(connect=lambda *a, **kw: Socket())}),
                  patch.object(verifier, "fixture", return_value=(bytes(1002), b"wav")),
                  patch.object(verifier, "token_file", return_value="test-only")):
                report = await verifier.run(args)
            self.assertFalse(report["checks"]["stream_completed"])
            self.assertFalse(report["checks"]["eof_ack_observed"])
            self.assertTrue(report["checks"]["requested_audio_sent"])
            self.assertTrue(report["checks"]["pacing_duration_observed"])
            self.assertEqual(report["failure"]["close_category"], "message_too_big" if reader_error else "unclassified")
            self.assertNotIn("private", json.dumps(report))
            self.assertNotIn("test-only", json.dumps(report))

        for reader_error in (True, False):
            with self.subTest(reader_error=reader_error):
                asyncio.run(scenario(reader_error))

    def test_snapshot_sizes_and_progress_age_are_separate_from_heartbeats(self):
        clock = SimpleNamespace(now=0.0)
        with patch.object(verifier, "time", SimpleNamespace(monotonic=lambda: clock.now)):
            stats = verifier.StreamStats(omi=True)
            stats.audio_start = 0
            text = json.dumps({"type": "local_transcript_snapshot", "segments": [{"text": "речь", "end": 1}]}, ensure_ascii=False)

            async def frames():
                clock.now = 3
                yield text
                clock.now = 10
                yield "ping"

            asyncio.run(verifier.receive(frames(), stats))
            report = stats.report()
            self.assertEqual(report["snapshot_bytes_max"], len(text.encode('utf-8')))
            self.assertEqual(report["snapshot_bytes_last"], len(text.encode('utf-8')))
            self.assertEqual(report["last_progress_age_s"], 7)
            self.assertEqual(report["last_snapshot_age_s"], 7)
            self.assertEqual(report["last_message_age_s"], 0)
            self.assertEqual(report["audio_relative_lag_intervals"][0]["max_s"], 2)

    def test_lag_intervals_are_bounded_and_do_not_hide_stalled_progress(self):
        clock = SimpleNamespace(now=0.0)
        with patch.object(verifier, "time", SimpleNamespace(monotonic=lambda: clock.now)):
            stats = verifier.StreamStats(omi=False)
            stats.audio_start = 0
            for interval in range(verifier.MAX_LAG_INTERVALS + 2):
                clock.now = interval * verifier.LAG_INTERVAL_S + 10
                stats.on_message({"lines": [{"text": "unused", "end": clock.now - 2}]}, wire_bytes=100 + interval)
            last_end = stats.last_end
            clock.now += 100
            stats.on_message({"lines": [{"text": "unused", "end": last_end}]}, wire_bytes=101)
            report = stats.report()
        self.assertEqual(len(report["audio_relative_lag_intervals"]), verifier.MAX_LAG_INTERVALS)
        self.assertEqual(report["audio_relative_lag_intervals"][0]["start_s"], 2 * verifier.LAG_INTERVAL_S)
        self.assertEqual(report["last_progress_age_s"], 100)
        self.assertEqual(report["last_snapshot_age_s"], 0)
        self.assertEqual(report["snapshot_bytes_max"], 100 + verifier.MAX_LAG_INTERVALS + 1)
        self.assertEqual(report["snapshot_bytes_last"], 101)
        self.assertEqual(report["audio_relative_line_lag"]["count"], verifier.MAX_LAG_INTERVALS + 2)

    def test_omi_reader_failure_and_deliberate_cleanup_cancellation(self):
        class Socket:
            def __init__(self, fail):
                self.closing = asyncio.Event()
                self.exited = False
                self.fail = fail
                self.reader_finished = False

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                self.exited = True

            async def send(self, data):
                pass

            async def close(self):
                self.closing.set()
                await asyncio.sleep(0)

            def __aiter__(self):
                return self.frames()

            async def frames(self):
                yield '{"type":"service_status","status":"ready"}'
                yield '{"type":"local_transcript_snapshot","segments":[{"text":"test","end":0.1}]}'
                try:
                    await self.closing.wait()
                    if self.fail:
                        yield '{"type":"malformed","status":[]}'
                    else:
                        await asyncio.Event().wait()
                finally:
                    self.reader_finished = True

        async def scenario(fail):
            socket = Socket(fail)
            modules = {
                "websockets": SimpleNamespace(connect=lambda *args, **kwargs: socket),
                "opuslib": SimpleNamespace(
                    APPLICATION_AUDIO=1,
                    Encoder=lambda *args: SimpleNamespace(encode=lambda *args: b"audio"),
                ),
            }
            args = SimpleNamespace(fixture=None, token_file=None, omi_url="http://localhost:21000",
                                   batch_url=None, duration=0.01, language="en", reconnect_check=False)
            with (patch.dict(sys.modules, modules),
                  patch.object(verifier, "fixture", return_value=(bytes(320), b"wav")),
                  patch.object(verifier, "token_file", return_value="test-only")):
                report = await verifier.run(args)
            self.assertTrue(socket.exited)
            self.assertTrue(socket.reader_finished)
            self.assertIsNotNone(report["stream"]["first_committed_text_s"])
            self.assertEqual(report["checks"]["stream_completed"], not fail)
            self.assertEqual(report["stream"]["audio_samples_sent"], 160)
            self.assertEqual(report["stream"]["opus_padding_s"], 0.01)
            if fail:
                self.assertEqual(report["failure"]["type"], "TypeError")
            else:
                self.assertNotIn("failure", report)
            self.assertNotIn("test-only", json.dumps(report))

        for fail in (True, False):
            with self.subTest(fail=fail):
                asyncio.run(scenario(fail))

    def test_reconnect_protocol_error_fails_cli_and_preserves_report(self):
        calls = 0

        async def stream(*args):
            nonlocal calls
            calls += 1
            return {"first_committed_text_s": 0.1, "protocol_errors": int(calls == 2), "eof_ack": True}

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            argv = ["verify_shared_audio.py", "--wlk-url", "ws://localhost/asr",
                    "--token-file", "unused-token", "--fixture", "unused-fixture",
                    "--duration", "0.1", "--reconnect-check", "--json-output", str(output)]
            with (patch.object(sys, "argv", argv),
                  patch.object(verifier, "fixture", return_value=(bytes(320), b"wav")),
                  patch.object(verifier, "token_file", return_value="test-only"),
                  patch.object(verifier, "stream", stream)):
                self.assertEqual(verifier.main(), 2)
            report = json.loads(output.read_text())
            self.assertTrue(report["checks"]["reconnect_text_observed"])
            self.assertFalse(report["checks"]["no_protocol_errors"])
            self.assertEqual(report["reconnect"]["protocol_errors"], 1)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_omi_heartbeat_is_not_a_protocol_error(self):
        async def frames():
            yield "ping"
            yield '{"type":"service_status","status":"ready"}'
            yield '{"type":"service_status","status":"stt_failed"}'

        stats = verifier.StreamStats(omi=True)
        asyncio.run(verifier.receive(frames(), stats))
        self.assertEqual(stats.heartbeats, 1)
        self.assertEqual(stats.errors, 1)
        self.assertIsNotNone(stats.ready)

    def test_disconnect_retains_partial_report_and_fails_acceptance(self):
        async def fail(*args):
            stats = args[-1]
            stats.sent_s = 10
            error = RuntimeError("must not appear in report")
            error.sent = SimpleNamespace(code=1011, reason="keepalive ping timeout")
            raise error

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            token = root / "token"
            token.write_text("test-only")
            token.chmod(0o600)
            audio = root / "fixture.wav"
            with wave.open(str(audio), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(b"\0\0" * 160)
            args = SimpleNamespace(fixture=audio, token_file=token, omi_url="http://localhost:21000",
                                   batch_url=None, duration=1800, language="en", reconnect_check=False)
            with patch.object(verifier, "stream", fail):
                report = asyncio.run(verifier.run(args))
        self.assertFalse(report["checks"]["stream_completed"])
        self.assertEqual(report["stream"]["audio_sent_s"], 10)
        self.assertTrue(report["failure"]["keepalive_timeout"])
        self.assertNotIn("must not appear", str(report))


if __name__ == "__main__":
    unittest.main()
