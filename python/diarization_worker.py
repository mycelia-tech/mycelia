import io
import time
import os
import argparse
import math
import re
import hashlib
import threading
import requests
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from tqdm import tqdm
from lib.config import load_environment

load_environment()

from lib.resources import call_resource
from lib.worker import setup_worker_logging, get_worker_id, mongo_cursor, claim_chunks, release_chunks
from lib.diarization_runtime import (
    StageTimings,
    extract_diarizator_runtime_provenance,
)

logger = setup_worker_logging('diarization_worker')


def log_info(message: str):
    """Write to both tqdm console and rotating log."""
    tqdm.write(message)
    logger.info(message)

from pydantic import BaseModel, Field
from datetime import datetime
from bson import ObjectId
from datetime import timedelta
from typing import Any, Callable, Iterator, Optional
from pytz import UTC

import signal

signal.signal(signal.SIGINT, signal.SIG_DFL)

DIARIZATION_SERVER_URL = os.environ.get('DIARIZATION_SERVER_URL', 'http://localhost:8085').rstrip('/')
MAX_SEQUENCE_CHUNKS = max(1, int(os.environ.get('DIARIZATION_MAX_SEQUENCE_CHUNKS', '6')))
SPEAKER_SIMILARITY_THRESHOLD = float(os.environ.get('SPEAKER_SIMILARITY_THRESHOLD', '0.35'))
DIARIZATION_CONTINUITY_THRESHOLD = float(os.environ.get('DIARIZATION_CONTINUITY_THRESHOLD', '0.75'))
# Gaps inside a sequence are padded with silence before inference, so a
# recording that paused would otherwise bill minutes of GPU time for nothing.
MAX_SEQUENCE_GAP = timedelta(
    seconds=float(os.environ.get('DIARIZATION_MAX_GAP_SECONDS', '60'))
)
DIARIZATION_CURSOR_MAX_TIME_MS = 5_000
DIARIZATION_CURSOR_MAX_DOCUMENTS = 5_000
DIARIZATION_RECORDING_CANDIDATE_LIMIT = 64
DIARIZATION_HYDRATE_MAX_TIME_MS = 5_000
DIARIZATION_METADATA_PROJECTION = {
    '_id': 1,
    'original_id': 1,
    'index': 1,
    'start': 1,
    'diarizationFailure': 1,
}

# Cache for speaker profiles (refreshed periodically). None means cold; an
# empty list is a valid cached result and must not trigger a query per sequence.
_speaker_profiles_cache: Optional[list] = None
_speaker_profiles_last_success_monotonic: Optional[float] = None
_speaker_profiles_next_refresh_monotonic: float = 0.0
_PROFILE_CACHE_TTL_SECONDS = 300  # 5 minutes
_PROFILE_CACHE_ERROR_RETRY_SECONDS = 30
_PROFILE_CACHE_MAX_STALE_SECONDS = 1_800
_speaker_profiles_cache_lock = threading.Lock()

import json
import numpy as np
from chunking import read_codec, array_to_wav, sample_rate


def _is_speaker_identification_enabled() -> bool:
    """Check if speaker identification is enabled via server config."""
    try:
        result = call_resource('config', {"action": "get"})
        if result and 'features' in result:
            return result['features'].get('enable_speaker_identification', False)
    except Exception as e:
        logger.warning(f"Could not check speaker identification feature flag: {e}")
    return False


def _get_speaker_profiles() -> list:
    """
    Get speaker profiles from cache or reload from MongoDB.
    Returns list of profiles with id, name, and embedding.
    """
    global _speaker_profiles_cache
    global _speaker_profiles_last_success_monotonic
    global _speaker_profiles_next_refresh_monotonic
    
    now = time.monotonic()
    if (
        _speaker_profiles_cache is not None
        and now < _speaker_profiles_next_refresh_monotonic
    ):
        return _speaker_profiles_cache

    with _speaker_profiles_cache_lock:
        now = time.monotonic()
        if (
            _speaker_profiles_cache is not None
            and now < _speaker_profiles_next_refresh_monotonic
        ):
            return _speaker_profiles_cache

        try:
            result = call_resource('mongo', {
                "action": "find",
                "collection": "speaker_profiles",
                "query": {},
                "options": {
                    "projection": {
                        "_id": 1,
                        "name": 1,
                        "embedding": 1,
                        "embeddingSpaceId": 1,
                        "revision": 1,
                    },
                    "sort": {"created_at": 1},
                },
            })
            if isinstance(result, list):
                rows = result
            elif isinstance(result, dict) and isinstance(result.get("data"), list):
                rows = result["data"]
            else:
                raise TypeError(
                    f"Unexpected speaker profile response: {type(result).__name__}"
                )

            profiles = []
            for profile in rows:
                if (
                    isinstance(profile, dict)
                    and profile.get("_id") is not None
                    and isinstance(profile.get("embedding"), list)
                    and profile["embedding"]
                ):
                    profiles.append(profile)
                else:
                    logger.warning("Skipping invalid speaker profile payload")

            _speaker_profiles_cache = profiles
            _speaker_profiles_last_success_monotonic = now
            _speaker_profiles_next_refresh_monotonic = (
                now + _PROFILE_CACHE_TTL_SECONDS
            )
            logger.info(
                "Loaded %d speaker profiles for identification",
                len(profiles),
            )
            return profiles
        except Exception as e:
            cache_age = (
                now - _speaker_profiles_last_success_monotonic
                if _speaker_profiles_last_success_monotonic is not None
                else math.inf
            )
            if (
                _speaker_profiles_cache is not None
                and cache_age < _PROFILE_CACHE_MAX_STALE_SECONDS
            ):
                # Retry soon while keeping identification stable through a
                # transient config/Mongo outage.
                _speaker_profiles_next_refresh_monotonic = (
                    now + _PROFILE_CACHE_ERROR_RETRY_SECONDS
                )
                logger.warning(
                    "Could not refresh speaker profiles; using stale cache: %s",
                    e,
                )
                return _speaker_profiles_cache
            logger.warning(f"Could not load speaker profiles: {e}")
            _speaker_profiles_cache = []
            _speaker_profiles_last_success_monotonic = None
            _speaker_profiles_next_refresh_monotonic = (
                now + _PROFILE_CACHE_ERROR_RETRY_SECONDS
            )
            return []


