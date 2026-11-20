import time
import os
import sys
import math
import argparse
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor
import logging
from logging.handlers import RotatingFileHandler
from tqdm import tqdm
import tempfile
import io
import wave
from pathlib import Path
import ffmpeg
import requests
from lib.config import load_environment

load_environment()

from lib.resources import call_resource
from lib.api import job_token_var, exchange_api_key_for_jwt

from lib.transcription import clip_timestamps, known_errors, remove_if_lonely, subtitle_credit_pattern

from lib.worker import mongo_cursor, claim_chunks, release_chunks

from pydantic import BaseModel
from datetime import datetime
from bson import ObjectId
from datetime import timedelta
from typing import Any, Iterator
from pytz import UTC

import signal

signal.signal(signal.SIGINT, signal.SIG_DFL)


LOG_DIR = os.path.join(os.path.dirname(__file__), 'logs')
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(message)s',
    handlers=[
        RotatingFileHandler(
            os.path.join(LOG_DIR, 'stt.log'),
            maxBytes=10*1024*1024,
            backupCount=5
        ),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


TRANSCRIPTION_SERVER_URL: str | None = None
TRANSCRIPTION_API_KEY: str | None = None
TRANSCRIPTION_MODEL = "whisper"
REPORTED_TRANSCRIPTION_MODELS: set[str] = set()


NO_SPEECH_DETECTED = object()


def initialize_backend_auth():
    jwt_token = exchange_api_key_for_jwt()
    job_token_var.set(jwt_token)


def configure_transcription_endpoint(
    server: str | None,
    api_key: str | None,
    model: str = "whisper",
):
    global TRANSCRIPTION_SERVER_URL, TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL

    if not server:
        TRANSCRIPTION_SERVER_URL = None
        TRANSCRIPTION_API_KEY = None
        return

    resolved_api_key = api_key or os.getenv("PROXY_API_KEY")
    if not resolved_api_key:
        raise RuntimeError(
            "Missing STT API key. Pass --api-key or set PROXY_API_KEY."
        )

    TRANSCRIPTION_SERVER_URL = server.rstrip("/")
    TRANSCRIPTION_API_KEY = resolved_api_key
    TRANSCRIPTION_MODEL = model
    tqdm.write(f"Using remote transcription server: {TRANSCRIPTION_SERVER_URL}")
    tqdm.write(f"Requested transcription model: {TRANSCRIPTION_MODEL}")


def transcribe_with_remote_server(
    audio_bytes: bytes,
    file_name: str = "combined.wav",
    file_type: str = "audio/wav",
):
    if not TRANSCRIPTION_SERVER_URL or not TRANSCRIPTION_API_KEY:
        raise RuntimeError("Remote transcription server is not configured")

    response = requests.post(
        f"{TRANSCRIPTION_SERVER_URL}/v1/audio/transcriptions",
        headers={
            "Authorization": f"Bearer {TRANSCRIPTION_API_KEY}",
        },
        files={
            "file": (file_name, audio_bytes, file_type),
        },
        data={"model": TRANSCRIPTION_MODEL},
        timeout=300,
    )

    try:
        response.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        body = response.text[:500]
        raise RuntimeError(
            f"Remote transcription failed with HTTP {response.status_code}: {body}"
        ) from exc

    try:
        transcript = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"Remote transcription returned invalid JSON: {response.text[:500]}"
        ) from exc

    model_used = (
        response.headers.get("X-Whisper-Model")
        or os.getenv("STT_MODEL")
        or transcript.get("model")
        or "unknown"
    )
    if (
        TRANSCRIPTION_MODEL != "whisper"
        and model_used != "unknown"
        and model_used != TRANSCRIPTION_MODEL
    ):
        raise RuntimeError(
            "Remote STT model mismatch: "
            f"requested {TRANSCRIPTION_MODEL}, server used {model_used}"
        )

    if model_used not in REPORTED_TRANSCRIPTION_MODELS:
        tqdm.write(f"Transcription model used: {model_used}")
        REPORTED_TRANSCRIPTION_MODELS.add(model_used)

    vad_filter_header = response.headers.get("X-Whisper-VAD-Filter")
    whisper_vad_filter = None if vad_filter_header is None else (
        vad_filter_header.strip().lower() in {"1", "true", "yes", "on"}
    )

    metadata = transcript.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    transcript["metadata"] = {
        **metadata,
        "model": model_used,
        "provider": "remote_openai_compatible",
        **(
            {"whisperVadFilter": whisper_vad_filter}
            if whisper_vad_filter is not None
            else {}
        ),
    }
    return transcript


