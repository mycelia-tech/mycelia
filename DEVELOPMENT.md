# Development Guide

This guide is for developers who want to contribute to Mycelia or run it in
development mode with hot reload.

## Development Setup

### Option A: Docker with Hot Reload

The fastest way to get a development environment with hot reload:

```bash
# Set APP_MODE=dev in .env, then apply it:
docker compose build frontend && docker compose up -d --no-deps --force-recreate frontend backend && docker compose restart nginx
```

#### Application Mode Variable

| Variable   | Default | Dev Value | Effect                                                          |
| ---------- | ------- | --------- | --------------------------------------------------------------- |
| `APP_MODE` | `prod`  | `dev`     | Selects both the frontend runtime and the backend reload policy |

`APP_MODE` is optional and defaults to production mode. In dev mode, frontend
changes are handled by Vite HMR and backend changes restart the Deno process
through `deno --watch`.

`APP_MODE` selects `Dockerfile.dev`/`Dockerfile.prod`, a separate local frontend
image tag, and the matching backend task. Switching it therefore requires a
frontend build, frontend/backend recreation, and an nginx restart. The backend
image itself does not need to be rebuilt.

After changing `APP_MODE` in `.env`, apply it without rebuilding the unchanged
backend image:

```bash
docker compose build frontend && docker compose up -d --no-deps --force-recreate frontend backend && docker compose restart nginx
```

Use this rebuild matrix to avoid unnecessary work:

| Change                        | Dev mode                                                 | Production mode                                                                      |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `frontend/src`                | Vite HMR; no build/recreate                              | Build and recreate `frontend`, then restart nginx                                    |
| Backend source                | Deno watcher reloads it                                  | Recreate `backend`, then restart nginx; no image build for the bind-mounted checkout |
| Python source                 | Recreate `python-worker`; no image build                 | Same                                                                                 |
| `APP_MODE`                    | Build frontend; recreate frontend/backend; restart nginx | Same; no backend image build                                                         |
| Dockerfile or dependency lock | Build and recreate only the affected service             | Same                                                                                 |
| Runtime `.env` value          | Recreate only affected services                          | Same                                                                                 |

Backend, frontend, and python-worker builds use Dockerfile-specific allowlists.
Only their source tree (plus `myceliasdk` where needed) enters the build
context; worktrees, database files, logs, local virtual environments,
`node_modules`, and existing frontend output cannot invalidate application-image
layers.

#### Environment file consistency

Audit `.env` against `.env.example` after pulling changes:

```bash
./scripts/check-env.sh --all
./scripts/check-env.sh
./scripts/check-env.sh --strict
./scripts/check-env.sh --json
```

The report contains key names and line numbers but never values. It shows file
statistics, missing required keys, optional keys, undocumented keys, duplicate
definitions, blank values, malformed assignments, and formatting issues. The
command exits non-zero when the files need attention, so `--json` can be used in
CI or other automation. `--all` treats the root contract as required and the
standalone diarizator, GPU, and RAG deployments as optional; missing optional
`.env` files are reported without failing the audit.

Apply only safe automatic repairs with:

```bash
./scripts/check-env.sh --fix
```

`--fix` creates a private timestamped `.env.backup-*`, adds required missing
keys, securely generates a missing blank `SECRET_KEY`, normalizes assignment
spacing, and removes identical duplicate definitions while preserving their
effective last value. It never deletes undocumented keys and refuses to modify
conflicting duplicates or malformed assignments.

After reviewing the reported names, remove keys that are no longer owned by a
specific template with an explicit, single-contract command:

```bash
./scripts/check-env.sh --fix --prune-undocumented
./scripts/check-env.sh \
  --env diarizator/.env \
  --example diarizator/.env.template \
  --fix --prune-undocumented
```

The deployment contracts remain separate because they are loaded by different
services. Compose services pass explicit diarizator and RAG variables instead
of injecting an entire application `.env` containing unrelated secrets.

#### Readiness and reload diagnostics

Container `running` status is not sufficient evidence that the application has
loaded its current source. Follow the readiness logs and Docker health state:

```bash
docker compose ps
docker compose logs -f frontend backend \
  | rg --line-buffered '\[SERVICE\]|\[READY\]|ready in|Restarting'

curl -fsS http://localhost:3210/ >/dev/null
curl -fkSs https://localhost:4433/health >/dev/null
```

Expected readiness records:

```text
[READY] frontend ready mode=development hmr=enabled ...
[READY] backend ready mode=dev workers=true ... readiness=/readiness ...
```

The backend `/readiness` endpoint returns `503` while resources and workers are
starting and `200` only after workers, triggers, and maintenance have started.
An ordinary frontend `src/` edit uses HMR without a full restart. Editing
`vite.config.ts` restarts Vite and can briefly return `502` until the next
frontend `[READY]` record. A backend source edit restarts the Deno process and
may keep `/readiness` unavailable while worker startup checks run.

The Media page uses the same development backend. A `502 Bad Gateway` during a
source edit means nginx temporarily had no ready upstream; wait for the next
backend `[READY]` line and retry the local proposal. Clustering validation and
per-item cost guards return structured application errors instead of 502. The
Media library never loops over visible cards to queue recognition. The separate
`/media/analysis` page sends one exact server-side selection receipt; the
coordinator creates separate photo jobs so one rejected item does not fail the
rest of the batch. Large mounted-folder sync and recognition batches return
immediately, resume in 25-file chunks or a bounded photo-job window, and the
30-second watchdog resumes a broken continuation after restart. Browsing,
filtering, and local import remain available while older batches run. Google
profiles use Vertex visual understanding/embedding plus strict-EU Vision OCR;
self-hosted profiles receive the same fixed visual-understanding + OCR request
without a Google call. Global labels/objects are excluded from this bulk path.

The dependency watchdog uses its own one-connection MongoDB pool. Long-running
imports and worker rebuilds may make ordinary queries slower, but they must not
starve the watchdog or cause `[SELF-HEAL]` restarts from an application-pool
`connection checkout` timeout.

Mongo change notifications use a separate four-connection pool and two cursors:
an Objects cursor preserving the selective lookup/catalog behavior, and a
database cursor excluding Objects. They no longer allocate one long-poll cursor
per collection from the application query pool. Startup logs
`[ChangeStream] Started 2 isolated cursors (objects + database)`.

When a change is not visible:

1. Run `git status --short` and preserve unrelated work from parallel agents.
2. Verify the live bind mounts point at this checkout:

   ```bash
   docker inspect mycelia-backend-1 \
     --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
   docker inspect mycelia-frontend-1 \
     --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
   ```

3. Confirm the effective commands with `docker compose config`: backend must use
   `deno task dev`, while frontend must use `Dockerfile.dev`.
4. Source changes should reload automatically. Changes to Dockerfiles,
   dependencies, Compose configuration, or `.env` require rebuilding or
   recreating the affected service.
5. After recreating frontend or backend, restart nginx because the container IP
   may have changed: `docker compose restart nginx`.
6. Do not restart MongoDB or Redis for an application-code reload.

#### Photo/PDF Knowledge in the main UAT stack

The main `sky-uat` stack keeps its existing project, database, ports, and other
overlays. To expose the mounted media source and Google ADC to that backend,
set absolute `MEDIA_SOURCE_HOST_PATH` and `GCP_ADC_HOST_PATH` values in the
uncommitted `.env`, then append `docker-compose.media-uat.yml` to the same UAT
Compose command. Do not copy the ADC JSON into the repository.

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.media-uat.yml \
  up -d --no-deps --force-recreate backend

docker compose \
  -f docker-compose.yml \
  -f docker-compose.media-uat.yml \
  restart nginx
