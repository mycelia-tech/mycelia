# Authentication & Authorization Model

## Enrollment and browser sessions

The first administrator requires the private one-time `MYCELIA_BOOTSTRAP_TOKEN`
created by setup. Concurrent enrollment is claimed atomically. Browser login
exchanges an API key once for an opaque HttpOnly, Secure, SameSite=Strict session
cookie; persistent client secrets are removed from localStorage. Sessions last
24 hours and mint 15-minute access tokens kept only in memory. Cookie mutations
require the configured Origin and CSRF header. HTTP is limited to explicit local
development. Existing device API keys remain supported.
Browser UI and API must be same-site for the Strict cookie; the supplied nginx
configuration serves them together. Separate cross-site browser/API deployments
need a same-site reverse proxy rather than restoring persistent browser secrets.

Credential-derived JWTs and sessions are bound to the key identity and current
permissions. Revocation and policy changes invalidate them. Existing unbound
JWTs require a new key exchange. Internal worker tokens are explicitly marked,
scoped to the worker manifest, and never replaced with system privileges after
failed validation. Previously accepted jobs remain independent durable work;
cancel them explicitly in Jobs.

All AI/MCP calls go through ResourceManager, including union schemas. Chat
aggregation rejects write stages; restricted Mongo operations cannot bypass
filters through cross-collection pipelines, bulk writes or reused cursors.
WebSocket subscriptions and delivery are permission checked; clients fetch
document contents through the protected API after receiving minimal changes.
JWTs are never put in WebSocket URLs. Device clients send
`Authorization: Bearer <JWT>`; browsers use subprotocols
`['mycelia', 'mycelia.jwt.<JWT>']`, and the server echoes only `mycelia`.
Legacy `?token=` connections are rejected, even alongside a valid header.
Do not log the credential-bearing `Sec-WebSocket-Protocol` request header.

See [hardening and rollout](HARDENING.md) for compatibility, proxy configuration,
verification and the separate Mongo authorization migration.

Mycelia Authorization Model revolves around three main entities:

1.  **Principal**: An entity (user, service, or API key) that wants to perform an action.
2.  **Resource**: A capability or piece of data that can be accessed.
3.  **Policy**: A rule that defines whether a Principal can perform a specific Action on a Resource.

### Resources & Actions

A **Resource** implementation defines:
- **Code**: A unique identifier for the resource type (e.g., `"apikeys"`, `"users"`).
- **Path**: A hierarchical identifier for a specific instance or sub-resource (e.g., `["apikeys", "list"]`).
- **Actions**: What can be done (e.g., `"read"`, `"write"`, `"execute"`).

### Policies

A **Policy** is a declarative rule that matches a Resource Path and an Action.

```typescript
export type Policy = SimplePolicy | ModifyPolicy<any>;

export type SimplePolicy = {
  resource: Rule; // e.g., "apikeys/**"
  action: Rule;   // e.g., "read"
  effect: "allow" | "deny";
};

export type ModifyPolicy<Arg> = {
  resource: Rule;
  action: Rule;
  effect: "modify";
  middleware: {
    code: Code;   // Reference to a ResourceAccessModifier
    arg?: Arg;    // Arguments for the modifier
  };
};
```

- **Rules**: Both `resource` and `action` in a policy are `Rule` types, which support glob patterns:
    - `**`: Matches anything, including directory separators (`/`). Use this for recursive matching (e.g., `apikeys/**` matches `apikeys/list`, `apikeys/create`, etc.).
    - `*`: Matches anything *except* directory separators (`/`). Use this for single-level matching (e.g., `users/*` matches `users/123` but not `users/123/settings`).
- **Effects**: 
    - `allow`: Grants access.
    - `deny`: Explicitly forbids access.
    - `modify`: Allows access but wraps the execution in a middleware (e.g., to filter results or inject constraints).

## Isolation and Least Privilege

The system is designed with **Least Privilege** by default:
- If no policy matches a requested action, access is **Denied**.
- An explicit `deny` policy always takes precedence during evaluation.
- Principals (like API Keys) carry their own set of policies, ensuring strict **Isolation**. An API key can only do exactly what its policies allow, regardless of the owner's broader permissions.

## Usage Examples

### 1. Simple Read-Only Access
Grant access to list and view all API keys:
```yaml
- resource: "apikeys/**"
  action: "read"
  effect: "allow"
```

