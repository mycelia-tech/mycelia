# MongoDB access and authorization migration

The base Compose stack no longer publishes MongoDB to the host. The optional
RAG stack uses the `mycelia-mongo-clients` Docker network created by the main
stack; configure `MYCELIA_MONGO_NETWORK` consistently in both projects. Existing
RAG environment files using `host.docker.internal:27017` must change to
`mongodb://mongo:27017/?directConnection=true` before the port is removed.
The main stack's Mongo client network is project-scoped by default. Set
`MYCELIA_MONGO_NETWORK` explicitly to the same name in its paired RAG config.
Independent development stacks must use a different network; the media example
sets `mycelia-media-89da-mongo-clients` to avoid sharing the `mongo` DNS alias.

For explicit host maintenance, add `docker-compose.mongo-local.yml` to the
normal overlay list. It publishes only `127.0.0.1:${MONGO_LOCAL_PORT:-27017}`.
Do not bind it to all interfaces. Host access is optional; `docker compose exec`
works without a published port.

## Existing installations: gated, manual migration

`MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` do **not** enable
authorization with the legacy custom entrypoint. Network isolation is not
database authentication. The base configuration intentionally does not enable
auth on an existing database without preparing users and clients.

1. Record the actual Compose project, all overlays, source checkout, image
   digests and data-volume paths. Keep the current data directory unchanged.
2. Complete an encrypted logical dump with oplog and verify its checksum.
   Restore it into an isolated MongoDB with a new volume and no published port.
   Compare collection/index inventories and representative application reads.
   A successful upload or checksum alone is not a restore drill.
3. While the database is still accessible only through the trusted local
   operator path, create distinct users using an interactive `mongosh` with
   `passwordPrompt()`, never shell arguments or checked-in scripts:
   administrator (`root` on `admin`); application (`readWrite` and `dbAdmin` on
   the configured application database); backup (`backup` on `admin`);
   health monitor (`clusterMonitor` on `admin`); RAG (`read` on the application
   database and read access to `local.oplog.rs` when change streams require it).
   Do not replace existing users or credentials implicitly.
4. Generate a replica-set keyfile locally (`openssl rand -base64 756`), store
   outside Git, make it readable only by the Mongo container user (0400), and
   verify ownership/readability in a disposable container with the same image.
   Set its absolute host path as `MONGO_KEYFILE_PATH`.
5. Prepare application `MONGO_URL`, RAG URL, authenticated backup credentials
   and `MONGO_HEALTH_USERNAME`/`MONGO_HEALTH_PASSWORD` in local secret storage.
   URI-encode credentials; never print expanded Compose configuration. Test
   the same client configurations against the restored authenticated instance.
6. Only after review of the restore result and rollback steps, pause writers
   and apply `docker-compose.mongo-auth.yml` together with **every existing
   overlay**. This is a database migration, not an application hot reload.
   The overlay uses Mongo's official entrypoint and enabled authorization.
7. Require an authenticated primary, passing health probe, denied anonymous
   reads, working application/RAG reads, and a new authenticated backup.
   Resume workers only after these checks pass.

Rollback: keep writers paused, preserve both the pre-migration archive and the
current volume, restore the previous Compose overlay set and client secret
configuration, and recheck readiness. Never delete or recreate the database
volume as a rollback shortcut. If data integrity is uncertain, restore to a new
isolated volume and review before switching consumers.

This repository change prepares the migration; it does not prove that any
existing deployment has enabled authorization or passed a restore drill.
