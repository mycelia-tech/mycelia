"""Network-free admission/PCM contract tests against actual patched relay methods."""
from __future__ import annotations

import ast
import asyncio
from contextlib import suppress
import importlib.util
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

ROOT = Path(__file__).resolve().parents[1]
if (ROOT / 'live_reconnect.py').is_file():
    spec = importlib.util.spec_from_file_location('reconnect_under_test', ROOT / 'live_reconnect.py')
    admission = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admission)
else:
    from dev_harness import live_reconnect as admission


def source(name):
    fixture_root = os.getenv('OMI_RECONNECT_SOURCE_DIR')
    if fixture_root:
        names = {'relay': 'omi-r4-local-provider-relay.py', 'preview': 'omi-r4-local-live-preview.py'}
        raw = (Path(fixture_root) / names[name]).read_text()
        spec = importlib.util.spec_from_file_location('reconnect_patch_test', ROOT / 'patch_live_reconnect.py')
        overlay = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(overlay)
        return overlay.patch_relay(raw) if name == 'relay' else overlay.patch_preview(raw)
    paths = {'relay': '/opt/omiloc/scripts/dev-harness/dev_harness/local_provider_relay.py',
             'preview': '/opt/omiloc/backend/utils/local_live_preview.py'}
    return Path(paths[name]).read_text()


def relay_methods():
    tree = ast.parse(source('relay'))
    methods = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
               and node.name in {'relay_session', 'validate_config'}]
    namespace = {'asyncio': asyncio, 'suppress': suppress, 'json': json, 'RelayError': ValueError,
                 'MAX_MESSAGE_BYTES': 16 * 1024 * 1024, 'DRAIN_SECONDS': 1,
                 'upstream': lambda snapshot, cfg, raw=False: ('ws://selected.invalid/asr', True),
                 'connect': None, 'connect_ready': admission.connect_ready}
    exec(compile(ast.Module(body=methods, type_ignores=[]), 'patched_relay', 'exec'), namespace)
    return namespace


class Transport:
    def __init__(self):
        self.aborted = False

    def abort(self):
        self.aborted = True


