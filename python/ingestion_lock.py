"""One host-wide lock for CLI, LaunchAgent and native Bridge ingestion."""
import fcntl
import os
import stat
import threading
import time
from contextlib import contextmanager
from functools import wraps
from pathlib import Path

_thread_lock = threading.RLock()
_local = threading.local()


@contextmanager
def ingestion_lock(cancel_check=None):
    with _thread_lock:
        if getattr(_local, "held", False):
            yield
            return
        root = Path(os.getenv("MYCELIA_INGESTION_LOCK_DIR", str(Path.home() / "Library/mycelia")))
        root.mkdir(parents=True, exist_ok=True)
        if any(p.is_symlink() for p in (root, *root.parents)):
            raise RuntimeError("Unsafe ingestion lock directory")
        descriptor = os.open(root / "ingestion.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise RuntimeError("Unsafe ingestion lock")
            while True:
                if cancel_check:
                    cancel_check()
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(0.1)
            _local.held = True
            yield
        finally:
            _local.held = False
            os.close(descriptor)


def serialized_ingestion(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with ingestion_lock():
            return function(*args, **kwargs)
    return wrapped
