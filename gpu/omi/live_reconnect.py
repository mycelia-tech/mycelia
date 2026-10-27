"""Bounded pre-audio admission retry for the shared single-session WLK server."""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
import json
import logging
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from websockets.exceptions import ConnectionClosed

ADMISSION_TIMEOUT = 45.0
BUSY_RETRY_INTERVAL = 0.25
FAILED_CONTEXT_CLOSE_GRACE = 0.1
logger = logging.getLogger(__name__)
_UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
_ERROR_CODES = {'upstream_busy', 'upstream_failed', 'upstream_timeout', 'upstream_unavailable',
                'invalid_timing_response', 'model_mismatch', 'empty_audio', 'audio_too_large',
                'client_disconnected', 'processing_failed', 'diarization_failed', 'live_provider_failed'}


def diagnostic_context(value):
    result = {}
    for key in ('capture_id', 'session_id', 'request_id'):
        item = value.get(key)
        if isinstance(item, str) and _UUID.fullmatch(item):
            result[key] = item
    window = value.get('window_index')
    if type(window) is int and 0 <= window < 1000000:
        result['window_index'] = window
    elif isinstance(window, str) and re.fullmatch(r'[0-9]{1,6}', window):
        result['window_index'] = int(window)
    return result


def correlated_endpoint(endpoint, query):
    context = diagnostic_context(query)
    context.setdefault('capture_id', str(uuid4()))
    parts = urlsplit(endpoint)
    fields = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
              if key not in {'capture_id', 'session_id', 'request_id', 'window_index'}]
    fields.extend((key, str(value)) for key, value in context.items())
    return urlunsplit(parts._replace(query=urlencode(fields)))


class ProviderFailure(ValueError):
    """Keep only an allowlisted provider error, never its text or response body."""

    def __init__(self, frame):
        super().__init__('Live provider stream failed')
        self.diagnostics = diagnostic_context(frame)
        code = frame.get('code')
        self.diagnostics['code'] = code if isinstance(code, str) and code in _ERROR_CODES else 'live_provider_failed'
        status = frame.get('upstream_status')
        if type(status) is int and 100 <= status <= 599:
            self.diagnostics['upstream_status'] = status


def relay_error_frame(error, query):
    context = diagnostic_context(query)
    context.update(error.diagnostics if isinstance(error, ProviderFailure) else {})
    context.setdefault('code', 'live_provider_failed')
    event = {'event': 'live_relay_failure', **context}
    name = type(error).__name__
    if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', name):
        event['exception_class'] = name
    try:
        logger.warning('%s', json.dumps(event, sort_keys=True))
    except Exception:
        pass
    return {'type': 'error', **context}


class ProviderBusyTimeout(TimeoutError):
    """The preceding live session did not release admission within the budget."""


def _is_busy_frame(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return False
    return isinstance(value, dict) and value.get('type') == 'error' and value.get('error') == 'live session busy'


def _abort(provider):
    # On cancellation/deadline the admitted stream has not received any audio.
    # Abort transport immediately rather than waiting beyond the admission budget.
    transport = getattr(provider, 'transport', None)
    if transport is not None:
        with suppress(Exception):
            transport.abort()


def _consume(task):
    if not task.cancelled():
        task.exception()


async def _close_attempt(stack, provider, deadline):
    """Include WebSocket context cleanup in the same admission deadline."""
    task = asyncio.create_task(stack.aclose())
    try:
        remaining = max(0, deadline - asyncio.get_running_loop().time())
        done, _ = await asyncio.wait([task], timeout=remaining)
        if not done:
            raise TimeoutError()
        task.result()
    except BaseException:
        _abort(provider)
        task.cancel()
        task.add_done_callback(_consume)
        raise


async def _admit(endpoint, key, connector, validate_config, timeout):
    deadline = asyncio.get_running_loop().time() + timeout
    budget = asyncio.timeout_at(deadline)
    stack = None
    provider = None
    saw_busy = False
    try:
        async with budget:
            while True:
                stack = AsyncExitStack()
                provider = await stack.enter_async_context(connector(endpoint, key=key))
                try:
                    raw = await asyncio.wait_for(provider.recv(), 5)
                except ConnectionClosed as error:
                    if error.rcvd is None or error.rcvd.code != 4409:
                        raise
                    busy = True
                else:
                    busy = _is_busy_frame(raw)
                if not busy:
                    try:
                        frame = json.loads(raw)
                    except (ValueError, TypeError):
                        frame = None  # The existing config validator rejects it.
                    if isinstance(frame, dict) and (frame.get('type') == 'error' or frame.get('status') == 'error'):
                        raise ProviderFailure(frame)
                    config = validate_config(raw)
                    accepted = stack
                    stack = None  # connect_ready now owns the accepted context
                    return accepted, provider, config
                saw_busy = True
                await _close_attempt(stack, provider, deadline)
                stack = None
                provider = None
                await asyncio.sleep(min(BUSY_RETRY_INTERVAL,
                                        max(0, deadline - asyncio.get_running_loop().time())))
    except BaseException as error:
        # Capture this before cleanup: a later cleanup deadline must not relabel
        # an earlier per-attempt connect/recv timeout as exhausted busy admission.
        overall_expired = budget.expired() or asyncio.get_running_loop().time() >= deadline
        if stack is not None:
            _abort(provider)
            try:
                # Transport is already aborted; give context hooks only a short
                # grace so caller cancellation never waits out the full budget.
                cleanup_deadline = min(deadline, asyncio.get_running_loop().time()
                                       + FAILED_CONTEXT_CLOSE_GRACE)
                await _close_attempt(stack, provider, cleanup_deadline)
            except asyncio.CancelledError:
                # A fresh caller cancellation during cleanup must also win over
                # an earlier config/connection error.
                raise
            except Exception:
                # Cleanup was initiated and is deadline-bounded; preserve the
                # original admission failure rather than a cleanup failure.
                pass
        if isinstance(error, TimeoutError) and overall_expired and saw_busy:
            raise ProviderBusyTimeout('Live provider admission remained busy') from None
        raise


@asynccontextmanager
async def connect_ready(endpoint, *, key, connector, validate_config, timeout=None):
    """Retry only explicit busy before config; never replay an accepted stream."""
    stack, provider, config = await _admit(
        endpoint, key, connector, validate_config,
        ADMISSION_TIMEOUT if timeout is None else timeout,
    )
    try:
        yield provider, config
    finally:
        await stack.aclose()
