"""Pinned Whisper ASR API with bounded worker requests and a shared GPU gate."""

import asyncio
import gc
import hmac
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from io import StringIO
from typing import Annotated
from urllib.parse import quote

from engine import FixedFeatureExtractor, transcribe
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import RedirectResponse, Response
from scheduler import Busy, Cancelled, GatedModel, ModelLease, Scheduler, current_job

log = logging.getLogger("shared_whisper")


class Backend:
    def __init__(self):
        from app.config import CONFIG

        if CONFIG.ASR_ENGINE != "faster_whisper":
            raise RuntimeError("shared Whisper requires ASR_ENGINE=faster_whisper")
        self.config = CONFIG
        self.scheduler = Scheduler(int(os.getenv("ASR_MAX_REQUESTS", "8")))
        self.live_token = os.getenv("LIVE_ASR_TOKEN", "")
        self.batch_timeout = float(os.getenv("ASR_REQUEST_TIMEOUT", "290"))
        self.live_timeout = float(os.getenv("ASR_LIVE_REQUEST_TIMEOUT", "55"))
        if min(self.batch_timeout, self.live_timeout) <= 0:
            raise ValueError("ASR request timeouts must be positive")
        self.lease = ModelLease(
            self.scheduler, self.load, self.unload, CONFIG.MODEL_IDLE_TIMEOUT
        )
        self.ready = False
        self.stop = threading.Event()

    def load(self):
        from faster_whisper import WhisperModel

        cfg = self.config
        model = WhisperModel(
            cfg.MODEL_NAME,
            device=cfg.DEVICE,
            compute_type=cfg.MODEL_QUANTIZATION,
            download_root=cfg.MODEL_PATH,
        )
        model.model = GatedModel(model.model, self.scheduler)
        model.feature_extractor = FixedFeatureExtractor(model.feature_extractor)
        log.info("Shared Whisper model loaded (one instance)")
        return model

    @staticmethod
    def unload(model):
        # Explicit unload happens before a subsequent load; waiting requests hold no references.
        model.model._model.unload_model()
        del model
        gc.collect()
        import torch

        torch.cuda.empty_cache()
        log.info("Shared Whisper model unloaded after idle timeout")

    def monitor(self):
        while not self.stop.wait(1):
            try:
                self.lease.unload_if_idle()
            except Exception:
                log.exception("Idle unload failed")

    def process(self, file, encode, detect, options, output):
        from app.asr_models.faster_whisper_engine import FasterWhisperASR
        from app.utils import load_audio

        job = current_job.get()
        job.check()
        audio = load_audio(file, encode)
        job.check()
        model = self.lease.get()
        job.check()
        if detect:
            import whisper

            generator, info = model.transcribe(whisper.pad_or_trim(audio), beam_size=5)
            close = getattr(generator, "close", None)
            if close:
                close()
            job.check()
            return {
                "detected_language": whisper.tokenizer.LANGUAGES[info.language],
                "language_code": info.language,
                "confidence": info.language_probability,
            }
        result = transcribe(model, audio, **options)
        output_file = StringIO()
        # Only reuse the pinned writer; never instantiate/load an upstream ASR model.
        FasterWhisperASR.write_result(None, result, output_file, output)
        return output_file.getvalue()


async def finish_worker(future):
    """A non-preemptible native call owns its upload/admission until it really exits."""
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            continue
        except Exception:
            log.debug(
                "ASR worker failed during cancelled request cleanup", exc_info=True
            )
            break
    # Retrieve errors even when HTTP disconnect/cancellation discards the result.
    with suppress(Exception, asyncio.CancelledError):
        future.result()


