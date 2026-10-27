"""Rotate WLK transport windows without rotating the durable Omi capture.

Only the active WLK window is replaceable. Completed snapshots remain a frozen
capture prefix; speaker numbers are anonymous and never reused across windows.
The constructor overrides exist for deterministic tests, not production env.
"""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, suppress
from copy import deepcopy
from datetime import datetime, timezone
import json
import logging
import math
import os
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)
BYTES_PER_SECOND = 32000
SAMPLE_RATE = 16000
CLEANUP_GRACE = 0.1


# Never log arbitrary exception messages: provider bodies can contain speech,
# URLs or credentials. Only these exact known local contract messages map to a
# diagnostic reason; the original exception and public failure behavior remain.
_KNOWN_FAILURES = {
    'Invalid preview timestamp': 'invalid_timestamp',
    'Unordered preview timestamps': 'unordered_timestamps',
    'Invalid preview lines': 'invalid_lines',
    'Invalid preview text': 'invalid_text',
    'Invalid preview buffer': 'invalid_buffer',
    'Invalid live snapshot': 'invalid_snapshot',
    'local_preview_early_eof': 'early_eof',
    'local_preview_error': 'provider_error',
    'local_preview_closed_without_eof': 'closed_without_eof',
    'local_preview_pcm_contract': 'pcm_contract',
    'local_preview_disabled_during_capture': 'disabled_during_capture',
    'local_preview_window_close_timeout': 'window_close_timeout',
}
_FALLBACK_REASONS = {'config_incomplete', 'capacity_full', 'timeout', 'other'}
_STATUS_REASONS = {'unavailable', 'disabled', 'invalid_configuration', 'buffer_full',
                   'protocol_error', 'busy', 'recovering'}
_PROVIDER_CODES = {'upstream_busy', 'upstream_failed', 'upstream_timeout', 'upstream_unavailable',
                   'invalid_timing_response', 'model_mismatch', 'empty_audio', 'audio_too_large',
                   'client_disconnected', 'processing_failed', 'diarization_failed', 'live_provider_failed'}


def _provider_details(message):
    result = {}
    for key in ('capture_id', 'session_id', 'request_id'):
        value = message.get(key)
        if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value):
            result[key] = value
    code = message.get('code')
    if isinstance(code, str) and code in _PROVIDER_CODES:
        result['code'] = code
    status = message.get('upstream_status')
    if type(status) is int and 100 <= status <= 599:
        result['upstream_status'] = status
    return result


def _correlated_url(url, capture_id, index):
    parts = urlsplit(url)
    fields = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
              if key not in {'capture_id', 'window_index'}]
    fields.extend((('capture_id', capture_id), ('window_index', str(index))))
    return urlunsplit(parts._replace(query=urlencode(fields)))


def _failure_details(error):
    reason = 'unexpected_exception'
    if isinstance(error, ConnectionClosed):
        reason = 'connection_closed'
    elif isinstance(error, TimeoutError):
        reason = 'timeout'
    elif isinstance(error, json.JSONDecodeError):
        reason = 'invalid_json'
    if error.args and type(error.args[0]) is str:
        reason = _KNOWN_FAILURES.get(error.args[0], reason)
    name = type(error).__name__
    result = {'reason': reason,
              'exception_class': name if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', name) else 'Exception',
              'traceback': []}
    tb = error.__traceback__
    while tb is not None:
        code = tb.tb_frame.f_code
        filename = os.path.basename(code.co_filename)
        function = code.co_name
        result['traceback'].append({
            'file': filename if re.fullmatch(r'[A-Za-z0-9_.-]{1,100}\.py', filename) else '<code>',
            'line': tb.tb_lineno,
            'function': function if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', function) else '<code>',
        })
        tb = tb.tb_next
    result['traceback'] = result['traceback'][-12:]
    if isinstance(error, ConnectionClosed):
        code = error.rcvd.code if error.rcvd is not None else None
        if type(code) is int and 1000 <= code <= 4999:
            result['close_code'] = code
    return result


def _numeric_time(value):
    if type(value) in (int, float):
        try:
            return float(value) if math.isfinite(value) else None
        except (ValueError, OverflowError):
            return None
    if type(value) is str and re.fullmatch(r'\d{1,8}:\d{2}:\d{2}(?:\.\d{1,12})?', value):
        hours, minutes, seconds = value.split(':')
        if int(minutes) < 60 and float(seconds) < 60:
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return None


