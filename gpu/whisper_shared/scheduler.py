"""Thread-safe admission and cooperative scheduling; no inference dependencies."""

import threading
import time
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

current_job = ContextVar("asr_job", default=None)


class Busy(Exception):
    pass


class Cancelled(Exception):
    pass


@dataclass(eq=False)
class Job:
    priority: str
    deadline: float
    cancelled: threading.Event = field(default_factory=threading.Event)

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled("request cancelled")
        if time.monotonic() >= self.deadline:
            raise Cancelled("request deadline exceeded")


class Scheduler:
    def __init__(self, max_requests=8):
        if max_requests < 1:
            raise ValueError("max_requests must be positive")
        self.cv = threading.Condition()
        self.max_requests = max_requests
        self.jobs = set()
        self.queues = {"live": deque(), "batch": deque()}
        self.running = None
        self.live_turns = 0
        self.draining = False
        self.last_completion = time.monotonic()

    def admit(self, priority, timeout):
        with self.cv:
            if self.draining or len(self.jobs) >= self.max_requests:
                raise Busy(
                    "ASR draining" if self.draining else "ASR admission limit reached"
                )
            job = Job(
                "live" if priority == "live" else "batch", time.monotonic() + timeout
            )
            self.jobs.add(job)
            return job

    def cancel(self, job):
        with self.cv:
            job.cancelled.set()
            self.cv.notify_all()

    def finish(self, job):
        with self.cv:
            self.jobs.discard(job)
            if not self.jobs:
                self.last_completion = time.monotonic()
            self.cv.notify_all()

    def set_draining(self, value):
        with self.cv:
            self.draining = value
            self.cv.notify_all()

    def _next(self):
        live, batch = self.queues["live"], self.queues["batch"]
        if live and (not batch or self.live_turns < 4):
            return live[0]
        return batch[0] if batch else None

    @contextmanager
    def operation(self, job):
        if job is None:
            raise RuntimeError("GPU operation without admitted request")
        ticket = object()
        with self.cv:
            job.check()
            if job not in self.jobs:
                raise RuntimeError("request already finished")
            queue = self.queues[job.priority]
            queue.append(ticket)
            self.cv.notify_all()
            try:
                while True:
                    job.check()
                    if self.running is None and self._next() is ticket:
                        queue.popleft()
                        self.running = ticket
                        # A lone live workload does not accumulate credit/debt.
                        self.live_turns = (
                            self.live_turns + 1
                            if job.priority == "live" and self.queues["batch"]
                            else 0
                        )
                        break
                    self.cv.wait(min(0.1, max(0.001, job.deadline - time.monotonic())))
            except BaseException:
                queue.remove(ticket)
                self.cv.notify_all()
                raise
        try:
            yield
        finally:
            with self.cv:
                self.running = None
                self.cv.notify_all()

    def wait_for_queued(self, count, timeout):
        """Deterministic synchronization for diagnostics and tests."""
        with self.cv:
            return self.cv.wait_for(
                lambda: sum(map(len, self.queues.values())) >= count, timeout
            )

    def snapshot(self):
        with self.cv:
            return {
                "active_requests": len(self.jobs),
                "max_requests": self.max_requests,
                "queued_operations": {
                    key: len(value) for key, value in self.queues.items()
                },
                "running_operations": int(self.running is not None),
                "draining": self.draining,
                "requests_by_priority": {
                    p: sum(j.priority == p for j in self.jobs) for p in self.queues
                },
            }


class GatedModel:
    """Proxy only CT2 GPU operations, retaining faster-whisper's native generators."""

    OPERATIONS = frozenset({"encode", "generate", "align", "detect_language"})

    def __init__(self, model, scheduler):
        self._model = model
        self._scheduler = scheduler

    def __getattr__(self, name):
        target = getattr(self._model, name)
        if name not in self.OPERATIONS:
            return target

        def call(*args, **kwargs):
            # Reject before launch so async GPU work cannot escape the gate.
            if kwargs.get("asynchronous", False):
                raise RuntimeError("asynchronous CT2 operations are unsupported")
            with self._scheduler.operation(current_job.get()):
                result = target(*args, **kwargs)
                return result

        return call


class ModelLease:
    """Serialize load/unload; accepted requests pin model through CPU/queue suspension."""

    def __init__(self, scheduler, load, unload, idle_timeout):
        self.scheduler = scheduler
        self.load = load
        self.unload = unload
        self.idle_timeout = idle_timeout
        self.lock = threading.Lock()
        self.model = None
        self.state = "unloaded"

    def get(self):
        with self.lock:
            if self.model is None:
                self.state = "loading"
                try:
                    self.model = self.load()
                except BaseException:
                    self.state = "unloaded"
                    raise
                self.state = "loaded"
                with self.scheduler.cv:
                    if not self.scheduler.jobs:
                        self.scheduler.last_completion = time.monotonic()
            return self.model

    def unload_if_idle(self, now=None):
        if self.idle_timeout <= 0:
            return False
        with self.lock:
            with self.scheduler.cv:
                if self.model is None or self.scheduler.jobs:
                    return False
                if (
                    time.monotonic() if now is None else now
                ) - self.scheduler.last_completion < self.idle_timeout:
                    return False
                model, self.model = self.model, None
                self.state = "unloading"
            # New admissions can occur, but get() waits until unload is finished.
            try:
                self.unload(model)
            finally:
                self.state = "unloaded"
            return True
