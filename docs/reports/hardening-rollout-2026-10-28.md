# Main-stack hardening rollout — 2026-10-28

Observed locally on 2026-10-28 (UTC observations ended at 2026-10-27 22:26).
This is a deployment report, not a claim that every improvement-plan item or
remaining dependency advisory has been resolved.

## Deployed source and preservation

- Application images were built sequentially from a clean archive of
  `5d1da6be7616d8b0e68f8e803bf6039c792f5470`, including the merge of the existing
  UAT fixes. Backend, frontend and Python image revision labels match that SHA.
- The existing main checkout was fast-forwarded; its application/SDK mounts were
  preserved. Backend runs in production mode. No worktree switch occurred.
- Nginx fixes `46154cb4` and `516e3927` were applied and loaded: IPv4/IPv6 listeners
  serve the application, the stock localhost virtual host is removed, HTTP
  redirects to HTTPS, and query strings stay out of access logs.
- Source/configuration then advanced to `866b7f46`. Its Python CPU quota is live
  at **2 CPUs**, applied without stopping the worker, and persisted as
  `PYTHON_WORKER_CPU_LIMIT=2.0`. The default remains 4 CPUs for other deployments.
- The Mongo signal-forwarding fix and 60-second stop grace are checked in, but
  the already running Mongo wrapper has **not** loaded that follow-up. It will
  take effect at the next planned recreation. No extra database restart was
  performed to load this follow-up.
- Existing local work was preserved with a rollback branch, image tags, a
  targeted stash and private copies. Four overlapping documents were merged.
  Two unfinished backup CLI files were restored exactly because another local
  backup script imports their older interface. Those working-tree CLI files
  are explicitly excluded from the application deployment claim.

Private rollback/verification receipts are in
`.local/rollouts/hardening-5d1da6be/` in the runtime checkout. They include original
image identities, worker pause states, source/WIP fingerprints and private local
configuration backups. They are not repository artifacts and must not be
published. The rollback branch is `sky/rollback-hardening-5d1da6be`; rollback
images use the `mycelia/rollback-*` names. No remote push was performed.

## Database and queue checks

Mongo was recreated once for the network change, with the **same image and exact
existing data bind**. Only `127.0.0.1:27017` is published. RAG moved from the host
port to `mongo:27017` on the shared private network. Its image and Qdrant
container/data were retained. Authentication migration was not performed.

During the old Mongo container's stop, the shell wrapper did not forward TERM.
TERM was sent directly to `mongod` to complete the requested shutdown. The new
wrapper contract is tested with synthetic child processes during initialization
and normal operation; these tests do not create a Mongo instance.

Redis was **not restarted or replaced**. After stopping the old backend, the
stream preservation boundary was captured as `1793139177060-0` and persisted in
`ACCESS_LOG_RETAIN_THROUGH_ID`. All **32,736,287 existing payloads**, including
pending events, are excluded from deletion by the new worker. The first stream
ID and ten sampled old pending payloads remained present. Stream length returned
to exactly the preserved count after newly written events were persisted.
Pending events fell from 4,323 to zero; this is acknowledgement/persistence
progress, not historical payload cleanup. No bulk trim, eviction or data reset
was performed. Historical archival completeness remains a separate task.

Twenty-four queues resumed; `mediaRecognition` and `mediaRecognitionBatch`
remained paused as before. Existing jobs/history were preserved. At the final
inspection there was one Mongo container and no test containers.

## Live verification

- `doctor --project mycelia --expected-root <runtime-checkout> --probe-readiness`
  passed with no source mismatch or publicly published Mongo port.
- Backend emitted `[READY]`; Docker reported healthy; `/health` and `/readiness`
  returned 200. Frontend was healthy and its served HTML hash matched the built
  image artifact. The static production frontend has no application `[READY]`
  log; its verification is health plus the served artifact.
- Python `/capabilities` reported ready with seven job types. It has no Docker
  healthcheck, so running and application readiness are reported separately.
- An authenticated pipeline read succeeded. A temporary browser session proved
  Secure/HttpOnly/SameSite=Strict cookie attributes, origin rejection,
  authenticated reads and immediate access-token rejection after logout. The
  temporary session was removed. Existing device API keys still work; browsers
  may need a fresh login after the session migration.
- Real RAG-to-Mongo ping and collection-list read passed. RAG `/ready` returned
  200 and status reported `ready`, `paused=false`, `degraded=false`.
- IPv4, IPv6 and Host: localhost redirect/routing regressions failed before the
  nginx fixes and passed afterward in an isolated nginx fixture and main stack.

This turn also passed 219 Python tests, ten access-log unit tests, six bounded
real-Redis retention scenarios, four infrastructure contracts and 26 repository
contracts, with applicable lint/type checks. The full earlier baseline is in
[the implementation history](../REPOSITORY_IMPROVEMENTS.md); it was not all rerun
against this deployment. Production data was never used as integration fixtures.

## Load observations

Docker CPU percentages are per-core: 200% means approximately two cores. These
are short samples, not a sustained recording or throughput acceptance run.

| Observation | Before resuming queues | Active work peak | Final sample after CPU limit |
| --- | --- | --- | --- |
| Python CPU | 0.19% | about 394% | 202% |
| Backend CPU | 0.69% | about 310% after resume | 49% |
| Mongo CPU | 3% | 144% | 6% |
| Mongo resident memory | 2.61 GiB | warmed after restart | 2.71 GiB |
| Redis resident memory | 3.45 GiB | 3.47 GiB | 3.46 GiB |
| Authenticated API read | 0.12 s | 0.23 s | 0.07 s |

Mongo lock queues stayed at zero; sampled long commands were topology/change
stream waits rather than proof of blocked application writes. Cache is bounded
at 2.5 GiB. Redis retained the old approximately 3.5 GB access-log payload set by
request; its memory should not be expected to disappear with this rollout.

Active work included existing VAD, diarization, source-index, transcription and
summarization queues. Thread CPU sampling confirmed multiple Python computation
threads consuming its four-core quota during VAD. Limiting the worker to two
cores reduced its share without interrupting the job. Further model-thread
budget tuning is separate; the quota alone does not reduce runnable thread count.

The host still had elevated load (1-minute average about 21 on 10 logical CPUs),
about 9.3 GiB used swap and 9.7 GiB free disk. The memory-pressure query reported
45% available. Other observed CPU users included Time Machine/File Provider,
WindowServer and Docker VM. These observations do not prove that all desktop
slowness is fixed. No unrelated service, backup, image or volume was removed.

## Remaining follow-ups

- The existing `locationMapProjection` automatic trigger returns a payload
  without `type`; startup reports a validation error. The same defect exists in
  the pre-rollout revision `f3554702`. Fix its payload contract in a small next
  backend change; do not erase failed history to hide it.
- Load the Mongo graceful-stop follow-up at the next planned Mongo recreation.
- Tune Python inference thread budgets with representative VAD throughput before
  increasing the CPU quota again; retain the current memory/disk safeguards.
- Mongo authorization migration, historical Redis archival/cleanup and verified
  restoration of the operator's real backup remain separate work. Remaining
  dependency findings are tracked in the [dated triage](dependency-triage-2026-10-28.md).
