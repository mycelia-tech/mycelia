"""Apply the Mycelia overlay only to pinned WhisperLiveKit v0.2.26 source."""

import hashlib
import sys
from pathlib import Path

EXPECTED = {
    "whisperlivekit/basic_server.py": "3557647e74e76d689f603ff59233502931f1559f4f376805f063a85d2283e999",
    "whisperlivekit/local_agreement/backends.py": "698317d958c76e3c369303fad1444369245d15c431f92e4e49866fe00000c9ea",
    "whisperlivekit/audio_processor.py": "5d39b72b877cec20677ef906c81a85be9d4b3c9e0d2569a045a334a7c900623a",
    "whisperlivekit/timed_objects.py": "608ef4f8ac279ecde43ef7a658a6164c0ec2596a3faadd9836cf0f853a2dc261",
    "whisperlivekit/tokens_alignment.py": "c127925aea1cff96b11ed0177f4e1b8888f84a71817ebb9890c4076cb2131617",
    "whisperlivekit/diarization/sortformer_backend.py": "b71c1dc060b1ecb17805c2805f330469fc75f679f0d228393cdf8be9a5028c85",
}


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f"expected exactly one upstream anchor, found {text.count(old)}")
    return text.replace(old, new, 1)


def patch_backend(source):
    source = replace_once(source, "import io\n", "import io\nimport os\n")
    source = replace_once(
        source,
        "from whisperlivekit.model_paths import detect_model_format, resolve_model_path\n",
        "from whisperlivekit.model_paths import detect_model_format, resolve_model_path\n"
        "from whisperlivekit.shared_livekit import remote_settings\n",
    )
    source = replace_once(source, '        self.modelname = "whisper-1"\n', '        self.modelname = None  # set from the explicitly configured private ASR endpoint\n')
    source = replace_once(
        source,
        "        from openai import OpenAI\n        self.client = OpenAI()\n        self.transcribed_seconds = 0\n",
        "        from openai import OpenAI\n"
        "        settings = remote_settings(os.environ)\n"
        "        self.modelname = settings.model\n"
        "        self.client = OpenAI(\n"
        "            base_url=settings.base_url, api_key=settings.api_key,\n"
        "            timeout=settings.timeout, max_retries=settings.max_retries,\n"
        "        )\n"
        "        self.transcribed_seconds = 0\n",
    )
    return source


def patch_server(source):
    source = replace_once(
        source,
        "from whisperlivekit.config import parse_cors_origins\n",
        "from whisperlivekit.config import parse_cors_origins\n"
        "from whisperlivekit.shared_livekit import SessionGate, config_message, remote_settings\n",
    )
    source = replace_once(
        source,
        "_API_TOKEN = getattr(config, \"api_token\", None) or os.environ.get(\"WLK_API_TOKEN\") or None\n",
        "_API_TOKEN = getattr(config, \"api_token\", None) or os.environ.get(\"WLK_API_TOKEN\") or None\n"
        "if not _API_TOKEN:\n"
        "    raise RuntimeError(\"WLK_API_TOKEN is required for public WebSocket authentication\")\n"
        "remote_settings(os.environ)  # fail closed before server startup\n"
        "_asr_gate = SessionGate()\n",
    )
    source = replace_once(
        source,
        "    except Exception as e:\n        logger.exception(f\"Error in WebSocket results handler: {e}\")\n\n\n@app.websocket(\"/asr\")\nasync def websocket_endpoint(websocket: WebSocket):\n",
        "    except Exception:\n"
        "        logger.exception(\"Live ASR results failed\")\n"
        "        try:\n"
        "            await websocket.send_json({\"type\": \"error\", \"error\": \"live ASR processing failed\"})\n"
        "            await websocket.close(code=1011, reason=\"live ASR processing failed\")\n"
        "        except (RuntimeError, WebSocketDisconnect):\n"
        "            pass\n\n\n"
        "@app.websocket(\"/asr\")\n"
        "async def websocket_endpoint(websocket: WebSocket):\n"
        "    if not _token_ok(websocket_token(websocket)):\n"
        "        await websocket.close(code=4401, reason=\"invalid or missing API token\")\n"
        "        return\n"
        "    if not _asr_gate.try_acquire():\n"
        "        await websocket.accept()\n"
        "        await websocket.send_json({\"type\": \"error\", \"error\": \"live session busy\"})\n"
        "        await websocket.close(code=4409, reason=\"live session busy\")\n"
        "        return\n"
        "    try:\n"
        "        await _serve_asr(websocket)\n"
        "    finally:\n"
        "        _asr_gate.release()\n\n\n"
        "async def _serve_asr(websocket: WebSocket):\n",
    )
    source = replace_once(
        source,
        '        await websocket.send_json({"type": "config", "useAudioWorklet": bool(config.pcm_input), "mode": mode})\n',
        '        await websocket.send_json(config_message(\n'
        '            config.pcm_input, mode, config.diarization, config.diarization_backend,\n'
        '            config.backend, getattr(transcription_engine, "diarization_model", None) is not None,\n'
        '        ))\n',
    )
    source = replace_once(
        source,
        "            message = await websocket.receive_bytes()\n            await audio_processor.process_audio(message)\n",
        "            message = await websocket.receive_bytes()\n"
        "            await audio_processor.process_audio(message)\n"
        "            if not message:  # binary EOF: drain results before session cleanup\n"
        "                await websocket_task\n"
        "                break\n",
    )
    source = replace_once(
        source,
        "def main():\n    \"\"\"Entry point for the CLI command.\"\"\"\n",
        "# This deployment serves only the authenticated /asr stream. Public batch\n"
        "# transcription remains on the existing :8001 proxy.\n"
        "app.router.routes = [\n"
        "    route for route in app.router.routes\n"
        "    if route.path not in {\"/v1/listen\", \"/v1/audio/transcriptions\"}\n"
        "]\n\n\n"
        "def main():\n    \"\"\"Entry point for the CLI command.\"\"\"\n",
    )
    return source


