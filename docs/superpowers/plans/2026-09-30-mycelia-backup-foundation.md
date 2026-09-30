# Mycelia Backup Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a fail-closed `backupctl` control surface, an encrypted restic
repository at `rclone:pk-backup:mycelia/restic-v1`, a verified files/config
snapshot, and a streamed portable MongoDB bootstrap snapshot without staging a
93 GiB dump on the nearly full Mac.

**Architecture:** A Deno TypeScript CLI builds explicit source manifests,
executes fixed argv arrays through an injectable runner, writes redacted atomic
state, and delegates encryption/deduplication to restic. The Mongo bootstrap is
`mongodump --archive --oplog` executed by restic's `--stdin-from-command`, so no
completed snapshot exists if the producer fails. The first remote write is gated
on non-interactive SSH, pinned host identity, remote capacity, namespace
ownership, source coverage, and a locally verified disposable integration test.

**Tech Stack:** Deno TypeScript, `restic` 0.19+, `rclone` 1.75+, Docker Compose,
MongoDB Database Tools 100.17+, macOS Keychain, Deno tests.

**Spec:**
[`docs/superpowers/specs/2026-09-30-mycelia-incremental-backup-design.md`](../specs/2026-09-30-mycelia-incremental-backup-design.md)

**Implementation reference:**
[restic backup from stdin and raw file lists](https://restic.readthedocs.io/en/stable/040_backup.html).

**Depends on:** No later implementation plan. This plan must finish before the
PBM/PITR plan starts.

## Global Constraints

- After plan approval, commit only these plan documents, then begin
  implementation with `superpowers:using-git-worktrees`; base the isolated
  `sky/` worktree on that plan commit (whose current design parent is
  `faf17ca7`). Do not modify or stage the unrelated Voice Memos work in the
  primary checkout.
- Use `superpowers:test-driven-development` for every behavior change and
  `superpowers:verification-before-completion` before each completion claim.
- Use `apply_patch` for tracked edits. Stage only the files named by the current
  task and inspect `git diff --cached` before every commit.
- Accept `--compose-root /Users/pk/repo/mycelia` so an implementation in an
  isolated worktree can inspect the live Compose project without pretending the
  worktree is deployed.
- Do not source `.env`. Parse it with `parseEnvText` from
  `scripts/check-env.ts`, reject conflicting duplicate keys, and never print
  values.
- Never put a secret in argv, logs, state JSON, manifests, plist files, Git, or
  a remote plaintext marker. Keychain initialization is an explicit interactive
  operator step; scheduled commands only read an existing item.
- Never tar or copy `/data/db`, WiredTiger files, Redis, Qdrant, caches, Voice
  Memos staging, or unreviewed untracked files.
- Treat restic exit code `3` as a failed partial snapshot. No first-run command
  invokes `forget`, `prune`, deletion, PBM, or a live service restart.
- Stop rather than downgrade if SSH remains interactive-only, the namespace is
  unknown, capacity cannot be proved, any `source_files.path` is uncovered, or
  the Mongo oplog window cannot span the measured dump.
- Running this plan does not make the 15-minute Mongo RPO live. That claim is
  reserved for the PBM/PITR plan.

## Review Focus

- No command string is evaluated by a shell with secret-bearing input, and no
  dump/readback stream is accumulated in memory before hashing or counting.
- A producer failure cannot create an accepted Mongo bootstrap snapshot.
- Source reconciliation rejects missing, unreadable, outside-root, and symlink
  escape paths.
- State transitions and logs reveal labels/IDs only, never file names, URIs with
  credentials, env values, or record content.
- An existing unknown remote namespace or restic repository is never adopted or
  overwritten.

---

## Task 1: Create the CLI, typed command runner, and deterministic dispatch

**Files:**

- Create: `scripts/backupctl`
- Create: `scripts/backupctl.ts`
- Create: `scripts/backup/types.ts`
- Create: `scripts/backup/runner.ts`
- Test: `scripts/backup/runner.test.ts`
- Test: `scripts/backupctl.test.ts`

- [ ] Write `runner.test.ts` first. Cover argv preservation for spaces and
      metacharacters, explicit `cwd`/environment forwarding, separate
      stdout/stderr capture, timeout termination, and a non-zero child exit.
      Assert that exceeding the aggregate `maxOutputBytes` cap kills the child,
      drains both pipes, and throws a `CommandRunError` whose own enumerable
      fields are exactly the stable code and exit/timeout metadata. The runner
      does not know or persist a tool label; Task 2 adds that from a closed
      caller-supplied context. Use a temporary fixture executable; do not invoke
      a shell.

- [ ] Write `backupctl.test.ts` first. Assert that `parseCli` accepts exactly
      `preflight`, `bootstrap`, `files`, `mongo-bootstrap`, `status`, and
      `verify`; requires an absolute `--compose-root`; rejects unknown options;
      and returns exit code `64` for usage errors without echoing option values.

- [ ] Run the tests and record the expected red state:

  ```bash
  deno test --allow-read --allow-write --allow-run scripts/backup/runner.test.ts scripts/backupctl.test.ts
  ```

  Expected: module-not-found or missing-export failures for the new files.

- [ ] Implement the shared public contracts in `types.ts` exactly once:

  ```ts
  export type Stage =
    | "preflight"
    | "bootstrap"
    | "files"
    | "mongo-bootstrap";

  export type StageState =
    | "not_started"
    | "running"
    | "complete"
    | "failed"
    | "stale";

  export type BackupStatus = {
    schema: 1;
    stage: Stage;
    state: StageState;
    backupId: string;
    startedAtUtc: string;
    endedAtUtc?: string;
    snapshotId?: string;
  };

  export type CommandResult = {
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    timedOut: boolean;
  };

  export type BufferedCommandOptions = {
    timeoutMs: number;
    maxOutputBytes: number;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  };

  export type StreamingCommandOptions = {
    timeoutMs: number;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  };

  export type StreamDigest = {
    byteCount: number;
    sha256Hex: string;
  };

  export type CommandRunError = Error & {
    code: "OUTPUT_LIMIT_EXCEEDED";
    exitCode?: number;
    timedOut: boolean;
  };

  export interface Runner {
    run(
      argv: readonly string[],
      options: BufferedCommandOptions,
    ): Promise<CommandResult>;
    spawn(
      argv: readonly string[],
      options: StreamingCommandOptions,
    ): RunningCommand;
  }

  export type RunningCommand = {
    stdin: WritableStream<Uint8Array> | null;
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
    status: Promise<{ code: number; timedOut: boolean }>;
    kill: () => void;
  };

  export function hashAndCountStream(
    stream: ReadableStream<Uint8Array>,
  ): Promise<StreamDigest>;

  export function collectBoundedStream(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<Uint8Array>;
  ```

- [ ] Implement `Deno.Command` execution in `runner.ts`. Require a non-empty
      argv array, pass `argv[0]` as the executable and `argv.slice(1)` as
      `args`, pass only the explicitly supplied `cwd` and environment overlay,
      pipe stdout/stderr, kill on the injected timeout, and never concatenate
      argv into a shell command or exception. `run` consumes stdout and stderr
      concurrently, enforces one aggregate positive byte bound, kills and drains
      the child on overflow, and surfaces the stable `OUTPUT_LIMIT_EXCEEDED`
      code without embedding captured bytes in an error. `spawn` exposes the
      child's backpressured Web Streams and never buffers them implicitly; its
      caller must consume stdout and stderr concurrently before awaiting final
      status. Implement `hashAndCountStream` with incremental `node:crypto`
      SHA-256 updates and a numeric byte counter, and implement
      `collectBoundedStream` without concatenating beyond its bound.

- [ ] Add two streaming tests without constructing an archive-sized value. A
      synthetic `ReadableStream` generates a deterministic 64 MiB sequence in
      fixed-size chunks with `highWaterMark: 1`; instrument `pull` while a
      delayed transform feeds `hashAndCountStream`, and assert the producer
      never has more than the configured queue plus one in-flight chunk. A
      child-process fixture emits that same sequence on stdout while writing a
      small stderr record; consume both pipes concurrently with `Promise.all`,
      then assert the known byte count/digest, bounded stderr, and successful
      status. A third fixture never finishes: let the runner timeout kill it
      while both consumers remain active, then assert a timed-out status and
      closed streams without retained chunk arrays. These fixtures exercise the
      same path used for the approximately 93 GiB Mongo archive readback.

- [ ] Implement `parseCli` and dependency-injected dispatch in `backupctl.ts`.
      Keep `main()` behind `if (import.meta.main)` so tests can import it. The
      shell launcher resolves its own repository root and executes:

  ```sh
  exec deno run --allow-read --allow-write --allow-run --allow-env --allow-sys \
    "$SCRIPT_DIR/backupctl.ts" "$@"
  ```

- [ ] Run the focused tests, then type-check:

  ```bash
  deno test --allow-read --allow-write --allow-run scripts/backup/runner.test.ts scripts/backupctl.test.ts
  deno check scripts/backupctl.ts
  ```

  Expected: all tests pass and `Check scripts/backupctl.ts` succeeds.

- [ ] Commit only this task:

  ```bash
  git add scripts/backupctl scripts/backupctl.ts scripts/backup/types.ts scripts/backup/runner.ts scripts/backup/runner.test.ts scripts/backupctl.test.ts
  git commit -m "feat(backup): scaffold fail-closed backupctl"
  ```

## Task 2: Add secret-safe configuration, redaction, lock, and atomic state

**Files:**

- Create: `.env.backup.example`
- Modify: `.gitignore`
- Create: `scripts/backup/config.ts`
- Create: `scripts/backup/redact.ts`
- Create: `scripts/backup/state.ts`
- Modify: `scripts/backup/types.ts`
- Test: `scripts/backup/config.test.ts`
- Test: `scripts/backup/redact.test.ts`
- Test: `scripts/backup/state.test.ts`

- [ ] Write failing configuration tests for these required, non-secret values:
      `BACKUP_RCLONE_REMOTE=pk-backup:`, `BACKUP_REMOTE_ROOT=pk-backup:mycelia`,
      `BACKUP_RESTIC_REPOSITORY=rclone:pk-backup:mycelia/restic-v1`,
      `BACKUP_RESTIC_KEYCHAIN_SERVICE=tech.mycelia.backup.restic`,
      `BACKUP_RESTIC_KEYCHAIN_ACCOUNT=mycelia`, `BACKUP_REMOTE_MIN_FREE_BYTES`,
      and `BACKUP_OPERATIONAL_UNTRACKED_JSON`. Assert that `.env` and
      `.env.backup` conflicting duplicates fail before any command runs.

- [ ] Write failing redaction tests with passwords, percent-encoded Mongo URIs,
      AWS-style access keys, full local paths, rclone URLs, multiline stderr, an
      arbitrary exception message/cause, and unexpected enumerable fields.
      Serialize the returned failure through the real state writer and capture
      both JSON and human CLI rendering. Assert recursively that the output has
      exactly the closed schema's keys and contains only a registered failure
      code, stage, backup ID, timestamp, opaque source label, bounded tool name,
      exit/timeout metadata, and numeric counters. Assert every supplied raw
      string and unknown field is absent.

- [ ] Write failing state tests for an atomic mode-`0600` JSON replacement,
      recursive rejection of unknown fields and unregistered failure codes,
      `running -> complete|failed` transitions, refusal to mark a snapshot
      complete without a snapshot ID, and lock refusal while another valid lock
      file exists. Lock removal occurs in `finally`; stale locks are reported
      and require the explicit `--clear-stale-lock <pid>` operator action.

- [ ] Run the tests and confirm missing implementations fail:

  ```bash
  deno test --allow-read --allow-write --allow-env scripts/backup/{config,redact,state}.test.ts
  ```

- [ ] Implement `loadBackupConfig(repoRoot, homeDir)` using exported
      `parseEnvText`. Merge non-secret `.env.backup` values over safe defaults
      and read application path settings from `.env`; reject malformed or
      conflicting assignments. Return a typed object, never the raw parsed
      files.

- [ ] Add `.env.backup` and backup state/temp patterns to `.gitignore`; keep
      `.env.backup.example` tracked. The example documents values and labels but
      contains no credential, access key, passphrase, private host path, or
      enabled deletion setting.

- [ ] Implement `redactError(error, context)` as an allowlist constructor rather
      than a regex-only scrubber. It returns a closed `PersistedFailure` object;
      state JSON and the JSON/human CLI renderer may consume only that object.
      Persist only registered failure code, stage, bounded tool label,
      exit/timeout state, backup ID, UTC timestamp, opaque source label, and
      fixed-name numeric counters. Raw stdout/stderr, unknown object fields,
      file names, record content, URIs, arbitrary exception message/stack/cause,
      and argv/env never enter the returned object and are discarded after the
      bounded volatile buffer is parsed. Secret/path substitution is defense in
      depth, not permission to persist diagnostics. Phase 1 creates no free-form
      persistent log; any future event log must serialize this same closed
      object. Reject a serialized record over 8 KiB instead of truncating raw
      text into it.

  ```ts
  export const FAILURE_CODES = [
    "USAGE_ERROR",
    "OUTPUT_LIMIT_EXCEEDED",
    "COMMAND_TIMEOUT",
    "COMMAND_FAILED",
    "CONFIG_INVALID",
    "LOCK_HELD",
    "STALE_LOCK",
    "STATE_INVALID",
    "SOURCE_COVERAGE_INCOMPLETE",
    "SSH_NONINTERACTIVE_REQUIRED",
    "HOST_KEY_MISMATCH",
    "REMOTE_CAPACITY_UNKNOWN",
    "REMOTE_CAPACITY_LOW",
    "REMOTE_NAMESPACE_UNKNOWN",
    "MONGO_NOT_PRIMARY",
    "OPLOG_WINDOW_SHORT",
    "VISIBLE_TTY_REQUIRED",
    "KEYCHAIN_ITEM_MISSING",
    "RECOVERY_RECEIPT_MISSING",
    "REPOSITORY_ID_MISMATCH",
    "RESTIC_INIT_FAILED",
    "RESTIC_VERIFY_FAILED",
    "MONGO_BOOTSTRAP_FAILED",
  ] as const;

  export type FailureCode = (typeof FAILURE_CODES)[number];
  export type ToolLabel =
    | "backupctl"
    | "filesystem"
    | "git"
    | "security"
    | "ssh"
    | "rclone"
    | "restic"
    | "docker"
    | "mongosh"
    | "mongodump"
    | "mongorestore";

  export type PersistedCounters = {
    files?: number;
    bytes?: number;
    total?: number;
    covered?: number;
    missing?: number;
    unreadable?: number;
    outsideRoots?: number;
    invalid?: number;
  };

  export type PersistedFailure = {
    schema: 1;
    code: FailureCode;
    stage: Stage;
    backupId: string;
    timestampUtc: string;
    tool: ToolLabel;
    exitCode?: number;
    timedOut: boolean;
    sourceLabel?:
      | "tracked-config"
      | "operational-config"
      | "media"
      | "voice-memos-archive"
      | "mongo-bootstrap";
    counters?: PersistedCounters;
  };
  ```

  Add these contracts to `types.ts` and extend `BackupStatus` only with
  `failure?: PersistedFailure` and `sourceCounts?: PersistedCounters`. Keep the
  failure-code tuple and tool/source-label unions as the sole registries; later
  tasks must edit those registries and their schema tests before emitting a new
  value.

- [ ] Implement `withLock`, `writeStateAtomic`, and `readState`. Create temp
      files beside the target with mode `0600`, write and `fsync`, rename, and
      `fsync` the directory. The lock JSON stores PID, process start timestamp,
      command, and backup ID but no paths or argv.

- [ ] Run tests and inspect the example for accidental secret-shaped values:

  ```bash
  deno test --allow-read --allow-write --allow-env scripts/backup/{config,redact,state}.test.ts
  rg -n '(password|secret|token|private.key)=' .env.backup.example
  ```

  Expected: tests pass; the scan returns no active assignment containing those
  names.

- [ ] Commit:

  ```bash
  git add .env.backup.example .gitignore scripts/backup/types.ts scripts/backup/config.ts scripts/backup/redact.ts scripts/backup/state.ts scripts/backup/config.test.ts scripts/backup/redact.test.ts scripts/backup/state.test.ts
  git commit -m "feat(backup): add secure config and atomic state"
  ```

## Task 3: Build the explicit file manifest and reconcile Mongo source paths

**Files:**

- Create: `scripts/backup/sources.ts`
- Create: `scripts/backup/mongo.ts`
- Test: `scripts/backup/sources.test.ts`
- Test: `scripts/backup/mongo.test.ts`

- [ ] Write failing source tests using a temporary Git repository. Cover tracked
      files, a reviewed explicit untracked allowlist, configured media roots,
      the default Voice Memos archive root `/Volumes/TM_data/iCloudArchive`, and
      `/Users/pk/Pictures/Mycelia-Import` only when present. Verify exclusion of
      `.git`, `.env.backup-*`, dependency/build caches, Qdrant, Redis, Mongo
      data, model caches, test media, and Voice Memos staging.

- [ ] Add failing protected-config tests for the canonical `.env`, active media
      and RAG env files, active TLS certificate/private-key paths, rclone config
      and pinned known-host material, provider configuration, active Mongo
      replica-set keyfile, dedicated PBM env/CA, and the effective
      `ICLOUD_ARCHIVE_CONFIG`. A configured active path that is missing or
      unreadable makes the manifest incomplete; an inactive optional deployment
      does not.

- [ ] Add failing path-safety cases for a symlink escaping an allowed root,
      duplicate canonical paths, an unreadable file, a vanished file, a relative
      Mongo path, an outside-root Mongo path, and a valid file beneath an
      allowed root.

- [ ] Add Voice Memos mapping cases. A Mongo path beneath the excluded staging
      audio root is covered only when the mode-`0600` publication receipt's
      canonical `published_audio_root` and `archive_audio_root` match the active
      configuration, the same safe relative path exists in the verified archive,
      and current size/SHA-256 matches the staged file. Reject stale/mismatched
      receipts, unsafe relative paths, missing archive files, and hash changes.

- [ ] Write failing Mongo command tests. The query must target `DATABASE_NAME`,
      select documents where `path` exists, project only `_id` and `path`, emit
      one Extended JSON record per line, use
      `docker compose --project-directory <composeRoot> exec -T mongo mongosh`,
      and never put a credential in argv. Reject malformed JSON, a selected
      document whose `path` is absent/non-string/blank, duplicate IDs with
      different paths, and non-zero exit. Documents with no `path` field are not
      external-file claims and are excluded by the query.

- [ ] Cover both known authorization states. When authorization is disabled,
      query locally without credentials. When it is enabled, a fixed JavaScript
      file authenticates from container environment before querying. Never try
      anonymous access as a fallback after the preflight reports auth enabled,
      and never place the URI or password in argv/output.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run scripts/backup/{sources,mongo}.test.ts
  ```

- [ ] Implement this coverage contract:

  ```ts
  export type Coverage = {
    total: number;
    covered: number;
    missing: number;
    unreadable: number;
    outsideRoots: number;
    invalid: number;
    complete: boolean;
  };

  export type SourceManifest = {
    backupId: string;
    labels: Array<{ label: string; canonicalRoot: string }>;
    files: string[];
    coverage: Coverage;
  };
  ```

- [ ] Resolve every root and candidate with `realPath`; use component-aware
      containment instead of string prefixes. Read tracked paths from
      `git -C <root> ls-files -z`. Accept untracked operational paths only from
      the JSON array in `.env.backup`. Sort and deduplicate the final canonical
      paths.

- [ ] Implement `readMongoSourcePaths` and `reconcileSourcePaths`. An empty
      result is valid only when Mongo confirms that the filtered count of
      documents with a `path` field is zero. Do not log the returned paths or
      IDs. Write an encrypted-in-repository manifest later; plaintext state
      receives only the numeric `Coverage` object and opaque labels.

- [ ] Implement the staging-to-archive resolver before the general containment
      check. Record the archive canonical path in the encrypted manifest and an
      opaque `voice-memos-archive` label in plaintext state; never add the
      staging copy itself to restic. Resolve the protected-config list through
      the same path/symlink/readability safeguards as media roots.

- [ ] Pass tests and add a property-style table test covering trailing slashes,
      Unicode, spaces, and prefix-collision roots such as `/media/a` vs
      `/media/ab`:

  ```bash
  deno test --allow-read --allow-write --allow-run scripts/backup/{sources,mongo}.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/sources.ts scripts/backup/mongo.ts scripts/backup/sources.test.ts scripts/backup/mongo.test.ts
  git commit -m "feat(backup): verify explicit source coverage"
  ```

## Task 4: Implement local and remote preflight without writes

**Files:**

- Create: `scripts/backup/preflight.ts`
- Create: `scripts/backup/remote.ts`
- Test: `scripts/backup/preflight.test.ts`
- Test: `scripts/backup/remote.test.ts`
- Modify: `scripts/backupctl.ts`

- [ ] Write failing preflight tests for missing/wrong tool versions, `.env` mode
      other than `0600`, low local temp space, unhealthy Mongo, no replica-set
      primary, too-short oplog window, incomplete source coverage, held lock,
      and a clean pass. Version gates are restic `>=0.19.0`, rclone `>=1.75.0`,
      PBM not required, and mongodump `>=100.17.0` inside the container.

- [ ] Write failing remote tests for `rclone lsf pk-backup:` authentication
      failure, host-key mismatch, `rclone about --json` unsupported/unknown
      capacity, free bytes below `BACKUP_REMOTE_MIN_FREE_BYTES`, absent
      namespace, an empty namespace, the exact owned marker, a malformed marker,
      and any unknown entry. This task is read-only: even an empty namespace is
      only reported as reservable.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{preflight,remote}.test.ts
  ```

- [ ] Implement ordered checks with stable codes such as
      `SSH_NONINTERACTIVE_REQUIRED`, `HOST_KEY_MISMATCH`,
      `REMOTE_CAPACITY_UNKNOWN`, `REMOTE_CAPACITY_LOW`,
      `REMOTE_NAMESPACE_UNKNOWN`, `MONGO_NOT_PRIMARY`, `OPLOG_WINDOW_SHORT`, and
      `SOURCE_COVERAGE_INCOMPLETE`. A failure ends the command before the next
      mutating stage.

- [ ] Compute the minimum remote free-space gate as the configured floor plus
      the measured size of eligible file roots and Mongo `dbStats.totalSize`,
      with 25% stream/repository headroom. `rclone about` free space must be at
      least the greater of that result and `BACKUP_REMOTE_MIN_FREE_BYTES`. If
      SFTP cannot report capacity, fail and require a separately verified value
      from the remote server; never interpret unknown as unlimited.

- [ ] Add `preflight` dispatch. Its JSON output contains booleans, numeric
      sizes, versions, backup ID, and failure codes only. Human output may name
      tool/stage but not source paths, remote URLs beyond the configured remote
      name, or Mongo records.

- [ ] Run tests and a local-only preflight fixture. Do not contact `pk-backup:`
      yet:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/{preflight,remote}.test.ts
  ./scripts/backupctl preflight --compose-root /Users/pk/repo/mycelia --remote-mode skip --json
  ```

  Expected: tests pass; the fixture/local report is valid JSON and explicitly
  says `remoteVerified: false`.

- [ ] Commit:

  ```bash
  git add scripts/backup/preflight.ts scripts/backup/remote.ts scripts/backup/preflight.test.ts scripts/backup/remote.test.ts scripts/backupctl.ts
  git commit -m "feat(backup): add read-only backup preflight"
  ```

## Task 5: Initialize Keychain-backed restic safely and reserve the namespace

**Files:**

- Create: `scripts/restic-password-command`
- Create: `scripts/backup/restic.ts`
- Test: `scripts/backup/restic.test.ts`
- Modify: `scripts/backupctl.ts`
- Create: `docs/BACKUP.md`

- [ ] Write failing tests for Keychain-item absence, successful password-command
      lookup, known-empty remote namespace, exact marker ownership, unknown
      marker, already-initialized expected restic repository, wrong repository
      ID, failed `restic init`, and post-init `snapshots --json` validation.
      Fake `security`, `rclone`, and `restic`; tests must never touch the real
      Keychain or remote.

- [ ] Assert the constructed environment contains
      `RESTIC_PASSWORD_COMMAND=<absolute scripts/restic-password-command>` and
      `RESTIC_REPOSITORY=rclone:pk-backup:mycelia/restic-v1`, while argv and
      diagnostics contain neither password nor repository credential material.

- [ ] Run the red test:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restic.test.ts
  ```

- [ ] Implement `scripts/restic-password-command` as a Deno executable with a
      restrictive shebang. Import `parseEnvText`, read the non-secret
      account/service from `.env.backup`, reject duplicates, and invoke
      `/usr/bin/security` through `Deno.Command` with the fixed argv
      `find-generic-password -w -a <account> -s <service>`. Emit only the
      password bytes to stdout; do not use a shell or emit diagnostic values.

- [ ] Implement `bootstrap` as three explicit modes:

  1. `--check` verifies that the Keychain item, recovery-copy receipt, namespace
     marker, and repository ID exist and match; it initializes nothing.
  2. `--initialize-keychain` requires an interactive visible TTY, generates a
     random password with the OS CSPRNG, and starts
     `security add-generic-password -U -a mycelia -s
     tech.mycelia.backup.restic -w`
     with `-w` last. Stream the generated bytes to the prompt's stdin so the
     password is absent from argv and output. First prove this behavior against
     a disposable keychain in an automated test. The operator retrieves the item
     through the user-visible Keychain Access flow, stores the offline recovery
     copy, and records only its non-secret receipt ID.
  3. `--initialize-repository` requires a complete full preflight, the Keychain
     item, and the recovery receipt; it alone may reserve the namespace and run
     `restic init`.

  Automation and Codex private PTYs must refuse `--initialize-keychain` with
  `VISIBLE_TTY_REQUIRED`.

- [ ] After a passing full preflight, reserve an empty `mycelia/` namespace with
      one marker containing schema, opaque installation UUID, created-at UTC,
      and intended child names. Re-read and compare the marker before
      `restic init`. On retry, accept only the same installation UUID saved in
      mode-`0600` local state.

- [ ] Initialize only `restic-v1`, capture its repository ID from `cat config`
      through restic-supported output, save only that ID locally, and verify
      `restic snapshots --json`. Never run init when any unknown entry exists.

- [ ] Add the initial `docs/BACKUP.md` with the exact visible-Terminal SSH and
      Keychain prerequisites, distinctions between configured/uploaded/readable/
      restored, and the statement that cleanup is disabled. Do not duplicate a
      passphrase or callback URL in the document.

- [ ] Pass tests, type checks, and shell syntax checks:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/restic.test.ts
  deno check scripts/restic-password-command
  sh -n scripts/backupctl
  ```

- [ ] Commit:

  ```bash
  git add scripts/restic-password-command scripts/backup/restic.ts scripts/backup/restic.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): bootstrap encrypted restic repository"
  ```

## Task 6: Create and verify the file/config snapshot

**Files:**

- Create: `scripts/backup/files.ts`
- Test: `scripts/backup/files.test.ts`
- Test: `scripts/backup/files.integration.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing tests that create a NUL-delimited mode-`0600` manifest and
      invoke `restic --json backup --files-from-raw <manifest>`. Cover exit `0`,
      exit `3`, malformed JSON, no summary/snapshot ID, source mutation, failed
      `snapshots --json`, failed `check --read-data-subset=1/100`, and failed
      representative `dump` readback.

