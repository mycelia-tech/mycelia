# Encrypted MongoDB logical backups and restore drills

The standalone `scripts/backup-mongo-bastion.ts` CLI is independent of the existing
restic file backup and does not implement retention, pruning, PITR or scheduling.
It streams `mongodump --archive --gzip --oplog` through age encryption directly
to an SSH receiver. Plaintext archives are never staged on disk.

Prerequisites: Deno 2.9.5, Docker, standard `age`/`age-keygen`, OpenSSH, Python 3
on the destination, an existing primary with sufficient oplog history, and a
reviewed Mongo image digest for restore drills. Generate/store the age identity
locally outside Git with restrictive permissions; put only its public recipient
in backup configuration. An unavailable command is an error, not a verified run.

## Local configuration

Create a private JSON file outside Git for the source Mongo container:

```json
{"uri":"mongodb://BACKUP_USER:URI_ENCODED_PASSWORD@127.0.0.1:27017/?authSource=admin&directConnection=true"}
```

For a source still without authorization, omit credentials. Mount the file
read-only at `/run/secrets/mongo-backup.json` using
`docker-compose.mongo-backup.yml` and `MONGO_BACKUP_CONFIG_PATH`, preserving every
other existing overlay. It must be a private regular file readable by the
container's tools. Never put the URI in CLI arguments, logs, URLs or chat.
The migration to authorization is separately gated in [MONGO_AUTH.md](MONGO_AUTH.md).

Create a separate private host config, replacing every placeholder:

```json
{
  "sourceContainer": "mycelia-mongo-1",
  "sourceConfigPath": "/run/secrets/mongo-backup.json",
  "sshHost": "mycelia-backup",
  "expectedSshHostname": "backup.example.invalid",
  "expectedSshUser": "backup",
  "remoteRoot": "/mnt/backups/mycelia-mongo",
  "remoteMount": "/mnt/backups",
  "stateDir": "/ABSOLUTE/PRIVATE/PATH/mongo-backup-state",
  "ageRecipient": "REPLACE_WITH_PUBLIC_AGE_RECIPIENT",
  "restoreImage": "mongo@sha256:REPLACE_WITH_REVIEWED_64_HEX_DIGEST",
  "minFreeBytes": 1073741824,
  "timeoutSeconds": 7200
}
```

Use an SSH alias with a verified known host and explicit destination. The CLI
checks the effective hostname/user, enforces host-key checking and validates the
destination mount. The restore image must match the source Mongo version and be
pinned by digest; mutable image tags are rejected.

## Commands and evidence

```sh
deno run -A scripts/backup-mongo-bastion.ts backup --config /ABSOLUTE/PATH/mongo-backup.json
deno run -A scripts/backup-mongo-bastion.ts verify --config /ABSOLUTE/PATH/mongo-backup.json --run-id mongo-UUID
deno run -A scripts/backup-mongo-bastion.ts restore-drill --config /ABSOLUTE/PATH/mongo-backup.json --run-id mongo-UUID --identity-file /ABSOLUTE/PATH/age-identity.txt --disposable
```

`backup` records separate transfer and ciphertext-integrity evidence. A partial
or failed transfer never becomes a verified archive. `verify` rechecks the
remote ciphertext. Neither operation claims restoration.

`restore-drill` requires the explicit disposable flag and creates a new,
exclusively owned Docker volume/container with no network and no published ports.
It decrypts into `mongorestore`, replays the oplog and validates restored
collections before setting `restoreVerified`. It refuses an existing target;
there is no option to name a production restore destination. The stopped
container and volume are retained for review and explicit cleanup, not silently
deleted. Inspect application-level invariants before approving a real migration.

Unit tests use synthetic bytes and fake subprocesses. Their success does not
prove that any operator archive was backed up or restored. Production migration
requires an actual reviewed restore receipt and an independent application check.

## Synthetic integration acceptance

`MYCELIA_MONGO_BACKUP_INTEGRATION=1 deno test -A scripts/backup-mongo-bastion.integration.test.ts`
creates a new synthetic source and receiver, runs real dump/encryption/restore,
checks sample values, date types and indexes, then stops and retains its targets.
It needs Docker and age; `MYCELIA_BACKUP_TEST_AGE` and
`MYCELIA_BACKUP_TEST_AGE_KEYGEN` may select temporary absolute binary paths.
It never reads an operator source or SSH configuration. SSH transport is replaced
with `docker exec` into the isolated receiver, so SSH handshake/authentication is
not covered. Receipts and owned resource names are printed for explicit review
and cleanup. This optional test is outside the default fast gate because it
intentionally retains evidence and volumes.

On 2026-10-27, the real synthetic path passed with MongoDB 8.0.28 and age 1.3.2:
dump with oplog/gzip, ciphertext transfer/hash, decrypt, oplog replay, four
validated collections and independent sample/index assertions. This proves the
tested pipeline, not the integrity or recoverability of a production archive.
