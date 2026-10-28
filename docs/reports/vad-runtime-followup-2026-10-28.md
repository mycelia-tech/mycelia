# Location trigger and VAD runtime follow-up — 2026-10-28

The main stack now runs backend revision
`690cf8a67bd35af9898b3614ebae35fa1be03dce`. The follow-up closes the location-trigger,
Mongo signal-handler activation and VAD-thread-budget items from the
[earlier rollout report](hardening-rollout-2026-10-28.md). This is local deployment
evidence; no remote push or database authentication migration was performed.

## Fixed and verified

The automatic `locationMapProjection` payload now includes its registered job
`type`. The regression test failed on the missing field before the fix, then
passed for startup, interval and change-event reasons. The new backend emitted
`[READY]` without that validation error. Its real automatic job completed
successfully with `processed=500`; existing failed history was retained.

Mongo was recreated with the same image and data bind, keeping only the loopback
host port. Its new PID 1 has a registered SIGTERM handler and Docker's stop grace
is 60 seconds. This loads the previously tested fix that was pending in the
prior report. The old wrapper's shutdown signal was forwarded directly to its
existing `mongod` during the controlled stop. The new wrapper's wait/forwarding
contract was tested on synthetic children, including initialization; a second
live database restart solely to test stopping was not performed.

The Python worker now starts with `OMP_NUM_THREADS=1`, controlled by
`PYTHON_WORKER_OMP_THREADS` in Compose. Its existing 2-CPU quota remains in place.
The Python runtime image/model/inference algorithm were not replaced for this
change; the worker was recreated to load its environment. Frontend was not
recreated by this follow-up. Redis and Qdrant retained their container identities.

## Why this reduces VAD CPU

Before inference, the real Silero initializer already set PyTorch intra-op
threads to one. The executor also reported one, yet the native runtime still
consumed multiple cores. Neither changing the inter-op count nor calling
`torch.set_num_threads(1)` again inside the executor fixed the measured overhead.

Setting **OpenMP before process startup** did. Separate OpenBLAS-only and
MKL-only runs did not reproduce the improvement. The committed
[`python/benchmarks/vad.py`](../../python/benchmarks/vad.py) runs the real VAD
function in an executor, using the trusted existing model cache and its public
25-second speech example. There are no personal recordings or database writes.
Model load/JIT warmup and media decoding are outside the timed inference passes.

| Median of three passes | Original process environment | `OMP_NUM_THREADS=1` |
| --- | --- | --- |
| Wall time for 25 seconds of audio | 3.215 s | 0.404 s |
| Process CPU time | 6.394 s | 0.404 s |

This is approximately **8× faster** with **94% less CPU time** for this sample.
All returned speech probabilities matched exactly across runs. Silence, seeded
noise and a partial window also matched exactly. The unchanged model/sample
hashes and raw measurements are in the
[benchmark artifact](vad-benchmark-2026-10-28.json).

After deployment, the same documented command produced a median of 0.440 seconds
wall/CPU time and identical results. This is not a claim of eightfold improvement
for the complete ingestion pipeline or a broad VAD accuracy evaluation.
OpenMP configuration affects native operations throughout the worker; other
workloads can explicitly override the budget. The container quota is independent.

The [Silero maintainer's guidance](https://github.com/snakers4/silero-vad/discussions/484)
and [PyTorch hub example](https://pytorch.org/hub/snakers4_silero-vad_vad/) recommend
single-thread CPU inference. The local measurements, rather than the reported
PyTorch thread count alone, establish why startup OpenMP configuration was needed
for this installed ARM64 runtime.

## Verification and preservation

- Nine backend trigger tests passed, including the new schema regression.
- Four infrastructure and 26 repository contracts passed; changed TypeScript
  and benchmark Python lint passed. No Mongo integration-test container was started.
- `doctor` passed with the main checkout's mounts, backend production mode,
  health/readiness and private Mongo binding. Authenticated pipeline read: 0.05 s.
  Python reported ready with seven job types; RAG `/ready` returned 200.
- Twenty-four queues resumed. The same two media-recognition queues remained
  paused. A new rollback branch/image and private receipts preserve the prior
  application state and overlapping development notes.
- Redis was not restarted: **32,736,287 historical payloads** remained, along
  with the first stream ID and all ten previously sampled old pending payloads.
  No trim, eviction, flush or historical cleanup was performed.

The private operator receipts are in `.local/rollouts/vad-tuning-690cf8a6/` in the
runtime checkout; they include configuration backups and must not be published.
The rollback branch is `sky/rollback-vad-690cf8a6`; the prior backend image is
`mycelia/rollback-backend:pre-vad-690cf8a6`. Existing unrelated WIP was preserved.

## Remaining host limits and separate work

At a post-deployment idle sample, Python used 0.28% CPU, backend 1.06% and Mongo
3.66%; Redis retained approximately 3.48 GiB intentionally. The host still showed
a high load average (about 51), approximately 10.5 GiB used swap and about 4.5 GiB
free disk. Other observed CPU users included Time Machine settings, Tailscale,
rsync, WindowServer and Docker VM. Their presence is not a full causal diagnosis
of the remaining desktop slowness. No unrelated process or data was removed.

The earlier report's Mongo authorization migration, real operator-backup restore,
historical Redis archival/cleanup and remaining dependency advisory work are
separate stages. Historical Redis cleanup remains explicitly deferred. These
measurements are short controlled checks, not a sustained live-audio acceptance run.
