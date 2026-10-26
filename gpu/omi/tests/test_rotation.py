"""Exact PCM, snapshot and lifecycle contracts for the deployed preview overlay.

Run against the installed r6 image without network/state mounts, or set
OMI_ROTATION_SOURCE_DIR to retained source extracted from the actual r5 image.
No source from an unrelated Omi checkout is imported.
"""
from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
import uuid
import wave

from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[1]
if (ROOT / 'local_live_rotation.py').is_file():
    spec = importlib.util.spec_from_file_location('rotation_under_test', ROOT / 'local_live_rotation.py')
    rotation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rotation)
else:
    from utils import local_live_rotation as rotation


async def drain(tasks, *, timeout, cancel=False, **_):
    if cancel:
        for task in tasks:
            if not task.done():
                task.cancel()
    if tasks:
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout)


def preview_types():
    directory = os.getenv('OMI_ROTATION_SOURCE_DIR')
    path = (Path(directory) / 'omi-r5-local-live-preview.py' if directory
            else Path('/opt/omiloc/backend/utils/local_live_preview.py'))
    tree = ast.parse(path.read_text())
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef)
               and node.name in {'PreviewSegment', 'LocalLivePreview'}]
    assert len(classes) == 2, 'actual base preview classes must be present'
    namespace = {'asyncio': asyncio, 'json': json, 'math': math, 'os': os, 're': re, 'uuid': uuid,
        'logger': logging.getLogger('rotation-contract-tests'), 'ConnectionClosed': ConnectionClosed,
        'record_fallback': lambda **_: None,
        'create_named_task': lambda awaitable, name: asyncio.create_task(awaitable, name=name),
        'drain_tasks': drain, 'websockets': SimpleNamespace(connect=None)}
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(path), 'exec'), namespace)
    return rotation.rotating_preview_class(namespace['LocalLivePreview'], namespace['PreviewSegment'])


def capture_contract():
    root = Path('/opt/omiloc/backend')
    path = root / 'utils/offline_audio_capture.py'
    if not path.exists():
        raise unittest.SkipTest('single WAV integration runs inside the actual Omi image')
    tree = ast.parse(path.read_text())
    tree.body = [node for node in tree.body if not (isinstance(node, ast.ImportFrom)
                 and node.module and node.module.startswith('utils.'))]
    namespace = {}
    exec(compile(tree, str(path), 'exec'), namespace)
    runtime = ast.parse((root / 'routers/listen/runtime.py').read_text())
    method = next(node for node in ast.walk(runtime) if isinstance(node, ast.FunctionDef)
                  and node.name == 'capture_decoded_audio')
    exec(compile(ast.Module(body=[method], type_ignores=[]), 'actual_capture_delivery', 'exec'), namespace)
    return namespace['OfflineAudioCapture'], namespace['capture_decoded_audio']