def _projection_details(snapshot, duration, error):
    """Numeric-only context for the first known invalid timestamp/ordering pair."""
    result = {'audio_seconds': duration}
    lines = snapshot.get('lines') if isinstance(snapshot, dict) else None
    if not isinstance(lines, list):
        return result
    result['line_count'] = len(lines)
    reason = _failure_details(error)['reason']
    if reason not in {'invalid_timestamp', 'unordered_timestamps'}:
        return result
    previous = previous_index = None
    for index, row in enumerate(lines):
        if not isinstance(row, dict) or row.get('speaker') == -2 or not row.get('text'):
            continue
        start, end = _numeric_time(row.get('start')), _numeric_time(row.get('end'))
        context = {'row_index': index, 'start': start, 'end': end}
        for field, value in (('start', start), ('end', end)):
            if value is None or value < 0 or value > duration + 0.1:
                result.update(context, invalid_field=field)
                if value is not None:
                    result['beyond_audio_seconds'] = value - duration
                return result
        # Match only the existing validator's clamp for identifying its failure;
        # diagnostics do not edit or reinterpret the provider's actual snapshot.
        valid_start, valid_end = min(start, duration), min(end, duration)
        if valid_end < valid_start:
            result.update(context, invalid_field='end_before_start')
            return result
        if previous is not None and valid_start < previous:
            result.update(context, invalid_field='ordering', previous_row_index=previous_index,
                          previous_start=previous, start_delta=valid_start - previous)
            return result
        text = row.get('text')
        if isinstance(text, str) and text.strip():
            previous, previous_index = valid_start, index
    return result


def _consume(task):
    if not task.cancelled():
        task.exception()


def _abort(socket):
    with suppress(Exception):
        socket.transport.abort()


class _Connection:
    def __init__(self):
        self.stack = AsyncExitStack()
        self.socket = None


class _Window:
    def __init__(self, index, offset_bytes):
        self.index = index
        self.offset_bytes = offset_bytes
        self.sent_bytes = 0
        # A response can arrive before send() returns from its flow-control wait.
        # Validate against bytes offered to the transport, never queued capture PCM.
        self.offered_bytes = 0
        self.eof_sent = False
        self.eof_ack = False


async def _close(connection, *, deadline=None, failed=False):
    """Run the connector exit exactly once, with abort on timeout/cancellation."""
    if connection is None or connection.stack is None:
        return
    stack, connection.stack = connection.stack, None
    if failed:
        _abort(connection.socket)
    closer = asyncio.create_task(stack.aclose(), name='local-preview-window-close')
    timeout = (CLEANUP_GRACE if failed else
               max(0.0, deadline - asyncio.get_running_loop().time()) if deadline is not None else 2.0)
    try:
        done, _ = await asyncio.wait([closer], timeout=timeout)
        if closer in done:
            closer.result()
            return
        _abort(connection.socket)
        closer.cancel()
        closer.add_done_callback(_consume)
        if not failed:
            raise TimeoutError('local_preview_window_close_timeout')
    except BaseException:
        _abort(connection.socket)
        if not closer.done():
            closer.cancel()
            closer.add_done_callback(_consume)
        raise


async def _cancel_tasks(tasks):
    tasks = [task for task in tasks if task is not None]
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        try:
            await asyncio.wait(tasks, timeout=CLEANUP_GRACE)
        finally:
            for task in tasks:
                if task.done():
                    _consume(task)
                else:
                    task.add_done_callback(_consume)


