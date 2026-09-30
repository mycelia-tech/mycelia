# Mycelia Incremental Backup and Restore Design

**Status:** approved in conversation on 2026-09-30; implementation pending

**Goal:** Protect Mycelia's canonical MongoDB data, configuration, and
externally referenced originals in always-on remote storage, with a MongoDB
recovery point objective of at most 15 minutes, 35 days of operational history,
12 monthly recovery points, and a measured same-day recovery target.

## Current baseline

The primary deployment is the `mycelia` Docker Compose project in this checkout.
MongoDB is Community 8.2, runs as the single-node replica set `rs0`, and
currently uses approximately 93 GiB on disk. The application, MongoDB, and Redis
are healthy; the backend reports `ready` in development mode and its bind mounts
point at this checkout.

The host has approximately 16 GiB free, so the design must not create a local
staging copy of the database. `mongodump` 100.17 is available inside the Mongo
container. Host `restic` 0.19.1 and `rclone` 1.75.0 are available. PBM is not
currently running; the existing Compose profile is only partial wiring around
PBM 2.12 and has no storage bootstrap, scheduler, retention, monitoring, or
restore workflow.

The selected `pk-backup:` rclone remote uses SFTP. Its TCP endpoint is
reachable, but non-interactive authentication is currently blocked because the
local RSA private-key passphrase cannot be retrieved from macOS Keychain while
user interaction is disallowed. No existing remote namespace or free-space
figure has therefore been verified yet.

## Selected architecture

Use two storage interfaces on the same backup server:

1. An encrypted restic repository accessed through
   `rclone:pk-backup:mycelia/restic-v1` for configuration, externally referenced
   originals, and a one-time portable Mongo bootstrap backup.
2. A dedicated MinIO/S3 endpoint and bucket on the backup server for PBM 2.16
   logical backups and continuous point-in-time recovery.

The MinIO API and console bind only to an approved private backup network. PBM
verifies the server certificate; insecure TLS verification is forbidden. PBM
objects are encrypted at rest with independently recoverable key material, and
the deployment verifies encryption on representative stored objects before
canonical data is uploaded.

The source Mac's scheduled identities can upload and read for verification but
cannot administer MinIO or delete protected versions. Cleanup uses a separate,
normally unavailable identity. The backup server must provide an immutable or
versioned recovery copy of both the PBM bucket and restic repository that these
source identities cannot remove. A second failure-domain copy remains required
before claiming full 3-2-1 protection; if it is not available in v1, `status`
must report that durability gap explicitly. MinIO object locking or filesystem
snapshots may be used only after their interaction with PBM cleanup and restore
has been tested.

SFTP alone is suitable for restic, but PBM does not support SFTP as a storage
backend. An rclone S3 gateway is intentionally rejected because
`rclone serve
s3` remains experimental. Mounting SFTP or rclone as PBM
filesystem storage is also rejected because a transient network filesystem would
add unsupported filesystem and cache semantics to the canonical recovery chain.

If the backup host cannot safely run MinIO or does not have enough storage, the
system must stop after the encrypted bootstrap backup and request a dedicated
supported PBM target. It must not silently downgrade the Mongo RPO or place PBM
data on the nearly full local disk.

## Data classification

### Canonical MongoDB data

PBM protects all MongoDB databases required by Mycelia, including GridFS/BSON
audio, `audio_chunks`, diarizations, media originals and previews, events,
consent, audit, deletion, and cost records. MongoDB Community supports logical
PBM backups and PITR, not physical incremental PBM backups. The incremental
recovery chain therefore consists of a logical base plus oplog slices.

Never copy the live WiredTiger directory with tar, restic, or rclone.

### External originals and protected configuration

Restic snapshots use an explicit, resolved allowlist:

- configured `MEDIA_SOURCE_HOST_PATH` and `MEDIA_SOURCE_EXTRA_HOST_PATH` roots;
- the verified Voice Memos archive, not its bounded staging projection;
- `/Users/pk/Pictures/Mycelia-Import` when present and readable;
- tracked working-tree files resolved through Git, plus a reviewed explicit list
  of untracked operational files; `.git`, dependency/build caches, temporary
  exports, large test media, runtime data, and unrelated untracked files are
  excluded;