def patch_processor(source):
    source = replace_once(
        source,
        "from whisperlivekit.metrics_collector import SessionMetrics\n",
        "from whisperlivekit.metrics_collector import SessionMetrics\n"
        "from whisperlivekit.shared_livekit import TrackedRemoteCalls\n",
    )
    source = replace_once(
        source,
        "        self._silent_backend_warned: bool = False\n",
        "        self._silent_backend_warned: bool = False\n"
        "        self._fatal_asr_error = False\n"
        "        self._fatal_diarization_error = False\n"
        "        self._remote_calls = TrackedRemoteCalls()\n",
    )
    source = replace_once(
        source,
        "        tokens, processed_upto = await asyncio.to_thread(method, *args)\n",
        "        if self.args.backend == \"openai-api\":\n"
        "            tokens, processed_upto = await self._remote_calls.run(method, *args)\n"
        "        else:\n"
        "            tokens, processed_upto = await asyncio.to_thread(method, *args)\n",
    )
    source = replace_once(
        source,
        "        if created_tasks:\n            await asyncio.gather(*created_tasks, return_exceptions=True)\n"
        "        logger.info(\"All processing tasks cancelled or finished.\")\n",
        "        if created_tasks:\n"
        "            try:\n"
        "                await asyncio.gather(*created_tasks, return_exceptions=True)\n"
        "            except asyncio.CancelledError:\n"
        "                pass  # remote calls still must drain before admission is freed\n"
        "        await self._remote_calls.drain()\n"
        "        logger.info(\"All processing tasks cancelled or finished.\")\n",
    )
    source = replace_once(
        source,
        '        except Exception as e:\n            logger.warning(f"Error finishing transcription: {e}")\n            logger.debug(f"Traceback: {traceback.format_exc()}")\n',
        '        except Exception as e:\n'
        '            if self.args.backend == "openai-api":\n'
        '                self._fatal_asr_error = True\n'
        '                raise\n'
        '            logger.warning(f"Error finishing transcription: {e}")\n'
        '            logger.debug(f"Traceback: {traceback.format_exc()}")\n',
    )
    source = replace_once(
        source,
        '            except Exception as e:\n                logger.warning(f"Exception in transcription_processor: {e}")\n',
        '            except Exception as e:\n'
        '                if self.args.backend == "openai-api":\n'
        '                    self._fatal_asr_error = True\n'
        '                    raise\n'
        '                logger.warning(f"Exception in transcription_processor: {e}")\n',
    )
    source = replace_once(
        source,
        "                elif isinstance(item, Silence):\n"
        "                    if item.has_ended:\n"
        "                        self.diarization.insert_silence(item.duration)\n"
        "                    continue\n",
        "                elif isinstance(item, Silence):\n"
        "                    if item.has_ended:\n"
        "                        if has_buffer:\n"
        "                            await self._update_diarization_state(await self.diarization.flush())\n"
        "                        self.diarization.insert_silence(item.duration)\n"
        "                    continue\n",
    )
    source = replace_once(
        source,
        '            except Exception as e:\n'
        '                logger.warning(f"Exception in diarization_processor: {e}")\n'
        '                logger.warning(f"Traceback: {traceback.format_exc()}")\n',
        '            except Exception as e:\n'
        '                logger.error(f"Exception in diarization_processor: {e}")\n'
        '                self._fatal_diarization_error = True\n'
        '                raise\n',
    )
    source = replace_once(
        source,
        "        # Drain any remaining audio in the buffer before exiting\n"
        "        if has_buffer:\n"
        "            try:\n"
        "                await self._drain_diarization_buffer()\n"
        "            except Exception as e:\n"
        "                logger.warning(f\"Exception draining diarization buffer: {e}\")\n",
        "        # Flush a sub-chunk tail at EOF and fail the stream if inference fails.\n"
        "        if has_buffer:\n"
        "            try:\n"
        "                await self._drain_diarization_buffer()\n"
        "                await self._update_diarization_state(await self.diarization.flush())\n"
        "            except Exception:\n"
        "                self._fatal_diarization_error = True\n"
        "                raise\n",
    )
    source = replace_once(
        source,
        '    async def results_formatter(self) -> AsyncGenerator[FrontData, None]:\n        """Format processing results for output."""\n        while True:\n            try:\n',
        '    async def results_formatter(self) -> AsyncGenerator[FrontData, None]:\n'
        '        """Format processing results for output."""\n'
        '        while True:\n'
        '            if self._fatal_asr_error:\n'
        '                raise RuntimeError("remote ASR failed")\n'
        '            if self._fatal_diarization_error:\n'
        '                raise RuntimeError("Sortformer diarization failed")\n'
        '            processing_done = self.is_stopping and self._processing_tasks_done()\n'
        '            try:\n',
    )
    source = replace_once(
        source,
        '                if self.is_stopping and self._processing_tasks_done():\n',
        '                if processing_done:\n',
    )
    return source