- [ ] Assert the encrypted snapshot includes `.env`, active configuration,
      generated full source manifest, Git revision/dirty state, tool versions,
      and source labels. Assert plaintext state contains only counts and IDs.

- [ ] Run the red test:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/files.test.ts
  ```

- [ ] Implement `runFilesBackup`. Re-run source reconciliation immediately
      before backup, write the raw manifest to the protected local state
      directory, call restic with `--tag mycelia-files` and
      `--tag backup-id=<UTC-ID>`, parse the final JSON summary, and reject every
      exit other than zero.

- [ ] Verify the exact snapshot ID with `restic snapshots --json`, a bounded
      `restic check --read-data-subset=1/100`, and `restic dump` of the
      generated manifest plus one deterministic small tracked file. Use
      `Runner.spawn`, consume stdout with `hashAndCountStream`, and drain stderr
      concurrently with `collectBoundedStream`; never call the buffered
      `Runner.run` for a file-content read. Remove the temporary raw manifest in
      `finally` but retain the encrypted copy inside the snapshot.

- [ ] Write `complete` state only after all reads pass. If any stage fails,
      persist `failed` with a stable code and leave the unaccepted snapshot
      visible for operator inspection; do not delete or prune it.

- [ ] Pass tests, then run a disposable local integration repository with paths
      containing spaces and Unicode:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/files.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/files.integration.test.ts
  ```

  Create `files.integration.test.ts` in this task. Expected: one snapshot and
  byte-identical `restic dump` output; no real rclone remote is used.

