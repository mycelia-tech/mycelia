# Mycelia [preview version]

**Mycelia is your self-hosted AI memory and timeline.**

Capture ideas, thoughts, and conversations in **voice, screenshots, or text**.
Ask anything later — _"What did I say about X last May?" Mycelia tells you, in
your own words.

📍 Local-first · 🔓 Open-source · 📦 Modular · 🛠 Hackable

## Features

### Audio Ingestion & Processing

- Staged import from Apple Voice Memos plus continuous Google Drive and local
  folder discovery.
- Automated pipeline: VAD → Transcription → Conversation extraction →
  Summarization.
- Smart chunking, waveform normalization, and diarization-friendly segments.
- Whisper transcription via local GPU or any remote OpenAI-compatible server.
- Audio recording, playback (0.5x–3x speed, volume up to 300%), and WAV export.
- Pipeline monitoring UI with real-time session tracking and error handling.

### Interactive Timeline

- D3.js-powered multi-track timeline with zoom and pan.
- Multi-resolution views (5 min, 1 hour, 1 day, 1 week).
- Transcript-synced audio playback with jump controls.
- Track visibility controls, object overlays, and event creation from selection.
- Persisted object-density bars at far zoom; individual object intervals load
  only when the scale is detailed enough.
- Quick presets (last hour, today, yesterday, this week, and more).

### Location Tracks & Map

- Preview and safely import overlapping GPS tracks (GPX, KML/KMZ), keeping
  provenance, every source coordinate, named routes and full non-geometry KMZ
  metadata without turning bookmark timestamps into false whereabouts. Each
  import keeps a detailed file passport and separates coordinate/metadata
  differences for review.
- Opt-in Locations row on the timeline: stays with city labels, movements, and
  grey "assumed" gaps; click a band to see where it was on a mini-map.
- Dedicated Map page: shareable time/viewport/layer URLs, an interactive compact
  timeline, zoom-aware full route geometry with reviewable source conflicts,
  dwell/visit density, saved places/source tracks, and persistent paginated
  conversation clusters that do not scan raw objects.
- Fully offline reverse geocoding (GeoNames) and automatic timezone periods
  derived from your movements; manual location assignment for ranges without
  data. See [LOCATIONS.md](docs/LOCATIONS.md) for the full manual.

### Photo & PDF Knowledge

- Preview-first import from a read-only mounted folder. Originals stay outside
  Mycelia by default; the database keeps a content hash, source-relative path,
  extracted metadata, and compact GridFS WebP previews.
- Direct drag-and-drop/file-picker import is also available. Upload analysis
  stages originals in a separate `media_originals` store. An untouched preview
  expires after one hour; confirmation makes the files canonical, while an
  interrupted confirmation has a bounded seven-day recovery lease. Originals
  can later be removed with a preview-and-confirm receipt while previews,
  metadata, and analysis remain.
- Recognition is provider-neutral and can be queued separately from import.
  **Settings → Photo analysis** reuses an existing LLM connection or creates a
  photo-only OpenAI-compatible vision connection, with an optional API key,
  explicit model, output language, and bounded concurrency. Google is optional
  and disabled by default through `externalServices.google.enabled`; saved
  Google results remain readable and locally searchable. The custom self-hosted
  Open Media API remains supported.
- Bulk Photo analysis uses one fixed package: visual understanding plus OCR. A
  general vision profile returns a description and model-extracted visible text
  without requiring embeddings. Its price is shown as unknown, not zero. An
  explicitly enabled Google profile runs Vertex visual understanding/embedding and strict-EU Cloud
  Vision OCR; a self-hosted profile requests the same two features only from its
  configured endpoint and does not call Google. Global Vision labels/objects are
  excluded from this batch action. Versioned descriptions, embeddings, OCR
  pages, annotations, provenance, usage, deduplication, an app-side gross-cost
  ledger, previews, derived analysis, and source references are stored as
  separate layers. Their actions live in one **Storage & deletion…** panel;
  mounted items can be removed from Mycelia together with their previews and
  analysis while the read-only mounted original is never deleted. Photos can
  also be ignored for future recognition and later returned without changing
  files or existing results.
- **Analysis & results** includes result-provider and import-batch filters,
  server-side select-all, and explicit **Reanalyze ready photos**. Reanalysis
  creates a new version; failed attempts never replace the accepted result.
  Photo details have Description, Text, Metadata, and History sections.
  Recognition reservations temporarily block these storage mutations. The main
  UAT stack opts into read-only source and ADC mounts with
  `docker-compose.media-uat.yml`; real host paths remain in `.env`. See
  [MEDIA_KNOWLEDGE.md](docs/MEDIA_KNOWLEDGE.md).
