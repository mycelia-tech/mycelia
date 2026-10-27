from __future__ import annotations

import os
import threading
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, Optional

import requests
from bson import ObjectId
from pytz import UTC

from .resources import call_resource


def parse_diarization_recording_lease_seconds(
    raw: Optional[str] = None,
) -> int:
    value = (
        os.environ.get("DIARIZATION_RECORDING_LEASE_SECONDS", "600")
        if raw is None
        else raw
    )
    try:
        seconds = int(value, 10)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "DIARIZATION_RECORDING_LEASE_SECONDS must be an integer >= 600"
        ) from exc
    if str(seconds) != value or seconds < 600:
        raise ValueError(
            "DIARIZATION_RECORDING_LEASE_SECONDS must be an integer >= 600"
        )
    return seconds


DIARIZATION_RECORDING_LEASE_SECONDS = (
    parse_diarization_recording_lease_seconds()
)
DIARIZATION_RECORDING_LEASE_COLLECTION = "diarization_recording_leases"
ResourceCall = Callable[[str, dict], Any]


def extract_diarizator_runtime_provenance(
    payload: Dict[str, Any],
) -> Optional[Dict[str, str]]:
    """Normalize compact aliases or a full diarizator inference fingerprint."""
    fingerprint = payload.get("diarizationFingerprint")
    if not isinstance(fingerprint, dict):
        fingerprint = {}
    model_id = payload.get("modelId") or fingerprint.get("model")
    model_version = payload.get("modelVersion") or fingerprint.get(
        "resolvedRevision"
    )
    embedding_space_id = payload.get("embeddingSpaceId")
    if not all(
        isinstance(value, str) and value.strip()
        for value in (model_id, model_version, embedding_space_id)
    ):
        return None
    return {
        "modelId": model_id.strip(),
        "modelVersion": model_version.strip(),
        "embeddingSpaceId": embedding_space_id.strip(),
    }


@dataclass(frozen=True)
class RecordingLease:
    original_id: ObjectId
    owner: str
    token: str
    expires_at: datetime


job_cancel_event_var: ContextVar[Optional[threading.Event]] = ContextVar(
    "job_cancel_event",
    default=None,
)


def is_job_cancelled() -> bool:
    event = job_cancel_event_var.get()
    return bool(event and event.is_set())


def new_provider_session() -> requests.Session:
    """Create a job-local provider session without Mycelia credentials."""
    session = requests.Session()
    # Avoid reusing a connection as the provider's keep-alive timeout expires.
    # An interrupted POST still fails once; inference must not be replayed.
    session.headers["Connection"] = "close"
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=1,
        pool_maxsize=1,
        max_retries=0,
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def _lease_expiry(now: datetime, minimum_seconds: float) -> datetime:
    return now + timedelta(
        seconds=max(DIARIZATION_RECORDING_LEASE_SECONDS, minimum_seconds)
    )


def acquire_recording_lease(
    original_id: ObjectId,
    owner: str,
    *,
    token: Optional[str] = None,
    job_id: Optional[str] = None,
    campaign_id: Optional[str] = None,
    run_id: Optional[str] = None,
    route: Optional[str] = None,
    minimum_seconds: float = DIARIZATION_RECORDING_LEASE_SECONDS,
    resource_call: Optional[ResourceCall] = None,
) -> Optional[RecordingLease]:
    """Atomically acquire an original-wide diarization lease.

    An active lease owned by another token makes the upsert collide with the
    document's deterministic _id. Only that duplicate-key outcome means busy;
    connectivity and authorization failures must remain visible.
    """
    now = datetime.now(tz=UTC)
    lease_token = token or uuid.uuid4().hex
    expires_at = _lease_expiry(now, minimum_seconds)
    invoke_resource = resource_call or call_resource
    try:
        doc = invoke_resource("mongo", {
            "action": "findOneAndUpdate",
            "collection": DIARIZATION_RECORDING_LEASE_COLLECTION,
            "query": {
                "_id": original_id,
                "$or": [
                    {"owner": owner, "token": lease_token},
                    {"expiresAt": {"$lte": now}},
                ],
            },
            "update": {
                "$set": {
                    "owner": owner,
                    "token": lease_token,
                    "jobId": job_id,
                    "campaignId": campaign_id,
                    "runId": run_id,
                    "route": route,
                    "expiresAt": expires_at,
                    "updatedAt": now,
                },
                "$setOnInsert": {"createdAt": now},
            },
            "options": {
                "upsert": True,
                "returnDocument": "after",
                "touchUpdatedAt": False,
            },
        })
    except Exception as exc:
        response = getattr(exc, "response", None)
        response_text = (
            getattr(response, "text", "") if response is not None else ""
        )
        status_code = (
            getattr(response, "status_code", None)
            if response is not None
            else None
        )
        message = f"{exc} {response_text}".lower()
        stable_conflict = (
            status_code == 409
            and "diarization_recording_lease_busy" in response_text.lower()
        )
        local_duplicate = response is None and (
            "e11000" in message or "duplicate key" in message
        )
        if stable_conflict or local_duplicate:
            return None
        raise

    if not isinstance(doc, dict):
        return None
    if doc.get("owner") != owner or doc.get("token") != lease_token:
        return None
    return RecordingLease(
        original_id=original_id,
        owner=owner,
        token=lease_token,
        expires_at=expires_at,
    )


