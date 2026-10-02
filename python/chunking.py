import base64
import io
import logging
import math
import os
import shutil
import subprocess
import time
import wave
from datetime import datetime, timedelta

import ffmpeg
import numpy as np
from pytz import UTC
from tqdm import tqdm

from lib.resources import call_resource
from utils import TMP_DIR, sample_rate, sha

logger = logging.getLogger('chunking')

CHUNK_MAX_LEN = timedelta(seconds=10)
CHUNK_WRITE_BATCH_SIZE = 50


def get_tmp_dir(original):
    return os.path.join(TMP_DIR, sha(original))

class EncodingProgress:
    """Bounded ffmpeg -progress parser; elapsed/heartbeat is not saved audio."""
    def __init__(self, callback):
        self.callback = callback
        self.started = time.monotonic()
        self.last_report = 0.0
        self.encoded = 0.0
        self.speed = 0.0
        self.updated_at = time.time()
        self.buffer = b""

    def feed(self, data):
        self.buffer += data
        if len(self.buffer) > 65536:
            raise RuntimeError("ffmpeg progress exceeded its safety limit")
        lines = self.buffer.split(b"\n")
        self.buffer = lines.pop()
        for line in lines:
            key, _, value = line.partition(b"=")
            try:
                if key == b"out_time_us":
                    seconds = float(value) / 1_000_000
                    if math.isfinite(seconds) and seconds > self.encoded:
                        self.encoded = seconds
                        self.updated_at = time.time()
                elif key == b"speed":
                    speed = float(value.rstrip(b"x"))
                    if math.isfinite(speed) and speed >= 0:
                        self.speed = speed
            except ValueError:
                pass  # ffmpeg can emit N/A before its first packet.

    def report(self, *, force=False):
        now = time.monotonic()
        if force or now - self.last_report >= 1:
            self.callback({"phase": "encoding", "encoded_seconds": self.encoded,
                           "encoding_elapsed_seconds": now - self.started,
                           "encoding_speed": self.speed,
                           "encoding_updated_at": self.updated_at})
            self.last_report = now


def split_to_opus_chunks(original, *, quiet=False, work_dir=None, cancel_check=None,
                         progress_callback=None):
    dest_dir = work_dir or get_tmp_dir(original)

    if os.path.exists(dest_dir):
        # A previous interrupted attempt can leave hundreds of chunks behind.
        # Remove the whole staging directory so an explicit retry starts cleanly.
        shutil.rmtree(dest_dir)
    os.makedirs(dest_dir, exist_ok=True)

    command = [
        'ffmpeg',
        '-i', original,
        '-f', 'segment',
        '-segment_time', str(int(CHUNK_MAX_LEN.total_seconds())),
        '-acodec', 'libopus',
        '-map_metadata', '-1',
        os.path.join(dest_dir, "%010d.opus"),
        '-y',
        '-v', 'error',
        '-nostats',
    ]

    if cancel_check is not None:
        # The native transport accepts audio bytes, never remote media URLs.
        command[1:1] = ['-protocol_whitelist', 'file,pipe', '-format_whitelist',
                        'mov,mp4,m4a,3gp,3g2,mj2,caf,wav,aac,mp3']

    try:
        if cancel_check is None and progress_callback is None:
            subprocess.run(command, check=True, capture_output=True, text=True)
        else:
            # Bridge can pause a long encode; never leave an orphan ffmpeg.
            if progress_callback:
                command[1:1] = ['-progress', 'pipe:1', '-stats_period', '1']
            tracker = EncodingProgress(progress_callback) if progress_callback else None
            with open(os.path.join(dest_dir, "ffmpeg.stderr"), "w+b") as errors:
                process = subprocess.Popen(command, stdout=subprocess.PIPE if tracker else subprocess.DEVNULL,
                                           stderr=errors)
                try:
                    if tracker:
                        os.set_blocking(process.stdout.fileno(), False)
                    while process.poll() is None:
                        if cancel_check:
                            cancel_check()
                        if tracker:
                            tracker.feed(process.stdout.read(65536) or b"")
                            tracker.report()
                        time.sleep(0.2)
                    if tracker:
                        tracker.feed(process.stdout.read(65536) or b"")
                        tracker.report(force=True)
                    if process.returncode:
                        errors.seek(0)
                        raise subprocess.CalledProcessError(
                            process.returncode, command,
                            stderr=errors.read(8192).decode(errors="replace"),
                        )
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                    if process.stdout:
                        process.stdout.close()
    except subprocess.CalledProcessError as error:
        details = (error.stderr or error.stdout or "").strip()
        if "Operation not permitted" in details:
            details += (
                "\nmacOS denied access to the live audio source. Refresh the "
                "verified Voice Memos staging archive from an authorized "
                "interactive terminal, then retry from that readable copy."
            )
        if not details:
            details = "ffmpeg did not provide diagnostic output"
        raise RuntimeError(
            f"ffmpeg failed to split {os.path.basename(original)} "
            f"(exit {error.returncode}): {details}"
        ) from error

    return [
        (i * CHUNK_MAX_LEN, os.path.join(dest_dir, f))
        for i, f in enumerate(sorted(f for f in os.listdir(dest_dir) if f.endswith(".opus")))
    ]

