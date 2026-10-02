# Mycelia Architecture: Resources vs Workers/Jobs

This document explains the two core architectural patterns in Mycelia: **Resources** (synchronous, authorized access) and **Workers/Jobs** (asynchronous background processing).

## Resources

**Resources** are the synchronous abstraction layer for accessing system capabilities with policy-based authorization. They follow a request-response pattern.

### Key Characteristics

- **Location**: `backend/app/lib/*/resource.server.ts`
- **Pattern**: Synchronous request → response
- **Authorization**: Policy-based, enforced via `Auth` context
- **Access**: `auth.getResource<Input, Output>("code")(input)`

### Resource Interface

Every resource implements the `Resource` interface:

```typescript
interface Resource<Input, Output> {
  code: string;                          // Unique identifier (e.g., "mongo", "llm")
  description?: string;                  // Human-readable description
  schemas: {
    request: z.ZodSchema<Input>;         // Input validation
    response: z.ZodSchema<Output>;       // Output validation
  };
  modifiers?: { ... };                   // Optional middleware hooks
  use: (input: Input, auth: Auth) => Promise<Output>;  // Business logic
  extractActions: (input: Input) => ResourceAction[];  // Permission extraction
}
```

### Available Resources

| Resource | Location | Purpose |
|----------|----------|---------|
| `MongoResource` | `lib/mongo/core.server.ts` | Database CRUD operations |
| `FsResource` | `lib/mongo/fs.server.ts` | GridFS file storage |
| `LLMResource` | `lib/llm/resource.server.ts` | LLM/AI model calls |
| `ObjectsResource` | `lib/objects/resource.server.ts` | Domain objects (conversations, uploads, etc.) |
| `TranscriptionResource` | `lib/transcription/resource.server.ts` | Transcription services |
| `TimelineResource` | `lib/timeline/resource.server.ts` | Timeline data queries |
| `JobsResource` | `lib/resources/worker.ts` | Job queue management |
| `MessengerResource` | `lib/messenger/resource.server.ts` | Messaging system |
| `ApiKeysResource` | `lib/auth/apikeys.resource.ts` | API key management |

### Using Resources

```typescript
// Get a typed resource accessor
const mongo = auth.getResource<MongoRequest, MongoResponse>("mongo");

// Call the resource
const users = await mongo({
  action: "find",
  collection: "users",
  query: { active: true },
});
```

Resources can be called:
1. **Locally**: When the resource is registered in the same process
2. **Remotely**: Via HTTP to `/api/resource/{code}` with JWT authentication

---

## Workers / Jobs

**Workers** handle asynchronous background processing using BullMQ/Redis queues. They process long-running tasks triggered by events or schedules.

### Key Characteristics

- **Location**: `backend/workers/*.ts`
- **Pattern**: Event-driven, async background processing
- **Execution**: Isolated child processes with scoped permissions
- **Access**: Workers call resources via JWT-authenticated HTTP

### Worker (JobCapability) Interface

```typescript
interface JobCapability {
  name: string;                          // Job type identifier
  inputSchema: JSONSchema;               // Input validation schema
  outputSchema: JSONSchema;              // Output validation schema
  policies: Policy[];                    // Required permissions
  maxConcurrency?: number;               // Limit concurrent jobs
  triggers?: {                           // Auto-triggering configuration
    sources: JobTriggerSource[];         // Events that trigger this job
    debounceMs?: number;                 // Debounce interval
    interval?: number;                   // Periodic execution (seconds)
  };
  use: (job: Job<JobData>) => Promise<JobResult>;  // Job logic
}
```

### Available Workers

| Worker | File | Purpose | Triggers |
|--------|------|---------|----------|
| `vad` | `vad.ts` | Voice Activity Detection | Event + Interval (5min) |
| `transcription` | `transcription.ts` | Speech-to-text via Whisper | Event + Interval (5min) |
| `transcription_sequence_creator` | `transcription_sequence_creator.ts` | Group audio chunks into sequences | Event + Interval (5min) |
| `diarization` | `diarization.ts` | Speaker identification | Manual |
| `ingestion` | `ingestion.ts` | Audio file processing | Manual |
| `conversation_extractor_merged` | `conversationExtractorMerged.ts` | Extract conversations from transcriptions (single LLM call) | Auto |
| `summarization` | `summarization.ts` | Generate conversation summaries | Auto (after conversation extraction) |
| `histRecalculation` | `histRecalculation.ts` | Recalculate timeline density | Automatic affected UTC days + manual bounded campaigns |

### Timeline Density Maintenance

The Mongo resource records durable write intents and pending UTC days for audio
ingestion, transcription, VAD, date moves, and source deletion. Changes to one
day coalesce for 30 seconds of quiet, with a five-minute batching deadline. A
startup and 30-second reconciler queues one eligible day on the existing
single-concurrency `histRecalculation` worker, respecting paused queues and
manual work. Each run rebuilds and verifies the day's 5-minute, hourly, and
daily buckets and its parent weekly bucket. Pending revisions survive concurrent
writes, queue loss, and process restarts; failed days remain pending for retry.

