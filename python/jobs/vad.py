import time
import torch
import logging
from datetime import datetime, UTC
from typing import Dict, Any, Callable, Optional
from pydantic import BaseModel
from lib.resources import call_resource
from chunking import read_codec, sample_rate

# Configure logging
logging.basicConfig(level=logging.INFO, format='[VAD] %(asctime)s %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

logger.info("Loading Silero VAD model...")
try:
    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
    )
    logger.info("Silero VAD model loaded successfully")
except Exception as e:
    logger.error(f"Failed to load Silero VAD model: {e}")
    raise

(get_speech_timestamps,
 save_audio,
 read_audio,
 VADIterator,
 collect_chunks) = utils

VAD_THRESHOLD = 0.5


class VadJobData(BaseModel):
    limit: int = 1000
    batchSize: int = 100
    originalId: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None


@torch.no_grad()
def get_voice_prob(audio):
    tensor = torch.from_numpy(audio).float()
    sampling_rate: int = 16000
    window_size_samples: int = 512

    model.reset_states()

    audio_length_samples = len(audio)
    duration_sec = audio_length_samples / sampling_rate

    # Audio stats for debugging
    audio_min = float(tensor.min())
    audio_max = float(tensor.max())
    audio_mean = float(tensor.mean())
    audio_std = float(tensor.std())

    max_prob = 0
    window_count = 0
    high_prob_windows = 0

    for current_start_sample in range(0, audio_length_samples, window_size_samples):
        chunk = tensor[current_start_sample: current_start_sample + window_size_samples]
        if len(chunk) < window_size_samples:
            chunk = torch.nn.functional.pad(chunk, (0, int(window_size_samples - len(chunk))))
        speech_prob = model(chunk, sampling_rate).item()
        window_count += 1
        if speech_prob > 0.3:  # Track windows with moderate speech probability
            high_prob_windows += 1
        if speech_prob > max_prob:
            max_prob = speech_prob

    logger.debug(f"Audio stats: duration={duration_sec:.2f}s, samples={audio_length_samples}, "
                f"range=[{audio_min:.4f}, {audio_max:.4f}], mean={audio_mean:.4f}, std={audio_std:.4f}")
    logger.debug(f"VAD analysis: {window_count} windows, {high_prob_windows} with prob>0.3, max_prob={max_prob:.4f}")

    return max_prob


def apply_updates(updates):
    call_resource('mongo', {
        "action": "bulkWrite",
        "collection": "audio_chunks",
        "operations": [
            {
                "updateOne": {
                    "filter": {"_id": chunk_id},
                    "update": update,
                }
            } for chunk_id, update in updates
        ],
    })


def process_vad_job(job_id: str, data: VadJobData, progress_callback: Callable) -> Dict[str, Any]:
    start_time = time.time()
    logger.info(f"Starting VAD job {job_id}")
    logger.info(f"Job params: limit={data.limit}, batchSize={data.batchSize}, originalId={data.originalId}")

    limit = data.limit
    batch_size = data.batchSize
    original_id = data.originalId
    start_date = data.start
    end_date = data.end

    query = {
        "vad": None,
    }

    if original_id:
        query["original_id"] = original_id

    if start_date or end_date:
        query["start"] = {}
        if start_date:
            query["start"]["$gte"] = {"$date": start_date}
        if end_date:
            query["start"]["$lte"] = {"$date": end_date}

    result = call_resource('mongo', {
        "action": "getFirstBatch",
        "collection": "audio_chunks",
        "query": query,
        "options": {
            "sort": {"start": -1},
        },
        "batchSize": min(batch_size, limit) if limit else batch_size,
    })

    cursor_id = result.get("cursorId", "")
    has_more = result.get("hasMore", False)
    chunks = result.get("data", [])

    logger.info(f"Found {len(chunks)} chunks to process (hasMore={has_more})")

    updates = []
    has_speech = 0
    total_processed = 0

    progress_callback({
        "processed": 0,
        "total": limit,
        "hasSpeech": 0,
    })

    while chunks:
        for chunk in chunks:
            if limit and total_processed >= limit:
                break

            chunk_id = chunk["_id"]

            try:
                audio = read_codec(chunk["data"], codec="opus", sample_rate=sample_rate)
                audio_duration = len(audio) / sample_rate
                prob = get_voice_prob(audio)
                is_speech = prob > VAD_THRESHOLD

                logger.info(f"Chunk {chunk_id}: duration={audio_duration:.2f}s, prob={prob:.4f}, speech={is_speech} (threshold={VAD_THRESHOLD})")

                updates.append((
                    chunk_id,
                    {
                        "$set": {
                            "vad.ran_at": datetime.now(UTC),
                            "vad.prob": prob,
                            "vad.has_speech": is_speech,
                        },
                    }
                ))
                has_speech += is_speech
                total_processed += 1

            except Exception as e:
                logger.error(f"Error processing chunk {chunk_id}: {e}")
                # Still mark as processed to avoid infinite retries
                updates.append((
                    chunk_id,
                    {
                        "$set": {
                            "vad.ran_at": datetime.now(UTC),
                            "vad.prob": 0,
                            "vad.has_speech": False,
                            "vad.error": str(e),
                        },
                    }
                ))
                total_processed += 1

            if len(updates) >= 30:
                apply_updates(updates)
                logger.info(f"Applied {len(updates)} updates, total processed: {total_processed}, speech detected: {has_speech}")
                updates = []

                progress_callback({
                    "processed": total_processed,
                    "total": limit,
                    "hasSpeech": has_speech,
                    "currentTimestamp": chunk.get('start', datetime.now(UTC)).isoformat() if 'start' in chunk else None,
                })

        if limit and total_processed >= limit:
            break

        if has_more and cursor_id:
            result = call_resource('mongo', {
                "action": "getMore",
                "collection": "audio_chunks",
                "cursorId": cursor_id,
                "batchSize": min(batch_size, limit - total_processed) if limit else batch_size,
            })
            has_more = result.get("hasMore", False)
            chunks = result.get("data", [])
        else:
            chunks = []

    if updates:
        apply_updates(updates)
        logger.info(f"Applied final {len(updates)} updates")

    duration = time.time() - start_time

    logger.info(f"VAD job {job_id} completed: processed={total_processed}, speech_chunks={has_speech}, duration={duration:.2f}s")

    return {
        "processed": total_processed,
        "total": total_processed,
        "hasSpeech": has_speech,
        "duration": duration,
        "hasMore": has_more,
    }
