#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_tool_root="${ICLOUD_ARCHIVE_TOOL_ROOT:-${HOME}/claude-cowork/icloud-archive-tool}"
archive_root="${MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT:-/Volumes/TM_data/iCloudArchive}"
staging_root="${MYCELIA_VOICE_MEMOS_STAGING_ROOT:-${HOME}/Library/mycelia/voice-memos-staging}"
audio_root="${archive_root}/data/voice-memos/audio-original"
staged_audio_root="${staging_root}/audio-original"
stable_database="${staging_root}/CloudRecordings.snapshot.db"
status_file="${staging_root}/sync-status.json"

usage() {
  cat <<'USAGE'
Usage: bash scripts/refresh-voice-memos-staging.sh [--apply|--publish-latest]

Without an option, show the archive plan and the latest completed snapshot.

  --apply           Refresh and fully verify the additive Voice Memos archive,
                    then atomically publish its newest SQLite snapshot.
  --publish-latest  Fully verify the existing archive and atomically publish
                    its newest completed SQLite snapshot without reading live
                    Voice Memos.

The live archive refresh must be started interactively from an already trusted
Terminal. Audio at or after MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE and the SQLite
snapshot are copied into local staging. Mycelia's LaunchAgent reads only that
published staging directory, never the protected library or external volume.
USAGE
}

mode="plan"
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

staging_not_before="${MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE:-}"
if [[ -z "${staging_not_before}" && -f "${repo_root}/.env" ]]; then
  staging_not_before="$(/usr/bin/python3 - "${repo_root}/.env" <<'PY'
import sys
from pathlib import Path

for raw_line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() == "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE":
        print(value.strip().strip('"').strip("'"))
        break
PY
)"
fi
if [[ $# -eq 1 ]]; then
  case "$1" in
    --apply) mode="apply" ;;
    --publish-latest) mode="publish-latest" ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
fi

if [[ -d "${archive_tool_root}" ]]; then
  archive_tool_root="$(cd "${archive_tool_root}" && pwd -P)"
fi
archive_run="${archive_tool_root}/scripts/run.sh"
archive_verify="${archive_tool_root}/scripts/verify.sh"
archive_common="${archive_tool_root}/scripts/common.sh"
if [[ ! -f "${archive_run}" || ! -f "${archive_verify}" || ! -f "${archive_common}" ]]; then
  echo "Voice Memos archive tool is unavailable at ${archive_tool_root}" >&2
  echo "Set ICLOUD_ARCHIVE_TOOL_ROOT to its checkout." >&2
  exit 1
fi
if [[ ! -d "${archive_root}" ]]; then
  echo "Archive volume is unavailable at ${archive_root}" >&2
  exit 1
fi

run_archive_tool() (
  publication_root="$(cd "${archive_root}" && pwd -P)"
  cd "${archive_tool_root}"
  # The archive tool's config can override exported ARCHIVE_TARGET. Resolve it
  # through the same loader before every plan, refresh, or verification call.
  # shellcheck disable=SC1090
  source "${archive_common}"
  load_config
  /usr/bin/python3 - "${publication_root}" "${ARCHIVE_TARGET}" <<'PY'
import sys
from pathlib import Path

publication_root, tool_root = (Path(value).resolve() for value in sys.argv[1:])
if publication_root != tool_root:
    raise SystemExit(
        "Voice Memos archive mismatch: "
        f"MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT resolves to {publication_root}, "
        f"but the archive tool's effective ARCHIVE_TARGET resolves to {tool_root}. "
        "Configure both to use the same archive before retrying."
    )
PY
  exec bash "$@"
)

