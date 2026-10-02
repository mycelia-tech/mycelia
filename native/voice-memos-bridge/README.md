# Voice Memos Bridge: direct import

A native English UI replacing the manual Voice Memos `uv run daemon.py`
workflow. **It does not build a staging archive.** Bridge reads the selected
Apple folder and transfers one recording to a local helper, which reuses
`chunking.ingest_source`: 10-second Opus chunks, bounded Mongo upserts, original
recording dates and stable source IDs. VAD/STT remain separate Pipeline workers.
Other daemon importers (Google Drive, SSH, arbitrary folders) are not managed here.

## Build and use

Requires macOS 13+, Xcode/Command Line Tools, `uv`, `ffmpeg`, `ffprobe`, the
project Python environment and a configured, running Mycelia backend.

Run from the repository root. Before rebuilding, **Quit Voice Memos Bridge**
from its menu (closing the window only hides it). The build script refuses to
replace the running app and keeps the previous signed bundle for recovery.

```bash
bash scripts/test-voice-memos-bridge.sh
bash scripts/build-voice-memos-bridge.sh
open 'build/voice-memos-bridge/Mycelia Voice Memos Bridge.app'
```

For daily use, run just the `open` command, or open the built `.app` in Finder.
Do not rebuild or start `uv run daemon.py` alongside it. To install in Applications,
quit Bridge, then run from the repository root:

```bash
ditto 'build/voice-memos-bridge/Mycelia Voice Memos Bridge.app' '/Applications/Mycelia Voice Memos Bridge.app'
open '/Applications/Mycelia Voice Memos Bridge.app'
```

The embedded repository path still references this checkout; keep it in place.
Copy again after rebuilding. Moving the repository requires a rebuild. The local helper
starts independently through launchd; Bridge must remain running to scan/send
Apple recordings. Only **Import pending** (or explicitly enabled **Automatic
import**) starts new audio ingestion; opening the app defaults to manual mode
unless you previously enabled automatic import.

1. When unavailable, **Importer setup… → Copy command** shows the one-time setup
   command. Open Terminal yourself, paste and press Return. This installs/starts
   `tech.mycelia.voicememos-importer` on **127.0.0.1:8012**. Setup never imports
   recordings. Once Ready appears, close Terminal and return to Bridge.
   The button becomes **Importer running** and is disabled while ready/importing.
   The sandbox cannot open executable Terminal documents; Bridge does not try to
   do so or request broader permissions.
2. **Choose source folder…** selects only
   `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings`.
   The saved read-only bookmark may already work from an earlier Bridge build.
3. Choose **All recordings** or a **since** date. **Scan library** reads the
   catalog and compares Apple UUIDs with Mycelia. No audio is imported by Scan.
4. **Import pending** refreshes the plan, skips imported/cached-failed items,
   and processes the pending queue one recording at a time.
5. **Retry failed** explicitly retries cached failures in the selected range,
   retaining errors until successful import. Missing local audio and ambiguous
   identities require resolving the row's reported problem first.
6. **Pause** stops new transfers and cancels active processing safely. A resumed
   scan reuses source IDs and already stored chunks. **Run in background** or
   closing the window keeps the menu-bar app running. **Quit** requests
   cancellation and stops new work.
7. **Automatic import** (off by default, separate from the old copier preference)
   checks/imports every 1, 5 or 15 minutes while Bridge is running. macOS sleep is
   allowed; Bridge login auto-start is not configured.
8. **Open pipeline** shows downstream VAD/transcription. Bridge's own table and
   counters show transfer, Opus processing, Mongo confirmation, errors and times.
   During encoding, processed audio time / duration, percent, speed, elapsed time
   and last-progress age come from ffmpeg's bounded `-progress` stream. A 30-second
   gap is shown as waiting for progress, not automatically declared failed.
   Encoding and saving are separate phases; `Opus chunks saved` appears only once
   encoding finishes. The overall batch bar weights encoding/saving approximately
   70/30 per recording, not an ETA for the whole library.

## Understanding a check

**Scan library** ends with **Check complete — no audio imported**. It shows the
check time, selected recording-date range, actual dates in view and dates of
pending recordings. **Since** includes the selected day from local midnight;
**All recordings** has no user-selected lower date limit. Filtering the table
does not change the import range or summary totals.

The **Apple source** and **Mycelia import** columns are independent:

- **On this Mac**: a usable local source; imported, pending and other counts
  describe only those remaining local recordings.
- **Not on this Mac**: the catalog still lists the recording, but its file is
  missing. It may be in iCloud or removed locally; this is not confirmed deletion.
- **Removed / not in catalog**: Mycelia knows the UUID, but the complete current
  Apple catalog does not. It may have been deleted or belong to another library.
  Existing Mycelia audio is preserved; nothing is deleted or re-imported.
