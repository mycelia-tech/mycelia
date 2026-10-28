from chunking import ( read_codec,
    sample_rate
)
from datetime import datetime, UTC

import logging

from lib.resources import call_resource
from lib.config import load_environment
import time
from tqdm import tqdm
import torch

logger = logging.getLogger('diarization')



model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad',
                             model='silero_vad',
                             )

(get_speech_timestamps,
 save_audio,
 read_audio,
 VADIterator,
 collect_chunks) = utils


vad_threshold = 0.5


@torch.no_grad()
def get_voice_prob(audio):
    tensor = torch.from_numpy(audio).float()
    sampling_rate: int = 16000
    window_size_samples: int = 512

    model.reset_states()

    audio_length_samples = len(audio)
    max_prob = 0
    for current_start_sample in range(0, audio_length_samples, window_size_samples):
        chunk = tensor[current_start_sample: current_start_sample + window_size_samples]
        if len(chunk) < window_size_samples:
            chunk = torch.nn.functional.pad(chunk, (0, int(window_size_samples - len(chunk))))
        speech_prob = model(chunk, sampling_rate).item()
        if speech_prob > max_prob:
            max_prob = speech_prob
    return max_prob

def apply_updates(updates):
    call_resource('mongo', {
        "action": "bulkWrite",
        "collection": "audio_chunks",
        "operations": [
            {
                "updateOne": {
                    "filter": {"_id": id},
                    "update": update,
                }
            } for id, update in updates
        ],
    })


def run_voice_activity_detection(limit=1000, verbose_logs=False, batch_size=100):

    # Use resumable cursors: getFirstBatch to start
    result = call_resource('mongo', {
        "action": "getFirstBatch",
        "collection": "audio_chunks",
        "query": {
            "vad": None,
        },
        "options": {
            "sort": {"start": -1},
        },
        "batchSize": min(batch_size, limit) if limit else batch_size,
    })
    
    cursor_id = result.get("cursorId", "")
    has_more = result.get("hasMore", False)
    chunks = result.get("data", [])
    
    updates = []
    has_speech = 0
    total_processed = 0
    pbar = tqdm(total=limit if limit else None, unit="chunks")
    
    while chunks:
        for chunk in chunks:
            if limit and total_processed >= limit:
                break
                
            audio = read_codec(chunk["data"], codec="opus", sample_rate=sample_rate)
            prob = get_voice_prob(audio)
            updates.append((
                chunk["_id"],
                {
                    "$set": {
                        "vad.ran_at": datetime.now(UTC),
                        "vad.prob": prob,
                        "vad.has_speech": prob > vad_threshold,
                    },
                }
            ))
            has_speech += prob > vad_threshold
            total_processed += 1

            pbar.set_postfix({
                'has_speech': f"{(has_speech / total_processed) * 100:.1f}%" if total_processed > 0 else "0%",
                'ts': chunk['start'].replace(microsecond=0).isoformat() if 'start' in chunk else '',
            })
            pbar.update(1)
            
            if len(updates) >= 30:
                apply_updates(updates)
                updates = []

        if limit and total_processed >= limit:
            break

        # Get more batches if available
        if has_more and cursor_id:
            result = call_resource('mongo', {
                "action": "getMore",
                "collection": "audio_chunks",
                "cursorId": cursor_id,
                "batchSize": min(batch_size, limit - total_processed) if limit else batch_size,
            })
            has_more = result.get("hasMore", False)
            chunks = result.get("data", [])
            # cursor_id remains the same for getMore
        else:
            chunks = []

    # Process any remaining updates
    if updates:
        apply_updates(updates)

    pbar.close()

    if verbose_logs:
        logger.info(f"VAD batch complete: {total_processed} chunks processed, {has_speech} with speech ({(has_speech / total_processed) * 100:.1f}%)" if total_processed > 0 else "VAD batch complete: 0 chunks processed")


if __name__ == "__main__":
    load_environment()
    while True:
        try:
            run_voice_activity_detection(limit=1000, verbose_logs=True, batch_size=100)
        except Exception as e:
            logger.error(f"Error running voice activity detection: {e}")
            time.sleep(10)
