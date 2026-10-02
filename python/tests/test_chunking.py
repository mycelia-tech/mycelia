from datetime import UTC, datetime, timedelta
from pathlib import Path
from subprocess import CalledProcessError
from sys import path
from tempfile import TemporaryDirectory, mkdtemp
from unittest import TestCase, main
from unittest.mock import Mock, patch

path.insert(0, str(Path(__file__).resolve().parents[1]))

import chunking


class SplitToOpusChunksTest(TestCase):
    def test_encoding_progress_is_bounded_and_tracks_audio_not_heartbeat(self):
        callback = Mock()
        tracker = chunking.EncodingProgress(callback)
        with patch("chunking.time.time", return_value=100):
            tracker.feed(b"out_time_us=1500")
            tracker.feed(b"000\nspeed=2.5x\nprogress=continue\n")
        tracker.report(force=True)
        result = callback.call_args.args[0]
        self.assertEqual(result["encoded_seconds"], 1.5)
        self.assertEqual(result["encoding_speed"], 2.5)
        self.assertEqual(result["encoding_updated_at"], 100)
        with patch("chunking.time.time", return_value=200):
            tracker.feed(b"out_time_us=500000\nspeed=N/A\nout_time_us=nan\n")
            tracker.report(force=True)
        self.assertEqual(callback.call_args.args[0]["encoding_updated_at"], 100)
        self.assertEqual(callback.call_args.args[0]["encoded_seconds"], 1.5)
        with self.assertRaisesRegex(RuntimeError, "safety limit"):
            tracker.feed(b"x" * 65537)

    def test_bridge_cancellation_terminates_ffmpeg(self):
        process = Mock()
        process.poll.return_value = None
        with TemporaryDirectory() as root:
            staging = str(Path(root) / "chunks")
            with patch("chunking.subprocess.Popen", return_value=process), self.assertRaisesRegex(RuntimeError, "paused"):
                chunking.split_to_opus_chunks(
                    "fixture.m4a", work_dir=staging,
                    cancel_check=Mock(side_effect=RuntimeError("paused")),
                )
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)

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