- the canonical `.env` and active media, RAG, TLS, provider, and archive-tool
  configuration files required to reconstruct the deployment;
- generated redacted manifests containing source roots, source labels, Git
  revision/dirty state, tool versions, backup IDs, and timestamps.

Historical `.env.backup-*` files are excluded from the canonical configuration
set. Secrets may be included only inside the encrypted restic repository and
must never appear in logs or manifests. Full local source paths and dirty-file
names also remain inside the encrypted repository; plaintext remote markers and
logs use only opaque source labels and backup IDs.

Before a file snapshot is accepted, `backupctl` reconciles every external
`source_files.path` stored in MongoDB with the resolved restic source manifest.
Missing paths, unreadable paths, and paths outside approved roots make external
original coverage incomplete and are reported explicitly. Configured mount roots
alone are not evidence that all referenced originals are protected.

### Rebuildable state

Redis/BullMQ state, Qdrant storage, RAG state, model caches, worker caches, and
Voice Memos staging are excluded. Restore starts with fresh Redis, keeps RAG
disabled until Mongo is restored, then invalidates future checkpoints and
rebuilds Qdrant/RAG from canonical Mongo data. Voice Memos staging is
republished from the verified archive through the existing interactive flow.

## Remote namespace

After authentication succeeds, preflight must inspect the remote before writing.
The intended SFTP layout is:

```text
pk-backup:mycelia/
  restic-v1/            # encrypted restic repository
  bootstrap-manifests/  # non-secret checksums and completion markers only
  logs/                 # redacted, bounded operational summaries
```

PBM uses a separate S3 bucket named for Mycelia and managed exclusively by PBM.
PBM must not share a bucket with arbitrary files or with the restic repository.
The preflight fails if the intended namespace contains an unknown repository,
the remote filesystem is too small, or the storage identity differs from the
configured identity.

## Access and secret handling

The SFTP private-key passphrase is unlocked locally through a user-visible macOS
Keychain or 1Password SSH-agent flow. The passphrase is never accepted in chat,
command-line arguments, repository files, or logs. The automated rclone remote
retains `BatchMode=yes`, strict host-key checking, and its pinned known hosts
file so scheduled jobs fail closed instead of prompting.

The restic repository password is generated randomly and stored in macOS
Keychain. Automation reads it through `RESTIC_PASSWORD_COMMAND`; it is never
stored in `.env` or a LaunchAgent plist. A separately exported recovery copy of
the restic credential is required before the repository is considered durable.

The offline recovery kit also contains the SFTP recovery identity and
passphrase, pinned host-key material, PBM/MinIO read credentials, storage
encryption keys, and the restore runbook. It is stored outside both the source
Mac and backup server and is exercised from a clean environment during the
restore drill.

PBM receives a bucket-scoped MinIO access key. The initial PBM configuration
file is created with mode `0600`, applied through `pbm config --file`, and
removed after PBM confirms a redacted configuration. MinIO administration
credentials are not reused by PBM. The main `.env` permissions are corrected to
`0600` before it is included in any snapshot.

Removing the setup YAML does not remove its values from MongoDB's
`admin.pbmConfig`; access to that collection, the PBM agent URI, and the agent
container environment is restricted and included in credential rotation and
recovery procedures. PBM's required Mongo role is privileged and must not be
described as a read-only backup role. The PBM agent and URI are isolated from
application containers. Upload/PITR, restore-read, cleanup-delete, and MinIO
administration use separate identities with only the permissions required for
their phase.

## Control surface

Add a host-side `scripts/backupctl` entry point with these commands:

- `preflight`: verify tools, Docker/Mongo health, replica-set primary, oplog
  window, local free space, resolved source roots, remote authentication, remote
  identity/capacity, namespace ownership, and lock availability;
- `bootstrap`: initialize or validate the restic repository and credential
  recovery material without overwriting an existing unknown repository;
- `mongo-bootstrap`: stream one consistent full `mongodump --archive --oplog`
  directly into restic without a local staging file;
- `mongo-full`: start a PBM logical backup, wait for completion, and write its
  backup ID and terminal state to the status manifest;
