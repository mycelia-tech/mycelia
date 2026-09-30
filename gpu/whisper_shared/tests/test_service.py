import asyncio
import threading
import time
import unittest
from types import SimpleNamespace

import httpx
from scheduler import Scheduler, current_job
from service import create_app


class Backend:
    def __init__(self):
        self.scheduler = Scheduler(1)
        self.lease = SimpleNamespace(state="loaded")
        self.started, self.release = threading.Event(), threading.Event()
        self.calls = []
        self.live_token = "internal-test-token"
        self.batch_timeout = self.live_timeout = 5
        self.ready = True

    def process(self, file, encode, detect, options, output):
        self.calls.append(
            (current_job.get().priority, file.read(), encode, options, output)
        )
        self.started.set()
        self.release.wait(5)
        current_job.get().check()
        return '{"text":"hello","language":"en","segments":[]}'


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.backend = Backend()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.backend)),
            base_url="http://test",
        )

    async def asyncTearDown(self):
        self.backend.release.set()
        await self.client.aclose()

    async def request(self, headers=None):
        return await self.client.post(
            "/asr?output=json&language=en&initial_prompt=hint&word_timestamps=true&vad_filter=true",
            files={"audio_file": ("sample.wav", b"whole file")},
            headers=headers or {},
        )

    async def wait_started(self):
        self.assertTrue(await asyncio.to_thread(self.backend.started.wait, 2))

    async def test_event_loop_responsive_bound_and_native_api_options(self):
        task = asyncio.create_task(self.request())
        await self.wait_started()
        health = await asyncio.wait_for(self.client.get("/health"), 1)
        self.assertEqual(health.status_code, 200)
        self.assertEqual((await self.request()).status_code, 503)
        self.backend.release.set()
        response = await task
        self.assertEqual(response.json()["text"], "hello")
        self.assertEqual(response.headers["asr-engine"], "faster_whisper")
        priority, audio, encode, options, output = self.backend.calls[0]
        self.assertEqual(
            (priority, audio, encode, output), ("batch", b"whole file", True, "json")
        )
        self.assertEqual(
            options,
            {
                "task": "transcribe",
                "language": "en",
                "initial_prompt": "hint",
                "vad_filter": True,
                "word_timestamps": True,
            },
        )

    async def test_trusted_priority_and_authenticated_drain(self):
        self.backend.release.set()
        await self.request({"X-ASR-Priority": "live", "X-ASR-Live-Token": "wrong"})
        await self.request(
            {"X-ASR-Priority": "live", "X-ASR-Live-Token": self.backend.live_token}
        )
        self.assertEqual([call[0] for call in self.backend.calls], ["batch", "live"])
        self.assertEqual((await self.client.post("/scheduler/drain")).status_code, 401)
        auth = {"Authorization": "Bearer " + self.backend.live_token}
        self.assertEqual(
            (await self.client.post("/scheduler/drain", headers=auth)).status_code, 200
        )
        self.assertEqual((await self.request()).status_code, 503)
        await self.client.post("/scheduler/resume", headers=auth)
        self.assertEqual((await self.request()).status_code, 200)

    async def test_request_cancellation_holds_admission_until_worker_returns(self):
        task = asyncio.create_task(self.request())
        await self.wait_started()
        task.cancel()
        await asyncio.sleep(0)
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 1)
        self.backend.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 0)

    async def test_deadline_cleans_up_after_nonpreemptible_work(self):
        self.backend.batch_timeout = 0.01
        task = asyncio.create_task(self.request())
        await self.wait_started()
        await asyncio.sleep(0.15)
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 1)
        self.backend.release.set()
        self.assertEqual((await task).status_code, 504)
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 0)

    async def test_transport_disconnect_cancels_and_releases_admission(self):
        app = create_app(self.backend)
        payload = (
            b'--boundary\r\nContent-Disposition: form-data; name="audio_file"; filename="a.wav"'
            b"\r\nContent-Type: audio/wav\r\n\r\naudio\r\n--boundary--\r\n"
        )
        messages = asyncio.Queue()
        await messages.put(
            {"type": "http.request", "body": payload, "more_body": False}
        )
        sent = []

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/asr",
            "raw_path": b"/asr",
            "query_string": b"",
            "root_path": "",
            "server": ("test", 80),
            "client": ("test", 1),
            "headers": [(b"content-type", b"multipart/form-data; boundary=boundary")],
        }
        task = asyncio.create_task(app(scope, messages.get, send))
        await self.wait_started()
        await messages.put({"type": "http.disconnect"})
        # Observe worker cancellation deterministically before releasing native work.
        for _ in range(100):
            if any(j.cancelled.is_set() for j in self.backend.scheduler.jobs):
                break
            await asyncio.sleep(0.001)
        self.assertTrue(any(j.cancelled.is_set() for j in self.backend.scheduler.jobs))
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 1)
        self.backend.release.set()
        await task
        self.assertEqual(sent[0]["status"], 499)
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 0)

    async def test_serialization_finishing_after_deadline_never_returns_success(self):
        self.backend.batch_timeout = 0.01

        def late_serialization(*args):
            current_job.get().check()
            # Output writing is CPU work after the last engine check. It can
            # finish before the HTTP loop's poll yet exceed the request budget.
            time.sleep(0.03)
            return '{"text":"late output","segments":[]}'

        self.backend.process = late_serialization
        response = await self.request()
        self.assertEqual(response.status_code, 504)
        self.assertEqual(self.backend.scheduler.snapshot()["active_requests"], 0)
