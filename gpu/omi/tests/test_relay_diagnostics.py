"""Short relay and preview correlation contracts; fake sockets and no audio I/O."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

import test_reconnect as relay
import test_rotation as rotation


CAPTURE = '4305706a-9185-434e-848b-42c66c419fa7'
REQUEST = 'a4c789df-a629-481c-b59a-39b210424fe4'


def test_r5_diagnostics_overlay_checks_exact_hash_before_mutating(tmp_path):
    directory = os.getenv('OMI_RECONNECT_SOURCE_DIR')
    if not directory:
        pytest.skip('requires retained r4 source for build-time hash contract')
    spec = importlib.util.spec_from_file_location('r5_diagnostics_patch', relay.ROOT / 'patch_live_diagnostics.py')
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    prior_spec = importlib.util.spec_from_file_location('r4_patch', relay.ROOT / 'patch_live_reconnect.py')
    prior = importlib.util.module_from_spec(prior_spec)
    prior_spec.loader.exec_module(prior)
    raw = (Path(directory) / 'omi-r4-local-provider-relay.py').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == prior.EXPECTED['local_provider_relay.py']
    source = prior.patch_relay(raw.decode())
    assert hashlib.sha256(source.encode()).hexdigest() == patch.EXPECTED
    path = tmp_path / 'local_provider_relay.py'
    path.write_text(source)
    patch.main([str(path)])
    assert 'raise ProviderFailure(decoded)' in path.read_text()
    assert 'relay_error_frame(error, socket.query_params)' in path.read_text()
    changed = path.read_bytes()
    with pytest.raises(RuntimeError, match='differs from verified'):
        patch.main([str(path)])
    assert path.read_bytes() == changed


def test_relay_forwards_capture_and_bounded_failure_without_replaying_audio(caplog):
    methods = relay.relay_methods()
    frame = {'type': 'error', 'code': 'upstream_timeout', 'capture_id': CAPTURE,
             'request_id': REQUEST, 'upstream_status': 504,
             'error': 'PRIVATE_SPEECH_OR_TOKEN', 'url': 'https://PRIVATE_URL'}

    class FailingProvider(relay.Provider):
        async def send(self, value):
            self.sent.append(value)
            if value:
                self.incoming.put_nowait(json.dumps(frame))
            await asyncio.sleep(0)

    async def scenario():
        provider = FailingProvider()
        downstream = relay.Downstream([b'\0\0', b''])
        downstream.query_params = {'capture_id': CAPTURE, 'window_index': '3'}
        calls = []
        def connector(endpoint, *, key):
            calls.append(endpoint)
            return provider
        with pytest.raises(relay.admission.ProviderFailure) as raised:
            await methods['relay_session'](downstream, {}, None, connector=connector)
        assert len(calls) == 1
        assert parse_qs(urlsplit(calls[0]).query) == {'capture_id': [CAPTURE], 'window_index': ['3']}
        assert provider.sent.count(b'\0\0') == 1
        assert provider.closed
        public = relay.admission.relay_error_frame(raised.value, downstream.query_params)
        assert public == {'type': 'error', 'code': 'upstream_timeout', 'capture_id': CAPTURE,
                          'window_index': 3, 'request_id': REQUEST, 'upstream_status': 504}
        assert 'PRIVATE_' not in str(public)
    asyncio.run(scenario())
    assert 'PRIVATE_' not in caplog.text


def test_preview_capture_id_is_stable_across_transport_windows():
    async def scenario():
        urls = []
        base = rotation.Connector()
        events = []
        def connector(url, **kwargs):
            urls.append(url)
            return base(url, **kwargs)
        async def send(event):
            events.append(event)
        preview = rotation.preview_types()('ws://127.0.0.1:21004/asr?language=ru', send,
            connector=connector, rotation_seconds=.04)
        try:
            preview.feed(b'\0\0' * 1440)
            await rotation.eventually(lambda: len(base.providers) == 3 and base.providers[-1].samples == 160)
            await preview.finish()
            assert not preview.failed
            contexts = [parse_qs(urlsplit(url).query) for url in urls]
            assert {item['capture_id'][0] for item in contexts} == {preview._capture_id}
            assert [item['window_index'][0] for item in contexts] == ['0', '1', '2']
            assert all(item['language'] == ['ru'] for item in contexts)
            assert all(event['capture_id'] == preview._capture_id
                       for event in events if event.get('type') == 'service_status')
        finally:
            if not preview.task.done():
                preview.task.cancel()
            await asyncio.gather(preview.task, return_exceptions=True)
    asyncio.run(scenario())


def test_untrusted_failure_and_url_context_are_bounded():
    context = relay.admission.ProviderFailure({'code': ['PRIVATE'], 'request_id': 'PRIVATE' * 1000,
                                               'upstream_status': True})
    assert context.diagnostics == {'code': 'live_provider_failed'}
    url = relay.admission.correlated_endpoint('ws://selected.invalid/asr?language=ru&capture_id=PRIVATE',
                                               {'capture_id': CAPTURE, 'window_index': '999999999'})
    assert parse_qs(urlsplit(url).query) == {'language': ['ru'], 'capture_id': [CAPTURE]}


def test_pre_audio_error_keeps_request_id_and_never_retries():
    async def scenario():
        provider = relay.Provider({'type': 'error', 'code': 'upstream_unavailable', 'request_id': REQUEST})
        calls = []
        def connector(*_, **__):
            calls.append(True)
            return provider
        with pytest.raises(relay.admission.ProviderFailure) as error:
            async with relay.admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                validate_config=relay.relay_methods()['validate_config']):
                pytest.fail('error cannot admit audio')
        assert error.value.diagnostics == {'code': 'upstream_unavailable', 'request_id': REQUEST}
        assert len(calls) == 1
        assert provider.sent == []
        assert provider.closed
    asyncio.run(scenario())
