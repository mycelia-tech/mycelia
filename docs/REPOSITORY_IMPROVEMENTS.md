# Repository improvements: implementation and rollout evidence

This change implements the repository hardening package in an isolated worktree.
It does not switch the running checkout, migrate a production database or claim
that an operator backup has been restored.

| Area | Implemented result |
| --- | --- |
| Database boundary | No default host port; explicit loopback maintenance overlay; project-scoped Mongo client network and paired RAG configuration |
| Authorization | Mandatory AI/MCP ResourceManager; read-only chat aggregation; namespace/filter/cursor enforcement; authorized minimal WebSocket notifications |
| Credentials | Atomic bootstrap; revocable credential-bound JWTs; cookie browser sessions/CSRF; URL-free WebSocket credentials; provider keys confined to their configured origin |
| Audio and recovery | Private temporary upload streaming and aggregate quota; bounded audio chunks; truthful failure states; source-specific ingestion jobs; bounded, cancellation-aware safe retries |
| Backups | Encrypted streaming archive, independent transfer/integrity/restore evidence and exclusively disposable restore targets |
| Daily workflows | URL/cache-backed search context, source time links, recoverable loading/error states, keyboard/mobile navigation and lazy routes |
| Maintainability | Search, jobs recovery, voice-preview, upload, Mongo policy and session modules; shared request contracts preserved |
| Verification | Root verification groups shared with CI, synthetic integration databases, browser/infra contracts, dependency/secret/link checks and guarded application deployment |
| Documentation | Current documentation entrypoints; historical roadmap/workflow preserved outside active discovery |

## Validation

- Backend: 1,180 tests (plus nine test steps), lint and typechecking; complete
  suite took 9m39s and the runner exited successfully after owned-container cleanup.
- Frontend: 596 unit tests, broad frozen typecheck, lint and production build.
- Browser: six Playwright/axe workflows, including 360/768/1440 px and keyboard
  navigation; APIs and WebSockets are intercepted with fictional data.
- Python: 217 tests; RAG: 72; SDK: 22; lint passed for each applicable group.
- CPU GPU gate: 14 scheduler and 37 standalone live/storage contracts.
- Additional exact-source live-overlay checks: 72 passed, two existing
  image-only skips; no sustained recording or model inference performed.
- Repository: 24 configuration, source-guard, backup and environment contracts.
- Infrastructure: actual isolated nginx routing/logging/HTTPS checks and
  static Compose network/port contracts. Source/health guards have regression
  tests and detect the currently different runtime checkout.
- Backup: seven failure/success unit contracts and one actual synthetic
  dump/encrypt/restore integration with MongoDB 8.0.28 and age 1.3.2. SSH transport
  was substituted with isolated container transport; SSH authentication was not
  tested. Stopped targets and restore receipts were retained for inspection.
- Dependency audit: 1,936 package/version pairs queried; 153 have advisories.
  This includes optional, transitive and retained tooling entries and is not an
  exploitability count. See [the report](reports/dependency-audit-2026-10-27.json).

All root verification groups completed successfully. The dependency advisory
audit intentionally remains failing while findings exist. Local verification is
evidence about this source tree, not remote CI or production readiness. The final read-only doctor check found application mounts
on the original checkout, outside this implementation worktree. Backend was
ready/healthy in production mode; frontend was healthy with mode unconfirmed.
Mongo still published port 27017 on IPv4/IPv6 wildcard interfaces. That existing
runtime binding requires a separate reviewed rollout; it was not changed here.

## Rollout gates and compatibility

1. Review and apply the new base network defaults to the actual runtime checkout.
   The working Mongo host binding was not changed by this implementation.
2. Update browser clients together with the backend. API keys still work, but
   old unbound JWTs require a fresh exchange and browsers require a new login.
   WebSocket clients using `?token=` must move to the authenticated header or
   browser subprotocol transport documented in [AUTH.md](AUTH.md).
3. Before Mongo authorization migration, restore a real encrypted operator
   archive, prepare separate app/backup/monitor users and test rollback. Follow
   [MONGO_AUTH.md](MONGO_AUTH.md) and [BACKUP_MONGO.md](BACKUP_MONGO.md).
4. Triage remaining advisories separately; this package does not silently
   suppress them or perform a broad library upgrade. Image publication depends
   on the required regression workflow for the same SHA; the full advisory audit
   remains a separate failing check while findings exist.
5. Rebuild and deliberately roll out live-audio overlays before hardware checks.
   A new hour-long recording is outside this change. No originals, historical
   job records or production data were deleted or backfilled.

Large Jobs/voice/media modules still warrant further domain extraction. The
initial boundaries above keep existing routes/actions stable and establish
regression coverage for subsequent small changes.

Implementation contracts and commands: [HARDENING.md](HARDENING.md),
[DEVELOPMENT.md](../DEVELOPMENT.md).