def get_os_metadata(file):
    stat = os.stat(file)
    return {
        "created": datetime.fromtimestamp(stat.st_birthtime, tz=UTC),
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=UTC),
        "path": file,
        "size": stat.st_size,
    }


def wav_to_array(source: io.BytesIO) -> np.ndarray:
    with wave.open(source, 'rb') as wav_file:
        if wav_file.getnchannels() != 1:
            raise ValueError("WAV file must be mono")
        frames = wav_file.readframes(wav_file.getnframes())

        # Get sample width to determine dtype
        if wav_file.getsampwidth() == 2:
            data = np.frombuffer(frames, dtype=np.int16)
        elif wav_file.getsampwidth() == 4:
            data = np.frombuffer(frames, dtype=np.int32)
        else:
            raise ValueError("Unsupported sample width")

    # Normalize to float between -1.0 and 1.0
    return data.astype(np.float32) / np.iinfo(data.dtype).max

def array_to_wav(audio_data: np.ndarray, sample_rate=16000) -> io.BytesIO:
    """
    Convert numpy array to WAV file in memory

    Args:
        audio_data (numpy.ndarray): Audio data normalized between -1.0 and 1.0
        sample_rate (int): Sample rate in Hz

    Returns:
        io.BytesIO: WAV file in memory
    """
    # Convert to 16-bit PCM
    audio_data = (audio_data * 32767).astype(np.int16)

    # Create BytesIO object
    wav_buffer = io.BytesIO()

    with wave.open(wav_buffer, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio_data.tobytes())

    wav_buffer.seek(0)
    return wav_buffer


def read_codec(source: bytes, codec: str, sample_rate: int = sample_rate) -> np.ndarray:
    process = (
        ffmpeg
        .input('pipe:', codec=codec)
        .output(
            'pipe:',
            format='wav',
            acodec='pcm_s16le',
            ar=str(sample_rate),
            ac=1,
        )
        .overwrite_output()
        .run_async(
            pipe_stdin=True,
            pipe_stdout=True,
            pipe_stderr=True,
        )
    )

    output_data, stderr = process.communicate(input=source)

    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg failed with: {stderr.decode()}")
    return wav_to_array(io.BytesIO(output_data))


def server_side_cursor_find(
        collection: str,
        filter: dict,
        sort: list[tuple[str, int]],
        batch_size: int = 100,
):
    resp = call_resource('mongo', {
        "action": "createCursor",
        "collection": collection,
        "filter": filter,
        "sort": sort,
        "batchSize": batch_size,
    })
    cursor_id = resp["cursor_id"]

    while True:
        batch = call_resource('mongo', {
            "action": "getMore",
            "collection": collection,
            "cursor_id": cursor_id,
            "batchSize": batch_size,
        })
        docs = batch["documents"]
        if not docs:
            break
        yield from docs
    



