# Mycelia Python Backend

This directory contains the Python components of Mycelia, including audio processing, daemon services, and data ingestion.

## Prerequisites

The main prerequisites are listed in the [root README](../README.md). This section covers Python-specific requirements:

### Python & uv

**Install uv (Python package manager):**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### PortAudio (Required for `stt.py`)

**macOS:**
```bash
brew install portaudio
```

**Linux:**
```bash
sudo apt install portaudio19-dev
```

**Windows:**
```bash
# Download from https://www.portaudio.com/download.html
```

## Components

### Daemon (`daemon.py`)

The main daemon service continuously:
- Imports new audio files from configured sources
- Ingests audio files into the system
- Backfills device information for imported recordings

For normal macOS operation, install the serialized host ingestion service from
the repository root:

```bash
bash scripts/install-ingestion-service.sh
```

It runs discovery and ingestion automatically and exposes the authenticated
`POST /jobs/ingestion` endpoint used by Jobs -> Ingestion -> Run now. Use
`daemon.py` directly only for a foreground session or recovery, and do not run
both ingestion processes simultaneously. The installer waits up to 90 seconds
for `/readiness`, independently of the first ingestion batch, and
the service adds the standard Homebrew binary paths required for `ffmpeg` and
`ffprobe` when running under launchd.

`GET http://127.0.0.1:8001/health` reports per-source discovery state and
`lastCycle.ingestion` counts (`attempted`, `succeeded`, `failed`, `remaining`,
and unresolved `cached_errors`). A
configured Apple staging database that is missing or cannot be queried makes
the service `degraded`; it is no longer reported as an empty successful scan.
The response also reports `appleVoiceMemosMode`. Upload failures and cached
errors within this daemon's source scope also make health `degraded`; pending
work alone does not. Cached failures require an explicit retry. `/readiness`
reports application startup completion with service `mycelia-host-ingestion`
and includes the current health details. Installation can succeed while health
is `starting` or `degraded`; the installer prints that state separately.
Invalid batch or interval settings fail application startup before readiness.
Readiness requests have a total transfer deadline; interrupted or malformed
responses are retried within the installer's 90-second budget.

The recommended macOS background mode is verified staging:

```bash
# Read-only preview
bash scripts/refresh-voice-memos-staging.sh

# Interactive archive refresh, full verification, and atomic publication
bash scripts/refresh-voice-memos-staging.sh --apply
```

Configure `.env` with `MYCELIA_APPLE_VOICEMEMOS_MODE=staged`, the local
`~/Library/mycelia/voice-memos-staging/audio-original` directory, the published
`CloudRecordings.snapshot.db` beside it, and a timezone-aware
`MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE` cutoff. The refresh copies and verifies
only that bounded audio set from the external archive. The LaunchAgent reads
only local ordinary paths; do not grant Full Disk Access to its `uv` executable.
New Voice Memos enter staging only after the interactive refresh command runs.
Incremental publication reuses audio only after size and hash verification.
Required free space covers audio needing copying, a temporary SQLite snapshot,
and a 1 GiB reserve, including full replacement-file sizes.
Existing audio symlinks need full copy space and are replaced with verified
regular files. Symlinked staging directories are rejected so publication
cannot write through them to an external location.

Apple identity lookup is paginated, so catalogs larger than 1,000 records stay
deduplicated. A unique pending UUID can move to a readable configured copy
without creating another source. Its cached error remains until explicit
retry; completed sources stay unchanged. Ambiguous matches and unreadable
replacement paths appear as discovery warnings. Multiple catalog paths for
one UUID are also ambiguous; neither insertion nor path repair runs for that
UUID until the catalog is reconciled.

For custom archives, export `MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT` and set the
archive tool's effective `ARCHIVE_TARGET` to the same directory. The wrapper
uses the tool's config loader before each archive command and rejects
mismatched resolved paths. The tool reads `ICLOUD_ARCHIVE_CONFIG` or its own
`config.env`; that config can override an exported `ARCHIVE_TARGET`.

Apple backup recovery supports separate paths and a bounded date range:

```bash
MYCELIA_APPLE_VOICEMEMOS_ROOT=/path/to/audio-original \
MYCELIA_APPLE_VOICEMEMOS_DB=/path/to/CloudRecordings.snapshot.db \
MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE=2026-08-24T00:00:00+04:00 \
MYCELIA_APPLE_VOICEMEMOS_MODE=staged \
uv run --env-file ../.env daemon.py --once
```

