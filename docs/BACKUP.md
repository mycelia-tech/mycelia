# Mycelia encrypted file backups

This runbook prepares the Keychain credential, reserves the remote
`pk-backup:mycelia` namespace, and creates incremental file/config snapshots
with restic. Mongo bootstrap/PITR and unattended schedules remain pending; a
files snapshot alone is not a complete database backup. Run every confirmation
step below in a normal, independently visible Terminal window. A Codex PTY,
redirected input, or an environment flag is not an operator confirmation.

The commands deliberately never print the restic password. Do not paste that
password, an SSH passphrase, or any authentication callback into this file,
shell history, logs, or chat.

Use Deno 2.9 or later (verified with 2.9.5). The host wrapper resolves Deno
through the same reviewed tool path used for backup subprocesses, not the
ambient shell PATH, and checks synchronous file-lock support before loading
the controller. A separate older installation in `~/.deno/bin` is not used.

## 1. Fix local SSH permissions and key access

Set the checkout once in the visible Terminal:

```sh
ROOT="$HOME/repo/mycelia"
cd "$ROOT"
```

The bootstrap accepts one concrete legacy private key, `~/.ssh/id_rsa`, and
owned regular mode-`0600` config, key, and known-hosts files. Repair only these
known paths:

```sh
/usr/bin/install -d -m 700 "$HOME/.ssh"
/bin/chmod 600 "$HOME/.ssh/id_rsa"
/bin/chmod 600 "$HOME/.ssh/config"
/bin/chmod 600 "$HOME/.ssh/known_hosts"
```

If `id_rsa` does not exist, create or obtain the intended key in the visible
Terminal. Do not copy a private key through chat. For a newly generated RSA key:

```sh
/usr/bin/ssh-keygen -t rsa -b 4096 -f "$HOME/.ssh/id_rsa"
/usr/bin/ssh-add --apple-use-keychain "$HOME/.ssh/id_rsa"
```

The second command may request the key passphrase in Terminal. If the server
still reports `Permission denied (publickey)`, the server administrator must add
the matching **public** key to user `pk`'s `~/.ssh/authorized_keys`; server-side
`~/.ssh` should be mode `0700` and `authorized_keys` mode `0600`. Never send the
private `id_rsa` file.

The exact local SSH stanza must set every reviewed value before any later
`Host *` stanza:

```sshconfig
Host pk_backup
    HostName 77.51.198.164
    Port 22126
    User pk
    IdentityFile ~/.ssh/id_rsa
    IdentitiesOnly yes
    IdentityAgent none
    UseKeychain yes
    StrictHostKeyChecking yes
```

`Include`, `Match`, proxy/local/remote commands, a second identity, and an
earlier matching wildcard are rejected. A global `AddKeysToAgent yes` is
allowed. The rclone `[pk-backup]` section must use the reviewed external
`/usr/bin/ssh -F <absolute-config>` command, the same absolute known-hosts file,
`shell_type = unix`, `md5sum_command = md5sum`, and `sha1sum_command = sha1sum`.
Its config file must also be owned, regular, and mode `0600`. Run
`rclone config file` to confirm that the path is exactly
`$HOME/.config/rclone/rclone.conf`; an ancestor such as `~/.config` may be a
dotfiles symlink. Both the selected path and resolved target are pinned, and a
retargeted ancestor is rejected during the run. The config file itself cannot be
a symlink. Custom config locations and inherited `RCLONE_CONFIG` overrides are
rejected. Use literal absolute paths in the config, not `$HOME` placeholders.
Bootstrap pins that canonical file's inode, size, and SHA-256 before the first
rclone or restic child and rechecks them before every later child. Replacing or
editing the file during bootstrap stops the operation.

The section has this exact shape. Replace both `/ABSOLUTE/HOME` placeholders
with the literal value printed by `printf '%s\n' "$HOME"` before saving:

```ini
[pk-backup]
type = sftp
ssh = /usr/bin/ssh -F /ABSOLUTE/HOME/.ssh/config -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/ABSOLUTE/HOME/.ssh/known_hosts -o ConnectTimeout=12 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 pk_backup
known_hosts_file = /ABSOLUTE/HOME/.ssh/known_hosts
shell_type = unix
md5sum_command = md5sum
sha1sum_command = sha1sum
```

Check the pinned host entry without changing it:

```sh
/usr/bin/ssh-keygen -F '[77.51.198.164]:22126' -f "$HOME/.ssh/known_hosts"
```

If the entry is absent or SSH reports a changed host key, stop and obtain the
expected fingerprint through an independent trusted channel. Only after it is
confirmed should the stale entry be removed and the confirmed replacement be
installed. Do not bypass this with `StrictHostKeyChecking=no` or an empty
known-hosts file.

