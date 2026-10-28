# Reitti → Mycelia

Configure `.env` with `REITTI_URL` (HTTPS origin, optional base path),
`REITTI_API_TOKEN` (a separately named token created in Reitti settings),
`REITTI_DEVICE_ID` and `REITTI_START_DATE` (`YYYY-MM-DD`, UTC). Keep `.env` private
and excluded from version control. Reitti 5.8.1 API tokens are not read-only;
this integration only calls GET `/api/v1/gpx/export` with the token in a header.
It never sends Mycelia data back or deletes records in Reitti.

Recreate backend with your active Compose overlays, restart nginx, and follow
DEVELOPMENT.md readiness checks. In Jobs, enable `reitti_sync` and choose Run now.
The worker is disabled when configuration is incomplete. No desktop automation
or open chat is required; Mycelia, its database/queue, the network and Reitti must
be running. A sleeping/offline Mac cannot fetch data until it resumes.

The first batch imports the last three UTC days followed by older days, seven
exports per job. Successful batches automatically continue historical backfill.
A cheap scheduler check runs each minute; only due work runs. Every hour the worker rereads recent days, including every day missed during an
outage. Once history completes, one additional historical day is checked per
hour in rotation to eventually discover old imports. For immediate reconciliation
of a large old import, reset only the relevant sync checkpoint with operator
review. Old remote deletions are not mirrored. The device's source track is
exported; Reitti's consolidated timeline edits and place labels are not synced.

Daily hashes live in `location_sync_days`; cursors, last success/failure and
counts live in `location_sync_state`. Checkpoints advance only after all nonempty
files have successful Mycelia commit receipts. Retrying after interruption uses
the normal import deduplication. Original GPX files remain in `location_files`;
coordinates that conflict with existing history follow the normal review path.
The source URL, device and start date identify a checkpoint namespace; changing
one starts a separate backfill, while token rotation preserves progress.

Imported data appears on the existing Location map. `location_processing`
derives stays/moves and `locationMapProjection` updates map projections. Keep
those workers enabled. Inspect Jobs → Pipeline health & recovery on failures;
use Run now to retry. Do not reset Mongo or Redis to recover a failed download.

HTTPS verification stays enabled and redirects are rejected. Export requests
have a two-minute timeout and 50 MiB daily limit; login pages and incomplete GPX
fail without advancing the cursor. Uploads have a ten-minute timeout. No token
or coordinates are placed in job inputs or progress logs.

Validation:

```bash
deno test --config backend/deno.json --allow-env --allow-read backend/app/lib/location/reitti-sync.test.ts
deno check --config backend/deno.json backend/workers/reittiSync.ts
deno lint --config backend/deno.json backend/app/lib/location/reitti-sync.ts backend/app/lib/location/reitti-sync.test.ts backend/workers/reittiSync.ts
```

API contract checked against the official Reitti v5.8.1 `GpxApiController` and
`GpxExportService`: start/end are inclusive UTC days and an explicit device is
supported. A single-day request uses the same start and end date.
