"""Install rotation over the exact verified deployed r5 preview source."""
from __future__ import annotations

import ast
import hashlib
import os
from pathlib import Path
import stat
import sys

EXPECTED = '31b8f4116901ff0624c0233c806804d7852e39d6ea0eb09dd2054adfbdd4d6aa'
INSTALL = '''\n\n# Capture/WAV lifecycle stays in the original class; only live windows rotate.\nfrom utils.local_live_rotation import rotating_preview_class\n_UnrotatedLocalLivePreview = LocalLivePreview\nLocalLivePreview = rotating_preview_class(_UnrotatedLocalLivePreview, PreviewSegment)\n'''


def main(paths):
    if len(paths) != 1:
        raise SystemExit('usage: patch_live_rotation.py PREVIEW_PATH')
    path = Path(paths[0])
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED:
        raise RuntimeError('Omi preview differs from verified r5 image')
    changed = raw.decode('utf-8') + INSTALL
    ast.parse(changed)
    metadata = path.stat()
    temporary = path.with_name(path.name + '.rotation-next')
    try:
        temporary.write_text(changed, encoding='utf-8')
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        if os.geteuid() == 0:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    main(sys.argv[1:])
