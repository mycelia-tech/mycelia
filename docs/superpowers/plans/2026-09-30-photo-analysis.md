# General photo analysis implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in the existing worktree. Steps use checkboxes for tracking.

**Goal:** Connect general vision models, preserve and review existing photo results, and keep Google disabled unless explicitly enabled.

**Architecture:** Extend media profiles with a referenced shared connection and a standard vision adapter. Preserve durable import/recognition jobs and versioned projections. Add a default-off Google access policy and separate photo settings from optional Google settings.

**Tech Stack:** Deno, TypeScript, Zod, MongoDB, BullMQ, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-provider-neutral-photo-analysis-design.md`

## Execution record

Implemented in the existing isolated worktree against `c199ed06`. The three
tasks were developed as one coherent change because profile schemas, persistence
and UI depend on each other; their intermediate commits were consolidated into
the final feature commit. No live model calls, UAT merge or service reload.

Verification on 2026-09-30:

- SDK: 16 tests passed.
- Backend: 110 media/provider/event/LLM tests plus 30 isolated Mongo/Redis
  reservation tests passed. No production data was used.
- Full frontend: 484 passed, one pre-existing failure in
  `src/lib/audioPipelineStats.test.ts` (expected fixture lacks `blocked: 0`).
  Its source and test are unchanged from the base commit. An initial sandbox run
  also denied Deno localStorage writes; these failures disappeared with the
  required local test-cache permissions. One earlier parallel UI run timed out;
  isolated and final full runs passed that test.
- Touched-file lint, targeted backend/frontend type checks, and Vite production
  build passed. Build retains existing browser-data/chunk-size warnings.
- Independent review found six important edge cases; all were repaired and the
  reviewer confirmed no remaining critical/important blockers.
- Live installation was inspected read-only: Google media disabled, no enabled
  Google LLM profile, recognition/batch workers paused. It binds the main UAT
  checkout, not this worktree; new code is not live.

## Global constraints

- No Google requests, real-photo inference, data deletion, MongoDB/Redis restart, or automatic archive reanalysis during implementation.
- Preserve existing provider profiles, original references, stored results and owner isolation.
- No credentials in media DTOs, receipts, jobs, logs or analysis history.
- Configurable photo concurrency 1–8, sharing provider capacity with text inference.
- Additive schema changes; Google access defaults off.

## Review focus

- A disabled provider or changed endpoint must invalidate queued snapshots before any network call.
- A keyless local model must work without a fabricated Authorization header.
- Reanalysis failures must not replace a previous successful result.
- Google history must be readable without ADC or Google network requests.
- Server-side all-matching selection must not silently become page-only selection.

### Task 1: Provider contracts, policy and vision adapter

Files: `myceliasdk/media.ts`, `myceliasdk/config.ts`, new `myceliasdk/google-policy.ts`, new `backend/app/lib/media/general-provider.ts`, new `backend/app/lib/media/provider-settings.server.ts`, `backend/app/lib/media/providers.server.ts`, `backend/app/lib/llm/resource.server.ts`, new shared limiter module and focused tests.

Interfaces: `assertGoogleAccess(config, {baseUrl?, model?, providerType?})`; `resolvePhotoConnection(config, profile)` returns a private credential-bearing connection and `photoConnectionSnapshot(connection)` returns a secret-free binding; `analyzeGeneralPhoto(input, connection, dependencies)` returns normalized analysis with optional embeddings and unknown cost explicitly represented.

- [x] Write schema and provider boundary tests. Pin behavior with real inputs:

```ts
assertThrows(() => assertGoogleAccess({}, { model: "google/gemini-test" }));
assertEquals(zMediaRecognitionProfile.parse({id:"p", name:"Photo", enabled:true,
  providerType:"openai-compatible", connectionId:"local", model:"vision"}).language, "Russian");
```

- [x] Run SDK/provider tests and observe failure for the absent contracts.
- [x] Implement the contracts, private connection resolver, default-off Google checks, keyless HTTP requests, bounded 429 retries, structured visual/text normalization and a shared in-process provider limiter. Reject unsafe URLs and redirects.
- [x] Run tests for disabled/changed endpoints, unknown prices, missing embeddings, empty optional attributes, malformed output, 429 exhaustion and cancellation before dispatch.
- [x] Include the tested provider foundation in the consolidated feature commit.

### Task 2: Durable media integration, settings and versioned reanalysis

Files: `backend/app/lib/media/resource.server.ts`, `backend/app/lib/media-library/resource.server.ts`, `backend/app/lib/media-library/recognition-reservations.test.ts`, `backend/app/lib/media/resource.schema.test.ts`, `myceliasdk/media-library.ts`, worker schemas.

Interfaces: media actions `photoSettings`, `savePhotoProfile`, `testPhotoProfile`, `getAnalysisRun`; general profiles bind their connection snapshot during preview. Batch selection carries an explicit `reanalyze` flag. Completed runs retain their immutable identity; new reanalysis receipts produce different identities and duplicate confirmations reuse the same one.

- [x] Add regression tests for ready-photo eligibility only under explicit reanalysis and optional-embedding persistence:

```ts
assertEquals(recognitionEligibilityQuery("owner", true).status.$in.includes("ready"), true);
assertEquals(recognitionEligibilityQuery("owner").status.$in.includes("ready"), false);
```

- [x] Observe the failing tests before changing preparation, queue claims and publication.
- [x] Integrate current-connection validation at preview, confirm and pre-dispatch. Keep secret-free snapshots and reject incompatible PDFs.
- [x] Add write-only credential handling via the existing shared provider store, admin-only connection management, synthetic image tests with explicit consent, and owner-scoped run retrieval.
- [x] Store descriptions without embeddings, retain the previous projection during reanalysis, represent failed latest attempts separately, and preserve exactly-once receipt confirmation and reservations.
- [x] Test cancellation, owner isolation, partial failures, changed/missing originals, old results while Google is off, and selection across all matching assets. Include in the consolidated commit.

### Task 3: Clear settings, analysis and results UI; verification

Files: new `frontend/src/pages/settings/PhotoAnalysisSettingsPage.tsx` and tests, `frontend/src/pages/MediaAnalysisPage.tsx` and tests, reusable media result components, `frontend/src/pages/MediaPage.tsx`, `frontend/src/pages/settings/GoogleCloudSettingsPage.tsx`, router/settings navigation, README/DEVELOPMENT/media docs.

Interfaces: consume the secret-free settings and run APIs from Task 2. Reuse current media filters, cursor pagination and deep links. Keep Google configuration at its existing optional route.

- [x] Add frontend behavior tests before implementing controls:

```tsx
expect(screen.getByRole("link", {name:"Photo analysis settings"})).toHaveAttribute("href", "/settings/photo-analysis");
expect(screen.queryByText("Verify Google credit")).not.toBeInTheDocument();
```

- [x] Implement existing/new connection selection, explicit image test, output language and model controls without exposing keys. Never auto-enable Google.
- [x] Add To analyze / Results / Needs attention navigation, provider filter, unknown-price copy and explicit reanalysis. Extract a closeable result/history panel that displays old Google and new model results without network inference.
- [x] Verify page/all-matching selection, model/provider provenance, deep-link closing, PDF navigation, and Map/Timeline image gates. Update docs for implemented behavior.
- [x] Run focused SDK/backend/frontend suites, broader project suites where safe, type checks, lint and frontend build. Record pre-existing failures by name.
- [x] Run a fresh whole-branch review before the consolidated commit. Repair important findings with failing regression tests, rerun affected suites, and report deployment separately from code verification. Do not merge or reload a shared checkout without current authorization.