```

If UAT already uses another overlay, keep it in both commands and append the
media overlay last. Verify that `/media-source` and `/run/secrets/gcp-adc` are
read-only mounts, wait for backend `[READY]`, then require `/readiness = 200`.
Missing host variables or paths fail at Compose time rather than producing a
later `MEDIA_SOURCE_ROOT is not configured` request error. MongoDB and Redis do
not need to be recreated.

#### Isolated Photo/PDF Knowledge development

Use the media overlays when the feature must run without sharing the main
checkout's Docker state. The overlay fixes the Compose project name to
`mycelia-media-89da`, publishes `3211`/`4443`, removes the Mongo host port, uses
distinct app image tags, and creates separate Mongo/Redis volumes.

```bash
cp .env.media.example .env.media.local
# Set absolute MEDIA_SOURCE_HOST_PATH and replace development secrets.

docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  up -d --build mongo redis backend frontend nginx
```

Verify the actual checkout and runtime before testing:

```bash
docker inspect mycelia-media-89da-backend-1 \
  --format '{{range .Mounts}}{{println .Source "->" .Destination .RW}}{{end}}'
docker inspect mycelia-media-89da-frontend-1 \
  --format '{{range .Mounts}}{{println .Source "->" .Destination .RW}}{{end}}'

docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  ps

curl -fsS http://127.0.0.1:3211/readiness
```

The source folder must appear at `/media-source` with `RW=false`; backend must
report `mode=dev`, frontend `mode=development`, and both must emit `[READY]`.
Run `bash scripts/smoke-media-local.sh` to verify analyze → confirm → protected
WebP retrieval without queueing recognition. Add `docker-compose.media-gcp.yml`
when testing ADC/GCP; keep it on every backend recreate so the credential mount
is not dropped. Untouched upload previews expire after one hour, while an
interrupted confirmation has a bounded seven-day idempotent recovery lease.

For removable disks on macOS, append `docker-compose.media-disks.yml` after
the primary media overlay. It mounts the stable `/Volumes` directory read-only,
so individual disks are optional at startup. In **Media → Choose folder**, open
**Connected disks**, refresh after connecting a disk, and select a disk or folder
before scanning. First create an empty `disks` directory inside the local
`MEDIA_SOURCE_HOST_PATH` folder for the nested mountpoint. The default
local-folder scan excludes these separate sources.
See [External photo libraries](docs/MEDIA_KNOWLEDGE.md#external-photo-libraries)
for stable aliases that preserve existing original-file references.

When switching from a direct disk mount, remove only its old overlay from the
local `.env` `COMPOSE_FILE` (for example, `docker-compose.media-external.yml` or
a local `docker-compose.media-local.yml`). Keep the primary media and credential
overlays. Run `docker compose config --quiet`, then
`docker compose up -d --no-deps backend` and `docker compose restart nginx`;
verify `/readiness`. Do not create an empty replacement for a disconnected disk.

Full setup and the provider-neutral
visual-understanding/embedding contract, configurable gross-cost guards
(24-hour Free Trial confirmation or persistent project-bound paid mode), and
visible committed/reserved cost ledger, multipart managed uploads, EXIF/GPS
extraction, and preview-confirm deletion of managed originals are in
[docs/MEDIA_KNOWLEDGE.md](docs/MEDIA_KNOWLEDGE.md).
The same guide covers the separate local photo-event proposal → group consent →
provider analysis → Event Object publication flow; event analysis is never
triggered automatically by import. Reanalysis also uses its own exact-thumbnail
preview and confirmation; cancelling a worker after the provider-start fence is
not proof that the remote request was cancelled or unbilled.

For the 900-photo campaign, place originals under
`MEDIA_SOURCE_HOST_PATH/900-photos/` and select `900-photos` in the mounted
folder browser on `/media`; `.` remains the default recursive root. Local folder
sync does not call Google. Its single normal `mediaFolderImport` job loops over
durable 25-file commits and publishes checked/total progress, speed and ETA to
Media and Jobs. A later sync still inventories and stats the selected tree, but
reuses a prior item SHA and metadata only when owner, relative path, byte size,
and modification time all match; `reused SHA` in the campaign report makes this
visible. New or changed files are hashed normally. Restart/recovery attempts
remain durable history, but Jobs
groups the same `campaignId` into one visible campaign row. On
`/media/analysis`, a batch preview can select an explicit set or every eligible
asset matching the current server-side filters, not only the visible gallery
page. The shared date-range picker uses the configured application timezone;
the **Unprocessed by capture-date range** shortcut waits for the new server
scope, selects all matching pages, and never reuses a stale page after a filter
reload fails. The preview rechecks retained-original and sanitized-WebP
pointers plus active reservations. It then fixes visual-understanding + OCR and
shows the authoritative eligible count and batch ceiling before consent. With a
Google profile this means Vertex
visual understanding/embedding plus strict-EU Vision OCR; a self-hosted profile
sends the same feature request only to its configured endpoint. Photos with
local time/GPS are queryable through indexed Timeline/Map projections in every
recognition state. At close map zoom, grouped markers expand into a thumbnail,
caption, status, and capture-time list; the adaptive Photos Timeline track opens
the same library links from overlapping markers or a selected density bucket.
Missing values are kept in Unplaced and can be edited without a provider call.
Jobs presents the durable recognition campaign as one
`mediaRecognitionBatch` row with aggregate done/total and state counters;
per-photo `mediaRecognition` jobs are hidden from the normal list and retained
only for explicit diagnostics. Jobs launch/restart actions follow the worker
catalog's `manualRun` capability. Generic cancel/clear actions leave folder
imports, recognition batches, and paid per-photo work untouched; manage those
campaigns on `/media` and `/media/analysis` instead.

Optional **Import + Google** uses `previewFolderStream` → `confirmFolderStream`
to authorize a source-scoped total gross ceiling (not a snapshot of all future
photos). A running folder campaign can be upgraded without restarting discovery.
The local coordinator overlaps bounded directory pages and 25-file inspection /
preview steps. Its 24-hour job timeout replaces the generic 15-minute timeout;
Mongo cursors/claims still recover if interrupted. Local-only scan → review →
confirm is unchanged.

The independent `mediaRecognitionBatch` coordinator dispatches one immutable
wave per stream at a time, up to 500 photos (UI default 100), flushing a partial
wave after 30 seconds or local completion. `0084_media_folder_streams` creates
authorization TTL, runnable-stream, batch lookup and unique campaign/asset
assignment indexes. The exact pending preview and integer-microdollar allocation
are committed together before dispatch; crash recovery replays the receipt.
Confirmed authorizations are retained; unconfirmed previews expire in one hour.
Late duplicate files and failed photos are not automatically recharged by the
same stream. Retry failures through a fresh explicit Analysis batch.

`pauseFolderStream` stops **new waves**, not previously confirmed batches or local
import. Resume reviews the **total** ceiling including already allocated waves;
allocation is conservative, not actual spend, and unused wave estimates are not
automatically refunded. Profile/source changes pause the stream. Monthly budget
exhaustion (or daily exhaustion when enabled) defers new waves to the next UTC
window. An explicit `mediaKnowledge.promoGuard.dailyGrossLimitUsd: null` disables
only the daily stop; dispatch then uses monthly capacity while continuing to
record daily usage. Missing values retain the guarded default. Per-photo ledger
reservations remain the final race-safe limit. No Google request is authorized
merely by starting a local scan.

#### Disabling Google without deleting media

An expired credit is not an application-level stop switch. To stop the existing
Google photo path, disable its profile in Google Cloud settings. If it is the
only recognition provider, also set `mediaKnowledge.enabled` to false. Local
uploads, folder import, previews and stored results remain available.

Pause Google folder streams and cancel any unstarted confirmed Google batches.
When no non-Google photo work shares the queues, pause `mediaRecognition` and
`mediaRecognitionBatch` through Jobs as an additional durable safeguard. Pause
stops new work; a provider request that already started may still finish. Do not
clear queues, delete history, remove originals or restart MongoDB/Redis to stop
cloud processing. Disable Google/Gemini text profiles separately, including any
Google environment fallback. This does not disable APIs in the Google account.

Re-enabling photo queues later requires a deliberate review of their pending
provider snapshots; an old Google batch must not silently become a local-model
batch. The proposed general connection and results-review feature is described
in the [provider-neutral photo design](docs/superpowers/specs/2026-09-30-provider-neutral-photo-analysis-design.md);
that document is a design, not a claim that the new adapter is deployed.

The Media workspace uses progressive disclosure: the folder tree is collapsed
until **Choose folder** is activated, while durable campaign progress remains
visible. Status, placement, sorting, page/all-results selection, and processing
actions share one compact toolbar. Long provider, privacy, placement, and
incremental-sync explanations belong in the reusable hover/focus `MediaHint`
rather than in always-visible paragraphs; the tooltip trigger must retain an
accessible name for keyboard and screen-reader users.

Media detail exposes one **Storage & deletion…** panel. **Remove from Mycelia**
deletes an external-reference or preview-only library record together with its
Mycelia WebP previews and derived projections, writes a local deletion receipt,
and never deletes the mounted original. A later folder sync may import that
still-present original again. **Ignore for processing** instead preserves the
record, previews, original reference, and existing analysis while excluding it
from unprocessed/attention selection; **Return to processing** clears that
flag. Managed originals must still use their separate preview-and-confirm
deletion before the remaining library item can be removed. These mutations must
claim the same per-asset reservation used by recognition batches and are
rejected while recognition is reserved, queued, or processing. A managed
original deletion remains preview-and-confirm; cancelling its review must call
`cancelOriginalDeletionPreview` so the reservation claim is released instead
of waiting for expiry.

#### Isolated Qdrant RAG development

The vector projection has its own Compose project, ports, state database, model
cache, and Qdrant volume. Do not add it to the main `docker compose up` command
or restart MongoDB/Redis while iterating on RAG code.

```bash
cp .env.rag.example .env.rag.local

