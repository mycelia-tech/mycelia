"""Add diagnostics only to the exact r5 relay produced by the pinned r4 overlay."""
from __future__ import annotations

import ast
import hashlib
import os
from pathlib import Path
import stat
import sys

EXPECTED = '6e0cdc1990897c6b718eb98919f280b09b048c0ce108bc707d19256c4532d832'


def once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Omi diagnostics source contract changed')
    return source.replace(old, new, 1)


def patch_relay(source):
    source = once(source,
        'from .live_reconnect import ProviderBusyTimeout, connect_ready\n',
        'from .live_reconnect import ProviderBusyTimeout, connect_ready, correlated_endpoint, ProviderFailure, relay_error_frame\n')
    source = once(source,
        '    endpoint, authenticated = upstream(snapshot, cfg, raw=raw_upstream)\n',
        '    endpoint, authenticated = upstream(snapshot, cfg, raw=raw_upstream)\n'
        "    endpoint = correlated_endpoint(endpoint, getattr(downstream, 'query_params', {}))\n")
    source = once(source,
        "                        raise RelayError('Live provider stream failed')\n",
        '                        raise ProviderFailure(decoded)\n')
    source = once(source,
        "        except Exception:\n"
        "            with suppress(Exception):\n"
        "                await socket.send_json({'type': 'error', 'code': 'live_provider_failed'})\n",
        "        except Exception as error:\n"
        "            frame = relay_error_frame(error, socket.query_params)\n"
        "            with suppress(Exception):\n"
        "                await socket.send_json(frame)\n")
    return source


def main(paths):
    if len(paths) != 1:
        raise SystemExit('usage: patch_live_diagnostics.py RELAY_PATH')
    path = Path(paths[0])
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED:
        raise RuntimeError('Omi relay differs from verified r5 source')
    changed = patch_relay(raw.decode('utf-8'))
    ast.parse(changed)
    metadata = path.stat()
    temporary = path.with_name(path.name + '.diagnostics-next')
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
