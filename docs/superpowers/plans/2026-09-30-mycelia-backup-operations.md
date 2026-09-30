# Mycelia Backup Operations and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trustworthy freshness reporting and scheduling, restore both PBM
PITR and portable restic backups into isolated targets, rebuild derived state,
prove recovery from protected versions, and measure the real recovery time.

**Architecture:** Pure evaluators turn backup/PITR/monitor observations into one
redacted status contract. User LaunchAgents invoke the host-side `backupctl`
without embedding secrets. Restore drills clone selected backup objects into a
disposable writable namespace, restore into a distinct `rsDrill` Compose project
with fresh Redis/Qdrant, run the application from a generated allowlist-only
environment with workers disabled, and verify canonical records, external media,
application readiness, and representative search. Images and pinned RAG model
artifacts are prepared before restored data exists; after that point every drill
service is confined to an internal network with no production or Internet route.
The live database, live paths, production bucket, and protected versions remain
read-only throughout a drill.

**Tech Stack:** Deno TypeScript, Python 3 stdlib `plistlib`, macOS LaunchAgents,
Docker Compose, PBM 2.16, restic/rclone, MongoDB tools, MinIO/`mc`, Qdrant/RAG.

**Spec:**
[`docs/superpowers/specs/2026-09-30-mycelia-incremental-backup-design.md`](../specs/2026-09-30-mycelia-incremental-backup-design.md)