Verified daily receipts update count evidence against the last exact audit's
per-day baseline. They do not change the full audit timestamp or hide unrelated
issues. The UI distinguishes ordinary **Updating** or **Retry scheduled** states
from repeated failures and unresolved mismatches. Manual audits and bounded
repair campaigns remain available for legacy gaps and direct database writes
outside the resource hooks; rebuilding all history stays manual. See
[Timeline maintenance and recovery](../DEVELOPMENT.md#timeline-density-maintenance-and-rebuild-recovery)
for rollout, freshness, and recovery details.

### Creating a Worker

```typescript
// backend/workers/my-worker.ts
import { z } from "zod";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import { callResource } from "@/lib/jobs/workerLauncher.ts";

const schema = z.object({
  type: z.literal("my-worker"),
  someInput: z.string(),
});

const capability: JobCapability = {
  name: "my-worker",
  inputSchema: z.toJSONSchema(schema),
  outputSchema: z.toJSONSchema(z.object({ processed: z.number() })),
  
  // Declare required permissions (principle of least privilege)
  policies: [
    { resource: "db/my_collection", action: "read", effect: "allow" },
    { resource: "db/my_collection", action: "update", effect: "allow" },
  ],
  
  maxConcurrency: 1,
  
  use: async (job) => {
    // Worker runs in isolated process with MYCELIA_JWT env var
    const jwt = Deno.env.get("MYCELIA_JWT")!;
    const myceliaUrl = Deno.env.get("MYCELIA_URL")!;
    
    // Call resources via HTTP
    const mongo = (input: any) => callResource("mongo", input, { jwt, myceliaUrl });
    
    const items = await mongo({
      action: "find",
      collection: "my_collection",
      query: { status: "pending" },
    });
    
    // Process items...
    await job.updateProgress({ processed: items.length });
    
    return { processed: items.length };
  },
  
  // Optional: Auto-trigger on events
  triggers: {
    sources: [{
      channel: "mycelia:mongo:my_collection",
      name: "new_item",
      filter: { event: "mongo.change", "data.operationType": "insert" },
    }],
    debounceMs: 5000,
    interval: 300, // Also run every 5 minutes
  },
};

export default capability;
```

---

## Key Differences

| Aspect | Resources | Workers/Jobs |
|--------|-----------|--------------|
| **Execution** | Synchronous, in-process | Asynchronous, isolated process |
| **Pattern** | Request → Response | Event/Schedule → Background Processing |
| **Duration** | Short (< 30s typical) | Long (minutes to hours) |
| **Authorization** | Direct Auth context | JWT with scoped permissions |
| **Use Case** | Data access, queries, mutations | Audio processing, ML inference, batch jobs |
| **Failure** | Immediate error response | Retry, dead-letter queue |
| **Progress** | N/A | Progress updates via Redis Streams |

## The Relationship

1. **Resources are the building blocks** - They provide authorized access to system capabilities (database, files, LLM, etc.)

2. **Workers consume resources** - Background jobs use resources to do their work, calling them via JWT-authenticated HTTP

3. **JobsResource bridges both worlds** - It's a Resource that exposes job management capabilities (enqueue, list, cancel, etc.)

### Data Flow Example: Audio Processing Pipeline

```
1. Audio uploaded via API
   └─► FsResource stores file in GridFS

2. Mongo change stream triggers VAD job
   └─► VAD Worker (isolated process)
       └─► Calls MongoResource to read chunks
       └─► Calls Python service for VAD analysis
       └─► Calls MongoResource to update chunks with VAD data

3. VAD completion triggers Transcription Sequence Creator
   └─► Groups speech chunks into sequences
   └─► Calls MongoResource to create sequences

4. Sequence creation triggers Transcription job
   └─► Transcription Worker
       └─► Calls MongoResource to read sequence
       └─► Calls Python Whisper service
       └─► Calls MongoResource to store transcription

5. Transcription triggers Conversation Extractor
   └─► Calls MongoResource and LLMResource
   └─► Creates conversation objects via ObjectsResource
   └─► Enqueues Summarization job via JobsResource
```

---

## When to Use Each

### Use a Resource when:
- You need synchronous, request-response access
- The operation completes quickly (< 30 seconds)
- You're accessing data or calling external APIs
- Authorization needs to flow from the original request

### Use a Worker when:
- The operation takes a long time (> 30 seconds)
- You need to process data in the background
- The task should be triggered by events or schedules
- You need progress tracking and retry logic
- The work involves heavy computation (ML inference, audio processing)

---

## Further Reading

- [JOB_QUEUE.md](JOB_QUEUE.md) - Detailed job queue documentation
- [AUTH.md](AUTH.md) - Authentication and authorization system
- [auth-model.md](auth-model.md) - Policy-based authorization model
- `backend/app/lib/auth/README.md` - Resource system internals