def ensure_audio_chunk_indexes():
    index_definitions = [
        (
            {
                'transcribed_at': 1,
                'processing_by': 1,
                'vad.has_speech': 1,
                'start': -1,
            },
            {
                'name': 'audio_chunks_pending_work',
                'partialFilterExpression': {
                    'transcribed_at': None,
                    'processing_by': None,
                    'vad.has_speech': True,
                },
            }
        ),
        (
            {'processing_by': 1},
            {'name': 'audio_chunks_processing_by'}
        ),
        (
            {'transcribed_at': 1},
            {'name': 'audio_chunks_transcribed_at'}
        ),
    ]

    for index, options in index_definitions:
        try:
            call_resource('mongo', {
                "action": "createIndex",
                "collection": "audio_chunks",
                "index": index,
                "options": options,
            })
        except Exception as exc:
            logger.warning(
                "Failed to ensure audio_chunks index %s: %s",
                options.get('name'),
                exc
            )
            tqdm.write(f"WARNING: Failed to ensure audio_chunks index {options.get('name')}: {exc}")
            break


def build_base_filters(extra_filters: dict | None = None) -> dict:
    base_filters = {
        'transcribed_at': {'$eq': None},
        'processing_by': {'$eq': None},
        'vad.has_speech': True
    }
    if extra_filters:
        merged = base_filters.copy()
        merged.update(extra_filters)
        return merged
    return base_filters


def get_pending_work_stats(extra_filters: dict | None = None) -> tuple[int | None, int | None]:
    filters = build_base_filters(extra_filters)
    sequences = None
    chunks = None

    try:
        result = call_resource('mongo', {
            "action": "aggregate",
            "collection": "audio_chunks",
            "pipeline": [
                {"$match": filters},
                {"$group": {"_id": "$original_id"}},
                {"$count": "total"},
            ],
        })
        sequences = result[0].get('total', 0) if result else 0
    except Exception as exc:
        tqdm.write(f"WARNING: Unable to estimate pending sequences: {exc}")
        logger.warning("Unable to estimate pending sequences: %s", exc)

    try:
        chunks = call_resource('mongo', {
            "action": "count",
            "collection": "audio_chunks",
            "query": filters,
        })
    except Exception as exc:
        tqdm.write(f"WARNING: Unable to count pending chunks: {exc}")
        logger.warning("Unable to count pending chunks: %s", exc)

    return sequences, chunks


def format_eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0 or math.isinf(seconds):
        return 'n/a'
    total_seconds = int(seconds)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


class SpeechSequence(BaseModel):
    original_id: ObjectId
    chunks: list[Any] = []
    is_partial: bool = False
    is_continuation: bool = False

    class Config:
        arbitrary_types_allowed = True

    @property
    def last(self) -> Any:
        return self.chunks[-1]

    @property
    def start(self) -> datetime:
        return self.last['start']

    @property
    def min_index(self) -> int:
        return self.last['index']

    def __repr__(self):
        indices = [chunk['index'] for chunk in self.chunks]
        return f'{self.original_id}: {repr(indices)}'



