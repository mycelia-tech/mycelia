#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
command -v uv >/dev/null || { echo 'Install uv before starting the importer.' >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo 'Install ffmpeg before starting the importer.' >&2; exit 1; }
command -v ffprobe >/dev/null || { echo 'Install ffprobe before starting the importer.' >&2; exit 1; }
cd "${repo_root}/python"
exec env UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-/private/tmp/mycelia-daemon-venv}" \
  uv run --env-file "${repo_root}/.env" voice_memos_bridge_server.py