class _CaptureProjection:
    def __init__(self, projection_cls, initial):
        self.projection_cls = projection_cls
        self.id = initial.id
        self.revision = 0
        self.segments = []
        self.text = ''
        self.frozen = []
        self.next_speaker = 0
        self.window_index = 0
        self.offset_bytes = 0
        self.active = initial
        self.local_speakers = {}

    def begin(self, index, offset_bytes, config):
        capture = self
        projection_cls = self.projection_cls
        mapping = {}

        class WindowProjection(projection_cls):
            def _speaker(self, value):
                _, raw = super()._speaker(value)
                if raw < 0:
                    return None, -1
                if raw not in mapping:
                    mapping[raw] = capture.next_speaker
                    capture.next_speaker += 1
                number = mapping[raw]
                return f'SPEAKER_{number:02d}', number

        self.active = WindowProjection()
        self.active.id = f'{self.id}-window-{index}'
        self.active.configure(config)
        self.window_index = index
        self.offset_bytes = offset_bytes
        self.local_speakers = mapping

    @property
    def diarization(self):
        return self.active.diarization

    @diarization.setter
    def diarization(self, value):
        self.active.diarization = value

    @property
    def configured_diarization(self):
        return self.active.configured_diarization

    @property
    def last_snapshot(self):
        return self.active.last_snapshot

    def update(self, snapshot, duration):
        if self.active.update(snapshot, duration) is None:
            return None
        offset = self.offset_bytes / BYTES_PER_SECOND
        local_ids = {global_id: raw for raw, global_id in self.local_speakers.items()}
        rows = []
        for original in self.active.segments:
            row = deepcopy(original)
            row.update(start=original['start'] + offset, end=original['end'] + offset,
                       live_window_index=self.window_index,
                       speaker_local_id=local_ids.get(original['speaker_id']))
            rows.append(row)
        self.segments = self.frozen + rows
        self.text = ' '.join(row['text'] for row in self.segments)
        self.revision += 1
        return {'type': 'local_transcript_snapshot', 'preview_id': self.id,
                'revision': self.revision, 'segments': self.segments,
                'live_window_index': self.window_index, 'live_window_start_s': offset}

    def freeze(self):
        # EOF is not permission to turn a remaining hypothesis into confirmed text.
        # Preserve its is_draft flag, and never carry it into the next ASR request.
        self.frozen = deepcopy(self.segments)

    def clear(self):
        self.segments = []
        self.frozen = []
        self.text = ''
        self.active.segments = []
        self.active.text = ''
        self.active.last_snapshot = None
        self.local_speakers = {}


