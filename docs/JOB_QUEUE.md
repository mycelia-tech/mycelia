# Job Queue System

## Voice Identity jobs

- `profileReenrollment`: rebuilds a profile from every linked saved sample and advances its revision.
- `diarization`: `missing` processes only uncovered speech; `build_generation` writes a bounded, cursor-resumable versioned run without changing active data.
- `speakerIdentity`: idempotent matching over stored embeddings for a frozen
  identity model set. It writes one evaluation per profile and projects the
  segment as `identified`, `ambiguous`, `uncertain`, `unknown`, or
  `unclassified`; the initial production set contains only Sky.
- `speakerIdentitySourceIndex`: resumably materializes active
  `runId + embeddingSpaceId` partitions so browser preflight never groups the
  full diarization corpus synchronously.

`speakerMatching` remains a legacy compatibility worker. New historical backfills should use `speakerIdentity`.

Mycelia uses a distributed job queue system with **isolated worker processes** that execute tasks in sandboxed environments with scoped permissions.

## Architecture

```
Client → Deno Server (BullMQ) → Job Processor ──→ Isolated Child Process (Worker)
                ↓                                         ↓
            Redis Queue                          JWT with scoped permissions
                                                          ↓
                                                 ┌────────┴────────┐
                                                 ▼                 ▼
                                         Python FastAPI     Internal Resources
                                         (via HTTP)         (via HTTP callback)
                                                 ▼                 ▼
                                           MongoDB/Redis/Storage
```

### Components

