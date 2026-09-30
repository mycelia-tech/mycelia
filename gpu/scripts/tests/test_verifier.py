"""Acceptance checks must distinguish Omi heartbeats from failed streams."""

import asyncio
import importlib.util
import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verifier", Path(__file__).parents[1] / "verify_shared_audio.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class VerifierTests(unittest.TestCase):
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
