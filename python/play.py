import io
import argparse
import numpy as np
from datetime import datetime, timedelta
from pytz import UTC
from typing import List, Dict, Any

from lib.worker import mongo_cursor
from lib.config import load_environment
from chunking import read_codec, array_to_wav, sample_rate


def parse_timestamp(ts: str) -> datetime:
    """Parse timestamp from ISO string or Unix timestamp."""
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except ValueError:
        try:
            return datetime.fromtimestamp(float(ts), tz=UTC)
        except ValueError:
            raise ValueError(f"Invalid timestamp format: {ts}")


def format_timestamp_for_filename(dt: datetime) -> str:
    """Format datetime as filesystem-safe string."""
    return dt.strftime("%Y-%m-%dT%H-%M-%S")


def get_chunks_in_range(start: datetime, end: datetime) -> List[Dict[str, Any]]:
    """Query MongoDB for audio chunks that overlap with the specified time range."""
    max_chunk_duration = timedelta(seconds=10)
    query_start = start - max_chunk_duration
    
    query = {
        "start": {
            "$gte": query_start,
            "$lt": end
        }
    }
    
    options = {
        "sort": {"start": 1}
    }
    
    chunks = list(mongo_cursor('audio_chunks', query, options))
    return chunks


def check_overlaps(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Check for overlapping chunks with different original_id and log warnings."""
    if not chunks:
        return chunks
    
    chunk_ranges = []
    for chunk in chunks:
        chunk_start = chunk['start']
        try:
            audio = read_codec(chunk['data'], codec="opus", sample_rate=sample_rate)
            chunk_duration = timedelta(seconds=len(audio) / sample_rate)
        except Exception as e:
            print(f"WARNING: Failed to decode chunk {chunk.get('_id')} for overlap detection: {e}")
            continue
        
        chunk_end = chunk_start + chunk_duration
        chunk_ranges.append({
            'chunk': chunk,
            'start': chunk_start,
            'end': chunk_end,
            'original_id': chunk.get('original_id')
        })
    
    filtered_chunks = []
    seen_ranges: List[Dict[str, Any]] = []
    
    for chunk_info in chunk_ranges:
        chunk = chunk_info['chunk']
        chunk_start = chunk_info['start']
        chunk_end = chunk_info['end']
        original_id = chunk_info['original_id']
        
        overlapping = []
        for existing in seen_ranges:
            if not (chunk_end <= existing['start'] or chunk_start >= existing['end']):
                if existing['original_id'] != original_id:
                    overlapping.append(existing)
        
        if overlapping:
            chosen_original_id = overlapping[0]['original_id']
            for existing in overlapping:
                print("WARNING: Overlapping chunks detected with different original_id:")
                print(f"  Existing: original_id={existing['original_id']}, {existing['start']} - {existing['end']}")
                print(f"  New: original_id={original_id}, {chunk_start} - {chunk_end}")
            print(f"  Picking chunks with original_id: {chosen_original_id} (first encountered)")
            
            if original_id != chosen_original_id:
                continue
        
        filtered_chunks.append(chunk)
        seen_ranges.append(chunk_info)
    
    return filtered_chunks


def combine_chunks_to_wav(chunks: List[Dict[str, Any]], start: datetime, end: datetime) -> io.BytesIO:
    """
    Combine opus chunks into a single WAV file for the specified time range.
    Handles gaps between chunks by inserting silence.
    """
    if not chunks:
        silence_duration = (end - start).total_seconds()
        silence_samples = int(silence_duration * sample_rate)
        silence = np.zeros(silence_samples, dtype=np.float32)
        return array_to_wav(silence, sample_rate=sample_rate)
    
    audio_arrays = []
    current_time = start
    
    for chunk in chunks:
        chunk_start = chunk['start']
        
        try:
            audio = read_codec(chunk['data'], codec="opus", sample_rate=sample_rate)
        except Exception as e:
            print(f"WARNING: Failed to decode chunk {chunk.get('_id')}: {e}")
            continue
        
        chunk_duration = timedelta(seconds=len(audio) / sample_rate)
        chunk_end = chunk_start + chunk_duration
        
        if chunk_end <= start:
            continue
        if chunk_start >= end:
            break
        
        clip_start = max(0, int((start - chunk_start).total_seconds() * sample_rate))
        clip_end = min(len(audio), int((end - chunk_start).total_seconds() * sample_rate))
        
        if clip_start < clip_end:
            audio = audio[clip_start:clip_end]
        else:
            continue
        
        gap = (chunk_start - current_time).total_seconds()
        
        if gap > 0:
            silence_samples = int(gap * sample_rate)
            audio_arrays.append(np.zeros(silence_samples, dtype=np.float32))
        elif gap < 0:
            overlap_samples = int(-gap * sample_rate)
            if audio_arrays and len(audio_arrays[-1]) > overlap_samples:
                audio_arrays[-1] = audio_arrays[-1][:-overlap_samples]
        
        audio_arrays.append(audio)
        current_time = chunk_start + chunk_duration
    
    if not audio_arrays:
        silence_duration = (end - start).total_seconds()
        silence_samples = int(silence_duration * sample_rate)
        silence = np.zeros(silence_samples, dtype=np.float32)
        return array_to_wav(silence, sample_rate=sample_rate)
    
    combined_audio = np.concatenate(audio_arrays, axis=0)
    
    target_duration = (end - start).total_seconds()
    target_samples = int(target_duration * sample_rate)
    
    if len(combined_audio) > target_samples:
        combined_audio = combined_audio[:target_samples]
    elif len(combined_audio) < target_samples:
        padding = np.zeros(target_samples - len(combined_audio), dtype=np.float32)
        combined_audio = np.concatenate([combined_audio, padding], axis=0)
    
    return array_to_wav(combined_audio, sample_rate=sample_rate)


def extract_audio(start: datetime, end: datetime, output_path: str = None):
    """Extract audio from MongoDB chunks for the specified time range."""
    if start >= end:
        raise ValueError("Start timestamp must be before end timestamp")
    
    print(f"Fetching chunks from {start} to {end}")
    chunks = get_chunks_in_range(start, end)
    print(f"Found {len(chunks)} chunks")
    
    if not chunks:
        print("No chunks found in the specified time range")
        return
    
    chunks = check_overlaps(chunks)
    print(f"Processing {len(chunks)} chunks after overlap handling")
    
    print("Combining chunks into WAV...")
    wav_file = combine_chunks_to_wav(chunks, start, end)
    
    if output_path is None:
        start_str = format_timestamp_for_filename(start)
        end_str = format_timestamp_for_filename(end)
        output_path = f"{start_str}-{end_str}.local.wav"
    
    with open(output_path, 'wb') as f:
        f.write(wav_file.read())
    
    print(f"Audio saved to: {output_path}")


if __name__ == '__main__':
    load_environment()
    parser = argparse.ArgumentParser(description='Extract audio from MongoDB chunks for a time range')
    parser.add_argument('start', type=str, help='Start timestamp (ISO format or Unix timestamp)')
    parser.add_argument('end', type=str, help='End timestamp (ISO format or Unix timestamp)')
    parser.add_argument('-o', '--output', type=str, help='Output file path (default: {start}-{end}.local.wav)')
    
    args = parser.parse_args()
    
    start = parse_timestamp(args.start)
    end = parse_timestamp(args.end)
    
    extract_audio(start, end, args.output)

