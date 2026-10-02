"""Bridge contract tests: no live Apple files, credentials or Mongo writes."""
import hashlib
import json
import os
import shutil
import subprocess
import time
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from sys import path
from tempfile import TemporaryDirectory
from unittest import TestCase, main, skipUnless
from unittest.mock import patch

from bson import ObjectId
from fastapi.testclient import TestClient
from mongo_stub import MongoStub

path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_memos_bridge_server as bridge


class BridgeTest(TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory(dir="/private/tmp")))
        self.mongo = MongoStub([])
        self.chunks = {}
        self.processing_paths = []
        self.stack.enter_context(patch.dict(os.environ, {"MYCELIA_INGESTION_LOCK_DIR": str(self.root / "locks")}))
        self.stack.enter_context(patch.object(bridge, "backend_auth"))
        self.stack.enter_context(patch.object(bridge, "require_space"))
        self.stack.enter_context(patch.object(bridge, "call_resource", side_effect=self.resource))
        self.stack.enter_context(patch.object(bridge, "_index_ready", False))
        self.pairing = self.root / "pairing/pairing.json"
        self.client = self.stack.enter_context(TestClient(bridge.create_app(self.pairing), base_url="http://127.0.0.1:8012"))
        self.headers = {"Authorization": "Bearer " + json.loads(self.pairing.read_text())["token"]}
        self.audio = b"fixture audio bytes"
        self.recording = {"uuid": "ABCD-1234-5678", "filename": "memo.m4a", "apple_date": 800000000,
                          "duration": 0.5, "size": len(self.audio), "title": "Fixture"}

    def resource(self, name, body):
        if body["action"] == "createIndex":
            return "fixture"
        if body["collection"] == "audio_chunks":
            for operation in body["operations"]:
                item = operation["updateOne"]
                self.chunks.setdefault((str(item["filter"]["original_id"]), item["filter"]["index"]), item["update"]["$setOnInsert"])
            return {"ok": 1}
        return self.mongo(name, body)

    def prepare(self, retry=False, checksum=None):
        response = self.client.post("/imports", headers=self.headers, json={
            "recording": self.recording, "retry_error": retry,
            "sha256": checksum or hashlib.sha256(self.audio).hexdigest(),
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["id"]

    def upload(self, job_id):
        return self.client.post(f"/imports/{job_id}/audio", headers=self.headers, content=self.audio)

    def await_result(self, job_id):
        for _ in range(250):
            result = self.client.get(f"/imports/{job_id}", headers=self.headers).json()
            if result["state"] in bridge.TERMINAL:
                return result
            time.sleep(0.02)
        self.fail("Fixture importer did not finish")

    def test_pairing_auth_origin_host_and_read_only_status(self):
        self.assertEqual(self.pairing.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.client.get("/status").status_code, 401)
        self.assertEqual(self.client.get("/status", headers={**self.headers, "Origin": "https://evil.test"}).status_code, 403)
        self.assertEqual(self.client.get("/status", headers={**self.headers, "Host": "evil.test"}).status_code, 403)
        self.assertEqual(self.client.get("/status", headers=self.headers).status_code, 200)
        self.assertEqual(self.mongo.calls, [])

    def test_plan_is_projected_bounded_and_preserves_cached_errors(self):
        self.mongo.records = [{"_id": "existing", "voicememo": {"ZUNIQUEID": self.recording["uuid"]},
                               "ingested": False, "ingestion": {"error": "old failure"}}]
        result = self.client.post("/plan", headers=self.headers, json={"recordings": [self.recording]})
        self.assertEqual(result.json()[self.recording["uuid"]]["state"], "error")
        call = self.mongo.calls[-1]
        self.assertEqual(call["options"]["limit"], 1001)
        self.assertEqual(call["options"]["maxTimeMS"], 5000)
        self.assertIn("projection", call["options"])
        self.assertTrue(all(c["action"] == "find" for c in self.mongo.calls))

    def test_inventory_is_read_only_keyset_paged_and_includes_missing_sources(self):
        self.mongo.records = [{
            "_id": ObjectId(f"{i:024x}"), "voicememo": {"ZUNIQUEID": f"APPLE-{i:08}", "ZDATE": 800000000},
            "ingested": i % 2 == 0, "ingestion": {"error": "keep cached error"},
            "path": "/missing/original.m4a", "size": 1024,
        } for i in range(1, 103)]
        first = self.client.post("/inventory", headers=self.headers, json={})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(len(first.json()["records"]), 100)
        self.assertEqual(first.json()["next"], f"{100:024x}")
        second = self.client.post("/inventory", headers=self.headers, json={"after": first.json()["next"]})
        self.assertEqual(len(second.json()["records"]), 2)
        self.assertIsNone(second.json()["next"])
        self.assertEqual(second.json()["records"][0]["error"], "keep cached error")
        self.assertNotIn("path", second.json()["records"][0])
        for call in self.mongo.calls:
            self.assertEqual(call["action"], "find")
            self.assertEqual(call["options"]["hint"], "_id_")
            self.assertEqual(call["options"]["limit"], 101)
            self.assertEqual(call["options"]["maxTimeMS"], 5000)
            self.assertNotIn("data", call["options"]["projection"])
        self.assertEqual(self.client.post("/inventory", headers=self.headers, json={"after": "bad"}).status_code, 422)
        self.assertEqual(self.client.post("/inventory", json={}).status_code, 401)
        self.assertEqual(len(self.mongo.records), 102)

    def test_no_paths_oversized_requests_or_implicit_retries(self):
        variant = {**self.recording, "filename": "Apple-variant.caf"}
        self.assertEqual(self.client.post("/plan", headers=self.headers, json={"recordings": [variant]}).status_code, 200)
        invalid = {**self.recording, "filename": "../outside.m4a"}
        self.assertEqual(self.client.post("/plan", headers=self.headers, json={"recordings": [invalid]}).status_code, 422)
        self.assertEqual(self.client.post("/plan", headers=self.headers, content=b" " * (256 * 1024 + 1)).status_code, 413)
        self.mongo.records = [{"_id": "existing", "voicememo": {"ZUNIQUEID": self.recording["uuid"]},
                               "ingested": False, "ingestion": {"error": "old failure"}}]
        with patch.object(bridge, "ingest_source") as ingest:
            job_id = self.prepare()
            self.assertEqual(self.upload(job_id).status_code, 200)
            self.assertEqual(self.await_result(job_id)["state"], "failed")
            ingest.assert_not_called()
        self.assertEqual(self.mongo.records[0]["ingestion"]["error"], "old failure")

    def test_checksum_failure_never_creates_source(self):
        job_id = self.prepare(checksum="0" * 64)
        self.assertEqual(self.upload(job_id).status_code, 409)
        self.assertEqual(self.await_result(job_id)["state"], "failed")
        self.assertEqual(self.mongo.records, [])

    def test_one_recording_at_a_time_and_cancel_before_upload(self):
        job_id = self.prepare()
        response = self.client.post("/imports", headers=self.headers, json={
            "recording": self.recording, "sha256": hashlib.sha256(self.audio).hexdigest(),
        })
        self.assertEqual(response.status_code, 409)
        self.client.post(f"/imports/{job_id}/cancel", headers=self.headers)
        self.assertEqual(self.upload(job_id).status_code, 409)
        self.assertEqual(self.mongo.records, [])

    def test_existing_uuid_start_retry_and_acknowledgement(self):
        start = datetime(2026, 8, 24, tzinfo=UTC)
        self.mongo.records = [{"_id": "existing", "voicememo": {"ZUNIQUEID": self.recording["uuid"]},
                               "start": start, "ingested": False, "ingestion": {"error": "old failure"}}]
        def ingest(source, **kwargs):
            path = Path(source["path"])
            self.processing_paths.append(path.parent)
            self.assertEqual(path.read_bytes(), self.audio)
            self.assertEqual(source["_id"], "existing")
            self.assertEqual(source["start"], start)
            kwargs["progress_callback"]({"phase": "saving", "completed_chunks": 1, "total_chunks": 1})
            return 1
        with patch.object(bridge, "ingest_source", side_effect=ingest), patch.object(bridge, "extract_device_info", return_value=None):
            job_id = self.prepare(retry=True)
            self.upload(job_id)
            self.assertEqual(self.await_result(job_id)["state"], "imported")
            job_id = self.prepare()
            self.upload(job_id)
            self.assertEqual(self.await_result(job_id)["state"], "already_imported")
        self.assertEqual(len(self.processing_paths), 1)
        self.assertFalse(self.processing_paths[0].exists())
        self.assertTrue(self.mongo.records[0]["ingested"])
        self.assertNotIn("ingestion", self.mongo.records[0])
        self.assertEqual(len(self.mongo.records), 1)

    def test_changed_partial_bytes_fail_closed(self):
        self.mongo.records = [{"_id": "existing", "voicememo": {"ZUNIQUEID": self.recording["uuid"]},
                               "ingested": False, "bridge_pending_sha256": "0" * 64}]
        with patch.object(bridge, "ingest_source") as ingest:
            job_id = self.prepare(); self.upload(job_id)
            self.assertEqual(self.await_result(job_id)["state"], "failed")
            ingest.assert_not_called()

    def test_processing_cancel_cleans_input_without_caching_error(self):
        seen = []
        def cancelled(source, **kwargs):
            seen.append(Path(source["path"]).parent)
            raise bridge.Cancelled("Paused fixture")
        with patch.object(bridge, "ingest_source", side_effect=cancelled):
            job_id = self.prepare(); self.upload(job_id)
            self.assertEqual(self.await_result(job_id)["state"], "cancelled")
        self.assertFalse(seen[0].exists())
        self.assertFalse(self.mongo.records[0]["ingested"])
        self.assertNotIn("ingestion", self.mongo.records[0])

    @skipUnless(shutil.which("ffmpeg"), "ffmpeg is needed for the real Opus fixture")
    def test_real_ffmpeg_same_chunks_and_original_preserved(self):
        source = self.root / "fixture.m4a"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.3", "-c:a", "aac", str(source)], check=True)
        self.audio = source.read_bytes(); self.recording["size"] = len(self.audio)
        job_id = self.prepare(); self.upload(job_id)
        result = self.await_result(job_id)
        self.assertEqual(result["state"], "imported", result)
        self.assertGreater(result["encoded_seconds"], 0)
        self.assertGreater(result["encoding_elapsed_seconds"], 0)
        self.assertGreater(result["encoding_updated_at"], 0)
        self.assertEqual(result["duration_seconds"], self.recording["duration"])
        self.assertGreater(result["completed_chunks"], 0)
        self.assertEqual(len(self.chunks), result["completed_chunks"])
        self.assertEqual(source.read_bytes(), self.audio)
        document = self.mongo.records[0]
        self.assertNotIn("path", document)
        self.assertEqual(document["voicememo"]["ZUNIQUEID"], self.recording["uuid"])
        self.assertEqual(document["start"].timestamp(), self.recording["apple_date"] + 978307200)


if __name__ == "__main__":
    main()