class AudioChunkReader:
    cursor: datetime

    def __init__(
            self,
            *,
            filter_chunks: dict,
            start_at,
            fetch_batch_size: int,
            sample_rate: int,
        ):
        self.sample_rate = sample_rate
        if isinstance(start_at, (int, float)):
            self.cursor = datetime.fromtimestamp(start_at, tz=UTC)
        elif isinstance(start_at, datetime):
            self.cursor = start_at
        else:
            raise TypeError("start_at must be a float (UTC timestamp) or datetime object.")
        self.chunks = db_collection.find(  # noqa: F821 - legacy injected collection
            {
                **filter_chunks,
                "start": {"$gt": self.cursor - CHUNK_MAX_LEN - timedelta(seconds=1)}
            }
        ).sort("start", 1).batch_size(fetch_batch_size)

    def read(self, duration: float | timedelta | None = None, **kwargs) -> np.array:
        """
        Read audio chunks from the database and concatenate them into a single array.

        The resulting array might be longer than the requested duration
        """
        assert not (duration and kwargs), "Only one of duration or kwargs can be provided."

        if isinstance(duration, (int, float)):
            duration = timedelta(seconds=duration)
        elif kwargs:
            duration = timedelta(**kwargs)

        start = self.cursor
        result = []

        while self.cursor - start < duration:
            try:
                chunk = self.chunks.next()
            except StopIteration:
                break
            audio = read_codec(chunk["data"], codec="opus", sample_rate=self.sample_rate)
            chunk_duration = timedelta(seconds=len(audio) / self.sample_rate)
            diff = int(
                (chunk["start"] - self.cursor).total_seconds()
                * self.sample_rate
            )

            if diff > 0:
                # gap between chunks, insert silence
                result.append(np.zeros(diff, dtype=np.float32))
            elif diff < 0:
                # chunk starts in the past
                if result:
                    # combine overlap with prev chunk
                    overlap = -diff
                    prev = result[-1]
                    result[-1] = prev[:overlap]
                    result.append(np.mean([prev[overlap:], audio[:overlap]], axis=0))
                audio = audio[-diff:]

            result.append(audio)

            self.cursor = chunk["start"] + chunk_duration


        return np.concatenate(result, axis=0, dtype=np.float32)


def fetch_audio(
        start: datetime,
        duration: timedelta,
        *,
        filter_chunks: dict | None = None,
        prefetch_chunks: int = 10,
        sample_rate: int = sample_rate,
    ) -> io.BytesIO:

    reader = AudioChunkReader(
        filter_chunks=filter_chunks or {},
        start_at=start,
        fetch_batch_size=prefetch_chunks,
        sample_rate=sample_rate,
    )
    result = reader.read(duration)
    return array_to_wav(result[:int(duration.total_seconds() * sample_rate)])


def ingest_source(original: dict, *, work_dir=None, progress_callback=None, cancel_check=None,
                  resource_callback=None):
    path = original["path"]
    tmp_dir = work_dir or get_tmp_dir(path)
    resource = resource_callback or call_resource
    def report(phase, completed=0, total=0):
        if cancel_check:
            cancel_check()
        if progress_callback:
            progress_callback({"phase": phase, "completed_chunks": completed, "total_chunks": total})
    try:
        report("encoding")
        logger.info("splitting '%s' into chunks", path)
        chunk_files = (
            split_to_opus_chunks(path, work_dir=tmp_dir, cancel_check=cancel_check,
                                 progress_callback=progress_callback)
            if work_dir is not None or cancel_check is not None or progress_callback is not None
            else split_to_opus_chunks(path)
        )
        if not chunk_files:
            raise RuntimeError("ffmpeg produced no audio chunks")
        start: datetime = original["start"]
        logger.info("ingesting %s chunks of '%s'",len(chunk_files), path)

        operations = []
        report("saving", 0, len(chunk_files))
        for i, [offset, file] in tqdm(
            enumerate(chunk_files),
            total=len(chunk_files),
        ):
            if cancel_check:
                cancel_check()
            with open(file, "rb") as f:
                operations.append({
                    "updateOne": {
                        # A crash before the source is marked ingested can
                        # retry this batch. The source/index pair remains the
                        # idempotent identity.
                        "filter": {
                            "original_id": original["_id"],
                            "index": i,
                        },
                        "update": {
                            "$setOnInsert": {
                                "format": "opus",
                                "original_id": original["_id"],
                                "index": i,
                                "ingested_at": {
                                    "$date": datetime.now(tz=UTC).isoformat()
                                },
                                "start": start + offset,
                                "data": {
                                    "$binary": {
                                        "base64": base64.b64encode(f.read()).decode(),
                                        "subType": "00",
                                    }
                                },
                            },
                        },
                        "upsert": True,
                    },
                })

            if len(operations) >= CHUNK_WRITE_BATCH_SIZE:
                resource('mongo', {
                    "action": "bulkWrite",
                    "collection": "audio_chunks",
                    "operations": operations,
                    "options": {"ordered": False},
                })
                operations = []
                report("saving", i + 1, len(chunk_files))

        if operations:
            resource('mongo', {
                "action": "bulkWrite",
                "collection": "audio_chunks",
                "operations": operations,
                "options": {"ordered": False},
            })
        report("saved", len(chunk_files), len(chunk_files))
        return len(chunk_files)
    finally:
        if os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir)
