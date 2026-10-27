# Mycelia RAG

Independent, testable Qdrant projection of Mycelia's MongoDB data. The service
reads MongoDB, writes vectors and payloads to Qdrant, and keeps its own lifecycle,
ledger, checkpoints, and operation history in SQLite. It does not import Mycelia's
backend and never writes to MongoDB.

This module does not use MongoDB Search or `mongot`. Mem0, graph retrieval, and
end-user/database authorization are deliberately separate later integrations.

## Retrieval baseline

- profile: `fastembed-minilm-bm25-v1`, executed in-process on the RAG host;
- dense: local FastEmbed multilingual
  `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384 dimensions);
- sparse: local `Qdrant/bm25` with Qdrant IDF modifier;
- reranker: disabled;
- hybrid: Qdrant prefetch for both named vectors plus reciprocal-rank fusion (RRF);
- hard payload filters: source kind, overlapping start/end time range, exact
  `(collection, source ID)`, message platform, and canonical message sender ID;
- evidence verification: over-fetch from Qdrant, bulk re-read matching MongoDB
  documents, re-chunk canonical text, verify source/content revisions and
  filters, then cap results per chat, recording, or canonical source;
- sources: `transcriptions`, `messages`, `objects`, and active
  `media_visual_descriptions`.

The dense and sparse Hugging Face artifact revisions and all other Stage 1
inference fields are immutable for this profile; invalid overrides stop
configuration loading. The installed FastEmbed version is verified before
inference. Model files are cached in `RAG_MODEL_CACHE`. The first rebuild/search
that needs a model may download it; startup and status inspection do not download
models.

The embedding-space fingerprint covers model/artifact revision, tokenizer
contract, query/document instruction fingerprints, dimensions, normalization,
and sparse settings. The projection fingerprint additionally covers the chunker
and source adapter schema. Executor location is deliberately separate: a future
local or remote executor may write the same generation only after it reports the
exact same embedding-space fingerprint. There is no silent fallback to a
different model or instruction format.

## Inference stages

| Stage | Current state | Execution |
| --- | --- | --- |
| 1: MiniLM + BM25 | Implemented default baseline | Local FastEmbed in the RAG process; Qdrant remains CPU-only |
| 2: Qwen3 embedding | Architecture only | A new blue/green projection using `Qwen/Qwen3-Embedding-0.6B`, 768 dimensions, and a separately deployed authenticated HTTP executor on the RTX 4090 |
| 3: reranker | Architecture only | Independent query-time service over canonically revalidated top candidates; enabling it does not rebuild vectors |

Stage 2 must pin a full model and tokenizer revision, a versioned query
instruction, document format, pooling/truncation/precision contract, 768 output
dimensions, L2 normalization, and the same chunker fingerprint. The remote
service must expose its contract fingerprint before accepting work, and every
embedding response must echo it. The future remote integration must make the RAG
runtime refuse rebuild, incremental update, reconcile, and search when the
configured and served contracts differ. The intended deployment keeps Qdrant on
the Mac/current server while only dense inference and later reranking use the
4090.

An M1 executor may handle small updates to a Qwen generation only if it implements
the exact same declared contract and passes the same handshake. Otherwise those
updates continue through the 4090; switching to the MiniLM baseline is a separate
projection activation, never a per-request fallback.

## Data ownership and lifecycle

MongoDB is the read-only source of truth. Each rebuild creates a new
generation-specific Qdrant collection. It never clears or overwrites the active
collection in place:

1. capture a database-wide change-stream post-batch resume token;
2. `building`: scan the configured source projection and populate a new collection;
3. `catching_up`: run a second full comparison and replay changes from the captured
   token to cover writes that happened during the initial scan;
4. update the `<RAG_COLLECTION_PREFIX>_active` Qdrant alias and drain its call window;
5. atomically persist the resume token and switch the active pointer in SQLite;
6. mark the previous projection `superseded`.

If any build, catch-up, or alias step fails, the old active projection remains the
search target. Superseded and failed Qdrant collections are not deleted
automatically; this makes failures inspectable and cleanup an explicit operation.

After activation, a single database-level MongoDB change stream watches the four
tracked collections with `fullDocument=updateLookup`. Its resume token advances only
after Qdrant and the SQLite ledger have both been updated. A periodic full reconcile
repairs missed updates and deletes. If MongoDB reports lost change-stream history,
the service exposes a degraded state, clears the unusable token, and schedules a
reconcile instead of silently skipping data.

The source Mongo deployment must be a replica set for change streams. Qdrant
remains intact if MongoDB is temporarily unavailable, but `/v1/search` fails
closed with `canonical_source_unavailable`: an unverified vector payload is not
returned as canonical evidence.

At startup, queued/running operations left by a stopped process are marked failed,
non-active `building`/`catching_up` generations are marked error, and the Qdrant
active alias is restored from SQLite's authoritative active pointer. An existing
active projection stays searchable and the lifecycle reports `degraded` until the
interrupted build is inspected or rebuilt.

The active generation fingerprint must match the configured adapter schema,
chunker, and complete dense/sparse embedding-space contract. A mismatch blocks
search, reconcile, and incremental mutation until rebuild activates a compatible
generation. MongoDB drop/rename/invalidate events durably mark reconciliation
required before their resume boundary advances.

## Ports

The container listens on port `8091`. The isolated development mapping is:

| Endpoint | Host port | Container port |
| --- | ---: | ---: |
| RAG API | `48091` | `8091` |
| Qdrant REST and dashboard | `46333` | `6333` |
| Qdrant gRPC | `46334` | `6334` |

These ports are intentionally outside the main Mycelia Docker stack's normal port
set. Do not point commands below at the already-running primary worktree stack.

## Local development

From this directory:

```sh
cp .env.example .env
uv sync --frozen
uv run uvicorn mycelia_rag.app:app --host 127.0.0.1 --port 48091
```

Run checks without Docker or model downloads:

```sh
uv run pytest
uv run ruff check src tests
uv run ruff format --check src tests
```

Build the standalone image from the repository root:

```sh
docker build -t mycelia-rag ./rag
```

The root-level isolated Compose profile supplies Qdrant and the network route to
MongoDB. This module's Dockerfile is self-contained and starts
`mycelia_rag.app:app` on `0.0.0.0:8091`.

## Configuration

Source checkouts load `rag/.env` relative to this package's project directory,
independently of the current working directory. Set `RAG_ENV_FILE` to an absolute
path to select another file, or to an empty string to disable dotenv loading.
An installed wheel does not search for a `.env`; configure it through environment
variables or an explicit `RAG_ENV_FILE`.

Explicit `Settings(...)` values take priority over environment variables, which
take priority over the selected file. A constructor `_env_file` argument overrides
the file selector. Repository verification uses a deliberately empty file and
explicit Python 3.12 (`deno task verify rag` from the repository root).

See [`.env.example`](.env.example) for all operational defaults. Core settings:

| Variable | Purpose |
| --- | --- |
| `RAG_MONGO_URL` | MongoDB read connection; use a replica-set URI for change streams |
| `RAG_MONGO_DATABASE` | Mycelia database name |
| `RAG_REQUIRE_READONLY_MONGO` | Fail readiness unless Mongo reports only approved read roles |
| `RAG_QDRANT_URL` | Qdrant REST endpoint |
| `RAG_STATE_PATH` | Durable SQLite lifecycle, ledger, and checkpoint file |
| `RAG_MODEL_CACHE` | Durable FastEmbed model cache |
| `RAG_INFERENCE_PROFILE` | Versioned Stage 1 profile (`fastembed-minilm-bm25-v1`) |
| `RAG_FASTEMBED_VERSION` | Required installed FastEmbed version |
| `RAG_DENSE_MODEL`, `RAG_DENSE_REVISION` | Dense model identity and pinned artifact revision |
| `RAG_DENSE_TOKENIZER`, `RAG_DENSE_TOKENIZER_REVISION` | Pinned dense tokenizer identity |
| `RAG_DENSE_*_INSTRUCTION_ID` | Versioned document/query instruction identities (`none` in Stage 1) |
| `RAG_DENSE_DIMENSIONS`, `RAG_DENSE_NORMALIZATION` | Dense output shape and post-processing contract |
| `RAG_SPARSE_MODEL`, `RAG_SPARSE_REVISION` | Sparse model and pinned artifact revision |
| `RAG_RERANKER_ENABLED` | Must remain `false` in Stage 1 |
| `RAG_COLLECTION_PREFIX` | Generation collection and active-alias prefix |
| `RAG_AUTH_MODE` | `none` now, or `internal_token` for bearer-token service auth |
| `RAG_INTERNAL_TOKEN` | Token required by `internal_token` mode |

The inference variables above are explicit deployment evidence, not tuning
knobs for the existing profile. Add a new profile implementation for a different
tuple; after this contract-v2 upgrade, rebuild any legacy active projection
explicitly before search or incremental updates can resume.

`RAG_REQUIRE_READONLY_MONGO=false` is the transitional default because the current
deployment does not yet have dedicated database users. The planned migration is:

1. create a MongoDB principal restricted to `read` on the Mycelia database plus the
   minimum change-stream capability;
2. move the RAG service to that URI and set `RAG_REQUIRE_READONLY_MONGO=true`;
3. verify rebuild, incremental update/delete, reconcile, and search contracts using
   the restricted principal;
4. only then make the read-only requirement the deployment default.

No end-user identity is inferred from `RAG_INTERNAL_TOKEN`. End-user authorization
and per-user projections require a separate data-model migration and remain outside
this module.

## HTTP interface

`/health` confirms only that the API process is serving. `/ready` confirms that the
SQLite active pointer refers to an existing compatible Qdrant collection, repairs
its alias, and enforces the optional read-only-principal gate. An active projection
can remain ready while indexing is degraded, but evidence search still requires a
canonical MongoDB re-read and fails closed if that verification is unavailable.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | process liveness |
| `GET` | `/ready` | active projection readiness |
| `GET` | `/v1/status` | lifecycle, fingerprints, operation progress, source/checkpoint lag, Qdrant stats |
| `POST` | `/v1/search` | hybrid, semantic, or lexical retrieval |
| `GET` | `/v1/chunks` | inspect active projection payloads (limit 1–200, offset 0–10000) |
| `POST` | `/v1/index/rebuild` | enqueue blue/green rebuild |
| `POST` | `/v1/index/reconcile` | enqueue correctness comparison of active projection |
| `POST` | `/v1/index/pause` | pause index mutations; search continues |
| `POST` | `/v1/index/resume` | resume indexing |

All `/v1/*` routes require `Authorization: Bearer <RAG_INTERNAL_TOKEN>` only when
`RAG_AUTH_MODE=internal_token`. Probe routes are intentionally unauthenticated.

Example rebuild and status:

```sh
curl -s -X POST http://127.0.0.1:48091/v1/index/rebuild \
  -H 'content-type: application/json' \
  -d '{"reason":"initial Qdrant projection"}'
curl -s http://127.0.0.1:48091/v1/status
```

Example hybrid search:

```sh
curl -s -X POST http://127.0.0.1:48091/v1/search \
  -H 'content-type: application/json' \
  -d '{
    "query":"где обсуждали срок проекта",
    "mode":"hybrid",
    "kinds":["message"],
    "start":"2026-01-01T00:00:00Z",
    "platforms":["mycelia","telegram"],
    "senderIds":["<canonical messages.senderId>"],
    "sources":[{"collection":"messages","id":"<message id>"}],
    "maxPerSource":2,
    "limit":10
  }'
```

Every result has an `evidenceId`, canonical source/group identity, source revision,
content hash, exact time/link for messages/transcriptions, and message
platform/sender when applicable. Message links carry the exact `messageId`; the
Mycelia UI loads a bounded context and fails visibly if that raw message is no
longer available. The top-level `revalidation` reports how many current MongoDB
sources were checked, how many stale/deleted/mismatched vector candidates were
removed, and how many fresh candidates were excluded by exact canonical interval
refinement. `selection` reports candidate/verified/returned counts and distinct
canonical sources and contexts, making the diversity cap inspectable. Every
search response also includes `freshness` with lifecycle state, pause flag,
`checkpointState`, last durable database checkpoint time, and observed
change-stream lag. With `RAG_ENABLE_BACKGROUND=false`, checkpoint state is
`disabled`, lag is null, and retrieval is explicitly degraded as a manual snapshot.
The global resume token and all per-source checkpoint positions are committed
together only after Qdrant and the SQLite source/chunk ledger have accepted the
event.

Canonical source links point back into the Mycelia UI:

- transcription: `/transcript?start=<ISO>&end=<ISO>`;
- Mycelia/other message: `/chat/<chatId>` or `/messaging/<chatId>`;
- object: `/objects/<id>`;
- media description: `/media?assetId=<assetId>`.

Errors use one envelope:

```json
{
  "error": {
    "code": "projection_not_ready",
    "message": "no active projection; run rebuild first",
    "details": null
  }
}
```

The generated OpenAPI document at `/openapi.json` is the exact request/response
contract, including nullable status fields and lifecycle enums.

## Operational interpretation

- `empty`: no projection has ever been activated;
- `building` / `catching_up`: a blue/green candidate is being prepared while the
  prior active projection, if any, still serves search;
- `ready`: active vector projection exists and normal freshness mechanisms run;
- `reconciling`: active projection is being compared with MongoDB;
- `paused`: an orthogonal status overlay; indexing/cutover waits at safe gates,
  but search continues;
- `degraded`: search may work, while freshness or a dependency needs attention;
- `error`: no valid active projection is available.

The status response includes stable source-schema, chunker, and embedding-space
fingerprints; exact model/tokenizer/instruction contracts; local/remote executor
metadata and lazy-load state; reranker state; generation/build/activation
timestamps; high-watermarks; change-stream state; lag/errors; and Qdrant counts.
Together these show which Mycelia projection is active, where inference runs, and
how current it is without exposing service credentials.

## Current limits and future gates

- The catch-up phase combines a pre-build resume boundary, a second bounded full
  comparison, and change replay; it is not a multi-document MongoDB snapshot
  transaction. Events after the final post-batch token are applied to the newly
  active projection by the same durable stream, and periodic reconcile remains the
  correctness backstop.
- BM25 term statistics are maintained by Qdrant's sparse IDF modifier. The current
  Stage 1 tuple is immutable; adding a different versioned embedding-space
  contract creates a new projection fingerprint and requires a rebuild.
- Quality acceptance against a representative 150–300 query multilingual dataset is
  a later deployment gate. Unit tests use deterministic fakes and never download
  models or require Docker.
- Voice speaker filtering is not yet exposed. Canonical voice identity lives on
  timed diarization segments plus manual annotations, so it requires a
  speaker-aligned transcript evidence projection; attributing a whole transcription
  to one profile would be incorrect.
- Jobs integration is deferred until RAG exposes exact operation lookup/attach and
  cancellation semantics. SQLite remains operation authority; a future BullMQ
  `ragRebuild`/`ragReconcile` wrapper will mirror `processed/total`, phase, errors,
  projection ID, and executor location following the Python integration progress
  pattern rather than starting duplicate work after a backend restart.
- Mem0, graph RAG, rerankers, ACL filtering, read-only database-user migration, and
  per-user authorization are separate follow-up integrations.
