import importlib.util
import io
import json
import subprocess
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/wait-for-ingestion-ready.py"
SPEC = importlib.util.spec_from_file_location("ingestion_readiness_waiter", SCRIPT)
waiter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(waiter)


class IngestionInstallerTest(TestCase):
    def setUp(self):
        self.elapsed = 0

    def sleep(self, duration):
        self.elapsed += duration

    @staticmethod
    def response(health_status="starting", **overrides):
        return {
            "service": "mycelia-host-ingestion", "status": "ready",
            "health": {"status": health_status}, **overrides,
        }

    def test_installer_accepts_ready_service_with_any_valid_ingestion_state(self):
        for status in ("starting", "healthy", "degraded"):
            with (
                self.subTest(status=status),
                patch.object(waiter, "fetch_readiness", return_value=self.response(status)),
                patch("sys.argv", [str(SCRIPT), "http://fixture/readiness"]),
                redirect_stdout(io.StringIO()) as output,
                redirect_stderr(io.StringIO()) as errors,
            ):
                self.assertEqual(waiter.main(), 0)
                self.assertIn(f"ingestion health: {status}", output.getvalue())
                if status == "degraded":
                    self.assertIn("needs attention", errors.getvalue())

    def test_malformed_wrong_service_and_not_ready_responses_are_retried(self):
        responses = [
            ValueError("invalid json"),
            self.response(service="another-service"),
            self.response(status="starting"),
            self.response(health={"status": []}),
            self.response(health={"status": {"unexpected": "object"}}),
            self.response(health=[]),
            [],
            subprocess.CalledProcessError(18, ["curl"]),
            self.response(),
        ]
        with (
            patch.object(waiter, "fetch_readiness", side_effect=responses) as request,
            patch.object(waiter.time, "monotonic", side_effect=lambda: self.elapsed),
            patch.object(waiter.time, "sleep", side_effect=self.sleep),
        ):
            self.assertEqual(waiter.wait_for_readiness("http://fixture", 10)["status"], "ready")
        self.assertEqual(request.call_count, len(responses))
        self.assertEqual(self.elapsed, len(responses) - 1)

    def test_slow_connection_failures_respect_total_deadline(self):
        timeouts = []

        def unavailable(_url, *, timeout):
            timeouts.append(timeout)
            self.elapsed += timeout
            raise subprocess.TimeoutExpired("curl", timeout)

        with (
            patch.object(waiter, "fetch_readiness", side_effect=unavailable),
            patch.object(waiter.time, "monotonic", side_effect=lambda: self.elapsed),
            patch.object(waiter.time, "sleep", side_effect=self.sleep),
            self.assertRaisesRegex(TimeoutError, "timed out"),
        ):
            waiter.wait_for_readiness("http://fixture", 3.5)
        self.assertEqual(self.elapsed, 3.5)
        self.assertEqual(timeouts, [2, 0.5])

    def test_request_bounds_both_transfer_and_process_time(self):
        response = subprocess.CompletedProcess([], 0, json.dumps(self.response()), "")
        with patch.object(waiter.subprocess, "run", return_value=response) as request:
            self.assertEqual(waiter.fetch_readiness("http://fixture", 0.25), self.response())
        self.assertEqual(request.call_args.args[0], [
            "/usr/bin/curl", "-fsS", "--max-time", "0.25", "http://fixture",
        ])
        self.assertEqual(request.call_args.kwargs["timeout"], 0.25)
        self.assertTrue(request.call_args.kwargs["check"])

    def test_response_after_deadline_cannot_report_success(self):
        def slow_response(_url, *, timeout):
            self.elapsed += timeout + 0.01
            return self.response()

        with (
            patch.object(waiter, "fetch_readiness", side_effect=slow_response),
            patch.object(waiter.time, "monotonic", side_effect=lambda: self.elapsed),
            self.assertRaisesRegex(TimeoutError, "exceeded the deadline"),
        ):
            waiter.wait_for_readiness("http://fixture", 0.1)

    def test_timeout_returns_failure_exit_status(self):
        with (
            patch.object(waiter, "wait_for_readiness", side_effect=TimeoutError("wrong service")),
            patch("sys.argv", [str(SCRIPT), "http://fixture"]),
            redirect_stderr(io.StringIO()) as errors,
        ):
            self.assertEqual(waiter.main(), 1)
        self.assertIn("wrong service", errors.getvalue())


if __name__ == "__main__":
    main()
