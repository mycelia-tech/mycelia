# Photo and PDF Knowledge

Mycelia imports and recognizes photos or PDFs in separate explicit stages:

1. Drop files into the managed upload area or choose a directory in the mounted
   folder browser for a read-only folder sync. Mycelia validates magic bytes and
   limits, calculates SHA-256, extracts local metadata with ExifTool/ffprobe,
   and creates temporary WebP previews with metadata stripped. It does not call
   a recognition provider.
2. **Confirm local import** creates canonical media assets. Recognition is a
   separate opt-in action on `/media/analysis`, so an import can remain `staged`
   until Google Cloud or a self-hosted provider is ready.

The Photo Analysis screen separates **where** a job runs from **what** it does.
Choose Google Cloud or a self-hosted Open Media API profile. The bulk action has
one fixed package: `visual-understanding` plus `ocr`. Visual understanding
produces a Russian caption and description, scene, objects, activities, people
count without identity inference, keywords, possible event, confidence,
warnings, and an embedding for semantic search. A Google profile runs Vertex
visual understanding/embedding and strict-EU Cloud Vision OCR. A self-hosted
profile receives the same two requested features at its configured endpoint and
does not call Google. Global Vision labels and object localization are not part
of this batch action. Local metadata extraction is always local and precedes
the provider choice.

Local ingestion is independent of recognition. When `mediaKnowledge.enabled` is
false, managed uploads and mounted-source imports still extract metadata,
deduplicate, and create previews. No recognition profile is selected and no
provider receives content.

Uploaded files use `managed_original`: analysis writes the immutable original
to staging inside the separate `media_originals` GridFS bucket. An untouched
preview expires after one hour; confirmation marks the original canonical. If
confirmation is interrupted after it is claimed, its unfinished staged files
are protected by a bounded seven-day recovery lease so the same confirmation
can resume idempotently. The source-folder path uses
`external_reference`: the mount is read-only and Mycelia stores only its
source-root ID, relative path and hash.
Both modes keep technical metadata, EXIF date/GPS when present, and compact WebP
thumbnails/previews separately. SHA-256 deduplication applies across both import
paths.

An untouched abandoned upload preview expires after one hour; its staged
original and previews are removed by the next import cleanup. A confirmation
already in progress keeps only its unfinished staged files for at most seven
days before normal cleanup can remove them. A managed original can be
converted to `preview_only`, but only through `Review original deletion` and a
second explicit confirmation. Mycelia first verifies a stored preview and a
completed analysis, then permanently deletes only the GridFS original while
retaining previews, metadata, provider results and search projections. Mounted
source files are never deleted; forgetting their reference only changes the
asset to `preview_only`. A preview-only asset cannot be reprocessed unless an
original is imported again.

The Media detail view groups retention controls under one **Storage &
deletion…** panel. This is not a whole-asset delete: Mycelia does not yet offer
an action that removes the canonical Media Library record and every layer in
one step. **Forget mounted original reference** removes only Mycelia's pointer;
the read-only mounted file is never modified or deleted, while existing
previews, metadata, and results remain. **Delete Mycelia previews** removes only
the compact WebP files; the original or its reference, metadata, and results
remain, but the item can no longer be viewed in the gallery or sent for photo
analysis. Resetting visual/OCR results remains an advanced, separate action.

Storage mutations are mutually exclusive with recognition. An active
recognition reservation, or a queued/processing asset, locks the panel and is
also rejected by the backend until the item finishes or the batch stops
starting new provider calls. Reviewing deletion of a Mycelia-managed original
claims the asset for that preview-and-confirm operation; **Cancel original
deletion review** releases the claim immediately so the asset does not remain
locked until the preview expires.

If a mounted original is moved or removed, recognition stops before any
provider or budget call and the asset becomes `source_missing`; if its bytes
change, it becomes `source_changed`. Uploading the same SHA-256 through the
managed-upload path restores a missing original without discarding the old
source provenance, previews, metadata, or completed analysis.

## Isolated media development stack

This checkout includes a Compose overlay that cannot reuse the main stack's
containers, volumes, image tags, ports, or database:

```bash
cp .env.media.example .env.media.local
```

Edit `.env.media.local`:

