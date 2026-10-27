"""Safety contracts for the selector's live/file controls; no live operations."""

import contextlib
import copy
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, call, patch


SOURCE = Path(__file__).resolve().parents[1] / "qwen-switch"
loader = importlib.machinery.SourceFileLoader("qwen_controls_under_test", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
q = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = q
loader.exec_module(q)


def state(running=False, cmd=()):
    return {"state": {"Running": running, "Status": "running" if running else "exited"},
            "restart": {"Name": "unless-stopped" if running else "no", "MaximumRetryCount": 0},
            "cmd": list(cmd), "networks": {"private": {"IPAddress": "172.30.0.5"}}}


READY = {"service": "pyannote-diarization", "status": "ok", "ready": True,
         "device": "cuda:0", "inflight": 0, "queued": 0, "concurrency": 1, "maxQueued": 1}
CPU_ONLY = {"CUDA_VISIBLE_DEVICES": "", "NVIDIA_VISIBLE_DEVICES": "void"}
BOUNDED_BATCHES = {"DIARIZATION_SEGMENTATION_BATCH_SIZE": "8",
                   "DIARIZATION_EMBEDDING_BATCH_SIZE": "8",
                   "DIARIZATION_SEGMENT_EMBEDDING_BATCH_SIZE": "4"}


class ControlsTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.stack.enter_context(patch.object(q, "locked", contextlib.nullcontext))
        self.guard = self.stack.enter_context(patch.object(q, "guard_disk"))
        self.preflight = self.stack.enter_context(patch.object(q, "preflight"))
        self.idle = self.stack.enter_context(patch.object(q, "ensure_idle"))
        self.policy = self.stack.enter_context(patch.object(q, "set_restart"))
        self.switch = self.stack.enter_context(patch.object(q, "switch_to"))
        self.wait_audio = self.stack.enter_context(patch.object(q, "wait_audio"))
        self.sleep = self.stack.enter_context(patch.object(q.time, "sleep"))
        self.connections = self.stack.enter_context(patch.object(q, "live_connections", return_value=0))
        self.values = {m.key: state(m.key == "small") for m in q.MODELS}
        self.values.update({s.key: state(True) for s in q.AUDIO})
        self.values["wlk"]["cmd"] = ["--diarization", "--diarization-backend", "sortformer"]
        self.values[q.FILE_DIARIZATION.key] = state(False)
        self.inspector = self.stack.enter_context(patch.object(q, "inspect", side_effect=lambda m: copy.deepcopy(self.values.get(m.key))))
        self.port_owners = []
        self.active_names = [q.resolve("small").container]
        self.free_mib = "10000\n"
        self.run = self.stack.enter_context(patch.object(q, "run", side_effect=self.fake_run))
        self.real_health = q.file_diarization_health
        self.health = self.stack.enter_context(patch.object(q, "file_diarization_health", return_value=dict(READY)))
        self.real_wait = q.wait_file_diarization
        self.wait = self.stack.enter_context(patch.object(q, "wait_file_diarization"))
        # An accidental escape from the fakes must fail, never run locally.
        self.stack.enter_context(patch.object(q.subprocess, "run", side_effect=AssertionError("Unexpected real subprocess")))
        self.open = self.stack.enter_context(patch.object(q.OPENER, "open", side_effect=AssertionError("Unexpected network probe")))

    def fake_run(self, *args, **kwargs):
        if args[:2] == ("docker", "info"):
            return Mock(stdout="fake-docker\n", returncode=0)
        if args[:2] == ("docker", "ps"):
            names = self.port_owners if "publish=8085" in args else self.active_names
            return Mock(stdout="\n".join(names), returncode=0)
        if args[:2] == ("nvidia-smi", "--query-gpu=memory.free"):
            return Mock(stdout=self.free_mib, returncode=0)
        if args[:2] in (("docker", "start"), ("docker", "stop")):
            for service in (*q.MODELS, *q.AUDIO, q.FILE_DIARIZATION):
                if service.container in args[2:] and self.values.get(service.key):
                    running = args[1] == "start"
                    self.values[service.key]["state"].update(Running=running, Status="running" if running else "exited")
            return Mock(stdout="", returncode=0)
        raise AssertionError("Unexpected command: " + repr(args))

    def mutations(self):
        verbs = {"start", "stop", "restart", "update", "run", "compose", "rm", "kill"}
        return [c for c in self.run.call_args_list if len(c.args) > 1 and c.args[0] == "docker" and c.args[1] in verbs]

    def assert_no_mutations(self):
        self.assertEqual(self.mutations(), [])
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_readonly_dispatch_never_switches_or_controls_containers(self):
        cases = [(["status"], "status"), (["list"], "status"), (["memory"], "memory"),
                 (["processes"], "processes"), (["diarization"], "diarization"),
                 (["diarization", "status"], "diarization"),
                 (["diarization", "live", "status"], "diarization"),
                 (["diarization", "file", "status"], "diarization")]
        with patch.object(q, "show_status") as status, patch.object(q, "show_resources") as resources, \
                patch.object(q, "show_diarization") as diarization, \
                patch.object(q, "switch_workload") as workload, \
                patch.object(q, "control_file_diarization") as file_control, \
                patch.object(q, "stop_all") as stop:
            for argv, expected in cases:
                with self.subTest(argv=argv):
                    status.reset_mock()
                    resources.reset_mock()
                    diarization.reset_mock()
                    self.assertEqual(q.main(argv), 0)
                    if expected == "status":
                        status.assert_called_once_with()
                    elif expected == "diarization":
                        diarization.assert_called_once_with()
                    elif expected == "processes":
                        resources.assert_called_once_with(full=True)
                    else:
                        resources.assert_called_once_with()
            workload.assert_not_called()
            file_control.assert_not_called()
            stop.assert_not_called()
        self.assert_no_mutations()
        self.health.assert_not_called()
        self.open.assert_not_called()

    def test_explicit_and_short_live_start_delegate_preserving_current_qwen(self):
        with patch.object(q, "switch_workload") as workload, \
                patch.object(q, "control_live_diarization") as live_control, \
                patch.object(q, "control_file_diarization") as file_control:
            for argv in (["diarization", "live", "start"], ["diarization", "start"]):
                with self.subTest(argv=argv):
                    live_control.reset_mock()
                    q.main([*argv, "--dry-run", "--force", "--timeout", "27"])
                    live_control.assert_called_once_with("start", True, 27, True)
            q.main(["diarization", "live", "stop", "--timeout", "27"])
            live_control.assert_called_with("stop", False, 27, False)
            workload.assert_not_called()
            file_control.assert_not_called()

    def test_file_cli_dispatch_keeps_live_workload_untouched(self):
        with patch.object(q, "control_file_diarization") as file_control, \
                patch.object(q, "switch_workload") as workload:
            for action in ("start", "stop"):
                with self.subTest(action=action):
                    file_control.reset_mock()
                    q.main(["diarization", "file", action, "--dry-run", "--timeout", "25"])
                    file_control.assert_called_once_with(action, False, 25, True)
            workload.assert_not_called()

    def test_invalid_action_is_rejected_before_any_docker_operation(self):
        for argv in (["diarization", "live", "restart"], ["diarization", "file", "restart"],
                     ["diarization", "candidate", "start"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                q.main(argv)
        self.run.assert_not_called()
        self.assert_no_mutations()

    def test_file_start_targets_only_existing_selected_container(self):
        self.assertEqual(q.FILE_DIARIZATION.container, "sky-diarization-candidate-diarization-1-1")
        q.control_file_diarization("start", timeout=31)
        self.assertEqual(self.mutations(), [call("docker", "start", q.FILE_DIARIZATION.container)])
        self.wait.assert_called_once_with(31)
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_missing_file_target_does_not_start_candidate_replicas(self):
        self.values[q.FILE_DIARIZATION.key] = None
        with self.assertRaisesRegex(RuntimeError, "missing"):
            q.control_file_diarization("start")
        self.run.assert_not_called()
        self.assert_no_mutations()

    def test_conflicting_8085_owner_blocks_start_even_with_force(self):
        self.port_owners = ["sky-diarization-candidate-worker-1"]
        for force in (False, True):
            with self.subTest(force=force), self.assertRaisesRegex(RuntimeError, "8085"):
                q.control_file_diarization("start", force=force)
        self.assert_no_mutations()
        self.wait.assert_not_called()

    def test_running_27b_profile_blocks_file_start_before_mutation(self):
        for alias in ("u64", "u32asr", "qwen", "heretic"):
            for model in q.MODELS:
                self.values[model.key] = state(model == q.resolve(alias))
            with self.subTest(alias=alias), self.assertRaisesRegex(RuntimeError, "27B"):
                q.control_file_diarization("start")
        self.assert_no_mutations()
        self.wait.assert_not_called()

    def test_bounded_file_start_with_32k_qwen_preserves_current_services(self):
        for model in q.MODELS:
            self.values[model.key] = state(model == q.resolve("u32asr"))
        self.values[q.FILE_DIARIZATION.key]["env"] = dict(BOUNDED_BATCHES)
        self.free_mib = "2048\n"
        q.control_file_diarization("start")
        self.assertEqual(self.mutations(), [call("docker", "start", q.FILE_DIARIZATION.container)])
        self.switch.assert_not_called()
        self.policy.assert_not_called()

    def test_live_start_preserves_current_qwen_and_starts_dependencies_in_order(self):
        for model in q.MODELS:
            self.values[model.key] = state(model == q.resolve("u32asr"))
        for service in q.AUDIO:
            self.values[service.key]["state"].update(Running=False, Status="exited")
        self.values["wlk"]["env"] = dict(CPU_ONLY)
        self.values["wlk"]["devices"] = []
        q.control_live_diarization("start", timeout=35)
        self.assertEqual(self.mutations(), [call("docker", "start", service.container) for service in q.AUDIO])
        self.switch.assert_not_called()
        self.policy.assert_not_called()
        self.idle.assert_not_called()
        self.wait.assert_not_called()
        self.assertTrue(self.values["uncensored-asr"]["state"]["Running"])

    def test_live_start_rejects_gpu_sortformer_with_large_qwen_without_mutation(self):
        for model in q.MODELS:
            self.values[model.key] = state(model == q.resolve("u32asr"))
        with self.assertRaisesRegex(RuntimeError, "CPU-only Sortformer"):
            q.control_live_diarization("start")
        self.assert_no_mutations()

    def test_live_start_rollback_keeps_dependencies_when_wlk_cannot_finish_stopping(self):
        for service in q.AUDIO:
            self.values[service.key]["state"].update(Running=False, Status="exited")

        def readiness(service, timeout):
            if service.key == "wlk":
                raise RuntimeError("WLK readiness failed")

        def command(*args, **kwargs):
            if args[:2] == ("docker", "stop"):
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            return self.fake_run(*args, **kwargs)

        self.wait_audio.side_effect = readiness
        self.run.side_effect = command
        with self.assertRaisesRegex(RuntimeError, "WLK readiness failed"):
            q.control_live_diarization("start", timeout=3)
        self.assertEqual(self.mutations(), [*[call("docker", "start", s.container) for s in q.AUDIO],
                                           call("docker", "stop", "--timeout=-1", q.AUDIO[-1].container, timeout=3)])
        self.assertTrue(all(self.values[s.key]["state"]["Running"] for s in q.AUDIO))
        self.assertIn("rollback incomplete", self.output.getvalue())
        self.switch.assert_not_called()
        self.policy.assert_not_called()

    def test_live_stop_keeps_shared_whisper_file_proxy_and_qwen(self):
        before = copy.deepcopy(self.values)
        q.control_live_diarization("stop", timeout=41)
        self.assertEqual(self.mutations(), [
            call("docker", "stop", "--timeout=-1", q.AUDIO[-1].container, timeout=41),
            call("docker", "stop", "--timeout=-1", q.AUDIO[-2].container, timeout=41),
        ])
        for service in (*q.MODELS, *q.AUDIO[:2], q.FILE_DIARIZATION):
            self.assertEqual(self.values[service.key], before[service.key])
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_live_stop_refuses_busy_unknown_or_second_snapshot_connection(self):
        for snapshots in ([1], [None], [0, 1]):
            with self.subTest(snapshots=snapshots):
                self.connections.side_effect = snapshots
                with self.assertRaisesRegex(RuntimeError, "open/uncheckable connections"):
                    q.control_live_diarization("stop")
                self.assert_no_mutations()

    def test_force_live_stop_explicitly_bypasses_connection_check(self):
        self.connections.return_value = 1
        q.control_live_diarization("stop", force=True, timeout=45)
        self.connections.assert_not_called()
        self.assertEqual(self.mutations(), [call("docker", "stop", "--timeout=30", s.container, timeout=45)
                                           for s in reversed(q.AUDIO[2:])])

    def test_stop_timeout_never_kills_restarts_or_moves_to_dependent_proxy(self):
        for action in ("file", "live"):
            with self.subTest(action=action):
                self.values[q.FILE_DIARIZATION.key] = state(True)
                self.run.reset_mock()
                self.run.side_effect = subprocess.TimeoutExpired("docker stop", 3)
                controller = q.control_file_diarization if action == "file" else q.control_live_diarization
                target = q.FILE_DIARIZATION if action == "file" else q.AUDIO[-1]
                with self.assertRaisesRegex(RuntimeError, "still stopping/draining"):
                    controller("stop", timeout=3)
                self.assertEqual(self.mutations(), [call("docker", "stop", "--timeout=-1", target.container, timeout=3)])
                self.policy.assert_not_called()
                self.switch.assert_not_called()

    def test_forced_stop_is_the_only_path_with_kill_deadline(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        q.control_file_diarization("stop", force=True, timeout=45)
        self.assertEqual(self.mutations(), [call("docker", "stop", "--timeout=30", q.FILE_DIARIZATION.container, timeout=45)])

    def test_low_or_unmeasurable_vram_blocks_file_start(self):
        for value in ("2047\n", "0\n", "N/A\n", "", "nan\n", "inf\n"):
            self.free_mib = value
            self.run.reset_mock()
            with self.subTest(free=value):
                with self.assertRaises(RuntimeError):
                    q.control_file_diarization("start")
                self.assert_no_mutations()
        self.wait.assert_not_called()

    def test_force_explicitly_overrides_coexistence_and_headroom(self):
        self.active_names = [q.resolve("u64").container]
        self.free_mib = "0\n"
        q.control_file_diarization("start", force=True)
        self.assertEqual(self.mutations(), [call("docker", "start", q.FILE_DIARIZATION.container)])
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_file_start_and_stop_dry_runs_never_mutate(self):
        q.control_file_diarization("start", dry_run=True)
        self.values[q.FILE_DIARIZATION.key] = state(True)
        q.control_file_diarization("start", dry_run=True)
        q.control_file_diarization("stop", dry_run=True)
        self.assert_no_mutations()
        self.wait.assert_not_called()

    def test_failed_readiness_restores_only_newly_started_target(self):
        self.wait.side_effect = RuntimeError("readiness failed")
        with self.assertRaisesRegex(RuntimeError, "readiness failed"):
            q.control_file_diarization("start")
        self.assertEqual(self.mutations(), [call("docker", "start", q.FILE_DIARIZATION.container),
                                           call("docker", "stop", "--timeout=-1", q.FILE_DIARIZATION.container, timeout=180, check=False)])
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_existing_running_service_readiness_failure_is_left_running(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        self.wait.side_effect = RuntimeError("readiness failed")
        with self.assertRaisesRegex(RuntimeError, "readiness failed"):
            q.control_file_diarization("start")
        self.run.assert_not_called()
        self.assert_no_mutations()

    def test_incomplete_rollback_warns_without_replacing_original_startup_error(self):
        for stop_result, after in ((Mock(returncode=1), state(False)),
                                   (Mock(returncode=0), state(True)),
                                   (Mock(returncode=0), None),
                                   (RuntimeError("rollback Docker failure"), state(True))):
            with self.subTest(stop_result=stop_result, after=after):
                self.output.seek(0)
                self.output.truncate(0)
                self.run.reset_mock()
                self.values[q.FILE_DIARIZATION.key] = state(False)
                original = RuntimeError("original model readiness failure")
                self.wait.side_effect = original

                def command(*args, **kwargs):
                    if args[:2] == ("docker", "stop"):
                        if isinstance(stop_result, Exception):
                            raise stop_result
                        self.values[q.FILE_DIARIZATION.key] = after
                        return stop_result
                    return self.fake_run(*args, **kwargs)

                self.run.side_effect = command
                with self.assertRaisesRegex(RuntimeError, "original model readiness failure") as caught:
                    q.control_file_diarization("start")
                self.assertIs(caught.exception, original)
                self.assertIn("rollback incomplete", self.output.getvalue())
                self.assertEqual(self.mutations(), [call("docker", "start", q.FILE_DIARIZATION.container),
                                                   call("docker", "stop", "--timeout=-1", q.FILE_DIARIZATION.container, timeout=180, check=False)])
                self.policy.assert_not_called()
                self.switch.assert_not_called()

    def test_unknown_or_busy_jobs_get_graceful_stop_without_kill_deadline(self):
        for data in (None, {}, {"inflight": 0}, {"inflight": 1, "queued": 0},
                     {"inflight": 0, "queued": 1}, {"inflight": "0", "queued": 0},
                     {"inflight": False, "queued": False}):
            self.health.return_value = data
            self.values[q.FILE_DIARIZATION.key] = state(True)
            self.run.reset_mock()
            with self.subTest(data=data):
                q.control_file_diarization("stop", timeout=29)
                self.assertEqual(self.mutations(), [call("docker", "stop", "--timeout=-1", q.FILE_DIARIZATION.container, timeout=29)])

    def test_confirmed_idle_stop_only_targets_file_service(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        q.control_file_diarization("stop")
        self.assertEqual(self.mutations(), [call("docker", "stop", "--timeout=-1", q.FILE_DIARIZATION.container, timeout=180)])
        self.policy.assert_not_called()
        self.switch.assert_not_called()

    def test_ready_requires_expected_service_true_readiness_and_cuda(self):
        self.assertTrue(q.file_diarization_ready(dict(READY)))
        for key, value in (("service", "other-service"), ("ready", False), ("ready", 1),
                           ("ready", "true"), ("device", "cpu"), ("device", None),
                           ("status", "starting"), ("concurrency", 2), ("concurrency", True),
                           ("concurrency", "1"), ("maxQueued", 2), ("maxQueued", -1),
                           ("maxQueued", True), ("maxQueued", "1")):
            with self.subTest(key=key, value=value):
                self.assertFalse(q.file_diarization_ready({**READY, key: value}))
        for data in (None, [], {}, {"status": "ok"}):
            self.assertFalse(q.file_diarization_ready(data))

    def test_file_gate_defaults_allow_one_request_and_explicit_zero_queue(self):
        info = state(False)
        info["env"] = dict(BOUNDED_BATCHES)
        self.assertTrue(q.file_bounded(info))
        self.assertTrue(q.file_bounded({**info, "env": {**info["env"], "DIARIZATION_MAX_QUEUED_REQUESTS": "0"}}))
        self.assertTrue(q.file_diarization_ready({**READY, "maxQueued": 0}))
        for key, value in (("DIARIZATION_REQUEST_CONCURRENCY", "2"), ("DIARIZATION_REQUEST_CONCURRENCY", "0"),
                           ("DIARIZATION_MAX_QUEUED_REQUESTS", "2"), ("DIARIZATION_MAX_QUEUED_REQUESTS", "-1")):
            with self.subTest(key=key, value=value):
                self.assertFalse(q.file_bounded({**info, "env": {**info["env"], key: value}}))

    def test_wait_requires_ready_health_and_rejects_stopped_or_restarting(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        self.health.side_effect = [{**READY, "ready": False}, dict(READY)]
        with patch.object(q.time, "monotonic", side_effect=[0, 0.1, 1.1]):
            self.real_wait(3)
        self.assertEqual(self.health.call_count, 2)
        self.sleep.assert_called_once_with(1)
        self.assert_no_mutations()
        for info in (state(False), {**state(True), "state": {"Running": True, "Restarting": True}}):
            self.values[q.FILE_DIARIZATION.key] = info
            with self.subTest(info=info), patch.object(q.time, "monotonic", side_effect=[0, 0.1]), \
                    self.assertRaisesRegex(RuntimeError, "stopped or restarted"):
                self.real_wait(3)

    def test_wait_timeout_does_not_treat_http_health_as_readiness(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        self.health.return_value = {"status": "ok"}
        with patch.object(q.time, "monotonic", side_effect=[0, 0.1, 2]), \
                self.assertRaisesRegex(RuntimeError, "readiness timeout"):
            self.real_wait(1)
        self.assert_no_mutations()

    def test_health_only_probes_running_selected_container_address(self):
        self.assertIsNone(self.real_health(state(False)))
        self.open.assert_not_called()
        self.open.side_effect = [io.StringIO(json.dumps(READY))]
        self.assertEqual(self.real_health(state(True)), READY)
        self.open.assert_called_once_with("http://172.30.0.5:8085/health", timeout=2)
        self.run.assert_not_called()

    def test_27b_modes_symmetrically_refuse_running_file_diarization(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        for mode in ("big", "big-asr"):
            with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, "File diarization is running"):
                q.switch_workload(mode)
        self.preflight.assert_not_called()
        self.assert_no_mutations()

    def test_audio_remains_allowed_and_force_can_override_symmetric_guard(self):
        self.values[q.FILE_DIARIZATION.key] = state(True)
        q.switch_workload("audio", dry_run=True)
        q.switch_workload("big", force=True, dry_run=True)
        q.switch_workload("big-asr", force=True, dry_run=True)
        self.assertEqual(self.preflight.call_count, 3)
        self.assert_no_mutations()

    def test_resource_helper_is_loaded_beside_symlink_target(self):
        with tempfile.TemporaryDirectory(prefix="qwen-control-test-") as directory:
            link = Path(directory) / "qwen-switch"
            link.symlink_to(SOURCE)
            with patch.object(q, "__file__", str(link)):
                module = q.resource_module()
        self.assertEqual(Path(module.__file__).resolve(), SOURCE.with_name("qwen_resources.py"))
        self.assertTrue(callable(module.collect_resources))
        self.run.assert_not_called()
        self.open.assert_not_called()

    def test_unknown_resource_snapshot_does_not_claim_a_zero_selection(self):
        snapshot = {"containers": [{"name": service.container, "state": "unknown"}
                                    for service in (*q.MODELS, *q.AUDIO, q.FILE_DIARIZATION)]}
        module = Mock()
        module.collect_resources.return_value = snapshot
        module.render_resources.return_value = "Unavailable current metrics"
        with patch.object(q, "resource_module", return_value=module):
            q.show_resources(running=[], audio={})
        output = self.output.getvalue()
        self.assertIn("unknown selection", output)
        self.assertNotIn("current selection 0.0;", output)
        required = q.OMI_CONTAINERS | {q.FILE_DIARIZATION.container}
        self.assertTrue(required.issubset(module.collect_resources.call_args.args[0]))
        self.assert_no_mutations()

    def test_loaded_plan_uses_snapshot_paused_and_restarting_states(self):
        services = (*q.MODELS, *q.AUDIO, q.FILE_DIARIZATION)
        states = {service.container: "exited" for service in services}
        states[q.resolve("small").container] = "paused"
        states[q.AUDIO[0].container] = "restarting"
        states[q.AUDIO[-1].container] = "paused"
        states[q.FILE_DIARIZATION.container] = "restarting"
        snapshot = {"containers": [{"name": name, "state": value} for name, value in states.items()]}
        module = Mock()
        module.collect_resources.return_value = snapshot
        module.render_resources.return_value = "Snapshot current metrics"
        with patch.object(q, "resource_module", return_value=module):
            # These stale arguments deliberately disagree with the authoritative snapshot.
            q.show_resources(running=[q.resolve("u64")], audio={s.key: state(False) for s in q.AUDIO})
        output = self.output.getvalue()
        self.assertIn("current selection 9.9 + file GPU ~1.0 (observed, peak unknown)", output)
        self.assertNotIn("unknown selection", output)
        self.inspector.assert_not_called()
        self.assert_no_mutations()

    def test_cpu_live_model_is_not_counted_as_gpu_vram_forecast(self):
        audio = {service.key: state(True) for service in q.AUDIO}
        audio["wlk"].update(env=dict(CPU_ONLY), devices=[])
        self.assertEqual(q.loaded_vram_plan([q.resolve("small")], audio), "8.5")


if __name__ == "__main__":
    unittest.main()
