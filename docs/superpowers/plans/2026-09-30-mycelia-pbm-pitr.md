# Mycelia PBM and PITR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden MongoDB authentication, deploy a private TLS MinIO target on
the backup server, upgrade PBM to 2.16, create a logical base backup, and prove
continuous remotely readable PITR coverage with a restore timestamp no more than
15 minutes behind wall clock.

**Architecture:** MongoDB remains the single-node `rs0` replica set but moves
from its currently unauthenticated configuration to explicit root, application,
read-only RAG, and PBM users after the Phase 1 portable backup is proven. PBM
agents write to a dedicated MinIO operational prefix over verified private TLS.
PBM's one runtime identity has the exact storage operations PBM documents as
required: list/get/put/delete, scoped only to that operational bucket/prefix.
Separate restore-read, protected-copy, and MinIO administration identities
enforce the remaining phase boundaries; cleanup safety comes from an
operator-gated CLI policy and immutable protected copies, never from swapping
PBM credentials. A server-local copy job writes PBM objects and the SFTP/restic
repository into an object-locked/versioned protected bucket that source
credentials cannot alter.

**Tech Stack:** Deno TypeScript, Docker Compose, MongoDB 8.2 Community, Percona
Backup for MongoDB 2.16, MinIO/`mc`, private TLS, macOS Keychain and mode-`0600`
secret files, Deno tests.

**Spec:**
[`docs/superpowers/specs/2026-09-30-mycelia-incremental-backup-design.md`](../specs/2026-09-30-mycelia-incremental-backup-design.md)