docker compose \
  --env-file .env.rag.local \
  -f docker-compose.rag.yml \
  up -d --build
```

Default host ports are RAG API `48091`, Qdrant REST/dashboard `46333`, and
Qdrant gRPC `46334`. They do not overlap the main application. Verify process,
dependency readiness, and projection readiness separately:

```bash
docker compose \
  --env-file .env.rag.local \
  -f docker-compose.rag.yml \
  ps
curl -fsS http://127.0.0.1:48091/health
curl -fsS http://127.0.0.1:48091/ready
curl -fsS http://127.0.0.1:48091/v1/status
```

`/health` is only liveness. `/ready` checks for a compatible active Qdrant
projection/alias and enforces the optional read-only-principal gate;
`/v1/status` is the authoritative view of build/catch-up/active and checkpoint
freshness state. A failed blue/green rebuild must leave the previous active
collection intact. Evidence search separately bulk-revalidates candidate source
revisions and filters against MongoDB and therefore fails closed if that
canonical read is unavailable. The complete lifecycle, connection modes, control
semantics, and deferred authorization/read-only-user migration are documented in
[docs/RAG_QDRANT.md](docs/RAG_QDRANT.md).

The default inference profile is the local
`fastembed-minilm-bm25-v1` baseline with pinned MiniLM/BM25 artifact revisions and
no reranker. `/v1/status` and **Settings → Knowledge index** show the full
embedding-space fingerprint and executor state. A future Qwen3/4090 service is a
separate HTTP executor and new blue/green projection; it is not enabled by any
Stage 1 environment variable. The Stage 1 model, revision, tokenizer,
instructions, dimensions, and normalization values are immutable and invalid
overrides stop configuration loading. Future local/remote executors must report
the same embedding fingerprint and chunker contract before they can write or
query one generation.

#### Objects browse and Timeline density rollout

The Objects page does not run MongoDB aggregation pipelines in the browser. Each
section uses the bounded `objects.listCards` action: 9 cards on the first page,
cursor-based pages of up to 30 afterwards, at most two section requests at once,
and a 3-second database deadline. Sections are loaded as they approach the
viewport. Cached type counts refresh separately from the more expensive orphan
count; a failed orphan refresh keeps the last value instead of replacing it with
zero.

Two manual-only Jobs tasks prepare the indexed projections used by this path:

- `objectListCatalogBackfill` fills `_listCategories` in batches of 1000 and
  enables the catalog only after missing/mismatch and legacy-count parity checks
  pass.
- `objectTimelineDensityRebuild` builds the isolated `object_timeline_density`
  projection in 31-day source windows. At a far zoom, the Timeline reads only
  this projection and makes no raw object-list request.

For an existing database, use a controlled rollout:

1. In **Jobs**, pause the `diarization` worker and wait for its active job to
   finish. Pausing prevents new work; it does not kill an active job.
2. Recreate only the changed backend/frontend application services, restart
   nginx, and wait for backend `[READY]`, `/readiness = 200`, and healthy app
   containers. Migrations `0051`, `0052`, and `0053` create the indexes, empty
   projection collections, and durable density queue. `0053` idempotently
   repairs installations that recorded an earlier `0052` before the queue and
   state fields existed. Migration `0063` adds the Jobs dashboard snapshots,
   run-history rollups, Timeline campaign lifecycle, and the indexed entity
   typing marker. Do not restart MongoDB or Redis.
3. Run one `objectListCatalogBackfill` job. Its `hasMore` continuations drain
   the catalog automatically; verify `object_list_state` has
   `schemaVersion: 2, ready: true, entityTypingReady: true` before treating
   indexed section reads and the covered entity-typing backlog count as active.
4. Run one `objectTimelineDensityRebuild` job. Enable/accept the far-zoom bars
   only after `object_timeline_density_state._id = "current"` reports
   `ready: true` and `building: false`.
5. Recheck MongoDB load and application readiness, then resume diarization.

Both rebuilds preserve canonical object timestamps. A failed catalog parity
check leaves `ready: false` and `listCards` on its bounded legacy predicate. A
density rebuild never writes the shared Timeline histogram collections.

#### Historical diarization cursor guardrails

Historical diarization scans `audio_chunks` through a metadata-only cursor
(`_id`, source, sequence position, timestamps, and retry state). An expiring,
token-scoped recording lease prevents two jobs from preparing the same source.
Each production job first reserves exactly one pending recording and then opens
a sequence cursor scoped to that `original_id`, so parallel GPU lanes do not
scan the same recording or prefetch work assigned to another lane. With prefetch
disabled, each sequence is synchronously hydrated and decoded under its lease
before it is claimed immediately ahead of the provider POST. With
`DIARIZATION_PREFETCH_SEQUENCES=1`, the same preparation may overlap one
provider call as a single bounded lookahead; promotion still requires a claim.
The cursor uses the diarization work index, a 5-second Mongo deadline, and an
explicit `mongo.closeCursor` call whenever a batch stops early.

One `diarization-…` campaign is the durable identity of a historical backfill,
not a container and not a single BullMQ job. Every bounded job and its `hasMore`
continuation keep the same campaign id. A successful batch schedules the next
one; the five-minute trigger is a watchdog that resumes eligible work after a
crash or broken continuation. Pausing the diarization worker prevents new
batches and lets active work finish; resuming continues the same campaign. Route
enablement and slot counts control parallelism independently of campaign
identity. The Audio Pipeline card shows only progress, rolling speed, useful
realtime, active/queued work, ready slots, and errors; detailed jobs remain on
the Jobs page.

Current workers add `result.processedRange` and the same live progress field
from the earliest through latest successfully processed audio in each job. Jobs
links that interval to Timeline without querying `audio_chunks` again.
Older/manual jobs fall back to their requested `data.start`/`data.end`; a job
with neither field has no range rendered rather than an inferred one.

The Job Detail page keeps a batch's recorded diarization errors as historical
evidence, but resolves each affected range against current `audio_chunks` so it
can distinguish recovered retries, pending retries, and exhausted failures. Raw
job payloads, worker logs, and access-audit rows remain available in closed
technical sections instead of expanding the page by default.

Deploy changes to this path by pausing only the diarization worker, draining its
active jobs, recreating `backend` and `python-worker`, and then resuming the
same worker. Do not clear waiting or delayed jobs, and do not restart MongoDB or
Redis. After rollout, verify metadata cursor requests omit `data`, hydration is
limited to the current sequence plus at most one leased lookahead, stopped
batches leave no application cursor registered in the backend, and expired
`diarization_recording_leases` can be acquired by a new worker.

Archive-wide `diarization` jobs in `missing` mode use route affinity as a
preference, not a hard constraint. A continuation keeps its previous route when
that slot is free, otherwise admission may select another healthy route only
when `modelId`, `modelVersion`, and `embeddingSpaceId` match exactly.
Enrollment, profile re-enrollment, targeted diarization, and generation builds
retain hard route affinity. Every newly routed job snapshots this runtime
contract from the route readiness payload, and the Python worker checks the
inference response again before it persists diarizations or profile embeddings.
Legacy or unknown fingerprints never qualify for compatible fallback. On every
diarizator terminal event, the backend first drains persisted work in
priority/FIFO order and then immediately fills any remaining provider capacity
with archive-wide missing work. This refill uses live BullMQ reservations and
healthy route slots; Mongo waiting rows are history/admission state and must not
suppress an otherwise free GPU. The 60-second maintenance pass remains only a
watchdog for missed events.

The Audio Pipeline page does not run exact corpus counts on a timer. A small
`/api/audio/pipeline/live` response polls the current global campaign, the
BullMQ-reconciled diarization queue, effective worker concurrency, and enabled
and healthy route slots every five seconds while the tab is visible. Route
capacity is derived from current settings; the dashboard never hardcodes a GPU
count. The full corpus snapshot is loaded only through **Calculate current
stats**. Within that snapshot, diarization probes at most one indexed ready
chunk: zero is exact, while existing work is shown either as the persisted
campaign estimate (`≈N`, with its update time) or as `Work remains` when no
estimate is available.

The unified **Audio processing overview** uses authenticated
`GET /api/audio/pipeline/operations`, cached/coalesced for 15 seconds per
authorization scope. Each refresh reads host ingestion `/health`, three BullMQ
queue counters, one `_id`-indexed persisted snapshot, and at most five recent
imports. The latter uses migration `0082_audio_imports_recent.ts`'s
`audio_imports_recent_v1` index and a 1-second Mongo deadline; a missing index
returns an explicit warning, never an unhinted fallback scan. No corpus counts
or audio payloads are read by this endpoint. **Update audio counts** reuses the
existing explicit pipeline calculation and saves its small summary in
`jobs_dashboard_snapshots` (`audio_operations:v1`). A failed core-audio count keeps
the last complete data and timestamp, marking it stale instead of publishing
fallback zeros; unrelated job-history failures do not invalidate audio counts.
Publishing a snapshot invalidates the lightweight cache immediately.
The host adds scan start/finish/trigger, interval/batch settings,
and a bounded read of the configured staging database's publication receipt.
Changing Python source requires restarting only the host ingestion LaunchAgent;
frontend/backend readiness does not prove the host daemon has reloaded.

Jobs **First 8 on** enables diarization routes in displayed order up to the
enforced eight-slot total. Routes that do not fit remain disabled, and the card
keeps the enabled/total route count visible. The same maximum applies to saved
provider capacity and BullMQ worker concurrency.

Jobs → Workers uses the backend worker catalog shared with Settings. Worker
descriptions, availability, queue state, and history stay visible by default;
Concurrency, Batch, and Schedule are available through **Advanced columns**.
Rows are grouped as **Pipeline**, **Maintenance**, and **Diagnostics**. In each
external-service card, the worker action reads **Resume workers** whenever any
routed worker is paused; otherwise it reads **Pause workers**. Diarization route
health and slots stay in External services & routing, so there is no second
live-slots dashboard.

Conversation extraction fills its configured runtime concurrency with atomically
distinct chunk claims. Provider concurrency remains a separate inference limit:
keep a one-slot local LLM profile and the extractor worker at 1, while a tested
OpenRouter profile may use a higher worker value (currently up to 8). The
provider-specific tuning contract and the deferred RTX 4090 two-slot experiment
are documented in `docs/CONVERSATION_EXTRACTION_TROUBLESHOOTING.md`.

#### Timeline density rebuild recovery

Timeline density repairs affect only derived audio/transcription density buckets
(the bars historically called histograms). They never rewrite raw audio,
transcript text, transcription completion markers, or speaker identity. Speaker
identity reads active speaker segments directly, so diarizations are not part of
density totals or repairs.

The manual exact check compares UTC-day raw counts with daily density totals. If
they differ, Jobs proposes only the mismatched days, merges adjacent days, and
starts one sparse durable campaign for those ranges. A known continuous period
can also be selected manually. Rebuilding all history is reserved for a density
schema change or widespread corruption that cannot be localized. New imports do
not automatically start `histRecalculation`; run **Check now** after a large or
historical import.

Every repair creates a durable `timeline_rebuild_campaigns` row before its first
bounded job. Long continuous periods split into 31-day jobs; disjoint affected
dates remain disjoint. `histRecalculation` runs at concurrency one and reports
its delete, 5-minute, hourly, daily, and weekly phases. The backend reconciles
an explicitly started, unpaused campaign every 30 seconds and restores the next
selected range. A legacy campaign remains `paused_legacy` until an operator
confirms **Resume**; page load or deployment never starts it. Pause/Resume and
campaign links are available from Jobs, and the job list filters by
`campaignId`.

Campaign completion requires a manual exact Timeline audit after all planned
batches finish. Jobs -> Timeline density integrity shows **Run exact
verification** while the campaign is `verifying`, and polls every two seconds
while the audit runs. This manual audit scans date-bearing raw rows for exact
counts; maintained collection metadata is used only for fast campaign range
planning because it can lag behind recent bulk ingestion. Matching source and
density totals closes the campaign as `completed`; remaining differences close
it as `completed_with_errors`, release the rebuild control, and require a new
bounded campaign over the affected dates. Stale buckets use **Update stale
ranges**. Transcription completion-marker repair is separate: **Check markers**
is read-only, and **Repair markers** is needed only when the check finds chunks
whose completed/empty sequence still has `transcribed_at=null`. It never creates
or changes transcript text.

The Jobs summary keeps Timeline density integrity in a compact two-row card
above **Work ready now**. **Details** opens the full recovery controls in a
centered modal on the same page.

Recent source-file metadata loads independently once and is ordered by
`source_files.updatedAt`, `start`, and `_id`; it is not described as downstream
processing activity. Opening one row issues one bounded detail request. Closed
rows make no audio-chunk, transcription, conversation-chunk, or object query.
Migration `0060_pipeline_recent_sources_cursor.ts` adds the stable cursor index.

Treat campaign `pendingChunks` as an operational estimate, not as an exact
scheduler input; claiming and completion continue to use canonical chunk state.
Campaign totals are atomically accounted once per job. Throughput and ETA use
one rolling wall-clock window of up to five minutes. Completed
`diarization_campaign_rate_samples` are clipped at the window boundary; active
jobs contribute their end-to-end average only for the part of that window in
which they have run. Their estimated chunks are added and divided by the common
window duration, so continuation-job rotation does not reset the displayed speed
and idle gaps lower it honestly. The live endpoint refreshes this bounded sample
set (at most 500 indexed records) and BullMQ progress every five seconds. A
stalled active job's contribution decays as its runtime grows. Until either
source exists, the UI labels the campaign EWMA as a legacy single-lane estimate.

#### Mongo dashboard load guardrails

Keep live service availability separate from corpus-wide statistics:

- Jobs and Settings read one canonical worker catalog. The last successful
  catalog is persisted in `jobs_dashboard_snapshots`; discovery or Python
  `/capabilities` failure marks rows stale/degraded instead of returning an
  empty list. `ingestion` is daemon-managed: only a bounded **Run now** request
  is allowed; daemon pause, schedule, and concurrency remain host-controlled.
- Page load reads only live queue totals and persisted snapshots. **Update
  history**, **Update backlog**, and the Timeline audit action return an
  operation id immediately; old values remain visible while the leased refresh
  runs. A failed refresh marks the snapshot stale without erasing its data.
- Run history is stored in `job_run_history_daily`. Its first manual build
  creates the terminal-job baseline; later updates scan the `(updatedAt, _id)`
  cursor and rebuild only affected UTC day/type rollups. Clearing terminal rows
  is a soft archive and does not delete the underlying records.
- Exact backlog metrics run sequentially and keep their own freshness/error
  state. A timeout preserves that metric's previous value. Entity typing never
  falls back to the former negative full scan: after `objectListCatalogBackfill`
  validates schema v2, it uses the partial `_entityTypingPending` index.
- Voice identity status reads profile/campaign metadata only. The global active
  diarization classification `$group` runs only through **Calculate exact**. A
  calibration is usable only when its profile id, profile revision, and
  embedding space all match the current primary profile. Adding a sample
  advances the revision. Removing a retained sample clears the old embedding,
  marks the profile rebuild pending, and queues `profileReenrollment`; a failed
  rebuild therefore blocks classification instead of reusing stale thresholds.
- Completed summarization claims are released in indexed batches of at most 100
  per maintenance pass. Do not replace this with an unbounded `updateMany`
  predicate over all objects.
- The Map page reads conversations only from the durable
  `location_conversation_projection`. It never falls back to scanning raw
  `objects`; while the first generation is absent it returns a typed
  `not-built`/`building` state. Summary requests use projection revision,
  viewport, zoom, range, layers and principal in their bounded LRU/single-flight
  cache key. The legacy manual `conversations-on-map` action remains only for
  UAT parity and is no longer called by the Map page. Historical diarization
  metadata cursors stop after 5000 documents per job and retain the five-second
  deadline.

Migration `0056_pipeline_dashboard_indexes.ts` adds the partial Jobs index used
for recent completed transcription batch history and the compound Map index for
conversation time ranges. Migration `0063_jobs_dashboard_snapshots.ts` adds the
dashboard cursor/rollup indexes, durable snapshot and campaign collections, the
unique campaign/batch constraint, and the partial entity-typing marker index.
Apply pending migrations before relying on the new query hints.

#### Location Map projection rollout

Migrations `0068_location_conversation_projection.ts` and
`0069_location_route_projection.ts` create only derived collections, state and
indexes. They do not scan conversations, reparse track files or rebuild data at
startup. Canonical `objects`, `location_points`, source geometry and saved
originals remain unchanged.

For an existing database, use this controlled rollout:

1. Recreate only the changed application services, restart nginx, and verify
   their bind mounts and effective dev commands as described in **Readiness and
   reload diagnostics**. Wait for frontend/backend `[READY]`, healthy app
   containers and `/readiness = 200`; do not restart MongoDB or Redis.
2. In **Jobs**, run **Location map index** with `mode: "all"` and
   `reparseOriginals: true`. Reparse upgrades retained GPX `trkseg` and KML/gx
   track boundaries before route projection. An unavailable or invalid original
   is marked `routeBoundaryCompleteness: "incomplete"`; existing raw geometry is
   retained.
3. Treat conversations as ready only when
   `location_conversation_projection_state._id = "current"` has `ready: true`,
   `building: false`, an `activeGeneration` and a revision. During later
   rebuilds, the previous generation stays readable with `stale: true` until the
   atomic generation swap.
4. Treat routes as ready only when
   `location_route_projection_state._id = "current"` has `ready: true`,
   `building: false`, `dirty: false` and an `activeGeneration`. Review pending
   `location_route_conflicts`; a decision changes derived visibility and never
   deletes the source geometry.
5. Verify a representative far-zoom density request, a zoom-14+ route-detail
   request and a coincident conversation cluster. Summary responses must be
   bounded to at most 2000 clusters; route responses over 50,000 simplified
   coordinates must return overview data with `detailLimited: true`, not a
   silently truncated detail path.

Conversation/object changes enter `location_conversation_projection_pending`;
location segment changes request a coalesced full association rebuild.
Track/geometry changes mark the route state dirty. The `locationMapProjection`
watchdog drains both paths and has concurrency one. A failed rebuild leaves the
prior published generation intact where one exists and records the error in the
corresponding state document.

Mongo's Compose health check is an exec-form, one-row native `mongostat` probe
every 30 seconds, with 1.5-second connection/server/socket deadlines and a
5-second container timeout. It avoids both timed-out shell accumulation and the
short CPU/PID burst from starting Node-based `mongosh` for every probe. Because
health-check configuration is attached at container creation, apply this
particular Compose change only during a planned Mongo restart:

```bash
docker compose up -d --force-recreate mongo
docker compose ps mongo
```

Recreating Mongo is not required for backend or frontend source reloads.

#### Location import recovery

Location imports use a two-phase `analyze → confirm` contract. Analysis may
stage an original in the `location_files` GridFS bucket, but it does not change
the canonical timeline. Confirmation writes an import in `committing` state,
uses idempotent point upserts, publishes newly-owned points, and only then sets
the import to `parsed`. The location worker also listens for this status update.

Migration `0050_location_import_review.ts` backfills `importIds[]` on legacy
points and marks points whose scalar `importId` has no `location_imports`
document as `visible: false, recoveryState: "orphaned"`. Before repairing a
failed legacy upload:

1. identify the exact import id, GridFS id, point count/hash and time range;
2. create and validate local dumps of `location_points`, `location_imports`,
   `location_files.files` and `location_files.chunks`;
3. re-analyze the original file and confirm it so identical hidden points are
   safely re-owned instead of inserted twice;
4. verify the receipt/counts, processing status and canonical point range;
5. delete only the verified superseded GridFS object. Never infer an orphan or
   delete points by filename/date range alone.

Migration `0054_location_full_geometry_metadata.ts` adds normalized full-route
chunks and durable metadata review. Existing `location_tracks.path` values are
copied to `renderPath` and receive `geometryCompleteness` of `render-only`; the
migration never claims that a previously decimated path is complete. Reparse
committed originals with the authenticated location resource action
`backfill-import` (one id) or `backfill-imports` (bounded batch). Backfill
verifies the GridFS source hash, fills full geometry/raw metadata and updates
the content passport without creating timeline observations.

Run backfill only while MongoDB and the backend readiness endpoint are healthy.
After each batch, verify the import's `contentProfileVersion`, exact geometry
point/chunk totals, saved-place/track provenance and pending metadata conflicts.
A missing source or hash mismatch is a failed backfill to investigate, never a
reason to reconstruct geometry from `renderPath` or delete canonical points.

Only Nginx entry-point ports are configurable from `.env`. Application service
ports remain internal to the Compose network; MongoDB keeps its explicit local
development port.

| Published endpoint | Variable          | Default |
| ------------------ | ----------------- | ------- |
| **Nginx HTTPS**    | `NGINX_PORT`      | `4433`  |
| **Nginx HTTP**     | `NGINX_HTTP_PORT` | `3210`  |
| **MongoDB**        | fixed mapping     | `27017` |

Example:

```bash
NGINX_PORT=5000 NGINX_HTTP_PORT=5001 docker compose up -d nginx
```

For more details on networking and SSL setup, see
**[NETWORKING.md](docs/NETWORKING.md)**.

## Parallel Development (Two Branches at Once)

You can work on two branches simultaneously — one instance keeps running
untouched while the other rebuilds. There are two setups, from cheapest to most
isolated.

### Option 1: Second frontend against the shared backend

Best when the second branch only changes frontend code. The Docker stack keeps
serving branch A; branch B runs as a plain local Vite dev server from a git
worktree:

```bash
git worktree add ../mycelia-b my-feature-branch
cd ../mycelia-b/frontend
deno task dev
```

This works without any extra configuration:

- The local Vite server listens on `5180`, which the backend already allows in
  its CORS whitelist (`backend/server.ts`).
- Point the app at the running backend on the `/setup` page — use
  `http://localhost:3210` (the non-HTTPS nginx port).

