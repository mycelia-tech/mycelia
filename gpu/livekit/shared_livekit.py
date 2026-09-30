"""Small policy helpers for the pinned WhisperLiveKit remote-ASR overlay."""

import asyncio
from dataclasses import dataclass
from urllib.parse import urlparse


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


class TrackedRemoteCalls:
    """Keep cancelled coroutine callers from orphaning synchronous HTTP work."""

    def __init__(self):
        self.pending = set()

    async def run(self, method, *args):
        task = asyncio.create_task(asyncio.to_thread(method, *args))
        self.pending.add(task)

        def complete(done):
            if not done.cancelled():
                done.exception()  # consume exceptions if caller was cancelled
            self.pending.discard(done)

        task.add_done_callback(complete)
        return await asyncio.shield(task)

    async def drain(self):
        # A cancelled WebSocket must not release its slot while HTTP is active.
        while self.pending:
            try:
                await asyncio.shield(asyncio.gather(*tuple(self.pending), return_exceptions=True))
            except asyncio.CancelledError:
                continue


async def flush_sortformer_tail(online, pad_audio):
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
        segments = await online.diarize()
    finally:
        online.global_time_offset -= pad_samples / online.sample_rate
    clipped = []
    for segment in segments:
        segment.end = min(segment.end, true_end)
        if segment.start < segment.end:
            clipped.append(segment)
    return clipped