- replace the three development-only secrets;
- set `MEDIA_SOURCE_HOST_PATH` to an **absolute** host folder containing JPG,
  PNG, WebP, or PDF files;
- leave `GCP_ADC_HOST_PATH` unused for the local-only phase.

Start only the services needed for the media UI:

```bash
docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  up -d --build mongo redis backend frontend nginx
```

Open `http://127.0.0.1:3211`. HTTPS is also published on port `4443`, but uses
the development self-signed certificate. Complete first-time setup, then open
Media. A recognition profile is not required for local-only import, and the
upload controls remain available when recognition is disabled. Either upload
files or select the mounted root `.`, review the local storage-mode preview, and
confirm. Configure and start recognition later on `/media/analysis`.

The mounted-folder browser exposes only directories below
`MEDIA_SOURCE_HOST_PATH`, not arbitrary macOS paths. The root (`.`) is selected
by default and scans the local folder recursively, excluding separately configured
disks and aliases; choose visible folders and
breadcrumbs to narrow the scan, for example to `2026/photos`. Symlinks are not
listed or followed. To change the real host folder, edit
`MEDIA_SOURCE_HOST_PATH` in `.env.media.local`, recreate only `backend`, and
restart `nginx`:

For the main `sky-uat` stack, store `MEDIA_SOURCE_HOST_PATH` and
`GCP_ADC_HOST_PATH` only in its uncommitted `.env` and append
`docker-compose.media-uat.yml` to every Compose command that recreates backend.
This preserves the UAT database and ports while mounting the source folder and
ADC JSON read-only. Keep any existing UAT overlays in the command as well.

For the large gallery workflow, create a subfolder such as
`~/Pictures/Mycelia-Import/900-photos/` under the mounted host root and select
`900-photos` in the folder browser. Use **Sync mounted folder locally** instead
of the older bounded preview button. The durable campaign walks subdirectories
without following symlinks, inventories unsupported files, hashes and inspects
25 entries per durable step, and survives backend restarts. One visible
`mediaFolderImport` job carries the whole normal campaign and reports the phase,
checked/total count, percentage, speed, ETA and last progress time; a recovery
job is created only after an interruption. Jobs groups those technical attempts
by `campaignId`, so the campaign remains one visible row. Its local report
separates imported, duplicate, unsupported, changed, and failed entries before
or during confirmation. Originals remain read-only external references; only
EXIF/GPS, stripped WebP previews, hashes, and derived data enter Mycelia.

### Streaming photo import

After **Scan** starts, select **Import + Google** on that folder campaign. This
also works for a campaign already scanning or imported: no repeated inventory
is required. Review the total dollar ceiling, photos per wave, project and
location, then confirm once. The authorization includes newly discovered photos
in this folder, not just the currently visible page. Discovery and local import
continue while ready originals enter separate exact-SHA recognition batches.
Original files are neither copied into Mongo nor modified.

The default form proposes 100 photos per wave and a $50 total ceiling; neither
is activated before confirmation. Google runs visual understanding/embedding
and EU OCR, never global labels/objects. Ready, busy, ignored and already
assigned photos are skipped. Same-byte duplicates share an asset and cannot
create a second paid wave item in this stream. Per-photo failures remain visible
in Analysis and require a new explicit batch to retry.

**Allocated / ceiling** counts confirmed wave ceilings, not actual billing or
remaining promotional credit. Allocation survives restarts and is deliberately
not refunded from lower actual usage. Daily/monthly/per-photo settings still
apply; new waves wait for the next UTC budget window when necessary.
**Pause new batches** stops future waves; already confirmed waves finish and
local import continues. **Review & resume** confirms a new total ceiling that
includes prior allocation. Missing disks or a changed provider pause cloud
dispatch; reconnect/review before resuming. Timeline/Map show imported photos
as soon as local date/GPS is available, before Google finishes.

```bash
docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  up -d --no-deps --force-recreate backend

docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  restart nginx
```

If this stack already uses Google ADC, keep the Google overlay in both commands
so recreation does not drop the credential mount and environment:

```bash
docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  -f docker-compose.media-gcp.yml \
  up -d --no-deps --force-recreate backend

docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  -f docker-compose.media-gcp.yml \
  restart nginx
```

