import contextlib
import copy
import importlib.machinery
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

loader = importlib.machinery.SourceFileLoader('qwen_modes', str(Path(__file__).with_name('qwen-switch')))
spec = importlib.util.spec_from_loader(loader.name, loader)
q = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = q
loader.exec_module(q)


def state(running, restart='unless-stopped', cmd=None):
    return {'state': {'Running': running, 'Status': 'running' if running else 'exited'},
            'restart': {'Name': restart, 'MaximumRetryCount': 0}, 'cmd': cmd or []}


def snapshot(active='small', audio=True):
    values = {m.key: state(m.key == active, 'unless-stopped' if m.key == active else 'no') for m in q.MODELS}
    values.update({s.key: state(audio, 'unless-stopped' if audio else 'no') for s in q.AUDIO})
    values['wlk']['cmd'] = ['--diarization', '--diarization-backend', 'sortformer']
    values[q.FILE_DIARIZATION.key] = state(False, 'no')
    return values


class WorkloadTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.stack.enter_context(patch.object(q, 'locked', contextlib.nullcontext))
        self.real_guard_disk = q.guard_disk
        self.stack.enter_context(patch.object(q, 'guard_disk'))
        self.preflight = self.stack.enter_context(patch.object(q, 'preflight'))
        self.values = snapshot()
        self.stack.enter_context(patch.object(q, 'inspect', side_effect=lambda m: copy.deepcopy(self.values.get(m.key))))
        self.idle = self.stack.enter_context(patch.object(q, 'ensure_idle'))
        self.run = self.stack.enter_context(patch.object(q, 'run', side_effect=self.fake_run))
        self.policy = self.stack.enter_context(patch.object(q, 'set_restart'))
        self.switch = self.stack.enter_context(patch.object(q, 'switch_to', side_effect=self.fake_switch))
        self.stack.enter_context(patch.object(q, 'wait_audio'))
        self.stack.enter_context(patch.object(q, 'wait_ready'))
        self.file_ready = self.stack.enter_context(patch.object(q, 'wait_file_diarization'))
        self.file_health = self.stack.enter_context(patch.object(q, 'file_diarization_health', return_value={
            'service': 'pyannote-diarization', 'status': 'ok', 'ready': True,
            'device': 'cuda:0', 'concurrency': 1, 'maxQueued': 1,
        }))
        self.stack.enter_context(patch.object(q, 'live_connections', return_value=0))
        self.stack.enter_context(patch.object(q.time, 'sleep'))
        self.stack.enter_context(patch.object(q.subprocess, 'run', side_effect=AssertionError('Unexpected real subprocess')))
        self.stack.enter_context(patch.object(q.OPENER, 'open', side_effect=AssertionError('Unexpected network probe')))

    def fake_run(self, *args, **kwargs):
        if args[:2] == ('docker', 'info'):
            return Mock(stdout='fake-docker\n', returncode=0)
        if args[:2] == ('nvidia-smi', '--query-gpu=memory.free'):
            return Mock(stdout='10000\n', returncode=0)
        if args[:2] in (('docker', 'start'), ('docker', 'stop')):
            for service in (*q.MODELS, *q.AUDIO, q.FILE_DIARIZATION):
                if service.container in args[2:] and self.values.get(service.key):
                    running = args[1] == 'start'
                    self.values[service.key]['state'].update(Running=running, Status='running' if running else 'exited')
            return Mock(stdout='', returncode=0)
        raise AssertionError('Unexpected command: ' + repr(args))

    def fake_switch(self, target, *args, **kwargs):
        for model in q.MODELS:
            self.values[model.key]['state'].update(Running=model == target, Status='running' if model == target else 'exited')

    def configure_big_audio(self):
        self.values['wlk'].update(env={'CUDA_VISIBLE_DEVICES': '', 'NVIDIA_VISIBLE_DEVICES': 'void'}, devices=[])
        self.values[q.FILE_DIARIZATION.key]['env'] = {
            'DIARIZATION_SEGMENTATION_BATCH_SIZE': '8',
            'DIARIZATION_EMBEDDING_BATCH_SIZE': '8',
            'DIARIZATION_SEGMENT_EMBEDDING_BATCH_SIZE': '4',
        }

    def test_preflight_failure_never_changes_audio_or_models(self):
        self.preflight.side_effect = RuntimeError('missing model')
        with self.assertRaisesRegex(RuntimeError, 'missing model'):
            q.switch_workload('big')
        self.run.assert_not_called()
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_busy_llm_blocks_before_stopping_audio(self):
        self.idle.side_effect = RuntimeError('processing request')
        with self.assertRaisesRegex(RuntimeError, 'processing'):
            q.switch_workload('big')
        self.run.assert_not_called()
        self.policy.assert_not_called()

    def test_dry_run_preserves_restart_policies_and_running_state(self):
        for mode in ('audio', 'big', 'big-asr'):
            q.switch_workload(mode, dry_run=True)
        self.run.assert_not_called()
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_missing_diarization_is_rejected_without_mutation(self):
        self.values['wlk']['cmd'] = ['--pcm-input']
        with self.assertRaisesRegex(RuntimeError, 'Sortformer'):
            q.switch_workload('audio')
        self.run.assert_not_called()
        self.policy.assert_not_called()

    def test_big_frees_audio_before_loading_and_changes_only_allowed_containers(self):
        events = []
        def command(*args, **kwargs):
            events.append(args)
            return self.fake_run(*args, **kwargs)
        self.run.side_effect = command
        self.switch.side_effect = lambda *args, **kw: events.append(('load-model', args[0].key))
        q.switch_workload('big')
        stops = [('docker', 'stop', '--timeout=-1', s.container) for s in reversed(q.AUDIO)]
        self.assertEqual(events[:len(stops)], stops)
        self.assertLess(events.index(stops[-1]), events.index(('load-model', 'uncensored')))
        allowed = {s.container for s in (*q.MODELS, *q.AUDIO)}
        self.assertTrue(all(call.args[0].container in allowed for call in self.policy.call_args_list))
        for service in q.AUDIO:
            self.policy.assert_any_call(service, 'no')

    def test_audio_failure_restores_the_complete_prior_workload(self):
        self.values = snapshot('uncensored', audio=False)
        self.run.side_effect = RuntimeError('audio start failed')
        with patch.object(q, 'restore_workload') as restore:
            with self.assertRaisesRegex(RuntimeError, 'audio start failed'):
                q.switch_workload('audio')
        models, audio, timeout = restore.call_args.args
        self.assertTrue(models['uncensored']['state']['Running'])
        self.assertFalse(models['small']['state']['Running'])
        self.assertTrue(all(not s['state']['Running'] and s['restart']['Name'] == 'no' for s in audio.values()))

    def test_big_asr_keeps_whisper_and_api_running_and_stops_only_live_stack(self):
        q.switch_workload('big-asr')
        stops = [call.args for call in self.run.call_args_list if call.args[:2] == ('docker', 'stop')]
        self.assertEqual(stops, [('docker', 'stop', '--timeout=-1', s.container) for s in reversed(q.AUDIO[2:])])
        self.switch.assert_called_once_with(q.resolve('u32asr'), False, 180, False, lock_held=True)
        for service in q.AUDIO[:2]:
            self.policy.assert_any_call(service, 'unless-stopped')
            self.assertNotIn(unittest.mock.call(service, 'no'), self.policy.call_args_list)
            self.assertNotIn(unittest.mock.call('docker', 'start', service.container), self.run.call_args_list)

    def test_failed_transition_from_big_asr_preserves_asr_only_snapshot(self):
        self.values = snapshot('uncensored-asr', audio=False)
        for key in ('whisper', 'stt-proxy'):
            self.values[key] = state(True)
        self.run.side_effect = RuntimeError('live proxy failed')
        with patch.object(q, 'restore_workload') as restore:
            with self.assertRaisesRegex(RuntimeError, 'live proxy failed'):
                q.switch_workload('audio')
        models, audio, timeout = restore.call_args.args
        self.assertTrue(models['uncensored-asr']['state']['Running'])
        self.assertEqual({key for key, value in audio.items() if value['state']['Running']}, {'whisper', 'stt-proxy'})

    def test_big_asr_cli_and_profile_alias_choose_asr_workload(self):
        with patch.object(q, 'switch_workload') as mode:
            q.main(['big-asr'])
            self.assertEqual(mode.call_args.args, ('big-asr',))
            q.main(['u32asr'])
            self.assertEqual(mode.call_args.args[:2], ('big-asr', q.resolve('u32asr')))
        with self.assertRaises(SystemExit):
            q.main(['big-asr', 'u128'])

    def test_big_audio_cli_chooses_all_audio_with_32k_profile(self):
        with patch.object(q, 'switch_workload') as mode:
            q.main(['big-audio', '--dry-run'])
            mode.assert_called_once_with('big-audio', force=False, timeout=180, dry_run=True)

    def test_big_audio_requires_cpu_only_live_placement_before_any_mutation(self):
        self.configure_big_audio()
        for env, devices in (({}, []), ({'CUDA_VISIBLE_DEVICES': '0', 'NVIDIA_VISIBLE_DEVICES': 'all'}, []),
                             ({'CUDA_VISIBLE_DEVICES': '', 'NVIDIA_VISIBLE_DEVICES': 'void'}, [{'Capabilities': [['gpu']]}])):
            with self.subTest(env=env, devices=devices):
                self.values['wlk'].update(env=env, devices=devices)
                with self.assertRaisesRegex(RuntimeError, 'CPU-only WLK'):
                    q.switch_workload('big-audio')
                self.run.assert_not_called()
                self.policy.assert_not_called()
                self.switch.assert_not_called()

    def test_big_audio_requires_existing_bounded_file_batches_before_mutation(self):
        self.configure_big_audio()
        valid = copy.deepcopy(self.values[q.FILE_DIARIZATION.key])
        for value in (None, state(False), {**valid, 'env': {**valid['env'], 'DIARIZATION_SEGMENTATION_BATCH_SIZE': '9'}},
                      {**valid, 'env': {**valid['env'], 'DIARIZATION_EMBEDDING_BATCH_SIZE': '9'}},
                      {**valid, 'env': {**valid['env'], 'DIARIZATION_SEGMENT_EMBEDDING_BATCH_SIZE': '5'}},
                      {**valid, 'env': {**valid['env'], 'DIARIZATION_REQUEST_CONCURRENCY': '2'}},
                      {**valid, 'env': {**valid['env'], 'DIARIZATION_MAX_QUEUED_REQUESTS': '2'}},
                      {**valid, 'env': {**valid['env'], 'DIARIZATION_EMBEDDING_BATCH_SIZE': 'bad'}}):
            with self.subTest(file=value):
                self.values[q.FILE_DIARIZATION.key] = value
                with self.assertRaisesRegex(RuntimeError, 'bounded batches'):
                    q.switch_workload('big-audio')
                self.run.assert_not_called()
                self.policy.assert_not_called()
                self.switch.assert_not_called()

    def test_big_audio_checks_running_file_gate_health_before_any_mutation(self):
        self.values = snapshot('uncensored-asr', audio=True)
        self.configure_big_audio()
        self.values[q.FILE_DIARIZATION.key]['state'].update(Running=True, Status='running')
        valid = dict(self.file_health.return_value)
        for health in (None, {**valid, 'concurrency': 2}, {**valid, 'maxQueued': 2},
                       {**valid, 'concurrency': True}, {**valid, 'maxQueued': '1'}):
            with self.subTest(health=health):
                self.file_health.return_value = health
                with self.assertRaises(RuntimeError):
                    q.switch_workload('big-audio')
                self.run.assert_not_called()
                self.policy.assert_not_called()
                self.switch.assert_not_called()

    def test_big_audio_starts_one_canonical_file_service_and_preserves_running_audio(self):
        self.values = snapshot('uncensored-asr', audio=True)
        self.configure_big_audio()
        q.switch_workload('big-audio')
        mutations = [c.args for c in self.run.call_args_list if c.args[:2] in (('docker', 'start'), ('docker', 'stop'))]
        self.assertEqual(mutations, [('docker', 'start', 'sky-diarization-candidate-diarization-1-1')])
        self.switch.assert_called_once_with(q.resolve('u32asr'), False, 180, False, lock_held=True)
        self.idle.assert_not_called()
        self.file_ready.assert_called_once_with(180)
        self.assertTrue(all(self.values[s.key]['state']['Running'] for s in q.AUDIO))

    def test_interrupted_drain_after_live_stop_does_not_restart_services_or_load_qwen(self):
        for interruption in (subprocess.TimeoutExpired('docker stop', 3), KeyboardInterrupt()):
            with self.subTest(interruption=type(interruption).__name__):
                self.values = snapshot()
                self.run.reset_mock()

                def command(*args, **kwargs):
                    if args[:2] == ('docker', 'stop') and q.AUDIO[-2].container in args:
                        raise interruption
                    return self.fake_run(*args, **kwargs)

                self.run.side_effect = command
                with self.assertRaisesRegex(q.DrainInProgress, 'still stopping/draining'):
                    q.switch_workload('big-asr', timeout=3)
                mutations = [c.args for c in self.run.call_args_list if c.args[:2] in (('docker', 'start'), ('docker', 'stop'), ('docker', 'kill'))]
                self.assertEqual(mutations, [('docker', 'stop', '--timeout=-1', s.container) for s in reversed(q.AUDIO[2:])])
                self.switch.assert_not_called()
                self.assertFalse(self.values['wlk']['state']['Running'])

    def test_big_audio_file_readiness_failure_rolls_back_only_new_file_service(self):
        self.values = snapshot('uncensored-asr', audio=True)
        self.configure_big_audio()
        self.file_ready.side_effect = RuntimeError('file readiness failed')
        with self.assertRaisesRegex(RuntimeError, 'file readiness failed'):
            q.switch_workload('big-audio')
        mutations = [c.args for c in self.run.call_args_list if c.args[:2] in (('docker', 'start'), ('docker', 'stop'))]
        self.assertEqual(mutations, [('docker', 'start', q.FILE_DIARIZATION.container),
                                     ('docker', 'stop', '--timeout=-1', q.FILE_DIARIZATION.container)])
        self.assertFalse(self.values[q.FILE_DIARIZATION.key]['state']['Running'])
        self.assertTrue(all(self.values[s.key]['state']['Running'] for s in q.AUDIO))

    def test_rollback_frees_audio_and_new_small_before_restoring_large_model(self):
        original = snapshot('uncensored', audio=False)
        with patch.object(q, 'wait_ready'):
            q.restore_workload({m.key: original[m.key] for m in q.MODELS},
                               {s.key: original[s.key] for s in q.AUDIO}, 180)
        calls = [c.args for c in self.run.call_args_list]
        big_start = calls.index(('docker', 'start', q.resolve('u64').container))
        small_stop = calls.index(('docker', 'stop', '-t', '30', q.resolve('small').container))
        self.assertLess(small_stop, big_start)
        self.assertEqual(calls[:len(q.AUDIO)], [('docker', 'stop', '--timeout=-1', s.container) for s in reversed(q.AUDIO)])
        for s in q.AUDIO:
            self.policy.assert_any_call(s, 'no')

    def test_model_aliases_use_matching_workload_and_preserve_alternate_big_profile(self):
        with patch.object(q, 'switch_workload') as mode:
            q.main(['small'])
            self.assertEqual(mode.call_args.args[:2], ('audio', q.resolve('small')))
            q.main(['u128'])
            self.assertEqual(mode.call_args.args[:2], ('big', q.resolve('u128')))
            q.main(['big', 'u64cpu', '--dry-run'])
            self.assertEqual(mode.call_args.args[:2], ('big', q.resolve('u64cpu')))
            self.assertTrue(mode.call_args.args[4])

    def test_wrong_disk_is_rejected(self):
        # Exercise the real guard separately from the mocked workload fixture.
        self.run.side_effect = None
        self.run.return_value = Mock(stdout='wrong-disk\n')
        with self.assertRaisesRegex(RuntimeError, 'Expected writable'):
            self.real_guard_disk()


if __name__ == '__main__':
    unittest.main()
