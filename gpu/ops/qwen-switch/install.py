#!/usr/bin/env python3
"""Install a versioned user-owned selector atomically; never change services."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import py_compile
import shutil
import tempfile


FILES = ("qwen-switch", "qwen_resources.py", "README.md")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(source, root, expected_sha=None):
    source, root = Path(source).resolve(), Path(root).resolve(strict=True)
    current = root / "qwen-switch"
    if not current.is_file() or current.stat().st_uid != os.getuid():
        raise RuntimeError("Expected an existing user-owned qwen-switch; refusing privileged/unknown installation")
    if expected_sha and digest(current) != expected_sha:
        raise RuntimeError("qwen-switch changed since inspection; inspect it again before updating")
    for name in FILES:
        if not (source / name).is_file():
            raise RuntimeError("Missing source: " + name)
    parent = root / ".qwen-switch-releases"
    parent.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-")
    release = Path(tempfile.mkdtemp(prefix=stamp, dir=parent))
    backup = release / "previous"
    backup.mkdir(mode=0o700)
    # Resolve first: the helper belongs beside the real script, not the symlink.
    original = current.resolve()
    for name in ("qwen-switch", "qwen_resources.py"):
        shutil.copy2(original.parent / name, backup / name)
    for name in FILES:
        shutil.copy2(source / name, release / name)
    (release / "qwen-switch").chmod(0o755)
    for name in ("qwen-switch", "qwen_resources.py"):
        py_compile.compile(str(release / name), doraise=True)
    receipt = {"release": str(release), "rollback": str(backup / "qwen-switch"),
               "files": {name: digest(release / name) for name in FILES}}
    (release / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if expected_sha and digest(current) != expected_sha:
        raise RuntimeError("Concurrent modification detected; installed command was not changed")
    temporary = root / (".qwen-switch-next-" + release.name)
    try:
        temporary.symlink_to(release / "qwen-switch")
        os.replace(temporary, current)
    finally:
        temporary.unlink(missing_ok=True)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/mnt/datadrive/sky-services/projects/qwen"))
    parser.add_argument("--expected-sha", help="SHA256 of the currently installed script; fail on concurrent edits")
    args = parser.parse_args()
    print(json.dumps(install(Path(__file__).parent, args.root, args.expected_sha), indent=2))


if __name__ == "__main__":
    main()