Prove the exact noninteractive transport and rclone alias:

```sh
/usr/bin/ssh -F "$HOME/.ssh/config" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts" \
  -o ConnectTimeout=12 \
  -o ServerAliveInterval=20 \
  -o ServerAliveCountMax=3 \
  pk_backup true
rclone lsf pk-backup:
```

An exit status of zero from the first command and a successful listing from the
second prove current transport access. They do not prove that a backup was
uploaded or is restorable.

## 2. Run full preflight

Keep Docker services in their normal healthy state and run:

```sh
./scripts/backupctl preflight --compose-root "$ROOT" --remote-mode full --json
```

Continue only when the report has `"ok":true`. Preflight is read-only. Do not
manually create `pk-backup:mycelia`, `owner-v1.json`, or `restic-v1`.

The bootstrap rejects inherited `RESTIC_*` and `RCLONE_*` variables, then starts
its helper, SSH, rclone, and restic subprocesses with a cleared environment.
Only the validated home, the fixed path
`$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, and the exact
per-command backup variables are supplied. Proxy, dynamic-loader, SSH-agent, and
unrelated shell variables are not forwarded.

## 3. Create the Keychain credential

In the same visible Terminal:

```sh
./scripts/backupctl bootstrap --compose-root "$ROOT" --initialize-keychain
```

Read the fresh challenge and type the exact requested confirmation. The helper
creates one non-synchronizing generic-password item in the selected concrete
file Keychain. It never updates, deletes, or replaces an existing item.

The item grants access only to `/usr/bin/security`, but any process running as
this macOS user can invoke that trusted program. The underlying Keychain ACL
APIs are deprecated. Successful helper compilation and unit tests are not proof
that the live ACL works.

## 4. Make and attest the offline recovery copy

Use the visible Keychain Access application to locate the item with account
`mycelia` and service/label `tech.mycelia.backup.restic`. Reveal it locally and
store the 64-character password in the approved offline recovery kit. Do not put
it in an environment variable, text file, command argument, or this runbook.

Choose a bounded, non-secret receipt identifier that refers to the offline
record, then run a separate confirmation transition:

```sh
./scripts/backupctl bootstrap --compose-root "$ROOT" \
  --attest-recovery --receipt-id offline-kit-20261001
```

The receipt records the operator attestation; it cannot prove that the offline
copy is correct or readable. Verify the offline copy according to the recovery
kit procedure before continuing.

## 5. Prove the live password lookup and initialize the repository

Before the first remote write, run the restrictive password command directly and
report only its status:

```sh
MYCELIA_BACKUP_COMPOSE_ROOT="$ROOT" \
  "$ROOT/scripts/restic-password-command" >/dev/null
