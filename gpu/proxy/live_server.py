"""Private, authenticated WLK adapter; never published on a host port.

The public batch proxy intentionally retains its existing response contract.
Only this listener may assign live priority and flatten genuine word timings.
"""

import asyncio
import hmac
import json
import logging
import math
import os
import re
import time
from contextlib import suppress
from urllib.parse import urljoin
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

LIVE_ASR_TOKEN = os.getenv("LIVE_ASR_TOKEN", "")
ASR_MODEL = os.getenv("ASR_MODEL", "large-v3-turbo")
WHISPER_SERVICE_URL = os.getenv("WHISPER_SERVICE_URL", "http://whisper:9000")
LIVE_ASR_TIMEOUT_SECONDS = float(os.getenv("LIVE_ASR_TIMEOUT_SECONDS", "60"))
MAX_UPLOAD_BYTES = 16 * 1024 * 1024

app = FastAPI(title="Private live ASR adapter", docs_url=None, redoc_url=None)
security = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)
_UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def _opaque_id(value):
    return value if isinstance(value, str) and _UUID.fullmatch(value) else str(uuid4())


def request_context(request):
    # Only opaque UUIDs and a bounded integer cross the diagnostic boundary.
    # Never record a URL, filename, prompt, remote response or exception message.
    context = {"request_id": _opaque_id(request.headers.get("x-request-id")),
               "capture_id": _opaque_id(request.headers.get("x-mycelia-capture-id")),
               "session_id": _opaque_id(request.headers.get("x-mycelia-session-id"))}
    window = request.headers.get("x-mycelia-window-index", "")
    if re.fullmatch(r"[0-9]{1,6}", window):
        context["window_index"] = int(window)
    return context


def log_request(context, status, code, started):
    event = {"event": "live_asr_request", **context, "status": status,
                 "duration_ms": round((time.monotonic() - started) * 1000)}
    if code:
        event["code"] = code
    try:
        logger.log(logging.WARNING if status >= 400 else logging.INFO,
                   "%s", json.dumps(event, sort_keys=True))
    except Exception:
        pass  # Diagnostics must never change request success or failure.


class CorrelationMiddleware:
    """Pure ASGI: leave receive untouched so disconnect cancellation still works."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        context = request_context(Request(scope))
        state = scope.setdefault('state', {})
        state['diagnostics'] = context
        started, status = time.monotonic(), 500

        async def send_correlated(message):
            nonlocal status
            if message['type'] == 'http.response.start':
                status = message['status']
                headers = [(b'x-request-id', context['request_id'].encode()),
                           (b'x-mycelia-capture-id', context['capture_id'].encode()),
                           (b'x-mycelia-session-id', context['session_id'].encode())]
                if state.get('error_code'):
                    headers.append((b'x-live-error-code', state['error_code'].encode()))
                message = {**message, 'headers': [*message.get('headers', []), *headers]}
            await send(message)

        try:
            await self.app(scope, receive, send_correlated)
        finally:
            # Health polling does not need per-request logs.
            if scope.get('path') == '/v1/audio/transcriptions':
                log_request(context, status, state.get('error_code'), started)


app.add_middleware(CorrelationMiddleware)


def live_error(request, status, code, message):
    request.state.error_code = code
    return HTTPException(status, {"code": code, "message": message,
                                  **request.state.diagnostics})


def authorize(credentials: HTTPAuthorizationCredentials = Depends(security)):  # noqa: B008
    if not LIVE_ASR_TOKEN:
        raise HTTPException(503, "Live ASR token is not configured")
    if not credentials or not hmac.compare_digest(credentials.credentials, LIVE_ASR_TOKEN):
        raise HTTPException(401, "Invalid or missing live ASR token")


def add_word_timings(payload: dict) -> dict:
    """Expose exactly the timings returned by Whisper, never interpolation."""
    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise TypeError("Whisper response has no segments")
    words = []
    for segment in segments:
        segment_words = segment.get("words", [])
        if segment.get("text", "").strip() and not segment_words:
            raise ValueError("Whisper did not return requested word timestamps")
        for word in segment_words:
            start, end = word.get("start"), word.get("end")
            if (not isinstance(word.get("word"), str)
                    or type(start) not in (int, float) or type(end) not in (int, float)
                    or not math.isfinite(start) or not math.isfinite(end)
                    or start < 0 or end < start):
                raise ValueError("Whisper returned invalid word timestamps")
            words.append(word)
    if payload.get("text", "").strip() and not words:
        raise ValueError("Whisper did not return requested word timestamps")
    return {**payload, "words": words}


@app.get("/health")
async def health():
    if not LIVE_ASR_TOKEN:
        raise HTTPException(503, "Live ASR token is not configured")
    return {"status": "ok", "model": ASR_MODEL}


@app.post("/v1/audio/transcriptions", dependencies=[Depends(authorize)])
async def transcribe(
    request: Request,
    file: UploadFile = File(...),  # noqa: B008
    model: str = Form(...),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
):
    if model not in (ASR_MODEL, "whisper"):
        raise live_error(request, 409, "model_mismatch", "Requested live model is not configured")
    audio = await file.read(MAX_UPLOAD_BYTES + 1)
    if not audio:
        raise live_error(request, 400, "empty_audio", "Empty audio file")
    if len(audio) > MAX_UPLOAD_BYTES:
        raise live_error(request, 413, "audio_too_large", "Live audio buffer is too large")
    params = {"task": "transcribe", "output": "json", "encode": "true",
              "word_timestamps": "true", "vad_filter": "true"}
    if language:
        params["language"] = language
    if prompt:
        params["initial_prompt"] = prompt
    try:
        async with httpx.AsyncClient(timeout=LIVE_ASR_TIMEOUT_SECONDS) as client:
            pending = asyncio.create_task(client.post(
                urljoin(WHISPER_SERVICE_URL, "/asr"), params=params,
                headers={"X-ASR-Priority": "live", "X-ASR-Live-Token": LIVE_ASR_TOKEN,
                         "X-Request-ID": request.state.diagnostics["request_id"],
                         "X-Mycelia-Capture-ID": request.state.diagnostics["capture_id"],
                         "X-Mycelia-Session-ID": request.state.diagnostics["session_id"]},
                files={"audio_file": (file.filename or "live.wav", audio, file.content_type)},
            ))
            try:
                while not pending.done():
                    await asyncio.wait({pending}, timeout=0.25)
                    if not pending.done() and await request.is_disconnected():
                        raise live_error(request, 499, "client_disconnected", "Live client disconnected")
                response = await pending
            finally:
                if not pending.done():
                    pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending
        if response.is_error:
            raise live_error(request, response.status_code,
                             "upstream_busy" if response.status_code in (429, 503) else "upstream_failed",
                             "Whisper inference failed")
        return add_word_timings(response.json())
    except httpx.TimeoutException as error:
        raise live_error(request, 504, "upstream_timeout", "Live inference timed out") from error
    except httpx.RequestError as error:
        raise live_error(request, 502, "upstream_unavailable", "Whisper is unavailable") from error
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise live_error(request, 502, "invalid_timing_response",
                         "Whisper returned an incompatible timing response") from error
