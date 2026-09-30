import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from sys import path
from unittest import TestCase, main
from unittest.mock import patch

from mongo_stub import MongoStub

path.insert(0, str(Path(__file__).resolve().parents[1]))

from discovery import (
    APPLE_REFERENCE_DATE,
    AppleVoiceMemosImporter,
    SourceUnavailableError,
)


def apple_seconds(value: datetime) -> float:
    return value.timestamp() - APPLE_REFERENCE_DATE


class AppleVoiceMemosImporterTest(TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "audio"
        self.root.mkdir()
        self.db_path = Path(self.temp_dir.name) / "metadata" / "snapshot.db"
        self.db_path.parent.mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_database(self, rows):
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                """
                CREATE TABLE ZCLOUDRECORDING (
                    ZPATH TEXT,
                    ZENCRYPTEDTITLE TEXT,
                    ZUNIQUEID TEXT,
                    ZDATE REAL,
                    ZDURATION REAL
                )
                """
            )
            db.executemany(
                "INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?)",
                rows,
            )

    @staticmethod
    def os_metadata(file_path):
        return {
            "created": datetime(2026, 8, 1, tzinfo=UTC),
            "modified": datetime(2026, 8, 1, tzinfo=UTC),
            "path": file_path,
            "size": 123,
        }

    def test_separate_database_and_audio_root_preserve_exact_utc_metadata(self):
        before = datetime(2026, 8, 23, 19, 59, tzinfo=UTC)
        target = datetime(2026, 8, 23, 20, 1, tzinfo=UTC)
        self.create_database([
            ("before.m4a", "Before", "uuid-before", apple_seconds(before), 1.0),
            ("target.m4a", "Target", "uuid-target", apple_seconds(target), 2.5),
        ])
        (self.root / "target.m4a").touch()
        importer = AppleVoiceMemosImporter(
            root=str(self.root),
            db_path=str(self.db_path),
            not_before=datetime(2026, 8, 23, 20, 0, tzinfo=UTC),
            code="apple_voicememos",
        )

        with (
            patch("discovery.call_resource", return_value=[]),
            patch("discovery.get_os_metadata", side_effect=self.os_metadata),
            patch("discovery.extract_device_info", return_value=None),
        ):
            discovered = list(importer.discover())

        self.assertEqual(len(discovered), 1)
        self.assertEqual(discovered[0]["path"], str(self.root / "target.m4a"))
        self.assertEqual(discovered[0]["voicememo"]["ZUNIQUEID"], "uuid-target")
        self.assertEqual(importer.get_start(discovered[0]), target)
        self.assertEqual(discovered[0]["duration"], 2.5)

    def test_existing_uuid_is_not_duplicated_from_backup_path(self):
        target = datetime(2026, 8, 24, tzinfo=UTC)
        self.create_database([
            ("backup.m4a", "Target", "same-uuid", apple_seconds(target), 2.5),
        ])
        (self.root / "backup.m4a").touch()
        importer = AppleVoiceMemosImporter(
            root=str(self.root),
            db_path=str(self.db_path),
            code="apple_voicememos",
        )
        existing = [{
            "path": "/live/recording.m4a",
            "voicememo": {"ZUNIQUEID": "same-uuid"},
        }]

        with patch("discovery.call_resource", return_value=existing):
            self.assertEqual(list(importer.discover()), [])

    def test_missing_database_is_reported_as_unavailable(self):
        importer = AppleVoiceMemosImporter(
            root=str(self.root),
            db_path=str(self.db_path),
            code="apple_voicememos",
        )

        with self.assertRaisesRegex(SourceUnavailableError, "database is unavailable"):
            list(importer.discover())

    def importer_for_records(self, records):
        target = datetime(2026, 8, 24, tzinfo=UTC)
        identities = sorted({record["voicememo"]["ZUNIQUEID"] for record in records})
        self.create_database([
            (f"{identity}.m4a", "Memo", identity, apple_seconds(target), 2.5)
            for identity in identities
        ])
        return AppleVoiceMemosImporter(
            root=str(self.root), db_path=str(self.db_path), code="apple_voicememos",
        )

    def test_large_catalog_is_not_rediscovered_across_cycles(self):
        records = [{
            "_id": index,
            "path": f"/live/{index}.m4a",
            "voicememo": {"ZUNIQUEID": f"uuid-{index}"},
            "ingested": True,
        } for index in range(1501)]
        importer = self.importer_for_records(records)
        mongo = MongoStub(records)
        with patch("discovery.call_resource", side_effect=mongo):
            self.assertEqual(importer.run(), 0)
            self.assertEqual(importer.run(), 0)
        self.assertEqual(len(mongo.records), 1501)
        self.assertEqual([call["action"] for call in mongo.calls], ["find"] * 4)

    def test_duplicates_cannot_hide_another_known_identity(self):
        records = [{
            "_id": index, "path": f"/old/{index}.m4a", "ingested": True,
            "voicememo": {"ZUNIQUEID": "duplicate" if index < 1001 else "tail"},
        } for index in range(1002)]
        importer = self.importer_for_records(records)
        mongo = MongoStub(records)
        with patch("discovery.call_resource", side_effect=mongo):
            self.assertEqual(importer.run(), 0)
        self.assertIn("Ambiguous", importer.last_warning)
        self.assertEqual(len(mongo.records), 1002)

    def test_pending_path_repair_preserves_identity_and_cached_error(self):
        source = {
            "_id": 1, "path": "/live/inaccessible.m4a", "ingested": False,
            "voicememo": {"ZUNIQUEID": "recover"},
            "ingestion": {"error": "permission denied"},
            "start": "original timestamp",
        }
        importer = self.importer_for_records([source])
        replacement = self.root / "recover.m4a"
        replacement.write_bytes(b"readable staged copy")
        mongo = MongoStub([source])
        with patch("discovery.call_resource", side_effect=mongo):
            self.assertEqual(importer.run(), 0)
            self.assertEqual(importer.run(), 0)
        self.assertEqual(mongo.records, [{**source, "path": str(replacement)}])
        updates = [call for call in mongo.calls if call["action"] == "updateOne"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["query"], {
            "_id": 1, "path": source["path"], "ingested": False,
            "voicememo.ZUNIQUEID": "recover",
        })

    def test_unreadable_replacement_keeps_pending_path_and_warns(self):
        source = {
            "_id": 1, "path": "/live/inaccessible.m4a", "ingested": False,
            "voicememo": {"ZUNIQUEID": "missing"},
        }
        importer = self.importer_for_records([source])
        mongo = MongoStub([source])
        with patch("discovery.call_resource", side_effect=mongo):
            self.assertEqual(importer.run(), 0)
        self.assertEqual(mongo.records, [source])
        self.assertIn("readable regular file", importer.last_warning)

    def test_path_repair_does_not_overwrite_concurrent_completion(self):
        source = {
            "_id": 1, "path": "/live/old.m4a", "ingested": False,
            "voicememo": {"ZUNIQUEID": "changed"},
        }
        replacement = self.root / "changed.m4a"
        replacement.touch()
        mongo = MongoStub([{**source, "ingested": True}])
        with patch("discovery.call_resource", side_effect=mongo):
            warning = AppleVoiceMemosImporter.repair_pending_path(source, str(replacement))
        self.assertIn("changed during path repair", warning)
        self.assertEqual(mongo.records[0]["path"], source["path"])

    def test_ambiguous_catalog_paths_do_not_rebind_or_create_sources(self):
        source = {
            "_id": 1, "path": "/live/old.m4a", "ingested": False,
            "voicememo": {"ZUNIQUEID": "ambiguous"},
        }
        importer = self.importer_for_records([source])
        with sqlite3.connect(self.db_path) as database:
            database.execute(
                "INSERT INTO ZCLOUDRECORDING "
                "SELECT 'alternate.m4a', ZENCRYPTEDTITLE, ZUNIQUEID, ZDATE, ZDURATION "
                "FROM ZCLOUDRECORDING"
            )
        for name in ("ambiguous.m4a", "alternate.m4a"):
            (self.root / name).write_bytes(b"audio")
        for existing in ([source], []):
            mongo = MongoStub(existing)
            with (
                self.subTest(existing=bool(existing)),
                patch("discovery.call_resource", side_effect=mongo),
            ):
                self.assertEqual(importer.run(), 0)
            self.assertEqual(mongo.records, existing)
            self.assertIn("Ambiguous Voice Memos catalog paths", importer.last_warning)
            self.assertTrue(all(call["action"] == "find" for call in mongo.calls))

    def test_repeated_identical_catalog_rows_repair_path_only_once(self):
        source = {
            "_id": 1, "path": "/live/old.m4a", "ingested": False,
            "voicememo": {"ZUNIQUEID": "same"},
        }
        importer = self.importer_for_records([source])
        with sqlite3.connect(self.db_path) as database:
            database.execute("INSERT INTO ZCLOUDRECORDING SELECT * FROM ZCLOUDRECORDING")
        (self.root / "same.m4a").write_bytes(b"audio")
        mongo = MongoStub([source])
        with patch("discovery.call_resource", side_effect=mongo):
            self.assertEqual(importer.run(), 0)
        self.assertIsNone(importer.last_warning)
        self.assertEqual(sum(call["action"] == "updateOne" for call in mongo.calls), 1)

    def test_missing_media_does_not_hide_other_catalog_entries(self):
        target = datetime(2026, 8, 24, tzinfo=UTC)
        self.create_database([
            ("missing.m4a", "Missing", "uuid-missing", apple_seconds(target), 1.0),
            ("present.m4a", "Present", "uuid-present", apple_seconds(target), 2.0),
        ])
        (self.root / "present.m4a").touch()
        importer = AppleVoiceMemosImporter(
            root=str(self.root),
            db_path=str(self.db_path),
            code="apple_voicememos",
        )

        def metadata(file_path):
            if file_path.endswith("missing.m4a"):
                raise FileNotFoundError(2, "No such file or directory", file_path)
            return self.os_metadata(file_path)

        with (
            patch("discovery.call_resource", return_value=[]),
            patch("discovery.get_os_metadata", side_effect=metadata),
            patch("discovery.extract_device_info", return_value=None),
        ):
            discovered = list(importer.discover())

        self.assertEqual([item["voicememo"]["ZUNIQUEID"] for item in discovered], [
            "uuid-present"
        ])
        self.assertIn("1 Voice Memos catalog entries", importer.last_warning)


if __name__ == "__main__":
    main()