def get_speech_sequences(limit=10, filters=None, max_sequence_length=30, worker_id=None) -> Iterator[SpeechSequence]:
    sequences_by_id: dict[ObjectId, SpeechSequence] = {}
    yielded = 0

    base_filters = build_base_filters(filters)

    for chunk in mongo_cursor('audio_chunks', base_filters, {
        "sort": {"start": -1},
    }):
        if limit is not None and yielded >= limit:
            break

        original_id = chunk['original_id']
        start = chunk['start']


        for existing_id, seq in tuple(sequences_by_id.items()):
            if seq.start - start > timedelta(seconds=600):
                if not seq.is_continuation or len(seq.chunks) > 1:
                    yield seq
                    yielded += 1
                del sequences_by_id[existing_id]


        seq = sequences_by_id.get(original_id)



        if seq and seq.min_index - 1 != chunk['index']:
            assert chunk not in seq.chunks
            yield seq
            del sequences_by_id[original_id]
            yielded += 1
            continue

        if original_id not in sequences_by_id:
            try:
                seq = sequences_by_id[original_id] = SpeechSequence(
                start=start,
                original_id=original_id,
                chunks=[]
            )
            except Exception as e:
                tqdm.write(f"ERROR: Creating speech sequence for {original_id}: {e}")
                continue

        seq.chunks.append(chunk)

        if len(seq.chunks) >= max_sequence_length:
            seq.is_partial = True
            yield seq
            yielded += 1
            sequences_by_id[original_id] = SpeechSequence(
                start=chunk['start'],
                original_id=original_id,
                chunks=[chunk],
                is_continuation=True,
            )



    if limit is None or yielded < limit:
        for seq in sequences_by_id.values():
            yield seq


def claim_sequence(seq: SpeechSequence, worker_id: str) -> bool:
    chunk_ids = [chunk['_id'] for chunk in seq.chunks]
    success = claim_chunks(chunk_ids, worker_id)
    if not success:
        release_sequence(seq, worker_id)
    return success


def release_sequence(seq: SpeechSequence, worker_id: str):
    chunk_ids = [chunk['_id'] for chunk in seq.chunks]
    release_chunks(chunk_ids, worker_id)

def process_sequence(sequence: SpeechSequence, worker_id: str):
    start_time = time.time()
    timestamp = sequence.start.strftime("%Y-%m-%d %H:%M:%S")
    chunks_count = len(sequence.chunks)
    original_id = str(sequence.original_id)

    try:
        if not claim_sequence(sequence, worker_id):
            tqdm.write(f'{timestamp}  {chunks_count:3d} chunks  {original_id}  skipped (claimed)')
            return {"status": "skipped", "chunks": 0, "duration": 0}

        result = transcribe_sequence(sequence)
        mark_as_transcribed(sequence, worker_id)

        end_time = time.time()
        duration = end_time - start_time
        status = "empty" if result is NO_SPEECH_DETECTED else "transcribed"
        tqdm.write(f'{timestamp}  {chunks_count:3d} chunks  {original_id}  {duration:5.2f}s  {status}')
        return {"status": status, "chunks": chunks_count, "duration": duration}

    except Exception as e:
        end_time = time.time()
        release_sequence(sequence, worker_id)
        tqdm.write(f'{timestamp}  {chunks_count:3d} chunks  {original_id}  ERROR: {str(e)}')
        return {"status": "error", "chunks": 0, "duration": end_time - start_time}