- `files`: snapshot the explicit file/config allowlist with restic;
- `status`: report independent freshness for PBM base, the latest contiguous
  remotely readable PITR restore timestamp and any gaps, file/config snapshot,
  Voice Memos archive publication, protected-copy state, and last restore drill;
- `verify`: run non-destructive PBM status/describe checks, restic repository
  checks, manifest validation, and representative remote reads;
- `retention-dry-run`: show exactly what PBM and restic would remove;
- `cleanup`: use the separately supplied delete identity to apply the reviewed
  full-backup, restic, and PITR-slice policies only when the cleanup gate is
  enabled;
- `restore-drill`: restore into a separate replica set and Compose project with
  distinct host paths, volumes, ports, and network; preserve original database
  names inside that isolated target and never use the live Mongo path.

The command uses a single-instance lock, bounded timeouts, atomic local status
files, UTC backup IDs, redacted logs, and non-zero exit status on stale or
partial results. A streamed Mongo bootstrap is accepted only if both `mongodump`
and restic finish successfully and the completed restic snapshot is subsequently
readable. Interrupted streams remain visibly failed and are never reported as
backups.

The bootstrap performs a full replica-set dump as an uncompressed
`mongodump --archive --oplog` byte stream with no TTY or non-archive output on
stdout. The wrapper captures producer and consumer exit states and verifies that
the oplog window can span the measured dump duration. Logical consistency is
validated by replaying it with `mongorestore --oplogReplay` into the isolated
target; repository readability alone is only transport verification.

## Schedule and retention

- PBM logical full: weekly, during the configured low-activity window.
- PBM PITR: continuous 10-minute oplog slices after the first complete base.
- Restic files/configuration: every six hours and on explicit operator request.
- File freshness check: after every scheduled attempt and at least hourly;
  snapshots older than six hours plus the bounded scheduling grace period are
  stale and alert independently of Mongo freshness.
- Mongo RPO check: every five minutes and after each PBM operation, alerting
  when the latest contiguous remotely readable restore timestamp is more than 15
  minutes behind wall clock or any slice gap exists.
- Full status check: daily and after every scheduled operation.
- Retention target: continuous PITR coverage for 35 days plus 12 monthly logical
  base snapshots; monthly bases older than 35 days do not imply continuous PITR.
- Restic retention target: every eligible snapshot within 35 days plus 12
  monthly snapshots. `forget --prune` is permitted only after its preview, a
  current protected copy, and the same cleanup gate used for PBM.

PBM 2.16 lifecycle policy, a separate time-bounded `pbm delete-pitr` operation,
and restic `forget` are always previewed first. PBM lifecycle cleanup alone does
not delete PITR slices. The slice cutoff must preserve the full chain required
by every retained base within the 35-day PITR window, including an anchor base
at or before the cutoff. Before and after cleanup, `pbm list` is checked for the
expected first/last restorable timestamps, coverage across the cutoff, and gaps.
Automated deletion remains disabled until there are at least two successful PBM
bases, continuous PITR coverage, one verified restic snapshot, an independent
protected copy, and a successful isolated PITR restore drill. Pruning or
deletion is never part of the initial backup run.

The 10-minute RPO applies to canonical MongoDB after PBM is active. File-source
RPO is six hours for readable always-mounted roots. New Voice Memos cannot have
an unattended RPO stronger than the last interactive, TCC-authorized archive
refresh; `status` reports this separately rather than claiming end-to-end
freshness.

## First backup flow

1. Unlock the SFTP key in a visible local terminal and prove a non-interactive
   `ssh ... true` plus `rclone lsf pk-backup:` succeeds.
2. Inspect remote capacity and existing names. Reserve the isolated `mycelia/`
   namespace only if it is unused or contains the expected marker.
3. Correct `.env` permissions, create the restic credential and recovery copy,
   and initialize `restic-v1`.
4. Run `backupctl files`, verify the snapshot and representative reads.
5. Stream `mongo-bootstrap` to restic and verify the snapshot. This supplies an
   immediate portable logical recovery point on the requested rclone remote; its
   logical validation remains pending until the isolated replay passes.
6. Install and harden MinIO on the backup server, create the dedicated PBM
   bucket and scoped credentials, and verify capacity and TLS/network scope.