Alternatively, drag files directly onto **Upload from this computer** or press
**Choose files**. This path does not require the mounted folder. It
accepts up to 50 JPEG, PNG, WebP, or PDF files per preview, with a 48 MB total
request limit (20 MB per image, 32 MB and 15 pages per PDF). It keeps staged
originals for one hour while the preview is untouched; confirmation marks those
originals canonical in the same `media_originals` GridFS bucket. An interrupted
confirmation can resume during its bounded seven-day recovery lease. It never
modifies the file selected on the computer.

Disabled providers remain visible in the provider selector for diagnosis but
cannot be selected. Enable the profile and the Media Knowledge master switch in
Settings → Google Cloud, then Save. For a Google profile, Labels and Objects
have an additional `Allow global labels and objects` switch because those two
Vision features do not use the strict-EU OCR endpoint. Visual understanding and
OCR do not depend on that global opt-in, and the Photo Analysis bulk action
never requests Labels or Objects. The master switch and current profile toggle
are checked again at enqueue and immediately before a worker reads or sends
content; turning either off stops already queued recognition before a provider
call.

If setup reports that API keys already exist, create browser credentials in the
running isolated backend (this command does not require a checkout `.env`):

```bash
docker exec -it -w /app mycelia-media-89da-backend-1 \
  deno run -A server.ts token-create --name Chrome-$(date +%F)
```

Automated local smoke test (it creates a test owner only inside the isolated
database and never calls Google). Before running it, put at least one supported
JPEG, PNG, WebP, or PDF in `MEDIA_SOURCE_HOST_PATH`; the script uses that file
for the mounted-reference receipt and generates its own separate managed-upload
fixture:

```bash
bash scripts/smoke-media-local.sh
```

Expected result contains two receipts. `mounted` includes `status: staged`,
`storageMode: external_reference`, the relative path, and a valid WebP preview.
`managed` includes `storageMode: managed_original`, a byte-for-byte verified
original hash, and a duplicate receipt from uploading the same generated image
again without creating a second canonical original. Original deletion remains
blocked until that asset has a ready analysis.

To verify the provider-neutral worker pipeline before granting Google IAM, add
the development-only self-hosted contract mock:

```bash
docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  -f docker-compose.media-selfhost-test.yml \
  up -d media-provider
```

Add the self-hosted preset in Settings → Google Cloud, set its URL to
`http://media-provider:8090`, enable it, select it under **Active provider**, and
Save. On `/media/analysis`, select a staged or failed test image (or use
**all matching**) and choose **Review analysis batch**. The resulting fixed
visual-understanding + OCR request goes only to the self-hosted endpoint. This
proves the actual BullMQ worker,
normalized projections, Russian structured visual description, vector search,
provenance, and usage without a cloud request; it is not a substitute for the
final Google connector and worker smoke.

## Google Cloud phase

Google recognition is server-side OAuth/ADC; there is no API-key field in the
browser or MongoDB. Prepare:

1. A dedicated GCP project with billing attached to the promotional-credit
   billing account.
2. Enabled `aiplatform.googleapis.com` and `vision.googleapis.com` for the fixed
   Google photo package. Enable `documentai.googleapis.com` only for optional
   PDF OCR.
3. For optional PDF OCR, an EU Document AI Enterprise OCR processor pinned to
   `pretrained-ocr-v2.1-2024-08-07`.
4. A least-privilege runtime identity with
   `roles/serviceusage.serviceUsageConsumer` and `roles/aiplatform.user`; add
   `roles/documentai.apiUser` only for Document AI.
5. An Application Default Credentials or Workload Identity Federation file
   outside the repository.

Set `GCP_ADC_HOST_PATH` in `.env.media.local` to the absolute credential-file
path, then add the Google overlay:

```bash
docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  -f docker-compose.media-gcp.yml \
  up -d --build --force-recreate backend

docker compose \
  --env-file .env.media.local \
  -f docker-compose.yml \
  -f docker-compose.media-dev.yml \
  -f docker-compose.media-gcp.yml \
  restart nginx
```

