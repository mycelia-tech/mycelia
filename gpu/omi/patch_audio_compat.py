"""Patch verified Omi image sources without reading the dirty checkout."""

from __future__ import annotations

import ast
import hashlib
import os
import stat
import sys
from pathlib import Path

STT_SOURCE_SHA256 = "4d2d0a71e5a93111d0707a646f6fbf1c4015f98260df60aa743538cd52eaeafe"
CAPTURE_SOURCE_SHA256 = "a538bea766476c2f09f28bcc2f01c6ba46db77d727dbf08532645769319da02d"
RUNTIME_SOURCE_SHA256 = "c3cd2e67b2959c56772402539db8f6543688e394229c329596c0c67428a71e4d"
SERVICES_SOURCE_SHA256 = "2726001f7060d20aa964252de036530ba5ad890b0593da84dae5376718c95e82"
OLD = (
    "completed = subprocess.run(command, cwd=cfg.repo_root / 'backend', env=env, "
    "capture_output=True, text=True, timeout=60)"
)
NEW = OLD.replace("timeout=60)", "timeout=180)")


def _write_verified(path: Path, original: bytes, changed: str) -> None:
    ast.parse(changed)
    original_stat = path.stat()
    temporary = path.with_name(path.name + ".compat-next")
    try:
        temporary.write_text(changed, encoding="utf-8")
        os.chmod(temporary, stat.S_IMODE(original_stat.st_mode))
        if os.geteuid() == 0:
            os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def patch_stt(path: Path) -> None:
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != STT_SOURCE_SHA256:
        raise RuntimeError("Omi STT source differs from the verified running image")
    source = original.decode("utf-8")
    functions = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "backend_step"]
    if len(functions) != 1 or source.count(OLD) != 1:
        raise RuntimeError("Omi import subprocess contract changed")
    call = next(
        (node for node in ast.walk(functions[0])
         if isinstance(node, ast.Call)
         and isinstance(node.func, ast.Attribute)
         and isinstance(node.func.value, ast.Name)
         and node.func.value.id == "subprocess" and node.func.attr == "run"
         and any(keyword.arg == "timeout" and isinstance(keyword.value, ast.Constant)
                 and keyword.value.value == 60 for keyword in node.keywords)),
        None,
    )
    if call is None:
        raise RuntimeError("Omi import timeout is no longer the verified 60 seconds")
    changed = source.replace(OLD, NEW, 1)
    _write_verified(path, original, changed)


def patch_capture(path: Path) -> None:
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != CAPTURE_SOURCE_SHA256:
        raise RuntimeError("Omi capture source differs from the verified running image")
    source = original.decode("utf-8")
    cls = next((node for node in ast.parse(source).body
                if isinstance(node, ast.ClassDef) and node.name == "OfflineAudioCapture"), None)
    if cls is None or {node.name for node in cls.body if isinstance(node, ast.FunctionDef)} < {
        "__init__", "_write_progress_metadata", "record_decoded_frame", "record_decode_error", "finalize"
    }:
        raise RuntimeError("Omi capture contract changed")
    replacements = (
        (
            "INPUT_CODECS_BY_SOURCE = {'omi': frozenset({'opus', 'opus_fs320'}), 'phone': frozenset({'pcm16'})}\n",
            (
                "INPUT_CODECS_BY_SOURCE = {'omi': frozenset({'opus', 'opus_fs320'}), 'phone': frozenset({'pcm16'})}\n"
                "METADATA_CHECKPOINT_SECONDS = 1.0\n"
            ),
        ),
        (
            (
                "        self._pcm = self.pcm_part_path.open('xb', buffering=0)\n"
                "        self._write_progress_metadata()\n"
            ),
            (
                "        self._pcm = self.pcm_part_path.open('xb', buffering=0)\n"
                "        # Keep the first packet recoverable, then bound durable progress writes.\n"
                "        self._last_metadata_checkpoint = time.monotonic() - METADATA_CHECKPOINT_SECONDS\n"
                "        self._write_progress_metadata()\n"
            ),
        ),
        (
            (
                "    def _write_progress_metadata(self) -> None:\n"
                "        _atomic_json(self.metadata_part_path, self._metadata(ended_at=None, status='recording'))\n"
            ),
            (
                "    def _write_progress_metadata(self) -> None:\n"
                "        _atomic_json(self.metadata_part_path, self._metadata(ended_at=None, status='recording'))\n\n"
                "    def _checkpoint_progress_metadata(self) -> None:\n"
                "        now = time.monotonic()\n"
                "        if now - self._last_metadata_checkpoint >= METADATA_CHECKPOINT_SECONDS:\n"
                "            self._write_progress_metadata()\n"
                "            self._last_metadata_checkpoint = time.monotonic()\n"
            ),
        ),
        (
            "        self._write_progress_metadata()\n\n    def record_decode_error",
            "        self._checkpoint_progress_metadata()\n\n    def record_decode_error",
        ),
        (
            "        self._write_progress_metadata()\n\n    def finalize",
            "        self._checkpoint_progress_metadata()\n\n    def finalize",
        ),
    )
    changed = source
    for old, new in replacements:
        if changed.count(old) != 1:
            raise RuntimeError("Omi capture checkpoint source shape changed")
        changed = changed.replace(old, new, 1)
    _write_verified(path, original, changed)