7. Upgrade the Compose PBM image to 2.16, create a dedicated Mongo PBM user with
   the official required privileged roles, isolate its URI from application
   services, apply the PBM storage/PITR configuration, and confirm the agent is
   OK.
8. Run a new PBM logical full. Enable PITR only after the base completes, then
   observe at least two completed 10-minute slices.
9. Create and verify immutable/versioned protected copies of both the PBM bucket
   and restic repository using credentials unavailable to scheduled source jobs.
10. Install scheduling only after manual `files`, `mongo-full`, `status`, and
    `verify` executions succeed. Observe at least one real automatic restic run
    in the LaunchAgent's scheduled environment after a user-session restart or
    equivalent credential-context renewal. Document key/agent renewal and make
    any noninteractive-auth failure mark file coverage stale and alert.
11. Perform the isolated restore drill before enabling cleanup or calling the
    system complete.

## Restore drill

The restore target must have enough independent storage for a full logical
restore and must not reuse the live Mongo or Redis paths. If the Mac remains at
16 GiB free, the drill runs on another explicitly approved host or on isolated
storage on the backup server. It uses a read-only mirror/clone of the required
backup objects whenever PBM needs storage writes; it never writes restore
metadata, backup data, PITR data, retention changes, or cleanup operations into
the production backup bucket. Backup, PITR, retention, and cleanup remain
disabled in the drill environment.

The drill verifies:

- PBM/restic credentials and repository access from a clean environment;
- a restore to one concrete timestamp after its logical base, with canary data
  expected immediately before and after that timestamp and measured recovery lag
  from the latest protected timestamp;
- the bootstrap archive replayed with `mongorestore --oplogReplay`;
- Mongo database/collection counts and indexes;
- representative GridFS and BSON audio SHA-256 values;
- representative media records and external path/hash resolution;
- consent, audit, deletion, and cost records;
- fresh Redis behavior;
- Voice Memos archive verification and staging publication;
- application migrations, `[READY]`, `/health`, and `/readiness`;
- representative UI/audio flows;
- RAG/Qdrant rebuild and `/ready`/`/v1/status` after Mongo restoration.

At least one drill also restores a consistent PBM base plus PITR point and a
restic snapshot from the protected versions/snapshot after current objects are
made unavailable in a disposable test namespace. It verifies the keys,
version-selection metadata, and procedures required to recover after source
credentials corrupt or hide current objects; production objects are never
altered for this test.

The measured duration is recorded as the actual RTO. Same-day recovery remains a
target, not a claim, until this drill passes.

## Error handling and observability

Every stage records `not_started`, `running`, `complete`, `failed`, or `stale`
with timestamps and identifiers. Startup, listening, healthy, ready, backup
complete, remote readable, and restored are distinct states.

Preflight and backup fail closed on:

- unavailable or interactive-only SSH authentication;
- host-key mismatch;
- unrecognized remote marker or repository;
- insufficient remote or local working space;
- missing/unreadable source roots;
- non-primary replica-set state or inadequate oplog window;
- PBM agent/storage not OK;
- concurrent backup/cleanup/restore operation;
- incomplete producer/consumer stream;
- inability to perform a representative read after upload.

Notifications contain no secrets, URLs with credentials, source filenames, or
record contents. They identify only the stage, backup ID, freshness, and path to
the local redacted log.

## Implementation and test boundaries

Implementation is limited initially to dedicated backup scripts, focused tests,
Compose/PBM wiring, `.env.example`, a backup runbook, and LaunchAgent templates.
Existing dirty Voice Memos implementation files are preserved. README and
DEVELOPMENT edits must be merged carefully around the user's current changes.

Tests cover command construction, redaction, source allowlisting/exclusion,
marker and capacity failures, locking, interrupted streaming, freshness
classification, retention dry-run parsing, and refusal to target live restore
paths. Integration verification uses a small disposable Mongo database and an
isolated restic test repository before touching production data.

The system is complete only when code/config tests pass, the first requested
remote backup is readable, PBM base and PITR are current, scheduling is loaded,
one automatic run succeeds in the actual scheduled credential context, both
repositories have verified protected copies, and the isolated
PITR/protected-copy restore drills succeed. Configuration alone is not
completion.