In Settings → Google Cloud add the `Google Cloud EU Photo Knowledge` preset,
fill the project ID, save, confirm the remaining promotional-credit balance
shown for that project in Cloud Console, and run the synthetic connector test.
It calls `gemini-3.5-flash-lite` through the Vertex AI EU endpoint and creates a
`gemini-embedding-001` search vector, then calls Cloud Vision EU OCR with the
same generated 1×1 PNG. The base test reserves $0.0075 in the conservative app
ledger. The Document AI processor ID and its additional $0.0015 synthetic PDF
test are optional. No user media is sent by the connector test.

Google Cloud does not expose a per-request "promo credit only" switch, and Cloud
Billing reporting is delayed. In **Free trial account** mode the app therefore
fails closed unless the credit balance and exact project were manually verified
in the preceding 24 hours, and it stops 72 hours before the recorded expiry. In
**Paid account** mode one project-bound confirmation permanently acknowledges
that real charges are acceptable; the 24-hour balance and promotion-expiry
checks are skipped. Both modes retain configurable monthly, daily, per-asset,
and per-event gross list-price stops. The 900-photo rollout uses `$300/month`,
`$50/day`, and `$0.01/photo`; every confirmed batch also stores its exact
SHA-bound maximum cost. A multi-file batch can therefore exceed one cent in
total while each asset stays below its own stop.
These guards reduce risk but cannot mathematically guarantee that a paid billing
account will never charge a card because Google has no per-request "promo
credits only" flag.

The confirmation receipt is bound to the selected project and Billing account
mode. Changing either closes the guard until it is confirmed again. Free-trial
confirmation is also bound to promotion expiry. Selecting **Not confirmed —
block Google calls** and saving is a persistent application kill-switch for
Google spending.

The settings page shows the app-side gross list-price ledger for the current
month and day, split into committed and still-reserved amounts. This counter is
shared across all Mycelia principals using the same GCP project and is the
source of the hard application stop. It deliberately does not subtract Google
free-tier units or promotional credits. Cloud Billing remains the authoritative
source for the actual invoice and remaining promotional balance.

## Provider boundary

Google visual understanding uses the Vertex AI EU multi-region endpoint and the
GA `gemini-3.5-flash-lite` model. The derived text is embedded with
`gemini-embedding-001` at the supported EU regional endpoint `europe-west4`; the
app never silently falls back to `global`. Google documents that choosing a
standard regional endpoint alone is not a data-residency guarantee, so Mycelia
records this as regional routing rather than claiming Netherlands-only
processing. Only the sanitized 1280 px WebP preview is sent. Structured output
and its text embedding are rebuildable projections; the external original
reference, SHA-256, technical metadata, preview, exact model/region/time
provenance, token usage, and estimated list-price cost remain separate. Google
image OCR uses strict-EU
`DOCUMENT_TEXT_DETECTION`; PDFs use the pinned EU Document AI processor.
Optional labels and object localization are a separate explicit `global` opt-in
and are never silently enabled.

Semantic query text is sent only when the user runs search, the enabled active
provider has owned semantic media, and its connector is available. Google
queries reserve a conservative $0.0004 gross-list-price ledger amount; without
an active provider, or when ADC fails, local OCR and label search still runs.

A self-hosted provider implements:

- `GET /health`;
- `GET /v1/capabilities`;
- `POST /v1/media/analyze` with multipart fields `file`, `request_id`, and
  `features`;
- `POST /v1/media/events/analyze` with an ephemeral manifest and sanitized
  WebP previews for group understanding;
- `POST /v1/media/embed` with `{text, purpose:"query"}`.

The multipart `features` field is the requested task array. The current Photo
Analysis workspace always sends `visual-understanding` and `ocr`; the provider
contract may advertise `labels` and `objects`, but the bulk action does not
request them. Visual providers return `visualUnderstanding`, `searchText`, and
`embedding`; OCR adds normalized `pages` and annotations. Switching providers
creates a new versioned analysis run; it does not rewrite the canonical asset or
previews. Existing vectors are never mixed across different embedding
model/dimension spaces. Existing `ready` assets are intentionally excluded from
normal batch eligibility, and there is currently no bulk re-index command for
them. A provider switch therefore applies to eligible `staged`, `failed`,
`budget_blocked`, or `recognition_disabled` assets; stored OCR and label
projections remain available meanwhile.

## Photo event aggregation

