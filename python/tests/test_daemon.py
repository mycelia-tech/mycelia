from pathlib import Path
from sys import path
from unittest import TestCase, main
from unittest.mock import Mock, patch

from mongo_stub import MongoStub

path.insert(0, str(Path(__file__).resolve().parents[1]))

import daemon
import manage_errors


class DaemonCliTest(TestCase):
    @staticmethod
    def sources(count):
        return [{
            "_id": index, "path": f"/staging/{index}.m4a", "start": index,
            "platform": {"importer": "fixture"}, "ingested": False,
        } for index in range(count)]

    def test_batch_limit_and_newest_first_order_are_enforced(self):
        mongo = MongoStub(self.sources(25))
        importer = Mock()
        with (
            patch("daemon.call_resource", side_effect=mongo),
            patch.dict(daemon.importer_map, {"fixture": importer}, clear=True),
        ):
            result = daemon.ingests_missing_sources(limit=20)
        self.assertEqual(result, {
            "attempted": 20, "succeeded": 20, "failed": 0,
            "remaining": 5, "cached_errors": 0,
        })
        self.assertEqual(
            [call.args[0]["_id"] for call in importer.upload.call_args_list],
            list(range(24, 4, -1)),
        )

    def test_failed_upload_is_counted_and_excluded_on_next_cycle(self):
        mongo = MongoStub(self.sources(2))
        importer = Mock()
        importer.upload.side_effect = [RuntimeError("FFmpeg failed"), None]
        with (
            patch("daemon.call_resource", side_effect=mongo),
            patch.dict(daemon.importer_map, {"fixture": importer}, clear=True),
        ):
            first = daemon.ingests_missing_sources(limit=20)
            second = daemon.ingests_missing_sources(limit=20)
        self.assertEqual(first, {
            "attempted": 2, "succeeded": 1, "failed": 1,
            "remaining": 0, "cached_errors": 1,
        })
        self.assertEqual(second, {
            "attempted": 0, "succeeded": 0, "failed": 0,
            "remaining": 0, "cached_errors": 1,
        })
        self.assertEqual(importer.upload.call_count, 2)

    def test_counts_exclude_other_hosts_and_importers(self):
        unrelated = {
            "_id": 99, "path": "/remote/audio", "ingested": False,
            "platform": {"node": "another-host", "importer": "another-importer"},
            "ingestion": {"error": "unrelated"},
        }
        mongo = MongoStub([unrelated])
        with (
            patch("daemon.call_resource", side_effect=mongo),
            patch.dict(daemon.importer_map, {"fixture": Mock()}, clear=True),
        ):
            result = daemon.ingests_missing_sources(limit=20)
            selected = daemon.ingests_missing_sources(limit=1, source_ids=[99])
        self.assertEqual(result["cached_errors"], 0)
        self.assertEqual(selected["cached_errors"], 1)

    def test_successful_explicit_retry_counts_only_unresolved_errors(self):
        sources = self.sources(2)
        for source in sources:
            source["ingestion"] = {"error": "old failure"}
        mongo = MongoStub(sources)
        with (
            patch("daemon.call_resource", side_effect=mongo),
            patch.dict(daemon.importer_map, {"fixture": Mock()}, clear=True),
        ):
            result = daemon.ingests_missing_sources(limit=1, retry_errors=True)
        self.assertEqual(result["succeeded"], 1)
        self.assertEqual(result["remaining"], 1)
        self.assertEqual(result["cached_errors"], 1)
        self.assertNotIn("ingestion", mongo.records[1])

    def test_mongo_completion_failure_is_cached_and_reported(self):
        mongo = MongoStub(self.sources(1))

        def fail_completion(resource, body):
            if body["action"] == "updateOne" and body["update"]["$set"].get("ingested"):
                raise RuntimeError("Mongo write failed")
            return mongo(resource, body)

        with (
            patch("daemon.call_resource", side_effect=fail_completion),
            patch.dict(daemon.importer_map, {"fixture": Mock()}, clear=True),
        ):
            result = daemon.ingests_missing_sources(limit=1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["cached_errors"], 1)
        self.assertFalse(mongo.records[0]["ingested"])

    def test_error_cache_write_failure_propagates(self):
        mongo = MongoStub(self.sources(1))

        def fail_writes(resource, body):
            if body["action"] == "updateOne":
                raise RuntimeError("Mongo unavailable")
            return mongo(resource, body)

        with (
            patch("daemon.call_resource", side_effect=fail_writes),
            patch.dict(daemon.importer_map, {"fixture": Mock()}, clear=True),
            self.assertRaisesRegex(RuntimeError, "Mongo unavailable"),
        ):
            daemon.ingests_missing_sources(limit=1)

    def test_import_new_files_returns_per_source_failures(self):
        successful = type(
            "Importer",
            (),
            {"code": "ok", "run": lambda self: 2, "last_warning": None},
        )()

        def fail(_self):
            raise RuntimeError("source denied")

        failed = type(
            "Importer",
            (),
            {"code": "bad", "run": fail},
        )()

        with (
            patch.object(daemon.settings, "importers", [successful, failed]),
            patch.object(daemon.logger, "exception"),
        ):
            daemon._importer_error_state.clear()
            results = daemon.import_new_files()

        self.assertEqual(results[0], {
            "source": "ok",
            "status": "completed",
            "discovered": 2,
        })
        self.assertEqual(results[1]["status"], "failed")
        self.assertEqual(results[1]["error"], "source denied")

    def test_successful_retry_clears_cached_ingestion_error(self):
        source = {
            "_id": "source-1",
            "path": "/tmp/voice-memo.m4a",
            "platform": {"importer": "apple_voicememos"},
        }
        importer = type("Importer", (), {"upload": lambda self, value: None})()
        responses = iter([1, 0, 0, [source], {"modifiedCount": 1}])

        with (
            patch("daemon.call_resource", side_effect=lambda *_: next(responses)) as call_resource,
            patch.dict(daemon.importer_map, {"apple_voicememos": importer}, clear=True),
        ):
            daemon.ingests_missing_sources(limit=1, retry_errors=True)

        update_call = call_resource.call_args_list[-1].args[1]
        self.assertEqual(update_call["action"], "updateOne")
        self.assertTrue(update_call["update"]["$set"]["ingested"])
        self.assertEqual(update_call["update"]["$unset"], {"ingestion": ""})

    def test_targeted_retry_only_queries_requested_source(self):
        source = {
            "_id": "source-2",
            "path": "/tmp/selected-voice-memo.m4a",
            "platform": {"importer": "apple_voicememos"},
        }
        importer = type("Importer", (), {"upload": lambda self, value: None})()
        responses = iter([1, 0, 1, [source], {"modifiedCount": 1}])

        with (
            patch("daemon.call_resource", side_effect=lambda *_: next(responses)) as call_resource,
            patch.dict(daemon.importer_map, {"apple_voicememos": importer}, clear=True),
        ):
            daemon.ingests_missing_sources(
                limit=1,
                retry_errors=True,
                source_ids=["source-2"],
            )

        find_call = next(
            call.args[1]
            for call in call_resource.call_args_list
            if call.args[1]["action"] == "find"
        )
        self.assertEqual(find_call["query"]["_id"], {"$in": ["source-2"]})
        self.assertNotIn("$or", find_call["query"])

    def test_targeted_retry_can_read_from_a_repaired_copy(self):
        source = {
            "_id": "source-3",
            "path": "/original/corrupt.m4a",
            "platform": {"importer": "apple_voicememos"},
        }
        uploaded = []
        importer = type(
            "Importer",
            (),
            {"upload": lambda self, value: uploaded.append(value)},
        )()
        responses = iter([1, 0, 1, [source], {"modifiedCount": 1}])

        with (
            patch("daemon.call_resource", side_effect=lambda *_: next(responses)),
            patch.dict(daemon.importer_map, {"apple_voicememos": importer}, clear=True),
        ):
            daemon.ingests_missing_sources(
                limit=1,
                retry_errors=True,
                source_ids=["source-3"],
                source_path_overrides={
                    "source-3": "/recovered/audio.m4a",
                },
            )

        self.assertEqual(uploaded[0]["path"], "/recovered/audio.m4a")
        self.assertEqual(source["path"], "/original/corrupt.m4a")

    def test_vad_only_runs_vad_cycle_without_import_cycle(self):
        with (
            patch("daemon.initialize_auth") as initialize_auth,
            patch("daemon.run_vad_cycle", return_value={}) as run_vad_cycle,
            patch("daemon.main") as run_import_cycle,
        ):
            daemon.cli([
                "--vad-only",
                "--vad-limit", "12",
                "--vad-batch-size", "3",
                "--once",
            ])

        initialize_auth.assert_called_once_with()
        run_vad_cycle.assert_called_once_with(limit=12, batch_size=3)
        run_import_cycle.assert_not_called()

    def test_default_mode_still_runs_import_cycle(self):
        with (
            patch("daemon.initialize_auth"),
            patch("daemon.run_vad_cycle") as run_vad_cycle,
            patch("daemon.main") as run_import_cycle,
        ):
            daemon.cli(["--once"])

        run_import_cycle.assert_called_once_with(reset_errors=False)
        run_vad_cycle.assert_not_called()

    def test_vad_only_rejects_reset_errors(self):
        with self.assertRaises(SystemExit):
            daemon.cli(["--vad-only", "--reset-errors", "--once"])

    def test_vad_limits_must_be_positive(self):
        with self.assertRaises(SystemExit):
            daemon.cli(["--vad-only", "--vad-limit", "0", "--once"])

    def test_manage_errors_retry_initializes_auth_and_targets_the_source(self):
        file_id = "68ee1a98a5ba09aadf9a8838"
        with (
            patch.object(manage_errors.sys, "argv", [
                "manage_errors.py",
                "retry",
                file_id,
            ]),
            patch("manage_errors.initialize_auth") as initialize_auth,
            patch("manage_errors.ingests_missing_sources") as ingest,
        ):
            manage_errors.main()

        initialize_auth.assert_called_once_with()
        ingest.assert_called_once()
        self.assertEqual(ingest.call_args.kwargs["limit"], 1)
        self.assertTrue(ingest.call_args.kwargs["retry_errors"])
        self.assertEqual(
            [str(value) for value in ingest.call_args.kwargs["source_ids"]],
            [file_id],
        )
        self.assertIsNone(
            ingest.call_args.kwargs["source_path_overrides"],
        )


if __name__ == "__main__":
    main()