Limitation: the backend is shared, so backend changes in branch B cannot be
tested this way.

### Option 2: Second full stack (frontend + backend)

Best when the second branch changes backend code. Bind mounts in
`docker-compose.yml` are relative (`./frontend`, `./backend`), so a git worktree
plus a separate Compose project name gives a fully independent stack:

```bash
git worktree add ../mycelia-b my-feature-branch
cd ../mycelia-b
cp ../mycelia/.env .env
```

Create an (uncommitted) `docker-compose.override.yml` in the worktree to remap
the published ports and image tags — both are fixed in `docker-compose.yml` and
would otherwise collide with the first stack:

```yaml
services:
  nginx:
    ports: !override
      - "4434:4433"
      - "3211:80"
  mongo:
    ports: !override
      - "27018:27017"
  frontend:
    image: bakuutin/mycelia-frontend:dev-b
  backend:
    image: bakuutin/mycelia-backend:dev-b
  python-worker:
    image: bakuutin/mycelia-python:dev-b
```

The `!override` tag is required: without it Compose _merges_ the port lists and
the duplicated host ports conflict. The image overrides prevent a rebuild in
stack B from overwriting the `:dev` tags that stack A's next `--force-recreate`
would pick up.

Start the second stack under its own project name:

```bash
docker compose -p mycelia-b up -d --build
```