def create_app(backend=None):
    backend = backend or Backend()
    scheduler = backend.scheduler
    pool = ThreadPoolExecutor(
        max_workers=scheduler.max_requests, thread_name_prefix="asr"
    )

    @asynccontextmanager
    async def lifespan(app):
        await asyncio.get_running_loop().run_in_executor(pool, backend.lease.get)
        backend.ready = True
        monitor = threading.Thread(target=backend.monitor, daemon=True, name="asr-idle")
        monitor.start()
        log.info("[READY] Shared Whisper HTTP ready")
        try:
            yield
        finally:
            backend.ready = False
            scheduler.set_draining(True)
            backend.stop.set()
            await asyncio.to_thread(pool.shutdown, wait=True)
            await asyncio.to_thread(monitor.join, 2)

    app = FastAPI(
        title="Shared Whisper ASR", version="1.9.1-shared.1", lifespan=lifespan
    )

    def trusted(token):
        return bool(backend.live_token) and hmac.compare_digest(
            token, backend.live_token
        )

    async def execute(request, audio_file, encode, detect, options, output):
        priority = (
            "live"
            if request.headers.get("x-asr-priority") == "live"
            and trusted(request.headers.get("x-asr-live-token", ""))
            else "batch"
        )
        try:
            job = scheduler.admit(
                priority,
                backend.live_timeout if priority == "live" else backend.batch_timeout,
            )
        except Busy as exc:
            raise HTTPException(503, str(exc), headers={"Retry-After": "1"}) from exc

        def work():
            token = current_job.set(job)
            try:
                return backend.process(audio_file.file, encode, detect, options, output)
            finally:
                current_job.reset(token)
                scheduler.finish(job)

        try:
            future = asyncio.get_running_loop().run_in_executor(pool, work)
        except BaseException:
            scheduler.finish(job)
            raise

        async def watch_disconnect():
            while True:
                message = await request.receive()
                if message["type"] == "http.disconnect":
                    return

        disconnect = asyncio.create_task(watch_disconnect())
        try:
            while not future.done():
                if time.monotonic() >= job.deadline:
                    scheduler.cancel(job)
                    await finish_worker(future)
                    raise HTTPException(504, "ASR request deadline exceeded")
                if disconnect.done():
                    scheduler.cancel(job)
                    await finish_worker(future)
                    raise HTTPException(499, "ASR client disconnected")
                await asyncio.wait(
                    {future, disconnect},
                    timeout=0.1,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            result = future.result()
            # Serialization can finish after the budget between HTTP polls.
            job.check()
            return result
        except asyncio.CancelledError:
            scheduler.cancel(job)
            await finish_worker(future)
            raise
        except Cancelled as exc:
            raise HTTPException(504, str(exc)) from exc
        finally:
            disconnect.cancel()
            with suppress(asyncio.CancelledError):
                await disconnect

    @app.get("/", include_in_schema=False)
    async def index():
        return RedirectResponse("/docs")

    @app.get("/health")
    async def health():
        if not backend.ready:
            raise HTTPException(503, "starting")
        return {"status": "ready", "model_state": backend.lease.state}

    @app.get("/scheduler")
    async def status():
        return {**scheduler.snapshot(), "model_state": backend.lease.state}

    def authorize(request):
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not trusted(authorization[7:]):
            raise HTTPException(401, "Invalid internal token")

    @app.post("/scheduler/drain")
    async def drain(request: Request):
        authorize(request)
        scheduler.set_draining(True)
        return await status()

    @app.post("/scheduler/resume")
    async def resume(request: Request):
        authorize(request)
        scheduler.set_draining(False)
        return await status()

    @app.post("/asr")
    async def asr(
        request: Request,
        audio_file: Annotated[UploadFile, File()],
        encode: bool = Query(True),
        task: str | None = Query("transcribe", enum=["transcribe", "translate"]),
        language: str | None = Query(None),
        initial_prompt: str | None = Query(None),
        vad_filter: bool | None = Query(False),
        word_timestamps: bool = Query(False),
        diarize: bool = Query(False, include_in_schema=False),
        min_speakers: int | None = Query(None, include_in_schema=False),
        max_speakers: int | None = Query(None, include_in_schema=False),
        output: str | None = Query("txt", enum=["txt", "vtt", "srt", "tsv", "json"]),
    ):
        result = await execute(
            request,
            audio_file,
            encode,
            False,
            {
                "task": task,
                "language": language,
                "initial_prompt": initial_prompt,
                "vad_filter": vad_filter,
                "word_timestamps": word_timestamps,
            },
            output,
        )
        return Response(
            content=result,
            media_type="text/plain",
            headers={
                "Asr-Engine": "faster_whisper",
                "Content-Disposition": f'attachment; filename="{quote(audio_file.filename or "audio")}.{output}"',
            },
        )

    @app.post("/detect-language")
    async def detect_language(
        request: Request,
        audio_file: Annotated[UploadFile, File()],
        encode: bool = Query(True),
    ):
        return await execute(request, audio_file, encode, True, {}, None)

    return app


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(create_app(), host="0.0.0.0", port=9000)