def patch_timed_objects(source):
    return replace_once(
        source,
        "            'speaker': int(self.speaker) if self.speaker != -1 else 1,\n",
        "            'speaker': int(self.speaker) if self.speaker not in (-1, None) else None,\n",
    )


def patch_alignment(source):
    return replace_once(
        source,
        "        return (speaker if speaker is not None else 1), segment_index\n",
        "        return (speaker if speaker is not None else -1), segment_index\n",
    )


def patch_sortformer(source):
    source = replace_once(
        source,
        "from whisperlivekit.timed_objects import SpeakerSegment\n",
        "from whisperlivekit.timed_objects import SpeakerSegment\n"
        "from whisperlivekit.shared_livekit import flush_sortformer_tail\n",
    )
    source = replace_once(
        source,
        "    def get_segments(self) -> List[SpeakerSegment]:\n",
        "    async def flush(self):\n"
        "        return await flush_sortformer_tail(self, np.pad)\n\n"
        "    def get_segments(self) -> List[SpeakerSegment]:\n",
    )
    return source


def main(root):
    root = Path(root)
    for relative, expected in EXPECTED.items():
        content = (root / relative).read_bytes()
        actual = hashlib.sha256(content).hexdigest()
        if actual != expected:
            raise RuntimeError(f"upstream source drift: {relative} has SHA256 {actual}, expected {expected}")
    backend = root / "whisperlivekit/local_agreement/backends.py"
    server = root / "whisperlivekit/basic_server.py"
    processor = root / "whisperlivekit/audio_processor.py"
    timed_objects = root / "whisperlivekit/timed_objects.py"
    alignment = root / "whisperlivekit/tokens_alignment.py"
    sortformer = root / "whisperlivekit/diarization/sortformer_backend.py"
    backend.write_text(patch_backend(backend.read_text()))
    server.write_text(patch_server(server.read_text()))
    processor.write_text(patch_processor(processor.read_text()))
    timed_objects.write_text(patch_timed_objects(timed_objects.read_text()))
    alignment.write_text(patch_alignment(alignment.read_text()))
    sortformer.write_text(patch_sortformer(sortformer.read_text()))
    helper = Path(__file__).with_name("shared_livekit.py")
    (root / "whisperlivekit/shared_livekit.py").write_bytes(helper.read_bytes())


if __name__ == "__main__":
    main(sys.argv[1])