**Implementation references:**
[PBM restore commands](https://docs.percona.com/percona-backup-mongodb/2.16.0/reference/pbm-commands.html),
[replica-set remapping](https://docs.percona.com/percona-backup-mongodb/features/restore-remapping.html),
and
[restore into a new environment](https://docs.percona.com/percona-backup-mongodb/2.16.0/features/restore-new-env.html).

**Depends on:**
[`2026-09-30-mycelia-pbm-pitr.md`](2026-09-30-mycelia-pbm-pitr.md) must have a
complete PBM base, contiguous PITR, and current protected copies.

## Global Constraints

- Continue in the isolated `sky/` worktree and preserve all unrelated primary
  checkout changes. Install schedules only from the canonical primary checkout
  after the implementation commits have been deliberately integrated there.
- Use `superpowers:test-driven-development`, `superpowers:systematic-debugging`
  for unexpected runtime results, `post-change-checks` for documentation/config
  changes, and `superpowers:verification-before-completion` before the final
  claim.
- A GUI LaunchAgent cannot run while the Mac is asleep or the user is logged
  out. Status must report monitor gaps and catch-up behavior; it must not claim
  uninterrupted five-minute monitoring from plist configuration alone.
- Plists contain absolute executable/config paths and non-secret labels only.
  Keychain, ignored mode-`0600` env files, and MinIO credential files remain the
  only credential sources.
- Restore paths must resolve outside every live Mongo, Redis, Qdrant, media,
  archive, state, and repository path. Symlinks, aliases, nested paths, and
  prefix collisions are rejected.
- A drill never points a PBM agent at the production bucket. Required objects
  are cloned through read-only credentials into a disposable writable bucket or
  prefix first.
- Production backup/PITR/retention jobs are disabled in the drill project. Redis
  and Qdrant start empty; RAG rebuilds only after Mongo validation.
- Pull/build every image and prefetch every exact, revision-pinned RAG model
  artifact before any protected/source object is retrieved into the drill. Then
  remove the temporary egress network and prove both Internet and live-service
  routes fail before cloning or restoring data.
- Generate drill runtime environments from explicit per-service allowlists. Do
  not merge the operator shell, repository `.env`, or production Compose
  environment. The backend always starts as `deno task prod --no-workers`; the
  Python worker, diarization services, host ingestion/import agents, and
  provider endpoints never start or enter the drill environment.
- Do not clean up a failed drill automatically. Preserve its redacted manifest
  and isolated data for diagnosis. Deletion of disposable drill resources is a
  separately named, explicit operator command.
- Cleanup of retained production backups remains unscheduled until a successful
  PITR drill, protected-copy drill, current copy, and reviewed dry-run all
  exist.
- The authoritative RTO is one monotonic interval. It starts when the operator
  declares recovery start, before the first source/protected object retrieval,
  and ends only after files and Mongo are restored, migrations and application
  acceptance pass, and a newly rebuilt RAG generation plus representative search
  pass. Object cloning, Mongo restore, migration, application, and RAG durations
  are component diagnostics only; no component or sum of independently timed
  components may populate `actualRtoSeconds`.

## Review Focus

- Freshness tests distinguish a new but isolated PITR slice from a contiguous
  restorable chain.
- Scheduling survives spaces in paths, contains no shell expansion, and is
  verified after a credential-context renewal rather than only with `kickstart`.
- `rsDrill=rs0` is used in PBM's documented `to_name=from_name` direction.
- Both sides of the restic-to-`mongorestore` stream are checked; a zero exit
  from only one process is failure.
- A restored application receives only allowlisted drill values, starts with
  `--no-workers`, has no egress route before any restored bytes exist, and its
  behavioral assertions plus RTO cover the single end-to-end monotonic interval
  rather than only listeners, `/health`, or component timers.

---

## Task 1: Define a complete redacted status and notification contract

**Files:**

- Modify: `scripts/backup/status.ts`
- Create: `scripts/backup/notifier.ts`
- Modify: `scripts/backup/status.test.ts`
- Test: `scripts/backup/notifier.test.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`

- [ ] Write failing status tests for these independent dimensions:

  ```ts
  export type RestoreDrillModeStatus = {
    state: "passed" | "stale" | "invalidated" | "failed" | "never";
    completedAtUtc?: string;
    ageSeconds?: number;
    // Present only for a full end-to-end recovery run, never for a component.
    actualRtoSeconds?: number;
    compatibilityFingerprint?: string;
  };

  export type BackupSystemStatus = {
    schema: 1;
    evaluatedAtUtc: string;
    mongo: {
      base: "current" | "stale" | "missing" | "failed";
      latestContiguousReadableUtc?: string;
      lagSeconds?: number;
      gaps: number;
    };
    files: {
      state: "current" | "stale" | "missing" | "failed";
      ageSeconds?: number;
      coverageComplete: boolean;
    };
    voiceMemos: {
      state: "current" | "stale" | "unavailable";
      archiveAgeSeconds?: number;
    };
    protectedCopy: {
      state: "current" | "stale" | "missing" | "failed";
      ageSeconds?: number;
    };
    restoreDrill: {
      state: "passed" | "stale" | "invalidated" | "failed" | "never";
      ageSeconds?: number;
      actualRtoSeconds?: number;
      compatibilityFingerprint?: string;
      modes: {
        pbmPitr: RestoreDrillModeStatus;
        mongoBootstrap: RestoreDrillModeStatus;
        protectedPbmPitr: RestoreDrillModeStatus;
      };
    };
    monitoring: {
      lastObservedUtc?: string;
      gapSeconds?: number;
      continuous: boolean;
    };
    durability:
      | "unknown"
      | "unprotected"
      | "same-server-protected"
      | "three-two-one";
    overall: "current" | "stale" | "failed";
  };
  ```

- [ ] Cover exact boundaries: PITR lag `14m59s` current and `15m01s` stale;
      files at `6h + configured grace` current and one second later stale; a
      recent endpoint after a gap failed; missing base failed; Voice Memos
      archive stale independently; protected copy stale independently;
      failed/never/stale/invalidated drill; monitor gap after sleep/logout;
      missing protection as `unprotected`; unavailable evidence as `unknown`;
      and the explicit same-server 3-2-1 gap. `three-two-one` requires a fresh,
      independently verified second-failure-domain receipt. A drill is `passed`
      only for 35 days and only while its compatibility fingerprint matches; age
      exactly `35d` remains `passed`, age `35d + 1s` is `stale`, any fingerprint
      change is `invalidated`, and an absent per-mode receipt is `never`.

- [ ] Add RTO provenance tests. The receipt exposes
      `recoveryStartedMonotonicNs`, `recoveryCompletedMonotonicNs`, and
      `actualRtoSeconds`; the latter must equal their one-interval delta. Reject
      a receipt that substitutes PBM restore time, clone time, a wall-clock
      difference, or the sum of component durations. A component-only bootstrap
      replay cannot publish `actualRtoSeconds` until the application and RAG
      acceptance sequence completes.

- [ ] Add receipt-authentication tests before freshness evaluation. A missing,
      truncated, or bad HMAC-SHA-256, unknown key ID, non-canonical JSON bytes,
      duplicate key, or any mutation after signing yields drill state `failed`,
      emits no trusted `actualRtoSeconds`, and is ineligible for cleanup. Verify
      the MAC in constant time over the exact stored canonical bytes with the
      `mycelia-restore-receipt-v1` domain before trusting completion time,
      compatibility fingerprint, or outcome.

- [ ] Add protected-copy status fixtures that use the exact Phase 2 completed
      generation contract: stable generation ID, catalog object/version ID and
      SHA-256, Ed25519 signature object/version ID, pinned signer fingerprint,
      completion-marker version written last, exact PBM/PITR/restic object
      version IDs, and retention-until values. Status is `current` only when the
      shared Phase 2 verifier succeeds and completion age is no more than 25
      minutes (15-minute cadence plus 10-minute grace). A valid copy on the same
      backup server maps to `same-server-protected`, never `three-two-one`.

- [ ] Write failing notification tests. Only state transitions into stale/failed
      and recovery back to current notify. The macOS notification receives a
      fixed title plus stage, failure code, age/lag, and local log path; it
      never receives source paths, filenames, record IDs, object URLs, or tool
      stderr.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run scripts/backup/{status,notifier}.test.ts
  ```

- [ ] Implement pure `evaluateStatus(observations, policy)` and stable JSON
      serialization. Read PBM, PITR, restic, Voice Memos verified manifest,
      protected-copy receipt, drill receipt, and last monitor tick
      independently. A missing subsystem may not inherit another subsystem's
      success.

- [ ] Set the restore-drill validity window to 35 days. Compute a compatibility
      fingerprint over Mongo major version, PBM version, migration/schema head,
      backupctl Git revision, storage/bucket identity, CA and encryption-key
      identifiers, and protected-catalog signer fingerprint. Age beyond 35 days
      yields `stale`; any fingerprint change yields `invalidated`, and either
      state blocks cleanup eligibility. Preserve the five-state result for each
      restore mode and derive the summary from the worst required mode rather
      than letting one recent drill mask a stale, failed, invalidated, or never
      run mode. Summary `actualRtoSeconds`, when present, copies the latest
      fresh, compatible, passed full-recovery receipt verbatim; it is never
      computed from component timings or from multiple receipts. Use
      deterministic summary precedence
      `failed > never > invalidated > stale > passed`; `failed`, `never`, or
      `invalidated` make overall status failed, while `stale` makes it stale.

- [ ] Consume `verifyProtectedGeneration` and its canonical completed-generation
      receipt from Phase 2; do not define a second catalog parser or freshness
      rule in status code. Treat an incomplete generation, a marker not written
      last, unreadable referenced version, bad signature, signer mismatch, or
      expired retention as failed evidence, not as a merely old copy.

- [ ] Implement notification through `/usr/bin/osascript` with a fixed script
      and safe argv values. Store the previous notification state atomically to
      avoid storms. Notification failure changes the command exit/report but
      does not rewrite backup freshness.

- [ ] Wire `backupctl status`, `mongo-rpo`, and `file-freshness` to the
      evaluator. Human output leads with `overall`; JSON exposes the entire
      typed object and no hidden raw command output.

- [ ] Extend `Stage` with `status` and central CLI coverage with
      `file-freshness` plus `--notify-on-failure`. Preserve the Phase 1 `status`
      spelling while replacing its partial output with the full contract.

- [ ] Pass tests and type-check:

  ```bash
  deno test --allow-read --allow-write --allow-run scripts/backup/{status,notifier}.test.ts
  deno check scripts/backupctl.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/status.ts scripts/backup/notifier.ts scripts/backup/status.test.ts scripts/backup/notifier.test.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts
  git commit -m "feat(backup): report independent freshness states"
  ```

## Task 2: Generate, install, and test LaunchAgent schedules

**Files:**

- Create: `misc/launchagents/tech.mycelia.backup-files.plist.in`
- Create: `misc/launchagents/tech.mycelia.backup-mongo-full.plist.in`
- Create: `misc/launchagents/tech.mycelia.backup-mongo-rpo.plist.in`
- Create: `misc/launchagents/tech.mycelia.backup-file-freshness.plist.in`
- Create: `misc/launchagents/tech.mycelia.backup-status.plist.in`
- Create: `scripts/install-backup-launchagents.py`
- Test: `scripts/tests/test_install_backup_launchagents.py`
- Modify: `docs/BACKUP.md`

- [ ] Write failing installer tests with temporary HOME/repository directories.
      Assert exact labels, absolute `ProgramArguments`, working directory, mode
      `0644` plist, mode `0700` log/state directories, and no environment
      variables containing secrets. Reject a symlinked agent/log directory,
      symlink target, malformed existing plist, foreign label, or existing plist
      with different content; never overwrite these cases.

- [ ] Assert the exact schedules:

  | Label                                | Command                                        | Schedule                                |
  | ------------------------------------ | ---------------------------------------------- | --------------------------------------- |
  | `tech.mycelia.backup-files`          | `backupctl files`                              | `StartInterval=21600`, `RunAtLoad=true` |
  | `tech.mycelia.backup-mongo-full`     | `backupctl mongo-full`                         | `Weekday=0`, Sunday 03:15 local         |
  | `tech.mycelia.backup-mongo-rpo`      | `backupctl mongo-rpo --notify-on-failure`      | `StartInterval=300`, `RunAtLoad=true`   |
  | `tech.mycelia.backup-file-freshness` | `backupctl file-freshness --notify-on-failure` | `StartInterval=3600`, `RunAtLoad=true`  |
  | `tech.mycelia.backup-status`         | `backupctl status --notify-on-failure`         | daily 08:00 local, `RunAtLoad=true`     |

  Assert `KeepAlive` is absent/false and stdout/stderr use distinct bounded log
  files under `~/Library/Logs/Mycelia/Backup`.

- [ ] Run the red installer tests:

  ```bash
  python3 -m unittest discover -s scripts/tests -p 'test_install_backup_launchagents.py'
  ```

- [ ] Implement templates and the stdlib-only installer with `plistlib` and
      atomic `os.replace`. It supports `--render`, `--install`, `--uninstall`,
      and `--status`; only `--install` calls `launchctl bootstrap gui/<uid>`,
      and only `--uninstall` calls `bootout`. Neither option deletes logs or
      backup state.

- [ ] Before install, require absolute canonical repository and compose roots,
      executable `scripts/backupctl`, passing manual `files`, `mongo-full`,
      `mongo-rpo`, and `status` receipts, and an available Keychain item.
      Rendered plists call the primary-checkout script directly without
      `/bin/sh -c`.

- [ ] Add a `monitor-tick` record at every scheduled start and end. On wake or
      renewed login, commands compute the missed interval and expose it as
      `monitoring.gapSeconds`; LaunchAgent coalescing is not treated as
      continuous execution.

- [ ] Pass tests, validate rendered plists, and inspect them for secrets:

  ```bash
  python3 -m unittest discover -s scripts/tests -p 'test_install_backup_launchagents.py'
  python3 scripts/install-backup-launchagents.py --render --output /tmp/mycelia-backup-agents
  plutil -lint /tmp/mycelia-backup-agents/*.plist
  rg -n 'PASSWORD|SECRET|TOKEN|ACCESS_KEY|mongodb://' /tmp/mycelia-backup-agents
  ```

  Expected: unit tests and `plutil` pass; the secret scan returns no matches.

- [ ] Commit:

  ```bash
  git add misc/launchagents/tech.mycelia.backup-*.plist.in scripts/install-backup-launchagents.py scripts/tests/test_install_backup_launchagents.py docs/BACKUP.md
  git commit -m "feat(backup): schedule freshness and backup jobs"
  ```

## Task 3: Build isolated restore topology and live-path refusal guards

**Files:**

- Create: `docker-compose.restore.yml`
- Create: `.env.restore.example`
- Create: `scripts/backup/restore.ts`
- Test: `scripts/backup/restore.test.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `.gitignore`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing topology tests that reject Compose project name `mycelia`,
      replica set `rs0`, default/live volumes, reused host ports, the live
      network, production bucket/prefix, enabled backup/PITR/lifecycle,
      non-empty Redis or Qdrant paths, and any restore host path equal to,
      inside, containing, or symlink-aliasing a live path. Reject any restored
      data service attached to a non-`internal: true` network, default network,
      host gateway, production DNS alias, or extra host; the drill PBM agent may
      reach only `mongo-drill` and `minio-drill` on the internal network.

- [ ] Write failing plan tests for low target capacity, wrong Mongo major/PBM
      version, absent complete base, timestamp outside a contiguous range,
      timestamp at a gap boundary, missing pre/post canaries, missing read-only
      source or writable mirror identities, and a mirror name not scoped to the
      unique drill ID.

- [ ] Add signature-binding tests for each restore mode. A plan is invalid if
      its mode, PBM base/object list, PITR interval, files snapshot, bootstrap
      snapshot, protected version IDs/catalog hash, code/config manifest hash,
      target identity/root, expiry, or policy version changes after signing.
      Include catalog, signature, and completion-marker object version IDs as
      distinct signed fields. One plan cannot be reused for another mode or
      target, and a plan with an unknown/expired policy or expiry in the past is
      rejected before object retrieval. Also reject a missing/truncated/bad MAC,
      unknown key ID, semantically equivalent but non-canonical JSON bytes,
      duplicate key, and any post-signature mutation before trusting a plan
      field or running target/source inventory.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore.test.ts
  ```

- [ ] Implement a standalone `docker-compose.restore.yml` with project
      `mycelia-restore-drill`, replica set `rsDrill`, services `mongo-drill`,
      `redis-drill`, `minio-drill`, and `pbm-drill-agent`, a distinct private
      internal network, explicit non-live bind paths, localhost-only diagnostic
      ports, verified internal TLS, and PBM 2.16. The PBM agent can route only
      to `mongo-drill` and `minio-drill`; production MinIO DNS/IP routes are
      absent/denied. Mongo/PBM backup creation, PITR slicing, lifecycle, and
      cleanup are disabled.

- [ ] Implement `backupctl restore-plan` with required `--mode`, `--time`,
      `--base`, `--target`, and `--target-root` arguments. Represent the target
      as `{kind: "local", root}` or `{kind: "ssh", host, root}`. For SSH, use
      the pinned non-interactive host identity and a fixed read-only inventory
      script to resolve paths and capacity. Canonicalize every source and
      target, inventory free bytes/inodes, verify target emptiness, prove
      version compatibility, and write a signed/redacted plan containing drill
      ID, hashes, mode, timestamp, exact PBM/PITR/restic/protected artifacts,
      every protected object version ID, catalog hash and catalog/signature/
      completion-marker version IDs, exact code Git revision and configuration
      manifest hash, source bucket ID, mirror bucket ID, target identity/root,
      expiry, policy version, and expected canary boundary. Canonical JSON has
      one documented field order/normalization and rejects duplicate keys,
      non-finite numbers, and unknown schema versions.

- [ ] Generate a dedicated CSPRNG 32-byte plan-MAC key, encode it as unpadded
      base64url (one printable line with no NUL/newline), and store only that
      encoded value in macOS Keychain service
      `tech.mycelia.backup.restore-plan`, account `plan-mac-v1`. Require an
      offline recovery receipt and authenticate the exact canonical JSON bytes
      with HMAC-SHA-256 using domain label `mycelia-restore-plan-v1` (receipt
      MACs use distinct label `mycelia-restore-receipt-v1`). The fixed key
      reader uses this exact argv and captures the encoded secret only in
      memory:

      ```text
      /usr/bin/security find-generic-password -s tech.mycelia.backup.restore-plan -a plan-mac-v1 -w
      ```

      `backupctl restore-plan-key --initialize-keychain` uses the same
      service/account with `add-generic-password ... -w`, keeps `-w` last, and
      supplies the printable line through the command's private prompt input,
      never argv. It requires a user-visible TTY, refuses an existing item, and
      performs a read-back/base64url decode/constant-time equality check that
      proves exactly 32 bytes before discarding both buffers. Add unit tests for
      malformed alphabet/padding, decoded lengths 31/33, newline/NUL, duplicate
      item, and argv/log leakage plus a user-visible-Terminal integration test;
      do not ask for the value or callback in chat. Never place the key in
      environment, plan, logs, or state. Store only the MAC and a non-secret key
      ID beside the plan. Verification must use a constant-time comparison
      before any inventory-dependent clone, restore, or cleanup action.

- [ ] Extend `Stage` with `restore-drill` and central CLI tests for
      `restore-plan-key`, `restore-plan`, `restore-drill`, and
      `restore-drill-cleanup`. Validate local and SSH target shapes without
      accepting a free-form remote command.

- [ ] Add a fixed operation that clones only the chosen base, its required PITR
      objects, PBM metadata, and required restic snapshot into the disposable
      `minio-drill` mirror. Source credentials are list/get only and are removed
      from the target process environment before any PBM agent starts. Re-list
      and hash/size-verify the mirror; then configure only the drill PBM agent
      with mirror-scoped credentials and endpoint.

- [ ] Add `restore-drill-cleanup` with required drill ID, plan MAC, and exact
      cleanup-preview hash as a separate command. It refuses live/protected
      paths and production bucket IDs, requires no running drill containers,
      previews exact disposable paths/objects, and requires
      `--confirm delete-disposable-drill`. It is never called automatically.

- [ ] Pass unit tests and render the standalone Compose file:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore.test.ts
  docker compose --env-file .env.restore.example -f docker-compose.restore.yml config --quiet
  ```

- [ ] Commit:

  ```bash
  git add docker-compose.restore.yml .env.restore.example .gitignore scripts/backup/restore.ts scripts/backup/restore.test.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): isolate restore drill topology"
  ```

## Task 4: Restore a concrete PBM base plus PITR timestamp

**Files:**

- Create: `scripts/backup/restore_pbm.ts`
- Create: `scripts/backup/quiesce.ts`
- Test: `scripts/backup/restore_pbm.test.ts`
- Test: `scripts/backup/restore_pbm.integration.test.ts`
- Test: `scripts/backup/quiesce.test.ts`
- Modify: `scripts/backup/restore.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing quiescence tests that inventory every known writer before
      the first stop: public nginx/API ingress and the whole backend service,
      backend workers, Python worker/diarization containers, RAG
      change-stream/background indexer, PBM-external import containers, enabled
      macOS ingestion/import/Voice Memos agents or processes, and direct Mongo
      clients identified by authenticated user, application name, and client
      address. Persist each exact service identity, running/enabled state,
      PID/container ID, and readiness probe in the drill manifest. Stop only
      active writers/ingress, drain active write transactions, and establish a
      reversible fail-closed write fence for every ordinary backend, RAG, and
      ingestion Mongo principal: record exact grants, suspend write grants, and
      terminate their existing sessions while leaving only the dedicated canary
      and PBM identities. Record an oplog fence start and tail a change stream,
      then require two consecutive production-Mongo `currentOp` samples at least
      five seconds apart with zero inserts, updates, deletes, find-and-modify,
      transactions, or write commands from non-canary clients. At fence close,
      reconcile the complete intervening oplog interval with the change-stream
      ledger and require that the only canonical-database writes are the two
      exact canary operations; an unknown privileged or short-lived direct write
      aborts the boundary even if both samples were zero. Resume in an outer
      `finally` only identities recorded active, restore exact grants, and
      verify every former readiness/state. Cover partial inventory, undrained
      transaction, fence/grant failure, stop failure, an unknown direct write
      between zero samples, RAG or host-agent write, canary failure, count/hash
      failure, grant/resume failure, signal interruption, and process identity
      reuse; any grant/resume failure is a high-priority production incident and
      aborts the drill.

- [ ] Write failing canary tests. Inside that bounded writer-quiesce helper,
      insert a majority-committed `pre` canary into `backup_restore_canaries`,
      capture canonical collection counts/index definitions and representative
      hashes, capture the Mongo operation time, then insert a majority-committed
      `post` canary after the chosen second. The restore timestamp must contain
      `pre` and exclude `post`.

- [ ] Write failing PBM restore command tests for exactly:

  ```text
  pbm restore
    --time=<chosen-UTC>
    --base-snapshot=<complete-base-name>
    --replset-remapping=rsDrill=rs0
    --wait
    --wait-time=<bounded-duration>
    --out=json
    --yes
  ```

  Assert PBM's documented direction is `to_name=from_name`; reject
  `rs0=rsDrill`.

- [ ] Add failing cases for a CLI wait timeout while the operation continues,
      restore `error`, restore `partlyDone`, wrong target replica set,
      unexpected production storage access, `post` canary present, `pre` canary
      absent, target agent loss, and any write recorded against
      production/protected buckets.

- [ ] Add a test where restored Mongo data contains stale production PBM config.
      The drill must keep production MinIO unreachable, overwrite PBM config
      with the disposable endpoint before an agent restart, and prove the agent
      holds only mirror-scoped credentials.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_pbm.test.ts scripts/backup/quiesce.test.ts
  ```

- [ ] Implement `runPbmRestore`: start only the isolated core project, prove
      empty target and `rsDrill` PRIMARY, apply mirror config with PITR
      disabled, start the restore, persist its name, and poll
      `pbm describe-restore --out=json` until `done` or an explicit terminal
      failure. A `--wait-time` return never substitutes for terminal polling.

- [ ] Implement the live canary boundary through `withQuiescedWriters`. Persist
      the complete prior-state inventory atomically before the first stop,
      install signal handlers before changing a writer, perform the two
      separated zero-write samples plus complete oplog-fence audit, and place
      write-grant restoration, writer/ingress restoration, and readiness
      verification in an outer `finally`. Re-resolve and match recorded service
      identity before resuming so a replacement PID is never signaled. Never
      start a restore or declare the baseline usable until grant and writer
      resume succeeds.

- [ ] For an SSH target, upload the signed plan, standalone Compose file, and
      exact restored code/config bundle to the drill directory, verify their
      hashes remotely, and run only fixed
      `docker compose -p mycelia-restore-drill-<id>` argv. Do not forward a
      caller-provided shell fragment.

- [ ] After terminal `done`, verify `rsDrill`, pre/post canary boundary,
      canonical `DATABASE_NAME` collection counts against the captured quiesced
      baseline, exact application index specs, and representative BSON/GridFS
      hashes before starting Redis, app, or RAG. Exclude PBM's changing admin
      control collections from exact-count comparison. Record PBM restore
      seconds as a named component duration and record the last restored oplog
      timestamp; never publish that component as `actualRtoSeconds`.

- [ ] Add a disposable integration test with a small logical PBM backup, two
      canaries, two PITR slices, a cloned writable mirror, and a differently
      named target set. Instrument object access so the test fails on any
      production write.

- [ ] Run unit and integration tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_pbm.test.ts scripts/backup/quiesce.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_pbm.integration.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/restore_pbm.ts scripts/backup/quiesce.ts scripts/backup/restore_pbm.test.ts scripts/backup/restore_pbm.integration.test.ts scripts/backup/quiesce.test.ts scripts/backup/restore.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): restore PBM point in time safely"
  ```

## Task 5: Replay and validate the portable restic Mongo bootstrap

**Files:**

- Create: `scripts/backup/restore_bootstrap.ts`
- Test: `scripts/backup/restore_bootstrap.test.ts`
- Test: `scripts/backup/restore_bootstrap.integration.test.ts`
- Modify: `scripts/backup/restore.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing stream tests that spawn `restic dump <snapshot> <archive>`
      and `mongorestore --archive --oplogReplay` directly, connect producer
      stdout to consumer stdin without a shell, drain both stderr streams, and
      require both exit codes to be zero. Cover producer failure, consumer
      failure, early close, timeout, empty stream, and valid replay.

- [ ] Write failing guards for a non-empty target, any live target path,
      snapshot without `mycelia-mongo-bootstrap`, snapshot not independently
      readable, and an oplog replay result missing the recorded transport
      hash/byte count.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_bootstrap.test.ts
  ```

- [ ] Implement `runBootstrapRestore` against a fresh second drill target. Keep
      its Mongo authorization state compatible with the pre-auth archive until
      replay completes; never point it at live application services. Hash/count
      the stream while forwarding it and compare with the Phase 1 receipt.

- [ ] Verify full database and collection inventory, indexes, oplog replay,
      representative BSON/GridFS hashes, and pre-bootstrap records. Set the
      original snapshot's `logicalReplayVerified` receipt only after all checks
      pass. Record stream/replay time only as a component duration; the portable
      mode receives `actualRtoSeconds` only after it proceeds through the shared
      files, migrations, application, RAG generation, and search acceptance in
      Task 6.

- [ ] Run the disposable integration test and focused unit test:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_bootstrap.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_bootstrap.integration.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/restore_bootstrap.ts scripts/backup/restore_bootstrap.test.ts scripts/backup/restore_bootstrap.integration.test.ts scripts/backup/restore.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): validate portable Mongo replay"
  ```

## Task 6: Validate canonical data, external files, application, and RAG recovery

**Files:**

- Create: `scripts/backup/restore_runtime.ts`
- Create: `scripts/backup/restore_verify.ts`
- Create: `scripts/backup/rag_restore.ts`
- Test: `scripts/backup/restore_runtime.test.ts`
- Test: `scripts/backup/restore_verify.test.ts`
- Test: `scripts/backup/rag_restore.test.ts`
- Test: `scripts/backup/restore_end_to_end.integration.test.ts`
- Modify: `docker-compose.restore.yml`
- Modify: `scripts/backup/restore.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

**Interfaces:**

- Consumes: the verified signed `RestorePlan`, isolated data roots, and the
  Phase 2 `verifyProtectedGeneration` result from Tasks 3-5.
- Produces: `buildRestoreRuntimeEnv(service, inputs)`,
  `prepareOfflineArtifacts(plan)`, `assertRestoreNetworkIsolated(project)`, and
  a signed `RestoreDrillReceipt` whose `actualRtoSeconds` is derived only from
  one `MonotonicRecoveryClock` spanning the whole recovery.

- [ ] Write failing data-verifier tests for Mongo database/collection counts,
      indexes, representative GridFS and BSON audio SHA-256, media records,
      external path/hash mapping, consent, audit, deletion, cost, and canary
      boundary. A listener, `ping`, or empty sample cannot pass.

- [ ] Write failing file-restore tests. Restore the selected restic files
      snapshot into an isolated root, map recorded source labels to isolated
      paths, reject symlink escapes, and compare hashes for every representative
      external record. Verify the Voice Memos archive with its existing full
      verifier and publish only to an isolated staging path.

- [ ] Write failing application checks for fresh Redis, migrations, backend
      `[READY]`, `/health`, `/readiness`, a representative authenticated API
      query, UI load, audio range/readback, and no connection to live
      Mongo/Redis paths. Require a one-shot isolated migration service to run
      this exact backend command before application startup:

      ```text
      deno run --allow-net --allow-read --allow-write=.,/tmp --allow-env --allow-run=ffmpeg,ffprobe,exiftool,deno --allow-sys server.ts migrate-up
      ```

      Then invoke the same fixed permission prefix with final argv
      `server.ts migrate-status` and require its exact `Pending: 0` line. Fail on
      a nonzero migration exit, an unexpected migration set, any pending
      migration, startup before migration completion, or a migration connection
      outside `mongo-drill`. Migration duration remains inside the end-to-end
      monotonic RTO.

- [ ] Write failing runtime-environment tests. Build each service environment
      from an empty map and reject inherited keys. Pin these configured-key sets
      literally in the test:

      ```ts
      const BACKEND_RESTORE_ENV_KEYS = [
        "APP_MODE",
        "MONGO_URL",
        "DATABASE_NAME",
        "REDIS_HOST",
        "REDIS_PORT",
        "SECRET_KEY",
        "RAG_URL",
        "RAG_INTERNAL_TOKEN",
      ] as const;

      const RAG_RESTORE_ENV_KEYS = [
        "RAG_MONGO_URL",
        "RAG_MONGO_DATABASE",
        "RAG_QDRANT_URL",
        "RAG_STATE_PATH",
        "RAG_MODEL_CACHE",
        "RAG_INFERENCE_PROFILE",
        "RAG_FASTEMBED_VERSION",
        "RAG_DENSE_MODEL",
        "RAG_DENSE_ARTIFACT_REPO",
        "RAG_DENSE_REVISION",
        "RAG_DENSE_TOKENIZER",
        "RAG_DENSE_TOKENIZER_REVISION",
        "RAG_DENSE_DOCUMENT_INSTRUCTION_ID",
        "RAG_DENSE_QUERY_INSTRUCTION_ID",
        "RAG_DENSE_DIMENSIONS",
        "RAG_DENSE_NORMALIZATION",
        "RAG_SPARSE_MODEL",
        "RAG_SPARSE_ARTIFACT_REPO",
        "RAG_SPARSE_REVISION",
        "RAG_SPARSE_TOKENIZER",
        "RAG_SPARSE_TOKENIZER_REVISION",
        "RAG_SPARSE_DOCUMENT_INSTRUCTION_ID",
        "RAG_SPARSE_QUERY_INSTRUCTION_ID",
        "RAG_SPARSE_NORMALIZATION",
        "RAG_RERANKER_ENABLED",
        "RAG_COLLECTION_PREFIX",
        "RAG_AUTH_MODE",
        "RAG_INTERNAL_TOKEN",
        "RAG_REQUIRE_READONLY_MONGO",
        "RAG_ENABLE_BACKGROUND",
        "RAG_BATCH_SIZE",
        "RAG_CHUNK_SIZE",
        "RAG_CHUNK_OVERLAP",
      ] as const;
      ```

      Generate drill-only 32-byte `SECRET_KEY` and `RAG_INTERNAL_TOKEN` values,
      set `APP_MODE=prod`, `RAG_AUTH_MODE=internal_token`,
      `RAG_REQUIRE_READONLY_MONGO=true`, and `RAG_ENABLE_BACKGROUND=false`, use
      only drill service names/paths, and start backend with exact argv
      `deno task prod --no-workers`. Actual container `Config.Env` may add only
      the pinned image's enumerated non-secret runtime baseline (`PATH`,
      `NODE_ENV`, Python runtime keys); the image digest and that baseline are
      part of the signed config manifest. Reject any `OPENAI_*`, `ANTHROPIC_*`,
      cloud/provider key or URL, `PYTHON_WORKER_URL`, `INGESTION_WORKER_URL`,
      `DIARIZATION_*`, PBM/MinIO/rclone credential, live host/path, or unknown
      configured/image key. Generated env files are mode `0600` and are deleted
      only by the explicit drill cleanup command. In a temporary isolated
      project fixture, seed the parent process and the fixture's `.env` with
      sentinel production/provider secrets and assert
      `docker compose config --environment` plus `docker inspect Config.Env`
      contain none of them. The test must neither read nor modify the real
      checkout `.env`.

- [ ] Write failing process/network-isolation tests. The restore Compose project
      contains no Python worker, diarization, backup, lifecycle, ingestion, or
      importer service and never invokes a host LaunchAgent/process. Before any
      restored byte is cloned, `prepareOfflineArtifacts` pulls/builds pinned
      images and runs a one-shot model prefetch against an exact
      artifact/revision manifest on a temporary egress network. It verifies
      hashes, stops the prefetcher, removes that network, mounts the cache
      read-only, and then uses a one-shot probe on the final internal network to
      prove public Internet, `host.docker.internal`, production service IP/DNS,
      and configured provider endpoints are unreachable. Repeat the same
      negative probes from backend and RAG after they start. Any egress route or
      post-restore artifact download fails the drill.

- [ ] Write failing monotonic RTO tests with a fake clock and ordered event log.
      `backupctl restore-drill` records `recoveryStartedMonotonicNs` when the
      operator's signed-plan invocation is accepted and before artifact
      preparation or the first source/protected object read. It records
      `recoveryCompletedMonotonicNs` only after file restore, Mongo restore, the
      exact migration command plus zero-pending verification, application
      acceptance, RAG generation activation, and representative search all pass.
      Require `actualRtoSeconds=(completed-started)/1_000_000_000`; reject
      wall-clock deltas, a timer started after cloning, a timer stopped at
      Mongo/app ready, or any component duration substituted for the end-to-end
      value. A failed attempt records its monotonic failure point and failure
      code but has no `recoveryCompletedMonotonicNs` or `actualRtoSeconds`.

- [ ] Write failing RAG tests. Start with empty Qdrant and SQLite state, submit
      `POST /v1/index/rebuild`, poll the named operation to completion, require
      `/ready`, inspect `/v1/status` for a newly active compatible generation
      and fresh source/checkpoint lag, then run one representative search whose
      evidence is canonically revalidated from the restored Mongo. `/ready`
      alone cannot pass.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{restore_runtime,restore_verify,rag_restore}.test.ts
  ```

- [ ] Add isolated app/RAG profiles to `docker-compose.restore.yml`. Every
      persistent path and port is drill-specific, Redis has no restored RDB,
      Qdrant has no restored collection, app backup jobs are absent, and source
      mounts are read-only isolated restores. Backend command is exactly
      `deno task prod --no-workers`; Python, diarization, host ingestion/import,
      and provider services are absent. All data-bearing services attach only to
      one `internal: true` drill network with no host gateway or production DNS.
      The temporary prefetch network is a pre-data one-shot profile and cannot
      coexist with any restored-data service. Add a separate one-shot
      `migrate-drill` service using the exact command above and the same
      sanitized backend environment; backend cannot start until it exits zero
      and `migrate-status` proves no pending migration.

- [ ] Implement `restore_runtime.ts`. Generate service env files from the exact
      allowlists above rather than filtering a production environment, generate
      drill-only secrets with Web Crypto CSPRNG, and inspect the running
      containers to require exact argv and exact allowlisted `Config.Env` keys.
      Invoke Docker Compose with a runner whose `clearEnv` is true, an explicit
      generated `--env-file`, a fixed project directory/name, and only the
      minimal signed target Docker context/TLS plus non-secret executable-path
      variables; never let the operator shell or repository `.env` participate
      in Compose interpolation. `prepareOfflineArtifacts` must complete before
      the object-clone callback is callable; `assertRestoreNetworkIsolated`
      performs both route-table/DNS inspection and negative connection probes
      through the pre-data one-shot probe after egress removal, then repeats
      them inside backend and RAG after those services start.

- [ ] Implement `restore_verify.ts` as named checks with evidence hashes/counts,
      durations, and pass/fail. Implement `rag_restore.ts` as an operation-aware
      rebuild poller. Persist a mode-`0600`, HMAC-SHA-256-authenticated,
      redacted run receipt with immutable `runOutcome: passed|failed`, source
      backup names and exact version IDs, chosen UTC, compatibility fingerprint,
      result states, verification hashes, start/end wall-clock audit timestamps,
      decimal-string monotonic start/end values, and `actualRtoSeconds`; omit
      record content and source paths. Task 1 regenerates a separate signed
      normalized receipt view whose `state` is one of `passed`, `stale`,
      `invalidated`, `failed`, or `never`: it maps a successful run to `stale`
      after 35 days, to `invalidated` after a compatibility change, and absence
      to `never`, without rewriting the immutable run outcome. Store clone,
      files, Mongo, migrations, app, and RAG timings under `componentSeconds`;
      they never feed the status `actualRtoSeconds` field.

- [ ] Pass unit tests and a small end-to-end fixture:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{restore_runtime,restore_verify,rag_restore}.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restore_end_to_end.integration.test.ts
  ```

  Create `restore_end_to_end.integration.test.ts` in this task. Expected: fresh
  Redis and Qdrant, ready app, byte-range audio response, active fresh RAG
  generation, and representative search hit from restored Mongo. Inspect backend
  logs for `[READY] ... workers=false`, assert no Python/host ingestion process
  was started or contacted, verify negative Internet/live-service probes, and
  prove the receipt's `actualRtoSeconds` covers the first object read through
  the successful search event.

- [ ] Commit:

  ```bash
  git add scripts/backup/restore_runtime.ts scripts/backup/restore_runtime.test.ts scripts/backup/restore_verify.ts scripts/backup/rag_restore.ts scripts/backup/restore_verify.test.ts scripts/backup/rag_restore.test.ts scripts/backup/restore_end_to_end.integration.test.ts docker-compose.restore.yml scripts/backup/restore.ts scripts/backup/types.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): verify full recovery behavior"
  ```

## Task 7: Prove recovery from protected versions and unlock retention eligibility

**Files:**

- Modify: `scripts/backup/protected_copy.ts`
- Modify: `scripts/backup/protected_copy.test.ts`
- Modify: `scripts/backup/restore.ts`
- Modify: `scripts/backup/status.ts`
- Modify: `scripts/backup/retention.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing protected-catalog tests. Each copy generation lists source
      repository ID, PBM base, PITR interval, restic snapshot IDs, protected
      object version IDs, sizes/hashes, copy completion UTC, retention-until
      UTC, catalog object/version ID and SHA-256, Ed25519 signature
      object/version ID, pinned signer fingerprint, and completion-marker
      version ID. Require the Phase 2 stable generation ID and prove the
      completion marker was published only after every referenced version and
      the exact canonical catalog signature verified. Reject incomplete
      generations, missing objects, mutable/unlocked versions, expired
      retention, signature mismatch, a marker that predates any referenced
      object, and a catalog accessible only with source credentials.

- [ ] Write failing access-isolation tests. The protected drill runs with
      operational PBM/restic credentials absent, reads exact historical versions
      through the restore-read identity, clones them to a new disposable mirror,
      and records zero requests to production operational namespaces. Production
      objects are never hidden, renamed, or altered for the test.

- [ ] Add failing cleanup-eligibility tests requiring two PBM bases, 35-day
      continuous PITR where enough history exists, current files snapshot,
      current protected copy, successful PBM PITR drill, successful bootstrap
      replay, successful protected-version drill, recovery-kit receipt, and
      reviewed retention preview hash. A 3-2-1 gap remains a warning but cannot
      be mislabeled as full 3-2-1 durability. Each required drill mode must have
      state `passed`, completion age at most 35 days, and the current exact
      compatibility fingerprint; `stale`, `invalidated`, `failed`, or `never`
      blocks cleanup. Any RTO policy check reads only the signed end-to-end
      `actualRtoSeconds`, never PBM/clone/component timings. Repeat the
      missing/bad MAC, unknown key ID, non-canonical bytes, duplicate key, and
      post-signature mutation cases at the cleanup entrypoint and prove each
      refuses deletion before loading cleanup credentials.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/protected_copy.test.ts scripts/backup/retention.test.ts scripts/backup/status.test.ts
  ```

- [ ] Extend the Phase 2 `verifyProtectedGeneration` implementation only where
      protected-only selection needs it; keep its canonical catalog bytes,
      Ed25519 verification, generation ID, completion-marker ordering, object
      version/retention checks, and 25-minute freshness policy as the single
      producer/status/restore contract. Implement protected-only clone mode from
      that verified result. Reuse the exact PBM and application validation from
      Tasks 4 and 6; do not create a weaker protected-copy drill or a second
      catalog interpretation.

- [ ] Reuse the Phase 2 `protected-copy` stage without redefining `Stage`, and
      add central CLI coverage only for protected restore mode and its read-only
      catalog verification.

- [ ] On success, write a mode-`0600` signed eligibility receipt. It permits a
      later operator-reviewed cleanup command but does not set
      `BACKUP_CLEANUP_ENABLED`, install a cleanup LaunchAgent, or run deletion.
      The receipt embeds the evaluated five-state result, completion UTC,
      current compatibility fingerprint, and receipt hash for all three restore
      modes plus the exact retention-preview hash. Before every cleanup, rerun
      status and refuse unless all three modes are still fresh, compatible, and
      `passed`; possession of an older eligibility file cannot bypass this live
      evaluation.

- [ ] Pass tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/protected_copy.test.ts scripts/backup/retention.test.ts scripts/backup/status.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/protected_copy.ts scripts/backup/protected_copy.test.ts scripts/backup/restore.ts scripts/backup/status.ts scripts/backup/retention.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): verify immutable recovery path"
  ```

## Task 8: Run the live restore drills and install scheduling

**Files:**

- Runtime drill state and isolated restore data only
- User LaunchAgents under `~/Library/LaunchAgents/`
- Modify tracked docs only if observed behavior differs from verified commands

- [ ] Select an approved restore host/root with enough independent free space;
      the Mac's observed 16 GiB is insufficient. Run `restore-plan` and manually
      verify that every resolved target path, Compose project, port, network,
      replica-set name, mirror bucket, and credential differs from live state.

- [ ] Create the pre/post canary boundary during the bounded writer-quiesce
      window, wait until the chosen point is inside a contiguous remotely
      readable PITR range, and run:

  ```bash
  ./scripts/backupctl restore-drill --mode pbm-pitr --plan <absolute-plan-path>
  ```

  The command itself records recovery start first, prepares and hash-verifies
  every image/model artifact while no restored data is present, removes the
  temporary egress network, proves Internet/live routes fail, and only then
  retrieves backup objects. No drill-specific pull, prefetch, clone, or restore
  may happen before the measured command. Expected: `rsDrill=rs0` remapping,
  terminal restore `done`, pre canary present, post canary absent, canonical
  hashes/counts/indexes pass, fresh Redis, app ready, audio flow works, and RAG
  rebuild/search pass. Record actual RTO from the command's operator recovery
  declaration through the successful RAG search. Backend logs must show
  `workers=false`; no Python/diarization/host ingestion process or provider
  endpoint is started or contacted.

- [ ] Run the bootstrap replay into a separate empty drill target:

  ```bash
  ./scripts/backupctl restore-drill --mode mongo-bootstrap --plan <absolute-plan-path>
  ```

  Expected: both stream processes exit zero and the Phase 1 snapshot gains a
  valid logical replay receipt. Continue through the same isolated files,
  migrations, no-workers application, RAG rebuild, and search acceptance so this
  mode's `actualRtoSeconds` is also end-to-end rather than stream time.

- [ ] Run the protected-only drill without operational credentials:

  ```bash
  ./scripts/backupctl restore-drill --mode protected-pbm-pitr --plan <absolute-plan-path>
  ```

  Expected: the same PBM/application checks pass using selected protected
  version IDs, and access logs show no production writes or operational reads.
  Its signed receipt binds the exact catalog hash, catalog/signature/marker
  version IDs, all restored object versions, current compatibility fingerprint,
  and the one end-to-end RTO interval.

- [ ] Review the new retention preview after all three drills. Keep cleanup
      disabled unless the user separately approves the exact preview hash and
      future deletion schedule. A successful drill grants eligibility, not
      deletion authority.

- [ ] Integrate the tested branch into the primary checkout using the method the
      user selected after plan approval. Re-run the full automated suite and the
      `post-change-checks` documentation/lint workflow in that canonical
      checkout.

- [ ] Install the five non-destructive LaunchAgents and inspect each service:

  ```bash
  python3 scripts/install-backup-launchagents.py --install
  launchctl print gui/$(id -u)/tech.mycelia.backup-files
  launchctl print gui/$(id -u)/tech.mycelia.backup-mongo-full
  launchctl print gui/$(id -u)/tech.mycelia.backup-mongo-rpo
  launchctl print gui/$(id -u)/tech.mycelia.backup-file-freshness
  launchctl print gui/$(id -u)/tech.mycelia.backup-status
  ```

  Expected: exact primary-checkout paths, expected schedules, no secret
  environment, and no cleanup agent.

- [ ] Renew the scheduled credential context by logging out/in or another
      documented user-session renewal, then wait for a naturally scheduled files
      run rather than only `kickstart`. Verify a new accepted restic snapshot,
      Keychain access without a prompt, representative readback, monitor tick,
      and fresh file status. If SSH/Keychain fails, status must become stale and
      notify.

- [ ] Observe PITR checks across at least two slice boundaries and one daily
      status evaluation. Verify `latestContiguousReadableUtc`, zero gaps, lag at
      most 900 seconds, a current Phase 2 completed protected generation no more
      than 25 minutes old, last drill end-to-end RTO, and the explicit
      `same-server-protected` durability classification. Do not report
      `three-two-one` without a fresh independently verified
      second-failure-domain receipt.

- [ ] Run the final project/runtime verification:

  ```bash
  deno fmt --check scripts/backupctl.ts scripts/backup/*.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backupctl.test.ts scripts/backup/*.test.ts scripts/check-env.test.ts
  python3 -m unittest discover -s scripts/tests -p 'test_install_backup_launchagents.py'
  ./scripts/check-env.sh --all
  docker compose config --quiet
  docker compose --profile backup config --quiet
  docker compose ps
  curl -fkSs https://localhost:4433/health
  curl -fkSs https://localhost:4433/readiness
  ./scripts/backupctl status --compose-root /Users/pk/repo/mycelia --json
  git diff --check
  ```

  Also verify backend/frontend bind mounts, effective `APP_MODE=dev`, fresh
  `[READY]` records, and PBM agent status as required by `DEVELOPMENT.md`.

## Phase 3 Completion Gate

The system is complete only when all tests pass, manual files/full/status/verify
commands pass, all three isolated restore modes have fresh (at most 35 days),
compatible, signed `passed` receipts, and the same-day target
`actualRtoSeconds <= 86400` is satisfied by each mode's one end-to-end monotonic
interval. Completion also requires the five non-destructive LaunchAgents to be
loaded, a natural scheduled files run after credential-context renewal, PITR
contiguous and remotely readable within 15 minutes, a current Phase 2 protected
generation, and an explicit durability classification. Component timings cannot
satisfy the RTO gate; cleanup remains a separate reviewed authorization even
after it becomes eligible.