def process_speech_sequences(limit=None, max_workers=1, worker_id=None, filters=None):
    import socket
    if worker_id is None:
        worker_id = f"{socket.gethostname()}_{os.getpid()}"

    ensure_audio_chunk_indexes()
    tqdm.write(f'Worker ID: {worker_id}')
    tqdm.write(f'Using {max_workers} parallel worker(s)')

    estimated_sequences, pending_chunks = get_pending_work_stats(filters)
    if estimated_sequences is not None or pending_chunks is not None:
        parts = []
        if estimated_sequences is not None:
            parts.append(f"{estimated_sequences} sequences")
        if pending_chunks is not None:
            parts.append(f"{pending_chunks} chunks")
        tqdm.write(f'Pending work: {", ".join(parts)}')
    else:
        tqdm.write('Pending work: unknown (unable to query MongoDB)')

    if limit is not None:
        progress_total = limit
        progress_unit = 'seq'
    else:
        if pending_chunks is not None:
            progress_total = pending_chunks
            progress_unit = 'chunk'
        elif estimated_sequences is not None:
            progress_total = estimated_sequences
            progress_unit = 'seq'
        else:
            progress_total = None
            progress_unit = 'seq'

    processed_count = 0
    stats = {'transcribed': 0, 'empty': 0, 'error': 0, 'skipped': 0}
    total_chunks = 0
    total_processing_seconds = 0.0
    batch_size = min(limit if limit else 1000, 1000)

    bar_format = '{n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}{postfix}]' if progress_total is not None else '{n_fmt} [{elapsed}, {rate_fmt}{postfix}]'

    with tqdm(total=progress_total, desc="Processing", unit=progress_unit, bar_format=bar_format) as pbar:

        if max_workers == 1:
            while True:
                batch_processed = 0
                for sequence in get_speech_sequences(limit=batch_size, filters=filters, worker_id=worker_id):
                    result = process_sequence(sequence, worker_id)
                    status = result["status"]

                    if status in stats:
                        stats[status] += 1

                    total_chunks += result["chunks"]
                    total_processing_seconds += result["duration"]

                    if status != "skipped":
                        processed_count += 1
                        batch_processed += 1

                    increment = result["chunks"] if progress_unit == 'chunk' else 1
                    if increment:
                        pbar.update(increment)
                    pbar.set_postfix(
                        transcribed=stats['transcribed'],
                        empty=stats['empty'],
                        errors=stats['error'],
                        skipped=stats['skipped'],
                    )

                    if limit and processed_count >= limit:
                        break

                if limit and processed_count >= limit:
                    break

                if batch_processed == 0:
                    tqdm.write("\nNo more sequences to process")
                    break
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                while True:
                    sequences = list(get_speech_sequences(limit=batch_size, filters=filters, worker_id=worker_id))
                    if not sequences:
                        tqdm.write("\nNo more sequences to process")
                        break

                    futures = {
                        executor.submit(process_sequence, seq, worker_id): seq
                        for seq in sequences
                    }

                    for future in concurrent.futures.as_completed(futures):
                        result = future.result()
                        status = result["status"]

                        if status in stats:
                            stats[status] += 1

                        total_chunks += result["chunks"]
                        total_processing_seconds += result["duration"]

                        if status != "skipped":
                            processed_count += 1

                        increment = result["chunks"] if progress_unit == 'chunk' else 1
                        if increment:
                            pbar.update(increment)
                        pbar.set_postfix(
                            transcribed=stats['transcribed'],
                            empty=stats['empty'],
                            errors=stats['error'],
                            skipped=stats['skipped'],
                        )

                        if limit and processed_count >= limit:
                            break

                    if limit and processed_count >= limit:
                        break

    tqdm.write("\n" + "=" * 80)
    tqdm.write(f"Completed: {processed_count} sequences, {total_chunks} chunks")
    tqdm.write(f"Stats: transcribed={stats['transcribed']}, empty={stats['empty']}, errors={stats['error']}, skipped={stats['skipped']}")
    tqdm.write("=" * 80)


def combine_chunks_with_ffmpeg(chunks: list[dict]) -> bytes:
    sample_rate = 16000
    
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        input_files = []
        
        for i, chunk in enumerate(reversed(chunks)):
            chunk_data = chunk['data']
            if not chunk_data:
                continue
            
            input_file = temp_path / f"chunk_{i}.opus"
            input_file.write_bytes(chunk_data)
            input_files.append(str(input_file))
        
        if not input_files:
            raise ValueError("No valid audio chunks to combine")
        
        concat_file = temp_path / "concat.txt"
        with open(concat_file, 'w') as f:
            for input_file in input_files:
                f.write(f"file '{input_file}'\n")
        
        output_file = temp_path / "combined.wav"
        
        process = (
            ffmpeg
            .input(str(concat_file), format='concat', safe=0)
            .output(
                str(output_file),
                format='wav',
                acodec='pcm_s16le',
                ar=str(sample_rate),
                ac=1
            )
            .overwrite_output()
            .run_async(
                pipe_stderr=True
            )
        )
        
        _, stderr = process.communicate()
        
        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown ffmpeg error"
            raise Exception(f"ffmpeg concat failed: {error_msg}")
        
        return output_file.read_bytes()


