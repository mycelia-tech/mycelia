from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import SHUT_RDWR
from sys import path
from threading import Thread
from unittest import TestCase, main
from unittest.mock import patch

import requests
from bson import ObjectId

path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.diarization_runtime import (  # noqa: E402
    DIARIZATION_RECORDING_LEASE_COLLECTION,
    DIARIZATION_RECORDING_LEASE_SECONDS,
    RecordingLease,
    acquire_recording_lease,
    aggregate_stage_timings,
    new_provider_session,
    parse_diarization_recording_lease_seconds,
    release_recording_lease,
    release_recording_leases,
    renew_recording_lease,
)
from lib.api import job_session_var, job_token_var  # noqa: E402
from lib.resources import call_resource_once  # noqa: E402


@contextmanager
def provider_http_server():
    observed = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            observed.append({
                # Retain the socket object so identity cannot be recycled.
                "connection": self.connection,
                "connection_header": self.headers.get("Connection"),
                "authorization": self.headers.get("Authorization"),
                "cookie": self.headers.get("Cookie"),
                "body": body,
            })
            if self.path == "/disconnect":
                self.close_connection = True
                self.connection.shutdown(SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", observed
        finally:
            server.shutdown()
            thread.join(timeout=2)


class DiarizationRuntimeTest(TestCase):
    def test_provider_posts_use_separate_connections_without_job_credentials(self):
        with requests.Session() as backend:
            backend.headers["Authorization"] = "Bearer test-mycelia-job-token"
            backend.cookies.set("mycelia-session", "test-session")
            session_context = job_session_var.set(backend)
            token_context = job_token_var.set("test-mycelia-job-token")
            try:
                with provider_http_server() as (url, observed), new_provider_session() as provider:
                    # Keep the loopback test independent of proxy/netrc settings.
                    provider.trust_env = False
                    for scheme in ("http://", "https://"):
                        adapter = provider.get_adapter(scheme)
                        self.assertEqual(adapter._pool_connections, 1)
                        self.assertEqual(adapter._pool_maxsize, 1)
                        self.assertEqual(adapter.max_retries.total, 0)
                    for _ in range(2):
                        response = provider.post(
                            url + "/diarize", data=b"test-audio", timeout=(1, 1),
                        )
                        response.raise_for_status()
                    self.assertEqual(len(observed), 2)
                    self.assertIsNot(observed[0]["connection"], observed[1]["connection"])
                    for request in observed:
                        self.assertEqual(request["connection_header"], "close")
                        self.assertIsNone(request["authorization"])
                        self.assertIsNone(request["cookie"])
            finally:
                job_session_var.reset(session_context)
                job_token_var.reset(token_context)

    def test_provider_disconnect_after_post_is_not_retried(self):
        with provider_http_server() as (url, observed), new_provider_session() as provider:
            provider.trust_env = False
            with self.assertRaises(requests.ConnectionError):
                provider.post(url + "/disconnect", data=b"test-audio", timeout=(1, 1))
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0]["body"], b"test-audio")

    def test_bounded_resource_call_uses_one_short_attempt(self):
        session = requests.Session()
        with (
            patch("lib.resources.ensure_authorized"),
            patch("lib.resources.get_session", return_value=session),
            patch.object(
                session,
                "post",
                side_effect=requests.Timeout("backend unavailable"),
            ) as post,
        ):
            with self.assertRaises(requests.Timeout):
                call_resource_once("mongo", {"action": "find"})

        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs["timeout"], (3.0, 10.0))

    def test_recording_lease_seconds_is_strict_and_never_below_ttl_floor(self):
        self.assertEqual(parse_diarization_recording_lease_seconds("600"), 600)
        self.assertEqual(parse_diarization_recording_lease_seconds("900"), 900)
        for value in ("", "599", "600.0", " 600", "invalid"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_diarization_recording_lease_seconds(value)

    def test_acquire_uses_original_id_key_and_aba_token_with_ten_minute_ttl(self):
        original_id = ObjectId()

        def resource(_name, request):
            return {
                "_id": original_id,
                "owner": "worker-1",
                "token": "token-1",
            }

        with patch(
            "lib.diarization_runtime.call_resource",
            side_effect=resource,
        ) as call:
            lease = acquire_recording_lease(
                original_id,
                "worker-1",
                token="token-1",
                job_id="job-1",
                campaign_id="campaign-1",
            )

        self.assertIsNotNone(lease)
        request = call.call_args.args[1]
        self.assertEqual(request["collection"], DIARIZATION_RECORDING_LEASE_COLLECTION)
        self.assertEqual(request["query"]["_id"], original_id)
        self.assertIn(
            {"owner": "worker-1", "token": "token-1"},
            request["query"]["$or"],
        )
        self.assertTrue(request["options"]["upsert"])
        self.assertEqual(
            request["update"]["$set"]["expiresAt"]
            - request["update"]["$set"]["updatedAt"],
            timedelta(seconds=DIARIZATION_RECORDING_LEASE_SECONDS),
        )

    def test_duplicate_key_means_active_recording_lease_is_busy(self):
        with patch(
            "lib.diarization_runtime.call_resource",
            side_effect=RuntimeError("E11000 duplicate key error"),
        ):
            lease = acquire_recording_lease(
                ObjectId(),
                "worker-1",
                token="token-1",
            )

        self.assertIsNone(lease)

    def test_conflict_response_means_active_recording_lease_is_busy(self):
        response = requests.Response()
        response.status_code = 409
        response._content = b'{"code":"diarization_recording_lease_busy"}'
        error = requests.HTTPError("Conflict", response=response)

        with patch(
            "lib.diarization_runtime.call_resource",
            side_effect=error,
        ):
            lease = acquire_recording_lease(
                ObjectId(),
                "worker-1",
                token="token-1",
            )

        self.assertIsNone(lease)

    def test_unrelated_conflict_is_not_misreported_as_lease_contention(self):
        response = requests.Response()
        response.status_code = 409
        response._content = b'{"code":"some_other_conflict"}'
        error = requests.HTTPError("Conflict", response=response)

        with patch(
            "lib.diarization_runtime.call_resource",
            side_effect=error,
        ):
            with self.assertRaises(requests.HTTPError):
                acquire_recording_lease(
                    ObjectId(),
                    "worker-1",
                    token="token-1",
                )

    def test_server_error_with_duplicate_text_is_not_lease_contention(self):
        response = requests.Response()
        response.status_code = 500
        response._content = (
            b'{"code":"diarization_recording_lease_busy",'
            b'"error":"E11000 duplicate key"}'
        )
        error = requests.HTTPError("Server error", response=response)

        with patch(
            "lib.diarization_runtime.call_resource",
            side_effect=error,
        ):
            with self.assertRaises(requests.HTTPError):
                acquire_recording_lease(
                    ObjectId(),
                    "worker-1",
                    token="token-1",
                )

    def test_renew_and_release_require_the_exact_owner_and_token(self):
        original_id = ObjectId()
        lease = RecordingLease(
            original_id=original_id,
            owner="worker-1",
            token="token-1",
            expires_at=datetime.now(tz=timezone.utc),
        )
        requests = []

        def resource(_name, request):
            requests.append(request)
            if request["action"] == "findOneAndUpdate":
                return {"owner": lease.owner, "token": lease.token}
            return {"deletedCount": 1}

        with patch(
            "lib.diarization_runtime.call_resource",
            side_effect=resource,
        ):
            renewed = renew_recording_lease(lease, minimum_seconds=900)
            released = release_recording_lease(renewed)

        self.assertIsNotNone(renewed)
        renew_query = requests[0]["query"]
        release_query = requests[1]["query"]
        expected_identity = {
            "_id": original_id,
            "owner": "worker-1",
            "token": "token-1",
        }
        self.assertEqual(
            {key: renew_query[key] for key in expected_identity},
            expected_identity,
        )
        self.assertEqual(release_query, expected_identity)
        self.assertTrue(released)
        self.assertGreaterEqual(
            (
                requests[0]["update"]["$set"]["expiresAt"]
                - requests[0]["update"]["$set"]["updatedAt"]
            ).total_seconds(),
            900,
        )

    def test_stage_samples_aggregate_count_total_average_and_max(self):
        aggregate = {}

        aggregate_stage_timings(aggregate, {"provider": 100.0})
        aggregate_stage_timings(aggregate, {"provider": 300.0})

        self.assertEqual(
            aggregate["provider"],
            {"count": 2, "total": 400.0, "avg": 200.0, "max": 300.0},
        )

    def test_batch_release_keeps_each_aba_identity_in_one_request(self):
        leases = [
            RecordingLease(
                original_id=ObjectId(),
                owner="worker-1",
                token=f"token-{index}",
                expires_at=datetime.now(tz=timezone.utc),
            )
            for index in range(2)
        ]

        with patch(
            "lib.diarization_runtime.call_resource",
            return_value={"deletedCount": 2},
        ) as call:
            deleted = release_recording_leases(leases)

        self.assertEqual(deleted, 2)
        request = call.call_args.args[1]
        self.assertEqual(request["action"], "deleteMany")
        self.assertEqual(
            request["query"]["$or"],
            [
                {
                    "_id": lease.original_id,
                    "owner": lease.owner,
                    "token": lease.token,
                }
                for lease in leases
            ],
        )


if __name__ == "__main__":
    main()
