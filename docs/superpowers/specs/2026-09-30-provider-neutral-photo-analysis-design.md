# Provider-neutral photo analysis and review

Status: implemented and reviewed in the feature worktree. Focused verification
passes; the full frontend suite retains one unrelated pre-existing audio stats
test failure. Not merged into UAT or deployed by this implementation.

## Intent and agreed scope

The user's Google promotional credit has expired. Mycelia must continue to
import, browse, analyze, and review photos without Google. The user chose a
general connection (server URL, model, optional API key), with reuse of an
already configured provider, and requested that Google services be disabled in
the running installation.

Preserve the existing media library, read-only external original references,
previews, EXIF/GPS, Google results, analysis history, Timeline and Map links. Do
not reimport, regenerate, delete, or send existing photos to another provider
merely because configuration changes.

## Baseline before implementation

- `/media` supports uploads, mounted-folder sync, hash deduplication and local
  metadata/previews independently of recognition being enabled.
- `/media/analysis` supports paginated inventory, server-side filters, selection
  across all matching pages, durable batches, result details and job progress.
- Media profiles currently support Google and a custom self-hosted Open Media
  API. The latter is not a standard chat-completions endpoint and requires both
  structured visual output and an embedding.
- Shared LLM profiles already hold endpoint, credentials, model aliases and
  concurrency. Photo analysis does not currently consume those connections.
- Configuration and much of the photo-analysis copy are exposed through the
  Google Cloud settings page, even for non-Google use.

## Architecture

Extend the existing media pipeline with an OpenAI-compatible vision adapter; do
not create another library or batch engine. Keep the custom Open Media API
adapter for compatibility. Keep Google as an explicit optional adapter.

Separate three responsibilities:

1. A shared connection owns server URL and credentials.
2. A photo-analysis profile references that connection and selects an explicit
   model, language, capabilities and processing limits.
3. An immutable run records the photo hash, selected model, connection identity,
   prompt/schema versions, result and usage, never the API key.

### Connections and model selection

The new Photo Analysis settings page offers **Use existing provider** and **Add
connection**. Reused connections retain their stable shared provider ID;
credentials are resolved on the backend and are not copied into media jobs,
receipts, result records, logs or public status responses.

New connections use the existing shared provider store. Creating a photo-only
connection must not populate text-model aliases or silently alter the default
text-inference route. A missing API key is valid; omit the Authorization header
in that case. API keys may be entered or replaced but must not be returned by
the new photo settings endpoints.

Validate HTTP(S) URLs and reject embedded credentials, query strings and
fragments. Connections are admin-configured, not arbitrary per-job URLs. Reject
redirects for authenticated provider requests. Allow deliberate local or tailnet
model endpoints; reject cloud metadata endpoints and non-HTTP URLs.

An explicit **Test image support** action sends a small synthetic test image,
not a library photo. Model listing alone is not proof of vision capability. Show
the destination and that the test makes a model request before running it. The
selected model stays fixed for a confirmed batch. No automatic cross-provider
fallback, and no substitution of a text-only model.

Changing the endpoint, model or disabling a referenced connection invalidates
unstarted work and requires a new review. Credential rotation for the same
connection and endpoint must not rewrite old receipts or expose credentials.

### Google disabled

Add a persisted application-level `externalServices.google.enabled` switch,
defaulting to false when absent. An operator must explicitly enable Google
before selecting a Google media or text route. Check the switch before dispatch
and immediately before a Google request, including connector tests, query
embeddings and jobs carrying older provider snapshots.

The policy covers direct Google API endpoints and Gemini models routed through
third-party providers. Do not automatically enable Google because ADC or an API
key is present. Disabling Google must not prevent reading stored results, local
metadata operations, or locally reconciling an already completed run.

Keep `/settings/google-cloud` for optional Google setup, billing safeguards and
historical usage. The normal photo workflow must not probe Google credentials,
require promotional-credit verification, or display GCP setup banners when a
non-Google model is selected. This switch does not change the Google account,
disable cloud APIs globally, or remove host credentials used by other tools.

The immediate operational shutdown uses the controls that already exist: disable
Google media profiles, disable Media Knowledge while no alternative profile is
configured, and pause photo-recognition queues. Disable any enabled Google text
routes and exclude Google environment fallbacks. Preserve imports, other local
workers and all stored data. Before enabling a non-Google profile, review old
Google authorizations; never retarget them automatically.

## Analysis behavior and stored results

The general vision adapter accepts sanitized WebP previews and produces the
existing structured visual description plus visible-text extraction when
requested. Preserve the current Russian output default; expose an explicit
output-language setting. Model-extracted text is labeled as such, not presented
as equivalent to a dedicated OCR engine or as verbatim certainty.

Photo descriptions must succeed without embeddings. New general profiles have
semantic indexing off by default; existing custom/Google profiles can retain
their supported embedding behavior. Track semantic-index availability separately
from successful description/OCR. Do not compare embeddings from different models
or dimensions. Local filtering and text search remain usable when the embedding
provider is disabled, including for historical Google results.

Empty optional attribute strings are normalized away; required descriptions
remain validated. Invalid output becomes a per-photo error with a useful reason,
not a failure of the whole batch. Never invent EXIF time, GPS or people
identities.

