"""Opaque correlation, thread context and private failure contracts; no models."""
import asyncio
import logging
from types import SimpleNamespace
from uuid import UUID

import httpx

from test_shared_livekit import load_helper


CAPTURE = '4305706a-9185-434e-848b-42c66c419fa7'
REQUEST = 'a4c789df-a629-481c-b59a-39b210424fe4'


def test_context_survives_native_thread_and_resets_between_captures():
    helper = load_helper()

    async def scenario():
        async def capture(capture_id):
            with helper.live_context({'capture_id': capture_id, 'window_index': '2'}) as context:
                calls = helper.TrackedRemoteCalls()
                def request():
                    value = SimpleNamespace(headers={})
                    helper.correlate_http_request(value)
                    return value.headers
                first = await calls.run(request)
                second = await calls.run(request)
                assert first['X-Mycelia-Capture-ID'] == capture_id
                assert first['X-Mycelia-Session-ID'] == context['session_id']
                assert first['X-Mycelia-Window-Index'] == '2'
                assert first['X-Request-ID'] != second['X-Request-ID']
                UUID(first['X-Request-ID'])
                assert helper.config_message(True, 'full', False, '', '', False)['diagnostics'] == context
                return context
        first, second = await asyncio.gather(capture(CAPTURE), capture(REQUEST))
        assert first['session_id'] != second['session_id']
        assert helper._LIVE_CONTEXT.get() is None

    asyncio.run(scenario())


def test_failure_preserves_ids_and_allowlisted_code_without_remote_body(caplog):
    helper = load_helper()
    request = httpx.Request('POST', 'https://SECRET:SECRET@provider.invalid/asr',
                            headers={'x-request-id': REQUEST})
    response = httpx.Response(503, headers={'x-request-id': REQUEST, 'x-live-error-code': 'upstream_busy'},
                              request=request, json={'detail': 'PRIVATE_TRANSCRIPT'})
    error = httpx.HTTPStatusError('PRIVATE_TRANSCRIPT SECRET', request=request, response=response)
    error.status_code = 503
    with helper.live_context({'capture_id': CAPTURE, 'window_index': '2'}):
        failure = helper.processing_failure('remote ASR', error)
        frame = helper.error_frame(failure)
        assert frame['request_id'] == REQUEST
        assert frame['capture_id'] == CAPTURE
        assert frame['upstream_status'] == 503
        assert frame['code'] == 'upstream_busy'
        helper.log_failure(logging.getLogger('live-diagnostics-contract'), failure)
    assert len(str(frame)) < 1000
    assert 'PRIVATE_' not in caplog.text + str(failure)
    assert 'SECRET' not in caplog.text + str(failure)
    assert 'provider.invalid' not in caplog.text + str(failure)


def test_invalid_header_metadata_and_query_never_enter_error_frame():
    helper = load_helper()
    error = RuntimeError('PRIVATE_MESSAGE')
    error.response = SimpleNamespace(headers={'x-request-id': 'PRIVATE_TOKEN', 'x-live-error-code': 'PRIVATE_BODY'})
    with helper.live_context({'capture_id': 'PRIVATE_URL', 'window_index': 'PRIVATE_TEXT'}):
        frame = helper.error_frame(error)
    UUID(frame['capture_id'])
    assert frame['code'] == 'processing_failed'
    assert 'request_id' not in frame
    assert 'window_index' not in frame
    assert 'PRIVATE_' not in str(frame)
