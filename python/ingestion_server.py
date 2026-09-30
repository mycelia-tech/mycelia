from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# CLI credentials come from .env; the local API address has a stable nginx
# default and must be set before daemon/lib.config modules are imported.
os.environ.setdefault("MYCELIA_URL", "http://localhost:3210")

from daemon import import_new_files, ingests_missing_sources, initialize_auth
from lib.api import job_token_var
from lib.resources import call_resource
from settings import get_apple_voicememos_mode

logger = logging.getLogger("ingestion_server")

cycle_lock = threading.Lock()
last_cycle: dict[str, Any] = {"status": "not_started"}
current_cycle: dict[str, Any] | None = None
service_started_at = datetime.now(UTC).isoformat()


def staging_status() -> dict[str, Any] | None:
    """Read the tiny publication receipt only; never scan audio or query Mongo."""
    if get_apple_voicememos_mode() != "staged":
        return None
    db_path = os.getenv("MYCELIA_APPLE_VOICEMEMOS_DB", "")
    receipt = Path(db_path).expanduser().parent / "sync-status.json"
    try:
        with receipt.open(encoding="utf-8") as stream:
            value = json.loads(stream.read(64 * 1024))
        if str(Path(value.get("published_database", "")).expanduser()) != str(Path(db_path).expanduser()):
            return {"status": "unavailable", "error": "Staging receipt does not match the configured database"}
        return {"status": "available", **{
            key: value.get(key) for key in (
                "published_at_utc", "not_before", "staged_audio_files",
                "staged_audio_bytes", "copied_audio_files", "reused_audio_files",
            )
        }}
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        return {"status": "unavailable", "error": str(exc)}


class IngestionJobData(BaseModel):
    type: str = "ingestion"
    limit: int = Field(default=20, ge=1, le=100)


def run_ingestion_cycle(limit: int, job_id: str | None = None) -> dict[str, Any]:
    """Discover and ingest one bounded batch, serializing automatic/manual runs."""
    global last_cycle, current_cycle

    with cycle_lock:
        started_at = datetime.now(UTC).isoformat()
        current_cycle = {"startedAt": started_at, "phase": "discovery", "trigger": "manual" if job_id else "automatic"}
        try:
            if job_id:
                call_resource("jobs", {
                    "action": "progressUpdate",
                    "jobId": job_id,
                    "progress": {"phase": "discovery", "processed": 0, "limit": limit},
                })

            source_results = import_new_files()
            current_cycle = {**current_cycle, "phase": "ingestion"}

            if job_id:
                call_resource("jobs", {
                    "action": "progressUpdate",
                    "jobId": job_id,
                    "progress": {"phase": "ingestion", "processed": 0, "limit": limit},
                })

            ingestion = ingests_missing_sources(limit=limit)
            degraded = any(
                source.get("status") != "completed"
                for source in source_results
            ) or ingestion["failed"] > 0 or ingestion["cached_errors"] > 0
            last_cycle = {
                "status": "degraded" if degraded else "completed",
                "limit": limit,
                "sources": source_results,
                "ingestion": ingestion,
                "startedAt": started_at,
                "finishedAt": datetime.now(UTC).isoformat(),
                "trigger": "manual" if job_id else "automatic",
            }
            return last_cycle.copy()
        except Exception as exc:
            last_cycle = {"status": "failed", "limit": limit, "error": str(exc),
                          "startedAt": started_at, "finishedAt": datetime.now(UTC).isoformat()}
            raise
        finally:
            current_cycle = None


def ingestion_loop_settings() -> tuple[int, int]:
    interval = max(1, int(os.getenv("INGESTION_INTERVAL_SECONDS", "10")))
    limit = min(100, max(1, int(os.getenv("INGESTION_BATCH_SIZE", "20"))))
    return interval, limit


async def automatic_ingestion_loop() -> None:
    global last_cycle
    interval, limit = ingestion_loop_settings()
    authenticated = False

    while True:
        try:
            if not authenticated:
                # The token must be set in this task's context, so subsequent
                # to_thread calls inherit it. Network authentication must not
                # block readiness or health requests on the event loop.
                job_token_var.set(await asyncio.to_thread(initialize_auth))
                authenticated = True
            await asyncio.to_thread(run_ingestion_cycle, limit)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not authenticated:
                last_cycle = {"status": "failed", "error": str(exc)}
            logger.exception("Automatic ingestion cycle failed")
            authenticated = False
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _app.state.ready = False
    # Reject invalid settings during startup, before advertising readiness.
    # Otherwise the background task can die while the HTTP server stays ready.
    ingestion_loop_settings()
    task = asyncio.create_task(automatic_ingestion_loop())
    _app.state.ready = True
    try:
        yield
    finally:
        _app.state.ready = False
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Mycelia Host Ingestion", lifespan=lifespan)


@app.get("/readiness")
async def readiness() -> dict[str, Any]:
    if not getattr(app.state, "ready", False):
        raise HTTPException(status_code=503, detail="Application is starting")
    return {
        "service": "mycelia-host-ingestion",
        "status": "ready",
        "health": await health(),
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    interval, limit = ingestion_loop_settings()
    # A worker can publish another cycle while the receipt is read below.
    # Keep the status, timing, and returned cycle from the same snapshot.
    cycle = last_cycle
    active_cycle = current_cycle
    cycle_status = cycle.get("status")
    if cycle_status == "completed":
        status = "healthy"
    elif cycle_status == "not_started":
        status = "starting"
    else:
        status = "degraded"
    return {
        "status": status,
        "automatic": True,
        "checkedAt": datetime.now(UTC).isoformat(),
        "startedAt": service_started_at,
        "intervalSeconds": interval,
        "batchSize": limit,
        "currentCycle": active_cycle,
        "nextCheckAt": (
            (datetime.fromisoformat(cycle["finishedAt"]) + timedelta(seconds=interval)).isoformat()
            if active_cycle is None and cycle.get("finishedAt") else None
        ),
        "staging": await asyncio.to_thread(staging_status),
        "appleVoiceMemosMode": get_apple_voicememos_mode(),
        "lastCycle": cycle,
    }


@app.post("/jobs/ingestion")
async def process_ingestion_job(
    body: dict[str, Any],
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")

    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="Missing jobId")

    try:
        data = IngestionJobData.model_validate(body.get("data", {}))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid job data: {exc}") from exc

    token_ref = job_token_var.set(authorization.removeprefix("Bearer "))
    try:
        return await asyncio.to_thread(run_ingestion_cycle, data.limit, job_id)
    except Exception as exc:
        logger.exception("Manual ingestion job %s failed", job_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        job_token_var.reset(token_ref)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "ingestion_server:app",
        host="0.0.0.0",
        port=int(os.getenv("INGESTION_WORKER_PORT", "8001")),
    )
