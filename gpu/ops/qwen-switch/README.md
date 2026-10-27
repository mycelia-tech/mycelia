# qwen-switch on faeon

User-owned CLI for the existing Qwen and shared audio containers. Python 3's
standard library, Docker CLI and `nvidia-smi` are required. It does not deploy new
models, replace audio images, copy secrets, or create a second Whisper.

`qwen-switch help` and `qwen-switch --help` provide an English guide to profile
selection, each service's purpose, CPU/GPU placement, measured RAM/VRAM and
Qwen weight-file sizes on disk, with dated measurements, control commands and
shutdown behavior. Reading help requires no Docker access and starts no services.

Run on faeon:

```bash
~/.local/bin/qwen-switch help        # profiles, purpose, RAM/VRAM, commands
~/.local/bin/qwen-switch             # menu
~/.local/bin/qwen-switch big-audio    # current combined setup
~/.local/bin/qwen-switch status
~/.local/bin/qwen-switch memory
~/.local/bin/qwen-switch processes
~/.local/bin/qwen-switch diarization live status
~/.local/bin/qwen-switch diarization live start
~/.local/bin/qwen-switch diarization live stop
~/.local/bin/qwen-switch diarization file status
~/.local/bin/qwen-switch diarization file start
~/.local/bin/qwen-switch diarization file stop
```

Interactive Bash already places `~/.local/bin` first. Noninteractive SSH may
resolve the historical root-owned `/usr/local/bin/qwen-switch`; use
`ssh faeon '~/.local/bin/qwen-switch status'`. Check `command -v qwen-switch`
after opening a shell. This installation does not replace the root-owned copy.

## Profiles

| Command | Qwen | Whisper | File diarization | Live Sortformer |
| --- | --- | --- | --- | --- |
| `big-audio` | 27B, 32K, CPU vision projector | GPU | GPU, starts canonical service | CPU, starts live stack |
| `big-asr` | 27B, 32K, CPU vision projector | GPU | Keeps bounded service if running | Stops |
| `audio` | 9B, 64K, text only | GPU | Keeps current state | Starts existing placement |
| `big [profile]` | Selected 27B profile | Stops | Must be stopped first | Stops |
| `stop` | Stops all known Qwen profiles | Keeps current state | Keeps current state | Keeps current state |

`big-audio` records the combination observed on 2026-10-27. It enables
`unless-stopped` for its services, so Docker can restore the selection after a
host restart once the guarded model disk is mounted. Selecting an already
running profile does not restart those services. The disk boot dependency is
covered by [faeon-boot](../faeon-boot/README.md).

Canonical file container: `sky-diarization-candidate-diarization-1-1`, port 8085,
community-1 pyannote on GPU, concurrency 1, queue <= 1, batches at most 8/8/4.
The similarly named legacy `sky-diarization-1` and other candidate replicas are
reported separately and never started by this utility.

Live container: `sky-livekit-wlk-1`, port 8010. It uses WLK 0.2.26, localagreement,
remote `openai-api` Whisper, PCM16 mono 16 kHz, Sortformer and up to 4 labels.
For `big-audio`, its existing deployment must disable CUDA devices explicitly.
The command refuses a GPU/unknown WLK placement instead of silently changing it.
**The base [WLK Compose](../../livekit/compose.yml) requests a GPU and is not this
CPU deployment.** On the verified host the retained CPU image is
`sha256:525ff4bbc90cb47898ffd5d882d212380ddf9e502e121c6bf4c52de9a65cf05b`,
with entrypoint `/opt/omi_cpu_placement_guard.py`, `CUDA_VISIBLE_DEVICES=""`,
`NVIDIA_VISIBLE_DEVICES=void`, no Docker GPU request, 4 Torch threads, 1 interop
thread and 6 GiB container RAM limit. Preserve its existing Compose/configuration
and cached image when updating. This selector starts existing containers;
recreating that CPU image on a new server is a separate deployment operation.

Whisper and file API remain shared. `diarization live start` keeps the current
Qwen profile, starts missing Whisper/proxies/WLK in dependency order, and checks
placement/headroom. `live stop` only stops WLK and its live proxy. `file start`
and `file stop` affect only the canonical file container. Independent controls
preserve restart policies; a manual Docker stop remains stopped across reboot.

## Shutdown and memory limits

File shutdown closes admission and waits for accepted HTTP work using
`docker stop --timeout=-1`, without Docker's usual SIGKILL deadline. A CLI
`--timeout` reports a still-draining service; it does not cancel shutdown or
restart it. Check status before retrying. `--force` deliberately allows a
30-second forced deadline and may interrupt work.

Normal live stop refuses observed established port 8000 connections. Finish the
recording so WLK receives EOF and returns `ready_to_stop`, then stop it. Two
socket snapshots are conservative checks, **not an atomic admission gate**.
`--force` can interrupt a live session; SIGTERM is not the audio EOF protocol
and does not guarantee final buffered preview text. Saved source recordings
are not deleted by this command.

`memory` reports Docker working sets, host used/available RAM, GPU used/free,
and per-service process-attributed VRAM. These are different accounting views,
not additive totals. `processes` also shows CPU container PIDs, including WLK
with zero GPU usage. Unknown metrics remain `?`. Status never wakes models.

Cold-start guards require 3 GiB free for Whisper, 2 GiB for file diarization and 2 GiB
for a GPU WLK. CPU WLK shares host RAM/CPU and saves GPU capacity; it can be slower
under CPU contention. Guards and historical estimates are not peak guarantees.
Details belong in `qwen-switch help`; current readings belong in `memory`.

## Update, verify, roll back

From the Mycelia checkout, run the isolated tests and lint before copying:

```bash
python3 -m unittest discover -s gpu/ops/qwen-switch/tests -v
python3 -m unittest discover -s gpu/ops/qwen-switch -p test_workloads.py -v
ruff check gpu/ops/qwen-switch
```

This host utility intentionally uses system Python's standard library; it does
not require the application's `uv` environment. Copy this folder to a new
user-owned staging directory on faeon, then run there:

```bash
sha256sum /mnt/datadrive/sky-services/projects/qwen/qwen-switch
python3 install.py --expected-sha <the-current-hash>
~/.local/bin/qwen-switch big-audio --dry-run
~/.local/bin/qwen-switch diarization status
```

The installer stores a versioned script/helper pair and the previous pair,
then atomically switches the project command symlink. It needs no sudo and
changes no running containers. It prints a receipt with a rollback script
path. To roll back atomically, link that receipt's `rollback` path to a temporary
symlink beside the project command, then rename it over `qwen-switch`. The helper
is loaded beside the resolved script, so versions stay paired. Keep the release
folder because it holds the previous copy.

After reviewing `--dry-run`, apply `big-audio` to persist the current combination.
Verify fresh status and a bounded real request. See the
[October 27 verification](VERIFICATION-2026-10-27.md); no 60-minute test is part of
installation or profile selection.