def renew_recording_lease(
    lease: RecordingLease,
    *,
    minimum_seconds: float = DIARIZATION_RECORDING_LEASE_SECONDS,
    resource_call: Optional[ResourceCall] = None,
) -> Optional[RecordingLease]:
    now = datetime.now(tz=UTC)
    expires_at = _lease_expiry(now, minimum_seconds)
    invoke_resource = resource_call or call_resource
    doc = invoke_resource("mongo", {
        "action": "findOneAndUpdate",
        "collection": DIARIZATION_RECORDING_LEASE_COLLECTION,
        "query": {
            "_id": lease.original_id,
            "owner": lease.owner,
            "token": lease.token,
            "expiresAt": {"$gt": now},
        },
        "update": {"$set": {"expiresAt": expires_at, "updatedAt": now}},
        "options": {
            "returnDocument": "after",
            "touchUpdatedAt": False,
        },
    })
    if not isinstance(doc, dict):
        return None
    return RecordingLease(
        original_id=lease.original_id,
        owner=lease.owner,
        token=lease.token,
        expires_at=expires_at,
    )


def release_recording_lease(
    lease: RecordingLease,
    *,
    resource_call: Optional[ResourceCall] = None,
) -> bool:
    invoke_resource = resource_call or call_resource
    result = invoke_resource("mongo", {
        "action": "deleteOne",
        "collection": DIARIZATION_RECORDING_LEASE_COLLECTION,
        "query": {
            "_id": lease.original_id,
            "owner": lease.owner,
            "token": lease.token,
        },
    })
    return bool((result or {}).get("deletedCount", 0))


def release_recording_leases(
    leases: list[RecordingLease],
    *,
    resource_call: Optional[ResourceCall] = None,
) -> int:
    """Release all exact ABA lease identities in one bounded round trip."""
    if not leases:
        return 0
    invoke_resource = resource_call or call_resource
    result = invoke_resource("mongo", {
        "action": "deleteMany",
        "collection": DIARIZATION_RECORDING_LEASE_COLLECTION,
        "query": {
            "$or": [
                {
                    "_id": lease.original_id,
                    "owner": lease.owner,
                    "token": lease.token,
                }
                for lease in leases
            ],
        },
    })
    return int((result or {}).get("deletedCount", 0))


class StageTimings:
    def __init__(self, initial: Optional[dict[str, float]] = None):
        self.values: dict[str, float] = dict(initial or {})

    def add(self, name: str, seconds: float) -> None:
        self.values[name] = self.values.get(name, 0.0) + max(seconds, 0.0)

    def measure(self, name: str):
        return _StageTimer(self, name)

    def milliseconds(self) -> dict[str, float]:
        return {
            name: round(seconds * 1000.0, 3)
            for name, seconds in self.values.items()
        }


class _StageTimer:
    def __init__(self, timings: StageTimings, name: str):
        self.timings = timings
        self.name = name
        self.started = 0.0

    def __enter__(self):
        self.started = time.monotonic()
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.timings.add(self.name, time.monotonic() - self.started)


def aggregate_stage_timings(
    aggregate: dict[str, dict[str, float]],
    sample_ms: dict[str, float],
) -> None:
    for stage, value in sample_ms.items():
        current = aggregate.setdefault(
            stage,
            {"count": 0, "total": 0.0, "avg": 0.0, "max": 0.0},
        )
        current["count"] += 1
        current["total"] = round(current["total"] + float(value), 3)
        current["max"] = round(max(current["max"], float(value)), 3)
        current["avg"] = round(current["total"] / current["count"], 3)