- [ ] Commit:

  ```bash
  git add scripts/backup/files.ts scripts/backup/files.test.ts scripts/backup/files.integration.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): snapshot and verify protected files"
  ```

## Task 7: Stream a portable Mongo bootstrap into restic

**Files:**

- Modify: `scripts/backup/mongo.ts`
- Create: `scripts/backup/mongo_bootstrap.ts`
- Create: `scripts/backup/status.ts`
- Test: `scripts/backup/mongo_bootstrap.test.ts`
- Test: `scripts/backup/mongo_bootstrap.integration.test.ts`
- Test: `scripts/backup/status.test.ts`
- Modify: `scripts/backupctl.ts`
- Modify: `docs/BACKUP.md`

- [ ] Write failing argv tests for this structure:

  ```text
  restic --json backup --stdin-from-command
    --stdin-filename mongo-bootstrap/<backup-id>.archive
    --tag mycelia-mongo-bootstrap
    --tag backup-id=<backup-id>
    -- docker compose --project-directory <compose-root>
       exec -T mongo sh -ceu <fixed-container-script>
  ```

  The fixed script runs `mongodump --archive --oplog` for the whole replica set,
  sends archive bytes only to stdout, and sends diagnostics to stderr. It never
  combines `--oplog` with `--db` or `--gzip`.