The **Photo events** panel turns imported images into reviewable memory events.
It deliberately separates local clustering, provider analysis, and canonical
publication:

1. **Build local event proposals** scans the newest unassigned image assets for
   the current principal that have a normalized capture time and stored
   preview. It groups nearby photos by time and EXIF GPS. No cloud or
   self-hosted provider is called. Photos that do not match another photo are
   returned explicitly as **Single photos** instead of disappearing from the
   proposal. Open a singleton for ordinary per-photo recognition, or select
   several photos in the Media inventory and build an explicit local proposal
   from that selection. At most 100 proposed groups can be confirmed in one
   batch; build the next batch afterwards.
2. Review the proposed membership, period, and the exact representative
   thumbnails that would be transmitted. Deselect unwanted groups and choose
   whether to queue group understanding. Omitting that choice creates only a
   local event. Queueing analysis requires explicit confirmation and creates a
   stable owner-scoped event plus an immutable, hash-bound consent receipt.
3. The selected provider receives at most the configured number of sanitized
   WebP previews (eight by default), labelled only with ephemeral references
   and relative time offsets. It never receives filenames, source paths,
   hashes, raw EXIF, exact GPS, transcript text, saved Object data, or original
   files.
4. Reanalysis is also a two-step **Review analysis** → **Confirm and queue**
   flow that shows the exact current thumbnail set, provider, privacy contract,
   and maximum reservation before any call. When a versioned result is ready,
   **Publish to Mycelia** is a second explicit action. It creates one
   idempotent `isEvent` Object with the exact locally computed period and
   optional local GPS centroid, so the event also appears on the existing
   Objects timeline. Later syncs preserve user-edited Object content.

The event model may produce a Russian title, description, visual place type,
anonymous visible-participant ranges, key actions, keywords, and ranked
representative frames. It is forbidden from resolving identities, matching
faces between frames, creating Person links, or inferring age, gender,
ethnicity, health, religion, politics, sexuality, or other sensitive traits.
Provider prose is still treated as untrusted output: it is displayed for human
review, neutralized before Markdown publication, and never creates a Person
link automatically.
The exact event period, membership, GPS, audio/transcription links, and Object
links remain local deterministic evidence and cannot be changed by the model.

## Media inventory and batches

### External photo libraries

On macOS, use `docker-compose.media-disks.yml` after your primary media overlay.
It mounts the stable parent `/Volumes` at `/media-source/disks` read-only;
individual external disks are not required for Mycelia to start. Set
`MEDIA_DISKS_HOST_PATH` only if your disks have a different stable parent.
Docker Desktop must allow access to that parent. This exposes its directories
to the authenticated media browser; symlinks are never followed.
Before the first start, create an empty `disks` directory inside your local
`MEDIA_SOURCE_HOST_PATH` folder. This permanent mountpoint is required because
the parent folder is read-only inside Docker. It does not stand in for any disk;
do not put local files there, as the volumes mount hides that directory's contents.

In **Media → Choose folder**, choose **Local import folder**, a subfolder, or
**Connected disks → disk → folder**. Refresh after connecting a disk. Scanning
the local root excludes other sources, and scanning the entire Connected disks
container is disabled: select the disk or folder you intend to import. Nothing
is imported merely by connecting a disk. **Scan** builds an inventory; review it
and use **Confirm local import**. You can also use **Choose files** to upload
selected photos or PDFs from any location your browser can access without a
server mount. Managed uploads copy originals; folder sync keeps references.

To retain references from an old direct mount, configure a stable logical alias
in the uncommitted `.env`, for example:

```dotenv
MEDIA_SOURCE_ALIASES='{"icloud-backup":"disks/MyDisk/Source/iCloud_backup"}'
```

Alias names reserve top-level entries in the picker. Targets must be relative
paths below the media root; absolute paths, traversal, and symlinks are rejected.
Stored paths remain `icloud-backup/...`. An offline alias stays visible as
unavailable, and reconnecting the disk makes it usable again. Keep disk and alias
names stable. Remove the old individual-disk overlay from `COMPOSE_FILE`, retain
the primary media and credential overlays, and append the disks overlay.
Recreate only backend and restart nginx once after this configuration change;
check `/readiness`. Later connections only require refreshing the folder list.
If Docker Desktop has not exposed a newly connected volume, check its file
sharing settings and recreate backend, then restart nginx.

