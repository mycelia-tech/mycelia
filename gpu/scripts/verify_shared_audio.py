"""Pace a WAV through WLK or Omi, with optional concurrent multipart batch checks.

Requires websockets<14 and httpx; Omi CV1 mode additionally requires opuslib.
Reports technical counters only, never recognized text or audio.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
import time
import wave
from collections import deque
from pathlib import Path
from urllib.parse import urlencode, urlsplit

RATE = 16000
FRAME_BYTES = 3200  # 100 ms PCM16 mono
LAG_INTERVAL_S = 300
MAX_LAG_INTERVALS = 48  # The CLI permits up to four hours.


def pcm_chunks(pcm, sample_count):
    """Repeat PCM continuously, including across fixture and final-frame boundaries."""
    if not pcm or len(pcm) % 2:
        raise ValueError('PCM must contain whole 16-bit samples')
    if type(sample_count) is not int or sample_count < 0:
        raise ValueError('sample count must be a non-negative integer')
    position = 0
    remaining = sample_count * 2
    while remaining:
        wanted = min(FRAME_BYTES, remaining)
        pieces = []
        available = wanted
        while available:
            piece = pcm[position:position + available]
            pieces.append(piece)
            available -= len(piece)
            position = (position + len(piece)) % len(pcm)
        yield b''.join(pieces)
        remaining -= wanted


def close_category(error):
    """Return only fixed categories: arbitrary peer close reasons may contain text."""
    received, sent = getattr(error, 'rcvd', None), getattr(error, 'sent', None)
    if sent is not None and sent.reason == 'keepalive ping timeout':
        return 'keepalive_timeout'
    code = getattr(received, 'code', None) or getattr(sent, 'code', None)
    return {1000: 'normal_close', 1001: 'going_away', 1002: 'protocol_error',
            1003: 'unsupported_data', 1006: 'abnormal_close', 1007: 'invalid_payload',
            1008: 'policy_violation', 1009: 'message_too_big', 1011: 'internal_error',
            1012: 'service_restart', 1013: 'try_again_later'}.get(code, 'unclassified')


class Metric:
    def __init__(self):
        self.n, self.total, self.high = 0, 0.0, 0.0
        self.recent = deque(maxlen=1024)

    def add(self, value):
        if math.isfinite(value):
            self.n += 1
            self.total += value
            self.high = max(self.high, value)
            self.recent.append(value)

    def report(self):
        ordered = sorted(self.recent)
        return {'count': self.n, 'mean_s': round(self.total / self.n, 3) if self.n else None,
                'max_s': round(self.high, 3) if self.n else None,
                'p95_recent_s': round(ordered[math.ceil(.95 * len(ordered)) - 1], 3) if ordered else None,
                'recent_window': len(ordered)}


def token_file(path):
    if path.stat().st_mode & 0o077:
        raise ValueError('token file must have mode 0600')
    token = path.read_text().strip()
    if not token or len(token) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('token file contains an invalid token')
    return token


def checked_url(value, websocket):
    part = urlsplit(value)
    schemes = {'ws', 'wss'} if websocket else {'http', 'https'}
    if (part.scheme not in schemes or not part.hostname or part.username or part.password
            or part.query or part.fragment):
        raise ValueError('URL must have a host and no credentials, query, or fragment')
    return value.rstrip('/')


def fixture(path):
    with wave.open(str(path), 'rb') as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, RATE, 'NONE'):
            raise ValueError('fixture must be uncompressed PCM16 mono 16 kHz WAV')
        pcm = audio.readframes(audio.getnframes())
    if not pcm:
        raise ValueError('fixture has no PCM')
    return pcm, path.read_bytes()


def timestamp(value):
    try:
        if isinstance(value, str):
            result = 0.0
            for component in value.split(':'):
                result = result * 60 + float(component)
        elif type(value) in (int, float):
            result = float(value)
        else:
            return None
        return result if math.isfinite(result) and result >= 0 else None
    except ValueError:
        return None


class StreamStats:
    def __init__(self, omi):
        self.omi = omi
        self.start = time.monotonic()
        self.ready = None
        self.audio_start = None
        self.first_text = None
        self.first_speaker = None
        self.speakers = set()
        self.snapshots = 0
        self.lines_max = 0
        self.last_end = None
        self.last_lag = None
        self.lag = Metric()
        self.errors = 0
        self.heartbeats = 0
        self.eof_ack = False
        self.sent_s = 0.0
        self.diarization = False
        self.audio_lag = Metric()
        self.lag_intervals = deque(maxlen=MAX_LAG_INTERVALS)
        self.snapshot_bytes_max = 0
        self.snapshot_bytes_last = None
        self.last_snapshot = None
        self.last_progress = None
        self.last_message = None
        self.target_samples = None
        self.sent_samples = 0
        self.padding_samples = 0
        self.audio_pacing_elapsed = None
        self.pacing_lag = Metric()

    def on_message(self, msg, wire_bytes=None):
        elapsed = time.monotonic() - self.start
        self.last_message = elapsed
        kind = msg.get('type')
        if self.ready is None and (kind == 'config' or self.omi and kind == 'service_status' and msg.get('status') == 'ready'):
            self.ready = elapsed
        if kind == 'config':
            self.diarization = msg.get('diarization') is True
        if kind == 'ready_to_stop':
            self.eof_ack = True
        if kind == 'error' or msg.get('status') in {'error', 'stt_failed'}:
            self.errors += 1
        lines = msg.get('segments') if self.omi and kind == 'local_transcript_snapshot' else msg.get('lines')
        if not isinstance(lines, list):
            return
        self.snapshots += 1
        self.last_snapshot = elapsed
        if wire_bytes is not None:
            self.snapshot_bytes_last = wire_bytes
            self.snapshot_bytes_max = max(self.snapshot_bytes_max, wire_bytes)
        committed = [row for row in lines if isinstance(row, dict) and isinstance(row.get('text'), str)
                     and row['text'].strip() and (not self.omi or not row.get('is_draft'))]
        self.lines_max = max(self.lines_max, len(committed))
        if committed and self.first_text is None:
            self.first_text = elapsed
        newest_end = None
        for row in committed:
            speaker = row.get('speaker_id') if self.omi else row.get('speaker')
            if not self.omi and isinstance(speaker, str) and speaker.startswith('SPEAKER_'):
                suffix = speaker.removeprefix('SPEAKER_')
                speaker = int(suffix) if suffix.isdigit() else None
            if (self.omi or self.diarization) and type(speaker) is int and speaker >= 0:
                self.speakers.add(speaker)
                if self.first_speaker is None:
                    self.first_speaker = elapsed
            end = timestamp(row.get('end'))
            if end is not None:
                newest_end = end if newest_end is None else max(newest_end, end)
        if newest_end is not None and (self.last_end is None or newest_end > self.last_end):
            self.last_end = newest_end
            self.last_progress = elapsed
            self.last_lag = max(0.0, elapsed - newest_end)
            self.lag.add(self.last_lag)
            if self.audio_start is not None:
                audio_elapsed = max(0.0, elapsed - self.audio_start)
                lag = max(0.0, audio_elapsed - newest_end)
                self.audio_lag.add(lag)
                interval = int(audio_elapsed // LAG_INTERVAL_S)
                if not self.lag_intervals or self.lag_intervals[-1][0] != interval:
                    self.lag_intervals.append((interval, Metric()))
                self.lag_intervals[-1][1].add(lag)

    def report(self):
        elapsed = time.monotonic() - self.start
        return {'ready_s': self.ready, 'audio_start_s': self.audio_start,
                'first_text_after_audio_start_s': (self.first_text - self.audio_start
                    if self.first_text is not None and self.audio_start is not None else None),
                'first_committed_text_s': self.first_text,
                'first_speaker_s': self.first_speaker, 'distinct_speakers': len(self.speakers),
                'snapshots': self.snapshots, 'committed_lines_max': self.lines_max,
                'last_committed_audio_end_s': self.last_end, 'last_line_lag_s': self.last_lag,
                'line_lag': self.lag.report(), 'audio_relative_line_lag': self.audio_lag.report(),
                'audio_relative_lag_intervals': [
                    {'start_s': number * LAG_INTERVAL_S, 'end_s': (number + 1) * LAG_INTERVAL_S,
                     **metric.report()} for number, metric in self.lag_intervals],
                'snapshot_bytes_max': self.snapshot_bytes_max,
                'snapshot_bytes_last': self.snapshot_bytes_last,
                'last_snapshot_age_s': round(elapsed - self.last_snapshot, 3) if self.last_snapshot is not None else None,
                'last_progress_age_s': round(elapsed - self.last_progress, 3) if self.last_progress is not None else None,
                'last_message_age_s': round(elapsed - self.last_message, 3) if self.last_message is not None else None,
                'protocol_errors': self.errors, 'heartbeats': self.heartbeats,
                'eof_ack': self.eof_ack, 'audio_sent_s': round(self.sent_s, 6),
                'target_audio_samples': self.target_samples, 'audio_samples_sent': self.sent_samples,
                'acceptance_audio_duration_s': self.target_samples / RATE if self.target_samples is not None else None,
                'opus_padding_s': self.padding_samples / RATE,
                'pacing_lag': self.pacing_lag.report(),
                'audio_pacing_elapsed_s': self.audio_pacing_elapsed}


async def receive(socket, stats):
    iterator = socket.__aiter__()
    try:
        async for raw in iterator:
            if stats.omi and raw == 'ping':
                stats.heartbeats += 1  # Omi's application-level keepalive is not JSON.
                stats.last_message = time.monotonic() - stats.start
                continue
            if not isinstance(raw, str) or len(raw) > 16 * 1024 * 1024:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                stats.errors += 1
                continue
            if isinstance(msg, dict):
                stats.on_message(msg, wire_bytes=len(raw.encode('utf-8')))
                if stats.eof_ack:
                    return
    finally:
        close = getattr(iterator, 'aclose', None)
        if close is not None:
            await close()


async def stream(url, token, pcm, duration, omi, language, stats=None):
    import websockets
    target_samples = round(duration * RATE)
    if target_samples < 1:
        raise ValueError('duration must include at least one audio sample')
    if omi:
        base = url.replace('https://', 'wss://', 1).replace('http://', 'ws://', 1)
        base = base.removesuffix('/v4/listen')
        query = urlencode({'language': language, 'sample_rate': RATE, 'codec': 'opus_fs320',
                           'channels': 1, 'include_speech_profile': 'false', 'source': 'omi'})
        url = base + '/v4/listen?' + query
        import opuslib
        encoder = opuslib.Encoder(RATE, 1, opuslib.APPLICATION_AUDIO)
        def packets(chunk):
            for pos in range(0, len(chunk), 640):
                piece = chunk[pos:pos + 640].ljust(640, b'\0')
                yield encoder.encode(piece, 320)
    else:
        def packets(chunk):
            return (chunk,)
    headers = {'Authorization': 'Bearer ' + token}
    if omi:
        headers['X-App-Platform'] = 'ios'
    stats = stats or StreamStats(omi)
    stats.target_samples = target_samples
    async with websockets.connect(url, extra_headers=headers, open_timeout=15, close_timeout=5,
                                  max_size=16 * 1024 * 1024, max_queue=8) as socket:
        reader = asyncio.create_task(receive(socket, stats))
        try:
            async with asyncio.timeout(20):
                while stats.ready is None and not reader.done():
                    await asyncio.sleep(.02)
            if stats.ready is None:
                raise RuntimeError('stream did not become ready')
            started = time.monotonic()
            stats.audio_start = started - stats.start
            next_progress_s = 60
            for chunk in pcm_chunks(pcm, target_samples):
                await asyncio.sleep(max(0, started + stats.sent_samples / RATE - time.monotonic()))
                stats.pacing_lag.add(max(0, time.monotonic() - started - stats.sent_samples / RATE))
                if reader.done():
                    await reader
                    raise RuntimeError('stream reader stopped before audio completed')
                for packet in packets(chunk):
                    await socket.send(packet)
                stats.sent_samples += len(chunk) // 2
                stats.sent_s = stats.sent_samples / RATE
                if omi:
                    stats.padding_samples += (-len(chunk) // 2) % 320
                if stats.sent_s >= next_progress_s:
                    print(json.dumps({'progress': stats.report()}), flush=True)
                    next_progress_s += 60
            # Complete the final frame's playback time before EOF; fractional final
            # frames otherwise make wall duration shorter than the requested audio.
            await asyncio.sleep(max(0, started + target_samples / RATE - time.monotonic()))
            stats.audio_pacing_elapsed = time.monotonic() - started
            if reader.done():
                await reader
                raise RuntimeError('stream reader stopped before EOF')
            if omi:
                await socket.send(json.dumps({'type': 'finalization_reason', 'reason': 'user_stop'}))
                await socket.close()  # Omi closes /v4/listen; EOF ACK is internal to its relay.
            else:
                await socket.send(b'')
                async with asyncio.timeout(90):
                    await reader
                if not stats.eof_ack:
                    raise RuntimeError('WLK did not acknowledge binary EOF')
        finally:
            cancelled_for_cleanup = not reader.done()
            if cancelled_for_cleanup:
                reader.cancel()
            outcome, = await asyncio.gather(reader, return_exceptions=True)
            if isinstance(outcome, Exception):
                raise outcome
            if (isinstance(outcome, asyncio.CancelledError) and not cancelled_for_cleanup
                    and sys.exception() is None):
                raise RuntimeError('stream reader was unexpectedly cancelled')
    return stats.report()


async def batch_loop(url, token, wav, model, interval, stop):
    import httpx
    metric = Metric()
    success = failure = words = segments = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10), trust_env=False,
                                 follow_redirects=False) as client:
        while not stop.is_set():
            started = time.monotonic()
            try:
                response = await client.post(url, headers={'Authorization': 'Bearer ' + token},
                    data={'model': model, 'response_format': 'verbose_json'},
                    files={'file': ('fixture.wav', wav, 'audio/wav')})
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict) or not isinstance(body.get('text'), str):
                    raise ValueError('batch response has no text')  # noqa: TRY004 - invalid remote payload
                success += 1
                words += len(body['text'].split())
                segments += len(body.get('segments', [])) if isinstance(body.get('segments'), list) else 0
                metric.add(time.monotonic() - started)
            except (httpx.HTTPError, ValueError):
                failure += 1
            try:
                await asyncio.wait_for(stop.wait(), max(0, started + interval - time.monotonic()))
            except asyncio.TimeoutError:
                pass
    return {'successes': success, 'failures': failure, 'total_words': words,
            'total_segments': segments, 'latency': metric.report()}


async def run(args):
    pcm, wav = fixture(args.fixture)
    token = token_file(args.token_file)
    omi = bool(args.omi_url)
    url = args.omi_url if omi else args.wlk_url
    checked_url(url, websocket=not omi or url.startswith(('ws://', 'wss://')))
    if not omi and urlsplit(url).path != '/asr':
        raise ValueError('WLK URL must end in /asr')
    if args.batch_url:
        checked_url(args.batch_url, websocket=False)
        if urlsplit(args.batch_url).path != '/v1/audio/transcriptions':
            raise ValueError('batch URL must end in /v1/audio/transcriptions')
        batch_token = token_file(args.batch_key_file)
    stop = asyncio.Event()
    batch = (asyncio.create_task(batch_loop(args.batch_url, batch_token, wav, args.batch_model,
                                           args.batch_interval, stop)) if args.batch_url else None)
    result = {'mode': 'omi' if omi else 'wlk', 'requested_duration_s': args.duration,
              'fixture_duration_s': round(len(pcm) / 32000, 3), 'started_epoch_s': time.time()}
    stats = StreamStats(omi)
    completed = False
    try:
        result['stream'] = await stream(url, token, pcm, args.duration, omi, args.language, stats)
        if args.reconnect_check:
            result['reconnect'] = await stream(url, token, pcm, min(8, args.duration), omi, args.language)
        completed = True
    except Exception as error:  # noqa: BLE001 - retain partial metrics without sensitive exception text
        result['stream'] = stats.report()
        result['failure'] = {'type': type(error).__name__, 'close_category': close_category(error)}
        received = getattr(error, 'rcvd', None)
        if received is not None and isinstance(received.code, int):
            result['failure']['websocket_close_code'] = received.code
        sent = getattr(error, 'sent', None)
        if sent is not None and isinstance(sent.code, int):
            result['failure']['client_close_code'] = sent.code
            result['failure']['keepalive_timeout'] = sent.reason == 'keepalive ping timeout'
    finally:
        stop.set()
        if batch:
            result['batch'] = await batch
    result['elapsed_s'] = round(time.time() - result['started_epoch_s'], 3)
    result['checks'] = {
        'stream_completed': completed,
        'requested_audio_sent': result['stream'].get('audio_samples_sent') == round(args.duration * RATE),
        'pacing_duration_observed': (result['stream'].get('audio_pacing_elapsed_s') is not None
            and result['stream']['audio_pacing_elapsed_s'] >= round(args.duration * RATE) / RATE),
        'committed_text_observed': result['stream']['first_committed_text_s'] is not None,
        'no_protocol_errors': all(result[name]['protocol_errors'] == 0
                                  for name in ('stream', 'reconnect') if name in result),
        'eof_ack_observed': result['stream']['eof_ack'] if not omi else None,
        'reconnect_text_observed': (result.get('reconnect', {}).get('first_committed_text_s') is not None
                                    if args.reconnect_check else None),
        'batch_all_succeeded': (result['batch']['successes'] > 0 and result['batch']['failures'] == 0
                                if batch else None),
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--wlk-url', help='full ws://...:8010/asr')
    target.add_argument('--omi-url', help='Omi backend base URL for real CV1 Opus /v4/listen')
    parser.add_argument('--token-file', type=Path, required=True, help='mode 0600 Bearer token file')
    parser.add_argument('--fixture', type=Path, required=True, help='PCM16 mono 16 kHz WAV')
    parser.add_argument('--duration', type=float, default=120, help='real-time seconds; e.g. 1800')
    parser.add_argument('--language', default='en', help='Omi listen language; direct WLK uses its server setting')
    parser.add_argument('--reconnect-check', action='store_true', help='second 8-second session')
    parser.add_argument('--batch-url', help='full /v1/audio/transcriptions URL')
    parser.add_argument('--batch-key-file', type=Path, help='mode 0600 existing batch key')
    parser.add_argument('--batch-model', default='large-v3-turbo')
    parser.add_argument('--batch-interval', type=float, default=60)
    parser.add_argument('--json-output', type=Path, required=True)
    args = parser.parse_args()
    if not 0 < args.duration <= 14400 or not math.isfinite(args.duration):
        parser.error('duration must be 0-14400 seconds')
    if args.batch_interval < 1 or not math.isfinite(args.batch_interval):
        parser.error('batch interval must be at least 1 second')
    if bool(args.batch_url) != bool(args.batch_key_file):
        parser.error('batch URL and key file must be supplied together')
    if args.json_output.exists():
        parser.error('JSON output already exists')
    try:
        report = asyncio.run(run(args))
    except Exception as error:  # noqa: BLE001 - avoid logging credentials or transcript in third-party errors
        print(f'verification failed: {type(error).__name__}', file=sys.stderr)
        return 1
    fd = os.open(args.json_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    print(f'technical report written: {args.json_output}')
    return 0 if all(value is not False for value in report['checks'].values()) else 2


if __name__ == '__main__':
    raise SystemExit(main())