- [ ] Add failing cases for producer exit non-zero, restic exit non-zero,
      timeout, malformed restic JSON, missing snapshot ID, no primary, oplog
      window shorter than the previous dump duration plus 25%, and unreadable
      snapshot. Assert that the backup command uses bounded `Runner.run` only
      for restic's JSON/diagnostic output: the archive bytes travel directly
      from the producer that restic supervises and never enter that buffer. In
      the producer-failure case, inject multiline stderr containing a fake URI,
      secret, path, and arbitrary prose; assert both persisted state and CLI
      output contain only `MONGO_BOOTSTRAP_FAILED` plus the closed metadata.

- [ ] Add an auth-enabled command test. The fixed container script writes a
      Mongo tools config into `/dev/shm` from container environment, applies
      mode `0600`, traps its removal, and passes only the config path to
      `mongodump`. Assert username/password/URI are absent from host argv and
      logs.

- [ ] Add failing `status.test.ts` cases for no state, running, failed,
      complete, unreadable-after-complete, and redaction. Assert Phase 1 cannot
      report the overall system current or claim the 15-minute RPO.

- [ ] Run the red tests:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/mongo_bootstrap.test.ts scripts/backup/status.test.ts
  ```

- [ ] Implement `runMongoBootstrap` with a preflight snapshot of replica-set
      primary, oplog first/last timestamps, database size, and start time. Let
      restic supervise the producer with `--stdin-from-command`; do not insert a
      shell pipe between mongodump and restic. Execute restic with
      `Runner.run(resticArgv, { timeoutMs, maxOutputBytes: 16 * 1024 * 1024,
      env })`
      so only bounded restic JSON/stderr is captured while the approximately 93
      GiB archive remains a direct producer-to-restic stream. Parse the JSON,
      map failure to the closed `PersistedFailure` schema, then discard captured
      raw bytes.

- [ ] On success, parse the snapshot ID, record dump duration, repeat the oplog
      window measurement, and require `restic snapshots --json` plus a complete
      read of the archive through `restic dump` via `Runner.spawn` into an
      incremental byte-count/SHA-256 sink with backpressure and no archive-sized
      buffer. Consume stdout with `hashAndCountStream` and concurrently drain
      stderr with `collectBoundedStream(..., 256 * 1024)` before awaiting child
      status. If either consumer fails or hits its bound, kill the child, await
      closure of both streams, persist only the registered failure summary, and
      discard raw diagnostics. Record only the byte count and digest in the
      verification receipt. Mark this as `transportVerified: true` and
      `logicalReplayVerified: false`; only the isolated restore plan may flip
      the latter field.

- [ ] Implement the Phase 1 `status` and `verify` handlers. `status` reports the
      accepted files and Mongo-bootstrap snapshot IDs, UTC times, transport/
      coverage/readback states, and explicitly reports PBM/PITR, protected copy,
      scheduling, and restore drill as `not_configured`. `verify --stage files`
      and `verify --stage mongo-bootstrap` rerun the same non-destructive reads
      used for acceptance; neither handler upgrades logical replay to verified.

- [ ] Add a disposable integration test using a temporary one-node replica set
      with a canary write during dump. Restore the archive to a second
      disposable Mongo instance using `mongorestore --archive --oplogReplay`,
      then assert the pre-dump canary exists and both processes exited zero.
      Skip with an explicit reason only when Docker is unavailable.

- [ ] Run unit and integration verification:

  ```bash
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/mongo_bootstrap.test.ts scripts/backup/status.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/mongo_bootstrap.integration.test.ts
  ```

- [ ] Commit:

  ```bash
  git add scripts/backup/mongo.ts scripts/backup/mongo_bootstrap.ts scripts/backup/status.ts scripts/backup/mongo_bootstrap.test.ts scripts/backup/mongo_bootstrap.integration.test.ts scripts/backup/status.test.ts scripts/backupctl.ts docs/BACKUP.md
  git commit -m "feat(backup): stream Mongo bootstrap into restic"
  ```

## Task 8: Complete documentation and project consistency checks

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/BACKUP.md`
- Test: `scripts/check-env.test.ts`