def transcribe_sequence(sequence: SpeechSequence):
    combined_audio = combine_chunks_with_ffmpeg(sequence.chunks)
    with wave.open(io.BytesIO(combined_audio), 'rb') as wav:
        duration_seconds = wav.getnframes() / wav.getframerate()

    if TRANSCRIPTION_SERVER_URL:
        transcript = transcribe_with_remote_server(
            combined_audio,
            file_name='combined.wav',
            file_type='audio/wav',
        )
    else:
        transcript = call_resource('transcription', {
            'action': 'transcribe',
            'file': combined_audio,
            'fileName': 'combined.wav',
            'fileType': 'audio/wav',
        })

    # Extract segments (could be empty, which is valid)
    segments = transcript.get('segments', [])

    # Filter out known errors and asterisk patterns to prevent cleanup need
    # This matches the filtering logic in cleanup.py but applied during transcription
    filtered_segments = []
    for segment in segments:
        text = segment.get('text', '').strip().lower()

        if (
            not text or
            text in known_errors or
            subtitle_credit_pattern.fullmatch(text) or
            text.startswith('*') and text.endswith('*')
        ):
            continue

        clipped = clip_timestamps(segment, duration_seconds)
        if clipped is None:
            continue
        if isinstance(clipped.get('words'), list):
            words = (clip_timestamps(word, duration_seconds) for word in clipped['words'])
            clipped = {**clipped, 'words': [word for word in words if word is not None]}
        filtered_segments.append(clipped)

    if not filtered_segments or all(
        segment['text'].strip() in remove_if_lonely for segment in filtered_segments
    ):
        return NO_SPEECH_DETECTED


    transcribed_text = ''.join(segment['text'] for segment in filtered_segments)
    if len(filtered_segments) != len(segments):
        transcript['text'] = transcribed_text
    transcript['segments'] = segments = filtered_segments

    # Calculate duration from filtered segments if available, otherwise use 0
    duration = 0.0
    if segments:
        duration = segments[-1]['end']

        call_resource('mongo', {
            "action": "insertOne",
            "collection": "transcriptions",
            "doc": {
                **transcript,
                'original': sequence.original_id,
                'start': sequence.start,
                'duration': duration,
                'end': sequence.start + timedelta(seconds=duration),
            }
        })

    return transcribed_text



def mark_as_transcribed(seq: SpeechSequence, worker_id: str | None = None):
    chunks_to_mark = seq.chunks[:-1] if seq.is_partial else seq.chunks
    if chunks_to_mark:
        query = {
            '_id': {'$in': [chunk['_id'] for chunk in chunks_to_mark]},
        }
        update_fields = {
            'transcribed_at': datetime.now(tz=UTC),
        }
        if worker_id:
            query['processing_by'] = worker_id
            update_fields.update({
                'processing_by': None,
                'claimed_at': None,
            })

        call_resource('mongo', {
            "action": "updateMany",
            "collection": "audio_chunks",
            "query": query,
            "update": {
                '$set': update_fields,
            }
        })

    if worker_id and seq.is_partial:
        release_chunks([seq.last['_id']], worker_id)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument(
        '--server',
        default=os.getenv('STT_SERVER_URL'),
        help='OpenAI-compatible STT server URL. Defaults to STT_SERVER_URL if set.',
    )
    parser.add_argument(
        '--api-key',
        default=None,
        help='API key for the STT server. Defaults to PROXY_API_KEY if set.',
    )
    parser.add_argument(
        '--model',
        default=os.getenv('STT_MODEL') or 'whisper',
        help=(
            'Required remote STT model, for example large-v3-turbo. '
            'Defaults to STT_MODEL or the generic whisper alias.'
        ),
    )
    parser.add_argument(
        '--count',
        action='store_true',
        help='Count pending speech chunks eligible for STT and exit.',
    )
    args = parser.parse_args()

    try:
        initialize_backend_auth()
        configure_transcription_endpoint(args.server, args.api_key, args.model)
    except Exception as e:
        print(f"Error initializing STT worker: {e}", file=sys.stderr)
        sys.exit(1)

    if args.count:
        try:
            count = call_resource('mongo', {
                "action": "count",
                "collection": "audio_chunks",
                "query": build_base_filters(),
            })
            print(count)
            sys.exit(0)
        except Exception as e:
            print(f"Error counting audio chunks: {e}", file=sys.stderr)
            sys.exit(1)

    process_speech_sequences(
        limit=args.limit,
        max_workers=1,
    )