For a fixed library that is always available, the direct-mount option remains:
keep the disk mounted at a stable host path. Set `MEDIA_SOURCE_EXTRA_HOST_PATH`
to its photo folder in the uncommitted `.env`, and optionally set
`MEDIA_SOURCE_EXTRA_NAME` (default `external-photos`). Append
`docker-compose.media-external.yml` after the existing UAT Compose overlays.
It adds a read-only subfolder under `/media-source`; keep the same subfolder
name on subsequent recreates because existing asset references use it. Existing
installations using `icloud-backup` should retain that name. The host directory
must exist; Compose will not create an empty substitute for a disconnected disk.

After connecting the disk, recreate only backend with the full overlay list and
restart nginx, then verify readiness as described in `DEVELOPMENT.md`. In
**Media → Choose folder**, select the mounted library and **Scan**. Discovery
saves at most 1,000 entries per request and a durable directory/name cursor, with
no 20,000-file or directory-depth cutoff. It shows discovered files and the
current directory; a total and ETA become meaningful after discovery. Metadata
and previews continue in 25-file steps. Restarting resumes discovery and file
work; replayed pages do not reset prior work. Keep the source tree stable during
a scan; a later sync discovers files added behind an already committed cursor.

Review the local report, then **Confirm local import**. JPEG/PNG/WebP originals
remain on the external disk. Mycelia stores SHA-256, EXIF/GPS, 256px and 1280px
WebP derivatives, and processing results. HEIC/RAW, video, PDF, and sidecars are
counted as unsupported by the photo-folder pipeline. Exact-byte duplicates
within the same owner resolve to the existing asset; re-encoded copies are not
exact duplicates. Unchanged paths reuse previous size/mtime-matched hashes.
Disconnecting the disk preserves existing metadata and previews; reconnect it
before importing or processing originals. Unavailable folders are marked in the
picker, with an actionable error if scanning cannot read one.
The backend image must include `exiftool` (already declared in its Dockerfile).
If an older running image lacks it, new metadata inspection fails explicitly
instead of silently dropping capture time and GPS. Rebuild the backend image
before retrying such files; source-code hot reload does not install OS packages.

Local discovery/import does not call Google. Recognition still uses a separate
priced preview and confirmation, at most 20,000 photos per receipt; a larger
selection now asks for narrower date/filename filters instead of silently
truncating. The library itself is not capped to that batch size.

The `/media` page is the local library and import workspace. It uses cursor
pagination, a responsive thumbnail gallery, background refresh, and a focused
detail viewer, so an archive of 900 or more photos is not truncated to the
first page. Useful capture time, timezone, camera, dimensions, GPS, provider,
OCR, annotations, description, and usage remain available in the detail view;
raw EXIF/ffprobe JSON stays under the advanced disclosure. The detail header
remains visible while content scrolls and has an explicit close action.
From the same detail view, **Show on Map** and **Show on Timeline** open a
focused photo sheet. If the stored GPS or capture time is missing, the target
page shows the photo as Unplaced instead of inventing metadata. For an image
without a visual description, **Get description** is offered only while a
retained original is available and the asset is in a recognition-eligible
state; it opens Photo Analysis with exactly that photo selected. Ready,
in-flight, or preview-only images instead open their existing Photo Analysis
state without promising a new description. Neither path contacts a provider
until an eligible priced preview is reviewed and explicitly confirmed.
Provider analysis is always stated: an empty card means no Google or
self-hosted run/result is stored, while an active result names the provider and
shows its service/location/model plus stored visual/OCR projection counts.
Only the run matching asset.currentRunId is described as the active result;
older attempts remain provenance history. Gallery checkboxes select photos only
for explicit local event grouping and never start cloud recognition.

`/media/analysis` is the recognition workspace. Status, placement, filename,
and capture-date filters run on the server. The shared date-range picker applies
an inclusive capture-date range in the configured application timezone. The
prominent **Unprocessed by capture-date range** workflow changes the status to
**Unprocessed** and selects every match across all server pages; it is not
capped by the 100 cards currently loaded. **Select loaded** includes only
recognition-eligible rows that still have a managed original or mounted-file
reference. While a changed filter scope is reloading, the previous result set
cannot be selected or reviewed as though it matched the new URL.