- [ ] Invoke the `post-change-checks` skill before editing documentation.
      Re-read the dirty primary-checkout README/DEVELOPMENT hunks, then port
      only backup links and verified commands into the isolated worktree. Do not
      replace or squash the user's Voice Memos documentation.

- [ ] Add only non-secret backup path/documentation variables to `.env.example`.
      Remove the obsolete PBM filesystem-backup instructions; link PBM details
      to the second plan and keep the default profile disabled.

- [ ] Add a compact README link to `docs/BACKUP.md`. Document in DEVELOPMENT
      that host-side source changes need no application restart, while later
      Mongo auth/PBM Compose changes require targeted service recreation and the
      full readiness procedure.

- [ ] Extend `check-env.test.ts` so backup examples remain optional and the
      primary `.env` audit never requires Keychain or MinIO secrets.

- [ ] Run formatting, documentation, environment, and focused backup tests:

  ```bash
  deno fmt --check scripts/backupctl.ts scripts/backup/*.ts scripts/check-env.test.ts
  deno test --allow-read --allow-write --allow-run --allow-env scripts/backupctl.test.ts scripts/backup/*.test.ts scripts/check-env.test.ts
  ./scripts/check-env.sh --all
  git diff --check
  ```

  Expected: formatting and tests pass; env contracts report no new errors; diff
  check is empty.

