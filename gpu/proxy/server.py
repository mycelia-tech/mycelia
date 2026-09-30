import os
import httpx
import logging
import time
from urllib.parse import urljoin
from fastapi import FastAPI, Request, HTTPException, Depends, Header, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
API_KEY = os.getenv("API_KEY")
WHISPER_SERVICE_URL = os.getenv("WHISPER_SERVICE_URL", "http://whisper:9000")
OLLAMA_SERVICE_URL = os.getenv("OLLAMA_SERVICE_URL", "http://ollama:11434")
ASR_MODEL = os.getenv("ASR_MODEL", "unknown")
MODEL_IDLE_TIMEOUT = max(0, int(os.getenv("MODEL_IDLE_TIMEOUT", "300")))


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value, got {value!r}")


# The GPU stack enables this explicitly in compose; keep the proxy default off
# so an independently deployed proxy remains backward-compatible.
WHISPER_VAD_FILTER = _env_bool("WHISPER_VAD_FILTER", False)
last_transcription_at: Optional[float] = None
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}

if not API_KEY:
    logger.warning("API_KEY environment variable not set. Authentication disabled.")

app = FastAPI(
    title="Proxy Server",
    description="Proxy server for Whisper ASR and Ollama",
    version="1.0.0"
)

# Authentication dependency using Bearer token
security = HTTPBearer(auto_error=False)

