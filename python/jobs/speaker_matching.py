"""Retroactive speaker matching job - matches existing diarizations to enrolled profiles."""

import logging
import os
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
from pydantic import BaseModel

from lib.resources import call_resource
from speaker_identification.profiles import get_all_profiles
from speaker_identification.matching import (
    DEFAULT_SIMILARITY_THRESHOLD,
    UNKNOWN_EMBEDDING_SPACES,
    match_segments_batch,
)

logger = logging.getLogger(__name__)

# Get similarity threshold from env var or use default
SIMILARITY_THRESHOLD = float(
    os.environ.get("SPEAKER_SIMILARITY_THRESHOLD", DEFAULT_SIMILARITY_THRESHOLD)
)


class SpeakerMatchingJobData(BaseModel):
    """Data model for speaker matching job."""
    limit: int = 10000  # Maximum number of segments to process
    batch_size: int = 500  # Batch size for MongoDB queries
    threshold: Optional[float] = None  # Override default similarity threshold
    profile_id: Optional[str] = None  # Only match for specific profile (for re-matching)
    start: Optional[datetime] = None
    end: Optional[datetime] = None


def _apply_updates(updates: List[tuple]) -> int:
    """Apply batch updates to diarizations collection."""
    if not updates:
        return 0
    
    operations = [
        {
            "updateOne": {
                "filter": {"_id": segment_id},
                "update": {"$set": {"matched_speaker": matched_speaker}},
            }
        }
        for segment_id, matched_speaker in updates
    ]
    
    result = call_resource("mongo", {
        "action": "bulkWrite",
        "collection": "diarizations",
        "operations": operations,
    })
    
    return result.get("modifiedCount", 0)


def process_speaker_matching_job(
    job_id: str,
    data: SpeakerMatchingJobData,
    progress_callback: Callable[[Dict[str, Any]], None],
) -> Dict[str, Any]:
    """
    Process retroactive speaker matching job.
    
    This job:
    1. Loads all speaker profiles from MongoDB
    2. Streams diarizations without matched_speaker
    3. Computes cosine similarity between segment and profile embeddings
    4. Updates diarizations with matched_speaker if above threshold
    """
    start_time = time.time()
    logger.info(f"Starting speaker matching job {job_id}")
    logger.info(f"Job params: limit={data.limit}, batch_size={data.batch_size}, threshold={data.threshold}")
    
    threshold = data.threshold or SIMILARITY_THRESHOLD
    logger.info(f"Using similarity threshold: {threshold}")
    
    # Load profiles
    progress_callback({
        "stage": "loading_profiles",
        "message": "Loading speaker profiles...",
    })
    
    profiles = get_all_profiles()
    if not profiles:
        logger.warning("No speaker profiles found, nothing to match")
        return {
            "processed": 0,
            "matched": 0,
            "duration": time.time() - start_time,
            "message": "No speaker profiles enrolled",
        }
    
    logger.info(f"Loaded {len(profiles)} speaker profiles")
    
    # If matching for specific profile only
    if data.profile_id:
        profiles = [p for p in profiles if str(p["_id"]) == data.profile_id]
        if not profiles:
            raise ValueError(f"Profile not found: {data.profile_id}")
        logger.info(f"Matching only for profile: {profiles[0]['name']}")

    profiles = [
        profile
        for profile in profiles
        if profile.get("embeddingSpaceId") not in UNKNOWN_EMBEDDING_SPACES
        and isinstance(profile.get("revision"), int)
        and not isinstance(profile.get("revision"), bool)
        and profile["revision"] > 0
    ]
    if not profiles:
        logger.warning("No speaker profiles have exact versioned embedding provenance")
        return {
            "processed": 0,
            "matched": 0,
            "duration": time.time() - start_time,
            "message": "No compatible speaker profiles enrolled",
        }
    
    # Build query for unmatched diarizations
    query = {
        "matched_speaker": {"$exists": False},
        "embedding": {"$exists": True},
        "embeddingSpaceId": {
            "$exists": True,
            "$nin": ["", "unknown", "legacy-unknown"],
        },
    }
    if data.start or data.end:
        query["start"] = {}
        if data.start:
            query["start"]["$gte"] = data.start
        if data.end:
            query["start"]["$lte"] = data.end
    
    progress_callback({
        "stage": "loading_segments",
        "message": "Loading unmatched diarization segments...",
        "profiles_count": len(profiles),
    })
    
    # Get first batch
    result = call_resource("mongo", {
        "action": "getFirstBatch",
        "collection": "diarizations",
        "query": query,
        "options": {"sort": {"start": -1}},
        "batchSize": min(data.batch_size, data.limit),
    })
    
    cursor_id = result.get("cursorId", "")
    has_more = result.get("hasMore", False)
    segments = result.get("data", [])
    
    logger.info(f"Found {len(segments)} initial segments (hasMore={has_more})")
    
    total_processed = 0
    total_matched = 0
    updates = []
    
    progress_callback({
        "stage": "matching",
        "message": "Matching segments to profiles...",
        "processed": 0,
        "matched": 0,
        "total": data.limit,
    })
    
    while segments:
        # Match this batch
        for segment_id, matched_speaker in match_segments_batch(profiles, segments, threshold):
            updates.append((segment_id, matched_speaker))
            total_matched += 1
        
        total_processed += len(segments)
        
        # Apply updates in batches
        if len(updates) >= 100:
            _apply_updates(updates)
            logger.info(f"Applied {len(updates)} updates, total: processed={total_processed}, matched={total_matched}")
            updates = []
            
            progress_callback({
                "stage": "matching",
                "processed": total_processed,
                "matched": total_matched,
                "total": data.limit,
            })
        
        # Check limit
        if total_processed >= data.limit:
            break
        
        # Get next batch
        if has_more and cursor_id:
            remaining = data.limit - total_processed
            result = call_resource("mongo", {
                "action": "getMore",
                "collection": "diarizations",
                "cursorId": cursor_id,
                "batchSize": min(data.batch_size, remaining),
            })
            has_more = result.get("hasMore", False)
            segments = result.get("data", [])
        else:
            segments = []
    
    # Apply remaining updates
    if updates:
        _apply_updates(updates)
        logger.info(f"Applied final {len(updates)} updates")
    
    duration = time.time() - start_time
    
    logger.info(f"Speaker matching job {job_id} completed: processed={total_processed}, matched={total_matched}, duration={duration:.2f}s")
    
    return {
        "processed": total_processed,
        "matched": total_matched,
        "profiles_count": len(profiles),
        "threshold": threshold,
        "duration": round(duration, 2),
        "hasMore": bool(has_more),
    }
