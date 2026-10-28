# Startup and optional-media rollout — 2026-10-28

## Deployed changes

The main checkout advanced to `005033d9` (explicit Python configuration and
bounded worker discovery), then `46ca98cf` (optional media source). Backend was
built from clean Git archives; the final image revision label is `46ca98cf`.
Python retained its dependency image and was recreated to load the updated
verified `/app` bind. Its OpenMP budget remains one thread and its CPU quota two.

The first Compose recreation encountered an absent configured local media
folder. The old backend remained running; Python was recovered and the original
queue states restored while the source was clarified. The user confirmed the
folder was empty and requested startup without it. Its empty local mountpoint
was restored to complete the first package; the follow-up removes that dependency.

The UAT overlay now creates the optional local import folder empty when absent,
defaulting to `./.local/media-import` without an explicit host path. Disks use a
separate read-only `/media-disks` mount. Saved logical `disks/...` and alias paths
still resolve through the same protected API. The **Media → Choose folder** panel
shows an empty/unavailable source message and allows another mounted folder.
This is an in-panel notice; no global toast or arbitrary host-folder access was
added. Changing to a host folder outside the existing mounts still requires
updating the local Compose configuration and recreating backend.

Required code/credential mounts now fail the deployment preflight before Compose
can partially recreate applications. Missing local media is the explicit exception;
the Google credential file is never fabricated. A real isolated, network-free
container proved startup with an initially absent local directory and read-only
mount enforcement. It was removed after the check; no test databases were started.

## Runtime and preservation evidence

- Backend: production mode, correct main-checkout mounts, Docker healthy, 26
  successful manifest inspections and `[READY]`. Process startup was
  `19:26:14.630 UTC`, readiness `19:26:24.161 UTC` (23:26 local, Asia/Tbilisi).
- Python: application `/capabilities` ready with seven job types; six synthetic
  configuration tests also passed inside its running container. There is no
  Docker healthcheck for this service, so this is application readiness.
- Authenticated pipeline health succeeded in 0.032 seconds. The real media API
  returned the empty-folder notice, a selectable Connected disks entry and seven
  visible disk entries. This does not test disk contents or run recognition.
- Doctor passed source/mode/readiness checks. File hashes matched the committed
  backend discovery/media code and Python utility code.
- Mongo, Redis, frontend, RAG and Qdrant retained their container identities and
  start times. Nginx was restarted after backend changes. Existing frontend
  Timeline work and its currently deployed image were preserved.
- All 32,736,287 historical Redis stream entries remained; first/boundary payload
  hashes and the retention cutoff matched preflight. No trim, flush or eviction.
- Twenty-four queues resumed; the original two recognition queues stayed paused.
  Forty-six local WIP file fingerprints were preserved, except DEVELOPMENT.md,
  whose unrelated edits were retained with a reviewed three-way merge.
- One old folder campaign has a paused Google stream pinned to the former
  physical disk path. It remains paused with its history intact. Review/re-enable
  it before resuming that stream; no authorization or spending cap was migrated.

Private rollback receipts are under `.local/rollouts/startup-005033d9/` and
`.local/rollouts/media-46ca98cf/`. They include private local configuration and
must not be published. Rollback branches/images were retained. No remote push.

## Verification scope

The preceding startup package passed 220 Python, 19 focused backend and 26
repository checks. This turn's media follow-up passed 13 backend media tests,
six existing/new folder-panel tests, 27 repository contracts and the Compose
contract, with changed-file lint/typechecking and documentation checks. Tests
cover independent/absent sources, aliases, traversal and symlink rejection,
the empty-state notice and choosing an alternative without starting a scan.
Full backend database integration and a fresh browser/hardware acceptance run
were not performed in this rollout.

## Load after queues resumed

Three short samples showed Python at 0.17–0.31% CPU, backend 1.27–7.29%, Mongo
2.80–24.46% and Redis 0.44–0.96%. RAG had one 98.42% sample followed by 0.33% and
0.80%; 100% represents one logical CPU. The final authenticated API check took
0.021 seconds. Disk free space was about 70 GiB.

The host still had elevated load averages (38.59 / 40.93 / 47.08) and about
12.8 GiB used swap; the memory-pressure query reported 34% available. A process
snapshot showed the Docker VM, WindowServer, storage-indexing/UI services,
Codex and iCloud work consuming CPU concurrently. These observations do not
establish a single cause or prove sustained desktop performance. No unrelated
process was stopped. Python was not the sustained CPU consumer in these samples.

## Plan status and next work

| Wave | Implemented / deployed | Remaining work |
| --- | --- | --- |
| 1. Security | Mongo loopback boundary; AI/MCP/Mongo/WebSocket authorization; provider-key origin restrictions; bootstrap, revocation, browser sessions/CSRF; targeted Multer/Vite/Express fixes | Remaining advisory paths, then Mongo users/authentication after recovery proof |
| 2. Data and processing | Bounded upload storage/chunks, explicit failure states, safe retries and source-specific recovery; encrypted backup/restore tooling and synthetic restore contracts | A real operator-backup restoration and reconciliation; unfinished local backup work remains separate |
| 3. Checks and deployment | Shared local/CI check commands, isolated/capped database tests, source guard/doctor, bounded discovery and mount preflight | Remote CI/image-publication acceptance for future PRs; complete advisory audit remains failing |
| 4. Daily workflows | Search URL/cache/back context, audio/time links, loading/error states, navigation/lazy routes; optional media source | Further real-data Audio/Timeline/search acceptance and short live-audio failure scenarios |
| 5. Maintainability | Domain extractions in Jobs/media/voice, shared recovery contracts, current documentation entrypoints, explicit Python configuration | Continue splitting large Jobs/voice/media modules and replacing direct UI Mongo mutations |

Recommended order: (1) targeted `ws`/`zod`/`minimatch` advisory remediation with
compatibility/security checks; (2) one verified restore of an actual encrypted
operator backup in an isolated bounded target; (3) separate Mongo app/backup
users, authentication cutover and rollback rehearsal; (4) further daily-workflow
acceptance and module extraction. Keep historical Redis cleanup deferred until
archival/reconciliation is proved and explicitly authorized. Do not start an
automatic hour-long recording or mass backfill as part of these steps.
