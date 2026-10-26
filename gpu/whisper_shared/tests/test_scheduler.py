import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from scheduler import Busy, Cancelled, GatedModel, ModelLease, Scheduler, current_job


class SchedulerTests(unittest.TestCase):
    def test_weighted_operations_and_no_overlap(self):
        s = Scheduler(max_requests=16)
        order = []
        blocker = s.admit("batch", 10)
        started = threading.Event()
        release = threading.Event()

        def hold():
            with s.operation(blocker):
                started.set()
                self.assertTrue(release.wait(5))

        with ThreadPoolExecutor(12) as pool:
            first = pool.submit(hold)
            self.assertTrue(started.wait(5))
            jobs = [s.admit("live", 10) for _ in range(8)] + [
                s.admit("batch", 10) for _ in range(2)
            ]

            def run(job):
                with s.operation(job):
                    order.append(job.priority)
                s.finish(job)

            futures = [pool.submit(run, job) for job in jobs]
            self.assertTrue(s.wait_for_queued(10, 5))
            release.set()
            first.result(5)
            for f in futures:
                f.result(5)
        s.finish(blocker)
        self.assertEqual(order, ["live"] * 4 + ["batch"] + ["live"] * 4 + ["batch"])
        self.assertEqual(s.snapshot()["active_requests"], 0)

    def test_bound_cancel_deadline_and_drain(self):
        s = Scheduler(max_requests=1)
        j = s.admit("batch", 10)
        with self.assertRaises(Busy):
            s.admit("live", 10)
        s.cancel(j)
        with self.assertRaises(Cancelled), s.operation(j):
            self.fail("cancelled operation ran")
        # Admission remains held until worker cleanup, never unload under native work.
        with self.assertRaises(Busy):
            s.admit("batch", 10)
        s.finish(j)
        expired = s.admit("batch", -1)
        with self.assertRaises(Cancelled), s.operation(expired):
            self.fail("expired operation ran")
        s.finish(expired)
        s.set_draining(True)
        with self.assertRaises(Busy):
            s.admit("batch", 10)
        s.set_draining(False)
        s.finish(s.admit("batch", 10))

    def test_waiter_cancel_removed_and_running_op_not_released_early(self):
        s = Scheduler(max_requests=3)
        a, b = s.admit("batch", 10), s.admit("live", 10)
        started, release = threading.Event(), threading.Event()

        def hold():
            with s.operation(a):
                started.set()
                release.wait(5)

        def waiting():
            with s.operation(b):
                self.fail("cancelled waiter ran")

        with ThreadPoolExecutor(2) as pool:
            fa = pool.submit(hold)
            started.wait(5)
            fb = pool.submit(waiting)
            self.assertTrue(s.wait_for_queued(1, 5))
            s.cancel(b)
            with self.assertRaises(Cancelled):
                fb.result(5)
            self.assertEqual(s.snapshot()["running_operations"], 1)
            release.set()
            fa.result(5)
        s.finish(a)
        s.finish(b)
        self.assertEqual(s.snapshot()["queued_operations"], {"live": 0, "batch": 0})

    def test_idle_unload_waits_for_suspended_generators(self):
        s = Scheduler(4)
        unloaded = []
        lease = ModelLease(
            s, lambda: object(), lambda m: unloaded.append(m), idle_timeout=0.01
        )
        lease.get()
        j = s.admit("batch", 10)
        self.assertFalse(lease.unload_if_idle(now=time.monotonic() + 100))
        s.finish(j)
        self.assertFalse(lease.unload_if_idle(now=time.monotonic()))
        self.assertTrue(lease.unload_if_idle(now=time.monotonic() + 100))
        self.assertEqual(len(unloaded), 1)

    def test_native_generator_keeps_context_and_gates_every_operation(self):
        s = Scheduler(4)
        operations = []

        class Native:
            def encode(self, value):
                operations.append(("encode", value))
                return value

            def generate(self, value):
                operations.append(("generate", value))
                return value + 1

            def align(self, value):
                operations.append(("align", value))
                return value

            def detect_language(self, value):
                operations.append(("detect_language", value))
                return value

        native = GatedModel(Native(), s)

        def generate():
            prompt = 0
            for _ in range(3):
                prompt = native.generate(native.encode(prompt))
                yield prompt

        j = s.admit("batch", 10)
        token = current_job.set(j)
        try:
            generator = generate()
            self.assertEqual(next(generator), 1)
            self.assertEqual(next(generator), 2)
            native.align(2)
            native.detect_language(2)
            s.cancel(j)
            with self.assertRaises(Cancelled):
                next(generator)
            self.assertEqual(len(operations), 6)
        finally:
            current_job.reset(token)
            s.finish(j)


if __name__ == "__main__":
    unittest.main()
