# Python configuration and bounded worker discovery — 2026-10-28

Status: prepared and verified in the hardening worktree; this follow-up has not
been deployed. The preceding [VAD rollout](vad-runtime-followup-2026-10-28.md)
remains a separate runtime result.

## Changes

- Removed `utils.py`'s implicit `load_dotenv('../.env', override=True)`. Audio
  imports could previously replace process credentials/endpoints from a file
  selected by the current working directory, even after correct startup loading.
  A fresh-process regression reproduced the defect before the fix. Repository
  defaults, explicit relative `MYCELIA_ENV_FILE`, and process overrides now all
  survive the utility import, with an unrelated adjacent dotenv left unread.
- Legacy standalone VAD, audio playback and device-backfill entrypoints now use
  the same explicit configuration loader. Imports of the standalone VAD
  processor no longer load a second dotenv file. Notebook callers must load
  configuration explicitly. Authentication policy and API retry rules are unchanged.
- Manifest discovery remains sequential, with a 60-second limit per child and
  a combined 1 MiB stdout/stderr budget. On timeout or excessive output the
  owned child is killed and awaited; output decoding preserves split UTF-8.
- Nonzero exits, invalid manifests and duplicate names fail discovery before
  registry publication. They no longer silently omit a worker. Progress records
  identify the file and elapsed time; arbitrary child output is not reflected
  into backend error logs. Fixed registry duplicate detection to use `Map.has`.

## Verification

- `deno task verify python repo`: 220 Python tests and 26 repository contracts;
  Python lint and dependency-declaration/document-link/tracked-secret checks passed.
- Ten container-free backend contracts cover actual child processes, production
  launcher integration, ignored SIGTERM, stdout/stderr floods, exit failures,
  invalid/duplicate manifests and rejection of partial discovery. Deno resource
  and operation sanitizers remained enabled. Changed-file typechecking/lint passed.
  The final combined backend run also passed eight existing trigger contracts
  and the location-projection payload contract: **19 tests total**.
- A separate smoke check used the production discovery launcher against all
  **26 real workers**, with synthetic verification environment and no database
  connections. All manifests loaded in **10.265 seconds** from the local cache.
  This is not a cold-container startup benchmark or proof of production readiness.
- No full backend database integration suite or live application reload was
  performed for this package. Full Python verification reports seven warnings
  from existing pydub/Pydantic dependencies; they are not test failures.

## Runtime observation and next steps

Read-only preflight saw Python at approximately 0.25% CPU, Mongo at 54% and RAG
at 41% in one sample; 100% represents one logical CPU. About 57 GiB was free on
the checkout filesystem. These samples do not establish sustained system load.
No services, queue pause states, Mongo data or historical Redis entries were
changed by this follow-up. No additional database containers were started.

Next deployment should preserve current runtime work, rebuild only affected
applications, and verify mounts/mode, discovery completion, readiness and an
authenticated operation. The timeout intentionally makes an unavailable worker
visible as a startup failure; diagnosing the named module takes precedence over
raising limits. Lightweight build-time manifests remain a separate optimization.

Remaining plan priorities are targeted dependency advisory remediation, a real
operator-backup restore drill before Mongo authorization migration, and further
Jobs/voice/media domain extraction. Historical Redis cleanup stays deferred.