**Implementation references:**
[PBM 2.16 commands](https://docs.percona.com/percona-backup-mongodb/2.16.0/reference/pbm-commands.html),
[authentication roles](https://docs.percona.com/percona-backup-mongodb/latest/install/configure-authentication.html),
[MinIO storage](https://docs.percona.com/percona-backup-mongodb/2.16.0/details/minio.html),
[storage permissions](https://docs.percona.com/percona-backup-mongodb/2.16.0/details/storage-configuration.html),
[MongoDB compatibility](https://docs.percona.com/percona-backup-mongodb/2.16.0/details/versions.html),
[backup lifecycle](https://docs.percona.com/percona-backup-mongodb/latest/usage/backup-lifecycle-management.html),
and
[restic forget/prune](https://restic.readthedocs.io/en/stable/060_forget.html).

**Depends on:**
[`2026-09-30-mycelia-backup-foundation.md`](2026-09-30-mycelia-backup-foundation.md)
must have completed both real remote snapshots. In particular, a remotely
readable pre-auth Mongo bootstrap is the rollback boundary for authentication.

**Reviewed constraint correction:** The design's separate PBM cleanup-delete
storage identity is superseded here because PBM 2.16 officially requires its
configured storage user to have List/Get/Put/Delete. This plan keeps one fixed,
prefix-scoped operational identity and moves cleanup authorization to hashed CLI
gates plus protected immutable copies. No implementation may reintroduce runtime
credential swapping.

## Global Constraints

- Continue in the isolated `sky/` worktree created for Phase 1. Preserve the
  primary checkout's unrelated dirty changes and stage only task-owned files.
- Use `superpowers:test-driven-development`, `superpowers:systematic-debugging`
  for any runtime failure, and `superpowers:verification-before-completion`
  before status claims.
- The first remote step is read-only inventory. If the server lacks a private
  bind address, verified TLS name, supported container runtime, independently
  encrypted storage, or measured capacity, stop after Phase 1. Do not install
  packages, reformat storage, expose a public port, or silently fall back to
  local PBM filesystem storage.
- Never enable Mongo authorization until root, application, read-only RAG, and
  PBM users have been created and authenticated in a rehearsal; the current
  unauthenticated state is an explicit migration input, not a safe steady state.
- Do not recursively change ownership of the 93 GiB Mongo data directory. Match
  key-file ownership to the observed Mongo process UID and prove readability
  before targeted recreation.
- Do not put Mongo root or PBM credentials in the root `.env`, backend
  environment, argv, logs, tracked YAML, or plist files. Root-admin, PBM-agent,
  and PBM-CLI secrets use distinct ignored mode-`0600` files; Compose mounts
  each only into the process that consumes it. The backend receives only the
  application URI, and RAG receives only its dedicated read-only URI.
- Configure PBM storage with bucket `mycelia-pbm` and prefix `pbm/`. Its runtime
  identity receives exactly `ListBucket` on the bucket with `s3:prefix` limited
  to `pbm` and `pbm/*`, and `GetObject`/`PutObject`/`DeleteObject` beneath it,
  as required by PBM; it has no protected-bucket, retention,
  identity-management, or MinIO-admin access. The CLI never rotates this
  identity to run cleanup.
- Keep MinIO API and console on an approved private interface. TLS verification
  is mandatory; `insecureSkipTLSVerify` is always `false`.
- A PBM command returning because `--wait-time` elapsed is not completion. Poll
  the named operation until a documented terminal state.
- Do not execute or schedule any deletion. The lifecycle policy may be enabled
  because PBM requires that state to calculate `cleanup --lifecycle --dry-run`;
  no cleanup command runs until the restore plan's gates and a separately
  reviewed preview pass.
- Startup, healthy, `[READY]`, base complete, PITR contiguous, remote readable,
  protected, and restored remain separate states.

## Review Focus

- Auth migration order cannot lock the application out without a tested rollback
  to the pre-auth config and Phase 1 backup.
- PBM's privileged Mongo role and stored `admin.pbmConfig` credentials are not
  misrepresented as read-only.
- The PBM operational identity can delete only under `mycelia-pbm/pbm/` because
  PBM requires DeleteObject; it cannot see protected versions. The restore
  identity cannot write, and MinIO administration credentials are normally
  unavailable. Cleanup authorization is a separately gated CLI policy, not a
  second S3 identity.
- The 15-minute metric uses the latest contiguous, remotely readable restore
  timestamp, not the newest metadata record.
- Retention logic preserves an anchor base at or before the PITR cutoff and
  treats PITR deletion separately from lifecycle-managed base deletion.

---

## Task 1: Inventory the backup server and model capacity without mutations

**Files:**

- Create: `scripts/backup/minio.ts`
- Create: `scripts/backup/capacity.ts`
- Test: `scripts/backup/minio.test.ts`
- Test: `scripts/backup/capacity.test.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing parsers for a fixed, read-only remote inventory response:
      OS/release, kernel, hostname, private addresses, listening sockets,
      container runtime/Compose versions, filesystem type, mountpoint,
      total/free bytes and inodes, encryption status, existing MinIO processes,
      firewall state, SFTP namespace owner, and clock skew. Reject missing,
      ambiguous, or extra privileged-command results.

- [ ] Write failing capacity tests for this model, using measured values rather
      than the 93 GiB raw database size:

  ```text
  required = weeklyBaseBytesWithin35Days
           + monthlyBaseBytesFor12Points
           + 35 * measuredOplogBytesPerDay
           + protectedCopyBytes
           + multipartAndRestoreHeadroom
           + configuredGrowthReserve
  ```

  Cover month boundaries, deduplicated monthly/weekly bases, zero growth,
  unknown compression, unknown oplog rate, insufficient inodes, and a 25%
  minimum headroom floor. Unknown measurements fail closed.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{minio,capacity}.test.ts
  ```

- [ ] Implement `backupctl minio-preflight --read-only`. Use the already pinned
      SFTP/SSH host configuration, `BatchMode=yes`, and one fixed remote script
      that contains no credentials or mutation. Permit unprivileged commands
      only; produce `NEEDS_ADMIN_INVENTORY` when encryption/firewall evidence
      requires an administrator.

- [ ] Extend the central CLI table and `backupctl.test.ts` with
      `minio-preflight`; assert the dispatcher passes the absolute compose root
      and never forwards raw config values into usage errors.

- [ ] Require all of these gates before generating deployment state:

  - a stable private IP reachable from the Mac;
  - private DNS whose certificate SAN will match the endpoint;
  - Docker Engine and Compose plugin versions that support the checked-in file;
  - a dedicated data mount whose at-rest encryption is verifiable and whose key
    recovery receipt is stored outside the Mac and server;
  - enough modeled bytes/inodes for operational and protected copies;
  - no existing listeners on the chosen private ports;
  - time skew below 30 seconds.

- [ ] Document the exact read-only inventory and failure codes in
      `docs/BACKUP.md`. Do not document a public address or a credential-bearing
      URL.

- [ ] Pass the focused tests and type-check:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{minio,capacity}.test.ts
  deno check scripts/backupctl.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/minio.ts scripts/backup/capacity.ts scripts/backup/minio.test.ts scripts/backup/capacity.test.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): gate MinIO on remote inventory"
  ```

## Task 2: Define a pinned private MinIO deployment and least-privilege policies

**Files:**

- Create: `ops/backup/minio/compose.yml`
- Create: `ops/backup/minio/minio.env.example`
- Create: `ops/backup/minio/policies/pbm-operational.json`
- Create: `ops/backup/minio/policies/pbm-restore-read.json`
- Create: `ops/backup/minio/policies/protected-copy.json`
- Create: `ops/backup/minio/bootstrap.sh`
- Create: `ops/backup/minio/verify.sh`
- Create: `ops/backup/minio/protected-copy.sh`
- Create: `ops/backup/minio/protected-copy-entrypoint.sh`
- Create: `scripts/backup/protected_copy.ts`
- Test: `scripts/backup/minio_compose.test.ts`
- Test: `scripts/backup/minio_policy.test.ts`
- Test: `scripts/backup/protected_copy.test.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing structural tests that reject `latest`, an image without an
      immutable digest, resources outside the exact named bucket/prefix, public
      port binds, HTTP MinIO endpoints, a console exposed outside the private
      address, writable TLS mounts, secrets in Compose, and any
      operational/restore principal with admin actions.

- [ ] Add failing protected-copy producer tests. Require a server-local service,
      a 15-minute interval plus 10-minute freshness grace, read-only mount of
      the SFTP restic root, a copy-service-only read credential for the
      operational PBM prefix (never the PBM source credential), no delete
      propagation, stable generation IDs, and an atomic completion marker
      written only after every object/version and signature verifies. Cover a
      crash before marker publication, tampered catalog, wrong signer
      fingerprint, missing middle object, under-retained monthly dependency,
      restic source mutation between inventory passes, stale producer health
      with a valid old receipt, and a valid current generation accepted by
      `protected-copy-status`.

- [ ] Write failing policy matrix tests with these exact outcomes. For the PBM
      operational principal, `ListBucket` on `arn:aws:s3:::mycelia-pbm` is
      conditioned to the exact `s3:prefix` values `pbm` and `pbm/*`, and the
      only object resource is `arn:aws:s3:::mycelia-pbm/pbm/*`; no ACL,
      bucket-wide wildcard, retention, version-delete, identity, or admin action
      is allowed:

  | Principal              | Operational PBM                                    | Protected bucket                                  | MinIO admin        |
  | ---------------------- | -------------------------------------------------- | ------------------------------------------------- | ------------------ |
  | PBM operational        | exact list/get/put/delete under `pbm/`             | none                                              | none               |
  | PBM restore-read       | list/get under `pbm/`                              | list/get                                          | none               |
  | Protected-copy service | list/get under `pbm/`; read-only local restic root | list/get/put + retention on own prefix; no delete | none               |
  | Administrator          | bootstrap/identity/policy only                     | bootstrap/retention only                          | required admin API |

  Include explicit denial tests for deleting protected versions and bypassing
  governance retention with every non-admin principal. Also prove there is no
  cleanup S3 principal: the PBM operational identity remains unchanged before,
  during, and after every cleanup preview or gated cleanup call.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read scripts/backup/{minio_compose,minio_policy,protected_copy}.test.ts
  ```

- [ ] During implementation, resolve a stable MinIO release from its official
      registry, record its release tag and digest, and pin both in
      `compose.yml`. The test accepts only the recorded `name@sha256:digest`
      form. Pin the matching `mc` client digest as a separate service.

- [ ] Pin a minimal protected-copy runtime image by digest. Generate an Ed25519
      catalog-signing key on the backup server with mode `0400`; store its
      private-key recovery copy offline and install only the public key plus
      fingerprint on the Mac. Source, PBM operational, and restore credentials
      never receive the private key or protected-copy service credential.

- [ ] Implement Compose with API and console published only on
      `${MINIO_PRIVATE_IP}`, a read-only certificate directory, a dedicated
      encrypted data mount, no default credential values, health checks over
      HTTPS, bounded logs, and `restart: unless-stopped`. The untracked remote
      env file is mode `0600` and contains admin bootstrap credentials only.

- [ ] Implement `bootstrap.sh` as idempotent create-or-validate operations:
      create `mycelia-pbm` without object lock, create `mycelia-protected` with
      versioning and object lock enabled at creation, create the four named
      principals, attach exact policies, and remove/disable reusable bootstrap
      admin credentials after validation. Refuse a bucket whose
      owner/region/object lock/versioning state differs.

- [ ] Configure default GOVERNANCE retention of 35 days for copied operational
      versions. A stable monthly selector pins the first successful, complete,
      remotely readable PBM base and restic snapshot in each UTC calendar month.
      Every object version in each pinned point's recoverable dependency closure
      receives 400 days: all PBM base metadata/archive/oplog objects; and the
      restic config, key, snapshot, index/tree/data pack graph needed to restore
      the pinned snapshot. Its signed catalog, signature, and completion marker
      receive the same 400 days. Do not grant bypass-governance to source, PBM,
      restore, or copy service identities.

      The copy service never receives the restic password, so it cannot inspect
      the encrypted snapshot graph. For each monthly restic point, conservatively
      define the recoverable closure as every repository object/version in the
      atomically inventoried source generation containing that snapshot. This
      superset is capacity-modeled and avoids claiming a partial graph is
      independently restorable.

- [ ] Implement `protected-copy.sh` as an additive mirror: copy changed PBM
      objects and the local SFTP/restic repository into separate protected
      prefixes without `--remove`, resolve resulting version IDs/sizes/hashes,
      compute and record each pinned monthly dependency closure, apply the
      correct 35- or 400-day retention to every referenced version, and build
      canonical JSON. Copy an exact PBM key/version inventory at a recorded
      cutoff. For restic, require identical complete source inventories before
      and after the copy; if the repository changes, leave the generation
      incomplete and retry instead of publishing a mixed generation. Sign the
      exact catalog bytes with the Ed25519 private key, upload catalog and
      detached signature under a unique staging generation, read both back and
      verify with the public key, then atomically publish a completion marker
      containing their hashes and generation ID as one final conditional PUT. An
      interrupted generation remains incomplete and is ignored.

- [ ] Implement the fixed entrypoint loop with a monotonic 900-second interval,
      single-instance lock, bounded runtime, retry backoff, and a health record;
      it never treats an old catalog as a successful current run. Implement
      `protected_copy.ts` to verify the pinned signer fingerprint, signature,
      completion-marker/catalog/signature hash binding, every object version,
      retention-until value, copy age, exact PBM/PITR/restic coverage, and every
      400-day monthly dependency closure. Extend `Stage` with `protected-copy`
      and wire `protected-copy-verify --generation <id>` plus
      `protected-copy-status` into the central CLI. Verification writes a
      redacted durable receipt only after all checks pass; status is `current`
      only while that receipt's generation is complete, valid, and at most 25
      minutes old. Phase 3's aggregate status consumes this receipt rather than
      trusting the producer health file.

- [ ] Implement `verify.sh` to prove right-CA success, wrong-CA failure,
      certificate SAN/expiry, private-interface listeners, anonymous denial,
      principal policy matrix, versioning, object lock, representative object
      encryption on the encrypted mount, and recovery-key receipt presence. It
      deletes only its uniquely named test object before retention is applied.

- [ ] Run tests plus local Compose rendering without secrets:

  ```bash
  deno test --allow-read scripts/backup/{minio_compose,minio_policy,protected_copy}.test.ts
  docker compose --env-file ops/backup/minio/minio.env.example -f ops/backup/minio/compose.yml config --quiet
  sh -n ops/backup/minio/bootstrap.sh ops/backup/minio/verify.sh ops/backup/minio/protected-copy.sh ops/backup/minio/protected-copy-entrypoint.sh
  ```

- [ ] Commit:

  ```bash
  git add ops/backup/minio scripts/backup/protected_copy.ts scripts/backup/minio_compose.test.ts scripts/backup/minio_policy.test.ts scripts/backup/protected_copy.test.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): define private MinIO storage"
  ```

## Task 3: Rehearse and implement MongoDB authorization migration

**Files:**

- Create: `misc/mongo/create-backup-users.js`
- Create: `misc/mongo/authenticated-status.js`
- Create: `ops/backup/mongo-admin.env.example`
- Create: `scripts/backup/mongo_auth.ts`
- Test: `scripts/backup/mongo_auth.test.ts`
- Test: `scripts/backup/mongo_auth.integration.test.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `misc/mongo/mongo-entrypoint.sh`
- Modify: `misc/mongo/mongod.conf`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.rag.yml`
- Modify: `.env.example`
- Modify: `rag/.env.example`
- Modify: `.gitignore`
- Modify: `docs/BACKUP.md`

- [ ] Write failing migration-plan tests for the observed starting states: auth
      disabled/no users, auth disabled/users already correct, auth enabled and
      credentials correct, auth enabled and credentials wrong, non-primary
      member, missing Phase 1 snapshot, keyfile wrong mode/owner, and unexpected
      existing roles. Every mutating path requires the exact accepted Phase 1
      snapshot ID.

- [ ] Write failing fixed-script tests. `create-backup-users.js` reads usernames
      and passwords only from process environment, creates/updates the root
      user, an application user with `dbOwner` on `DATABASE_NAME`, and the
      official PBM roles on `admin`: `readWrite`, `backup`, `clusterMonitor`,
      `restore`, plus the custom `pbmAnyAction` role containing `anyAction` on
      `anyResource`. It also creates a separate RAG user with only `read` on
      `DATABASE_NAME`, sufficient for collection reads and change streams. It
      prints user names and role names only.

- [ ] Add failing tests that `authenticated-status.js` connects locally and
      authenticates with the two fixed root-credential environment variables.
      Require `rs0` PRIMARY and never interpolate a secret into source-generated
      argv. Test that unauthenticated application reads fail after migration,
      authenticated app reads/writes succeed, the RAG user can read and resume a
      change stream but cannot write, and the PBM user authenticates.

- [ ] Add failing secret-boundary tests. Root credentials exist only as
      `MONGO_ADMIN_USERNAME`/`MONGO_ADMIN_PASSWORD` in ignored
      `misc/secrets/mongo-admin.env` mode `0600`; neither those names nor the
      legacy `MONGO_INITDB_ROOT_*` names may appear in root `.env`, backend/RAG
      container environments, rendered Compose, logs, argv, or status JSON.
      `docker-compose.rag.yml` must require an authenticated `RAG_MONGO_URL`
      from ignored `rag/.env`, set `RAG_REQUIRE_READONLY_MONGO=true`, and
      contain no unauthenticated default URI.

- [ ] Run the red tests and shell syntax check:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/mongo_auth.test.ts
  bash -n misc/mongo/mongo-entrypoint.sh
  ```

- [ ] Implement `backupctl mongo-auth-plan` as read-only inventory of current
      authorization, users/roles, Mongo process UID/GID, data/keyfile ownership,
      replica-set state, and current app connectivity. Redacted output contains
      booleans and role names only.

- [ ] Extend `Stage` with `mongo-auth`, and extend the central CLI tests for
      `mongo-auth-plan`, `mongo-auth-prepare`, `mongo-auth-apply`, and the
      bounded rollback command. Unknown confirmation text must remain a usage
      error.

- [ ] Implement `backupctl mongo-auth-prepare --bootstrap-snapshot <id>`:

  1. verify that `<id>` is the accepted remotely readable Phase 1 Mongo
     snapshot;
  2. require `.env` and every live secret file to be mode `0600`; generate
     missing root/application/RAG/PBM passwords through a CSPRNG without
     printing them;
  3. keep only the application URI in `.env`; write root credentials only to
     ignored `misc/secrets/mongo-admin.env`, the authenticated read-only RAG URI
     only to ignored `rag/.env`, and distinct agent/CLI PBM URIs only to ignored
     `misc/secrets/pbm-agent.env` and `misc/secrets/pbm-cli.env`. Percent-encode
     every URI component. The agent URI targets
     `mongo:27017/?replicaSet=rs0&authSource=admin`; the CLI URI independently
     targets the same Docker-network replica-set endpoint but is consumed only
     by the disposable `pbm-cli` service;
  4. generate `misc/secrets/mongo-keyfile` with MongoDB-compatible entropy, mode
     `0400`, and the owner required by the observed process;
  5. run the fixed user script while auth is still disabled;
  6. prove all four accounts by `db.auth` before touching config, then prove the
     RAG role permits reads/change streams and denies writes;
  7. require offline recovery-kit receipts for the root/PBM credentials and
     replica-set keyfile without printing or copying their values through Codex.

- [ ] Add `ops/backup/mongo-admin.env.example` with fixture-only values and
      remove `MONGO_INITDB_ROOT_*` from `.env.example` and the backend-loaded
      `.env` contract. Compose passes the admin file only to `mongo`; admin
      scripts receive it as subprocess environment, never argv. Add an
      integration assertion against `docker inspect` that backend, Python
      worker, RAG, and PBM containers do not receive root credentials.

- [ ] Modify `mongod.conf` to enable `security.authorization` and point at the
      read-only keyfile mount. Change the published host port from `27017:27017`
      to `127.0.0.1:27017:27017`. Mount the keyfile only into Mongo. Replace the
      credential-free `mongostat` healthcheck with a local `mongosh` `ping`
      liveness probe; authenticated PRIMARY checks remain in readiness and
      `backupctl`.

- [ ] Refactor `mongo-entrypoint.sh` to use the fixed authenticated status
      script whenever authorization is enabled. It must fail if root auth fails
      or the replica set cannot become PRIMARY, rather than falling through
      after 60 seconds. Preserve the current `rs0` hostname and do not
      reinitialize an existing set.

- [ ] Add `backupctl mongo-auth-apply` with required bootstrap snapshot and the
      exact confirmation text `enable-authorization`. It validates
      `docker compose config`, inventories and quiesces every Mongo writer
      (backend, Python worker, and any enabled host ingestion/import service)
      plus the separate RAG reader/change-stream client, records their prior
      states, and verifies no application write remains in `currentOp`. It then
      recreates only Mongo, waits for authenticated PRIMARY, recreates backend
      and Python worker with the authenticated `MONGO_URL`, recreates RAG only
      if it was previously running with its authenticated read-only URI, resumes
      only the previously enabled host services, restarts nginx, and executes
      the project's readiness checks. It does not recreate Redis or Qdrant.

- [ ] Add a bounded rollback command that restores the saved pre-auth
      `mongod.conf`, recreates only Mongo, and leaves the newly created users in
      place. Rollback requires the same snapshot ID and is available until the
      authenticated application readiness gate passes. It never restores data or
      deletes users automatically.

- [ ] Exercise the entire migration against a disposable single-node replica set
      and test application before applying it live:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/mongo_auth.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/mongo_auth.integration.test.ts
  docker compose config --quiet
  docker compose --env-file rag/.env.example -f docker-compose.rag.yml config --quiet
  ```

  Create `mongo_auth.integration.test.ts` in this task. Expected: authenticated
  root/app/RAG/PBM access succeeds, unauthenticated collection access fails, RAG
  reconnects and observes a post-migration canary through its change stream
  while a RAG write is denied, restart preserves users, no non-Mongo container
  sees root credentials, and rs0 returns PRIMARY.

- [ ] Commit code/config before any live apply:

  ```bash
  git add misc/mongo/create-backup-users.js misc/mongo/authenticated-status.js ops/backup/mongo-admin.env.example scripts/backup/mongo_auth.ts scripts/backup/mongo_auth.test.ts scripts/backup/mongo_auth.integration.test.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts misc/mongo/mongo-entrypoint.sh misc/mongo/mongod.conf docker-compose.yml docker-compose.rag.yml .env.example rag/.env.example .gitignore docs/BACKUP.md
  git commit -m "feat(mongo): gate authorization migration on backup"
  ```

## Task 4: Upgrade and isolate PBM 2.16 configuration

**Files:**

- Create: `scripts/backup/pbm.ts`
- Test: `scripts/backup/pbm.test.ts`
- Create: `ops/backup/pbm-agent.env.example`
- Create: `ops/backup/pbm-cli.env.example`
- Create: `ops/backup/pbm-agent-entrypoint.sh`
- Create: `ops/backup/pbm-cli-entrypoint.sh`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `docs/BACKUP.md`

- [ ] Write failing Compose tests asserting
      `percona/percona-backup-mongodb:2.16.0`, no local backup volume, a Mongo
      health dependency, a read-only CA mount, `SSL_CERT_FILE`, no PBM secret in
      backend, and a dedicated ignored agent env file mounted only into
      `pbm-agent`. Require `PBM_AGENT_MONGODB_URI` in the agent file and
      `PBM_CLI_MONGODB_URI` in a separate CLI-only file. The agent entrypoint
      maps only the former to PBM's required `PBM_MONGODB_URI` immediately
      before `exec`; a non-running `pbm-cli` service maps only the latter before
      executing one CLI command. Reject either URI in Compose rendering, logs,
      argv, status JSON, error messages, or any non-owning service environment.

- [ ] Write failing config-render tests for the exact redacted structure:

  ```yaml
  storage:
    type: s3
    s3:
      region: us-east-1
      bucket: mycelia-pbm
      prefix: pbm
      endpointUrl: https://backup-private.example:9000
      forcePathStyle: true
      insecureSkipTLSVerify: false
      credentials:
        access-key-id: supplied-at-runtime
        secret-access-key: supplied-at-runtime
  pitr:
    enabled: false
    oplogSpanMin: 10
  lifecycle:
    enabled: true
    strategy: calendar
    minKeep: 2
    purgeFailed: false
    dailyRetention: 35
    weeklyRetention: 0
    monthlyRetention: 12
    monthlyDay: 1
  ```

  Lifecycle policy evaluation is enabled so PBM can produce a real dry-run; PBM
  deletes nothing until the separate `pbm cleanup --lifecycle` command is
  invoked. This plan neither invokes nor schedules that command. In production
  code, the three endpoint/credential values are required runtime parameters;
  the literal demonstration values above never reach a tracked generated file.

- [ ] Add failing cases for HTTP endpoints, IP endpoints that do not match the
      certificate SAN, unknown CA, wrong bucket, missing force-path-style, MinIO
      admin credentials, missing/wrong `pbm` prefix, YAML or secret file mode
      other than `0600`, either URI file mounted into the wrong service, a CLI
      invocation that starts a persistent second agent, a URI that cannot reach
      `mongo` from its owning container, a secret emitted by any output channel,
      PBM version below 2.16, agent not OK, and redacted config differing from
      requested non-secret fields.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/pbm.test.ts
  ```

- [ ] Implement the Compose update and `renderPbmConfig(values)`. Write config
      atomically to the protected state directory, run `pbm config --file`,
      remove the file in `finally`, then query redacted `pbm config` and compare
      storage type, endpoint, bucket, prefix, PITR, and lifecycle fields. Every
      CLI invocation goes through one wrapper that runs the non-persistent
      `pbm-cli` Compose service with `run --rm --no-deps`. Its entrypoint reads
      `PBM_CLI_MONGODB_URI`, places it only in that child process environment as
      `PBM_MONGODB_URI`, and central redaction filters returned output. The
      agent gets only `PBM_AGENT_MONGODB_URI`; both owning containers
      independently prove the Docker-network endpoint
      `mongo:27017/?replicaSet=rs0&authSource=admin`. Document that storage
      credentials persist in Mongo `admin.pbmConfig` and are part of
      rotation/recovery.

- [ ] Add `ops/backup/pbm-agent.env.example` and
      `ops/backup/pbm-cli.env.example` with syntactically valid fixture-only
      values and document copying them to ignored `misc/secrets/pbm-agent.env`
      and `misc/secrets/pbm-cli.env`, both mode `0600`. Implement
      `pbm-agent-entrypoint.sh` without `eval` or shell tracing; it validates
      one assignment, exports the value under PBM's required variable name,
      unsets the source name, and `exec`s the agent. Implement
      `pbm-cli-entrypoint.sh` with the same parser but an allowlist of PBM
      subcommands; it executes once and exits, never starts an agent. Extend
      `Stage` with `pbm-bootstrap`, and extend CLI dispatch tests for that
      command. The backend Compose service must not reference either PBM
      env-file variable.

- [ ] Add `backupctl pbm-bootstrap` with ordered gates: Mongo auth complete,
      private TLS right-CA success/wrong-CA failure, MinIO policy probe, bucket
      identity, exact operational List/Get/Put/Delete probe under `pbm/` plus
      protected/admin denial, separate agent and disposable-CLI Mongo
      authentication probes, PBM image/version, agent heartbeat, redacted config
      comparison, and PBM status. Keep PITR disabled.

- [ ] Pass tests and render Compose with a fixture PBM env/CA:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/pbm.test.ts
  PBM_AGENT_ENV_FILE=ops/backup/pbm-agent.env.example PBM_CLI_ENV_FILE=ops/backup/pbm-cli.env.example docker compose --profile backup config --quiet
  sh -n ops/backup/pbm-agent-entrypoint.sh ops/backup/pbm-cli-entrypoint.sh
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/pbm.ts scripts/backup/pbm.test.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts ops/backup/pbm-agent.env.example ops/backup/pbm-cli.env.example ops/backup/pbm-agent-entrypoint.sh ops/backup/pbm-cli-entrypoint.sh docker-compose.yml .env.example docs/BACKUP.md
  git commit -m "feat(backup): wire PBM 2.16 to private MinIO"
  ```

## Task 5: Implement logical full backup and continuous PITR verification

**Files:**

- Create: `scripts/backup/pitr.ts`
- Test: `scripts/backup/pitr.test.ts`
- Test: `scripts/backup/pitr.integration.test.ts`
- Modify: `scripts/backup/pbm.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing `mongo-full` tests for
      `pbm backup --type=logical --wait --out=json`, timeout followed by
      continued polling, named-operation lookup, `done`, `error`, `cancelled`,
      malformed JSON, agent loss, and a successful metadata record whose first,
      middle, or last expected S3 object cannot be read or whose ETag changes
      after its receipt.

- [ ] Write failing PITR interval tests. Normalize slices to half-open UTC
      intervals, merge exact overlaps, detect any positive gap, reject a newest
      slice without a complete base at or before it, and compute
      `latestContiguousReadableUtc`. A slice is readable only when every object
      that PBM metadata says contributes to that slice has a fresh durable read
      receipt bound to its object key, version/ETag, size, checksum metadata,
      and verified byte ranges. Test 14m59s as current and 15m01s as stale.

- [ ] Add failing checks for enabling PITR before a base, only one slice after
      enable, a gap hidden by a newer slice, remote read failure, wall-clock
      skew, and oplog-window exhaustion. Include a three-slice chain whose first
      and last slices read successfully but whose middle slice, or one object in
      that middle slice, is unreadable; the readable frontier must stop before
      it. Include a stale receipt after an object ETag/version changes.
      `pbm list --out=json` alone must never make `remoteReadable` true.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{pbm,pitr}.test.ts
  ```

- [ ] Implement `backupctl mongo-full`: acquire the global lock, verify PBM
      agent/storage, start one logical full, persist its operation name, poll
      `pbm describe-backup --out=json` through timeouts until a terminal state,
      enumerate every object belonging to the named backup, and perform an
      authenticated metadata check plus bounded first/last range reads for each
      one. Write `complete` only for terminal `done` plus complete current
      per-object read receipts.

- [ ] Extend `Stage` with `mongo-full` and `pitr`, then add central CLI dispatch
      cases for `mongo-full`, `pitr-enable`, and `mongo-rpo` before wiring the
      implementation.

- [ ] Implement `backupctl pitr-enable --base <backup-name>`. Require that exact
      base to be complete and readable, enable PITR, wait for at least two
      completed 10-minute slices, enumerate every object contributing to every
      slice from the base through the candidate frontier, and issue an
      authenticated HEAD plus bounded first/last range reads for each object.
      Persist redacted per-object receipts atomically; no slice becomes readable
      until all of its current object versions have receipts. Prove contiguous
      metadata and complete per-slice receipt coverage, never only
      representative reads at the beginning and end of the window.

- [ ] Implement `backupctl mongo-rpo`. Report base name, first restorable UTC,
      latest contiguous readable UTC, gap count, lag seconds, agent state, and
      `current|stale|failed`. Before advancing the readable frontier, refresh or
      validate every contributing slice receipt against current object
      version/ETag and size. A missing/unreadable middle object, a gap, or lag
      over 900 seconds exits non-zero even when a newer isolated slice exists.

- [ ] Pass tests and a disposable MinIO/PBM integration scenario with a canary
      write between two slices:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{pbm,pitr}.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/pitr.integration.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/pitr.ts scripts/backup/pitr.test.ts scripts/backup/pitr.integration.test.ts scripts/backup/pbm.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): verify PBM base and PITR coverage"
  ```

## Task 6: Implement retention previews and immutable cleanup gates

**Files:**

- Create: `scripts/backup/retention.ts`
- Test: `scripts/backup/retention.test.ts`
- Modify: `scripts/backup/pbm.ts`
- Modify: `scripts/backup/restic.ts`
- Modify: `scripts/backup/types.ts`
- Modify: `scripts/backupctl.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing calendar-policy tests for 35 days of full PITR coverage, 12
      distinct monthly bases, calendar months of 28/29/30/31 days, two minimum
      complete PBM bases, the anchor base at/before the PITR cutoff, restic
      snapshots within 35 days plus the same 12 pinned monthly point IDs used by
      protected-copy catalogs, and protected versions required before every
      proposed deletion. A monthly point is protected only if its complete PBM
      or restic dependency graph—not just its catalog object—has valid 400-day
      retention.

- [ ] Write failing command tests that keep these previews separate: PBM
      lifecycle full-backup candidates from
      `pbm cleanup --lifecycle --dry-run --out=json`, time-bounded
      `pbm delete-pitr --older-than=<cutoff> --dry-run --out=json` candidates,
      policy candidates from
      `restic forget --keep-within 35d --keep-monthly 12 --keep-tag monthly --prune --dry-run`,
      and currently unreachable packs from a separate `restic prune --dry-run`.
      The installed restic 0.19.1 help and official docs explicitly support both
      dry-run forms. Assert no `--yes`, credential swap, or mutating call
      appears in `retention-dry-run`; `--prune` is accepted there only when the
      same argv contains `--dry-run`. The word `delete-pitr` may appear only
      with `--dry-run` in a separately verified argv that cannot confirm
      deletion.

- [ ] Add refusal tests for fewer than two bases, PITR gap, stale files
      snapshot, absent protected copy, missing successful restore drill, missing
      cleanup gate, PBM operational identity/policy differing from the pinned
      List/Get/Put/Delete-only definition, stale or incompatible preview hash,
      and a proposed deletion that removes an anchor, pinned monthly point, or
      any object in its recoverable dependency graph.

- [ ] Run the red test:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/retention.test.ts
  ```

- [ ] Implement `retention-dry-run` as a deterministic JSON plan containing
      object IDs/names, UTC cutoffs, reasons, retained anchors, policy version,
      and a hash of the plan. It does not expose credentials, object URLs, or
      source paths.

- [ ] Extend `Stage` with `retention`, and extend central CLI tests for
      `retention-dry-run`, `cleanup`, and `cleanup-prune`. Both mutation
      commands must be unreachable without every explicit gate even when called
      directly.

- [ ] Implement `cleanup` in a permanently disabled-by-default state. The code
      requires the exact preview hash, `BACKUP_CLEANUP_ENABLED=true` from a
      separate operator-supplied environment, successful drill/protected-copy
      receipts, a fresh compatible restore drill, and a readback that the PBM
      operational policy still equals the pinned List/Get/Put/Delete-only
      policy. It acquires the global lock, reruns all four previews and requires
      byte-for-byte normalized output and repository/storage fingerprints to
      reproduce the supplied hash, then performs only the named PBM base/PITR
      deletions and exact restic snapshot IDs from that plan. It never creates,
      requests, applies, or swaps a cleanup storage credential: PBM retains its
      required operational identity throughout, while protected versions remain
      immutable.

      Do not run restic prune in that first mutation. After exact snapshot
      forgetting, run supported `restic prune --dry-run`, persist its normalized
      pack/repack/delete set, repository fingerprint, flags, and a second hash,
      then stop with `PRUNE_APPROVAL_REQUIRED`. `cleanup-prune
      --preview-hash <hash>` is a separately disabled-by-default operation. It
      rechecks every gate and the unchanged post-forget repository fingerprint,
      reruns `restic prune --dry-run` to reproduce the hash, runs `restic prune`
      with exactly the hashed tuning flags, and finishes with `restic check`.
      Any drift creates a new preview and requires new approval. After either
      mutation, recheck agents, PITR coverage, protected objects, and restic
      integrity. Do not schedule or invoke either mutation in this plan.

- [ ] Pass tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/retention.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/retention.ts scripts/backup/retention.test.ts scripts/backup/pbm.ts scripts/backup/restic.ts scripts/backup/types.ts scripts/backupctl.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): preview retention with delete gates"
  ```

## Task 7: Deploy MinIO, migrate auth, and establish the live PITR chain

**Files:**

- Remote deployment/state only for MinIO and protected-copy service
- Live `.env`, ignored `rag/.env`, and ignored `misc/secrets/` only for
  Mongo/RAG/PBM credentials
- No tracked change unless a verified implementation defect is found

- [ ] Run `backupctl minio-preflight --read-only` after SSH is non-interactive.
      Review the exact inventory and capacity model. Stop if any server
      prerequisite is missing; require the server administrator to provision the
      private encrypted mount or firewall outside this automation.

- [ ] Copy the pinned `ops/backup/minio` bundle to a dedicated remote directory,
      create its mode-`0600` env and TLS material through the server's approved
      secret flow, and start only MinIO/`mc`. Run `bootstrap.sh` to create or
      validate buckets, versioning/object-lock state, principals, and exact
      policies; only after bootstrap succeeds run `verify.sh`. Record right-CA,
      wrong-CA, private listener, policy, encryption, object-lock, capacity, and
      recovery-key evidence.

- [ ] Run `backupctl mongo-auth-plan` and compare it to the expected
      unauthenticated state. Run `mongo-auth-prepare` with the accepted Phase 1
      snapshot ID, verify root/application/RAG/PBM accounts and secret-file
      boundaries, then apply during an explicit maintenance window. Verify the
      backend sees only its application URI, RAG reconnects with its read-only
      URI and resumes its change stream, and neither receives root or PBM
      credentials.

- [ ] Immediately after authenticated readiness passes, run a new
      `backupctl files` snapshot so the encrypted repository contains the active
      authenticated application `.env`, isolated root-admin and RAG secret
      files, Mongo keyfile, both dedicated PBM env files/CA, and updated
      Compose/config files. Verify representative readback without revealing any
      secret before continuing.

- [ ] Follow `DEVELOPMENT.md` readiness and reload diagnostics after targeted
      recreation: verify backend/frontend bind mounts, effective `APP_MODE=dev`,
      authenticated Mongo PRIMARY, Docker health, `[READY]`, `/health`, and
      `/readiness`. Verify unauthenticated collection access is denied. Recreate
      neither Redis nor unrelated services.

- [ ] Start the PBM profile, confirm image 2.16 and agent heartbeat, apply the
      S3 configuration with PITR disabled, and compare redacted config. Prove
      the agent uses only `PBM_AGENT_MONGODB_URI`, the disposable CLI service
      uses only `PBM_CLI_MONGODB_URI`, both authenticate, and neither URI
      appears in output. Prove the backend/RAG cannot see either PBM secret and
      the PBM operational identity has only exact List/Get/Put/Delete access
      beneath `mycelia-pbm/pbm/`, with no protected/admin access.

- [ ] Run `backupctl mongo-full`, retain its operation name and terminal state,
      then enable PITR against that exact base. Observe two or more complete
      slices and run `backupctl mongo-rpo` until lag is at most 900 seconds with
      zero gaps and a current read receipt for every object in every
      contributing slice. Deliberately deny a disposable middle-slice fixture in
      the integration environment and prove the frontier stops before it; do not
      perform this fault injection against the live chain.

- [ ] Start the server-local protected-copy job. Mirror the operational PBM
      bucket and the SFTP restic repository into separate prefixes of
      `mycelia-protected` without propagating deletes. Apply 35-day GOVERNANCE
      retention to ordinary versions and 400-day retention to every object in
      each pinned monthly PBM-base/restic-snapshot recoverability graph plus its
      catalog, signature, and completion marker. Verify source/operational
      credentials cannot list protected objects, alter retention, delete a
      protected version, or access MinIO admin APIs.

- [ ] Observe two completed protected-copy generations at least 15 minutes
      apart, including one changed PITR object and the post-auth files snapshot.
      Verify the completion marker is last, the Ed25519 signature matches the
      offline-pinned public-key fingerprint, every referenced object/version is
      readable and retained, copy age is at most 25 minutes, and removing a
      disposable source test object does not remove its protected version. Run
      `backupctl protected-copy-verify` for each generation and require
      `backupctl protected-copy-status` to consume the accepted receipt and
      report `current`; producer health alone is insufficient.

- [ ] Run final evidence commands:

  ```bash
  ./scripts/backupctl verify --compose-root /Users/pk/repo/mycelia --stage mongo-full
  ./scripts/backupctl mongo-rpo --compose-root /Users/pk/repo/mycelia --json
  ./scripts/backupctl protected-copy-status --compose-root /Users/pk/repo/mycelia --json
  ./scripts/backupctl retention-dry-run --compose-root /Users/pk/repo/mycelia --json
  docker compose --profile backup ps
  ```

  Expected: PBM base complete/readable, contiguous PITR lag `<=900`, protected
  copy current, and a non-mutating retention plan. Cleanup remains disabled.

## Phase 2 Completion Gate

Phase 2 is complete only when authenticated application behavior and denial of
unauthenticated reads are live-verified, RAG has resumed with its read-only
account, and root/PBM secrets are absent from application containers. MinIO must
be private/TLS/encrypted and policy-tested; PBM must retain its exact
operational-prefix identity and have a complete remotely readable 2.16 logical
base. At least two PITR slices must form a contiguous chain within 15 minutes of
wall clock with current receipts for every contributing object. Both PBM and
restic data must have current signed protected copies, including complete
400-day dependency graphs for any pinned monthly points. Restore and automatic
scheduling remain incomplete until Phase 3 passes.
