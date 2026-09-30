#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
label="tech.mycelia.ingestion"
launch_agents_dir="${HOME}/Library/LaunchAgents"
log_dir="${HOME}/Library/Logs/Mycelia"
plist_path="${launch_agents_dir}/${label}.plist"
readiness_url="http://127.0.0.1:8001/readiness"
uid="$(id -u)"

mkdir -p "${launch_agents_dir}" "${log_dir}"

cat >"${plist_path}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${repo_root}/scripts/run-ingestion-service.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repo_root}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${log_dir}/ingestion-service.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/ingestion-service.error.log</string>
</dict>
</plist>
PLIST

plutil -lint "${plist_path}" >/dev/null
launchctl bootout "gui/${uid}" "${plist_path}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${uid}" "${plist_path}"
launchctl kickstart -k "gui/${uid}/${label}"

if ! /usr/bin/python3 "${repo_root}/scripts/wait-for-ingestion-ready.py" "${readiness_url}"; then
  echo "Installed ${label}, but the service did not become ready within 90 seconds." >&2
  echo "Inspect ${log_dir}/ingestion-service.error.log" >&2
  exit 1
fi

echo "Installed and started ${label}"
echo
