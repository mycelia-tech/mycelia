import json
import os
import shlex
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPOSITORY_ROOT / "scripts/refresh-voice-memos-staging.sh"


class VoiceMemosStagingScriptTest(TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.archive_tool = self.root / "archive-tool"
        self.archive_root = self.root / "archive"
        self.staging_root = self.root / "staging"
        self.command_log = self.root / "commands.log"
        self.target_log = self.root / "targets.log"

        scripts = self.archive_tool / "scripts"
        scripts.mkdir(parents=True)
        (scripts / "common.sh").write_text(
            '#!/usr/bin/env bash\n'
            'TOOL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
            'load_config() {\n'
            '  local config_path="${ICLOUD_ARCHIVE_CONFIG:-$TOOL_ROOT/config.env}"\n'
            '  if [[ -f "$config_path" ]]; then source "$config_path"; fi\n'
            '  ARCHIVE_TARGET="${ARCHIVE_TARGET:-/missing-default-archive}"\n'
            '}\n',
            encoding="utf-8",
        )
        load_config = (
            'source "$(dirname "${BASH_SOURCE[0]}")/common.sh"\n'
            'load_config\n'
            'printf "%s\\n" "$ARCHIVE_TARGET" >> "$VOICE_TEST_TARGET_LOG"\n'
        )
        (scripts / "run.sh").write_text(
            '#!/usr/bin/env bash\n' + load_config
            + 'printf "run:%s\\n" "$*" >> "$VOICE_TEST_LOG"\n',
            encoding="utf-8",
        )
        (scripts / "verify.sh").write_text(
            '#!/usr/bin/env bash\n' + load_config
            + 'printf "verify:%s\\n" "$*" >> "$VOICE_TEST_LOG"\n',
            encoding="utf-8",
        )
        (
            self.archive_root / "data/voice-memos/audio-original"
        ).mkdir(parents=True)

        self.environment = {
            **os.environ,
            "HOME": str(self.root / "home"),
            "ICLOUD_ARCHIVE_TOOL_ROOT": str(self.archive_tool),
            "ICLOUD_ARCHIVE_CONFIG": str(self.archive_tool / "config.env"),
            "ARCHIVE_TARGET": str(self.archive_root),
            "MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT": str(self.archive_root),
            "MYCELIA_VOICE_MEMOS_STAGING_ROOT": str(self.staging_root),
            "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE": "2001-01-01T00:00:00+00:00",
            "VOICE_TEST_LOG": str(self.command_log),
            "VOICE_TEST_TARGET_LOG": str(self.target_log),
        }

    def tearDown(self):
        self.temporary_directory.cleanup()

    def add_completed_snapshot(self, run_id: str, *, valid: bool = True) -> Path:
        manifest = self.archive_root / "manifests" / run_id
        manifest.mkdir(parents=True)
        (manifest / "run.json").write_text(
            json.dumps({"completed": True, "components": ["voice-memos"]}),
            encoding="utf-8",
        )
        (manifest / "voice-memos.json").write_text(
            json.dumps({"sqlite_snapshots": ["CloudRecordings.snapshot.db"]}),
            encoding="utf-8",
        )
        snapshot = (
            self.archive_root
            / "data/voice-memos/native-metadata/snapshots"
            / run_id
            / "CloudRecordings.snapshot.db"
        )
        snapshot.parent.mkdir(parents=True)
        if valid:
            with sqlite3.connect(snapshot) as database:
                database.execute("CREATE TABLE marker (value TEXT NOT NULL)")
                database.execute("INSERT INTO marker VALUES (?)", (run_id,))
                database.execute(
                    "CREATE TABLE ZCLOUDRECORDING (ZPATH TEXT, ZDATE REAL)"
                )
                database.execute(
                    "INSERT INTO ZCLOUDRECORDING VALUES (?, ?)",
                    ("memo.m4a", 1.0),
                )
            (
                self.archive_root
                / "data/voice-memos/audio-original/memo.m4a"
            ).write_bytes(b"voice memo fixture")
        else:
            snapshot.write_bytes(b"not a SQLite database")
        return snapshot

    def run_script(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPT), *arguments],
            cwd=REPOSITORY_ROOT,
            env=self.environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_publish_latest_verifies_and_atomically_publishes_snapshot(self):
        source = self.add_completed_snapshot("20260901T120000Z-1")

        result = self.run_script("--publish-latest")

        self.assertEqual(result.returncode, 0, result.stderr)
        published = self.staging_root / "CloudRecordings.snapshot.db"
        self.assertTrue(published.is_file())
        self.assertEqual(
            (self.staging_root / "audio-original/memo.m4a").read_bytes(),
            b"voice memo fixture",
        )
        with sqlite3.connect(published) as database:
            self.assertEqual(
                database.execute("SELECT value FROM marker").fetchone(),
                ("20260901T120000Z-1",),
            )
        status = json.loads(
            (self.staging_root / "sync-status.json").read_text(encoding="utf-8")
        )
        self.assertEqual(status["source_snapshot"], str(source))
        self.assertEqual(status["staged_audio_files"], 1)
        self.assertEqual(len(status["snapshot_sha256"]), 64)
        self.assertEqual(
            self.command_log.read_text(encoding="utf-8").strip(),
            "verify:--components voice-memos --full",
        )

    def test_invalid_new_snapshot_does_not_replace_last_good_database(self):
        self.add_completed_snapshot("20260901T120000Z-1")
        first = self.run_script("--publish-latest")
        self.assertEqual(first.returncode, 0, first.stderr)
        published = self.staging_root / "CloudRecordings.snapshot.db"
        original_bytes = published.read_bytes()

        self.add_completed_snapshot("20260901T130000Z-2", valid=False)
        second = self.run_script("--publish-latest")

        self.assertNotEqual(second.returncode, 0)
        self.assertIn("not a database", second.stderr)
        self.assertEqual(published.read_bytes(), original_bytes)

    def test_archive_mismatch_stops_every_mode_before_archive_commands(self):
        self.add_completed_snapshot("20260910T120000Z-1")
        other_archive = self.root / "other archive"
        other_archive.mkdir()
        for configured_in_file in (False, True):
            if configured_in_file:
                # A config file overrides even a matching exported target.
                self.environment["ARCHIVE_TARGET"] = str(self.archive_root)
                Path(self.environment["ICLOUD_ARCHIVE_CONFIG"]).write_text(
                    f"ARCHIVE_TARGET={shlex.quote(str(other_archive))}\n",
                    encoding="utf-8",
                )
            else:
                self.environment["ARCHIVE_TARGET"] = str(other_archive)
            for arguments in ((), ("--apply",), ("--publish-latest",)):
                with self.subTest(config_file=configured_in_file, mode=arguments):
                    result = self.run_script(*arguments)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("archive mismatch", result.stderr)
                    self.assertFalse(self.command_log.exists())
                    self.assertFalse(self.staging_root.exists())
                    self.assertEqual(list(other_archive.iterdir()), [])

    def test_effective_config_target_is_used_for_refresh_and_verification(self):
        self.add_completed_snapshot("20260910T120000Z-1")
        config = self.root / "custom archive config.env"
        config.write_text(
            f"ARCHIVE_TARGET={shlex.quote(str(self.archive_root))}\n",
            encoding="utf-8",
        )
        self.environment["ICLOUD_ARCHIVE_CONFIG"] = str(config)
        self.environment["ARCHIVE_TARGET"] = str(self.root / "stale-environment")
        result = self.run_script("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target_log.read_text().splitlines(), [
            str(self.archive_root), str(self.archive_root),
        ])
        self.assertEqual(self.command_log.read_text().splitlines(), [
            "run:--execute --components voice-memos",
            "verify:--components voice-memos --full",
        ])
        self.assertTrue((self.staging_root / "CloudRecordings.snapshot.db").is_file())

    def test_equivalent_archive_paths_are_accepted(self):
        self.add_completed_snapshot("20260910T120000Z-1")
        alias = self.root / "archive alias"
        alias.symlink_to(self.archive_root, target_is_directory=True)
        self.environment["ARCHIVE_TARGET"] = str(alias)
        result = self.run_script("--publish-latest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.staging_root / "CloudRecordings.snapshot.db").is_file())

    def publish_with_capacity(self, snapshot, free_bytes):
        # Execute the exact embedded publisher against fixtures, replacing only
        # disk capacity; never mock away file copies, hashes, or SQLite checks.
        publisher = SCRIPT.read_text().split('"${staging_not_before}" <<\'PY\'\n', 1)[1].split("\nPY\n", 1)[0]
        arguments = [
            "publisher", str(snapshot),
            str(self.staging_root / "CloudRecordings.snapshot.db"),
            str(self.staging_root / "sync-status.json"),
            str(self.archive_root / "data/voice-memos/audio-original"),
            str(self.staging_root / "audio-original"),
            self.environment["MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE"],
        ]
        with (
            patch("sys.argv", arguments),
            patch("os.statvfs", return_value=SimpleNamespace(f_bavail=free_bytes, f_frsize=1)),
        ):
            exec(compile(publisher, str(SCRIPT), "exec"), {"__name__": "__test__"})  # noqa: S102 - repository publisher, isolated fixtures
        return json.loads((self.staging_root / "sync-status.json").read_text())

    def test_unchanged_audio_needs_only_snapshot_and_headroom(self):
        snapshot = self.add_completed_snapshot("20260901T120000Z-1")
        self.publish_with_capacity(snapshot, 2**32)
        status = self.publish_with_capacity(snapshot, 2**30 + snapshot.stat().st_size)
        self.assertEqual(status["copied_audio_files"], 0)
        self.assertEqual(status["reused_audio_files"], 1)

    def test_staged_symlink_is_materialized_instead_of_reused(self):
        snapshot = self.add_completed_snapshot("20260901T120000Z-1")
        archived = self.archive_root / "data/voice-memos/audio-original/memo.m4a"
        staged = self.staging_root / "audio-original/memo.m4a"
        staged.parent.mkdir(parents=True)
        staged.symlink_to(archived)
        original_bytes = archived.read_bytes()
        required = 2**30 + snapshot.stat().st_size + archived.stat().st_size
        with self.assertRaisesRegex(SystemExit, "Insufficient free space"):
            self.publish_with_capacity(snapshot, required - 1)
        self.assertTrue(staged.is_symlink())
        status = self.publish_with_capacity(snapshot, required)
        self.assertFalse(staged.is_symlink())
        self.assertEqual(status["reused_audio_files"], 0)
        self.assertEqual(status["copied_audio_files"], 1)
        self.assertEqual(archived.read_bytes(), original_bytes)
        archived.rename(archived.with_suffix(".offline"))
        self.assertEqual(staged.read_bytes(), original_bytes)

    def test_symlinked_audio_directory_is_rejected_before_writing(self):
        snapshot = self.add_completed_snapshot("20260901T120000Z-1")
        outside = self.root / "outside"
        outside.mkdir()
        audio = self.staging_root / "audio-original"
        self.staging_root.mkdir()
        for nested in (False, True):
            with self.subTest(nested=nested):
                if nested:
                    audio.mkdir()
                    link = audio / "nested"
                    with sqlite3.connect(snapshot) as database:
                        database.execute("UPDATE ZCLOUDRECORDING SET ZPATH = 'nested/memo.m4a'")
                else:
                    link = audio
                link.symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(SystemExit, "symbolic link"):
                    self.publish_with_capacity(snapshot, 2**32)
                self.assertEqual(list(outside.iterdir()), [])
                self.assertFalse((self.staging_root / "CloudRecordings.snapshot.db").exists())
                link.unlink()

    def test_incremental_copy_budgets_only_new_audio_and_deduplicates_paths(self):
        snapshot = self.add_completed_snapshot("20260901T120000Z-1")
        audio = self.archive_root / "data/voice-memos/audio-original"
        (audio / "memo.m4a").write_bytes(b"existing" * 1024)
        self.publish_with_capacity(snapshot, 2**32)
        (audio / "new.m4a").write_bytes(b"new")
        with sqlite3.connect(snapshot) as database:
            database.executemany(
                "INSERT INTO ZCLOUDRECORDING VALUES (?, ?)",
                [("new.m4a", 2.0), ("new.m4a", 3.0)],
            )
        status = self.publish_with_capacity(snapshot, 2**30 + snapshot.stat().st_size + 3)
        self.assertEqual(status["copied_audio_files"], 1)
        self.assertEqual(status["copied_audio_bytes"], 3)
        self.assertEqual(status["reused_audio_files"], 1)
        self.assertEqual(status["staged_audio_files"], 2)

    def test_same_size_hash_mismatch_requires_copy_space_and_preserves_snapshot_on_failure(self):
        snapshot = self.add_completed_snapshot("20260901T120000Z-1")
        audio = self.archive_root / "data/voice-memos/audio-original/memo.m4a"
        self.publish_with_capacity(snapshot, 2**32)
        published = self.staging_root / "CloudRecordings.snapshot.db"
        before = published.read_bytes()
        staged = self.staging_root / "audio-original/memo.m4a"
        staged_before = staged.read_bytes()
        audio.write_bytes(b"x" * len(staged_before))
        required = 2**30 + snapshot.stat().st_size + audio.stat().st_size
        with self.assertRaisesRegex(SystemExit, "Insufficient free space"):
            self.publish_with_capacity(snapshot, required - 1)
        self.assertEqual(published.read_bytes(), before)
        self.assertEqual(staged.read_bytes(), staged_before)
        self.assertEqual(list(self.staging_root.rglob("*.tmp-*")), [])
        status = self.publish_with_capacity(snapshot, required)
        self.assertEqual(status["copied_audio_files"], 1)
        self.assertEqual(status["reused_audio_files"], 0)
        self.assertEqual(staged.read_bytes(), audio.read_bytes())


if __name__ == "__main__":
    main()
