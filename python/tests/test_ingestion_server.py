import asyncio
import threading
from pathlib import Path
from sys import path
from unittest import TestCase, main
from unittest.mock import mock_open, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

path.insert(0, str(Path(__file__).resolve().parents[1]))

import ingestion_server

SUCCESS = {
    "attempted": 0, "succeeded": 0, "failed": 0,
    "remaining": 0, "cached_errors": 0,
}


class IngestionServerHealthTest(TestCase):
    def setUp(self):
        ingestion_server.last_cycle.clear()
        ingestion_server.last_cycle.update({"status": "not_started"})

    def test_discovery_failure_degrades_cycle_but_still_ingests_pending(self):
        source_results = [{
            "source": "apple_voicememos",
            "status": "failed",
            "error": "permission denied",
        }]
        with (
            patch("ingestion_server.import_new_files", return_value=source_results),
            patch("ingestion_server.ingests_missing_sources", return_value=SUCCESS) as ingest,
        ):
            result = ingestion_server.run_ingestion_cycle(limit=20)

        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["sources"], source_results)
        ingest.assert_called_once_with(limit=20)

        with patch(
            "ingestion_server.get_apple_voicememos_mode",
            return_value="staged",
        ):
            health = asyncio.run(ingestion_server.health())
        self.assertEqual(health["status"], "degraded")
        self.assertEqual(health["appleVoiceMemosMode"], "staged")
        self.assertEqual(health["lastCycle"]["status"], "degraded")

    def test_successful_discovery_reports_healthy(self):
        source_results = [{
            "source": "apple_voicememos",
            "status": "completed",
            "discovered": 0,
        }]
        with (
            patch("ingestion_server.import_new_files", return_value=source_results),
            patch("ingestion_server.ingests_missing_sources", return_value=SUCCESS),
        ):
            ingestion_server.run_ingestion_cycle(limit=20)

        with patch(
            "ingestion_server.get_apple_voicememos_mode",
            return_value="manual",
        ):
            health = asyncio.run(ingestion_server.health())
        self.assertEqual(health["status"], "healthy")
        self.assertEqual(health["appleVoiceMemosMode"], "manual")

    def test_upload_and_cached_failures_degrade_health(self):
        for counts in (
            {**SUCCESS, "attempted": 1, "failed": 1, "cached_errors": 1},
            {**SUCCESS, "cached_errors": 1},
        ):
            with (
                self.subTest(counts=counts),
                patch("ingestion_server.import_new_files", return_value=[]),
                patch("ingestion_server.ingests_missing_sources", return_value=counts),
            ):
                cycle = ingestion_server.run_ingestion_cycle(20)
                self.assertEqual(cycle["ingestion"], counts)
                self.assertEqual(asyncio.run(ingestion_server.health())["status"], "degraded")

    def test_remaining_work_does_not_degrade_health(self):
        with (
            patch("ingestion_server.import_new_files", return_value=[]),
            patch("ingestion_server.ingests_missing_sources", return_value={**SUCCESS, "remaining": 9}),
        ):
            self.assertEqual(ingestion_server.run_ingestion_cycle(20)["status"], "completed")

    def test_health_remains_consistent_when_cycle_changes_during_receipt_read(self):
        completed = {"status": "completed", "finishedAt": "2026-09-07T00:00:00+00:00"}
        failed = {"status": "failed", "error": "concurrent failure"}

        def read_receipt():
            ingestion_server.last_cycle = failed

        with (
            patch.object(ingestion_server, "last_cycle", completed),
            patch.object(ingestion_server, "current_cycle", None),
            patch("ingestion_server.staging_status", side_effect=read_receipt),
        ):
            health = asyncio.run(ingestion_server.health())
        self.assertEqual(health["status"], "healthy")
        self.assertEqual(health["lastCycle"], completed)

    def test_manual_exception_publishes_failed_cycle_and_returns_500(self):
        with (
            patch("ingestion_server.call_resource"),
            patch("ingestion_server.import_new_files", return_value=[]),
            patch("ingestion_server.ingests_missing_sources", side_effect=RuntimeError("Mongo unavailable")),
            self.assertRaises(HTTPException) as failure,
        ):
            asyncio.run(ingestion_server.process_ingestion_job(
                {"jobId": "fixture", "data": {}}, "Bearer fixture-token",
            ))
        self.assertEqual(failure.exception.status_code, 500)
        self.assertEqual(ingestion_server.last_cycle["status"], "failed")
        self.assertEqual(asyncio.run(ingestion_server.health())["status"], "degraded")

    def test_manual_job_returns_ingestion_counts(self):
        with (
            patch("ingestion_server.call_resource"),
            patch("ingestion_server.import_new_files", return_value=[]),
            patch("ingestion_server.ingests_missing_sources", return_value=SUCCESS),
        ):
            result = asyncio.run(ingestion_server.process_ingestion_job(
                {"jobId": "fixture", "data": {}}, "Bearer fixture-token",
            ))
        self.assertEqual(result["ingestion"], SUCCESS)
        self.assertEqual(result["trigger"], "manual")
        self.assertLessEqual(result["startedAt"], result["finishedAt"])
        self.assertIsNone(ingestion_server.current_cycle)

    def test_staging_receipt_is_bounded_and_belongs_to_configured_database(self):
        with (
            patch("ingestion_server.get_apple_voicememos_mode", return_value="staged"),
            patch.dict("os.environ", {"MYCELIA_APPLE_VOICEMEMOS_DB": "/fixture/snapshot.db"}),
            patch("pathlib.Path.open", mock_open(read_data='{"published_database":"/fixture/snapshot.db","staged_audio_files":22,"private_field":"omit"}')) as opened,
        ):
            receipt = ingestion_server.staging_status()
            self.assertEqual(receipt["status"], "available")
            self.assertEqual(receipt["staged_audio_files"], 22)
            self.assertNotIn("private_field", receipt)
            opened().read.assert_called_once_with(64 * 1024)
        with (
            patch("ingestion_server.get_apple_voicememos_mode", return_value="staged"),
            patch.dict("os.environ", {"MYCELIA_APPLE_VOICEMEMOS_DB": "/fixture/snapshot.db"}),
            patch("pathlib.Path.open", mock_open(read_data='{"published_database":"/other/snapshot.db"}')),
        ):
            self.assertEqual(ingestion_server.staging_status()["status"], "unavailable")

    def test_readiness_responds_while_authentication_is_blocked(self):
        release = threading.Event()
        started = threading.Event()

        def authenticate():
            started.set()
            if not release.wait(3):
                raise TimeoutError("Test authentication was not released")
            return "fixture-token"

        async def check():
            async with ingestion_server.lifespan(ingestion_server.app):
                try:
                    await asyncio.to_thread(started.wait, 1)
                    ready = await asyncio.wait_for(ingestion_server.readiness(), timeout=0.5)
                    self.assertEqual(ready["status"], "ready")
                    self.assertEqual(ready["health"]["status"], "starting")
                finally:
                    release.set()
            with self.assertRaises(HTTPException) as failure:
                await ingestion_server.readiness()
            self.assertEqual(failure.exception.status_code, 503)

        with patch("ingestion_server.initialize_auth", side_effect=authenticate):
            asyncio.run(check())

    def test_automatic_cycle_inherits_authentication_token(self):
        observed = []

        def cycle(_limit):
            observed.append(ingestion_server.job_token_var.get())
            raise asyncio.CancelledError

        with (
            patch("ingestion_server.initialize_auth", return_value="fixture-token"),
            patch("ingestion_server.run_ingestion_cycle", side_effect=cycle),
            self.assertRaises(asyncio.CancelledError),
        ):
            asyncio.run(ingestion_server.automatic_ingestion_loop())
        self.assertEqual(observed, ["fixture-token"])

    def test_invalid_settings_fail_startup_before_readiness(self):
        async def check():
            with self.assertRaises(ValueError):
                async with ingestion_server.lifespan(ingestion_server.app):
                    self.fail("Invalid settings must prevent startup")
            with self.assertRaises(HTTPException) as failure:
                await ingestion_server.readiness()
            self.assertEqual(failure.exception.status_code, 503)

        for variable in ("INGESTION_BATCH_SIZE", "INGESTION_INTERVAL_SECONDS"):
            with (
                self.subTest(variable=variable),
                patch.dict("os.environ", {variable: "invalid"}),
                patch("ingestion_server.initialize_auth") as authenticate,
            ):
                asyncio.run(check())
                authenticate.assert_not_called()

    def test_http_readiness_is_ready_during_blocked_first_batch(self):
        started = threading.Event()
        release = threading.Event()

        def ingest(*, limit):
            started.set()
            if not release.wait(3):
                raise TimeoutError("Test batch was not released")
            return SUCCESS

        with (
            patch("ingestion_server.initialize_auth", return_value="fixture-token"),
            patch("ingestion_server.import_new_files", return_value=[]),
            patch("ingestion_server.ingests_missing_sources", side_effect=ingest),
            TestClient(ingestion_server.app) as client,
        ):
            try:
                self.assertTrue(started.wait(1))
                response = client.get("/readiness")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["service"], "mycelia-host-ingestion")
                self.assertEqual(response.json()["status"], "ready")
                self.assertEqual(response.json()["health"]["status"], "starting")
                self.assertEqual(client.get("/health").json()["status"], "starting")
            finally:
                release.set()


if __name__ == "__main__":
    main()