A batch can contain that all-matching scope or an explicit eligible selection.
Preparing a preview sends nothing to a provider: the server rechecks the
retained-original reference and required sanitized WebP pointer, excludes active
reservations, and returns the exact eligible count, cutoff, asset IDs/SHA-256
values, tasks, provider snapshot, and gross ceiling.
Only **Confirm exact batch** authorizes provider work. Existing batches keep
updating in the background without blocking library browsing, local import,
filter changes, or preparation of another batch from still-eligible photos.

The batch action first creates a local preview receipt with a cutoff, exact
asset IDs/SHA-256 values, the pinned provider profile, tasks, per-photo estimate,
and total gross ceiling. Confirmation returns immediately. A durable coordinator
keeps a bounded queue window and creates one ordinary `mediaRecognition` job per
photo internally. Jobs exposes one `mediaRecognitionBatch` row for the whole
confirmed batch, with aggregate progress and pending/queued/processing/failure
counters; child jobs and recovery attempts stay available only as diagnostics.
It skips `ready`, `queued`, and `processing`; missing references become
`source_missing` under Needs attention. Stop prevents new jobs while
already-started provider calls finish and remain accounted. Failed Google items
must be reviewed as a new exact batch with a new cost ceiling; the original
confirmation never authorizes extra paid attempts. With a Google profile, the fixed tasks are
Vertex visual understanding/embedding and strict-EU Vision OCR. With a
self-hosted profile, the same visual-understanding + OCR feature request goes
only to that endpoint. Global Vision labels/objects are never part of this bulk
action.

Every individual photo with a reliable local capture time appears on the
adaptive **Photos** Timeline track, regardless of recognition status. Narrow
ranges show thumbnail markers; overlapping markers expand into a captioned list,
while wide ranges use indexed density buckets whose selected capture window can
be opened as a paginated list. Every row links to the canonical Media Library
detail view. Every photo with EXIF or manually assigned GPS appears on the
default **Photos** map layer, which also works without GPX imports. A distant
map cluster first zooms in; at close zoom it expands into the same thumbnail,
status, capture-time, concise-description, and library-link view. Map viewport
and Timeline list requests remain bounded, and a truncated map explicitly asks
the user to zoom in rather than implying the list is complete. **Zoom to fit**
combines the owner-scoped Object and photo capture ranges, so photo-only dates
are not left outside the initial Timeline view. Missing values are never
inferred:
**Missing time**, **Missing location**, and Unplaced links open the inventory,
where time/timezone/coordinates can be assigned locally with audit history.
Photo groups remain separate: an event appears as a canonical Object only after
its own review and explicit **Publish to Mycelia** action.

Audio and transcription links are derived locally from time overlap and are
stored as IDs rather than copied text. The linker accepts a transcription only
when its source file is owned by the same principal. Because legacy Objects are
a single-person corpus without owner fields, automatic Object suggestions are
enabled only for the default `admin` personal corpus and always exclude Person
Objects. Tokens created with a different owner can still build owner-scoped
photo events, but cannot publish into that shared Object corpus.
Nothing from those links is sent to Google.

Settings → Google Cloud exposes defaults for the time gap, GPS distance, audio
link window, maximum event size, provider preview count, and the conservative
per-event gross stop. The initial Google reservation is capped at $0.02 per
event and shares the existing daily/monthly project ledger. A provider call is
never triggered automatically by file import or by local clustering. Changing
the active provider affects only new explicit event jobs; there is no automatic
self-hosted-to-Google fallback. Once a provider request has crossed its durable
start fence, cancelling the queue job may not stop a request already accepted
by the remote provider; the run remains auditable instead of being silently
replayed. Startup maintenance and a one-minute reconciler settle expired event
runs and their budget records across all owners; duplicate workers wait for the
saved lease instead of creating another provider call.

Deleting a photo's previews or analysis marks every affected derived event
stale and blocks publication/reanalysis until it is rebuilt. A previously
published Event Object is retained as user-owned canonical content rather than
being deleted implicitly; removing that Object remains a separate user action.
The first release creates single events only. Hierarchical multi-day journeys
and automatic merging/splitting of confirmed events remain future work.
