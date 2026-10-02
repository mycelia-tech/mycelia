"""Loopback-only native Bridge transport for the existing daemon chunk importer.

No Apple folder access. One transient recording at a time, bounded metadata
queries, and no automatic discovery/import without an authenticated UI request.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import secrets
import shutil
import stat
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from bson import ObjectId
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from chunking import ingest_source
from discovery import extract_device_info
from ingestion_lock import ingestion_lock
from lib.api import exchange_api_key_for_jwt, job_session_var, job_token_var
from lib.resources import call_resource_once

logger = logging.getLogger("voice_memos_bridge")
PAIRING = Path.home() / "Library/Application Support/Mycelia/VoiceMemosBridge/pairing.json"
PORT = 8012
TERMINAL = {"imported", "already_imported", "failed", "cancelled"}
_backend_lock = threading.Lock()
_backend_token = None
_backend_until = 0.0
_index_ready = False


def call_resource(resource, body):
    return call_resource_once(resource, body, timeout=(3.0, 20.0))


class Recording(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    uuid: str = Field(pattern=r"^[A-Za-z0-9_-]{8,128}$")
    filename: str = Field(min_length=1, max_length=255)
    apple_date: float = Field(ge=-978307200, le=3155760000)
    duration: float = Field(gt=0, le=1209600)
    size: int = Field(gt=0, le=16 * 1024**3)
    title: str = Field(default="", max_length=1024)

    @field_validator("filename")
    @classmethod
    def basename_only(cls, value):
        # Apple also keeps non-.m4a audio variants in its own catalog. The
        # filename is display/provenance only; it never determines a temp path.
        if any(c in value for c in ("/", "\\", "\0")) or value in (".", ".."):
            raise ValueError("Expected an audio filename, not a path")
        return value


class Plan(BaseModel):
    recordings: list[Recording] = Field(min_length=1, max_length=100)


class InventoryPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    after: str | None = Field(default=None, pattern=r"^[0-9a-f]{24}$")


def library_inventory(page):
    """Small metadata-only pages; no audio reads, counts, writes, or $nin scans.

    Fetch the whole Apple identity inventory once per explicit scan, including
    missing originals. The native client reconciles only after all pages and
    the complete Apple catalog have been read successfully.
    """
    backend_auth()
    query = {"voicememo.ZUNIQUEID": {"$exists": True}}
    if page.after:
        query["_id"] = {"$gt": ObjectId(page.after)}
    rows = call_resource("mongo", {
        "action": "find", "collection": "source_files", "query": query,
        "options": {"projection": {
            "_id": 1, "voicememo.ZUNIQUEID": 1, "voicememo.ZDATE": 1,
            "voicememo.ZPATH": 1, "voicememo.ZENCRYPTEDTITLE": 1,
            "start": 1, "duration": 1, "size": 1, "name": 1,
            "ingested": 1, "ingestion.error": 1,
        }, "sort": {"_id": 1}, "hint": "_id_", "limit": 101, "maxTimeMS": 5000},
    })
    records = []
    for row in rows[:100]:
        memo = row.get("voicememo", {})
        date = memo.get("ZDATE")
        if not isinstance(date, (int, float)) and isinstance(row.get("start"), datetime):
            date = row["start"].timestamp() - 978307200
        if not isinstance(date, (int, float)) or not math.isfinite(date):
            date = None
        records.append({
            "source_id": str(row["_id"]), "uuid": str(memo.get("ZUNIQUEID") or ""),
            "filename": str(memo.get("ZPATH") or row.get("name") or "")[:255],
            "title": str(memo.get("ZENCRYPTEDTITLE") or row.get("name") or "")[:1024],
            "apple_date": date, "duration": row.get("duration") or 0,
            "size": row.get("size") or 0, "imported": row.get("ingested") is True,
            "error": str(row.get("ingestion", {}).get("error") or "")[:500],
        })
    return {"records": records, "next": str(rows[99]["_id"]) if len(rows) > 100 else None}


class Submission(BaseModel):
    recording: Recording
    retry_error: bool = False
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


def backend_auth():
    global _backend_token, _backend_until
    with _backend_lock:
        if not _backend_token or time.monotonic() >= _backend_until:
            _backend_token = exchange_api_key_for_jwt(timeout=15)
            _backend_until = time.monotonic() + 300
        token = _backend_token
    job_token_var.set(token)
    job_session_var.set(None)


def identities(uuids):
    """At most 100 keys / 1001 projected rows; never count or scan the corpus."""
    global _index_ready
    if not _index_ready:
        call_resource("mongo", {"action": "createIndex", "collection": "source_files",
                               "index": {"voicememo.ZUNIQUEID": 1},
                               "options": {"name": "voice_memos_uuid_lookup"}})
        _index_ready = True
    rows = call_resource("mongo", {
        "action": "find", "collection": "source_files",
        "query": {"voicememo.ZUNIQUEID": {"$in": uuids}},
        "options": {"projection": {"_id": 1, "voicememo": 1, "start": 1, "bridge_pending_sha256": 1,
                                    "ingested": 1, "ingestion.error": 1},
                    "limit": 1001, "maxTimeMS": 5000},
    })
    if len(rows) > 1000:
        raise RuntimeError("Too many duplicate source identities; resolve them before importing")
    return {uid: [r for r in rows if r.get("voicememo", {}).get("ZUNIQUEID") == uid] for uid in uuids}


def classify(rows):
    if any(row.get("ingested") is True for row in rows):
        return "already_imported", ""
    if len(rows) > 1:
        return "conflict", "Multiple pending records have the same Apple UUID"
    if rows and rows[0].get("ingestion", {}).get("error"):
        return "error", str(rows[0]["ingestion"]["error"])[:500]
    return "pending", ""


def plan_recordings(recordings):
    backend_auth()
    known = identities([r.uuid for r in recordings])
    return {r.uuid: dict(zip(("state", "error"), classify(known[r.uuid]))) for r in recordings}


def require_space(root, needed=0):
    free = shutil.disk_usage(root).free
    required = needed + 1024**3
    if free < required:
        raise RuntimeError(f"Not enough disk space: need {required / 1024**3:.1f} GiB free, "
                           f"have {free / 1024**3:.1f} GiB. Free space before retrying.")


class Cancelled(Exception):
    pass


class ImportJob:
    def __init__(self, submission):
        self.id = str(uuid4())
        self.submission = submission
        self.cancel = threading.Event()
        self.created = time.monotonic()
        self.guard = threading.Lock()
        self.values = {"id": self.id, "uuid": submission.recording.uuid,
                       "filename": submission.recording.filename, "state": "awaiting_upload",
                       "received_bytes": 0, "size": submission.recording.size,
                       "duration_seconds": submission.recording.duration,
                       "completed_chunks": 0, "total_chunks": 0, "error": ""}

    def update(self, **values):
        with self.guard:
            self.values.update(values)

    def snapshot(self):
        with self.guard:
            return self.values.copy()

    def check(self):
        if self.cancel.is_set():
            raise Cancelled("Import paused. Already saved chunks are safe to retry.")


def process_recording(job, audio, chunks):
    """Keep original source ID/date and use daemon's exact Opus/upsert contract."""
    recording = job.submission.recording
    source = None
    with ingestion_lock(job.check):
        job.check()
        backend_auth()
        matches = identities([recording.uuid])[recording.uuid]
        state, error = classify(matches)
        if state == "already_imported":
            return state
        if state == "conflict" or (state == "error" and not job.submission.retry_error):
            raise RuntimeError(error or "Cached error requires an explicit retry")
        if matches:
            source = matches[0]
            old_hash = source.get("bridge_pending_sha256")
            if old_hash and old_hash != job.submission.sha256:
                raise RuntimeError("Recording bytes changed since partial import; manual review required")
            call_resource("mongo", {"action": "updateOne", "collection": "source_files",
                                    "query": {"_id": source["_id"]},
                                    "update": {"$set": {"bridge_pending_sha256": job.submission.sha256}}})
        else:
            source = {
                "_id": ObjectId(), "ingested": False,
                "start": datetime.fromtimestamp(recording.apple_date + 978307200, UTC),
                "duration": recording.duration, "size": recording.size,
                "name": recording.title or recording.filename,
                "bridge_pending_sha256": job.submission.sha256,
                # Do not persist ephemeral input paths or let legacy discovery
                # pick up Bridge-only sources through its local-node filter.
                "platform": {"importer": "apple_voicememos_bridge", "node": "native-bridge", "system": "Darwin"},
                "voicememo": {"ZUNIQUEID": recording.uuid, "ZDATE": recording.apple_date,
                              "ZENCRYPTEDTITLE": recording.title, "ZPATH": recording.filename},
            }
            call_resource("mongo", {"action": "insertOne", "collection": "source_files", "doc": source})
        try:
            start = source.get("start")
            if not isinstance(start, datetime):
                raise TypeError("Existing source has no valid recording date; manual repair required")

            def check():
                job.check()
                require_space(audio.parent)

            def report(progress):
                job.update(state=progress.pop("phase"), **progress)

            count = ingest_source({**source, "path": str(audio)}, work_dir=str(chunks),
                                  progress_callback=report, cancel_check=check, resource_callback=call_resource)
            job.check()
            device = extract_device_info(str(audio))
            update = {"ingested": True, "ingested_at": datetime.now(UTC),
                      "bridge_import": {"chunks": count, "sha256": job.snapshot().get("sha256")}}
            if device:
                update["device"] = device
            result = call_resource("mongo", {
                "action": "updateOne", "collection": "source_files", "query": {"_id": source["_id"]},
                "update": {"$set": update, "$unset": {"ingestion": ""}},
            })
            if result.get("matchedCount") != 1:
                raise RuntimeError("Source disappeared before import confirmation")
            return "imported"
        except Cancelled:
            raise  # User cancellation is not a cached source error.
        except Exception as exc:
            call_resource("mongo", {
                "action": "updateOne", "collection": "source_files", "query": {"_id": source["_id"]},
                "update": {"$set": {"ingestion": {"error": str(exc)[:2000],
                                                   "last_attempt": datetime.now(UTC)}}},
            })
            raise