latest_snapshot() {
  /usr/bin/python3 - "${archive_root}" <<'PY'
import json
import sys
from pathlib import Path

archive = Path(sys.argv[1])
manifests = archive / "manifests"
snapshots = archive / "data/voice-memos/native-metadata/snapshots"

for run_directory in sorted(manifests.iterdir(), reverse=True):
    if not run_directory.is_dir():
        continue
    run_file = run_directory / "run.json"
    report_file = run_directory / "voice-memos.json"
    try:
        run = json.loads(run_file.read_text(encoding="utf-8"))
        report = json.loads(report_file.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        continue
    if run.get("completed") is not True:
        continue
    if "voice-memos" not in run.get("components", []):
        continue
    if "CloudRecordings.snapshot.db" not in report.get("sqlite_snapshots", []):
        continue
    snapshot = snapshots / run_directory.name / "CloudRecordings.snapshot.db"
    if snapshot.is_file():
        print(snapshot)
        raise SystemExit(0)

raise SystemExit("No completed Voice Memos SQLite snapshot was found")
PY
}

publish_snapshot() {
  local snapshot="$1"
  local lock_directory="${staging_root}/.refresh.lock"

  if [[ -z "${staging_not_before}" ]]; then
    echo "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE is required for bounded staging." >&2
    echo "Set it in ${repo_root}/.env with an explicit UTC offset." >&2
    exit 1
  fi

  if [[ -L "${staging_root}" ]]; then
    echo "Staging root must be a local directory, not a symbolic link: ${staging_root}" >&2
    exit 1
  fi
  mkdir -p "${staging_root}"
  chmod 700 "${staging_root}"
  if ! mkdir "${lock_directory}" 2>/dev/null; then
    echo "Another staging publication is active: ${lock_directory}" >&2
    exit 1
  fi
  trap 'rmdir "${lock_directory}" 2>/dev/null || true' EXIT

  /usr/bin/python3 - \
    "${snapshot}" \
    "${stable_database}" \
    "${status_file}" \
    "${audio_root}" \
    "${staged_audio_root}" \
    "${staging_not_before}" <<'PY'
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

source, destination, status_path, archive_audio_root, staged_audio_root = map(
    Path,
    sys.argv[1:6],
)
cutoff_value = sys.argv[6]
if destination.parent.is_symlink() or staged_audio_root.is_symlink():
    raise SystemExit("Staging directories must not be symbolic links")
if not source.is_file():
    raise SystemExit(f"Snapshot is missing: {source}")
if not archive_audio_root.is_dir():
    raise SystemExit(f"Archive audio root is missing: {archive_audio_root}")


def quick_check(path: Path) -> None:
    uri = path.resolve().as_uri() + "?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        result = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    if result != ("ok",):
        raise SystemExit(f"SQLite quick_check failed for {path}: {result}")


quick_check(source)
try:
    cutoff = datetime.fromisoformat(cutoff_value)
except ValueError as exc:
    raise SystemExit(
        "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE must be an ISO 8601 datetime"
    ) from exc
if cutoff.tzinfo is None or cutoff.utcoffset() is None:
    raise SystemExit(
        "MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE must include a UTC offset"
    )

apple_reference_date = 978307200
apple_cutoff = cutoff.timestamp() - apple_reference_date
database = sqlite3.connect(source.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
try:
    catalog = database.execute(
        "SELECT ZPATH FROM ZCLOUDRECORDING WHERE ZDATE >= ? ORDER BY ZDATE",
        (apple_cutoff,),
    ).fetchall()
finally:
    database.close()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


audio_entries: list[tuple[Path, Path, int]] = []
seen_paths: set[Path] = set()
for (catalog_path,) in catalog:
    if not catalog_path:
        raise SystemExit(f"Unsafe Voice Memos catalog path: {catalog_path!r}")
    relative = Path(catalog_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"Unsafe Voice Memos catalog path: {catalog_path!r}")
    if relative in seen_paths:
        continue
    seen_paths.add(relative)
    archive_file = archive_audio_root / relative
    staged_file = staged_audio_root / relative
    for relative_parent in relative.parents:
        if (staged_audio_root / relative_parent).is_symlink():
            raise SystemExit(f"Staged audio parent must not be a symbolic link: {staged_file.parent}")
    if not archive_file.is_file():
        raise SystemExit(f"Archived Voice Memo is missing: {archive_file}")
    audio_entries.append((archive_file, staged_file, archive_file.stat().st_size))

staged_audio_root.mkdir(parents=True, exist_ok=True)
staged_audio_root.chmod(0o700)
catalog_bytes = sum(size for _, _, size in audio_entries)
copy_entries: list[tuple[Path, Path, int, str]] = []
reused_audio = 0
for archive_file, staged_file, source_size in audio_entries:
    source_digest = sha256(archive_file)
    if (
        not staged_file.is_symlink()
        and staged_file.is_file()
        and staged_file.stat().st_size == source_size
        and sha256(staged_file) == source_digest
    ):
        reused_audio += 1
    else:
        copy_entries.append((archive_file, staged_file, source_size, source_digest))

copy_bytes = sum(size for _, _, size, _ in copy_entries)
capacity = os.statvfs(staged_audio_root)
free_bytes = capacity.f_bavail * capacity.f_frsize
minimum_headroom = 1024 * 1024 * 1024
required_bytes = copy_bytes + source.stat().st_size + minimum_headroom
if free_bytes < required_bytes:
    raise SystemExit(
        "Insufficient free space for bounded Voice Memos staging: "
        f"need at least {required_bytes} bytes ({copy_bytes} audio bytes to copy), "
        f"have {free_bytes}"
    )

copied_audio = 0
for archive_file, staged_file, source_size, source_digest in copy_entries:
    staged_file.parent.mkdir(parents=True, exist_ok=True)
    staged_file.parent.chmod(0o700)
    temporary_audio = staged_file.with_name(
        f".{staged_file.name}.tmp-{os.getpid()}"
    )
    try:
        copy_digest = hashlib.sha256()
        with archive_file.open("rb") as source_stream, temporary_audio.open("wb") as output:
            for block in iter(lambda: source_stream.read(8 * 1024 * 1024), b""):
                copy_digest.update(block)
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        temporary_audio.chmod(0o600)
        copied_digest = copy_digest.hexdigest()
        if copied_digest != source_digest:
            raise SystemExit(f"Archived Voice Memo changed while copying: {archive_file}")
        if sha256(temporary_audio) != copied_digest:
            raise SystemExit(f"Staged Voice Memo hash mismatch: {staged_file}")
        os.replace(temporary_audio, staged_file)
        copied_audio += 1
    finally:
        if temporary_audio.exists():
            temporary_audio.unlink()

destination.parent.mkdir(parents=True, exist_ok=True)
temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
status_temporary = status_path.with_name(f".{status_path.name}.tmp-{os.getpid()}")
try:
    with source.open("rb") as source_stream, temporary.open("wb") as output:
        while block := source_stream.read(8 * 1024 * 1024):
            output.write(block)
        output.flush()
        os.fsync(output.fileno())
    temporary.chmod(0o600)
    quick_check(temporary)
    digest_builder = hashlib.sha256()
    with temporary.open("rb") as staged_stream:
        for block in iter(lambda: staged_stream.read(8 * 1024 * 1024), b""):
            digest_builder.update(block)
    digest = digest_builder.hexdigest()
    os.replace(temporary, destination)

    payload = {
        "schema": 1,
        "published_at_utc": datetime.now(timezone.utc).isoformat(),
        "archive_audio_root": str(archive_audio_root),
        "published_audio_root": str(staged_audio_root),
        "not_before": cutoff.isoformat(),
        "staged_audio_files": len(audio_entries),
        "staged_audio_bytes": catalog_bytes,
        "copied_audio_files": copied_audio,
        "copied_audio_bytes": copy_bytes,
        "reused_audio_files": reused_audio,
        "source_snapshot": str(source),
        "published_database": str(destination),
        "snapshot_sha256": digest,
    }
    status_temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    status_temporary.chmod(0o600)
    os.replace(status_temporary, status_path)
finally:
    for path in (temporary, status_temporary):
        if path.exists():
            path.unlink()
PY

  rmdir "${lock_directory}"
  trap - EXIT
  echo "Published Voice Memos staging snapshot: ${stable_database}"
  echo "Published bounded audio staging: ${staged_audio_root}"
  echo "Status: ${status_file}"
}

if [[ "${mode}" == "plan" ]]; then
  run_archive_tool "${archive_run}" --components voice-memos
  snapshot="$(latest_snapshot)"
  echo
  echo "Latest completed snapshot: ${snapshot}"
  if [[ -n "${staging_not_before}" ]]; then
    echo "Bounded staging cutoff: ${staging_not_before}"
  else
    echo "Bounded staging cutoff is not configured."
  fi
  echo "No archive or staging files were changed."
  exit 0
fi

if [[ "${mode}" == "apply" ]]; then
  run_archive_tool "${archive_run}" --execute --components voice-memos
fi

run_archive_tool "${archive_verify}" --components voice-memos --full

snapshot="$(latest_snapshot)"
publish_snapshot "${snapshot}"

cat <<EOF

Mycelia can now read Voice Memos without Full Disk Access for uv:
  MYCELIA_APPLE_VOICEMEMOS_MODE=staged
  MYCELIA_APPLE_VOICEMEMOS_ROOT=${staged_audio_root}
  MYCELIA_APPLE_VOICEMEMOS_DB=${stable_database}

The running host ingestion service will pick up the atomically published
snapshot on its next cycle. Repository: ${repo_root}
EOF