class Provider:
    def __init__(self, initial=None, *, close_delay=0, recv_event=None, stream_error=False):
        self.initial = initial if initial is not None else {'type': 'config', 'useAudioWorklet': True}
        self.close_delay = close_delay
        self.recv_event = recv_event
        self.stream_error = stream_error
        self.incoming = asyncio.Queue()
        self.sent = []
        self.transport = Transport()
        self.closed = False
        self.exit_called = 0
        self.entered = False

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *_):
        self.exit_called += 1
        await asyncio.sleep(self.close_delay)
        self.closed = True

    async def recv(self):
        if self.recv_event:
            await self.recv_event.wait()
        if isinstance(self.initial, BaseException):
            raise self.initial
        return json.dumps(self.initial)

    async def send(self, value):
        self.sent.append(value)
        if self.stream_error:
            self.incoming.put_nowait(json.dumps({'type': 'error', 'error': 'stream failure'}))
        elif not value:
            self.incoming.put_nowait(json.dumps({'type': 'ready_to_stop'}))
        else:
            self.incoming.put_nowait(json.dumps({'lines': [], 'buffer_transcription': 'synthetic'}))
        await asyncio.sleep(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.incoming.get()


class Downstream:
    def __init__(self, frames):
        self.frames = asyncio.Queue()
        for frame in frames:
            self.frames.put_nowait({'type': 'websocket.receive', 'bytes': frame})
        self.receives = 0
        self.messages = []

    async def receive(self):
        self.receives += 1
        return await self.frames.get()

    async def send_text(self, value):
        self.messages.append(json.loads(value))


class ReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.methods = relay_methods()
        self.config = self.methods['validate_config']
        self.interval = patch.object(admission, 'BUSY_RETRY_INTERVAL', .001)
        self.interval.start()
        self.addCleanup(self.interval.stop)

    def connector(self, providers):
        calls = []
        def connect(endpoint, *, key):
            calls.append((endpoint, key))
            return providers[len(calls) - 1]
        return connect, calls

    async def test_busy_then_config_preserves_all_pcm_in_order(self):
        busy = Provider({'type': 'error', 'error': 'live session busy'})
        ready = Provider()
        connector, calls = self.connector([busy, ready])
        frames = [b'\x01\x00' * 320, b'\x02\x00' * 320, b'']
        downstream = Downstream(frames)
        await self.methods['relay_session'](downstream, {}, None, key='synthetic', connector=connector)
        self.assertEqual(len(calls), 2)
        self.assertEqual(busy.sent, [])
        self.assertTrue(busy.closed)
        self.assertEqual(ready.sent, frames)
        self.assertEqual(downstream.messages[0]['type'], 'config')
        self.assertEqual(downstream.messages[-1]['type'], 'ready_to_stop')
        self.assertEqual(sum(m.get('type') == 'config' for m in downstream.messages), 1)

    async def test_close_4409_before_config_retries(self):
        busy = Provider(ConnectionClosedError(Close(4409, 'busy'), Close(4409, 'busy'), True))
        ready = Provider()
        connector, calls = self.connector([busy, ready])
        async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                           validate_config=self.config) as (provider, config):
            self.assertIs(provider, ready)
            self.assertEqual(config['type'], 'config')
        self.assertEqual(len(calls), 2)

    async def test_auth_close_is_not_retried(self):
        provider = Provider(ConnectionClosedError(Close(4401, 'auth'), Close(4401, 'auth'), True))
        connector, calls = self.connector([provider])
        with self.assertRaises(ConnectionClosedError):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        self.assertEqual(len(calls), 1)
        self.assertTrue(provider.transport.aborted)
        self.assertEqual(provider.exit_called, 1)

    async def test_wrong_config_is_not_retried(self):
        provider = Provider({'type': 'config', 'useAudioWorklet': False})
        connector, calls = self.connector([provider])
        with self.assertRaises(ValueError):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        self.assertEqual(len(calls), 1)
        self.assertTrue(provider.transport.aborted)
        self.assertEqual(provider.exit_called, 1)

    async def test_non_busy_error_is_not_retried(self):
        provider = Provider({'type': 'error', 'error': 'anything else'})
        connector, calls = self.connector([provider])
        with self.assertRaises(ValueError):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        self.assertEqual(len(calls), 1)

    async def test_busy_then_config_timeout_keeps_original_timeout(self):
        busy = Provider({'type': 'error', 'error': 'live session busy'})
        timeout = TimeoutError('per-attempt recv timeout')
        broken = Provider(timeout)
        connector, calls = self.connector([busy, broken])
        with self.assertRaises(TimeoutError) as raised:
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        self.assertIs(raised.exception, timeout)
        self.assertNotIsInstance(raised.exception, admission.ProviderBusyTimeout)
        self.assertEqual(len(calls), 2)
        self.assertEqual(broken.exit_called, 1)
        self.assertTrue(broken.transport.aborted)

    async def test_busy_then_connect_timeout_keeps_original_timeout(self):
        busy = Provider({'type': 'error', 'error': 'live session busy'})
        timeout = TimeoutError('per-attempt connect timeout')
        calls = []
        def connector(*args, **kwargs):
            calls.append(True)
            if len(calls) == 1:
                return busy
            raise timeout
        with self.assertRaises(TimeoutError) as raised:
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        self.assertIs(raised.exception, timeout)
        self.assertNotIsInstance(raised.exception, admission.ProviderBusyTimeout)
        self.assertEqual(len(calls), 2)
        self.assertEqual(busy.exit_called, 1)

    async def test_invalid_config_with_slow_cleanup_keeps_original_error(self):
        provider = Provider({'type': 'config', 'useAudioWorklet': False}, close_delay=1)
        connector, calls = self.connector([provider])
        started = time.monotonic()
        with self.assertRaises(ValueError):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config, timeout=.025):
                self.fail('not admitted')
        self.assertLess(time.monotonic() - started, .2)
        self.assertEqual(provider.exit_called, 1)
        self.assertTrue(provider.transport.aborted)
        self.assertEqual(len(calls), 1)
        await asyncio.sleep(0)

    async def test_cancel_during_slow_exit_keeps_cancellation(self):
        provider = Provider(recv_event=asyncio.Event(), close_delay=1)
        connector, calls = self.connector([provider])
        async def attempt():
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        task = asyncio.create_task(attempt())
        while not provider.entered:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, .2)
        self.assertEqual(provider.exit_called, 1)
        self.assertTrue(provider.transport.aborted)
        self.assertEqual(len(calls), 1)

    async def test_fresh_cancel_during_failed_config_cleanup_wins(self):
        provider = Provider({'type': 'config', 'useAudioWorklet': False}, close_delay=1)
        connector, calls = self.connector([provider])
        async def attempt():
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        task = asyncio.create_task(attempt())
        while not provider.exit_called:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, .2)
        self.assertTrue(task.cancelled())
        self.assertEqual(provider.exit_called, 1)
        self.assertTrue(provider.transport.aborted)
        self.assertEqual(len(calls), 1)

    async def test_connect_error_is_not_retried(self):
        calls = []
        def connector(*args, **kwargs):
            calls.append(True)
            raise OSError('synthetic connect failure')
        with self.assertRaises(OSError):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        self.assertEqual(len(calls), 1)

    async def test_busy_deadline_includes_slow_context_close(self):
        busy = Provider({'type': 'error', 'error': 'live session busy'}, close_delay=1)
        connector, calls = self.connector([busy])
        started = time.monotonic()
        with self.assertRaises(admission.ProviderBusyTimeout):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config, timeout=.025):
                self.fail('not admitted')
        self.assertLess(time.monotonic() - started, .2)
        self.assertEqual(len(calls), 1)
        self.assertTrue(busy.transport.aborted)
        self.assertEqual(busy.exit_called, 1)
        await asyncio.sleep(0)

    async def test_retries_share_one_overall_deadline(self):
        providers = []
        def connector(*args, **kwargs):
            provider = Provider({'type': 'error', 'error': 'live session busy'}, close_delay=.003)
            providers.append(provider)
            return provider
        started = time.monotonic()
        with self.assertRaises(admission.ProviderBusyTimeout):
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config, timeout=.03):
                self.fail('not admitted')
        self.assertGreater(len(providers), 1)
        self.assertLess(time.monotonic() - started, .2)
        self.assertTrue(all(p.closed or p.transport.aborted for p in providers))

    async def test_cancel_during_admission_aborts_promptly(self):
        provider = Provider(recv_event=asyncio.Event())
        connector, calls = self.connector([provider])
        async def attempt():
            async with admission.connect_ready('ws://selected.invalid/asr', key='', connector=connector,
                                               validate_config=self.config):
                self.fail('not admitted')
        task = asyncio.create_task(attempt())
        while not provider.entered:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, .2)
        self.assertTrue(provider.transport.aborted)
        self.assertEqual(provider.exit_called, 1)
        self.assertEqual(len(calls), 1)

    async def test_no_pcm_consumed_until_real_config(self):
        release = asyncio.Event()
        provider = Provider(recv_event=release)
        connector, calls = self.connector([provider])
        downstream = Downstream([b'\x01\x00', b''])
        task = asyncio.create_task(self.methods['relay_session'](downstream, {}, None, connector=connector))
        while not provider.entered:
            await asyncio.sleep(0)
        await asyncio.sleep(.005)
        self.assertEqual(downstream.receives, 0)
        self.assertEqual(provider.sent, [])
        self.assertEqual(downstream.messages, [])
        release.set()
        await asyncio.wait_for(task, .3)
        self.assertEqual(provider.sent, [b'\x01\x00', b''])
        self.assertEqual(len(calls), 1)

    async def test_post_admission_stream_failure_never_replays_audio(self):
        provider = Provider(stream_error=True)
        connector, calls = self.connector([provider])
        downstream = Downstream([b'\x01\x00', b''])
        with self.assertRaises(ValueError):
            await self.methods['relay_session'](downstream, {}, None, connector=connector)
        self.assertEqual(len(calls), 1)
        self.assertEqual(provider.sent.count(b'\x01\x00'), 1)

    def test_only_relay_handshake_budget_changes_and_pcm_limit_remains(self):
        tree = ast.parse(source('preview'))
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'LocalLivePreview')
        assignment = next(node for node in ast.walk(cls) if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == 'handshake_timeout'
                                  for target in node.targets))
        expression = compile(ast.Expression(body=assignment.value), 'handshake_timeout', 'eval')
        self.assertEqual(eval(expression, {'os': SimpleNamespace(getenv=lambda name: '1')}), 50)
        self.assertEqual(eval(expression, {'os': SimpleNamespace(getenv=lambda name: None)}), 3)
        maximum = next(node for node in cls.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == 'MAX_PENDING_BYTES'
                               for target in node.targets))
        self.assertEqual(eval(compile(ast.Expression(body=maximum.value), 'pcm_bound', 'eval')), 60 * 32000)
        method = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == 'feed')
        namespace = {}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'actual_feed', 'exec'), namespace)
        cancelled = []
        failures = []
        instance = SimpleNamespace(accepting=True, pending_bytes=0, audio_bytes=0, MAX_PENDING_BYTES=4,
            queue=asyncio.Queue(), task=SimpleNamespace(done=lambda: False, cancel=lambda: cancelled.append(True)),
            _fail=lambda *args, **kwargs: failures.append((args, kwargs)))
        namespace['feed'](instance, b'1234')
        self.assertEqual(instance.queue.get_nowait(), b'1234')
        self.assertEqual(instance.pending_bytes, 4)
        namespace['feed'](instance, b'56')
        self.assertFalse(instance.accepting)
        self.assertEqual(cancelled, [True])
        self.assertEqual(len(failures), 1)
        self.assertEqual(instance.audio_bytes, 4)


if __name__ == '__main__':
    unittest.main()