def rotating_preview_class(base_cls, projection_cls):
    """Install against the hash-verified r5 class without importing capture code."""
    record_fallback = base_cls._run.__globals__['record_fallback']

    class RotatingLocalLivePreview(base_cls):
        FINISH_TIMEOUT = 120.0
        FINAL_DRAIN_TIMEOUT = 60.0

        def __init__(self, url, send_segments, *, unavailable_reason='disabled',
                     rotation_seconds=1800.0, connector=None, handoff_timeout=50.0):
            if (isinstance(rotation_seconds, bool) or not isinstance(rotation_seconds, (int, float))
                    or not math.isfinite(rotation_seconds) or rotation_seconds <= 0):
                raise ValueError('Invalid live rotation duration')
            if (isinstance(handoff_timeout, bool) or not isinstance(handoff_timeout, (int, float))
                    or not math.isfinite(handoff_timeout) or not 0 < handoff_timeout <= 50):
                raise ValueError('Invalid live handoff timeout')
            self.rotation_bytes = round(rotation_seconds * SAMPLE_RATE) * 2
            if self.rotation_bytes < 2:
                raise ValueError('Live window must contain at least one sample')
            self.handoff_timeout = handoff_timeout
            self.connector = connector or websockets.connect
            self._carry_pcm = b''
            self.completed_windows = 0
            self.window = None
            self._failure_details = None
            self._projection_details = None
            self._provider_diagnostics = None
            self._capture_id = str(uuid4())
            self._phase = 'initializing'
            self._attempt_window_index = 0
            super().__init__(url, send_segments, unavailable_reason=unavailable_reason)
            self.segment = _CaptureProjection(projection_cls, self.segment)
            # feed() may fill/cancel the task before its coroutine starts; in
            # that case no coroutine finally block can release buffered PCM.
            self.task.add_done_callback(lambda _: self._clear_pending())

        def _diagnose(self, error):
            try:
                self._failure_details = _failure_details(error)
                if self._projection_details is not None:
                    self._failure_details['projection'] = self._projection_details
            except Exception:
                # Observability must never replace or alter the original failure.
                self._failure_details = None

        def _fail(self, reason, *, status_reason='unavailable'):
            if not self.failed:
                try:
                    window = self.window
                    preview_id = getattr(self.segment, 'id', '')
                    payload = {
                        'event': 'local_preview_failure',
                        'capture_id': self._capture_id,
                        'timestamp_utc': datetime.now(timezone.utc).isoformat(),
                        'preview_id': preview_id if re.fullmatch(
                            r'local-preview-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', preview_id) else None,
                        'phase': self._phase, 'attempt_window_index': self._attempt_window_index,
                        'reason': 'unclassified', 'exception_class': None, 'traceback': [],
                        'window_index': window.index if window is not None else None,
                        'sent_bytes': window.sent_bytes if window is not None else 0,
                        'offered_bytes': window.offered_bytes if window is not None else 0,
                        'eof_sent': window.eof_sent if window is not None else False,
                        'eof_ack': window.eof_ack if window is not None else False,
                        'fallback_reason': reason if reason in _FALLBACK_REASONS else 'other',
                        'status_reason': status_reason if status_reason in _STATUS_REASONS else 'unavailable',
                        **(self._failure_details or {}),
                    }
                    if self._provider_diagnostics:
                        payload['provider'] = self._provider_diagnostics
                    logger.warning('Local preview failure %s', json.dumps(payload, allow_nan=False, sort_keys=True))
                except Exception:
                    pass
            super()._fail(reason, status_reason=status_reason)

        def _clear_pending(self):
            self.accepting = False
            self._carry_pcm = b''
            self.segment.clear()
            while not self.queue.empty():
                self.queue.get_nowait()
            self.pending_bytes = 0

        def feed(self, pcm):
            if not self.accepting or self.task.done():
                return
            if not pcm:
                return  # Empty binary frames belong solely to the EOF protocol.
            if len(pcm) % 2:
                self._fail('other', status_reason='protocol_error')
                self.accepting = False
                self.task.cancel()
                return
            super().feed(pcm)

        async def _next_pcm(self):
            if self._carry_pcm:
                pcm, self._carry_pcm = self._carry_pcm, b''
                return pcm
            while True:
                pcm = await self.queue.get()
                if pcm is None or pcm:
                    return pcm

        async def _send_window(self, socket, window):
            while True:
                pcm = await self._next_pcm()
                if pcm is None:
                    return 'stop'
                remaining = self.rotation_bytes - window.sent_bytes
                if remaining == 0:
                    # Peek only: Stop exactly at the boundary never admits an
                    # empty next window. A transport pause consumes no handoff budget.
                    self._carry_pcm = pcm
                    return 'rotate'
                piece = pcm[:remaining]
                self._carry_pcm = pcm[len(piece):]
                window.offered_bytes += len(piece)
                await socket.send(piece)
                window.sent_bytes += len(piece)
                self.pending_bytes -= len(piece)

        async def _receive_window(self, socket, window):
            async for raw in socket:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError('Invalid live snapshot')
                if message.get('type') == 'ready_to_stop':
                    if not window.eof_sent:
                        raise RuntimeError('local_preview_early_eof')
                    window.eof_ack = self.eof_ack = True
                    return
                if message.get('type') == 'error' or message.get('status') == 'error':
                    self._provider_diagnostics = _provider_details(message)
                    raise RuntimeError('local_preview_error')
                status = (message.get('status') if message.get('type') == 'diarization_status'
                          else message.get('diarization_status'))
                if status in {'degraded', 'ready'}:
                    enabled = self.segment.configured_diarization and status == 'ready'
                    if enabled != self.segment.diarization:
                        self.segment.diarization = enabled
                        record_fallback(component='stt_selection',
                            from_mode='local_live_preview' if enabled else 'local_live_diarization',
                            to_mode='local_live_diarization' if enabled else 'local_live_preview',
                            reason='local_heal' if enabled else 'other',
                            outcome='recovered' if enabled else 'degraded')
                    if message.get('type') == 'diarization_status':
                        message = self.segment.last_snapshot or {}
                duration = window.offered_bytes / BYTES_PER_SECOND
                self._projection_details = None
                try:
                    snapshot = self.segment.update(message, duration)
                except Exception as error:
                    try:
                        self._projection_details = _projection_details(message, duration, error)
                    except Exception:
                        pass
                    raise
                if snapshot is not None and self.deliver:
                    try:
                        await self.send_segments(snapshot)
                        self.updates += 1
                        if self.updates == 1:
                            logger.warning('Local preview: first_segment_sent')
                    except Exception:
                        self.deliver = False
            if not window.eof_ack:
                raise RuntimeError('local_preview_closed_without_eof')

        async def _window_ready(self):
            if not self.deliver:
                return
            payload = {'type': 'service_status', 'status': 'ready', 'provider': 'local_live_preview',
                       'capture_id': self._capture_id,
                       'live_window_index': self.window.index,
                       'live_window_start_s': self.window.offset_bytes / BYTES_PER_SECOND}
            try:
                await asyncio.wait_for(self.send_segments(payload), self.STATUS_TIMEOUT)
            except Exception:
                pass

        async def _run_windows(self):
            connection = None
            sender = receiver = None
            index = offset_bytes = 0
            deadline = None
            try:
                while True:
                    self._phase = 'admission'
                    self._attempt_window_index = index
                    connection = _Connection()
                    async with asyncio.timeout_at(deadline):
                        socket = connection.socket = await connection.stack.enter_async_context(
                            self.connector(_correlated_url(self.url, self._capture_id, index), open_timeout=3, close_timeout=2,
                                           max_size=self.MAX_SNAPSHOT_BYTES))
                        handshake = 50 if os.getenv('OMI_LOCAL_LIVE_PROVIDER_RELAY') == '1' else 3
                        config = json.loads(await asyncio.wait_for(socket.recv(), handshake))
                        if isinstance(config, dict) and (config.get('type') == 'error' or config.get('status') == 'error'):
                            self._provider_diagnostics = _provider_details(config)
                            raise RuntimeError('local_preview_error')
                        if (not isinstance(config, dict) or config.get('type') != 'config'
                                or config.get('useAudioWorklet') is not True):
                            raise RuntimeError('local_preview_pcm_contract')
                        if config.get('enabled') is False:
                            if index:
                                raise RuntimeError('local_preview_disabled_during_capture')
                            self.disabled = True
                            return
                    # Only a fully validated config completes the shared handoff.
                    deadline = None
                    self.window = window = _Window(index, offset_bytes)
                    self._phase = 'streaming'
                    self.eof_ack = False
                    self.segment.begin(index, offset_bytes, config)
                    if self.failed:
                        return
                    await self._window_ready()
                    sender = asyncio.create_task(self._send_window(socket, window), name='local-preview-send')
                    receiver = asyncio.create_task(self._receive_window(socket, window), name='local-preview-receive')
                    done, _ = await asyncio.wait([sender, receiver], return_when=asyncio.FIRST_COMPLETED)
                    if receiver in done:
                        receiver.result()
                        raise RuntimeError('local_preview_early_eof')
                    reason = sender.result()
                    timeout = self.handoff_timeout if reason == 'rotate' else self.FINAL_DRAIN_TIMEOUT
                    deadline = asyncio.get_running_loop().time() + timeout
                    self._phase = 'eof_drain'
                    async with asyncio.timeout_at(deadline):
                        window.eof_sent = True
                        await socket.send(b'')
                        await receiver
                        self._phase = 'closing'
                        await _close(connection, deadline=deadline)
                    connection = None
                    sender = receiver = None
                    self.segment.freeze()
                    self.completed_windows += 1
                    logger.warning('Local preview window complete index=%d samples=%d eof_ack=%s reason=%s',
                                   index, window.sent_bytes // 2, window.eof_ack, reason)
                    if reason == 'stop':
                        return
                    index += 1
                    offset_bytes += window.sent_bytes
                    # The original deadline survives EOF drain, context close and
                    # the next connection/config; no per-stage budget reset.
            finally:
                for task in (sender, receiver):
                    if task is not None and not task.done():
                        task.cancel()
                try:
                    try:
                        await _close(connection, deadline=deadline, failed=True)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        pass  # Preserve the original stream failure.
                finally:
                    await _cancel_tasks((sender, receiver))

        async def _run(self):
            try:
                if not self.url:
                    if self.unavailable_reason == 'disabled':
                        self.disabled = True
                    else:
                        self._fail('config_incomplete', status_reason=self.unavailable_reason)
                    return
                await self._run_windows()
            except asyncio.CancelledError:
                raise
            except ConnectionClosed as error:
                self._diagnose(error)
                code = error.rcvd.code if error.rcvd is not None else None
                status_reason = {
                    'live_preview_busy': 'busy', 'final_transcription_busy': 'busy',
                    'live_preview_recovering': 'recovering', 'live_preview_unavailable': 'unavailable',
                }.get(error.rcvd.reason, 'unavailable') if code == 1013 else 'unavailable'
                self._fail('capacity_full' if status_reason == 'busy' else 'other', status_reason=status_reason)
            except TimeoutError as error:
                self._diagnose(error)
                self._fail('timeout', status_reason='unavailable')
            except (ValueError, TypeError, RuntimeError) as error:
                self._diagnose(error)
                self._fail('other', status_reason='protocol_error')
            except Exception as error:
                self._diagnose(error)
                self._fail('other')
            finally:
                self._clear_pending()

    return RotatingLocalLivePreview
