"""Cancellation shared by HTTP resources and provider jobs without import cycles."""
from contextvars import ContextVar
from threading import Event

job_cancel_event_var: ContextVar[Event | None] = ContextVar("job_cancel_event", default=None)


class ResourceCancelledError(RuntimeError):
    pass


def check_cancelled() -> None:
    event = job_cancel_event_var.get()
    if event is not None and event.is_set():
        raise ResourceCancelledError("Job cancelled")