def patch_runtime(path: Path) -> None:
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != RUNTIME_SOURCE_SHA256:
        raise RuntimeError("Omi Docker runtime differs from the verified running image")
    source = original.decode("utf-8")
    functions = {node.name for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
    if "main" not in functions or source.count("def main():\n") != 1:
        raise RuntimeError("Omi Docker runtime entrypoint changed")
    old_call = "            local_mac.ensure_owner_profile(cfg, pairing['owner_uid'])\n"
    new_call = "            wait_for_owner_profile(cfg, pairing['owner_uid'], stopped=lambda: stopped)\n"
    old_infrastructure = (
        "            deadline = time.monotonic() + 120\n"
        "            while not all(cli._port_open('127.0.0.1', p) for p in\n"
        "                          (cfg.firestore_port, cfg.auth_port, cfg.redis_port)):\n"
        "                if stopped or time.monotonic() > deadline:\n"
        "                    raise RuntimeError('Infrastructure did not become ready')\n"
        "                time.sleep(.5)\n"
    )
    new_infrastructure = "            wait_for_infrastructure(cfg, stopped=lambda: stopped)\n"
    old_error = (
        "            print('Docker runtime failed: ' + type(error).__name__, file=sys.stderr)\n"
        "            raise SystemExit(1)\n"
    )
    new_error = old_error.replace("            raise SystemExit(1)\n", "            traceback.print_exc()\n            raise SystemExit(1)\n")
    helper = (
        "def wait_for_infrastructure(cfg, *, stopped):\n"
        "    # TCP readiness for all three existing local dependencies is required.\n"
        "    ports = (('firestore', cfg.firestore_port), ('auth', cfg.auth_port),\n"
        "             ('redis', cfg.redis_port))\n"
        "    deadline = time.monotonic() + 300\n"
        "    while True:\n"
        "        missing = [name for name, port in ports if not cli._port_open('127.0.0.1', port)]\n"
        "        if not missing:\n"
        "            return\n"
        "        if stopped() or time.monotonic() >= deadline:\n"
        "            raise RuntimeError('Infrastructure did not become ready: ' + ', '.join(missing))\n"
        "        time.sleep(0.5)\n\n\n"
        "def wait_for_owner_profile(cfg, owner_uid, *, stopped):\n"
        "    # Firestore opens its TCP port before imported data is ready for reads.\n"
        "    deadline = time.monotonic() + 120\n"
        "    while not stopped():\n"
        "        try:\n"
        "            local_mac.ensure_owner_profile(cfg, owner_uid)\n"
        "        except TimeoutError:\n"
        "            remaining = deadline - time.monotonic()\n"
        "            if remaining <= 0 or stopped():\n"
        "                raise\n"
        "            time.sleep(min(2, remaining))\n"
        "        else:\n"
        "            if not stopped():\n"
        "                return\n"
        "    raise RuntimeError('Shutdown requested during owner profile readiness')\n\n\n"
    )
    if (source.count(old_call) != 1 or source.count(old_infrastructure) != 1
            or source.count(old_error) != 1 or source.count("import threading\n") != 1):
        raise RuntimeError("Omi startup readiness calls changed")
    changed = source.replace("def main():\n", helper + "def main():\n", 1)
    changed = changed.replace(old_call, new_call, 1).replace(old_infrastructure, new_infrastructure, 1)
    changed = changed.replace("import threading\n", "import threading\nimport traceback\n", 1)
    changed = changed.replace(old_error, new_error, 1)
    _write_verified(path, original, changed)


def patch_services(path: Path) -> None:
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != SERVICES_SOURCE_SHA256:
        raise RuntimeError("Omi STT services differ from the verified running image")
    source = original.decode("utf-8")
    functions = [node for node in ast.parse(source).body
                 if isinstance(node, ast.FunctionDef) and node.name == "start_provider_relay"]
    old_wait = (
        "    for _ in range(30):\n"
        "        if health(cfg, 'provider-relay')[0]:\n"
        "            return\n"
        "        time.sleep(0.2)\n"
        "    raise ServiceError('Live relay did not become ready')\n"
    )
    new_wait = (
        "    deadline = time.monotonic() + 60\n"
        "    while time.monotonic() < deadline:\n"
        "        if health(cfg, 'provider-relay')[0]:\n"
        "            return\n"
        "        time.sleep(min(0.5, max(0, deadline - time.monotonic())))\n"
        "    raise ServiceError('Live relay did not become ready')\n"
    )
    if len(functions) != 1 or source.count(old_wait) != 1:
        raise RuntimeError("Omi relay startup readiness contract changed")
    _write_verified(path, original, source.replace(old_wait, new_wait, 1))


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("usage: patch_audio_compat.py STT_PATH CAPTURE_PATH RUNTIME_PATH SERVICES_PATH")
    patch_stt(Path(sys.argv[1]))
    patch_capture(Path(sys.argv[2]))
    patch_runtime(Path(sys.argv[3]))
    patch_services(Path(sys.argv[4]))