async def verify_api_key(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Verify API key from Authorization Bearer header"""
    if not API_KEY:
        # If no API key is configured, allow all requests
        return True
    
    if not credentials:
        logger.warning("Missing Authorization header")
        raise HTTPException(
            status_code=401,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    token = credentials.credentials
    if token != API_KEY:
        logger.warning(f"Invalid API key provided: {token[:8]}...")
        raise HTTPException(
            status_code=401,
            detail="Invalid API key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return True

@app.post("/v1/audio/transcriptions")
async def transcribe_audio(
    request: Request,
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    _: bool = Depends(verify_api_key)
):
    """
    OpenAI-compatible transcription endpoint that forwards to whisper service
    """
    global last_transcription_at
    last_transcription_at = time.time()
    logger.info(f"Received transcription request for file: {file.filename}")

    if model and model != "whisper" and model != ASR_MODEL:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Requested model '{model}' is not loaded; "
                f"this server is configured for '{ASR_MODEL}'. "
                "Change ASR_MODEL and redeploy the STT stack."
            ),
        )
    
    try:
        # Read the audio file
        audio_content = await file.read()
        
        # Prepare form data for whisper service
        files = {
            "audio_file": (file.filename, audio_content, file.content_type)
        }
        
        # Prepare query parameters for whisper service
        params = {
            "task": "transcribe",
            "output": "json",
            "encode": "true",
            "vad_filter": "true" if WHISPER_VAD_FILTER else "false",
        }
        
        if language:
            params["language"] = language
        if prompt:
            params["initial_prompt"] = prompt
        # OpenAI clients request word timing via timestamp_granularities[]=word;
        # only then ask whisper for word_timestamps so default callers are unaffected.
        form = await request.form()
        granularities = form.getlist("timestamp_granularities[]") + form.getlist("timestamp_granularities")
        if "word" in granularities:
            params["word_timestamps"] = "true"
        
        # Forward request to whisper service and stream response back
        async with httpx.AsyncClient(timeout=300.0) as client:
            whisper_url = urljoin(WHISPER_SERVICE_URL, "/asr")
            logger.info(f"Forwarding transcription request to {whisper_url}")
            response = await client.post(
                whisper_url,
                files=files,
                params=params
            )
            response.raise_for_status()
            
            # Read the entire response content (whisper service returns complete response)
            content = response.content
            content_type = response.headers.get("content-type", "application/octet-stream")
            logger.info(f"Received transcription response with content-type: {content_type}, size: {len(content)} bytes")
            
            # Stream the content back
            async def generate():
                yield content
            
            return StreamingResponse(
                generate(),
                status_code=response.status_code,
                media_type=content_type,
                headers={
                    **{
                        k: v for k, v in response.headers.items()
                        if k.lower() not in ["content-length", "transfer-encoding", "host", "connection"]
                    },
                    "X-Whisper-Model": ASR_MODEL,
                    "X-Whisper-VAD-Filter": str(WHISPER_VAD_FILTER).lower(),
                },
            )
            
    except httpx.HTTPStatusError as e:
        error_detail = "Whisper service error"
        try:
            if hasattr(e.response, 'text'):
                error_detail = e.response.text
            elif hasattr(e.response, 'content'):
                error_detail = str(e.response.content)
        except Exception as _:
            pass
        logger.error(f"Whisper service error: {e.response.status_code}")
        raise HTTPException(status_code=e.response.status_code, detail=error_detail)
    except Exception as e:
        logger.error(f"Transcription failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _filtered_headers(request: Request) -> dict:
    # Keep original headers except hop-by-hop ones.
    # Important: do NOT set Content-Length manually; httpx will handle it for streamed bodies.
    return {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP_HEADERS}
@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models(_: bool = Depends(verify_api_key)):
    """Advertise the single Whisper model loaded by this STT deployment."""
    if not ASR_MODEL or ASR_MODEL == "unknown":
        raise HTTPException(
            status_code=503,
            detail="ASR_MODEL is not configured",
        )

    return {
        "object": "list",
        "data": [
            {
                "id": ASR_MODEL,
                "object": "model",
                "created": 0,
                "owned_by": "mycelia-stt",
                "capabilities": ["audio.transcriptions"],
            }
        ],
    }


@app.get("/v1/stt/status")
async def stt_status(_: bool = Depends(verify_api_key)):
    """Report the STT stack's configured cache policy without exposing secrets."""
    now = time.time()
    idle_seconds = None if last_transcription_at is None else max(
        0, int(now - last_transcription_at)
    )
    unloads_after_idle = MODEL_IDLE_TIMEOUT > 0
    return {
        "model": ASR_MODEL,
        "whisperVadFilter": WHISPER_VAD_FILTER,
        "modelCache": "persistent",
        "modelCacheLocation": "whisper_cache volume",
        "policy": "unload_after_idle" if unloads_after_idle else "keep_warm",
        "idleTimeoutSeconds": MODEL_IDLE_TIMEOUT if unloads_after_idle else None,
        "lastTranscriptionAt": (
            None if last_transcription_at is None
            else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_transcription_at))
        ),
        "idleSeconds": idle_seconds,
        "modelState": (
            "unknown_before_first_request" if last_transcription_at is None
            else "active_or_warm" if not unloads_after_idle or idle_seconds < MODEL_IDLE_TIMEOUT
            else "idle_unload_expected"
        ),
    }


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_all(path: str, request: Request, _: bool = Depends(verify_api_key)):
    upstream_url = urljoin(OLLAMA_SERVICE_URL, path)
    headers = _filtered_headers(request)
    params = request.query_params  # keep multi-values

    timeout = httpx.Timeout(connect=10.0, read=300.0, write=300.0, pool=10.0)
    client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    try:
        # Build request w/ streamed body (no buffering)
        upstream_req = client.build_request(
            method=request.method,
            url=upstream_url,
            params=params,
            headers=headers,
            content=request.stream(),
        )

        upstream_resp = await client.send(upstream_req, stream=True)

        resp_headers = {
            k: v for k, v in upstream_resp.headers.items()
            if k.lower() not in HOP_BY_HOP_HEADERS
        }

        async def body_iter():
            try:
                async for chunk in upstream_resp.aiter_bytes():
                    # Optional: stop work if client disconnected
                    if await request.is_disconnected():
                        break
                    yield chunk
            finally:
                await upstream_resp.aclose()
                await client.aclose()

        return StreamingResponse(
            body_iter(),
            status_code=upstream_resp.status_code,
            media_type=upstream_resp.headers.get("content-type"),
            headers=resp_headers,
        )

    except httpx.RequestError as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Bad gateway: {e}")
if __name__ == "__main__":
    import uvicorn
    logger.info("Starting proxy server on 0.0.0.0:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