- [ ] Commit the documentation boundary separately:

  ```bash
  git add .env.example README.md DEVELOPMENT.md docs/BACKUP.md scripts/check-env.test.ts
  git commit -m "docs(backup): document restic bootstrap workflow"
  ```

## Task 9: Run the first real backup to `pk-backup:` and capture evidence

**Files:**

- Runtime state only: `~/Library/Application Support/Mycelia/Backup/`
- Remote objects only: `pk-backup:mycelia/restic-v1/` and owned marker/log paths
- No tracked code change unless verification exposes a reproducible defect

- [ ] In the user-visible macOS Terminal, complete the SSH/Keychain steps from
      `docs/BACKUP.md`. Because Codex's command PTY is private, do not request
      the key passphrase or callback text in chat. The user reports only the
      exit status of:

  ```bash
  ssh -o BatchMode=yes -p 22126 pk@77.51.198.164 true
  rclone lsf pk-backup:
  ```

  Expected: both exit `0` without prompting.

- [ ] From that same visible terminal, initialize the restic Keychain item with
      `./scripts/backupctl bootstrap --initialize-keychain --compose-root
  /Users/pk/repo/mycelia`,
      export its recovery credential to the approved offline kit, and record
      only the non-secret receipt ID.

- [ ] Run the non-mutating gate and save the redacted output:

  ```bash
  ./scripts/backupctl preflight --compose-root /Users/pk/repo/mycelia --json
  ```

  Expected: `ok: true`, `remoteVerified: true`, `sourceCoverage.complete: true`,
  a primary replica set, a sufficient oplog window, sufficient capacity, and an
  empty or exactly owned namespace. If `.env` is not `0600`, change only its
  mode to `0600` and rerun.