Stack B is served at `https://localhost:4434` with its own containers, network,
and volumes (`mycelia-b_mongo_data`, `mycelia-b_redis_data`), i.e. a fresh
database — run first-time setup on it. To work with the same data, clone the
primary database into the second stack's volume with `mongodump`/`mongorestore`
rather than sharing the live one.

### Do not share one database between two backends

Running two backends from different branches against the same MongoDB database
(same `DATABASE_NAME`) is unsafe:

- Both run BullMQ workers and periodic triggers (extraction and summarization
  every 5 minutes) and will race to process the same jobs with different branch
  code.
- With separate Redis instances, each backend's watchdog cancels the other's
  Mongo job records as `queue_record_missing`.
- Branches may be at different migration levels, so one backend writes schema
  the other does not know about.

If the stacks must share one `mongod` instance, give each backend its own
`DATABASE_NAME` (e.g. `mycelia_b`). Sharing the Redis instance is not supported
at all — the second stack should always run its own.

### Resource note

Each backend, mongo, and python-worker container is limited to 2 CPUs / 4 GB, so
two full stacks are a significant memory load. If the second branch only touches
frontend code, prefer Option 1.

## Frontend Development

```bash
cd frontend

# Start development server
deno task dev

# Run tests
deno task test

# Type checking
deno task type-check

# Linting
deno lint

# Build for production
deno task build

# Preview production build
deno task preview
```