status=$?
printf 'password lookup exit=%s\n' "$status"
```

Continue only when the status is `0`. This proves the current unlocked login
session can use the item's ACL through `/usr/bin/security`. It does not prove a
LaunchAgent can read it after logout or restart; that remains a later operations
acceptance check.

Reserve the namespace and initialize/verify only `restic-v1`:

```sh
./scripts/backupctl bootstrap --compose-root "$ROOT" --initialize-repository
./scripts/backupctl bootstrap --compose-root "$ROOT" --check
```

The first command atomically reserves `pk-backup:mycelia/owner-v1.json`, opens
or initializes the repository, records its repository ID, and verifies
`restic snapshots --json`. On an interrupted marker or partial repository it
stops for manual inspection. It never deletes, adopts, overwrites, or retries a
foreign/ambiguous namespace.

The owner-marker intent is durable before the first remote write. If a later
attempt starts with that intent but `restic-v1` is absent, it performs no marker
write and no `restic init`; inspect the preserved state and remote namespace
manually. For an interrupted marker writer or `restic init`, bootstrap observes
the raw status of the direct child and then performs only read-only remote
attestation before returning failure. That does not prove that every descendant
or remote side effect has stopped. Such an unproved write now activates the
repository-global quarantine before the bootstrap lock may unwind. An
unconfirmed child status, any forced kill, or an incomplete producer/side-effect
audit also activates that quarantine. The durable marker intent remains a
separate no-retry boundary for the Task 5 marker and repository initialization.

## Repository quarantine and the current recovery boundary

The global interlock is stored under `.local/backup` as a protected pending
intent and `repository-quarantine-v1.json`. While either exists, all Task 5
mutating bootstrap entrypoints and the read-only bootstrap check fail closed
with the quarantine ID and a closed reason code. Generic `--clear-stale-lock`
recovery rechecks this interlock while holding the lock guard and cannot remove
a quarantined lock.

The code now has the fail-closed recovery primitives: an exact lock-owner
identity is pinned, two separated dead-owner/descendant observations must match
it, and every mutating lock fsyncs a pre-reserved quarantine UUID/time before
the mutating callback starts. That WAL alone blocks every other writer and
generic stale clear; only its exact live branded lease may continue its own
callback. A crashed mutating owner therefore requires dedicated recovery even if
no pending rewrite exists. Preflight and status locks remain eligible for
explicit generic stale clearing. The lock is durably rebound to that exact
quarantine before intent I/O. If the single `.recovery-pending` rewrite crashes
while empty or partial, recovery derives the closed
`retention_publication_interrupted` fallback only from that on-disk reservation;
it does not accept caller-injected or in-memory provenance. Hard-link retries
compare inode identity and bytes before any truncate, so a new controller stages
on a fresh inode while the old published lock remains the interlock. The same
advisory guard remains held across recovery, immutable audit fsync, quarantine
removal, and exact recovery-lock cleanup. Deterministic `.pending` publication
prefixes stay fail-closed and are reconciled only by that dedicated recovery
path. The quarantine is removed only after its receipt and state reconciliation.
The concrete Task 7 audit commands and an operator-facing `recover-repository`
CLI are not yet implemented. Therefore there is currently no supported manual
command to clear a quarantine. Do not delete or edit the quarantine, intent,
audit, lock, or guard files; preserve them for the dedicated recovery workflow.

## 6. Create and verify a files snapshot

After full preflight and repository initialization, use the checkout containing
these scripts and its actual Compose root:

```sh
./scripts/backupctl files --compose-root "$ROOT"
./scripts/backupctl status --compose-root "$ROOT"
./scripts/backupctl verify --compose-root "$ROOT"
```

`files` makes the first snapshot with `--force`, then selects the last accepted
full snapshot ID as the explicit parent of subsequent snapshots. Restic
deduplicates unchanged content. A failed candidate never becomes the next
parent. The output contains the current attempt and its candidate ID separately
from `accepted`, which remains the previous verified receipt until the entire
new attempt succeeds.

The command reconciles source coverage, records metadata fingerprints, and
writes a protected temporary JSON inventory plus a separate NUL-delimited input
list. The encrypted snapshot includes the inventory; the input list and other
local backup state are excluded. Source fingerprints are checked before and
after backup. This detects concurrent changes but does not provide an atomic
filesystem snapshot across all sources.

Acceptance requires the exact snapshot ID/host/tags/path set, expected file and
byte counts (including the inventory), a rotating `n/100` repository data check,
and matching SHA-256/length for readback of the inventory and
`docker-compose.yml`. The sampled check does not read all repository data on
each run. `verify` repeats the recorded subset and those two reads against
stored digests; it does not compare against changed current source files or
create a new acceptance receipt. Its output reports `scope: files`.

`status` is read-only and works before initialization. It reports bootstrap
phase, files/Mongo stage records, and any repository quarantine. A null stage
means no recorded attempt, not success. After a crash, a retained mutation WAL
requires the dedicated recovery workflow described above; generic
`--clear-stale-lock` cannot erase it. If writing terminal status fails, the WAL
also remains, even when restic already created a candidate.

Source enumeration is limited to 250,000 files and 16 MiB of encoded source
paths; the generated inventory is limited to 256 MiB. Diagnostics and metadata
have independent bounds. Files are not silently omitted to satisfy a limit.

Local verification can be reproduced without Keychain or remote storage:

```sh
deno test --allow-read --allow-write --allow-run --allow-env scripts/backupctl.test.ts scripts/backup/*.test.ts
BACKUP_INTEGRATION=1 deno test --allow-read --allow-write --allow-run --allow-env scripts/backup/files.integration.test.ts
```

The opt-in integration test creates a disposable encrypted local repository,
backs up A and B, verifies the explicit parent and readback, restores B into a
separate temporary directory with restic verification, and simulates a failed C.
It proves local file workflow behavior; it is not evidence of a production
upload, full Mycelia restoration, Mongo replay, or a measured production RTO.

## What each status proves

- **Configured**: local files, SSH/rclone transport, Keychain metadata, and
  bootstrap state pass their checks.
- **Uploaded**: a later backup stage completed a restic snapshot and recorded
  its snapshot ID. Bootstrap alone is not uploaded data.
- **Readable**: an independent verification can open the repository and read the
  expected objects. A successful `rclone lsf` is not this proof.
- **Restored**: a representative restore was completed into a separate target
  and validated. Neither configuration nor repository readability proves this.

Cleanup is disabled. Do not run `restic forget`, `prune`, repository deletion,
`rclone sync`, or manual remote cleanup as part of bootstrap or a failed retry.
Preserve the marker, partial repository, local bootstrap state, and diagnostics
for review.