- **Source unavailable**: access, unsafe paths, changing files or other source
  problems, not silently counted as deleted.

Use the status filter to inspect pending, missing, removed or duplicate IDs.
Old multiple Mycelia records for one Apple UUID are shown, not silently repaired.
Already imported UUIDs are skipped, including when the local original is gone.
Removal status is computed only after a complete catalog and database inventory
read; narrowing a date range or a failed check never marks records as removed.
The previous summary and check time survive closing the app and are explicitly
labeled **not live** until another successful scan. A small metadata-only history
in Bridge's sandboxed preferences remembers UUIDs seen in successful scans,
including recordings not yet imported. If those later disappear, they remain
visible as **Removed / not in catalog — Not imported**. This is not an audio
backup and cannot reconstruct recordings removed before any scan/discovery.
History is capped at 10,000 identities / 16 MiB. No audio is stored for this
history, and source-presence labels are not written back to Mongo.

## Storage and integrity

- Originals are read-only. No permanent `audio-original` or snapshot directory
  is created; the deleted staging folder is not restored.
- The helper needs room for **one transient M4A + that recording's Opus chunks**,
  plus a 1 GiB free-space reserve. Mongo storage also grows. This is not zero
  disk usage. The transient directory is removed on success, failure and normal
  cancellation before the job reports completion.
- Forced process termination/power loss can leave a transient
  `mycelia-bridge-import-*` directory under the system temp folder. Inspect the
  helper process and exact candidate before manual cleanup; never delete Apple
  originals or Mongo data to recover.
- SHA-256 verifies the upload against the source read; changing files are
  rejected. Apple UUIDs, original source IDs and dates are retained. A changed
  hash after a partial Bridge import requires manual review.
- The CLI, host ingestion service and Bridge helper share a host-wide file lock.
  Updated processes serialize discovery/import; stop any old already-running
  daemon before using Bridge. Cross-host import concurrency is not covered by
  this host lock. Never reset cached errors globally to resume.
- Scans read only `source_files` metadata in 100-record `_id` keyset pages
  (101-row lookahead, 5-second Mongo deadline, 10,000-record client cap).
  Reconciliation and table filters run locally; no `audio_chunks` scan or
  per-record count is needed. Import-time UUID lookups retain their 100-key/
  1001-result bound and non-unique UUID index. Status polling reads
  in-memory state and disk capacity, **not Mongo counts**.
- Transport/auth/disk failures pause unattended importing. A scan or successful
  upload alone is not successful ingestion: success requires acknowledged chunk
  writes and the source's completion update.

## Security and service operations

Bridge uses App Sandbox, a read-only selected-folder bookmark, outgoing network
permission and read-only access to exactly:
`~/Library/Application Support/Mycelia/VoiceMemosBridge/pairing.json`.

There is **no Full Disk Access grant**, no general user-selected read/write
permission, no staging write exception and no Python interpreter with Apple
folder access. The OS network entitlement permits outgoing connections generally;
Bridge code fixes the destination to 127.0.0.1:8012, disables proxies/cookies and
rejects redirects. Setup only displays/copies a shell-quoted command for the user
to run in Terminal; it neither launches a `.command` document nor passes its
Apple bookmark or source access to the Python helper.

The helper binds loopback only, rejects browser Origin/foreign Host headers and
requires a private 0600 pairing token. The Bridge reads only that local token,
never Mycelia credentials. The helper uses the checkout's existing `.env` to
authenticate to Mycelia. It is idle unless the UI requests work. The separate
legacy `tech.mycelia.ingestion` service on 8001 is not reconfigured by setup.

```bash
# The one-time setup shown by the UI, using only the system stdlib:
/usr/bin/python3 scripts/install-voice-memos-importer.py

# Logs / service state:
tail -n 60 ~/Library/Logs/Mycelia/voicememos-importer.error.log
launchctl print "gui/$(id -u)/tech.mycelia.voicememos-importer"

# Stop after pausing active work in Bridge:
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/tech.mycelia.voicememos-importer.plist"
```

Builds are locally ad-hoc-signed, not notarized or Developer-ID signed. A
rebuild can require selecting the source again. The build script refuses to
replace a running app and retains previous bundles under ignored build folders.
Building never starts imports. Opening the UI respects its saved automatic-import
preference, which defaults off.
`BuildIcon.swift` packages the existing `backend/public/icon.svg` logo into an
`AppIcon.icns` with native 16–1024-pixel representations during each build.

Tests use generated fixtures and an in-memory Mongo substitute, including a
real ffmpeg M4A → Opus pass. They do not ingest personal recordings. Live service
readiness, source access, real ingestion and downstream completion must be
verified separately.

Apple: [network entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.network.client),
[file-backed uploads](https://developer.apple.com/documentation/foundation/urlsession/uploadtask(with:fromfile:completionhandler:)).