- [ ] Reserve the namespace, initialize restic, then validate both:

  ```bash
  ./scripts/backupctl bootstrap --initialize-repository --compose-root /Users/pk/repo/mycelia
  ./scripts/backupctl bootstrap --check --compose-root /Users/pk/repo/mycelia
  ```

  Expected: one owned marker, one repository ID, and readable empty snapshots.

- [ ] Create and verify the files/config snapshot:

  ```bash
  ./scripts/backupctl files --compose-root /Users/pk/repo/mycelia
  ./scripts/backupctl verify --compose-root /Users/pk/repo/mycelia --stage files
  ```

  Expected: a complete snapshot ID, complete source coverage, and successful
  representative remote reads.

- [ ] Stream and verify the one-time Mongo bootstrap:

  ```bash
  ./scripts/backupctl mongo-bootstrap --compose-root /Users/pk/repo/mycelia
  ./scripts/backupctl verify --compose-root /Users/pk/repo/mycelia --stage mongo-bootstrap
  ```

  Expected: complete snapshot ID, producer and consumer exit zero, readable full
  archive, adequate oplog window, `transportVerified: true`, and
  `logicalReplayVerified: false` pending the isolated drill.

- [ ] Run final read-only repository evidence:

  ```bash
  ./scripts/backupctl status --compose-root /Users/pk/repo/mycelia --json
  restic snapshots --json
  rclone lsf pk-backup:mycelia --max-depth 2
  ```

  Expected: one accepted files snapshot and one accepted Mongo-bootstrap
  snapshot. Report snapshot IDs, UTC times, byte counts, and verification states
  only. Do not paste repository passwords, file lists, Mongo paths, or content.

- [ ] Stop this plan if any remote assertion fails. Preserve failed state and
      objects for diagnosis; do not retry initialization against an unknown
      namespace and do not delete partial remote data.

## Phase 1 Completion Gate

Phase 1 is complete only when all tests pass, SSH/rclone are non-interactive in
the scheduled user context, the remote namespace and capacity are proven, the
files snapshot is remotely readable with complete `source_files.path` coverage,
and the Mongo bootstrap is remotely readable. A logical Mongo replay and the
15-minute RPO remain explicitly incomplete until the later plans pass.