for mycelia url during development use: `http://localhost:3210` (non-https nginx
port)

### Tech Stack

- **Deno** runtime with npm compatibility
- **FFmpeg/ffprobe and ExifTool** for local media previews and metadata
- **React 18** + TypeScript
- **Vite** for build tooling
- **Zustand** for state management
- **D3.js** for timeline visualization
- **Tailwind CSS v4** for styling
- **Radix UI** for accessible components

### Import Conventions

Use `@/` alias for all imports (configured in `deno.json`):

```typescript
import { Component } from "@/components/Component";
import { useTimeline } from "@/hooks/useTimeline";
import type { TimelineItem } from "@/types/timeline";
```

### Date and time selection

Use `DateRangePicker` from `frontend/src/components/DateRangePicker.tsx` for
start/end ranges throughout the app. It keeps the date range in one calendar,
provides month and year dropdowns, defaults to minute precision, and can add the
audio-density timeline with `showAudioTimeline`. The picker opens in a
viewport-contained, internally scrolling dialog; users explicitly select the
Start or End boundary before editing its date or time. Use `precision="date"`
for date-only filters and opt into `precision="second"` only when the workflow
requires exact seconds.

Use `DateTimePicker` from `frontend/src/components/ui/datetime-picker.tsx` only
for a single instant. Do not assemble new range controls from separate native
`date`, `time`, or `datetime-local` inputs. Both shared controls use the
configured app timezone unless the caller explicitly supplies a contextual
Timeline timezone or UTC for a maintenance boundary.

## Backend Development

```bash
cd backend

# Start development server
deno task dev

# Create an API token
deno run -A server.ts token-create
```

## Inference Stack (GPU)

For local GPU inference (Whisper, Ollama, Diarization):

```bash
cd gpu

# Create .env with required tokens
echo "HF_TOKEN=your_huggingface_token" >> .env
echo "PROXY_API_KEY=your_api_key" >> .env

# Start all services
docker compose up -d --build
```

See [gpu/README.md](gpu/README.md) for detailed setup and VRAM requirements.

## Speaker Identification

For diarization, voice enrollment, speaker recognition, and historical backfill:

1. Start Mycelia and apply migrations.
2. Run diarization locally on CPU or remotely on an NVIDIA GPU.
3. Configure and verify the route in Settings → Diarization.
4. Complete missing diarization coverage.
5. In Settings → Voice Identity, build Sky from clean, single-speaker profile
   samples. Use ordinary review labels for Timeline/calibration; add a clip to
   the profile only when it represents a missing recording condition.
6. Press **Start recommended review** and label enough independent recordings
   for Learn and Check. Timeline-derived profile samples are excluded from both
   sets; legacy Timeline samples without recording provenance must be re-added.
7. Save a calibration only after Check has at least 20 Sky labels, 20 not-Sky
   labels, and 20 safe automatic Sky matches at the selected precision. If
   held-out not-Sky decisions are not proven, the server keeps them uncertain.
8. Use the embedded **Classify all compatible history** action. The server
   freezes a cutoff, partitions real active segments by run and embedding space,
   and resumes batches with deterministic job ownership. Raw technical IDs
   remain in Advanced/Jobs for diagnostics only.
