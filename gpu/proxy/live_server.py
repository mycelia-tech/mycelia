"""Private, authenticated WLK adapter; never published on a host port.

The public batch proxy intentionally retains its existing response contract.
Only this listener may assign live priority and flatten genuine word timings.
"""

import asyncio
import hmac
import math
import os
from contextlib import suppress
from urllib.parse import urljoin

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
        raise HTTPException(409, f"Configured model is {ASR_MODEL}")
    audio = await file.read(MAX_UPLOAD_BYTES + 1)
    if not audio:
        raise HTTPException(400, "Empty audio file")
    if len(audio) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Live audio buffer is too large")
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
                headers={"X-ASR-Priority": "live", "X-ASR-Live-Token": LIVE_ASR_TOKEN},
                files={"audio_file": (file.filename or "live.wav", audio, file.content_type)},
            ))
            try:
                while not pending.done():
                    await asyncio.wait({pending}, timeout=0.25)
                    if not pending.done() and await request.is_disconnected():
                        raise HTTPException(499, "Live client disconnected")
                response = await pending
            finally:
                if not pending.done():
                    pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending
        if response.is_error:
            raise HTTPException(response.status_code, "Whisper inference failed")
        return add_word_timings(response.json())
    except httpx.TimeoutException as error:
        raise HTTPException(504, "Live inference timed out") from error
    except httpx.RequestError as error:
        raise HTTPException(502, "Whisper is unavailable") from error
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise HTTPException(502, "Whisper returned an incompatible timing response") from error
