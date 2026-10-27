"""Critical privacy and failure-semantics contracts for preview diagnostics.

These run against the retained r5 base via test_rotation's existing fixture or
against the installed image. Providers are in-memory fakes: no audio/network I/O.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

import test_rotation as contract


SPEECH = 'synthetic private transcript CANARY_SPEECH_8391'
SECRET = 'CANARY_KEY_58df0'
URL = f'https://user:{SECRET}@provider.invalid/asr?token={SECRET}'
PRIVATE = f'{SPEECH}; {URL}'


class SnapshotProvider(contract.Provider):
    def __init__(self, snapshot):
        super().__init__(0)
        self.injected_snapshot = snapshot

    def snapshot(self, final=False):
        return deepcopy(self.injected_snapshot)


class MalformedProvider(contract.Provider):
    async def send(self, pcm):
        if pcm:
            self.sent.append(pcm)
            self.samples += len(pcm) // 2
            self.incoming.put_nowait('{"unclosed": "' + PRIVATE)
            await asyncio.sleep(0)
        else:
            await super().send(pcm)


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previews = []

    async def asyncTearDown(self):
        for preview in self.previews:
            if not preview.task.done():
                preview.task.cancel()
            await asyncio.gather(preview.task, return_exceptions=True)
            if preview.failure_status_task:
                await asyncio.gather(preview.failure_status_task, return_exceptions=True)

    async def failure(self, provider, *, capture_logs=True):
        events = []
        calls = []

        async def receive(message):
            events.append(deepcopy(message))

        def connect(*_, **__):
            calls.append(True)
            return provider

        async def exercise():
            preview = contract.preview_types()('ws://127.0.0.1:21004/asr', receive,
                rotation_seconds=1800, connector=connect)
            self.previews.append(preview)
            preview.feed(b'\0\0' * 16000)
            await asyncio.wait_for(preview.task, .5)
            if preview.failure_status_task:
                await preview.failure_status_task
            # Repeated failure notifications must remain idempotent, including
            # after resource cleanup and the ordinary capture finish path.
            preview._fail('other')
            await preview.finish()
            self.assertTrue(preview.failed)
            self.assertFalse(preview.accepting)
            self.assertEqual(preview.pending_bytes, 0)
            self.assertEqual(len(calls), 1)  # Diagnostics must not introduce retries.
            self.assertTrue(provider.closed or provider.aborted)
            failures = [event for event in events if event.get('status') == 'stt_failed']
            self.assertEqual(len(failures), 1)
            self.assertIs(failures[0]['retryable'], False)
            self.assertFalse(any(event.get('type') == 'local_transcript_snapshot' for event in events))
            return failures[0]

        if not capture_logs:
            return await exercise(), None
        with self.assertLogs(contract.rotation.logger, level='WARNING') as logs:
            public_status = await exercise()
        records = [record for record in logs.records if record.msg == 'Local preview failure %s']
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertIsNone(record.exc_info)
        self.assertIsNone(record.stack_info)
        payload = json.loads(record.args[0])
        self.assertEqual(payload['event'], 'local_preview_failure')
        rendered = '\n'.join(logs.output)
        for private in (SPEECH, SECRET, URL, 'provider.invalid', 'token=', '"unclosed"'):
            self.assertNotIn(private, rendered)
        for frame in payload['traceback']:
            self.assertEqual(set(frame), {'file', 'line', 'function'})
            self.assertNotIn('/', frame['file'])
            self.assertIs(type(frame['line']), int)
        return public_status, payload

    async def test_exception_messages_and_close_reasons_are_redacted_without_reclassification(self):
        cases = [
            (RuntimeError(PRIVATE), 'unexpected_exception', 'protocol_error', 'other'),
            (TimeoutError(PRIVATE), 'timeout', 'unavailable', 'timeout'),
            (OSError(PRIVATE), 'unexpected_exception', 'unavailable', 'other'),
            (ConnectionClosedError(Close(1008, PRIVATE), None), 'connection_closed', 'unavailable', 'other'),
        ]
        for error, reason, status, fallback in cases:
            with self.subTest(exception=type(error).__name__):
                public, diagnostic = await self.failure(contract.Provider(0, config=error))
                self.assertEqual(public['reason'], status)
                self.assertEqual(diagnostic['reason'], reason)
                self.assertEqual(diagnostic['exception_class'], type(error).__name__)
                self.assertEqual(diagnostic['status_reason'], status)
                self.assertEqual(diagnostic['fallback_reason'], fallback)
                self.assertTrue(diagnostic['traceback'])
                if isinstance(error, ConnectionClosedError):
                    self.assertEqual(diagnostic['close_code'], 1008)

    async def test_timestamp_failures_have_numeric_context_and_keep_original_rejection(self):
        cases = [
            ('regressive', [(.5, .7), (.4, .6)], 'unordered_timestamps',
             {'row_index': 1, 'previous_row_index': 0, 'previous_start': .5,
              'start': .4, 'end': .6, 'start_delta': -.1, 'invalid_field': 'ordering'}),
            ('future', [(.2, 1.25)], 'invalid_timestamp',
             {'row_index': 0, 'start': .2, 'end': 1.25, 'beyond_audio_seconds': .25, 'invalid_field': 'end'}),
            ('reversed', [(.7, .6)], 'unordered_timestamps',
             {'row_index': 0, 'start': .7, 'end': .6, 'invalid_field': 'end_before_start'}),
        ]
        for name, spans, reason, expected in cases:
            with self.subTest(case=name):
                snapshot = {'lines': [{'start': start, 'end': end, 'speaker': 1, 'text': PRIVATE}
                                      for start, end in spans],
                            'buffer_transcription': PRIVATE, 'buffer_diarization': ''}
                public, diagnostic = await self.failure(SnapshotProvider(snapshot))
                self.assertEqual(public['reason'], 'protocol_error')
                self.assertEqual(diagnostic['reason'], reason)
                self.assertEqual(diagnostic['exception_class'], 'ValueError')
                self.assertEqual(diagnostic['window_index'], 0)
                self.assertEqual(diagnostic['offered_bytes'], 32000)
                self.assertFalse(diagnostic['eof_sent'])
                self.assertFalse(diagnostic['eof_ack'])
                context = diagnostic['projection']
                self.assertEqual(context['audio_seconds'], 1)
                self.assertEqual(context['line_count'], len(spans))
                for key, value in expected.items():
                    if isinstance(value, float):
                        self.assertAlmostEqual(context[key], value)
                    else:
                        self.assertEqual(context[key], value)
                self.assertTrue(all(value is None or type(value) in (int, float)
                                    for key, value in context.items() if key != 'invalid_field'))

    async def test_malformed_wire_json_and_secret_timestamp_never_escape_to_logs(self):
        public, diagnostic = await self.failure(MalformedProvider(0))
        self.assertEqual(public['reason'], 'protocol_error')
        self.assertEqual(diagnostic['reason'], 'invalid_json')
        self.assertEqual(diagnostic['exception_class'], 'JSONDecodeError')
        snapshot = {'lines': [{'start': URL, 'end': .8, 'speaker': 1, 'text': SPEECH}],
                    'buffer_transcription': SECRET, 'buffer_diarization': ''}
        public, diagnostic = await self.failure(SnapshotProvider(snapshot))
        self.assertEqual(public['reason'], 'protocol_error')
        self.assertEqual(diagnostic['reason'], 'invalid_timestamp')
        self.assertIsNone(diagnostic['projection']['start'])
        self.assertEqual(diagnostic['projection']['invalid_field'], 'start')

    async def test_provider_failure_keeps_only_opaque_ids_and_known_code(self):
        request_id = 'a4c789df-a629-481c-b59a-39b210424fe4'
        session_id = '82a690e7-9301-4ac1-a737-6d02c5e720c7'
        frame = {'type': 'error', 'code': 'upstream_timeout', 'request_id': request_id,
                 'session_id': session_id, 'upstream_status': 504,
                 'error': PRIVATE, 'url': URL, 'capture_id': PRIVATE}
        public, diagnostic = await self.failure(SnapshotProvider(frame))
        self.assertEqual(public['reason'], 'protocol_error')
        self.assertEqual(diagnostic['reason'], 'provider_error')
        self.assertEqual(diagnostic['provider'], {'request_id': request_id, 'session_id': session_id,
                                                 'code': 'upstream_timeout', 'upstream_status': 504})
        self.assertRegex(diagnostic['capture_id'], r'^[0-9a-f-]{36}$')

    def test_provider_diagnostic_fields_reject_objects_and_unbounded_values(self):
        self.assertEqual(contract.rotation._provider_details({
            'code': {'secret': PRIVATE}, 'upstream_status': True,
            'request_id': PRIVATE * 1000, 'session_id': 123,
        }), {})

    async def test_logging_failure_cannot_prevent_existing_offline_fallback(self):
        with patch.object(contract.rotation.logger, 'warning', side_effect=RuntimeError(PRIVATE)):
            public, _ = await self.failure(contract.Provider(0, config=ValueError(PRIVATE)), capture_logs=False)
        self.assertEqual(public['reason'], 'protocol_error')


if __name__ == '__main__':
    unittest.main()