9. If Voice Identity reports empty active coverage, open **Operations &
   generations**, inspect the non-destructive repair preview, and confirm repair
   separately before classification. Never purge as part of repair.
10. Open Timeline and use the Speaker identity track/filter after the campaign
    reports zero real remaining segments.

See [the architecture guide](docs/SPEAKER_IDENTIFICATION.md) and
[operator runbook](docs/VOICE_IDENTITY_RUNBOOK.md) for exact commands, UI
workflow, safety gates, and troubleshooting.

## Database Migrations

Migrations are in `backend/migrations/`. Apply them with:

```bash
# Check status
docker compose exec backend deno run -A server.ts migrate-status

# Apply all pending
docker compose exec backend deno run -A server.ts migrate-up

# Rollback last migration
docker compose exec backend deno run -A server.ts migrate-down
```

See [docs/MIGRATIONS.md](docs/MIGRATIONS.md) for details.

### AI chat state and resource boundary

The `/chat` UI uses the authenticated `ChatResource` for chat history,
preferences, favorites, pins, and read state. This resource is deliberately not
registered as a model-callable tool. All actions scope records to the current
user and the Mycelia chat platform. The model sees only the curated tool set;
raw Mongo writes and internal maintenance actions are excluded.

Each generation has a durable `chat_runs` record. `activeRunId` protects the
chat summary from stale completions, and an approval continuation keeps the same
run and assistant message. The `chat:self` WebSocket subscription is mapped to a
hashed user-scoped backend channel and carries only summary/run events.

Migration `0057_chat_experience.ts` adds the chat list, pin, and run indexes and
backfills counts, title sources, tool defaults, and last actual model/provider.
Migration `0058_chat_archive_and_pins.ts` adds the active/archive list index and
backfills the materialized pinned-message count used by compact chat cards.
Apply pending migrations before testing the updated UI.

Targeted checks for this feature:

```bash
cd backend
deno test -A app/lib/chat/tools.server.test.ts \
  app/lib/chat/resource.server.test.ts app/lib/chat/runs.server.test.ts \
  app/routes/api.chat.test.ts \
  app/services/updates.websocket.server.test.ts

cd ../frontend
deno run -A npm:vitest run src/lib/chat.test.ts \
  src/hooks/useStableChatSessionId.test.tsx src/lib/chatMessages.test.ts \
  src/stores/notificationStore.test.ts \
  src/components/chat/ChatPinnedNavigation.test.tsx
```

## Troubleshooting

### Empty or loading-model chat responses

Memory Chat records `X-Mycelia-Request-Id` with every assistant response. When
the provider returns `Loading model`, the backend waits with bounded backoff for
the same provider/model instead of silently routing an exact model ID elsewhere.
It also retries a nominally successful SSE response that closes without text or
tool calls, including a reasoning-only response truncated before visible text,
and a network reset while that pre-output prefix is being read. If the retry
budget is exhausted, the request is reported as a provider failure rather than a
completed empty assistant message. Historical empty assistant messages remain
visible as diagnostics but are omitted from later model context, so they cannot
make every retry fail UI-message validation.

Use the request ID shown in the chat error to correlate the attempt:

```bash
docker compose logs --tail=500 backend \
  | rg '\[apiChatHandler\]|<request-id>'
```

The provider still has to be reachable. A successful `/v1/models` response is
only catalogue evidence; verify readiness with a small authenticated
`/v1/chat/completions` request before retrying a private chat. Do not move an
exact self-hosted model ID to an unrelated cloud provider as a recovery step.

### Queue recovery and process restarts

For unattended local use, prefer the stable runtime (`APP_MODE=prod`). Use
Docker hot reload only while actively editing: Vite and the Deno watcher consume
more memory, and a watcher can keep its container alive after the child
application has failed.

Docker restart policies react to a stopped container, not to an `unhealthy`
status. In `APP_MODE=dev`, Deno's watcher intentionally remains as PID 1 after
an application failure and waits for a file change, so Docker cannot restart it.
If unattended recovery matters, use `APP_MODE=prod`; after a source or
configuration change, recreate only `backend` and restart `nginx`.

Check the whole stack without changing data:

```bash
docker compose ps
docker compose logs --tail=150 mongo redis backend frontend nginx \
  | rg '\[READY\]|\[WATCHDOG\]|\[SELF-HEAL\]|error|unhealthy|OOM|Killed'
curl -fkSs https://localhost:4433/readiness
```

MongoDB and Redis have Docker health checks, and the backend also waits for the
updates Pub/Sub subscriber to reconcile before becoming ready. Once ready, the
backend checks all three every 30 seconds. After three consecutive failed checks
it logs a `[SELF-HEAL]` record and exits; Docker's `restart: unless-stopped`
policy then starts it again. The backend log also emits `[READY]` only after
workers, periodic triggers, and maintenance are running.

Browser update WebSockets share one process-scoped Redis Pub/Sub connection. The
backend does not become ready until that subscriber passes Redis's ready check.
If Redis reconnects, the hub restores its reference-counted channels and the
frontend invalidates canonical API queries because Pub/Sub cannot replay events
that were emitted during the delivery gap.

Extraction and summarization triggers run every five minutes. Source failures
are retained and retried with bounded exponential backoff:

- conversation extraction: 5 minutes, increasing up to 6 hours;
- summarization content-filter failures: 15 minutes, increasing up to 24 hours;
- completed summarization claims left by an interrupted run are released by
  maintenance once the summary exists.
- photo-event analysis runs are reconciled at startup and every minute. A run
  that has not crossed the provider fence releases its reservation; a stale
  post-fence run becomes `provider_outcome_unknown` and is never replayed
  automatically. An early duplicate worker is delayed until the saved lease can
  be reconciled instead of being recorded as completed.
- active Mongo job records whose BullMQ record disappeared after a process
  restart are cancelled with `queue_record_missing`; summarization claims are
  released and interrupted extraction chunks return to the retry backlog.

Open **Jobs → Pipeline health & recovery** at <https://localhost:4433/jobs>.
`Run now` immediately retries eligible and previously errored source records
(bypassing backoff for that manual run). `Retry one failed` recreates one
historical failed job while preserving the original failure. Resume only the
affected worker if its card says it is paused. Do not use **Reset worker**
merely to retry errors: reset drains live queue state and is reserved for an
explicitly confirmed queue reset.

Restart application code without touching MongoDB or Redis:

```bash
docker compose up -d --build --force-recreate frontend backend
docker compose restart nginx
docker compose ps
docker compose logs --tail=100 backend frontend nginx \
  | rg '\[READY\]|\[WATCHDOG\]|\[SELF-HEAL\]|error'
```

Restart a failed dependency only when its health check or logs identify it:

```bash
docker compose restart redis       # queue unavailable
docker compose restart mongo       # database unavailable
docker compose restart backend     # reconnect workers after dependency recovery
docker compose ps
```

Speech-to-text is a separate external dependency. An unavailable STT provider
blocks transcription but does not block conversation extraction or summarization
when their LLM provider is healthy.

### Automatic pending-work contract

Every worker with a change-event or interval trigger must declare a cheap,
indexed `hasPendingWork` preflight. Its eligibility predicate must be the same
predicate used by batch selection and the final `hasMore` check, including due
retries and stale claims. A scheduled trigger with no eligible source work must
not create a durable job. The registry test enforces this contract for newly
added automatic workers.

Return boolean `true` when the preflight only proves that work exists and every
free concurrency slot may claim independently. Return a number only when it is
an actual estimate of how many jobs are worth starting; returning numeric `1`
deliberately caps each trigger to one new job.

