#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"
pipeline_venv="${UV_PROJECT_ENVIRONMENT:-/private/tmp/mycelia-daemon-venv}"
service_path="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

# launchd uses a minimal PATH, so Homebrew tools are otherwise unavailable to
# the ingestion subprocesses even when they work in an interactive shell.
for package_bin_dir in /usr/local/bin /opt/homebrew/bin; do
  if [[ -d "${package_bin_dir}" ]]; then
    service_path="${package_bin_dir}:${service_path}"
  fi
done

uv_bin="${UV_BIN:-$(PATH="${service_path}" command -v uv || true)}"

if [[ -z "${uv_bin}" && -x "${HOME}/.local/bin/uv" ]]; then
  uv_bin="${HOME}/.local/bin/uv"
fi

if [[ -z "${uv_bin}" ]]; then
  echo "uv is required" >&2
  exit 1
fi

for media_tool in ffmpeg ffprobe; do
  if ! PATH="${service_path}" command -v "${media_tool}" >/dev/null 2>&1; then
    echo "${media_tool} is required; install ffmpeg with Homebrew before starting ingestion." >&2
    exit 1
  fi
done

if [[ ! -f "${env_file}" ]]; then
  echo "Missing ${env_file}; configure it before starting ingestion." >&2
  exit 1
fi

cd "${repo_root}/python"
exec env PATH="${service_path}" UV_PROJECT_ENVIRONMENT="${pipeline_venv}" \
  "${uv_bin}" run --env-file "${env_file}" ingestion_server.py
