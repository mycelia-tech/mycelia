#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"
pipeline_venv="${UV_PROJECT_ENVIRONMENT:-${repo_root}/python/.venv}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required" >&2
  exit 1
fi

if [[ ! -f "${env_file}" ]]; then
  echo "Missing ${env_file}; copy .env.example to .env and configure it first." >&2
  exit 1
fi

if ! grep -Eq '^STT_SERVER_URL=.+$' "${env_file}"; then
  echo "STT_SERVER_URL is missing from ${env_file}" >&2
  exit 1
fi

if ! grep -Eq '^PROXY_API_KEY=.+$' "${env_file}"; then
  echo "PROXY_API_KEY is missing from ${env_file}" >&2
  exit 1
fi

echo "Starting Mycelia services and the automatic audio pipeline..."
if ! docker compose --project-directory "${repo_root}" up -d; then
  echo "docker compose reported a startup dependency timeout; waiting for backend readiness explicitly..." >&2
fi

backend_ready=false
for _ in {1..36}; do
  if curl -fkSs "https://localhost:4433/readiness" >/dev/null 2>&1; then
    backend_ready=true
    break
  fi
  sleep 5
done

if [[ "${backend_ready}" != "true" ]]; then
  echo "Backend did not become ready within 3 minutes; audio daemon was not started." >&2
  docker compose --project-directory "${repo_root}" ps >&2
  exit 1
fi

echo "Starting host audio discovery/import. Press Ctrl+C to stop importing."
echo "VAD and transcription continue automatically in the Docker services."
cd "${repo_root}/python"
exec env UV_PROJECT_ENVIRONMENT="${pipeline_venv}" uv run daemon.py "$@"
