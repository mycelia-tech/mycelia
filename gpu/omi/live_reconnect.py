"""Bounded pre-audio admission retry for the shared single-session WLK server."""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
import json

from websockets.exceptions import ConnectionClosed

ADMISSION_TIMEOUT = 45.0
BUSY_RETRY_INTERVAL = 0.25
FAILED_CONTEXT_CLOSE_GRACE = 0.1


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
