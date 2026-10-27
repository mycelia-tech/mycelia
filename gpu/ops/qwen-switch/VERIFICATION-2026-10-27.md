# Combined Qwen/audio setup verification — 2026-10-27

The observed setup is represented by `qwen-switch big-audio`:

| Service | Placement | Observed image ID prefix |
| --- | --- | --- |
| Qwen 27B ASR, 32K, CPU projector | GPU | dde47811ea25 |
| Shared Whisper large-v3-turbo | GPU | 6a14dad9718b |
| Canonical community-1 file diarizer | GPU | eb4dabb07e7b |
| WLK 0.2.26 Sortformer, 4 labels | CPU, 4 threads | 525ff4bbc90c |

Only one Whisper container/process was present. WLK uses the internal
`live-asr:8002/v1` backend; no cloud ASR was used. The file diarizer's actual
health reported concurrency 1, maxQueued 1, batches 8/8/4 and idle offload 120 s.

## Real bounded inference

A 20-second synthetic two-speaker PCM stream ran 15:53:16–15:53:42 UTC while all
four containers stayed up. It sent 320000 samples, received two speaker labels,
reported diarization enabled in `config`, and completed with `ready_to_stop`.
There were no protocol errors. First committed text appeared 2.253 s after audio
started. Mean audio-relative text lag was 2.096 s; maximum 5.961 s included the final
drain. This is a direct WLK stream, not a physical pendant capture.

WLK ran on CPU: approximately 1.66 GiB peak Docker RAM and about 2.93 CPU cores at
the sampled peak; there was no WLK GPU compute process. The GPU used roughly
21.4–21.8 GiB while Qwen, Whisper and the file diarizer were resident. GPU device
used, driver reservation and reported free are separate values; `memory` now
reads `nvidia-smi memory.free` directly. These short samples are not peak bounds.

Recent Mycelia jobs also completed real summaries and file diarization: one
summary job produced 3 summaries, one diarization job processed 10 chunks and
saved 16 segments with 0 errors, with the next job active. Qwen remained resident
during the live replay, but concurrent Qwen generation during that exact replay
was not established. Earlier file/transcription recovery evidence is in
[the recovery report](../../VERIFICATION-2026-10-27-RECOVERY.md).

## Operational boundaries

The CPU WLK image was already deployed when this selector update began.
Its startup and bounded real inference were verified. The selector preserves
that deployment and refuses `big-audio` if CUDA placement is not explicitly
disabled. The default GPU WLK Compose is not silently converted to CPU.

No 60-minute endurance test or reboot was performed. Sustained live reliability,
simultaneous heavy Qwen generation, and CPU contention remain outside this
bounded check. Active request completion, readiness and model residency are
reported separately; a healthy idle-offloaded file service need not have its
weights loaded on GPU.

## Selector installation and controls

The versioned user command was installed at 15:59 UTC with a retained previous
script/helper pair. SHA256 of the installed selector:
`dd703dbeda04259114d6c8b95265230b4481a2e785db527161c903c7b44cf06a`.
Both local and faeon runs passed 78 isolated tests; Ruff and whitespace checks
passed. Tests cover service scope, placement, memory accounting, bounded
admission, interrupted/timed-out drains, dependency rollback and atomic install.

`big-audio --dry-run` passed, then the profile was applied successfully. Actual
live stop followed by start passed without force. Qwen, Whisper, file proxy and
canonical file diarizer retained their container IDs, images and StartedAt
values. File start was verified as idempotent; file stop was checked with
`--dry-run` and isolated tests to avoid disrupting the active Mycelia backlog.
The combined profile sets `unless-stopped` for all six model/API containers.
A reboot was not performed; boot restoration remains configuration-verified.

The retained rollback selector is under the installed release's `previous/`
folder, as recorded in `receipt.json`. The root-owned historical selector was
not replaced. No containers, volumes, source recordings or caches were deleted.

A second 10-second synthetic stream after the selector's live restart passed:
first text 1.666 s, two speaker labels, acknowledged EOF, no protocol errors.
Before the test there were zero established WLK client connections. Its
before/during/after GPU readings were 21,456 MiB used and **2,706 MiB free** directly
from `nvidia-smi` (24,564 MiB total; the difference includes reserved memory).
Final Docker RAM was Qwen 10.020 GiB, Whisper 2.386 GiB, file diarizer 1.833 GiB and
WLK 1.680 GiB: **15.919 GiB** for these four services. Host available RAM was 32.734 GiB.
The final readings are snapshots; idle offload and active requests change usage.
