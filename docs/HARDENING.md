# Repository hardening and rollout

This work targets a personal self-hosted installation. Source changes are not a
deployment report: use `deno task doctor --expected-root "$PWD" --probe-readiness`
to verify the actual source mounts, image, mode, health and backend readiness.
Never switch a running worktree or migrate database authentication implicitly.

## Security contracts

- AI/MCP tools always execute through ResourceManager, including union schemas.
- Chat Mongo aggregation is read-only even for administrators. Scoped Mongo
  queries authorize every referenced collection; unsupported pipeline stages,
  filtered aggregation/bulk operations and unscoped cursors fail closed.
- WebSocket channels are authorized at subscription and delivery. Mongo changes
  contain identifiers and changed field names, not documents or update values.
  Clients refetch authoritative data through protected resources.
- Saved provider keys stay on their saved origin. Endpoint probing requires
  `llm/providers:probe`; explicitly configured local providers remain supported.
- First enrollment requires a one-time `MYCELIA_BOOTSTRAP_TOKEN` (at least 32
  characters). Browser sessions replace persistent client secrets; device API
  keys remain available. Revocation/policy changes apply to derived sessions.
- Invalid worker credentials fail closed. System access is explicit.
- Revocation blocks external requests and new job submissions. Already accepted
  durable jobs continue under their bounded internal worker capabilities; cancel
  accepted work explicitly in Jobs. Revoking a browser session is not a job
  cancellation operation.
- Browser sessions last 24 hours; their access tokens last 15 minutes. Logout,
  key revocation and policy changes invalidate derived tokens. Old unbound JWTs
  and refresh grants need a fresh API-key exchange; existing API keys remain
  valid. Browsers require one login when persistent secrets are removed.
- `MYCELIA_FRONTEND_HOST` is a complete URL origin. Direct backend execution
  trusts no proxy; Compose explicitly sets `MYCELIA_TRUST_PROXY=uniquelocal`
  behind nginx, which overwrites forwarded protocol. HTTP browser sessions are
  allowed only for loopback origins in explicit development mode.
- Production nginx redirects HTTP to HTTPS, preserves the incoming host port,
  adds basic security headers and excludes query strings from access logs.
  `APP_MODE=dev` is the explicit local HTTP exception.

## Processing contracts

Audio uploads stream to private temporary files with a 500 MiB aggregate limit,
at most 20 files and at most two concurrent upload requests. Audio is emitted
as bounded 10-second chunks. Files longer than 24 hours are rejected explicitly;
`AUDIO_UPLOAD_PROCESS_TIMEOUT_SECONDS` defaults to 600 (allowed range 1–7200).
Errors leave a failed source rather than a false success. Temporary web uploads
must be uploaded again after failure; no automatic durable-resume claim is made.

Source retry queues an ingestion job with explicit `sourceIds`/`retryErrors`;
it does not erase the previous ingestion error before processing succeeds.
Python retries only safe operations or operations with stable identity and
deduplication, with bounded connection/read deadlines and cancellation checks.
`MYCELIA_ENV_FILE` and `MYCELIA_IMPORTERS_FILE` select explicit config files;
process environment takes precedence over dotenv. HTTPS verification remains on.

## Daily workflows and feature modules

Search submission writes query and filters into the URL. Results and scroll
position are cached only in memory and restored when returning from a source;
authentication/account changes clear that memory. Technical retrieval details
are collapsed. Mobile navigation and settings use compact menus, active parent
links and skip-to-content navigation. Route chunks load lazily with recoverable
loading/error screens. Messenger and worker actions expose failures and retries.
Inference setup distinguishes saved configuration from a read-only connection
check; it never claims that inference succeeded without running inference.

The first feature boundaries are `frontend/src/modules/search` and
`frontend/src/modules/jobs`; upload processing, Mongo pipeline policy and browser
session lifecycle also have dedicated modules. Existing URLs/action names remain
stable. Continue extraction by domain contract rather than moving JSX alone.

`frontend/src/modules/speakers/useReviewSourcePreview` owns source-preview
cancellation, stale-response protection, timeout/elapsed state and the frozen
server-checked range. Jobs and voice review remain substantial pages; subsequent
extraction should preserve their domain contracts and regression tests.

Live audio attaches opaque capture/session/request UUIDs and allowlisted failure
codes across Omi, WLK and the private ASR adapter. A capture ID persists across
rotation windows. Diagnostics omit speech, PCM, arbitrary provider errors and
credentials. Short synthetic timeout/disconnect tests are required; they do not
substitute for a sustained physical-device acceptance run.

## Validation and release

`deno task verify` runs repository, backend, frontend, SDK, Python, RAG, CPU
GPU, isolated nginx and browser acceptance checks. Supply group names for focused
work, e.g. `deno task verify sdk repo`. Browser tests need a locally installed
Playwright Chromium or explicit `PLAYWRIGHT_CHANNEL=chrome`.
Backend integration tests require a local Docker engine. One parent runner owns
a disposable MongoDB/Redis pair and awaits cleanup, including failed startup,
failed tests and interruption. A private session manifest supplies loopback
endpoints and verifies Docker exposes them only on 127.0.0.1; modules run
sequentially and database fixtures use unique names.
The runner blocks dotenv reads and replaces application endpoints with inert
values. All verification children clear inherited service credentials and
operator storage paths, with explicit tool/cache settings retained. Python is
requested as 3.12, including when an older local virtual environment exists.
Use the wrapper documented in DEVELOPMENT.md for selected integration
tests; never point tests at working data. Python/RAG use frozen uv environments; notebook and
recorder extras are optional.

Images depend on the reusable verification workflow for the same SHA. The
separate dependency advisory workflow queries OSV using only package names and
versions, retains findings, and fails when findings exist or the scan is
incomplete. It does not silently mark unavailable scans clean. Repository checks
also validate dependency declarations, documentation links and common leaked
credential formats; this bounded scan is not a complete secret-detection claim.

The online inventory on 2026-10-27 checked 1,936 package/version pairs and
reported advisories for 153 pairs across the lockfiles, including
transitive, optional and retained tooling entries. Deno peer suffixes are parsed
separately from package names. This is not an exploitability count or a clean
security baseline. Multer and Vite are the targeted upgrades in this change;
other findings require separate reachability/compatibility triage. The advisory
workflow remains failing when findings exist; no blanket suppression is applied.
The targeted Multer 2.5.0 and frontend Vite 6.4.5 returned no advisories in this
query; an existing backend tooling lock entry for Vite 8.1.5 still has findings.
Manifest normalization also resolves peer/transitive packages; review lockfile
diffs alongside the targeted upgrades. The complete report is in
[the audit snapshot](reports/dependency-audit-2026-10-27.json).

See [Mongo migration](MONGO_AUTH.md) and [backups](BACKUP.md) for the separate
operator gates. Existing archives, originals and production data are preserved.