The cutoff must include a UTC offset. Metadata comes from the Apple database,
and deduplication uses the full `ZUNIQUEID`, not the absolute audio path. Stop
the LaunchAgent for this separate foreground command. In normal staged
operation, publishing a replacement snapshot is atomic and the service can stay
running.

Chunk ingestion uses unordered, idempotent `bulkWrite` batches of 50. Retrying
an interrupted source safely reuses the existing `(original_id, index)` chunks.

The normal daemon does **not** run voice activity detection. VAD normally runs
as a backend job in `python-worker`; use `daemon.py --vad-only` only as a direct
recovery or backfill path.

#### Running the Daemon

```bash
uv run daemon.py
```

The daemon runs continuously and logs to `~/Library/mycelia/logs/daemon.log`.

Useful modes:

```bash
# Run one discovery/import cycle and exit
uv run daemon.py --once

# Directly process chunks without VAD metadata, bypassing the job queue
uv run daemon.py --vad-only

# Run one bounded direct VAD cycle
uv run daemon.py --vad-only --once --vad-limit 1000 --vad-batch-size 100
```

Both the queued worker and `--vad-only` use the Silero implementation in
`jobs/vad.py` and write the same `audio_chunks.vad` fields. The difference is
orchestration: queued VAD is triggered and tracked by the backend Jobs system,
while `--vad-only` runs directly and creates no job record. Do not run direct
VAD alongside an active queued VAD worker or start multiple direct VAD
processes, because direct workers do not claim chunks before processing them.

#### Error Handling

The daemon now intelligently handles errors:
- **Cached Errors**: Files that fail ingestion are marked with an error and automatically excluded from future processing
- **No Automatic Retry**: Errored files won't be retried automatically to prevent infinite loops
- **Manual Retry**: You can manually retry errored files using the management script

### Error Management (`manage_errors.py`)

A utility script to manage files that failed during ingestion.
Each command initializes daemon API authentication before reading or changing
source-file state.

#### List Errored Files

```bash
uv run manage_errors.py list
```

Shows all files with ingestion errors, including:
- File name and ID
- Error message (truncated to 100 chars)
- Last attempt timestamp

#### Retry All Errored Files

```bash
uv run manage_errors.py retry-all
```

Attempts to re-ingest all previously failed files without clearing their cached
errors first. Each error is removed only after that exact source succeeds.

#### Retry Specific File

```bash
uv run manage_errors.py retry <file_id>
```

Retries a specific file by MongoDB ObjectId. Its cached error is preserved until
ingestion succeeds.

Example:
```bash
uv run manage_errors.py retry 68ee1a98a5ba09aadf9a8838
```

The cached error remains attached until that exact source succeeds. The retry
is scoped by source ID, so unrelated pending files cannot be selected by the
daemon's normal newest-first ordering. Existing chunks for the same source are
upserted by chunk index; a retry fills missing chunks instead of duplicating
them.

If the original container is damaged but a verified repaired copy exists, pass
it as a second argument:

```bash
uv run manage_errors.py retry <file_id> ~/Library/mycelia/recovered_audio/repaired.m4a
```

The daemon reads audio from the replacement only for that retry. The stored
Voice Memos path remains unchanged, so discovery does not create a duplicate
source record.

#### Clear All Errors (Without Retry)

```bash
uv run manage_errors.py clear-all
```

Removes error flags from all files without attempting to re-ingest them.

#### Clear Specific Error (Without Retry)

```bash
uv run manage_errors.py clear <file_id>
```

Removes the error flag from a specific file without retrying ingestion.

### Conversation Extraction (`python -m convos.cli`)

Extracts conversations from existing transcripts using an LLM and writes conversation objects plus entity mention relationships to MongoDB.

#### When to run

- After transcripts exist in the `transcriptions` collection (produced by your ingestion/transcription pipeline)
- Ad hoc to backfill older data or periodically (e.g., via cron) to keep conversations up to date

#### Running

```bash
uv run python -m convos.cli
```

Optional flags:

- `--limit <N>`: process at most N conversation chunks
- `--not-later-than <UNIX_TS>`: only process transcripts earlier than the given UNIX timestamp (seconds)
- `--model {small|medium|large}`: choose LLM size (default: small)
- `--force`: force recreation of existing conversations (deletes and recreates)

#### Resume-Safe Processing

By default, `convos` **skips** chunks that already have conversations, making it safe to resume interrupted processing:

```bash
# Process new conversations only (skips existing)
uv run python -m convos.cli --limit 10

# Continue processing - will skip the 10 already done
uv run python -m convos.cli --limit 10
```