1. **BullMQ (Redis)** - Job queue and state management
2. **Job Processor** - Spawns isolated child processes for each job
3. **Isolated Workers** - Execute in sandboxed Deno processes with:
   - **Short-lived JWT** (15 min expiry) with scoped permissions
   - **Limited file system access** (only SDK directory)
   - **Network access** for callbacks to main process
   - **Process isolation** (crashes don't affect main server)
4. **Worker Types**:
   - **Network Workers**: Delegate to external services (Python FastAPI for AI/ML)
   - **Internal Workers**: Execute TypeScript logic with resource callbacks
5. **Python FastAPI** - Heavy AI/ML computation
6. **Redis Streams** - Real-time progress updates
7. **Resource System** - Scoped database access via JWT-authenticated HTTP API

## Quick Start

### 1. Start Deno Server

```bash
deno run -A server.ts serve
```

This starts:
- Express API server
- BullMQ TypeScript workers
- WebSocket handlers

### 2. Start Python Worker Server (Optional)
Required only for AI/ML tasks (VAD, Transcription, etc.).

```bash
cd python
python3 worker_server.py
```

This starts:
- FastAPI server on port 8000
- VAD, STT, diarization processors

### 3. Enqueue a Job

Jobs are enqueued via the `jobs` resource API.

```bash
curl -X POST http://localhost:3000/api/resource/jobs \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "enqueue",
    "data": {
      "type": "vad",
      "limit": 100
    }
  }'
```

Response:
```json
{
  "success": true,
  "jobId": "67a1b2c3d4e5f6789abcdef0",
  "jobType": "vad"
}
```

### 4. Monitor Progress (SSE)

```bash
curl -N "http://localhost:3000/api/jobs/67a1b2c3d4e5f6789abcdef0/progress?type=vad"
```

Output:
```
data: {"processed":"10","total":"100","hasSpeech":"5","timestamp":"2024-01-15T12:34:56Z"}
data: {"processed":"20","total":"100","hasSpeech":"12","timestamp":"2024-01-15T12:34:57Z"}
...
```

### 5. Check Job Status

```bash
curl "http://localhost:3000/api/jobs/67a1b2c3d4e5f6789abcdef0?type=vad"
```

Response:
```json
{
  "id": "67a1b2c3d4e5f6789abcdef0",
  "type": "vad",
  "state": "completed",
  "progress": {
    "processed": 100,
    "total": 100,
    "hasSpeech": 56
  },
  "result": {
    "processed": 100,
    "hasSpeech": 56,
    "duration": 12.5
  }
}
```

## Job Lifecycle

```
1. WAITING    → Job enqueued in Redis (BullMQ)
2. ACTIVE     → Job processor picks up job
3. ISOLATION  → Processor spawns isolated child process:
                 • Generates short-lived JWT with scoped permissions
                 • Sets MYCELIA_JWT, MYCELIA_URL env vars
                 • Launches worker with limited permissions
4. PROCESSING → Worker executes in sandbox (15-minute job timeout):
                 IF Network Worker: Calls external service (Python FastAPI)
                 IF Internal Worker: Calls back to main process via HTTP
5. COMPLETED  → Worker outputs result to stdout
               → Parent process captures result
               → Updates BullMQ with result
               → Child process exits
6. REMOVED    → After retention period
```

**Job Timeout**: All jobs have a hard 15-minute timeout. If a job exceeds this limit:
- The child process is forcefully terminated (`SIGKILL`)
- The job is marked as failed with error: `"Job timed out after 15 minutes"`
- No retries are attempted for timeout failures

### Security Flow

Each job runs with the **principle of least privilege**:

1. **Job Discovery**: Registry discovers worker manifests with declared permissions
2. **JWT Generation**: Processor creates token with ONLY permissions from manifest
3. **Process Spawn**: Child process receives JWT via environment variable
4. **Scoped Access**: Worker can only access resources specified in its policy
5. **Automatic Expiry**: JWT expires after 15 minutes (prevents token reuse)

## Job Types

All jobs are enqueued via the `jobs` resource.

| Type | Backend | Description | Triggers | Example Body |
|------|---------|-------------|----------|--------------|
| `vad` | Python | Voice Activity Detection (auto-triggered or manual) | Event (debounce 1s), Interval (5min) | `{"action": "enqueue", "data": {"type": "vad", "limit": 1000, "trigger": "manual"}}` |
| `transcription` | Python | Speech-to-text | Event (debounce 5s), Interval (5min) | `{"action": "enqueue", "data": {"type": "transcription", "audioChunkIds": [...]}}` |
| `transcription_sequence_creator` | TypeScript | Create speech sequences from processed chunks (max 30 per job, returns hasMore flag) | Event (debounce 1s), Interval (5min) | `{"action": "enqueue", "data": {"type": "transcription_sequence_creator"}}` |
| `diarization` | Python | Speaker identification | Manual only | `{"action": "enqueue", "data": {"type": "diarization", "start": {"$date": "..."}, "end": {"$date": "..."}}}` |
| `ingestion` | Python | Audio file processing | Manual only | `{"action": "enqueue", "data": {"type": "ingestion", "sourceId": "..."}}` |
| `histRecalculation` | TypeScript | Recalculate timeline histograms | Manual only | `{"action": "enqueue", "data": {"type": "histRecalculation", "all": true}}` |

## Configuration

### Environment Variables

**Main Server (Deno):**
```bash
PYTHON_WORKER_URL=http://localhost:8000  # Python FastAPI URL (Optional if using only TS jobs)
MYCELIA_URL=http://localhost:5173       # Main server URL for worker callbacks
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
SECRET_KEY=your_secret_key_for_jwt      # Required for JWT generation
```

**Worker Process (Auto-set by processor):**
```bash
MYCELIA_JWT=eyJhbG...                    # Short-lived JWT with scoped permissions
MYCELIA_URL=http://localhost:5173       # Server URL for resource callbacks
MYCELIA_WORKER_PATH=file:///.../worker.ts  # Path to worker implementation
```

**Python:**
```bash
MYCELIA_URL=http://localhost:3000        # TypeScript API URL
MYCELIA_API_KEY=your_api_key            # For progress callbacks (legacy)
PORT=8000
```

**Note**: Workers receive `MYCELIA_JWT` automatically from the processor. Never set this manually in production.

### Job Options

When enqueuing jobs:

```typescript
await enqueueJob(data, {
  priority: 1,        // Higher = more priority
  jobId: "custom",    // Optional, defaults to ObjectId
});
```

### Worker Concurrency

Edit `backend/app/lib/jobs/queue.ts`:

```typescript
export function createWorker(type: JobType, processor) {
  return new Worker(getQueueName(type), processor, {
    connection: redis,
    concurrency: 4,  // Change this
  });
}
```

## Creating Workers

Workers are auto-discovered from `backend/app/workers/*.ts` at startup. Each worker declares its capabilities via a manifest.

### Worker Manifest Structure

```typescript
// backend/app/workers/my-worker.ts
import { z } from "zod";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";

const schema = z.object({
  type: z.literal("my-worker"),
  someInput: z.string(),
});

const capability: JobCapability = {
  name: "my-worker",
  inputSchema: (z as any).toJSONSchema(schema),
  outputSchema: { type: "object" },
  policies: [
    { resource: "db/my_collection", action: "read", effect: "allow" },
    { resource: "db/my_collection", action: "update", effect: "allow" },
  ],
  use: async (job) => {
    // Worker logic runs in isolated process
    const auth = await getServerAuth(); // Uses JWT from MYCELIA_JWT env var
    const mongo = auth.getResource("mongo");

    // Do work with scoped permissions
    const result = await mongo({
      action: "find",
      collection: "my_collection",
      query: { someField: job.data.someInput },
    });

    return { success: true, count: result.length };
  },
  maxConcurrency: 1, // Optional: limit concurrent jobs
};

export default capability;
```

### Network Workers (Delegating to External Services)

For workers that call external services (like Python workers):

```typescript
// backend/app/workers/vad.ts
import { NetworkJobCapability } from "./python.ts";

export default new NetworkJobCapability({
  name: "vad",
  schema: vadSchema,
  url: `${PYTHON_WORKER_URL}/jobs/vad`,
  policies: [
    { resource: "db/audio_chunks", action: "read", effect: "allow" },
    { resource: "db/audio_chunks", action: "update", effect: "allow" },
  ],
  maxConcurrency: 1,
});
```

The `NetworkJobCapability` class:
- Automatically attaches `MYCELIA_JWT` to outgoing requests
- Serializes job data with EJSON (handles MongoDB types)
- Forwards job to external service
- Returns deserialized result

### Auto-Discovery

Workers are discovered at server startup:

```typescript
// backend/app/lib/jobs/job-registry.ts
await discoverJobWorkers(); // Scans app/workers/*.ts

// Registers each worker's manifest (NOT implementation)
// Implementation is loaded on-demand in isolated process
```

### Worker Triggers (Auto-Enqueue)

Workers can declare triggers to automatically enqueue jobs in response to events or at regular intervals:

#### Event-Based Triggers

Workers can trigger on Redis Pub/Sub events:

```typescript
const capability: JobCapability = {
  name: "vad",
  // ... other fields
  triggers: {
    sources: [
      {
        channel: "mycelia:mongo:audio_chunks",
        name: "auto_new_chunks",
        filter: {
          event: "mongo.change",
          "data.operationType": "insert",
          "data.document": { $exists: true },
          "data.document.vad": { $exists: false },
        },
      },
    ],
    debounceMs: 1000, // Wait 1s after last event before enqueueing
  },
};
```

#### Interval-Based Triggers

Workers can also trigger at regular intervals:

```typescript
const capability: JobCapability = {
  name: "transcription",
  // ... other fields
  triggers: {
    sources: [
      // Event-based triggers can be combined with intervals
    ],
    debounceMs: 5000,
    interval: 300, // Trigger every 300 seconds (5 minutes)
  },
};
```

**Filter Syntax**: Uses [Sift](https://github.com/crcn/sift.js) MongoDB-style queries for declarative event filtering.

**How It Works**:

**Event Triggers**:
1. Redis Pub/Sub messages arrive on `channel`
2. Filter is evaluated against message payload
3. If matches, job is debounced and enqueued
4. Trigger metadata is added to job data: `{ trigger: { type: "auto", reason: "auto_new_chunks", principal: "server" } }`

**Interval Triggers**:
1. `TriggerManager` sets up `setInterval` for the specified duration
2. At each interval, checks if job should run (respects `maxConcurrency` and `requireIdle`)
3. If conditions met, enqueues job with reason: `"interval:{intervalSeconds}s"`
4. Intervals are cleaned up when server shuts down

**Interval Options**:
- `requireIdle: true` - Only trigger if no jobs of this type are currently running (waiting/active)
- Intervals run in non-test environments only

See [VAD_TRIGGERING.md](./VAD_TRIGGERING.md) for detailed examples.

## Progress Callbacks

Python workers send progress updates:

```python
progress_callback({
    "processed": 50,
    "total": 100,
    "currentItem": "chunk_abc123",
    "customField": "anything",
})
```

This triggers:
1. `POST /api/resource/jobs` (authenticated)
2. Updates BullMQ job progress
3. Publishes to Redis Stream: `progress:{type}:{jobId}`
4. Clients receive via SSE

## Maintenance

The system includes a **Maintenance Manager** that runs every minute to ensure job queue consistency and handle edge cases.

### Maintenance Tasks

1. **Timeout Cleanup**: Cancels jobs that have been active longer than 15 minutes (backup mechanism if processor timeout fails)
2. **Queue Synchronization**: Re-enqueues jobs that exist in database but are missing from BullMQ queue (after 2-minute grace period)
3. **Diarizator Admission Watchdog**: Recovers deferred diarizator jobs only if
   an event-driven completion/failure/cancellation drain was missed

**Implementation** (`backend/app/lib/jobs/maintenance-manager.ts`):
- Runs every 60 seconds
- Processes up to 500 jobs per maintenance cycle
- Updates job states and publishes events for cancelled/re-enqueued jobs
- Does not pace normal diarizator admission; available GPU slots are filled by
  terminal queue events

## Error Handling

### Retries

Jobs do not automatically retry on failure:
- 1 attempt max (no retries)
- Jobs that fail will not be retried automatically

### Failed Jobs

Query failed jobs:

```bash
curl "http://localhost:3000/api/jobs/{jobId}?type=vad"
```

Response for failed job:
```json
{
  "state": "failed",
  "failedReason": "Python worker failed (500): Division by zero",
  "attemptsMade": 3,
  "timestamp": 1705320896000,
  "failedOn": 1705320920000
}
```

### Manual Retry

Failed jobs can be retried:

```typescript
const queue = getQueue("vad");
const job = await queue.getJob(jobId);
await job.retry();
```

## Monitoring

### Redis CLI

```bash
redis-cli

# List waiting jobs
LRANGE bull:jobs:vad:wait 0 -1

# List active jobs
LRANGE bull:jobs:vad:active 0 -1

# Get job details
HGETALL bull:jobs:vad:67a1b2c3d4e5f6789abcdef0

# View progress stream
XREAD STREAMS progress:vad:67a1b2c3d4e5f6789abcdef0 0
```

### BullMQ Dashboard

Install Bull Board (optional):

```bash
npm install @bull-board/express bullmq
```

Add to server:

```typescript
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [new BullMQAdapter(vadQueue)],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());
```

Visit: `http://localhost:3000/admin/queues`

## Best Practices

### 1. Keep Jobs Idempotent

Jobs should be safely retryable:

```python
# Bad - not idempotent
def process_job(data):
    count = get_count()
    set_count(count + 1)

# Good - idempotent
def process_job(data):
    mark_as_processed(data.item_id)
```

### 2. Send Progress Regularly

Update progress every ~30 items or 5 seconds:

```python
for i, item in enumerate(items):
    process_item(item)

    if i % 30 == 0:
        progress_callback({"processed": i})
```

### 3. Use Batch Operations

MongoDB bulk operations are faster:

```python
# Good
apply_updates([
    (id1, update1),
    (id2, update2),
])

# Bad
for id, update in updates:
    mongo.updateOne(id, update)
```

### 4. Set Appropriate Limits

Don't process unlimited data in one job:

```python
# Request with limit
{
  "limit": 1000,
  "batchSize": 100
}
```

### 5. Clean Up Resources

```python
try:
    model = load_model()
    result = process(model, data)
finally:
    cleanup_model(model)
```

## Scaling

### Horizontal - More Workers

TypeScript (in server process):
```typescript
// Edit backend/app/lib/jobs/workers.ts
const JOB_TYPES = ["vad", "transcription", "diarization", "histRecalculation"];

// Each type gets its own worker
// Run multiple Deno server instances
```

Python (separate processes):
```bash
# Terminal 1
PORT=8000 python3 worker_server.py

# Terminal 2
PORT=8001 python3 worker_server.py

# Use load balancer
export PYTHON_WORKER_URL=http://lb:80
```

### Vertical - More Resources

```bash
# TypeScript: More concurrent jobs per worker
concurrency: 8

# Python: GPU acceleration
export CUDA_VISIBLE_DEVICES=0,1
```

## Debugging

### Enable Debug Logs

TypeScript:
```typescript
worker.on("active", (job) => {
  console.log(`[DEBUG] Processing ${job.id}`);
});
```

Python:
```python
logging.basicConfig(level=logging.DEBUG)
```

### Test Jobs Manually

Python without TypeScript:
```bash
curl -X POST http://localhost:8000/jobs/vad \
  -H "Content-Type: application/json" \
  -d '{"jobId": "test", "data": {"limit": 5}}'
```

Test Worker in Isolation:
```bash
# Set required env vars
export MYCELIA_JWT=$(deno run -A scripts/generate-test-jwt.ts)
export MYCELIA_URL=http://localhost:5173
export MYCELIA_WORKER_PATH=file:///path/to/worker.ts

# Run worker launcher
deno run -A backend/app/lib/jobs/workerLauncher.ts < test-job-data.json
```

## Security & Isolation

### Permission Model

Each worker declares its required permissions in its manifest:

```typescript
policies: [
  { resource: "db/audio_chunks", action: "read", effect: "allow" },
  { resource: "db/audio_chunks", action: "update", effect: "allow" },
]
```

**What This Means**:
- Worker can ONLY access `audio_chunks` collection
- Cannot read from `users`, `configs`, or other collections
- Cannot write to other collections
- Cannot escalate privileges

### JWT Lifecycle

1. **Generation**: When job starts, processor generates JWT with:
   - `principal`: `job:{jobId}` (unique identity)
   - `policies`: Exact list from worker manifest
   - `exp`: 15 minutes from now

2. **Usage**: Worker receives JWT via `MYCELIA_JWT` environment variable
   - Automatically attached to all resource calls
   - Cannot be modified or regenerated by worker

3. **Expiration**: After 15 minutes, JWT becomes invalid
   - Long-running jobs should complete within window
   - Prevents token reuse after job completion

### Process Isolation

Workers run in separate Deno processes with limited permissions:

```bash
deno run \
  -E                                    # Allow env access (for MYCELIA_JWT)
  --allow-read=/path/to/sdk             # Only SDK directory
  --allow-net                           # Network for callbacks
  workerLauncher.ts
```

**Benefits**:
- Worker crash doesn't affect main server
- Memory leaks are isolated
- CPU-intensive work doesn't block main event loop
- Clear audit trail per job (`job:123` principal)

### Security Best Practices

1. **Declare Minimal Permissions**: Only request resources you need
   ```typescript
   // Good
   policies: [{ resource: "db/audio_chunks", action: "read", effect: "allow" }]

   // Bad (overly permissive)
   policies: [{ resource: "**", action: "*", effect: "allow" }]
   ```

2. **Validate Input**: Workers should validate job data against schema


## VAD Auto-Triggering

The VAD job type has **automatic triggering** enabled via the unified `TriggerManager`. See [VAD_TRIGGERING.md](./VAD_TRIGGERING.md) for details.

Key features:
- **Auto-triggered on new chunks**: When audio chunks arrive, VAD jobs are automatically enqueued after a configurable debounce (default 5s)
- **Principal injection**: Every job automatically captures the `principal` (user ID or `server`) that initiated it
- **Duplicate prevention**: Max concurrency is enforced by checking active jobs in MongoDB before enqueuing
- **Trigger tracking**: Each job tracks its trigger state: `{ type: "manual" | "auto", reason: string, principal: string }`

To manually enqueue a VAD job:
```bash
curl -X POST http://localhost:3000/api/resource/jobs \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "enqueue",
    "data": {
      "type": "vad",
      "limit": 1000
    },
    "trigger": {
      "type": "manual",
      "reason": "user_request"
    }
  }'
```

## See Also

- [VAD_TRIGGERING.md](./VAD_TRIGGERING.md) - VAD auto-triggering system
- [WORKER_SERVER.md](../python/WORKER_SERVER.md) - Python FastAPI details
- [BullMQ Docs](https://docs.bullmq.io/) - Queue documentation
- [FastAPI Docs](https://fastapi.tiangolo.com/) - Python framework