def get_speaker_profiles_snapshot(
    expected_embedding_space_id: Optional[str] = None,
) -> list:
    """Resolve an immutable, embedding-space-compatible profile view per job."""
    if not _is_speaker_identification_enabled():
        return []
    if not expected_embedding_space_id:
        # Legacy jobs without admitted runtime provenance keep the historical
        # no-identification behavior instead of risking cross-space matching.
        return []
    profiles = list(_get_speaker_profiles())
    compatible = [
        profile
        for profile in profiles
        if profile.get("embeddingSpaceId") == expected_embedding_space_id
        and isinstance(profile.get("revision"), int)
        and not isinstance(profile.get("revision"), bool)
        and profile["revision"] > 0
    ]
    skipped = len(profiles) - len(compatible)
    if skipped:
        logger.warning(
            "Skipping %d speaker profiles outside admitted embedding space %s",
            skipped,
            expected_embedding_space_id,
        )
    return compatible


def _build_clusters_param(profiles: list) -> str:
    """Build JSON clusters parameter for diarization API."""
    clusters = []
    for profile in profiles:
        clusters.append({
            "id": str(profile["_id"]),
            "name": profile.get("name", "Unknown"),
            "embedding": profile["embedding"],
        })
    return json.dumps(clusters)


def _build_diarization_request_fields(clusters_param: Optional[str]) -> tuple[dict, dict]:
    """Keep multipart fields separate from FastAPI query parameters."""
    if not clusters_param:
        return {}, {}
    return (
        {'clusters': clusters_param},
        {'similarity_threshold': str(SPEAKER_SIMILARITY_THRESHOLD)},
    )


def _normalized_centroid(embeddings: list[list[float]]) -> Optional[np.ndarray]:
    if not embeddings:
        return None
    centroid = np.mean(np.asarray(embeddings, dtype=np.float32), axis=0)
    norm = np.linalg.norm(centroid)
    if norm == 0 or not np.isfinite(norm):
        return None
    return centroid / norm


def _reconcile_speaker_labels(
    segments: list[dict],
    previous_segments: list[dict],
    threshold: float = DIARIZATION_CONTINUITY_THRESHOLD,
    reserved_labels: Optional[set[str]] = None,
) -> dict[str, str]:
    """Map request-local Pyannote labels to stable labels from the overlap."""
    current_groups: dict[str, list[list[float]]] = {}
    previous_groups: dict[str, list[list[float]]] = {}
    # Every speaker in the response needs a mapping, including one whose
    # segments carry no embedding: leaving it on its request-local label would
    # silently merge it into whichever speaker already holds that label.
    current_speakers: dict[str, None] = {}

    for segment in segments:
        current_speakers.setdefault(segment['speaker'], None)
        if segment.get('embedding'):
            current_groups.setdefault(segment['speaker'], []).append(segment['embedding'])
    for segment in previous_segments:
        if segment.get('embedding'):
            previous_groups.setdefault(segment['speaker'], []).append(segment['embedding'])

    if not previous_groups and not reserved_labels:
        return {speaker: speaker for speaker in current_speakers}

    current_centroids = {
        speaker: centroid
        for speaker, embeddings in current_groups.items()
        if (centroid := _normalized_centroid(embeddings)) is not None
    }
    previous_centroids = {
        speaker: centroid
        for speaker, embeddings in previous_groups.items()
        if (centroid := _normalized_centroid(embeddings)) is not None
    }

    candidates = []
    for current_speaker, current_centroid in current_centroids.items():
        for previous_speaker, previous_centroid in previous_centroids.items():
            if current_centroid.shape != previous_centroid.shape:
                continue
            similarity = float(np.dot(current_centroid, previous_centroid))
            if similarity >= threshold:
                candidates.append((similarity, current_speaker, previous_speaker))

    mapping: dict[str, str] = {}
    used_previous = set()
    for _, current_speaker, previous_speaker in sorted(candidates, reverse=True):
        if current_speaker not in mapping and previous_speaker not in used_previous:
            mapping[current_speaker] = previous_speaker
            used_previous.add(previous_speaker)

    existing_labels = set(previous_groups) | (reserved_labels or set())
    numeric_labels = []
    for label in existing_labels:
        match = re.fullmatch(r'SPEAKER_(\d+)', label)
        if match:
            numeric_labels.append(int(match.group(1)))
    next_speaker_number = max(numeric_labels, default=-1) + 1

    for current_speaker in current_speakers:
        if current_speaker not in mapping:
            while f'SPEAKER_{next_speaker_number:02d}' in existing_labels:
                next_speaker_number += 1
            mapping[current_speaker] = f'SPEAKER_{next_speaker_number:02d}'
            existing_labels.add(mapping[current_speaker])
            next_speaker_number += 1

    return mapping


def _get_overlap_segments(sequence: 'DiarizationSequence') -> list[dict]:
    """Load the preceding run's segments for the intentionally repeated chunk."""
    if not sequence.is_continuation or len(sequence.chunks) < 2:
        return []

    overlap_end = sequence.chunks[1]['start']
    result = call_resource('mongo', {
        "action": "find",
        "collection": "diarizations",
        "query": {
            "original_id": sequence.original_id,
            "end": {"$gt": sequence.start},
            "start": {"$lt": overlap_end},
        },
        "options": {
            "projection": {"speaker": 1, "embedding": 1, "start": 1, "end": 1},
            "sort": {"start": 1},
        },
    })
    if isinstance(result, list):
        return result
    return result.get('data', []) if isinstance(result, dict) else []


def _get_existing_speaker_labels(original_id: ObjectId) -> set[str]:
    result = call_resource('mongo', {
        "action": "aggregate",
        "collection": "diarizations",
        "pipeline": [
            {"$match": {"original_id": original_id}},
            {"$group": {"_id": "$speaker"}},
        ],
    })
    return {item['_id'] for item in (result or []) if item.get('_id')}


def _clip_continuation_segment(
    start: datetime,
    end: datetime,
    overlap_end: Optional[datetime],
) -> Optional[tuple[datetime, datetime]]:
    if overlap_end is None:
        return start, end
    if end <= overlap_end:
        return None
    return max(start, overlap_end), end