class Provider:
    def __init__(self, number, *, config=None, config_delay=0, eof_delay=0, close_delay=0,
                 config_gate=None, eof_gate=None, final_revision=True, malformed=False,
                 fail_after_audio=False, draft_at_eof=False, early_ack=False, audio_send_gate=None):
        self.number = number
        self.config = config if config is not None else {'type': 'config', 'useAudioWorklet': True,
                                                        'diarization': True, 'stt_provider': 'test'}
        self.config_delay, self.eof_delay, self.close_delay = config_delay, eof_delay, close_delay
        self.config_gate, self.eof_gate = config_gate, eof_gate
        self.final_revision, self.malformed, self.fail_after_audio = final_revision, malformed, fail_after_audio
        self.draft_at_eof, self.early_ack = draft_at_eof, early_ack
        self.audio_send_gate = audio_send_gate
        self.incoming = asyncio.Queue()
        self.sent = []
        self.samples = 0
        self.entered = False
        self.closed = False
        self.aborted = False
        self.eof = asyncio.Event()
        self.final_sent = False
        self.tasks = []
        self.transport = SimpleNamespace(abort=self.abort)

    def abort(self):
        self.aborted = True

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *_):
        await asyncio.sleep(self.close_delay)
        self.closed = True
        for task in self.tasks:
            if not task.done():
                task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    async def close(self):
        await self.__aexit__()

    async def recv(self):
        if self.config_gate:
            await self.config_gate.wait()
        await asyncio.sleep(self.config_delay)
        if isinstance(self.config, BaseException):
            raise self.config
        return json.dumps(self.config)

    def snapshot(self, final=False):
        return {'lines': [{'text': f'synthetic-{self.number}-' + ('final' if final else 'pending'),
                           'speaker': 1 if final else 0, 'start': 0.0, 'end': self.samples / 16000}],
                'buffer_transcription': 'synthetic-unconfirmed' if final and self.draft_at_eof else '',
                'buffer_diarization': ''}

    async def acknowledge(self):
        if self.eof_gate:
            await self.eof_gate.wait()
        await asyncio.sleep(self.eof_delay)
        if self.final_revision and self.samples:
            self.incoming.put_nowait(json.dumps(self.snapshot(final=True)))
            self.final_sent = True
        self.incoming.put_nowait(json.dumps({'type': 'ready_to_stop'}))

    async def send(self, pcm):
        self.sent.append(pcm)
        if pcm == b'':
            self.eof.set()
            self.tasks.append(asyncio.create_task(self.acknowledge()))
        else:
            self.samples += len(pcm) // 2
            message = ({'type': 'ready_to_stop'} if self.early_ack else
                       {'type': 'error'} if self.fail_after_audio else self.snapshot())
            self.incoming.put_nowait('malformed' if self.malformed else json.dumps(message))
            if self.audio_send_gate:
                await self.audio_send_gate.wait()
        await asyncio.sleep(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.incoming.get()


class Connector:
    def __init__(self, options=None):
        self.options = options or {}
        self.providers = []
        self.overlap = False

    def __call__(self, *_, **__):
        if self.providers and not (self.providers[-1].closed or self.providers[-1].aborted):
            self.overlap = True
        provider = Provider(len(self.providers), **self.options.get(len(self.providers), {}))
        self.providers.append(provider)
        return provider


async def eventually(predicate, timeout=.6):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.001)


class RotationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.preview_class = preview_types()
        self.previews = []
        self.events = []

    async def asyncTearDown(self):
        for preview in self.previews:
            if not preview.task.done():
                preview.task.cancel()
            await asyncio.gather(preview.task, return_exceptions=True)
            status = getattr(preview, 'failure_status_task', None)
            if status:
                await asyncio.gather(status, return_exceptions=True)

    def make(self, connector=None, *, seconds=.04, timeout=.2):
        async def send(message):
            # Capture a value copy, detecting accidental later mutation of rows.
            self.events.append(json.loads(json.dumps(message)))
        connector = connector or Connector()
        preview = self.preview_class('ws://127.0.0.1:21004/asr', send,
            rotation_seconds=seconds, connector=connector, handoff_timeout=timeout)
        self.previews.append(preview)
        return preview, connector

    def snapshots(self):
        return [event for event in self.events if event.get('type') == 'local_transcript_snapshot']

    async def test_three_boundaries_preserve_exact_pcm_history_times_and_new_speaker_ids(self):
        preview, connector = self.make()
        pcm = b''.join(sample.to_bytes(2, 'little') for sample in range(2240))
        for offset in range(0, len(pcm), 334):  # 167-sample frames cross every 640-sample boundary.
            preview.feed(pcm[offset:offset + 334])
        await eventually(lambda: len(connector.providers) == 4 and connector.providers[-1].samples == 320
                         and len(self.snapshots()) >= 4)
        await preview.finish()
        self.assertFalse(preview.failed)
        self.assertFalse(connector.overlap)
        self.assertEqual([p.samples for p in connector.providers], [640, 640, 640, 320])
        self.assertEqual(b''.join(frame for p in connector.providers for frame in p.sent if frame), pcm)
        self.assertTrue(all(p.sent.count(b'') == 1 and p.closed for p in connector.providers))
        snapshots = self.snapshots()
        self.assertEqual(len({m['preview_id'] for m in snapshots}), 1)
        self.assertEqual([m['revision'] for m in snapshots], sorted({m['revision'] for m in snapshots}))
        self.assertEqual({m['live_window_index'] for m in snapshots}, {0, 1, 2, 3})
        frozen = {}
        speakers = {}
        for message in snapshots:
            window = message['live_window_index']
            self.assertAlmostEqual(message['live_window_start_s'], window * .04)
            rows = message['segments']
            self.assertEqual(len({row['id'] for row in rows}), len(rows))
            self.assertEqual([row['start'] for row in rows], sorted(row['start'] for row in rows))
            for previous in range(window):
                prior = [row for row in rows if row['live_window_index'] == previous]
                if previous in frozen:
                    self.assertEqual(prior, frozen[previous])
                else:
                    frozen[previous] = prior
                self.assertTrue(prior)
                self.assertTrue(all(row['text'].endswith('final') for row in prior))
            for row in rows:
                epoch = row['live_window_index']
                self.assertGreaterEqual(row['start'], epoch * .04)
                self.assertLessEqual(row['end'], (epoch + 1) * .04 + 1e-9)
                if not row['is_draft'] and row['speaker_id'] >= 0:
                    speakers.setdefault(epoch, set()).add(row['speaker_id'])
                    self.assertIn(row['speaker_local_id'], {0, 1})
        for first, values in speakers.items():
            for second, other in speakers.items():
                if first != second:
                    self.assertTrue(values.isdisjoint(other))
        self.assertEqual(preview.pending_bytes, 0)
        self.assertEqual(preview.completed_windows, 4)
        self.assertTrue(preview.window.eof_sent and preview.window.eof_ack)

    async def test_unresolved_final_draft_remains_in_frozen_prefix(self):
        connector = Connector({0: {'draft_at_eof': True}})
        preview, _ = self.make(connector)
        preview.feed(b'\1\0' * 800)
        await eventually(lambda: any(m['live_window_index'] == 1 for m in self.snapshots()))
        await preview.finish()
        next_window = next(m for m in self.snapshots() if m['live_window_index'] == 1)
        draft = [row for row in next_window['segments'] if row['live_window_index'] == 0 and row['is_draft']]
        self.assertEqual(len(draft), 1)
        self.assertEqual(draft[0]['text'], 'synthetic-unconfirmed')
        self.assertEqual(draft[0]['speaker_id'], -1)
        self.assertIsNone(draft[0]['speaker'])

    async def test_exact_threshold_stop_creates_no_empty_next_window(self):
        preview, connector = self.make()
        preview.feed(b'\1\0' * 640)
        await eventually(lambda: connector.providers and connector.providers[0].samples == 640)
        await preview.finish()
        self.assertFalse(preview.failed)
        self.assertEqual(len(connector.providers), 1)
        self.assertEqual(connector.providers[0].sent.count(b''), 1)

    async def test_slow_final_revision_is_delivered_before_next_window(self):
        gate = asyncio.Event()
        connector = Connector({0: {'eof_gate': gate}})
        preview, _ = self.make(connector)
        preview.feed(b'\1\0' * 1280)
        await eventually(lambda: connector.providers and connector.providers[0].eof.is_set())
        self.assertEqual(len(connector.providers), 1)
        self.assertGreater(preview.pending_bytes, 0)
        gate.set()
        await eventually(lambda: len(connector.providers) == 2 and connector.providers[1].samples == 640)
        await preview.finish()
        snapshots = self.snapshots()
        boundary = next(i for i, msg in enumerate(snapshots) if msg['live_window_index'] == 1)
        self.assertTrue(snapshots[boundary - 1]['segments'][0]['text'].endswith('final'))
        self.assertEqual(snapshots[boundary]['segments'][0], snapshots[boundary - 1]['segments'][0])

    async def test_handoff_uses_one_deadline_for_drain_and_admission(self):
        connector = Connector({0: {'eof_delay': .04}, 1: {'config_delay': .04}})
        preview, _ = self.make(connector, timeout=.06)
        preview.feed(b'\1\0' * 1280)
        started = asyncio.get_running_loop().time()
        await asyncio.wait_for(preview.task, .25)
        self.assertTrue(preview.failed)
        self.assertLess(asyncio.get_running_loop().time() - started, .2)
        self.assertEqual(len(connector.providers), 2)
        self.assertEqual(connector.providers[1].sent, [])
        self.assertEqual(preview.pending_bytes, 0)
        self.assertTrue(connector.providers[1].closed or connector.providers[1].aborted)

    async def test_next_config_gate_preserves_all_buffered_pcm(self):
        gate = asyncio.Event()
        connector = Connector({1: {'config_gate': gate}})
        preview, _ = self.make(connector)
        first, second = b'\1\0' * 640, b'\2\0' * 800
        preview.feed(first + second)
        await eventually(lambda: len(connector.providers) == 2 and connector.providers[1].entered)
        self.assertEqual(connector.providers[1].sent, [])
        self.assertGreater(preview.pending_bytes, 0)
        gate.set()
        await eventually(lambda: sum(p.samples for p in connector.providers) == 1440)
        await preview.finish()
        self.assertFalse(preview.failed)
        self.assertEqual(b''.join(frame for p in connector.providers for frame in p.sent if frame), first + second)

    async def test_stop_during_handoff_drains_buffer_once(self):
        gate = asyncio.Event()
        connector = Connector({0: {'eof_gate': gate}})
        preview, _ = self.make(connector)
        pcm = b'\1\0' * 800
        preview.feed(pcm)
        await eventually(lambda: connector.providers and connector.providers[0].eof.is_set())
        stopping = asyncio.create_task(preview.finish())
        await asyncio.sleep(.005)
        gate.set()
        await asyncio.wait_for(stopping, .5)
        self.assertFalse(preview.failed)
        self.assertEqual([p.samples for p in connector.providers], [640, 160])
        self.assertEqual(b''.join(frame for p in connector.providers for frame in p.sent if frame), pcm)
        self.assertEqual(preview.pending_bytes, 0)

    async def test_cancel_during_admission_releases_tasks_and_queue(self):
        gate = asyncio.Event()
        connector = Connector({1: {'config_gate': gate}})
        preview, _ = self.make(connector)
        preview.feed(b'\1\0' * 1280)
        await eventually(lambda: len(connector.providers) == 2 and connector.providers[1].entered)
        preview.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(preview.task, .2)
        self.assertFalse(preview.accepting)
        self.assertEqual(preview.pending_bytes, 0)
        self.assertEqual(connector.providers[1].sent, [])
        self.assertTrue(connector.providers[1].closed or connector.providers[1].aborted)

    async def test_stream_error_does_not_replay_or_rotate(self):
        connector = Connector({0: {'fail_after_audio': True}})
        preview, _ = self.make(connector)
        pcm = b'\1\0' * 160
        preview.feed(pcm)
        await asyncio.wait_for(preview.task, .3)
        self.assertTrue(preview.failed)
        self.assertEqual(len(connector.providers), 1)
        self.assertEqual(connector.providers[0].sent.count(pcm), 1)
        self.assertEqual(preview.pending_bytes, 0)

    async def test_missing_eof_ack_fails_without_admitting_next_window(self):
        connector = Connector({0: {'eof_gate': asyncio.Event()}})
        preview, _ = self.make(connector, timeout=.025)
        preview.feed(b'\1\0' * 800)
        await asyncio.wait_for(preview.task, .3)
        self.assertTrue(preview.failed)
        self.assertEqual(len(connector.providers), 1)
        self.assertEqual(connector.providers[0].samples, 640)
        self.assertEqual(preview.completed_windows, 0)
        self.assertFalse(preview.window.eof_ack)
        self.assertEqual(preview.pending_bytes, 0)

    async def test_early_eof_ack_cannot_be_successful_rotation(self):
        preview, connector = self.make(Connector({0: {'early_ack': True}}))
        preview.feed(b'\1\0' * 160)
        await asyncio.wait_for(preview.task, .3)
        self.assertTrue(preview.failed)
        self.assertEqual(len(connector.providers), 1)
        self.assertEqual(preview.completed_windows, 0)

    async def test_snapshot_before_send_returns_uses_offered_audio_duration(self):
        gate = asyncio.Event()
        preview, _ = self.make(Connector({0: {'audio_send_gate': gate}}))
        preview.feed(b'\1\0' * 160)
        await eventually(lambda: bool(self.snapshots()))
        self.assertFalse(preview.failed)
        self.assertEqual(preview.window.sent_bytes, 0)
        self.assertEqual(self.snapshots()[-1]['segments'][-1]['end'], .01)
        gate.set()
        await preview.finish()
        self.assertFalse(preview.failed)
        self.assertEqual(preview.window.sent_bytes, 320)

    async def test_early_ack_on_later_window_does_not_reuse_prior_success(self):
        preview, connector = self.make(Connector({1: {'early_ack': True}}))
        preview.feed(b'\1\0' * 800)
        await asyncio.wait_for(preview.task, .3)
        self.assertTrue(preview.failed)
        self.assertEqual(len(connector.providers), 2)
        self.assertEqual(preview.completed_windows, 1)
        self.assertFalse(preview.window.eof_ack)

    async def test_missing_ack_on_later_window_does_not_reuse_prior_success(self):
        preview, connector = self.make(Connector({1: {'eof_gate': asyncio.Event()}}), timeout=.025)
        preview.feed(b'\1\0' * 1440)
        await asyncio.wait_for(preview.task, .3)
        self.assertTrue(preview.failed)
        self.assertEqual(len(connector.providers), 2)
        self.assertEqual(preview.completed_windows, 1)
        self.assertFalse(preview.window.eof_ack)
        self.assertEqual(preview.pending_bytes, 0)

    async def test_capacity_cancel_before_task_starts_releases_pending_pcm(self):
        preview, connector = self.make()
        preview.MAX_PENDING_BYTES = 4
        preview.feed(b'\1\0' * 2)
        preview.feed(b'\2\0')
        await asyncio.gather(preview.task, return_exceptions=True)
        await asyncio.sleep(0)  # Task done callbacks also run when _run never starts.
        self.assertTrue(preview.failed)
        self.assertEqual(preview.pending_bytes, 0)
        self.assertTrue(preview.queue.empty())
        self.assertEqual(connector.providers, [])

    async def test_malformed_next_config_preserves_prior_history_and_fails_once(self):
        connector = Connector({1: {'config': {'type': 'config', 'useAudioWorklet': False}}})
        preview, _ = self.make(connector)
        preview.feed(b'\1\0' * 1280)
        await asyncio.wait_for(preview.task, .3)
        if preview.failure_status_task:
            await preview.failure_status_task
        self.assertTrue(preview.failed)
        self.assertEqual(connector.providers[1].sent, [])
        self.assertTrue(self.snapshots()[-1]['segments'][0]['text'].endswith('final'))
        failed = [e for e in self.events if e.get('status') == 'stt_failed']
        self.assertEqual(len(failed), 1)

    async def test_single_wav_survives_three_rotations_and_finalize_is_explicit(self):
        capture_class, feed = capture_contract()
        preview, connector = self.make()
        with tempfile.TemporaryDirectory() as directory:
            capture = capture_class(session_id=str(uuid.uuid4()), input_codec='opus_fs320',
                                    source='omi', root=Path(directory))
            owner = SimpleNamespace(capture_sink=capture, local_preview=preview)
            pcm = b'\1\0\2\0' * 1120
            try:
                for offset in range(0, len(pcm), 334):
                    chunk = pcm[offset:offset + 334]
                    feed(owner, encoded_bytes=len(chunk), pcm=chunk)
                await eventually(lambda: len(connector.providers) == 4 and connector.providers[-1].samples == 320)
                self.assertFalse(capture.wav_path.exists())
                self.assertTrue(capture.metadata_part_path.exists())
                self.assertEqual(capture.pcm_part_path.read_bytes(), pcm)
                self.assertEqual(len(list(Path(directory).glob('listen-captures/*'))), 1)
                await preview.finish()
                self.assertFalse(capture.wav_path.exists())
            finally:
                metadata = capture.finalize()
            with wave.open(str(capture.wav_path)) as wav:
                self.assertEqual(wav.readframes(wav.getnframes()), pcm)
            self.assertEqual(metadata['decoded_pcm_bytes'], len(pcm))
            self.assertEqual(metadata['decode_errors'], 0)

    async def test_capacity_failure_preserves_wav_using_actual_capture_delivery(self):
        capture_class, feed = capture_contract()
        preview, _ = self.make(Connector({0: {'config_gate': asyncio.Event()}}))
        preview.MAX_PENDING_BYTES = 4
        with tempfile.TemporaryDirectory() as directory:
            capture = capture_class(session_id=str(uuid.uuid4()), input_codec='opus_fs320',
                                    source='omi', root=Path(directory))
            owner = SimpleNamespace(capture_sink=capture, local_preview=preview)
            try:
                for pcm in [b'\1\0\2\0', b'\3\0', b'\4\0']:
                    feed(owner, encoded_bytes=len(pcm), pcm=pcm)
                await asyncio.gather(preview.task, return_exceptions=True)
            finally:
                capture.finalize()
            with wave.open(str(capture.wav_path)) as wav:
                self.assertEqual(wav.readframes(wav.getnframes()), b'\1\0\2\0\3\0\4\0')
        self.assertTrue(preview.failed)
        self.assertFalse(preview.accepting)


if __name__ == '__main__':
    unittest.main()