def load_pairing(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(p.is_symlink() for p in (path.parent, *path.parent.parents)):
        raise RuntimeError("Unsafe pairing directory")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise RuntimeError("Pairing file must be a private, user-owned regular file")
            value = json.loads(stream.read(4096))
        token = value.get("token", "")
        if len(token) != 64:
            raise RuntimeError("Invalid pairing file; do not reuse it")
        return token
    token = secrets.token_hex(32)
    with os.fdopen(fd, "w") as stream:
        json.dump({"version": 1, "token": token}, stream)
    return token


def create_app(pairing_path=PAIRING):
    jobs = {}
    active = None
    tasks = set()

    @asynccontextmanager
    async def lifespan(app):
        app.state.token = load_pairing(pairing_path)

        async def expire():
            while True:
                await asyncio.sleep(5)
                for job in list(jobs.values()):
                    if job.snapshot()["state"] == "awaiting_upload" and time.monotonic() - job.created > 120:
                        job.cancel.set()
                        job.update(state="cancelled", error="Upload did not start; scan again")
        expiry = asyncio.create_task(expire())
        try:
            yield
        finally:
            expiry.cancel()
            for job in jobs.values():
                job.cancel.set()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(title="Mycelia Voice Memos Importer", lifespan=lifespan, docs_url=None, redoc_url=None)

    async def authenticate(request: Request):
        # No browser callers, DNS rebinding, CORS or network-facing exposure.
        if request.headers.get("origin") is not None or request.headers.get("host") != f"127.0.0.1:{PORT}":
            raise HTTPException(403, "Native loopback requests only")
        supplied = request.headers.get("authorization", "")
        if not secrets.compare_digest(supplied, "Bearer " + request.app.state.token):
            raise HTTPException(401, "Bridge pairing required")

    async def bounded_json(request, model):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 256 * 1024:
                raise HTTPException(413, "Metadata request too large")
        try:
            return model.model_validate_json(body)
        except ValidationError as exc:
            issues = [".".join(map(str, item["loc"])) + ": " + item["msg"]
                      for item in exc.errors(include_input=False)[:3]]
            raise HTTPException(422, "Invalid recording metadata: " + "; ".join(issues)) from exc

    def get_job(job_id):
        if job_id not in jobs:
            raise HTTPException(404, "Unknown import; scan library again")
        return jobs[job_id]

    @app.get("/status", dependencies=[Depends(authenticate)])
    async def status():
        return {"service": "mycelia-voice-memos-importer", "version": 1,
                "active": active.snapshot() if active else None,
                "free_bytes": shutil.disk_usage(tempfile.gettempdir()).free}

    @app.post("/plan", dependencies=[Depends(authenticate)])
    async def plan(request: Request):
        body = await bounded_json(request, Plan)
        try:
            return await asyncio.to_thread(plan_recordings, body.recordings)
        except Exception as exc:
            logger.exception("Bridge plan failed")
            raise HTTPException(503, "Cannot query Mycelia. Check the local backend and importer logs.") from exc

    @app.post("/inventory", dependencies=[Depends(authenticate)])
    async def inventory(request: Request):
        body = await bounded_json(request, InventoryPage)
        try:
            return await asyncio.to_thread(library_inventory, body)
        except Exception as exc:
            logger.exception("Bridge inventory failed")
            raise HTTPException(503, "Cannot finish checking Mycelia; no removal status was confirmed.") from exc

    @app.post("/imports", dependencies=[Depends(authenticate)])
    async def prepare(request: Request):
        nonlocal active
        body = await bounded_json(request, Submission)
        if active and active.snapshot()["state"] not in TERMINAL:
            raise HTTPException(409, "Another recording is still being imported")
        try:
            require_space(tempfile.gettempdir(), body.recording.size + int(body.recording.duration * 16000))
        except RuntimeError as exc:
            raise HTTPException(507, str(exc)) from exc
        job = ImportJob(body)
        active = job
        jobs[job.id] = job
        while len(jobs) > 32:
            jobs.pop(next(iter(jobs)))
        return job.snapshot()

    @app.post("/imports/{job_id}/audio", dependencies=[Depends(authenticate)])
    async def upload(job_id: str, request: Request):
        job = get_job(job_id)
        if job.snapshot()["state"] != "awaiting_upload":
            raise HTTPException(409, "This upload has already started")
        if request.headers.get("content-length") != str(job.submission.recording.size):
            raise HTTPException(400, "Recording size does not match the request")
        job.update(state="receiving")
        temporary = tempfile.TemporaryDirectory(prefix="mycelia-bridge-import-")
        root = Path(temporary.name)
        audio = root / "recording.m4a"
        received = 0
        digest = hashlib.sha256()
        try:
            with audio.open("xb") as stream:
                async for chunk in request.stream():
                    job.check()
                    received += len(chunk)
                    if received > job.submission.recording.size:
                        raise RuntimeError("Received more data than declared")
                    require_space(root, job.submission.recording.size - received)
                    await asyncio.to_thread(stream.write, chunk)
                    digest.update(chunk)
                    job.update(received_bytes=received)
            if received != job.submission.recording.size:
                raise RuntimeError("Recording upload was incomplete")
            if digest.hexdigest() != job.submission.sha256:
                raise RuntimeError("Recording changed during transfer; scan and retry")
            job.check()
            job.update(state="waiting_for_import_lock", sha256=digest.hexdigest())
        except BaseException as exc:
            temporary.cleanup()
            job.update(state="cancelled" if isinstance(exc, Cancelled) else "failed", error=str(exc)[:1000])
            raise HTTPException(409, job.snapshot()["error"] or "Upload interrupted") from exc

        async def run():
            final, error = "failed", ""
            try:
                final = await asyncio.to_thread(process_recording, job, audio, root / "chunks")
            except Cancelled as exc:
                final, error = "cancelled", str(exc)
            except Exception as exc:
                logger.exception("Bridge import failed for %s", job.submission.recording.uuid)
                error = str(exc)[:1000]
            finally:
                # Completion means both Mongo acknowledgement AND temp cleanup.
                try:
                    temporary.cleanup()
                except OSError:
                    final, error = "failed", "Import ended but temporary cleanup failed; inspect importer logs before retrying"
                    logger.exception("Could not clean temporary Bridge data at %s", root)
                job.update(state=final, error=error)
        task = asyncio.create_task(run())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return job.snapshot()

    @app.get("/imports/{job_id}", dependencies=[Depends(authenticate)])
    async def progress(job_id: str):
        return get_job(job_id).snapshot()

    @app.post("/imports/{job_id}/cancel", dependencies=[Depends(authenticate)])
    async def cancel(job_id: str):
        job = get_job(job_id)
        job.cancel.set()
        if job.snapshot()["state"] == "awaiting_upload":
            job.update(state="cancelled")
        return job.snapshot()

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, access_log=False)
