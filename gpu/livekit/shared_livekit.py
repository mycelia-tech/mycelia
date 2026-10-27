"""Small policy helpers for the pinned WhisperLiveKit remote-ASR overlay."""

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
import json
import re
import traceback
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

_LIVE_CONTEXT = ContextVar("live_diagnostics", default=None)
_UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
_ERROR_CODES = {"upstream_busy", "upstream_failed", "upstream_timeout", "upstream_unavailable",
                "invalid_timing_response", "model_mismatch", "empty_audio", "audio_too_large",
                "client_disconnected", "processing_failed", "diarization_failed"}


def _safe_id(value):
    return value if isinstance(value, str) and _UUID.fullmatch(value) else None


@contextmanager
def live_context(query):
    context = {"capture_id": _safe_id(query.get("capture_id")) or str(uuid4()),
               "session_id": str(uuid4())}
    window = query.get("window_index", "")
    if isinstance(window, str) and re.fullmatch(r"[0-9]{1,6}", window):
        context["window_index"] = int(window)
    token = _LIVE_CONTEXT.set(context)
    try:
        yield context
    finally:
        _LIVE_CONTEXT.reset(token)


def correlate_http_request(request):
    """httpx synchronous hook; asyncio.to_thread propagates the session context."""
    request.headers["X-Request-ID"] = str(uuid4())
    context = _LIVE_CONTEXT.get() or {}
    for key, header in (("capture_id", "X-Mycelia-Capture-ID"),
                        ("session_id", "X-Mycelia-Session-ID"),
                        ("window_index", "X-Mycelia-Window-Index")):
        if key in context:
            request.headers[header] = str(context[key])


def error_frame(error):
    failure = processing_failure("remote ASR", error)
    return {"type": "error", "error": "live ASR processing failed", **failure.diagnostics}


def log_failure(logger, error):
    # Do not use logger.exception: unwrapped SDK exceptions can include audio
    # text, authenticated endpoints and entire remote error responses.
    try:
        logger.error("%s", json.dumps({"event": "live_processing_failure", **error_frame(error)}, sort_keys=True))
    except Exception:
        pass


@dataclass(frozen=True)
class RemoteSettings:
    base_url: str
    api_key: str
    model: str
    timeout: float = 15.0
    max_retries: int = 1


def remote_settings(environ):
    base_url = environ.get("OPENAI_BASE_URL", "").strip().rstrip("/")
    api_key = environ.get("OPENAI_API_KEY", "").strip()
    model = environ.get("WLK_ASR_MODEL", "large-v3-turbo").strip()
    parsed = urlparse(base_url)
    if (parsed.scheme, parsed.hostname, parsed.port, parsed.path) != ("http", "live-asr", 8002, "/v1"):
        raise ValueError("OPENAI_BASE_URL must explicitly target http://live-asr:8002/v1")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required for the private live ASR listener")
    if not model:
        raise ValueError("WLK_ASR_MODEL must not be empty")
    return RemoteSettings(base_url, api_key, model)


def config_message(pcm_input, mode, diarization, backend, asr_backend, model_loaded):
    message = {"type": "config", "useAudioWorklet": bool(pcm_input), "mode": mode}
    if diarization and backend == "sortformer" and asr_backend == "openai-api" and model_loaded:
        message.update(diarization=True, stt_provider="whisperlivekit-remote")
    context = _LIVE_CONTEXT.get()
    if context:
        message["diagnostics"] = dict(context)
    return message


class SessionGate:
    """Admission gate for one ASR WebSocket per event-loop worker."""

    def __init__(self):
        self.active = False

    def try_acquire(self):
        if self.active:
            return False
        self.active = True
        return True

    def release(self):
        self.active = False


class ProcessingFailure(RuntimeError):
    """Keep the cause for inspection while logging no remote body or audio text."""

    def __init__(self, stage, error):
        self.original_error = error
        self.diagnostics = {**(_LIVE_CONTEXT.get() or {}),
                            "code": "diarization_failed" if stage == "Sortformer diarization" else "processing_failed"}
        details = []
        current, seen = error, set()
        while current is not None and id(current) not in seen and len(details) < 4:
            seen.add(id(current))
            kind = f"{type(current).__module__}.{type(current).__name__}"
            status = getattr(current, "status_code", None)
            if type(status) is int and 100 <= status <= 599:
                kind += f" HTTP {status}"
                self.diagnostics.setdefault("upstream_status", status)
            response = getattr(current, "response", None)
            request = getattr(current, "request", None)
            headers = getattr(response, "headers", {})
            request_headers = getattr(request, "headers", {})
            request_id = (_safe_id(headers.get("x-request-id"))
                          or _safe_id(getattr(current, "request_id", None))
                          or _safe_id(request_headers.get("x-request-id")))
            if request_id:
                self.diagnostics.setdefault("request_id", request_id)
            code = headers.get("x-live-error-code")
            if isinstance(code, str) and code in _ERROR_CODES:
                self.diagnostics["code"] = code
            # format_exception/format_tb include message or source text. Only
            # locations are safe when SDK errors can embed request/response data.
            frames = traceback.extract_tb(current.__traceback__)[-12:]
            locations = ", ".join(
                f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}"
                for frame in frames
            )
            details.append(kind + (f" at {locations}" if locations else ""))
            current = current.__cause__ or current.__context__
        super().__init__(f"{stage} failed: " + " <- ".join(details)
                         + " " + json.dumps(self.diagnostics, sort_keys=True))


def processing_failure(stage, error):
    return error if isinstance(error, ProcessingFailure) else ProcessingFailure(stage, error)


class TrackedWorkerCalls:
    """Serialize native work and join it even when its async caller is cancelled."""

    def __init__(self):
        self.pending = set()
        self.lock = asyncio.Lock()

    async def run(self, method, *args):
        async def invoke():
            # The shielded task owns this lock, not the cancellable caller.
            async with self.lock:
                return await asyncio.to_thread(method, *args)

        task = asyncio.create_task(invoke())
        self.pending.add(task)

        def complete(done):
            if not done.cancelled():
                done.exception()  # consume exceptions if caller was cancelled
            self.pending.discard(done)

        task.add_done_callback(complete)
        return await asyncio.shield(task)

    async def drain(self):
        # A cancelled WebSocket cannot release its slot while native work lives.
        while self.pending:
            try:
                await asyncio.shield(asyncio.gather(*tuple(self.pending), return_exceptions=True))
            except asyncio.CancelledError:
                continue


TrackedRemoteCalls = TrackedWorkerCalls


def flush_sortformer_tail(online, pad_audio):
    """Infer a short speech tail and remove padded time from the stream clock."""
    remaining = len(online.buffer_audio)
    if not remaining:
        return []
    threshold = int(online.chunk_duration_seconds * online.sample_rate)
    if remaining >= threshold:
        raise ValueError("drain full Sortformer chunks before flushing the tail")
    pad_samples = threshold - remaining
    true_end = (online._chunk_index * online.chunk_duration_seconds
                + online.global_time_offset + remaining / online.sample_rate)
    online.buffer_audio = pad_audio(online.buffer_audio, (0, pad_samples))
    try:
        segments = online._diarize_sync()
    finally:
        online.global_time_offset -= pad_samples / online.sample_rate
    clipped = []
    for segment in segments:
        segment.end = min(segment.end, true_end)
        if segment.start < segment.end:
            clipped.append(segment)
    return clipped