For a historical conversation-chain recovery, use a bounded pilot before opening
the automatic cursor to the full history:

1. Record Mongo pending counts and BullMQ active/waiting state. Do not reset
   MongoDB, Redis, or failed-job history.
2. Enqueue `conversation_chunk_creator` with an explicit `start`/`end` range and
   `force:false`. Confirm that transcriptions gain `chunk_id`, chunks reach
   `completed`/`empty`, and objects plus summaries appear without repeated
   source errors.
3. Preserve the current pause state, pause only the affected conversation
   queues, apply the migration and code, and wait for backend `[READY]`, Docker
   health, `/health=200`, and `/readiness=200`.
4. Resume only queues that were running before the change. Let the automatic
   pending predicate drain the remaining history; do not start a duplicate
   diarization campaign or force-reprocess existing summaries.
5. Finish only when pending work is zero or every remainder is classified as an
   active claim, delayed retry, or terminal failure. Repeating automatic jobs
   with `processed:0` while eligible pending work remains is a contract
   violation, not an idle state.

Conversation extraction has a second safety boundary in addition to queue
retries. New conversation chunks are finalized at source-file changes or before
their formatted transcript would exceed `maxPromptChars` (32,000 by default),
and the merged extractor partitions legacy oversized chunks into the same
bounded windows before inference. If a bounded window still ends with
`finish_reason=length`, it is adaptively bisected by utterance and retried, up
to eight splits per chunk. Do not raise the default `maxTokens=8192` solely for
a large source chunk; inspect Job Detail window diagnostics first.

### FFmpeg Import Errors

1. Check `~/Library/mycelia/logs/daemon.log` for details
2. Common causes:
   - Corrupted audio file
   - Unsupported codec
   - Missing, stale, or unreadable staging archive
3. Failed files remain cached until an explicit retry with
   `python/manage_errors.py`; fixing staging access does not clear old errors.

### macOS Voice Memos staging boundary

The supported background configuration avoids Full Disk Access for `uv` and
`tech.mycelia.ingestion`:

1. Set `MYCELIA_APPLE_VOICEMEMOS_MODE=staged`.
2. Point `MYCELIA_APPLE_VOICEMEMOS_ROOT` at the local published
   `~/Library/mycelia/voice-memos-staging/audio-original` directory and
   `MYCELIA_APPLE_VOICEMEMOS_DB` at the stable local SQLite snapshot.
3. From an already trusted interactive Terminal, preview with
   `bash scripts/refresh-voice-memos-staging.sh`, then refresh with
   `bash scripts/refresh-voice-memos-staging.sh --apply`.
4. Let the running LaunchAgent pick up the atomic snapshot on its next cycle.

The refresh wrapper runs the existing `icloud-archive-tool`, performs a full
archive verification, then hash-verifies and materializes the audio at or after
`MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE` alongside the newest completed SQLite
snapshot in `~/Library/mycelia/voice-memos-staging`. The database is replaced
last and atomically. The archive and local audio staging are additive; the
wrapper does not delete source or archived recordings. Incremental refreshes
reuse size-and-hash-verified files.
The capacity check budgets only audio needing copying, the temporary SQLite
snapshot, and a 1 GiB reserve. Full replacement-file sizes are included while
old files still exist. Duplicate catalog paths count once. Existing staged
audio symlinks are copied into regular files, even when target hashes match;
symlinked staging directories are rejected before publication. Keeping audio local
also prevents launchd from crossing the removable-volume privacy boundary. A
fully unattended read of Apple's Group Container still requires a
TCC-authorized background process, so `live` mode remains an explicit legacy
opt-in rather than the normal LaunchAgent configuration. If no interactive
process may read the protected library either, export recordings from Voice
Memos to a user-readable folder and import that folder instead.

When `/health` is `degraded`, inspect `appleVoiceMemosMode` and
`lastCycle.sources` and `lastCycle.ingestion` before changing any data. The
ingestion counts are `attempted`, `succeeded`, `failed`, `remaining`, and
`cached_errors`, scoped to this daemon's eligible sources or explicitly
selected IDs. Current failures and unresolved cached errors degrade health;
pending work alone does not. A readable source with no new
files is `completed` with `discovered: 0`; SQLite corruption and missing-path
failures are explicit. Health describes the latest cycle's discovery and
eligible ingestion work; full media verification and snapshot freshness must
be checked through the interactive staging refresh. For a bounded
recovery, also set `MYCELIA_APPLE_VOICEMEMOS_NOT_BEFORE` to a timezone-aware ISO
timestamp. Stop the LaunchAgent only when running a separate foreground
recovery process; publishing a new staging snapshot is atomic and does not
require a stop.

Apple UUID lookup uses paginated Mongo finds with projection, sort, and limit
under `options`; catalogs and existing duplicate sets can exceed 1,000 records.
A single pending UUID match can have its path updated to a readable regular
file in the configured root. The guarded update preserves source identity,
metadata, and cached failures. Completed sources are not rebound; ambiguous
matches and unreadable replacement paths produce discovery warnings. A catalog
with multiple paths for the same UUID is skipped with a warning before either
insertion or path repair, including when that UUID has only one Mongo record. Cached
errors still require explicit retries through `python/manage_errors.py`.

Before invoking the archive tool for a plan, refresh, or verification, the
staging wrapper loads its `scripts/common.sh` and calls `load_config`. Its
effective `ARCHIVE_TARGET` must resolve to the same directory as
`MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT`; a mismatch fails before that archive command
runs. Configure a custom root in both places. The archive tool uses
`ICLOUD_ARCHIVE_CONFIG`, falling back to its `config.env`, which can override
shell environment values. Equivalent paths through archive symlinks are
accepted; staging-directory symlinks remain rejected.

The host service's `/readiness` endpoint reports application startup with
`service: mycelia-host-ingestion` and includes current ingestion health. The
installer polls it for at most 90 seconds; readiness is independent of slow
authentication, discovery, and audio processing. A ready service with
`starting` or `degraded` ingestion health is installed successfully, with that
state printed for inspection. `/health` remains the ingestion outcome signal.
Invalid batch or interval settings fail startup before readiness is enabled.
The installer uses a total transfer timeout and a subprocess deadline for each
HTTP probe, both bounded by the remaining 90-second budget. Interrupted and
malformed responses are retried; late responses cannot report success.

Source ingestion writes audio chunks as unordered 50-operation `bulkWrite`
batches. The `$setOnInsert` contract on `(original_id, index)` makes a retry
idempotent; do not replace it with plain inserts when changing batch size.

## Project Structure

```
mycelia/
├── frontend/           # React SPA (Deno + Vite)
│   ├── src/
│   │   ├── components/ # Reusable UI components
│   │   ├── pages/      # Route page components
│   │   ├── hooks/      # Custom React hooks
│   │   ├── stores/     # Zustand state stores
│   │   ├── lib/        # Utilities (API client, auth)
│   │   ├── modules/    # Feature modules
│   │   └── types/      # TypeScript definitions
│   ├── Dockerfile.dev  # Dev server with hot reload
│   └── Dockerfile.prod # Production nginx build
├── backend/            # Deno API server
├── python/             # Audio import, STT, conversation extraction
├── diarizator/         # Speaker diarization service (FastAPI)
├── friend/             # Friend-Lite companion app
├── gpu/                # GPU inference stack
├── myceliasdk/         # Shared TypeScript SDK
├── misc/               # Infrastructure configs (nginx, mongo)
└── docs/               # Additional documentation
```

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes with tests
4. Run linting and type checks
5. Submit a PR

Join the [Discord](https://discord.gg/hPfYbpp2am) for discussions.
