"""One-time UI setup for an idle, local-only importer. Never starts audio work."""
import json
import os
import plistlib
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def main():
    repository = Path(__file__).resolve().parents[1]
    label = "tech.mycelia.voicememos-importer"
    domain = f"gui/{os.getuid()}"
    home = Path.home()
    agents = home / "Library/LaunchAgents"
    logs = home / "Library/Logs/Mycelia"
    pairing = home / "Library/Application Support/Mycelia/VoiceMemosBridge/pairing.json"
    target = agents / f"{label}.plist"
    loaded = subprocess.run(["launchctl", "print", f"{domain}/{label}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0
    if not loaded:
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", 8012)) == 0:
                raise RuntimeError("Port 8012 is occupied by another process. Nothing was replaced.")
        for path in (agents, logs):
            path.mkdir(parents=True, exist_ok=True)
            if any(parent.is_symlink() for parent in (path, *path.parents)):
                raise RuntimeError(f"Unsafe service directory: {path}")
        plist = {"Label": label, "ProgramArguments": ["/bin/bash", str(repository / "scripts/run-voice-memos-importer.sh")],
                 "WorkingDirectory": str(repository), "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 15,
                 "StandardOutPath": str(logs / "voicememos-importer.log"),
                 "StandardErrorPath": str(logs / "voicememos-importer.error.log")}
        if target.exists():
            if target.is_symlink() or plistlib.loads(target.read_bytes()) != plist:
                raise RuntimeError("An importer plist with different settings already exists. Nothing was overwritten.")
        else:
            with tempfile.NamedTemporaryFile(dir=agents, prefix=".voicememos-plist-", delete=False) as stream:
                temporary = Path(stream.name)
                plistlib.dump(plist, stream)
            try:
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
    else:
        subprocess.run(["launchctl", "kickstart", f"{domain}/{label}"], check=True)
    print("Starting local importer. No audio is being imported.", flush=True)
    for _ in range(45):
        try:
            token = json.loads(pairing.read_text())["token"]
            request = urllib.request.Request("http://127.0.0.1:8012/status",
                                             headers={"Authorization": "Bearer " + token})
            # Ignore proxy environment variables for local pairing.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=1) as response:
                status = json.load(response)
            if status.get("service") == "mycelia-voice-memos-importer" and status.get("version") == 1:
                print("Ready. Return to Bridge → Scan library → Import pending.\nYou can close this Terminal window.")
                return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Importer is not ready. See {logs / 'voicememos-importer.error.log'}")


if __name__ == "__main__":
    main()