Continue using exact-SHA server-side batch preview/confirm, owner isolation,
asset reservations, idempotent confirmation, bounded queue windows and durable
progress. Default to one photo at a time with a configurable limit of 1–8; also
respect the referenced provider's shared capacity so text and photo jobs cannot
independently overbook it.

Use bounded 429 retries with exponential backoff, jitter and Retry-After within
the job timeout. Retry only the rejected request, not completed billable stages.
Timeouts with uncertain provider outcomes are reported explicitly; no unlimited
automatic reruns. Cancellation stops new requests and allows an already started
request to finish and be accounted for.

Generic external providers must not be labeled free merely because they are not
Google. Show returned token usage and known pricing, otherwise **Cost unknown**.
Confirmation identifies the destination, number of photos, token/output limits
and whether a monetary ceiling can actually be enforced. Do not reuse the GCP
ledger or promotional allowance as a fabricated price estimate for another
model.

### Reanalysis and history

Default batch selection skips photos that already have successful requested
results. **Reanalyze** is a separate explicit action available for one photo or
an exact selection. It creates a new analysis version; it does not reset the
asset or delete previous results. Repeated confirmation of the same receipt must
create only one run.

Keep the previously successful result visible until the new result is fully
validated and published. On failure or cancellation, retain that prior result
and show the latest attempt separately. Owner-scoped run retrieval supports
reviewing every existing Google/custom run and the newly selected provider's
result. Concurrent storage changes and duplicate analysis reservations remain
blocked by existing backend contracts.

## User interface

Keep one compact media navigation with two destinations:

- **Library** (`/media`): attach files/folders, import progress, grid/table
  view, source availability and links into analysis. No duplicate provider
  forms.
- **Analysis & results** (`/media/analysis`): To analyze, Results and Needs
  attention views using the existing inventory rather than a second dataset.

The analysis toolbar has status, date/import-batch/provider filters, sort,
grid/table toggle, page selection and **Select all matching**. Selection always
uses server-side criteria, not just the loaded page. Refresh results after
import or batch progress without discarding filters, scroll or selection.

Show provider choice and **Review analysis** only when preparing new work.
Results mode instead prioritizes thumbnail, description, extracted-text
availability, capture time and provider/model. Running progress occupies one
compact row per campaign. Help belongs in accessible hover/focus tooltips.

The closeable detail panel contains a large preview and **Description**,
**Text**, **Metadata**, **History** sections. History identifies provider/model,
processing time, outcome and usage for each run, including Google runs while
Google is off. Show Map/Timeline links only for images with the corresponding
local metadata. The existing `assetId` deep links must continue to open and
close correctly. Do not remove PDF detail/analysis access, but do not route PDFs
through the new photo-only vision adapter.

Add `/settings/photo-analysis` to configure general profiles and inspect model
compatibility. Keep Google-specific controls only on `/settings/google-cloud`.
Add a small **Google disabled** state there rather than blocking the library.

## Components and change boundaries

- Extend `myceliasdk/media.ts`, `media-library.ts` and `config.ts` with the new
  profile, capability, run-version and Google-policy contracts.
- Add focused backend modules for connection resolution, Google access policy
  and the general vision adapter; keep HTTP/error normalization separate from
  media persistence and batch coordination.
- Adapt media preparation, processing and publication in
  `backend/app/lib/media/resource.server.ts` and batch reservation/selection in
  `backend/app/lib/media-library/`; retain owner and hash validation.
- Apply the shared Google policy to media adapters and LLM route selection and
  dispatch. Do not reorganize unrelated transcription, ingestion or diarization.
- Extract reusable photo detail/result components instead of extending the two
  large page files with duplicated controls. Add the dedicated settings page and
  preserve existing routes.
- Preserve legacy records with additive schema changes. Do not wipe MongoDB or
  rebuild existing embeddings as part of migration.

## Verification and rollout

Focused regressions must cover:

1. Existing-provider reuse, a keyless local endpoint, disabled/deleted
   connection, endpoint changes and absence of secrets in receipts/status/run
   records.
2. Google disabled across old queued snapshots, connector tests, semantic-query
   embeddings and direct/third-party Google text routes; stored results remain
   readable with ADC absent.
3. Successful description without embeddings, visible-text extraction with no
   text, empty optional attributes, malformed output, unsupported image input,
   429 exhaustion and uncertain timeout accounting.
4. All-matching selection beyond 100/500 rows, immutable receipts, duplicate
   confirm, cancellation, restart recovery and owner isolation.
5. Reanalysis preserving prior success on failure, versioned publication,
   changed/missing originals and single/batch reservation races.
6. GCP-free settings and library rendering, history review, provider filters,
   deep-link close behavior, image-only Map/Timeline links and unchanged PDF
   navigation.

Update README, DEVELOPMENT and media documentation only for implemented
behavior. Run targeted backend/SDK and frontend tests, lint/type checks and the
frontend build. Document unrelated pre-existing failures separately.

Verify the actual deployment checkout, bind mounts and runtime mode. Reload only
affected application services if needed; do not restart MongoDB or Redis.
Require readiness 200 and one explicitly authorized non-Google synthetic test
before proposing a real-photo smoke run. Starting a large replacement-provider
batch is a separate confirmation, not an automatic consequence of deployment.

## Non-goals

No new video pipeline, face identification, model installation, external model
downloads, global text-router redesign, Google account/billing changes, or
automatic cross-provider reruns of the archive. No new review-approval workflow
or manual editing of model descriptions in this first version.
