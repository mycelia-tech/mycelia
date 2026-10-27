"""Synthetic lost-response and cancellation contracts; never contact a backend."""
import json
import threading
from pathlib import Path
from sys import path
from unittest import TestCase
from unittest.mock import Mock, patch

from bson import ObjectId
from requests.exceptions import ConnectionError

path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib import resources
from lib.cancellation import ResourceCancelledError, job_cancel_event_var


class ResourceRetryTest(TestCase):
    def setUp(self):
        self.auth = patch("lib.resources.ensure_authorized").start()
        self.url = patch("lib.resources.get_url", return_value="https://fixture.invalid/api").start()
        self.session = Mock()
        patch("lib.resources.get_session", return_value=self.session).start()
        patch("lib.resources.time.sleep").start()
        self.addCleanup(patch.stopall)

    def test_lost_write_response_is_not_replayed(self):
        writes = []
        def committed_then_disconnected(*_args, **kwargs):
            writes.append(json.loads(kwargs["data"]))
            raise ConnectionError("response lost after commit")
        self.session.post.side_effect = committed_then_disconnected
        with self.assertRaises(ConnectionError):
            resources.call_resource("mongo", {"action": "insertOne", "doc": {"text": "fixture"}})
        self.assertEqual(len(writes), 1)
        self.assertEqual(self.session.post.call_args.kwargs["timeout"], (3.0, 30.0))

    def test_read_retries_but_cursor_does_not(self):
        response = Mock(text='{"found":true}')
        self.session.post.side_effect = [ConnectionError("transient"), response]
        self.assertEqual(resources.call_resource("mongo", {"action": "findOne"}), {"found": True})
        self.assertEqual(self.session.post.call_count, 2)
        self.session.post.reset_mock(side_effect=True)
        self.session.post.side_effect = ConnectionError("transient")
        with self.assertRaises(ConnectionError):
            resources.call_resource("mongo", {"action": "getMore", "cursorId": "fixture"})
        self.assertEqual(self.session.post.call_count, 1)

    def test_stable_insert_if_absent_has_one_effect_after_response_loss(self):
        rows = {}
        attempts = []
        def insert(*_args, **kwargs):
            body = json.loads(kwargs["data"], cls=resources.EJsonDecoder)
            rows.setdefault(str(body["query"]["_id"]), body["update"]["$setOnInsert"])
            attempts.append(True)
            if len(attempts) == 1:
                raise ConnectionError("response lost")
            return Mock(text='{"matchedCount":1}')
        self.session.post.side_effect = insert
        resources.call_resource("mongo", {
            "action": "updateOne", "query": {"_id": ObjectId()},
            "update": {"$setOnInsert": {"path": "/fixture/audio"}}, "options": {"upsert": True},
        })
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(rows), 1)

    def test_cancel_stops_retry_but_allows_one_shot_cleanup(self):
        event = threading.Event()
        reference = job_cancel_event_var.set(event)
        self.addCleanup(job_cancel_event_var.reset, reference)
        def disconnected(*_args, **_kwargs):
            event.set()
            raise ConnectionError("lost")
        self.session.post.side_effect = disconnected
        with self.assertRaises(ResourceCancelledError):
            resources.call_resource("mongo", {"action": "find"})
        self.assertEqual(self.session.post.call_count, 1)
        self.session.post.side_effect = None
        self.session.post.return_value = Mock(text='{"released":true}')
        self.assertEqual(resources.call_resource_once("mongo", {"action": "updateOne"}), {"released": True})
