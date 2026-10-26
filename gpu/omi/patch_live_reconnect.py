"""Patch exact deployed r4 sources; no dirty Omi checkout is copied into the image."""
from __future__ import annotations

import ast
import hashlib
import os
from pathlib import Path
import stat
import sys

EXPECTED = {
    'local_provider_relay.py': '7e6949150356ae07149b025fda1b87b7b5bb2220824de8bed14fa14c1dd9c43e',
    'local_live_preview.py': '17110ccb83444d8a46cd493bfa40f3c7c78c3efa80bac579117a45b4bf99c70d',
}


def once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Omi reconnect source contract changed')
    return source.replace(old, new, 1)


def patch_relay(source):
    source = once(source, 'from .local_provider_http import auth_headers, validate_url\n',
        'from .local_provider_http import auth_headers, validate_url\n'
        'from .live_reconnect import ProviderBusyTimeout, connect_ready\n')
    source = once(source,
        "        async with connector(endpoint, key=key if authenticated else '') as provider:\n"
        "            config = validate_config(await asyncio.wait_for(provider.recv(), 5))\n",
        "        async with connect_ready(endpoint, key=key if authenticated else '',\n"
        "                                 connector=connector, validate_config=validate_config) as admitted:\n"
        "            provider, config = admitted\n")
    source = once(source,
        "        except Exception:\n"
        "            with suppress(Exception):\n"
        "                await socket.send_json({'type': 'error', 'code': 'live_provider_failed'})\n",
        "        except ProviderBusyTimeout:\n"
        "            with suppress(Exception):\n"
        "                await socket.close(code=1013, reason='live_preview_busy')\n"
        "        except Exception:\n"
        "            with suppress(Exception):\n"
        "                await socket.send_json({'type': 'error', 'code': 'live_provider_failed'})\n")
    return source


def patch_preview(source):
    return once(source,
        "                handshake_timeout = 12 if os.getenv('OMI_LOCAL_LIVE_PROVIDER_RELAY') == '1' else 3\n",
        "                # Relay admission may wait for the preceding session to drain.\n"
        "                # Existing MAX_PENDING_BYTES preserves up to 60 s of PCM meanwhile.\n"
        "                handshake_timeout = 50 if os.getenv('OMI_LOCAL_LIVE_PROVIDER_RELAY') == '1' else 3\n")


def main(paths):
    if len(paths) != 2:
        raise SystemExit('usage: patch_live_reconnect.py RELAY_PATH PREVIEW_PATH')
    changes = []
    for path, patch in zip(map(Path, paths), (patch_relay, patch_preview)):
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != EXPECTED.get(path.name):
            raise RuntimeError('Omi source differs from verified r4 image: ' + path.name)
        changed = patch(raw.decode('utf-8'))
        ast.parse(changed)
        changes.append((path, changed))
    # Validate both inputs before making either write.
    for path, changed in changes:
        metadata = path.stat()
        temporary = path.with_name(path.name + '.reconnect-next')
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
