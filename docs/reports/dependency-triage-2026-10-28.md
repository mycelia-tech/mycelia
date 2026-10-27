# Dependency triage: 2026-10-28

This is a reachability review of selected findings from
[the inventory](dependency-audit-2026-10-27.json), not a complete clean audit.
The original 153 package/version findings include tooling and optional paths.
No adversarial requests were sent to the running application.

## Addressed in this source tree

The backend installs Express 4.22.3, resolving body-parser 1.20.9, qs 6.16.1,
path-to-regexp 0.1.13, send 0.19.2 and serve-static 1.16.3. The backend's global
JSON and form parsers run before authentication. The prior body-parser 1.20.4
therefore exposed the application to the compressed-body process crash described
by the [maintainer advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).
The advisory lists 1.20.9 as the fixed release on the existing major version.

Parser failures now return safe 400/413/415 responses before the generic error
logger can print a submitted body. Existing JSON/form settings and valid
gzip/deflate requests remain supported. Tests use disposable middleware on
loopback with synthetic data. The specialized trailing-frame reproduction was
not completed after an automated security filter rejected the agent task;
ordinary compatibility and error handling checks are separate evidence.

Express 5.2.1/body-parser 2.2.1 remain in the MCP SDK dependency graph. This patch
does not claim to remove every vulnerable parser package from the lockfile.
Confirm whether SDK-owned HTTP applications are instantiated before choosing its
compatible upgrade; the primary Mycelia server imports Express 4 directly.

## Next small changes

| Dependency | Application exposure | Next verification |
| --- | --- | --- |
| ws 8.18.3 | The backend creates the WebSocket server with defaults. Upgrade authentication limits entry to valid credentials, but does not bound an authenticated peer's resource use. | Upgrade to at least 8.21.0; preserve audio/notification messages and unauthorized-upgrade rejection. |
| zod 4.3.5 | Resource input parsing happens after authentication but before resource policy checks; several Mongo arrays have no size bounds. | Coordinate backend/SDK upgrade to at least 4.6.6 and add operation-specific bounds; verify bounded validation errors before execution. |
| minimatch 10.1.1 | Authorization paths/actions use the default matcher. Patterns come from privileged API-key policy creation or updates. | Upgrade to at least 10.2.3, constrain policy grammar/size, preserve existing wildcard semantics. This is not established as anonymous exposure. |

Sources: [ws maintainer advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p),
[Zod fix](https://github.com/colinhacks/zod/commit/a0ebf97),
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[minimatch maintainer advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-23c5-xmqv-rm74).

Relevant call sites: `backend/server.ts`, `backend/app/lib/auth/resources.ts`,
`backend/app/lib/auth/apikeys.resource.ts`, `backend/app/lib/mongo/core.server.ts`.
These changes require targeted regression and a deliberate runtime rollout.