- Photo events locally cluster nearby owned images by capture time and EXIF GPS,
  then use a separate preview-and-confirm step before a Google or self-hosted
  provider can analyze a displayed, bounded set of sanitized thumbnails (eight
  by default, at most twelve). Ready results can be reviewed and explicitly
  published as idempotent Mycelia Event Objects on the Timeline;
  audio/transcription/Object links stay local and identity recognition is
  forbidden. Media uses switchable gallery/table views, stable server-side
  sorting, explicit page selection, and all-matching server selection with a
  focused detail viewer. The compact workspace keeps import, filters, selection,
  and batch actions close to the photos; secondary privacy, provider, and
  placement explanations are available through keyboard-accessible hover/focus
  hints instead of permanent help paragraphs. `/media/analysis` provides the
  same sortable inventory plus server-side status, placement, filename, and a
  shared capture-date range picker. Its **Unprocessed by
  capture-date range** workflow can target every eligible asset matching the
  server-side filters without being limited to the visible page, then shows an
  exact preview and, where pricing is known, a ceiling before confirmation.
  General model previews state when no monetary ceiling can be enforced.
  Unmatched event candidates
  remain visible as single photos instead of being silently omitted.
- Large mounted folders use a visual folder picker and resumable scan → review →
  confirm campaigns. The local root is selected by default; separately configured
  disks and aliases are excluded from that scan. The optional macOS
  `docker-compose.media-disks.yml` overlay exposes **Connected disks** read-only,
  with stable aliases preserving references when disks reconnect. See
  [External photo libraries](docs/MEDIA_KNOWLEDGE.md#external-photo-libraries).
  Subfolders are
  browsable without typing paths from a collapsed **Choose folder** control, so
  the current path and primary Scan action remain visible without consuming the
  page. One `mediaFolderImport` job reports live
  checked/total progress, speed and ETA while committing durable 25-file steps.
  **Import + Google** optionally turns a folder campaign into a live stream:
  discovery, local previews, and Google recognition overlap. Review one total
  gross ceiling and batch size before enabling it. Exact SHA-bound photo waves
  consume that ceiling conservatively; **Pause new batches** leaves confirmed
  waves and the independent local import running. Monthly/per-photo caps and
  any enabled daily cap remain enforced. See [streaming photo import](docs/MEDIA_KNOWLEDGE.md#streaming-photo-import).
  Later syncs stat every path but reuse the previously verified SHA-256 and
  extracted metadata when owner, path, byte size, and modification time are
  unchanged; only new or changed files are read and hashed again.
  The gallery is cursor-paginated and refreshes while folder imports or
  recognition jobs advance. An exact SHA-bound provider batch on the Analysis
  page can process every eligible photo matching the server-side filters with
  one visible **Photo analysis batch** row and aggregate progress in Jobs.
  Per-photo recognition jobs remain internal recovery details and do not flood
  the default Jobs list; active batches do not lock browsing or local import.
  Generic Jobs launch/restart/cancel/clear actions cannot recreate or remove
  folder-import or paid recognition campaigns; their lifecycle stays under the
  Media library and Photo analysis controls.
  Individual photos have a default Photos map layer and adaptive Photos Timeline
  track. Nearby map markers and overlapping Timeline markers expand into a
  captioned photo list with links to the library; wide Timeline density bars
  open the same bounded capture-window view. Missing time/GPS stays visible as
  Unplaced and can be assigned locally with audit history.
- Google media billing supports a fail-closed 24-hour Free Trial confirmation
  or an explicit persistent paid-account acknowledgement bound to one project;
  both retain the application monthly, per-asset, per-event, and confirmed batch
  limits. **Settings → Google Cloud → Daily limit** can explicitly disable the
  daily stop (`dailyGrossLimitUsd: null`); daily usage is still recorded, and no
  other ceiling is raised. Missing settings retain the guarded $0.10/day default.

### AI Chat

- Chat with your memory using a curated tool catalogue, with Auto, No tools, and
  per-chat Custom policies; data-changing actions require explicit approval.
- Streaming responses with durable run status, observable tool activity and
  usage metadata, retry/stop controls, and in-app completion notifications.
- Searchable chat history with favorites and a separate archive, compact
  message/pin counts, actual-model labels, unread states, resizable navigation,
  rename, and previous/next navigation across pinned messages.

### Hybrid Knowledge Search

- Optional Qdrant-backed dense + sparse search across transcriptions, messages,
  objects, and active media descriptions. Typed date/source/message platform and
  sender filters are revalidated against current MongoDB records; results are
  capped per chat/recording/source and link back to canonical Mycelia records.
- Independent projection lifecycle with durable checkpoints, source/chunk
  ledger, incremental change-stream updates, periodic reconciliation, and
  blue/green rebuilds that keep the previous active generation searchable.
- Dedicated Search page and Knowledge settings page for status, progress,
  freshness, errors, chunk inspection, reconcile, pause/resume, and confirmed
  rebuild operations. Chat receives only the read-only search tool.
- Separate `mycelia-rag` Compose project and volumes; Qdrant is additional
  rebuildable storage and never replaces canonical MongoDB. See
  [RAG_QDRANT.md](docs/RAG_QDRANT.md) for architecture and
  [RAG_UI_MANUAL.md](docs/RAG_UI_MANUAL.md) for the Russian operator/UI
  walkthrough and acceptance checks.

### Object Management

- Create, edit, and browse People, Events, Conversations, Relationships, and
  Promises.
- Per-object audio player with transcript sync and segment navigation.
- LLM summarization with model selection and cost estimation.
- Summary comparison (side-by-side, star/favorite).
- In `/summaries`, combine **Last X** (optional, 1–10,000) with a generated-date
  **Period**, or use either filter alone. The page shows matching summaries and
  distinct conversations. Choose a target model and click **Rerun summaries**;
  this single action follows the full filter, independently of how many cards
  are displayed. Clear Last X to include the whole period. New versions are
  appended; existing target-model versions and queued jobs are skipped. Keep
  the page open until queueing completes.
- Autosave with per-field throttling and version history.
- Full-text search, category filtering, and relationship graph.
- Lazy, cursor-paginated object sections with bounded backend queries and
  independent cached count freshness.

### Background Processing

- BullMQ job queue backed by Redis.
- Canonical worker catalog shared by Jobs and Settings, with stable stale-state
  fallback, one-line descriptions, relevant routing metadata, and compact
  advanced controls.
- Persistent manual snapshots for exact backlog, incremental run history, and
  Timeline integrity; refresh failures retain the last successful values.
- Durable, pausable Timeline density repair campaigns for exact affected dates
  or a selected period, with bounded batches, progress, missing-successor
  recovery, and explicit final verification.
- Lightweight live diarization campaign, five-minute rolling throughput, queue,
  and dynamic route-capacity status, with corpus-wide pipeline and identity
  counts available through explicit calculate buttons instead of dashboard
  polling.
- Pipeline ordering and progress tracking.
- Sky-first Voice Identity workflow with rolling review, independent calibration
  checks, resumable all-history classification campaigns, safe empty-generation
  repair preview, and current/manual speaker projection on Timeline. See the
  [Voice Identity runbook](docs/VOICE_IDENTITY_RUNBOOK.md).
- Configurable worker defaults and prompt templates.
- Failed-job bulk retry, obsolete-failure dismissal, VAD queue recovery, and
  historical conversation repair:
  [pipeline troubleshooting](docs/CONVERSATION_EXTRACTION_TROUBLESHOOTING.md).

### Infrastructure & Auth

- One-command Docker setup (`docker compose up -d`) with backend, frontend,
  Python worker, MongoDB, and Redis.
- OAuth 2.0 with PKCE, `.well-known` metadata, JWT login, and API key
  management.
- MCP (Model Context Protocol) server endpoint for remote operations and
  scripting.
- First-run setup wizard with automatic API key creation and inference provider
  configuration.
- OpenTelemetry observability (optional).
- Feature flags, access logging, and server configuration UI.

### Integrations

- Messenger platform import (Telegram, Signal).
- LLM provider configuration with model aliases (small / medium / large),
  independent host/catalog checks, and fixed or automatic live-model selection.
- OpenAI-compatible API endpoints (`/v1/audio/transcriptions`,
  `/llm/chat/completions`).
- MongoDB full-text search alongside GridFS-backed storage.

## Roadmap

**In progress**

- Friend-Lite companion app + advanced backend (`friend/`) wiring semantic
  memories and wearable capture back into Mycelia.
- GPU diarization stack replacing the current batch-only flow (`diarizator/`
  Helm charts + WebUI).
- Qdrant retrieval evaluation and owner-scoped authorization hardening.

**Planned**

- Multi-device & multi-modal capture (health, geolocation, photos, sensors).
- Mem0/OpenMemory and graph-memory integrations built as separate projections
  after the Qdrant retrieval contract is validated.
- Privacy + usage dashboards, token metering, and export flows.
- Processing / artifact templates, batch operations, and backup automation.

## 🚀 Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### Setup & Run

```bash
git clone https://github.com/mycelia-tech/mycelia.git
cd mycelia

./scripts/setup.sh --start
```

The setup script automatically:

- Creates `.env` from `.env.example`
- Generates a secure `SECRET_KEY`
- Starts all services with Docker Compose

Open [http://localhost:3210](http://localhost:3210) in your browser.

#### Optional Qdrant RAG stack

The vector projection is intentionally not part of the main startup. Run it as
an isolated stack after Mycelia's MongoDB is available:

```bash
cp .env.rag.example .env.rag.local
docker compose \
  --env-file .env.rag.local \
  -f docker-compose.rag.yml \
  up -d --build
```

Then set `RAG_URL` in the main ignored `.env` and recreate only the backend.
The default standalone ports are `48091` (RAG API), `46333` (Qdrant
REST/dashboard), and `46334` (Qdrant gRPC).

The default is a local pinned MiniLM + BM25 FastEmbed baseline with no reranker.
Its model/tokenizer/instruction/dimension/normalization/chunker contract is visible
in **Settings → Knowledge index** and enforced by the projection fingerprint.
Qwen3-Embedding-0.6B at 768 dimensions on an RTX 4090 is reserved as a later
remote-executor projection; Qdrant itself stays on the current host and no GPU or
remote inference service is started by this Compose file.

#### CLI/Python Daemon Users

If you need API tokens in `.env` (for Python daemon or CLI access):

```bash
./scripts/setup.sh --with-tokens --start
```

This starts MongoDB temporarily to generate `MYCELIA_CLIENT_ID` and
`MYCELIA_TOKEN`.

#### Checking and Syncing After Updates

After pulling updates, check whether `.env` still matches `.env.example`. The
checker reports only key names and line numbers; it never prints values:

```bash
./scripts/check-env.sh --all    # Audit every configured env contract
./scripts/check-env.sh          # Audit only the root .env
./scripts/check-env.sh --strict # Also warn about blank active values
./scripts/check-env.sh --fix    # Back up .env and apply safe fixes
./scripts/sync-env.sh           # Interactive - prompts before adding
./scripts/sync-env.sh --dry-run # Preview changes without modifying
```

The main stack, standalone diarizator, and remote GPU stack intentionally use
separate templates. `--all` checks `.env`, `diarizator/.env`, and `gpu/.env`
when present; an absent optional deployment is reported as not configured. Use
`--fix --prune-undocumented` only after reviewing the listed key names: it backs
up the selected file and removes keys that its template no longer owns.

> **Note**: For local development, Mycelia uses a self-signed certificate. You
> may need to click "Advanced" and "Proceed" in your browser. See
> [NETWORKING.md](docs/NETWORKING.md) for more details on port configuration and
> SSL.

### Import Existing Audio Files

The Python daemon discovers new recordings, imports their metadata, splits each
audio file into chunks, and ingests up to 20 source files per cycle. It runs
continuously, starting another cycle approximately every 10 seconds, until you
stop it with `Ctrl+C`.

```bash
cd python
uv run daemon.py
```

The daemon can import:

- Apple Voice Memos
- Google Drive Folders
- Local Audio Folders

On macOS, the recommended background setup does not read Apple's protected
Group Container. Run the repository's staging refresh interactively from an
already trusted Terminal; it copies a bounded set of verified audio and an
atomically published SQLite snapshot into `~/Library/mycelia`. The LaunchAgent
never opens either Apple's library or the external archive volume. Do not grant
Full Disk Access to `uv` or to the ingestion LaunchAgent for this workflow.

**Environment variables** (optional, set in `.env`):

- `MYCELIA_APPLE_VOICEMEMOS_MODE` - `manual` disables background Apple
  discovery, `staged` requires explicit local staging paths, and `live` is the
  legacy opt-in direct-library mode
- `MYCELIA_APPLE_VOICEMEMOS_ROOT` - local published staging folder containing
  Apple audio files; required in `staged` mode
- `MYCELIA_APPLE_VOICEMEMOS_DB` - optional separate `CloudRecordings.db` or
  snapshot path; required in `staged` mode
- `MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE` - timezone-aware ISO 8601 cutoff;
  required by the bounded staging publisher and optional for direct discovery
- `MYCELIA_GOOGLE_DRIVE_ROOT` - Google Drive path
- `MYCELIA_LOCAL_AUDIO_ROOT` - Local audio folder
- `MYCELIA_GOOGLE_TZ` / `MYCELIA_LOCAL_TZ` - Timezones (default: UTC)

#### Daemon Options

| Option               | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `--once`             | Run one cycle and exit instead of watching continuously.            |
| `--reset-errors`     | Clear cached source-file ingestion errors before importing again.   |
| `--vad-only`         | Skip discovery/import and process only chunks without VAD metadata. |
| `--vad-limit N`      | Process at most `N` chunks per VAD cycle; default is `1000`.        |
| `--vad-batch-size N` | Fetch `N` chunks per VAD database batch; default is `100`.          |

`--reset-errors` cannot be combined with `--vad-only`. Both VAD numeric options
must be greater than zero.

Examples:

```bash
# Import one batch and exit
uv run daemon.py --once

# Retry source files with cached ingestion errors
uv run daemon.py --reset-errors
```

#### Run the Complete Automatic Pipeline

For an always-on macOS installation, install the host ingestion service once:

```bash
bash scripts/install-ingestion-service.sh
curl -fsS http://localhost:8001/health
```

The LaunchAgent starts at login, scans its configured readable sources every 10
seconds, and ingests bounded batches on the host. The Jobs page's ingestion
**Run now** button calls the same serialized service, so it cannot overlap the
automatic cycle. Ingestion remains host-side because local source paths are
deliberately not mounted into the Docker Python worker. The installer waits up
to 90 seconds for `/readiness`, independently of ingestion completion, and
prints the ingestion health and per-source result; the
service includes standard Intel and Apple Silicon Homebrew paths so `uv`,
`ffmpeg`, and `ffprobe` remain available under launchd's minimal environment.
The health response is `degraded` when a configured staging source cannot be
opened, an upload fails, or eligible sources have unresolved cached errors.
`lastCycle.ingestion` reports attempted, successful, failed, remaining, and
cached-error counts. An empty readable catalog with no unresolved ingestion
failures remains healthy. Installation can succeed while ingestion health is
`starting` or `degraded`; readiness confirms application startup only.
Invalid ingestion batch or interval settings prevent startup. The installer
bounds each complete HTTP request within its overall 90-second deadline and
retries interrupted or malformed readiness responses.

Open **Audio → Pipeline → Audio processing overview** for ingestion reachability,
last completed scan, last imported files (recording and import dates), staging
publication time, and the Import → VAD → Transcription backlog in one place.
**Check service** refreshes lightweight status; **Scan staging now** queues one
serialized ingestion batch, not a refresh of Apple's protected library.
**Update audio counts** explicitly recalculates the corpus snapshot. Counts keep
their calculation time, and unavailable counts appear as `—`, not zero. Service
and queue status refresh every 15 seconds while the page is visible; exact audio
counts never run on that timer. A running service with cached errors or an old
staging publication does not mean all Apple recordings have been imported.

To preview a Voice Memos archive refresh without changing anything, then apply
and verify it when ready:

```bash
bash scripts/refresh-voice-memos-staging.sh
bash scripts/refresh-voice-memos-staging.sh --apply
```

`--apply` runs the existing `~/claude-cowork/icloud-archive-tool` Voice Memos
component, performs its full verification, and copies the audio at or after
`MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE` plus the newest `CloudRecordings` snapshot
under `~/Library/mycelia/voice-memos-staging`. Audio is published additively;
the database is replaced atomically only after every bounded audio file passes
a hash check. Start it interactively so only the trusted Terminal crosses the
macOS privacy and external-volume boundaries; the background `uv` process never
does. The LaunchAgent discovers the local published update on its next cycle.
Incremental staging budgets space for audio needing copying, a temporary
SQLite snapshot, and a 1 GiB reserve; verified unchanged audio is reused.
Existing audio symlinks are materialized as regular local files; symlinked
staging directories are rejected before publication.
UUID lookup is paginated. A unique pending recording can be rebound to a
readable configured copy, preserving its source ID and cached error. Retry
cached failures explicitly after repair; ambiguous identities are reported
for review without creating another source or changing a pending path. This
includes catalog entries assigning multiple paths to the same UUID.

For a custom archive, export `MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT` and configure
the archive tool's `ARCHIVE_TARGET` to point to the same directory. The wrapper
loads `ICLOUD_ARCHIVE_CONFIG` (or the tool's `config.env`) and compares the
resolved paths before every preview, refresh, and verification. A mismatch
stops the command; the tool's config can override an exported `ARCHIVE_TARGET`.

For a verified backup whose audio and database snapshot are stored separately,
run one bounded recovery cycle like this:

```bash
cd python
MYCELIA_APPLE_VOICEMEMOS_ROOT=/path/to/audio-original \
MYCELIA_APPLE_VOICEMEMOS_DB=/path/to/CloudRecordings.snapshot.db \
MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE=2026-08-24T00:00:00+04:00 \
MYCELIA_APPLE_VOICEMEMOS_MODE=staged \
uv run --env-file ../.env daemon.py --once
```

Stop the LaunchAgent before a foreground recovery and start it again afterward.
The Apple importer uses the full Voice Memo UUID for deduplication, so changing
from the live path to a backup path does not create a second source record. The
cutoff limits discovery only. Refresh and republish the staging snapshot before
expecting newer recordings to appear in the automatic scan.

Audio chunks are written with idempotent MongoDB upserts in batches of 50. A
retry after interruption reuses `(original_id, index)` and does not duplicate
chunks, while avoiding one HTTP round trip for every 10-second segment.

For a foreground session instead, use:

```bash
cd /path/to/mycelia
./scripts/run-audio-pipeline.sh
```

It starts the Docker services and then runs local discovery/import on the host.
With the recommended `staged` mode, Apple Voice Memos are still read from the
published local staging directory. Direct access to the live protected library
is only an explicit `live`-mode foreground exception. After each audio chunk is
inserted, the backend automatically runs the remaining stages:

The foreground wrapper waits up to three minutes for backend readiness before
starting the host daemon. Do not run it while the LaunchAgent is active, because
both processes would discover and ingest the same source files.

```text
daemon import -> VAD -> speech sequence creation -> remote STT -> conversations
```

Configure one or more transcription routes on the dedicated **Settings ->
Speech-to-text** page. Each provider has an OpenAI-compatible base URL, API key,
model, enabled switch, priority, and parallel slot count. Lower priority numbers
are selected first; providers with the same priority are load-balanced, and
lower-priority routes receive overflow when earlier routes are full. A job keeps
its selected provider snapshot even if routing is edited later.

The dedicated `STT_SERVER_URL`, `PROXY_API_KEY`, and optional `STT_MODEL`
variables from `.env` appear as the **Backend environment STT route**. Enable
that route in the same settings card if it should run alongside UI-managed local
or remote providers. Its secret remains environment-managed.

For a local Argmax server on port 10301, use `http://host.docker.internal:10301`
in the Mycelia UI. Test it directly from the Mac before adding it:

```bash
curl -fsS http://127.0.0.1:10301/health
curl -fsS \
  -H 'Authorization: Bearer local-no-auth' \
  -F 'file=@test.wav;type=audio/wav' \
  -F 'model=large-v3-v20240930_626MB' \
  -F 'response_format=verbose_json' \
  http://127.0.0.1:10301/v1/audio/transcriptions | jq .
```

Argmax does not validate this placeholder bearer token, but Mycelia requires a
non-empty profile key. See
[Local STT with Argmax and Whisper](docs/LOCAL_STT.md) for startup, Docker
networking, and model-specific examples.

### Local speaker diarization (Docker)

Argmax and the Mycelia diarizator are separate providers. `argmax-cli serve`
exposes WhisperKit transcription only. `argmax-cli diarize --audio-path ...` is
a one-shot Apple Silicon CLI that writes diarization output for one file; it
does not expose Mycelia's required `/health`, `/diarize`, and `/embed` HTTP
endpoints or the compatible Pyannote/WeSpeaker embedding space.

Run the supported local diarization service in the main Mycelia Compose project:

```bash
cd /path/to/mycelia

# First start, or after changing the Dockerfile/dependencies:
docker compose --profile diarization up -d --build diarizator

# Normal subsequent start:
docker compose --profile diarization up -d diarizator

docker compose --profile diarization ps diarizator
docker compose --profile diarization logs -f diarizator
```

Set `HF_TOKEN` in the repository `.env` and accept access to both gated models
listed in [`diarizator/README.md`](diarizator/README.md). Inside the Mycelia
network the service URL is:

```dotenv
DIARIZATION_SERVER_URL=http://diarizator:8085
```

Verify model readiness and a real audio request, not only container state:

```bash
curl -fsS http://127.0.0.1:8085/health | jq .
curl -fsS http://127.0.0.1:8085/ready | jq .
curl -fsS \
  -F 'file=@test.wav;type=audio/wav' \
  'http://127.0.0.1:8085/diarize?min_speakers=1&max_speakers=2' \
  | jq '{segments: (.segments | length), speakers: [.segments[].speaker] | unique}'
```

`/health` is liveness and reports effective batching plus inference concurrency.
`/ready` becomes HTTP 200 only after the requested compute device and both
models are ready. Each diarizator process runs one inference at a time; Mycelia
provider `Slots` must therefore remain `1` per process.

In **Settings → Diarization**, enable the environment route, set it to the
highest preference (for example priority `1`), and confirm that it reports
**Running**. See [`diarizator/README.md`](diarizator/README.md) for memory,
remote GPU, and troubleshooting details.

Turning a diarization route off blocks new jobs from that server. A request
already in flight may finish, but the active batch checks the saved route before
each following sequence and stops before making another request. The route
toggle does not stop the diarizator container or remote server process.

When historical diarization work exists, the automatic trigger treats the
pending check as a boolean and immediately fills every free healthy provider
slot. A six-route pool therefore starts up to six independent jobs without a
five-minute one-at-a-time ramp.

Historical workers take an expiring recording-level lease before hydrating
audio. Set `DIARIZATION_PREFETCH_SEQUENCES=1` only after the lease metrics show
low contention; it keeps exactly one decoded lookahead WAV and never overlaps
provider POST requests within a job.

#### Debugging conversation re-extraction

The scripts in `scripts/debug/` find and optionally enqueue historical
conversation chunks that need the v2 extractor. Finding records only prints a
tab-separated preview and never creates a JSONL file automatically:

```bash
./scripts/debug/find-conversations.sh
```

Create a JSONL input only when explicitly requested, then review it and pass
that exact file to the enqueue script. Start with `--dry-run` before enqueueing
jobs:

```bash
./scripts/debug/find-conversations.sh --write-json /tmp/conversations.jsonl
./scripts/debug/enqueue-conversations.sh --input /tmp/conversations.jsonl --dry-run
./scripts/debug/enqueue-conversations.sh --input /tmp/conversations.jsonl
```

Both scripts use `.env` OAuth credentials for enqueueing; do not commit an
exported JSONL file or credentials.

LLM routing is configured separately in **Settings -> Inference**. Choose a
default model for new memory chats independently from the preset's background
task default, optionally override summaries, conversation extraction, or
tagging, and choose the failure policy for each feature: **Stop with error** or
retry once with a specific fallback model. The same provider settings can be
supplied with `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and
`OPENAI_CHAT_MODEL` in `.env`. Per-feature fallback defaults are
`SUMMARIZATION_FALLBACK_MODEL`, `CONVERSATION_EXTRACTION_FALLBACK_MODEL`, and
`TAGGER_FALLBACK_MODEL`; leave them unset to stop on error. Streaming chat never
switches models silently.

Before running it, configure at least:

```dotenv
STT_SERVER_URL=http://gpu-host.example:8001
PROXY_API_KEY=your-proxy-key
STT_MODEL=whisper
```

Use the `whisper` alias when the Portainer stack should use whichever
`ASR_MODEL` it has loaded. The service reports the actual model, and Mycelia
stores it in `transcriptions.metadata.model`.

### Change the Whisper model in Portainer

The model shown in **Settings -> Speech-to-text -> Selected server** is the
model name Mycelia sends for request validation. It does not load a model into
the GPU. The model that is actually loaded is controlled by `ASR_MODEL` in the
Portainer stack and is loaded when the Whisper container starts.

Whisper's internal VAD filter is controlled by the single stack variable
`WHISPER_VAD_FILTER` (default `true` in the GPU compose files). When enabled,
the proxy passes `vad_filter=true` to Whisper and records the effective value in
`transcriptions.metadata.whisperVadFilter`. Set it to `false` and redeploy the
proxy if this filtering should be disabled. The status endpoint exposes the
current value as `whisperVadFilter`.

To change it, for example to `large-v3-turbo`:

1. Open Portainer -> **Stacks -> mycelia-stt -> Editor**.
2. Set `ASR_MODEL` to `large-v3-turbo` in the stack environment variables. Make
   sure the Whisper and proxy services use the same value. If the compose file
   contains a literal `ASR_MODEL`, remove or update any old Portainer stack
   variable that could override it.

   In the repository's `gpu/docker-compose.portainer.yml`, the two service
   entries use `${ASR_MODEL:-large-v3-turbo}`. They are references to one
   Portainer variable, not three independent settings, so normally you change
   only the `ASR_MODEL` value under **Environment variables**. This compose is
   intentionally STT-only. Remote diarization is deployed from
   `diarizator/compose.portainer.yml`, which is the canonical one-to-six process
   pool definition.
3. Choose **Update the stack** and confirm the redeploy. Both
   `mycelia-stt-whisper-1` and `mycelia-stt-proxy-1` must be recreated.
4. In Portainer, inspect both containers and confirm their environment has
   `ASR_MODEL=large-v3-turbo`. `running` alone is not enough.
5. From a machine that can reach the STT host, verify the proxy advertises the
   loaded model:

   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $PROXY_API_KEY" \
     http://gpu-host.example:8001/v1/models
   ```

   The response must contain `large-v3-turbo` in `data[].id`.
6. Back in Mycelia, press **Load STT models**, select `large-v3-turbo`, and
   press **Save STT route**. This keeps request validation and provenance
   aligned with the model actually loaded remotely.

If Mycelia shows `large-v3` while `/v1/models` returns `large-v3-turbo`, the GPU
is using Turbo and only Mycelia's saved request setting is stale. If
`/v1/models` returns `502 Bad gateway`, update the proxy image first; an old
proxy image sends that endpoint to its obsolete Ollama catch-all route.

To audit or correct old transcription provenance, use the safe dry-run script
from `python/`:

```bash
uv run debug/repair_transcription_model_provenance.py
```

It only matches `metadata.model=large-v3` records produced by the remote STT
provider and prints a sample. Apply the correction only after confirming that
those historical requests were really processed by Turbo:

```bash
uv run debug/repair_transcription_model_provenance.py \
  --apply --confirm-turbo
```

The script records the old and new values in `metadata.modelCorrection`. Do not
rewrite every `large-v3` record blindly: records made while the GPU really had
the non-Turbo model should retain their original provenance. Use `--start-after`
and `--start-before` to bound the repair when only a known time window was
processed by Turbo.

The normal `daemon.py` process performs discovery, ingestion, and device-info
backfill only. It does not calculate VAD. After a chunk is inserted, the backend
change-stream trigger creates a `vad` job, and `python-worker` runs the shared
Silero implementation from `python/jobs/vad.py`. This queued path records job
state and progress in the Jobs UI and is the normal production path.

`daemon.py --vad-only` calls that same Python VAD implementation directly while
bypassing the backend job queue. It does not create a Jobs UI record and is
intended only for recovery or manual backfills when the automatic queue is
unavailable or blocked. `stt.py` is likewise a direct recovery tool. Do not run
direct VAD or STT alongside a healthy automatic pipeline: the direct processes
can select work that the queued pipeline is also processing.

#### Run Import and VAD in Parallel

Use this recovery path only when the backend job queue is unavailable or
blocked. Keep file discovery/import on the host so it can access your local
recordings, and run VAD in the Python worker container where the Silero model
and cache are already available.

Terminal 1:

```bash
cd /path/to/mycelia/python
uv run daemon.py
```

Terminal 2:

```bash
cd /path/to/mycelia
docker compose exec python-worker python daemon.py --vad-only
```

For a bounded VAD run:

```bash
docker compose exec python-worker python daemon.py \
  --vad-only \
  --once \
  --vad-limit 1000 \
  --vad-batch-size 100
```

This is process-level parallelism: importing and VAD can run simultaneously. Do
not start multiple VAD-only processes against the same database, or combine one
with an active queued VAD worker. Direct VAD selects chunks with no VAD metadata
but does not claim them, so concurrent workers can process the same chunks.

After VAD marks speech chunks, inspect and run the direct STT worker only if the
automatic transcription queue is not running:

```bash
docker compose exec -T python-worker python stt.py --count
docker compose exec python-worker python stt.py
```

The host daemon log is written to `~/Library/mycelia/logs/daemon.log`.

### Configuration

When you first open the frontend, you'll be guided through a setup wizard:

1. **Server Connection** (`/setup`) - Connects to the backend and automatically
   creates your first API key.

2. **Inference Provider** (`/setup/inference`) - Configure an OpenAI-compatible
   endpoint and initial model. Settings → Inference then lets you separate the
   default for new memory chats from background-task routing. Local GPU stacks
   are supported; see [GPU README](gpu/README.md).

You can reconfigure these settings anytime in Settings.

#### Managing API Keys

- **Via Settings UI**: Go to Settings → API Keys to create, view, and revoke
  keys
- **Via Terminal** (for initial setup or automation):
  ```bash
  docker compose run --rm backend deno run -A server.ts token-create
  ```

## For Developers

See **[DEVELOPMENT.md](DEVELOPMENT.md)** for:

- Docker dev/prod modes, hot reload, and the rebuild/recreate matrix
- Parallel development on two branches (second frontend or a second full stack)
- Native development setup (Deno + Vite)
- Python tooling (audio import, STT, conversation extraction)
- GPU inference stack setup
- Database backup & point-in-time recovery
- Project structure and contributing guidelines

## Contributing

You're welcome to fork, build plugins, suggest features, or break things
(metaphorically, c'mon, it's open source).

- Join the [Discord](https://discord.gg/hPfYbpp2am)
- PRs are welcome

## License

[MIT](./LICENSE)
