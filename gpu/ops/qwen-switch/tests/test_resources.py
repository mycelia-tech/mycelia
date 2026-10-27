import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "qwen_resources.py"
spec = importlib.util.spec_from_file_location("qwen_resources", SOURCE)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

A, B, C, D = (char * 64 for char in "abcd")
MIB = 1024 ** 2
FILE_DIARIZATION = r.CANONICAL_FILE_DIARIZATION


class ResourcesTests(unittest.TestCase):
    def setUp(self):
        self.containers = [
            {"id": A, "name": "qwen-test", "state": "running", "health": "healthy", "project": "qwen"},
            {"id": B, "name": FILE_DIARIZATION, "state": "exited", "health": None, "project": r.LEGACY_PROJECT},
            {"id": C, "name": "omi-runtime", "state": "running", "health": None, "project": "omi"},
            {"id": D, "name": "sky-diarization-candidate-worker-1", "state": "exited", "health": None, "project": r.LEGACY_PROJECT},
        ]
        self.stats = [{"id": A, "memory": "1.5GiB / 64GiB"}, {"id": C, "memory": "128MiB / 64GiB"}]
        self.gpus = "0, GPU-one, 4096, 24576, 20480\n"
        self.gpu_processes = "GPU-one, 123, /usr/bin/llama-server, 3072\nGPU-one, 456, python, 512\n"
        self.proc = {"/proc/meminfo": "MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\nMemFree: 1048576 kB\nCached: 4194304 kB\n",
                     "/proc/123/cgroup": "0::/system.slice/docker-" + A + ".scope\n",
                     "/proc/456/cgroup": "0::/user.slice/user-1000.slice/session-3.scope\n"}
        self.tops = {A: "PID COMMAND\n123 llama-server\n", C: "PID COMMAND\n321 omi\n"}
        self.failures = set()
        self.inspect_rows = None
        self.inspect_exit_code = 0
        self.calls = []
        self.patches = [patch.object(r.subprocess, "run", side_effect=self.fake_run),
                        patch.object(r, "_read_text", side_effect=lambda path: self.proc.get(str(path)))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def fake_run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ["docker", "ps"]:
            key, output = "list", "\n".join(json.dumps({k: c[k] for k in ("id", "name", "state")}) for c in self.containers)
        elif args[:2] == ["docker", "inspect"]:
            rows = self.containers if self.inspect_rows is None else self.inspect_rows
            key, output = "inspect", "\n".join(json.dumps(c) for c in rows)
        elif args[:2] == ["docker", "stats"]:
            key, output = "stats", "\n".join(json.dumps(s) for s in self.stats)
        elif args[:2] == ["docker", "top"]:
            key, output = "top:" + args[2], self.tops.get(args[2], "PID COMMAND\n")
        elif args[0] == "nvidia-smi" and args[1].startswith("--query-gpu="):
            key, output = "gpu", self.gpus
        elif args[0] == "nvidia-smi" and args[1].startswith("--query-compute-apps="):
            key, output = "gpu-processes", self.gpu_processes
        else:
            raise AssertionError("Unexpected command: " + repr(args))
        if key in self.failures:
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])
        code = self.inspect_exit_code if key == "inspect" else 0
        return subprocess.CompletedProcess(args, code, output, "")

    def collect(self, extra=()):
        return r.collect_resources({"qwen-test", "omi-runtime", FILE_DIARIZATION, *extra})

    def test_units_and_missing_values(self):
        for text, expected in [("1.5GiB / 64GiB", 1536 * MIB), ("2MB", 2000000),
                               ("2 MiB", 2 * MIB), ("1 KiB", 1024), ("2kB", 2000),
                               ("42", 42), ("0B / 64GiB", 0)]:
            with self.subTest(text=text):
                self.assertEqual(r.parse_bytes(text), expected)
        for value in (None, "", "N/A", "[Not Supported]", "-1B", "nan", True):
            self.assertIsNone(r.parse_bytes(value))

    def test_host_available_excludes_reclaimable_cache_and_is_not_container_sum(self):
        snap = self.collect()
        self.assertEqual(snap["host"]["total_bytes"], 8192 * MIB)
        self.assertEqual(snap["host"]["available_bytes"], 6144 * MIB)
        self.assertEqual(snap["host"]["used_bytes"], 2048 * MIB)
        self.assertEqual(snap["known_totals"]["ram_bytes"], 1664 * MIB)
        self.assertNotEqual(snap["host"]["used_bytes"], snap["known_totals"]["ram_bytes"])

    def test_gpu_attribution_cgroup_and_no_device_or_process_double_count(self):
        self.gpu_processes += "GPU-one, 123, /usr/bin/llama-server, 3072\n"
        snap = self.collect()
        qwen = next(c for c in snap["containers"] if c["name"] == "qwen-test")
        self.assertEqual(qwen["vram_bytes"], 3072 * MIB)
        self.assertEqual(snap["gpu"]["used_bytes"], 4096 * MIB)
        self.assertEqual(snap["gpu"]["available_bytes"], 20480 * MIB)
        self.assertEqual(snap["gpu"]["process_bytes"], 3584 * MIB)
        self.assertEqual(snap["known_totals"]["vram_bytes"], 3072 * MIB)
        self.assertEqual(len(snap["processes"]), 2)
        self.assertEqual(snap["processes"][0]["attribution"], "cgroup")
        self.assertEqual(snap["processes"][1]["attribution"], "host")

    def test_docker_top_fallback_for_unreadable_cgroup(self):
        del self.proc["/proc/123/cgroup"]
        snap = self.collect()
        self.assertEqual(snap["processes"][0]["container_name"], "qwen-test")
        self.assertEqual(snap["processes"][0]["attribution"], "docker top")

    def test_stopped_zero_missing_unknown_and_partial_totals(self):
        snap = self.collect(["missing-service"])
        entries = {c["name"]: c for c in snap["containers"]}
        self.assertEqual(entries[FILE_DIARIZATION]["ram_bytes"], 0)
        self.assertEqual(entries[FILE_DIARIZATION]["vram_bytes"], 0)
        self.assertIsNone(entries["missing-service"]["ram_bytes"])
        self.assertIsNone(entries["missing-service"]["vram_bytes"])
        self.assertEqual(entries["missing-service"]["state"], "missing")
        self.assertIsNone(snap["known_totals"]["ram_bytes"])
        self.assertEqual(snap["known_totals"]["ram_measured_bytes"], 1664 * MIB)
        self.assertEqual(snap["known_totals"]["ram_unknown_count"], 1)

    def test_missing_metrics_never_become_zero(self):
        self.failures.update({"stats", "gpu", "gpu-processes"})
        self.proc.pop("/proc/meminfo")
        snap = self.collect()
        self.assertIsNone(snap["host"]["used_bytes"])
        self.assertIsNone(snap["gpu"]["used_bytes"])
        self.assertIsNone(snap["gpu"]["available_bytes"])
        for c in snap["containers"]:
            if c["state"] == "running":
                self.assertIsNone(c["ram_bytes"])
                self.assertIsNone(c["vram_bytes"])
        self.assertGreaterEqual(len(snap["warnings"]), 4)

    def test_optional_inspect_metadata_uses_safe_map_access_and_preserves_nulls(self):
        # Docker's template engine uses missingkey=error: direct .State.Health
        # fails for containers with no healthcheck, and Labels may be null.
        self.assertIn('with index .State "Health"', r.INSPECT_FORMAT)
        self.assertIn('with index .Config "Labels"', r.INSPECT_FORMAT)
        self.assertNotIn('.State.Health', r.INSPECT_FORMAT)
        self.assertNotIn('.Config.Labels', r.INSPECT_FORMAT)
        self.containers[2]["project"] = None
        entries = {c["name"]: c for c in self.collect()["containers"]}
        self.assertEqual(entries["qwen-test"]["health"], "healthy")
        self.assertIsNone(entries["omi-runtime"]["health"])
        self.assertIsNone(entries["omi-runtime"]["project"])

    def test_partial_inspect_failure_retains_valid_peers_and_warns(self):
        self.inspect_rows = self.containers[:2]
        self.inspect_exit_code = 1
        snap = self.collect()
        entries = {c["name"]: c for c in snap["containers"]}
        self.assertEqual(entries["qwen-test"]["health"], "healthy")
        self.assertEqual(entries["qwen-test"]["project"], "qwen")
        self.assertEqual(entries[FILE_DIARIZATION]["project"], r.LEGACY_PROJECT)
        self.assertIn("Docker inspect returned an error; using any valid details.", snap["warnings"])
        self.assertIn("Container details unavailable: omi-runtime.", snap["warnings"])
        self.assertNotIn("Container details unavailable: qwen-test.", snap["warnings"])

    def test_failed_inspect_without_output_keeps_ps_state_and_unknown_metadata(self):
        self.inspect_rows = []
        self.inspect_exit_code = 1
        snap = self.collect()
        entries = {c["name"]: c for c in snap["containers"]}
        self.assertEqual(entries["qwen-test"]["state"], "running")
        self.assertIsNone(entries["qwen-test"]["health"])
        self.assertIsNone(entries["qwen-test"]["project"])
        self.assertIn("Container details unavailable: qwen-test.", snap["warnings"])

    def test_unattributed_gpu_pid_and_failed_top_leave_vram_unknown(self):
        self.proc.pop("/proc/123/cgroup")
        self.failures.add("top:" + A)
        snap = self.collect()
        entries = {c["name"]: c for c in snap["containers"]}
        self.assertIsNone(entries["qwen-test"]["vram_bytes"])
        self.assertEqual(entries["omi-runtime"]["vram_bytes"], 0)
        self.assertEqual(snap["processes"][0]["attribution"], "unknown")

    def test_available_missing_does_not_substitute_free_memory(self):
        self.proc["/proc/meminfo"] = "MemTotal: 8388608 kB\nMemFree: 1048576 kB\n"
        self.assertIsNone(self.collect()["host"]["used_bytes"])

    def test_same_pid_on_two_gpus_sums_device_allocations_once_each(self):
        self.gpus += "1, GPU-two, 1024, 24576, 23552\n"
        self.gpu_processes += "GPU-two, 123, /usr/bin/llama-server, 512\n"
        snap = self.collect()
        self.assertEqual(snap["known_totals"]["vram_bytes"], 3584 * MIB)
        self.assertEqual(snap["gpu"]["used_bytes"], 5120 * MIB)
        self.assertEqual(snap["gpu"]["total_bytes"], 49152 * MIB)
        self.assertEqual(snap["gpu"]["available_bytes"], 44032 * MIB)

    def test_invalid_gpu_capacity_keeps_available_unknown(self):
        for device in ("0, GPU-one, N/A, 24576, 20480\n", "0, GPU-one, 24577, 24576, 0\n",
                       "0, GPU-one, 4096, 24576, N/A\n"):
            with self.subTest(device=device):
                self.gpus = device
                snap = self.collect()
                self.assertIsNone(snap["gpu"]["available_bytes"])
                self.assertIn("GPU device memory unavailable or incomplete.", snap["warnings"])
                gpu_line = next(line for line in r.render_resources(snap).splitlines() if line.startswith("GPU VRAM:"))
                self.assertTrue(gpu_line.endswith("available ?"))

    def test_gpu_available_uses_reported_free_memory_not_total_minus_used(self):
        self.gpus = "0, GPU-one, 4096, 24576, 19968\n"
        snap = self.collect()
        self.assertEqual(snap["gpu"]["available_bytes"], 19968 * MIB)
        self.assertNotEqual(snap["gpu"]["available_bytes"], snap["gpu"]["total_bytes"] - snap["gpu"]["used_bytes"])
        self.assertIn("available 19.50 GiB", r.render_resources(snap))

    def test_unknown_process_memory_is_not_zero(self):
        self.gpu_processes = "GPU-one, 123, llama-server, N/A\n"
        snap = self.collect()
        self.assertIsNone(snap["known_totals"]["vram_bytes"])
        self.assertIsNone(snap["gpu"]["process_bytes"])

    def test_failed_container_list_does_not_claim_missing_or_zero(self):
        self.failures.add("list")
        snap = self.collect()
        self.assertTrue(all(c["state"] == "unknown" for c in snap["containers"]))
        self.assertTrue(all(c["ram_bytes"] is None for c in snap["containers"]))

    def test_compact_separates_legacy_and_full_includes_other_running_services(self):
        extra_id = "e" * 64
        self.containers.append({"id": extra_id, "name": "unrelated-service", "state": "running", "health": None})
        self.stats.append({"id": extra_id, "memory": "32MiB / 64GiB"})
        snap = self.collect()
        compact = r.render_resources(snap)
        full = r.render_resources(snap, full=True)
        self.assertIn("Legacy diarization", compact)
        self.assertNotIn("unrelated-service", compact)
        self.assertIn("unrelated-service", full)
        self.assertNotIn("GPU compute processes", compact)
        self.assertIn("GPU compute processes", full)
        self.assertIn("123", full)
        self.assertEqual(snap["known_totals"]["container_count"], 3)

    def test_canonical_file_service_is_in_managed_total_and_legacy_stays_separate(self):
        self.containers[1]["state"] = "running"
        self.stats.append({"id": B, "memory": "2GiB / 64GiB"})
        self.tops[B] = "PID COMMAND\n789 uvicorn\n"
        self.gpu_processes += "GPU-one, 789, /app/.venv/bin/python, 1024\n"
        self.proc["/proc/789/cgroup"] = "0::/system.slice/docker-" + B + ".scope\n"
        self.containers.append({"id": "e" * 64, "name": "sky-diarization-1", "state": "exited", "health": None,
                                "project": "sky-diarization"})
        snap = self.collect()
        entries = {c["name"]: c for c in snap["containers"]}
        self.assertEqual(entries[FILE_DIARIZATION]["group"], "diarization")
        self.assertTrue(entries[FILE_DIARIZATION]["known"])
        self.assertEqual(entries["sky-diarization-1"]["group"], "legacy-diarization")
        self.assertEqual(entries["sky-diarization-candidate-worker-1"]["group"], "legacy-diarization")
        self.assertEqual(snap["known_totals"]["ram_bytes"], 3712 * MIB)
        self.assertEqual(snap["known_totals"]["vram_bytes"], 4096 * MIB)
        compact = r.render_resources(snap)
        self.assertIn(FILE_DIARIZATION, compact)
        self.assertNotIn("sky-diarization-1", compact)
        self.assertIn("Legacy diarization: 0 active/unknown, 2 stopped", compact)

    def test_full_process_view_includes_wlk_without_gpu_allocation_and_reports_failed_top(self):
        extra_id = "e" * 64
        self.containers.append({"id": extra_id, "name": "sky-livekit-wlk-1", "state": "running", "health": "healthy"})
        self.stats.append({"id": extra_id, "memory": "256MiB / 64GiB"})
        self.tops[extra_id] = "PID COMMAND\n987 python\n"
        self.failures.add("top:" + C)
        snap = self.collect(["sky-livekit-wlk-1"])
        compact = r.render_resources(snap)
        full = r.render_resources(snap, full=True)
        self.assertIn("GPU VRAM: 4.00 GiB / 24.00 GiB  available 20.00 GiB", compact)
        self.assertNotIn("Container processes", compact)
        process_section = full.split("Container processes", 1)[1].split("GPU compute processes", 1)[0]
        self.assertRegex(process_section, r"987\s+python\s+sky-livekit-wlk-1\s+running\s+0")
        self.assertIn("Processes unavailable: omi-runtime.", process_section)

    def test_stopped_rows_do_not_display_historical_health(self):
        self.containers[1]["health"] = "unhealthy"
        snap = self.collect()
        for full in (False, True):
            with self.subTest(full=full):
                rendered = r.render_resources(snap, full=full)
                self.assertNotIn("exited/unhealthy", rendered)
                self.assertIn("running/healthy", rendered)

    def test_commands_are_read_only_bounded_and_do_not_fetch_sensitive_metadata(self):
        self.collect()
        for args, kwargs in self.calls:
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], 8)
            self.assertFalse(kwargs.get("shell", False))
            if args[0] == "docker":
                self.assertIn(args[1], {"ps", "inspect", "stats", "top"})
            command = " ".join(args)
            self.assertNotIn(".Config.Env", command)
            self.assertNotIn(".Config.Cmd", command)
            self.assertNotIn("args", command)


if __name__ == "__main__":
    unittest.main()