### 2. Restricting to a Specific Instance
Grant full access only to a specific user resource:
```yaml
- resource: "users/12345"
  action: "*"
  effect: "allow"
```

### 3. Policy-Based Modification (Middleware)
Suppose you have a resource that lists documents, but you want to ensure the user can only see documents they own. A `modify` policy can inject this constraint:
```yaml
- resource: "documents/**"
  action: "list"
  effect: "modify"
  middleware:
    code: "ownerFilter"
    arg: { ownerId: "user_abc" }
```

## How Evaluation Works

When a resource is accessed:
1.  The resource extracts the required **Actions** and their **Paths** from the input.
2.  The `ResourceManager` compares these against the Principal's **Policies**.
3.  It uses `minimatch` to check if the current `ResourcePath` and `Action` match any `Rule` in the policies.
4.  If any `deny` matches, access is immediately rejected.
5.  If no `allow` (or `modify`) matches, access is rejected.
6.  If `modify` policies match, they are applied as layers of middleware around the resource's `use` function.
7.  Finally, the `use` function is executed (or the chain of modifiers).

## Resource Calling as a Control Point

In Mycelia, the act of "calling a resource" is the primary enforcement point for all security logic. Whether from the frontend or within a background worker, access is always mediated by the `ResourceManager`.

### Client-Side: `callResource`
On the frontend, all interactions with the backend happen through `callResource`. This function targets an API endpoint (`/api/resource/:code`) that:
1.  Authenticates the request (e.g., via a JWT in headers).
2.  Instantiates the requested **Resource**.
3.  Evaluates the Principal's **Policies** against the requested actions.
4.  Executes the resource logic only if permitted.

### Server-Side: Worker Isolation
Background workers (located in `backend/app/workers/`) are also subject to these constraints. When a worker starts, it is provided with a scoped JWT containing only the policies it needs to function.

For example, a `summarization` worker specifies its required permissions:

```typescript
// backend/app/workers/summarization.ts
export const policies = [
  { resource: "db/transcriptions", action: "read", effect: "allow" },
  { resource: "llm/chat", action: "completions", effect: "allow" },
  { resource: "objects", action: "*", effect: "allow" },
];
```

When the worker code executes, it calls resources like this:

```typescript
const auth = await getServerAuth(); // Scoped to worker's permissions
const mongo = await getMongoResource(auth);
const transcripts = await mongo({
  action: "find",
  collection: "transcriptions",
  // ...
});
```

Even though this code runs on the server, the `mongo` call is still a control point, worker cannot access collections or perform actions beyond what was explicitly granted in its `policies` definition. This provides **Internal Isolation**


# FAQ


**Question:** If a VAD (Voice Activity Detection) job needs to access Mongo, File System, and Transcription, how is that coordinated? Does it become a mess of separate checks?

**Answer:** 
Coordination is handled through **Declarative Scoping**. In Mycelia, a worker or capability doesn't "ask" for permissions at runtime. Instead, it declares its **Manifest**:

```typescript
// Example: VAD Job Capability
export const policies = [
  { resource: "db/audio_chunks", action: "read", effect: "allow" },
  { resource: "fs/temp", action: "*", effect: "allow" },
  { resource: "transcription/*", action: "execute", effect: "allow" },
];
```

When the job starts, the `processor.ts` generates a **scoped JWT** containing *only* these policies. 
- **The Coordination:** The JWT travels with the job's execution context. 
- **The Enforcement:** Every time the job calls `auth.getResource("mongo")` or `auth.getResource("fs")`, the `ResourceManager` automatically validates the call against that specific JWT. 
- **Result:** The developer of the VAD job only thinks about what they need. The system ensures they can't do more.




**Question:** What if a user has `allow` on Mongo but `deny` on a specific collection? How do `modify` policies interact?

**Answer:**
1.  **Deny-by-Default & Deny-Overrides:** Evaluation follows strict rules:
    - If no policy matches an action: **Deny**.
    - If *any* policy matches with `effect: "deny"`: **Deny** (even if an `allow` also matches).
    - If an `allow` matches and no `deny` matches: **Allow**.
2.  **Modify Policies (Middleware):** These are applied as a **Chain of Responsibility**. If multiple `modify` policies match a single resource call, they wrap each other like onion layers.
    - *Example:* Policy A redacts PII, Policy B filters by Owner. The call becomes: `PolicyA(PolicyB(Resource.use()))`.
