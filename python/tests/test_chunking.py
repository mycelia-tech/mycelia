from datetime import UTC, datetime, timedelta
from pathlib import Path
from subprocess import CalledProcessError
from sys import path
from tempfile import TemporaryDirectory, mkdtemp
from unittest import TestCase, main
from unittest.mock import patch

path.insert(0, str(Path(__file__).resolve().parents[1]))

import chunking


class SplitToOpusChunksTest(TestCase):
    def test_retry_removes_files_left_by_an_interrupted_attempt(self):
        with TemporaryDirectory() as temp_dir:
            staging = Path(temp_dir) / "chunks"
            staging.mkdir()
            stale_chunk = staging / "0000000000.opus"
            stale_chunk.write_bytes(b"stale")

            with (
                patch("chunking.get_tmp_dir", return_value=str(staging)),
                patch("chunking.subprocess.run") as run,
            ):
                chunks = chunking.split_to_opus_chunks("recording.m4a")

            run.assert_called_once()
            self.assertEqual(chunks, [])
            self.assertFalse(stale_chunk.exists())

    def test_permission_failure_preserves_ffmpeg_diagnostic_and_guidance(self):
        failure = CalledProcessError(
            255,
            ["ffmpeg"],
            stderr="Error opening input: Operation not permitted",
        )

        with (
            TemporaryDirectory() as temp_dir,
            patch("chunking.get_tmp_dir", return_value=temp_dir),
            patch("chunking.subprocess.run", side_effect=failure),
            self.assertRaisesRegex(
                RuntimeError,
                "macOS denied access.*staging archive",
            ),
        ):
            chunking.split_to_opus_chunks("recording.m4a")


class IngestSourceTest(TestCase):
    def test_chunks_are_upserted_in_bounded_bulk_writes(self):
        staging = Path(mkdtemp())
        chunk_files = []
        for index in range(chunking.CHUNK_WRITE_BATCH_SIZE + 1):
            chunk_file = staging / f"{index:010d}.opus"
            chunk_file.write_bytes(f"chunk-{index}".encode())
            chunk_files.append((timedelta(seconds=index * 10), str(chunk_file)))

        source = {
            "_id": "source-1",
            "path": "/backup/recording.m4a",
            "start": datetime(2026, 8, 24, tzinfo=UTC),
        }
        with (
            patch("chunking.get_tmp_dir", return_value=str(staging)),
            patch("chunking.split_to_opus_chunks", return_value=chunk_files),
            patch("chunking.call_resource") as call_resource,
        ):
            chunking.ingest_source(source)

        self.assertEqual(call_resource.call_count, 2)
        first = call_resource.call_args_list[0].args[1]
        second = call_resource.call_args_list[1].args[1]
        self.assertEqual(first["action"], "bulkWrite")
        self.assertEqual(len(first["operations"]), chunking.CHUNK_WRITE_BATCH_SIZE)
        self.assertEqual(len(second["operations"]), 1)
        self.assertTrue(first["operations"][0]["updateOne"]["upsert"])
        self.assertEqual(
            first["operations"][0]["updateOne"]["filter"],
            {"original_id": "source-1", "index": 0},
        )
        self.assertFalse(staging.exists())


if __name__ == "__main__":
    main()