def _segment_identity_key(
    run_id: str,
    sequence: 'DiarizationSequence',
    segment_index: int,
) -> str:
    """Stable key used to make every diarization write safe to resume."""
    raw = (
        f"{run_id}:{sequence.original_id}:{sequence.min_index}:"
        f"{sequence.max_index}:{segment_index}"
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _classify_diarization_error(
    sequence: 'DiarizationSequence',
    route: str,
    error: Exception,
    *,
    attempt: int = 1,
    http_status: Optional[int] = None,
) -> dict[str, Any]:
    message = str(error)
    lowered = message.lower()
    status = http_status
    if status is None and isinstance(error, requests.exceptions.HTTPError):
        status = error.response.status_code if error.response is not None else None

    if isinstance(error, (requests.exceptions.Timeout, TimeoutError)) or "timed out" in lowered:
        category = "timeout"
    elif isinstance(error, requests.exceptions.ConnectionError):
        category = "provider_network"
    elif status == 429:
        category = "provider_busy"
    elif status == 413:
        category = "payload_too_large"
    elif "embedding space" in lowered:
        category = "embedding_space_mismatch"
    # A server fault often quotes the filename it was given, so the message
    # keywords below must not outrank an explicit 5xx.
    elif status is not None and status >= 500:
        category = "provider_http"
    elif any(token in lowered for token in ("decode", "codec", "audio", "opus", "wav")):
        category = "invalid_audio"
    elif any(token in lowered for token in ("forbidden", "unauthorized", "permission", "mongo")):
        category = "persistence_auth"
    elif status is not None:
        category = "provider_http"
    else:
        category = "unknown"

    retryable = category == "provider_busy" or (
        category in {
            "timeout",
            "provider_network",
            "provider_http",
            "invalid_audio",
            "unknown",
        }
        and attempt < 3
    )
    return {
        "originalId": str(sequence.original_id),
        "start": sequence.start,
        "end": sequence.last.get("start", sequence.start),
        "category": category,
        "message": message,
        "httpStatus": status,
        "route": route,
        "attempt": attempt,
        "retryable": retryable,
        "status": "will_retry" if retryable else "needs_attention",
    }


def _failure_retry_state(attempt: int) -> dict[str, Any]:
    delays = (60, 300, 1800)
    if attempt >= 3:
        return {"status": "needs_attention", "delaySeconds": None}
    return {
        "status": "will_retry",
        "delaySeconds": delays[max(attempt - 1, 0)],
    }


def _record_sequence_failure(
    sequence: 'DiarizationSequence',
    detail: dict[str, Any],
) -> None:
    retry = (
        {"status": "will_retry", "delaySeconds": 60}
        if detail.get("category") == "provider_busy"
        else _failure_retry_state(int(detail.get("attempt", 1)))
    )
    retry_at = (
        datetime.now(tz=UTC) + timedelta(seconds=retry["delaySeconds"])
        if retry["delaySeconds"] is not None
        else None
    )
    detail.update({"status": retry["status"], "retryAt": retry_at})
    call_resource('mongo', {
        "action": "updateMany",
        "collection": "audio_chunks",
        "query": {"_id": {"$in": [chunk["_id"] for chunk in sequence.chunks]}},
        "update": {"$set": {"diarizationFailure": detail}},
    })


class DiarizationSequence(BaseModel):
    original_id: ObjectId
    chunks: list[Any] = Field(default_factory=list)
    is_partial: bool = False
    is_continuation: bool = False

    class Config:
        arbitrary_types_allowed = True

    @property
    def last(self) -> Any:
        return self.chunks[-1]

    @property
    def start(self) -> datetime:
        return self.chunks[0]['start'] if self.chunks else datetime.now(tz=UTC)

    @property
    def min_index(self) -> int:
        return self.chunks[0]['index'] if self.chunks else 0

    @property
    def max_index(self) -> int:
        return self.last['index']

    def __repr__(self):
        indices = [chunk['index'] for chunk in self.chunks]
        return f'{self.original_id}: {repr(indices)}'


@dataclass
class PreparedDiarizationSequence:
    sequence: DiarizationSequence
    wav_file: io.BytesIO
    total_samples: int
    stage_timings_seconds: dict[str, float] = field(default_factory=dict)

    def close(self) -> None:
        self.wav_file.close()



def _build_pending_chunk_filters(
    filters: Optional[dict[str, Any]] = None,
    include_diarized: bool = False,
) -> dict[str, Any]:
    base_filters: dict[str, Any] = {
        'processing_by': None,
        'vad.has_speech': True,
        'diarizationFailure.status': {'$ne': 'needs_attention'},
        # $not/$gt matches missing and null retryAt values as well as retries
        # whose delay has elapsed, while remaining index-friendly.
        'diarizationFailure.retryAt': {'$not': {'$gt': datetime.now(tz=UTC)}},
    }
    if not include_diarized:
        base_filters['diarized_at'] = None

    if filters:
        base_filters.update(filters)

    return base_filters


def count_pending_chunks(filters: Optional[dict[str, Any]] = None) -> Optional[int]:
    """
    Count audio chunks that still need diarization.
    """
    query = _build_pending_chunk_filters(filters)
    result = call_resource('mongo', {
        "action": "count",
        "collection": "audio_chunks",
        "query": query,
        "options": {
            "hint": "audio_chunks_diarization_ready_backlog_v1",
            "maxTimeMS": 5_000,
        },
    })
    return int(result) if result is not None else None


def count_pending_sequences(filters: Optional[dict[str, Any]] = None) -> Optional[int]:
    """
    Estimate how many distinct originals still have pending chunks.
    """
    pipeline = [
        {"$match": _build_pending_chunk_filters(filters)},
        {"$group": {"_id": "$original_id"}},
        {"$count": "total"},
    ]
    result = call_resource('mongo', {
        "action": "aggregate",
        "collection": "audio_chunks",
        "pipeline": pipeline,
    })
    if not result:
        return 0
    return int(result[0].get('total', 0))


def _format_eta(seconds: Optional[float]) -> str:
    if seconds is None or not math.isfinite(seconds) or seconds <= 0:
        return 'n/a'
    return str(timedelta(seconds=int(seconds)))



def get_diarization_sequences(limit=10, filters=None, max_sequence_length=MAX_SEQUENCE_CHUNKS, worker_id=None, include_diarized=False) -> Iterator[DiarizationSequence]:
    sequences_by_id: dict[ObjectId, DiarizationSequence] = {}
    yielded = 0

    base_filters = _build_pending_chunk_filters(filters, include_diarized=include_diarized)

    cursor = mongo_cursor('audio_chunks', base_filters, {
        "projection": DIARIZATION_METADATA_PROJECTION,
        "sort": {"start": 1},  # Sort ascending to get consecutive chunks
        "hint": (
            "audio_chunks_diarization_coverage_v1"
            if include_diarized
            else "audio_chunks_diarization_pending_v2"
        ),
        # A worker may lose recording leases to another concurrent lane. Bound
        # how much shared historical metadata one job can walk before yielding
        # its slot; the continuation watchdog can start a fresh bounded pass.
        "limit": DIARIZATION_CURSOR_MAX_DOCUMENTS,
        "maxTimeMS": DIARIZATION_CURSOR_MAX_TIME_MS,
    })
    try:
        for chunk in cursor:
            if limit is not None and yielded >= limit:
                break

            original_id = chunk['original_id']
            start = chunk['start']

            # Clean up old sequences that are too far in the past
            for existing_id, seq in tuple(sequences_by_id.items()):
                if start - seq.start > timedelta(seconds=600):
                    if not seq.is_continuation or len(seq.chunks) > 1:
                        yield seq
                        yielded += 1
                    del sequences_by_id[existing_id]

            seq = sequences_by_id.get(original_id)

            # Break the sequence when the chunks stop being consecutive, or when
            # the recording paused long enough that joining them would send mostly
            # silence to the diarizer.
            if seq and (
                seq.max_index + 1 != chunk['index']
                or start - seq.last['start'] > MAX_SEQUENCE_GAP
            ):
                assert chunk not in seq.chunks
                yield seq
                yielded += 1
                del sequences_by_id[original_id]
                seq = None

            if original_id not in sequences_by_id:
                try:
                    seq = sequences_by_id[original_id] = DiarizationSequence(
                        original_id=original_id,
                        chunks=[]
                    )
                except Exception as e:
                    log_info(f"ERROR: Creating diarization sequence for {original_id}: {e}")
                    continue

            seq.chunks.append(chunk)

            # If we've reached max sequence length, yield it and create continuation
            if len(seq.chunks) >= max_sequence_length:
                seq.is_partial = True
                yield seq
                yielded += 1
                sequences_by_id[original_id] = DiarizationSequence(
                    original_id=original_id,
                    chunks=[chunk],
                    is_continuation=True,
                )
    finally:
        close_cursor = getattr(cursor, 'close', None)
        if close_cursor:
            close_cursor()

    # Yield remaining sequences
    if limit is None or yielded < limit:
        for seq in sequences_by_id.values():
            yield seq


def get_diarization_recording_candidates(
    filters: dict[str, Any] | None = None,
    *,
    include_diarized: bool = False,
    limit: int = DIARIZATION_RECORDING_CANDIDATE_LIMIT,
) -> Iterator[ObjectId]:
    """Yield distinct pending recordings in the same order as sequence work.

    A concurrent job leases one of these originals before opening its sequence
    cursor. This keeps every lane on one recording and prevents one fast lane
    from prefetching leases that the rest of the GPU pool could process.
    """
    if limit < 1:
        return

    base_filters = _build_pending_chunk_filters(
        filters,
        include_diarized=include_diarized,
    )
    cursor = mongo_cursor('audio_chunks', base_filters, {
        "projection": {'original_id': 1},
        "sort": {"start": 1},
        "hint": (
            "audio_chunks_diarization_coverage_v1"
            if include_diarized
            else "audio_chunks_diarization_pending_v2"
        ),
        "limit": DIARIZATION_CURSOR_MAX_DOCUMENTS,
        "maxTimeMS": DIARIZATION_CURSOR_MAX_TIME_MS,
    })
    seen: set[ObjectId] = set()
    try:
        for chunk in cursor:
            original_id = chunk.get('original_id')
            if not isinstance(original_id, ObjectId) or original_id in seen:
                continue
            seen.add(original_id)
            yield original_id
            if len(seen) >= limit:
                return
    finally:
        close_cursor = getattr(cursor, 'close', None)
        if close_cursor:
            close_cursor()


def combine_chunks_to_wav(sequence: DiarizationSequence) -> tuple[io.BytesIO, int]:
    """
    Combine opus chunks into a single WAV file, tracking total samples.
    Handles gaps between chunks by inserting silence.
    Returns tuple of WAV BytesIO and number of audio samples.
    """
    audio_arrays = []
    chunk_sample_counts: list[int] = []
    current_time = sequence.start

    for chunk in sequence.chunks:
        # Decode opus chunk to numpy array
        audio = read_codec(chunk['data'], codec="opus", sample_rate=sample_rate)
        chunk_sample_counts.append(len(audio))
        chunk_duration = timedelta(seconds=len(audio) / sample_rate)

        # Calculate gap between expected time and actual chunk start
        gap = (chunk['start'] - current_time).total_seconds()

        if gap > 0:
            # Insert silence for gap
            silence_samples = int(gap * sample_rate)
            audio_arrays.append(np.zeros(silence_samples, dtype=np.float32))
        elif gap < 0:
            # Overlap - truncate previous audio or handle overlap
            overlap_samples = int(-gap * sample_rate)
            if audio_arrays and len(audio_arrays[-1]) > overlap_samples:
                audio_arrays[-1] = audio_arrays[-1][:-overlap_samples]

        audio_arrays.append(audio)
        current_time = chunk['start'] + chunk_duration

    # Concatenate all audio arrays
    combined_audio = np.concatenate(audio_arrays, axis=0)

    # Convert to WAV
    wav_file = array_to_wav(combined_audio, sample_rate=sample_rate)
    # BytesIO supports task-local metadata without changing this established
    # function's public two-tuple contract.
    wav_file.mycelia_chunk_sample_counts = chunk_sample_counts
    return wav_file, len(combined_audio)


def _get_claim_owner(chunk_id: ObjectId) -> Optional[str]:
    doc = call_resource('mongo', {
        "action": "findOne",
        "collection": "audio_chunks",
        "query": {'_id': chunk_id},
        "options": {"projection": {"processing_by": 1}},
    })
    if doc:
        return doc.get('processing_by')
    return None


def claim_sequence(
    seq: DiarizationSequence,
    worker_id: str,
    *,
    include_diarized: bool = False,
) -> tuple[bool, Optional[str]]:
    chunk_ids = [chunk['_id'] for chunk in seq.chunks]
    success = claim_chunks(
        chunk_ids,
        worker_id,
        required_filters=_build_pending_chunk_filters(
            include_diarized=include_diarized,
        ),
    )

    if not success:
        release_sequence(seq, worker_id)
        owner = _get_claim_owner(chunk_ids[0]) if chunk_ids else None
        return False, owner

    return True, None


def hydrate_claimed_sequence(
    seq: DiarizationSequence,
    worker_id: str,
) -> DiarizationSequence:
    """Load audio bytes only after every candidate chunk belongs to this worker."""
    if all('data' in chunk for chunk in seq.chunks):
        return seq

    chunk_ids = [chunk['_id'] for chunk in seq.chunks]
    result = call_resource('mongo', {
        "action": "find",
        "collection": "audio_chunks",
        "query": {
            '_id': {'$in': chunk_ids},
            'processing_by': worker_id,
        },
        "options": {
            "projection": {
                '_id': 1,
                'original_id': 1,
                'index': 1,
                'start': 1,
                'data': 1,
                'diarizationFailure': 1,
            },
            "limit": len(chunk_ids),
            "hint": "_id_",
            "maxTimeMS": DIARIZATION_HYDRATE_MAX_TIME_MS,
        },
    })
    docs = result.get('data', []) if isinstance(result, dict) else result
    by_id = {doc['_id']: doc for doc in docs or []}
    missing_ids = [chunk_id for chunk_id in chunk_ids if chunk_id not in by_id]
    if missing_ids:
        raise RuntimeError(
            f"Could not hydrate {len(missing_ids)} claimed audio chunk(s)"
        )

    return DiarizationSequence(
        original_id=seq.original_id,
        chunks=[by_id[chunk_id] for chunk_id in chunk_ids],
        is_partial=seq.is_partial,
        is_continuation=seq.is_continuation,
    )


def hydrate_leased_sequence(
    seq: DiarizationSequence,
    worker_id: str,
    *,
    include_diarized: bool = False,
    resource_call: Optional[Callable[[str, dict], Any]] = None,
) -> DiarizationSequence:
    """Boundedly load immutable audio under an original-wide lease.

    The next continuation deliberately overlaps the current sequence's last
    chunk. During lookahead that chunk may still be claimed by this same job,
    so hydration accepts either an unclaimed chunk or this job's ownership.
    The full pending-state contract is rechecked by claim_sequence immediately
    before the external provider request.
    """
    if all('data' in chunk for chunk in seq.chunks):
        return seq

    chunk_ids = [chunk['_id'] for chunk in seq.chunks]
    pending = _build_pending_chunk_filters(include_diarized=include_diarized)
    pending['processing_by'] = {'$in': [None, worker_id]}
    invoke_resource = resource_call or call_resource
    result = invoke_resource('mongo', {
        "action": "find",
        "collection": "audio_chunks",
        "query": {
            **pending,
            '_id': {'$in': chunk_ids},
            'original_id': seq.original_id,
        },
        "options": {
            "projection": {
                '_id': 1,
                'original_id': 1,
                'index': 1,
                'start': 1,
                'data': 1,
                'diarizationFailure': 1,
            },
            "limit": len(chunk_ids),
            "hint": "_id_",
            "maxTimeMS": DIARIZATION_HYDRATE_MAX_TIME_MS,
        },
    })
    docs = result.get('data', []) if isinstance(result, dict) else result
    by_id = {doc['_id']: doc for doc in docs or []}
    missing_ids = [chunk_id for chunk_id in chunk_ids if chunk_id not in by_id]
    if missing_ids:
        raise RuntimeError(
            f"Could not hydrate {len(missing_ids)} leased audio chunk(s)"
        )

    return DiarizationSequence(
        original_id=seq.original_id,
        chunks=[by_id[chunk_id] for chunk_id in chunk_ids],
        is_partial=seq.is_partial,
        is_continuation=seq.is_continuation,
    )


def prepare_diarization_sequence(
    sequence: DiarizationSequence,
    worker_id: str,
    *,
    include_diarized: bool = False,
    resource_call: Optional[Callable[[str, dict], Any]] = None,
) -> PreparedDiarizationSequence:
    """Hydrate and decode one lookahead sequence under its recording lease."""
    timings = StageTimings()
    with timings.measure("hydrate"):
        hydrated = hydrate_leased_sequence(
            sequence,
            worker_id,
            include_diarized=include_diarized,
            resource_call=resource_call,
        )
    with timings.measure("decode"):
        wav_file, total_samples = combine_chunks_to_wav(hydrated)
        wav_file.seek(0)
    return PreparedDiarizationSequence(
        sequence=hydrated,
        wav_file=wav_file,
        total_samples=total_samples,
        stage_timings_seconds=timings.values,
    )


def release_sequence(seq: DiarizationSequence, worker_id: str):
    chunk_ids = [chunk['_id'] for chunk in seq.chunks]
    release_chunks(chunk_ids, worker_id)


def diarize_sequence(
    sequence: DiarizationSequence,
    worker_id: str,
    *,
    run_id: str = "legacy-v0",
    generation: int = 0,
    lifecycle_status: str = "active",
    mark_chunks: bool = True,
    expected_embedding_space_id: Optional[str] = None,
    expected_model_id: Optional[str] = None,
    expected_model_version: Optional[str] = None,
    server_url: Optional[str] = None,
    prepared: Optional[PreparedDiarizationSequence] = None,
    provider_session: Optional[requests.Session] = None,
    speaker_profiles_snapshot: Optional[list] = None,
):
    """
    Combine chunks to WAV, call diarization API, and save results to MongoDB.
    """
    start_time = time.time()
    started_monotonic = time.monotonic()
    if prepared is not None:
        sequence = prepared.sequence
    timings = StageTimings(
        prepared.stage_timings_seconds if prepared is not None else None
    )
    timestamp = sequence.start.strftime("%Y-%m-%d %H:%M:%S")
    chunks_count = len(sequence.chunks)
    chunks_marked = 0
    original_id = str(sequence.original_id)
    failure_attempt = max(
        [int(chunk.get('diarizationFailure', {}).get('attempt', 0)) for chunk in sequence.chunks]
        or [0]
    ) + 1

    payload_bytes = 0
    payload_duration = 0.0
    useful_audio_duration = 0.0
    wav_file: Optional[io.BytesIO] = prepared.wav_file if prepared else None

    def finish(result: dict[str, Any]) -> dict[str, Any]:
        timings.values["total"] = max(
            time.monotonic() - started_monotonic,
            0.0,
        )
        result["stage_timings_ms"] = timings.milliseconds()
        result["audio_seconds"] = useful_audio_duration
        result["useful_audio_seconds"] = useful_audio_duration
        result["payload_audio_seconds"] = payload_duration
        return result

    try:
        with timings.measure("claim"):
            claimed, claimed_by = claim_sequence(
                sequence,
                worker_id,
                include_diarized=not mark_chunks,
            )
        if not claimed:
            claimant_text = f' by {claimed_by}' if claimed_by else ''
            log_info(f'{timestamp}  {chunks_count:3d} chunks  {original_id}  skipped (claimed{claimant_text})')
            return finish({
                "status": "skipped",
                "skip_reason": "chunk_claim",
                "chunks": 0,
                "chunks_diarized": 0,
                "duration": 0,
                "segments": 0,
            })

        if prepared is None:
            try:
                with timings.measure("hydrate"):
                    sequence = hydrate_claimed_sequence(sequence, worker_id)
            except Exception as exc:
                release_sequence(sequence, worker_id)
                detail = {
                    "category": "mongo_hydration",
                    "message": str(exc),
                    "retryable": True,
                    "status": "will_retry",
                }
                log_info(
                    f'{timestamp}  {chunks_count:3d} chunks  {original_id}  '
                    f'ERROR: claimed audio hydration failed: {exc}'
                )
                return finish({
                    "status": "error",
                    "error": str(exc),
                    "errorDetail": detail,
                    "chunks": 0,
                    "chunks_diarized": 0,
                    "duration": time.time() - start_time,
                    "segments": 0,
                })

            with timings.measure("decode"):
                wav_file, total_samples = combine_chunks_to_wav(sequence)
                wav_file.seek(0)
        else:
            total_samples = prepared.total_samples
        assert wav_file is not None
        payload_bytes = wav_file.getbuffer().nbytes
        payload_duration = total_samples / sample_rate if total_samples else 0.0
        chunk_sample_counts = getattr(
            wav_file,
            "mycelia_chunk_sample_counts",
            None,
        )
        if chunk_sample_counts:
            # A partial sequence deliberately retains its last chunk as the
            # next request's continuity overlap. Count the padded payload once,
            # but defer that retained chunk's decoded duration until the next
            # sequence commits it.
            retained_overlap_samples = (
                chunk_sample_counts[-1] if sequence.is_partial else 0
            )
            useful_audio_duration = (
                max(total_samples - retained_overlap_samples, 0) / sample_rate
            )
        else:
            # Test doubles and legacy prepared objects do not carry per-chunk
            # decode metrics; payload duration is the conservative fallback.
            useful_audio_duration = payload_duration

        # Check if speaker identification is enabled and get profiles
        speaker_profiles = []
        clusters_param = None
        with timings.measure("speaker_profiles"):
            if run_id == "legacy-v0" and speaker_profiles_snapshot is not None:
                speaker_profiles = speaker_profiles_snapshot
            elif run_id == "legacy-v0" and _is_speaker_identification_enabled():
                speaker_profiles = _get_speaker_profiles()
            if expected_embedding_space_id:
                speaker_profiles = [
                    profile
                    for profile in speaker_profiles
                    if profile.get("embeddingSpaceId")
                    == expected_embedding_space_id
                    and isinstance(profile.get("revision"), int)
                    and not isinstance(profile.get("revision"), bool)
                    and profile["revision"] > 0
                ]
            else:
                # A route without exact runtime provenance cannot safely use
                # enrolled embeddings for automatic identification.
                speaker_profiles = []
            if speaker_profiles:
                clusters_param = _build_clusters_param(speaker_profiles)
                log_info(f'  → Speaker identification enabled with {len(speaker_profiles)} profiles')

        # Call diarization API
        request_data, request_params = _build_diarization_request_fields(clusters_param)
        
        effective_server_url = (server_url or DIARIZATION_SERVER_URL).rstrip('/')
        post = provider_session.post if provider_session is not None else requests.post
        with timings.measure("provider"):
            response = post(
                f'{effective_server_url}/diarize',
                files={'file': ('audio.wav', wav_file, 'audio/wav')},
                data=request_data if request_data else None,
                params=request_params if request_params else None,
                timeout=(10, 300 + len(sequence.chunks) * 3),
            )
            response.raise_for_status()
            data = response.json()
        service_timings = data.get("timings")
        if isinstance(service_timings, dict):
            for raw_name, raw_milliseconds in service_timings.items():
                if (
                    not isinstance(raw_name, str)
                    or not raw_name.endswith("_ms")
                    or isinstance(raw_milliseconds, bool)
                    or not isinstance(raw_milliseconds, (int, float))
                ):
                    continue
                milliseconds = float(raw_milliseconds)
                if not math.isfinite(milliseconds) or milliseconds < 0:
                    continue
                timings.add(
                    f"server_{raw_name[:-3]}",
                    milliseconds / 1000.0,
                )
        segments = data.get('segments', [])
        embedding_space_id = data.get('embeddingSpaceId', 'legacy-unknown')
        runtime_provenance = extract_diarizator_runtime_provenance(data)
        if expected_embedding_space_id and embedding_space_id != expected_embedding_space_id:
            raise ValueError(
                f"Diarizator embedding space changed while building run: {embedding_space_id} != {expected_embedding_space_id}"
            )
        if expected_model_id and (
            runtime_provenance or {}
        ).get("modelId") != expected_model_id:
            raise ValueError(
                "Diarizator model changed after route admission: "
                f"{(runtime_provenance or {}).get('modelId')} != "
                f"{expected_model_id}"
            )
        if expected_model_version and (
            runtime_provenance or {}
        ).get("modelVersion") != expected_model_version:
            raise ValueError(
                "Diarizator model version changed after route admission: "
                f"{(runtime_provenance or {}).get('modelVersion')} != "
                f"{expected_model_version}"
            )

        with timings.measure("continuity"):
            previous_segments = _get_overlap_segments(sequence)
            reserved_labels = _get_existing_speaker_labels(sequence.original_id)
            speaker_label_mapping = _reconcile_speaker_labels(
                segments,
                previous_segments,
                reserved_labels=reserved_labels,
            )
            for segment in segments:
                segment['speaker'] = speaker_label_mapping.get(segment['speaker'], segment['speaker'])

        if not segments:
            # No segments found, mark as processed
            with timings.measure("release"):
                chunks_marked = mark_as_diarized(sequence, worker_id)
            end_time = time.time()
            duration = end_time - start_time
            chunk_rate = (chunks_marked / duration) if chunks_marked and duration > 0 else None
            chunk_rate_display = f'{chunk_rate:.2f} ch/s' if chunk_rate else 'n/a'
            remaining_in_sequence = max(chunks_count - chunks_marked, 0)
            log_info(
                f'{timestamp}  {chunks_count:3d} chunks  {original_id}  '
                f'processed={chunks_marked}/{chunks_count} (seq_left={remaining_in_sequence}) @ {chunk_rate_display}  '
                f'no_segments  payload={payload_bytes / (1024 * 1024):.2f} MiB/{payload_duration:.1f}s'
            )
            return finish({
                "status": "no_segments",
                "chunks": chunks_count,
                "chunks_diarized": chunks_marked,
                "duration": duration,
                "segments": 0,
                "runtimeProvenance": runtime_provenance,
            })

        # Generate unique inference_id for this diarization run
        inference_id = ObjectId()
        sequence_start_time = sequence.start

        # Build profile ID to profile lookup for matched speaker info
        profile_lookup = {str(p["_id"]): p for p in speaker_profiles} if speaker_profiles else {}

        # Save each segment as a separate document
        segment_operations: list[dict] = []
        matched_segments = 0
        overlap_end = sequence.chunks[1]['start'] if sequence.is_continuation and len(sequence.chunks) > 1 else None
        for segment_index, segment in enumerate(segments):
            # Convert relative times to absolute datetimes
            segment_start_relative = segment['start']  # seconds relative to audio start
            segment_end_relative = segment['end']  # seconds relative to audio start

            # Calculate absolute start time (sequence start + relative offset)
            segment_start_absolute = sequence_start_time + timedelta(seconds=segment_start_relative)
            segment_end_absolute = sequence_start_time + timedelta(seconds=segment_end_relative)

            # The first chunk of a continuation was already stored by the
            # preceding request. It is repeated only to reconcile speaker IDs.
            clipped_bounds = _clip_continuation_segment(
                segment_start_absolute,
                segment_end_absolute,
                overlap_end,
            )
            if clipped_bounds is None:
                continue
            segment_start_absolute, segment_end_absolute = clipped_bounds

            # Build diarization document
            diar_doc = {
                "inference_id": inference_id,
                "original_id": sequence.original_id,
                "start": segment_start_absolute,
                "end": segment_end_absolute,
                "speaker": segment['speaker'],
                "embedding": segment['embedding'],  # 256 floats
                "duration": (segment_end_absolute - segment_start_absolute).total_seconds(),
                "created_at": datetime.now(tz=UTC),
                "runId": run_id,
                "generation": generation,
                "embeddingSpaceId": embedding_space_id,
                **(
                    {
                        "modelId": runtime_provenance["modelId"],
                        "modelVersion": runtime_provenance["modelVersion"],
                        "runtimeProvenanceSource": "inference_response",
                    }
                    if runtime_provenance
                    else {}
                ),
                "lifecycleStatus": lifecycle_status,
            }
            diar_doc["segmentKey"] = _segment_identity_key(
                run_id, sequence, segment_index
            )

            # Add matched_speaker if cluster was matched
            cluster_id = segment.get('cluster_id')
            if cluster_id and cluster_id in profile_lookup:
                profile = profile_lookup[cluster_id]
                diar_doc["matched_speaker"] = {
                    "profile_id": profile["_id"],
                    "name": profile.get("name", "Unknown"),
                    "similarity": segment.get('similarity', 0),
                    "matched_at": datetime.now(tz=UTC),
                    "method": "live",
                    "profile_revision": profile["revision"],
                    "embedding_space_id": embedding_space_id,
                }
                matched_segments += 1

            segment_operations.append({
                "updateOne": {
                    "filter": {
                        "runId": run_id,
                        "segmentKey": diar_doc["segmentKey"],
                    },
                    "update": {"$setOnInsert": diar_doc},
                    "upsert": True,
                },
            })

        # One round trip per sequence: a partial write followed by a crash
        # would leave chunks unmarked and be redone from the start.
        saved_segments = len(segment_operations)
        if segment_operations:
            with timings.measure("persist"):
                call_resource('mongo', {
                    "action": "bulkWrite",
                    "collection": "diarizations",
                    "operations": segment_operations,
                })

        # Mark chunks as diarized
        with timings.measure("release"):
            if mark_chunks:
                chunks_marked = mark_as_diarized(sequence, worker_id)
            else:
                release_sequence(sequence, worker_id)
                chunks_marked = chunks_count

        end_time = time.time()
        duration = end_time - start_time
        chunk_rate = (chunks_marked / duration) if chunks_marked and duration > 0 else None
        chunk_rate_display = f'{chunk_rate:.2f} ch/s' if chunk_rate else 'n/a'
        remaining_in_sequence = max(chunks_count - chunks_marked, 0)
        matched_info = f', matched={matched_segments}' if matched_segments else ''
        log_info(
            f'{timestamp}  {chunks_count:3d} chunks  {original_id}  '
            f'processed={chunks_marked}/{chunks_count} (seq_left={remaining_in_sequence}) @ {chunk_rate_display}  '
            f'diarized  {saved_segments} segments{matched_info}  payload={payload_bytes / (1024 * 1024):.2f} MiB/{payload_duration:.1f}s'
        )
        return finish({
            "status": "diarized",
            "chunks": chunks_count,
            "chunks_diarized": chunks_marked,
            "duration": duration,
            "segments": saved_segments,
            "matched_segments": matched_segments,
            "runtimeProvenance": runtime_provenance,
        })

    except requests.exceptions.ReadTimeout:
        end_time = time.time()
        release_sequence(sequence, worker_id)
        log_info(f'{timestamp}  {chunks_count:3d} chunks  {original_id}  ERROR: ReadTimeout')
        log_info(f'  → Increase timeout or check diarization server at {server_url or DIARIZATION_SERVER_URL}')
        detail = _classify_diarization_error(
            sequence,
            server_url or DIARIZATION_SERVER_URL,
            TimeoutError("Diarization request timed out"),
            attempt=failure_attempt,
        )
        if mark_chunks:
            _record_sequence_failure(sequence, detail)
        return finish({
            "status": "error",
            "error": "Diarization request timed out",
            "errorDetail": detail,
            "chunks": 0,
            "chunks_diarized": 0,
            "duration": end_time - start_time,
            "segments": 0,
        })

    except requests.exceptions.HTTPError as http_err:
        end_time = time.time()
        release_sequence(sequence, worker_id)
        status_code = (
            http_err.response.status_code
            if http_err.response is not None
            else None
        )
        extra_context = ''
        if status_code == 413:
            extra_context = (
                f'payload={payload_bytes / (1024 * 1024):.2f} MiB/'
                f'{payload_duration:.1f}s exceeded server limit; '
                'lower --max-chunks or DIARIZATION_MAX_SEQUENCE_CHUNKS.'
            )
        elif status_code == 404:
            extra_context = 'endpoint not found; verify DIARIZATION_SERVER_URL or server routing.'
        log_info(
            f'{timestamp}  {chunks_count:3d} chunks  {original_id}  '
            f'ERROR: {status_code} {http_err} {extra_context}'.rstrip()
        )
        detail = _classify_diarization_error(
            sequence,
            server_url or DIARIZATION_SERVER_URL,
            http_err,
            attempt=failure_attempt,
            http_status=status_code,
        )
        if mark_chunks:
            _record_sequence_failure(sequence, detail)
        return finish({
            "status": "error",
            "error": f"HTTP {status_code}: {http_err}",
            "errorDetail": detail,
            "chunks": 0,
            "chunks_diarized": 0,
            "duration": end_time - start_time,
            "segments": 0,
        })

    except Exception as e:
        end_time = time.time()
        release_sequence(sequence, worker_id)
        log_info(f'{timestamp}  {chunks_count:3d} chunks  {original_id}  ERROR: {str(e)}')
        detail = _classify_diarization_error(
            sequence,
            server_url or DIARIZATION_SERVER_URL,
            e,
            attempt=failure_attempt,
        )
        if mark_chunks:
            _record_sequence_failure(sequence, detail)
        return finish({
            "status": "error",
            "error": str(e),
            "errorDetail": detail,
            "chunks": 0,
            "chunks_diarized": 0,
            "duration": end_time - start_time,
            "segments": 0,
        })
    finally:
        if wav_file is not None:
            wav_file.close()


def mark_as_diarized(seq: DiarizationSequence, worker_id: Optional[str] = None) -> int:
    """
    Mark chunks as diarized by setting diarized_at timestamp.
    For partial sequences, mark all but the last chunk.
    """
    chunks_to_mark = seq.chunks[:-1] if seq.is_partial else seq.chunks
    if not chunks_to_mark:
        if worker_id:
            release_sequence(seq, worker_id)
        return 0

    query = {
        '_id': {'$in': [chunk['_id'] for chunk in chunks_to_mark]},
    }
    update_fields = {
        'diarized_at': datetime.now(tz=UTC),
    }
    if worker_id:
        query['processing_by'] = worker_id
        update_fields.update({
            'processing_by': None,
            'claimed_at': None,
        })

    result = call_resource('mongo', {
        "action": "updateMany",
        "collection": "audio_chunks",
        "query": query,
        "update": {
            '$set': update_fields,
            '$unset': {'diarizationFailure': ''},
        }
    })

    if worker_id and seq.is_partial:
        release_chunks([seq.last['_id']], worker_id)

    return int(result.get('modifiedCount', len(chunks_to_mark)))


def process_diarization_sequences(limit=None, max_workers=1, worker_id=None, max_sequence_length=None):
    if worker_id is None:
        worker_id = get_worker_id()

    log_info(f'Worker ID: {worker_id}')
    log_info(f'Using {max_workers} parallel worker(s)')
    log_info(f'Diarization server: {DIARIZATION_SERVER_URL}')
    effective_max_sequence_length = max_sequence_length if max_sequence_length and max_sequence_length > 0 else MAX_SEQUENCE_CHUNKS
    log_info(f'Max chunks per request: {effective_max_sequence_length}')

    pending_sequences_total: Optional[int] = None
    pending_chunks_total: Optional[int] = None

    try:
        pending_sequences_total = count_pending_sequences()
    except Exception as exc:
        log_info(f'Pending sequence count unavailable: {exc}')

    try:
        pending_chunks_total = count_pending_chunks()
    except Exception as exc:
        log_info(f'Pending chunk count unavailable: {exc}')

    pending_parts = []
    if pending_sequences_total is not None:
        pending_parts.append(f'sequences={pending_sequences_total}')
    if pending_chunks_total is not None:
        pending_parts.append(f'chunks={pending_chunks_total}')

    if pending_parts:
        log_info('Pending work: ' + ', '.join(pending_parts))
    else:
        log_info('Pending work: unknown (unable to query MongoDB)')

    log_info('Initial metrics: processed_chunks=0, chunk_rate=0.00 ch/s, eta=n/a')
    log_info('Progress legend: count [elapsed, avg/seq, chunks=completed chunks, ch_sec=current chunks/sec, eta=time remaining, errors=total errors]')

    processed_count = 0
    stats = {'diarized': 0, 'no_segments': 0, 'error': 0, 'skipped': 0}
    completed_chunks = 0
    total_segments = 0
    batch_size = min(limit if limit else 1000, 1000)
    run_start_time = time.time()

    total = limit if limit else None
    bar_format = '{n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}{postfix}]' if total else '{n_fmt} [{elapsed}, {rate_fmt}{postfix}]'

    with tqdm(total=total, desc="Processing", unit="seq", bar_format=bar_format) as pbar:

        def record_result(result: dict[str, Any]) -> bool:
            nonlocal processed_count, completed_chunks, total_segments
            status = result["status"]

            if status in stats:
                stats[status] += 1

            total_segments += result.get("segments", 0)
            completed_chunks += result.get("chunks_diarized", 0)

            counted = status != "skipped"
            if counted:
                processed_count += 1

            pbar.update(1)

            elapsed = max(time.time() - run_start_time, 0.0)
            chunks_per_sec = (completed_chunks / elapsed) if completed_chunks and elapsed > 0 else None
            remaining_chunks = None
            if pending_chunks_total is not None:
                remaining_chunks = max(pending_chunks_total - completed_chunks, 0)
            eta_seconds = (remaining_chunks / chunks_per_sec) if chunks_per_sec and remaining_chunks is not None and chunks_per_sec > 0 else None

            total_display = f"{completed_chunks}/{pending_chunks_total}" if pending_chunks_total is not None else f"{completed_chunks}/?"
            remaining_display = str(remaining_chunks) if remaining_chunks is not None else 'n/a'
            pbar.set_postfix(
                seqs=processed_count,
                chunks=total_display,
                rem=remaining_display,
                skipped=stats['skipped'],
                ch_sec=f"{chunks_per_sec:.2f}" if chunks_per_sec else 'n/a',
                eta=_format_eta(eta_seconds),
                errors=stats['error']
            )

            return counted

        executor: Optional[ThreadPoolExecutor] = None
        if max_workers and max_workers > 1:
            executor = ThreadPoolExecutor(max_workers=max_workers)

        try:
            while True:
                sequences = list(
                    get_diarization_sequences(
                        limit=batch_size,
                        worker_id=worker_id,
                        max_sequence_length=effective_max_sequence_length
                    )
                )
                if not sequences:
                    log_info("\nNo more sequences to process")
                    break

                if executor:
                    futures = [executor.submit(diarize_sequence, seq, worker_id) for seq in sequences]
                    for future in concurrent.futures.as_completed(futures):
                        result = future.result()
                        record_result(result)

                        if limit and processed_count >= limit:
                            break
                else:
                    for sequence in sequences:
                        result = diarize_sequence(sequence, worker_id)
                        record_result(result)

                        if limit and processed_count >= limit:
                            break

                if limit and processed_count >= limit:
                    break
        finally:
            if executor:
                executor.shutdown(wait=True)

    log_info("\n" + "=" * 80)
    log_info(f"Completed: {processed_count} sequences, {completed_chunks} chunks, {total_segments} segments")
    log_info(f"Stats: diarized={stats['diarized']}, no_segments={stats['no_segments']}, errors={stats['error']}, skipped={stats['skipped']}")
    log_info("=" * 80)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument(
        '--max-chunks',
        type=int,
        default=MAX_SEQUENCE_CHUNKS,
        help='Maximum number of chunks to combine per diarization request'
    )
    args = parser.parse_args()
    process_diarization_sequences(limit=args.limit, max_workers=1, max_sequence_length=args.max_chunks)