#### Force Recreate

Use `--force` to delete and recreate existing conversations:

```bash
# Recreate conversations (useful after prompt improvements)
uv run python -m convos.cli --limit 10 --force

# Recreate with larger model
uv run python -m convos.cli --limit 10 --force --model medium

# Process items not later than a specific time
uv run python -m convos.cli --not-later-than 1730500000
```

#### Logs

Writes logs to `~/Library/mycelia/logs/convos.log` and also prints progress to the console.

## Daemon Logging

The daemon now provides detailed progress information:

```
Starting ingestion: 45 files pending, 2 errored files cached
Processing [1/20]: audio_recording.m4a
✓ Successfully ingested: audio_recording.m4a
Processing [2/20]: meeting_notes.wav
✗ Error ingesting meeting_notes.wav: ffmpeg error...
Batch complete: 19 processed, 1 errors, 25 remaining, 3 total cached errors
```

## Other Components

### Audio Processing (`chunking.py`)
Handles audio file splitting and conversion to Opus chunks.

### Discovery (`discovery.py`)
Discovers and imports new audio files from configured sources.

### Voice Activity Detection (`jobs/vad.py`)

Runs Silero VAD on audio chunks and stores `vad.ran_at`, `vad.prob`, and
`vad.has_speech`. The automatic path is exposed by `worker_server.py` at
`POST /jobs/vad` and invoked by the backend Jobs worker. `daemon.py --vad-only`
calls the same processor directly for recovery and manual backfills.

### Diarization Worker (`diarization_worker.py`)
Consumes pending audio chunks, merges them into short WAVs, and calls the diarization server to write speaker segments back to MongoDB.

#### Running

```bash
cd python
uv run diarization_worker.py --limit 25 --max-chunks 10
```

- `--limit` (optional): stop after processing a specific number of sequences.
- `--max-chunks` (optional): cap how many consecutive chunks get merged per request (defaults to the `DIARIZATION_MAX_SEQUENCE_CHUNKS` env var, or 6).

Environment variables:

- `DIARIZATION_SERVER_URL` (default `http://localhost:8085`): endpoint that exposes `POST /diarize`.
- `DIARIZATION_MAX_SEQUENCE_CHUNKS`: fallback for the `--max-chunks` flag; use it when running the worker under a supervisor so uploads stay below the server’s payload limit.
- `DIARIZATION_CONTINUITY_THRESHOLD` (default `0.75`): cosine-similarity threshold used to preserve speaker labels between overlapping requests.

Progress logs stream to the console (via `tqdm`) and to `python/logs/diarization_worker.log`.

#### Cleanup Stuck Claims (`debug/cleanup_claims.py`)

Debug helper to inspect and clear stuck diarization claims when chunks remain marked as "claimed" by a crashed worker.

```bash
cd python
uv run debug/cleanup_claims.py              # show current claims
uv run debug/cleanup_claims.py --clean      # clear claims (verifies no workers running)
uv run debug/cleanup_claims.py --clean --force  # force clear (skip worker check)
```

Options:
- `--collection <name>`: MongoDB collection (default: `audio_chunks`)
- `--worker-id <id>`: Limit to specific worker
- `--clean`: Perform cleanup (default: show only)
- `--force`: Skip running-worker check

### Transcription (`stt.py`)
Speech-to-text transcription services.

For local Argmax/Whisper setup, see [Local STT with Argmax and Whisper](../docs/LOCAL_STT.md).

#### Running against a remote STT proxy

`stt.py` still needs backend access for MongoDB/resource APIs, so `MYCELIA_URL`, `MYCELIA_CLIENT_ID`, and `MYCELIA_TOKEN` must be configured in the repo `.env`.

To send transcription requests to a remote OpenAI-compatible STT endpoint instead of the backend-configured provider, add this to the repo `.env`:

```bash
STT_SERVER_URL=https://stt.mycelia.tech
PROXY_API_KEY=your_proxy_api_key
```

Then run:

```bash
cd python
export UV_CACHE_DIR=/tmp/uv-cache
uv run stt.py --limit 10
```

Useful checks:

```bash
uv run stt.py --count
uv run stt.py --limit 1
```

- `--server` can still override `STT_SERVER_URL`
- `--api-key` can still override `PROXY_API_KEY`
- `--count` returns pending speech chunks eligible for STT; it only verifies backend auth/Mongo access, not the remote STT call

## Configuration

Configuration is managed through `settings.py`.
