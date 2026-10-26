# Omi Docker audio compatibility image

The verified Omi app image is native arm64, but its automatic final transcription
worker can spend over 60 seconds loading the backend import preflight under the
current Docker Desktop load. The worker then fails before it writes an STT
manifest. The backend also durably rewrites capture progress metadata for every
20 ms audio packet on its WebSocket event loop, which can delay keepalives under
disk pressure. This overlay raises the import subprocess timeout from 60 to 180
seconds and limits progress metadata checkpoints to once per second after the
first audio packet. PCM writes and final WAV/metadata fsync remain unchanged;
crash recovery obtains audio duration from the actual PCM file, while technical
frame/error counters can lag by up to one second after an abrupt crash. The
Docker supervisor also retries only a timed-out paired-owner Firestore read
within a 120-second retry window after emulator ports open, because imported emulator
data can become readable later than its TCP listener. Owner creation remains
idempotent; other errors still abort startup, and stop requests end the retry.
The provider relay has a 60-second readiness window because its cold import
exceeded the image's previous six-second poll budget under load; the relay's
own `/health` response must still report ready.
The Docker supervisor waits up to 300 seconds for all three local Firestore,
Auth, and Redis TCP listeners, and names any listeners still closed at timeout.
Its canonical entrypoint prints a traceback on startup failure while preserving
the original nonzero exit and Compose restart policy.
The build refuses source files that differ from the verified running image hashes
in `patch_audio_compat.py`. It keeps Omi's offline credential and network
guards and does not read the dirty Omi checkout into the image.

The original r4 build remains in `Dockerfile` / `patch_audio_compat.py` and the
October 1 verification report. The current Compose override selects r7, built
from the retained r5 image. It includes all r4 and r5 compatibility fixes.

Use the same three Compose files for later app updates; Omi's plain `docker.sh
up` rebuilds its standard image. The state volume and ingress are inherited
unchanged. Verify `/v1/health`, the local library, the active Live profile,
and a newly completed synthetic recording before treating the patch as live.
The existing terminal `failed` STT queue entry is not retried by this image
change alone; recover that job separately after confirming the new worker.

## Installation prerequisites and image chain

This directory contains overlays for the retained **Linux arm64 Omi image**,
not a standalone build of Omi from a fresh checkout. Before installation:

1. Set up the shared GPU services and authenticated providers as described in
   [SHARED_AUDIO.md](../SHARED_AUDIO.md). The Mac needs Tailscale reachability to
   live WLK on `:8010` and final Whisper on `:8001`; it does not load these GPU
   models locally.
2. Keep the Omi deployment's `compose.yaml`, `compose.external.yaml`, pairing,
   provider configuration and state volume. The verified Mac volume is
   `omiloc-docker_state`. A new Omi installation needs its normal initial setup
   and pairing before the overlay can be verified.
3. Obtain the retained base image from the deployment's private image archive.
   These local tags are not published registry releases. A Git checkout alone
   does not supply the base image. Keep credentials and image/configuration
   archives out of Git.

| Stage | Dockerfile | Required input | Result |
|---|---|---|---|
| r4 compatibility | `Dockerfile` | Recorded stock Omi image; all four source hashes must match `patch_audio_compat.py` | r4 base |
| r5 reconnect | `Dockerfile.reconnect` | Retained r4; two guarded source files | r5 base |
| r7 rotation and diagnostics | `Dockerfile.rotation` | Retained r5; preview source hash checked by `patch_live_rotation.py` | Current Compose image |

On a fresh host, load the retained r4 or r5 archive with `docker image load -i
/path/to/private-image.tar`, then verify its ID using the build commands below.
With r4, build r5 first, then r7. With r5 already present, build only r7. There is
no need to install r6 between r5 and r7. Each build uses the image contents;
none copies the current Omi checkout into the image.

If only the original stock-image archive is available, first set
`OMI_RECORDED_BASE_IMAGE` to its verified local image ID and build r4:

```sh
export OMI_COMPAT_CONTEXT=/path/to/mycelia/gpu/omi
docker build --network none --pull=false -f "$OMI_COMPAT_CONTEXT/Dockerfile" \
  --build-arg OMI_BASE_IMAGE="$OMI_RECORDED_BASE_IMAGE" \
  -t mycelia/omiloc-app-audio-compat-r4:2026-10-01 "$OMI_COMPAT_CONTEXT"
```

The following ID checks refer to the retained, tested images. A rebuild can
produce a different image ID: stop and review its source hashes and provenance
before recording a replacement base. Do not remove a patch's hash guards or
substitute an arbitrary latest Omi image to make the build succeed.

## Continuous capture with 30-minute live windows (r7, 2026-10-23)

`Dockerfile.rotation` adds planned 1800-second live windows while keeping one
Omi recording, decoder, WAV and final-transcription job. Previous transcript
rows and absolute timestamps remain visible. Each window gets fresh anonymous
speaker IDs; matching a person across windows is not inferred from its local
speaker number. See [the rotation contract and tradeoffs](ROTATION.md).

The r7 overlay also records bounded technical failure diagnostics: exception
class, code locations, window/sample counters and numeric timestamp context.
It excludes transcript text, credentials, URLs and arbitrary exception messages.
Logs are written to `/data/harness/docker/logs/backend.log`; `docker logs` alone
does not contain these preview lifecycle records. r7 does not change failure,
timeout or retry behavior from r6.

The [rotation follow-up report](../VERIFICATION-2026-10-23-ROTATION.md) records
the deployed images, the successful 15-minute diagnostic and the failed longer
runs. The first r6 replay lost live preview around 700 seconds; its complete
880.6-second WAV and fresh final-transcription job were independently verified.

The subsequent r7 replay stopped after **2481.9 seconds** with `stt_failed`,
after one successful 1800-second rollover. First text after that rollover took
**8.221 seconds**, exceeding the 5-second guide. The captured PCM matched the
retained WAV, but the full 61-minute live/final-job acceptance did not pass.
Another long replay is deferred at the user's request; continuous reliability
is not established by the shorter successful diagnostic or the image tests.

The overlay verifies the exact r5 preview source before installation. Build
from the retained image rather than copying a modified Omi checkout:

```sh
export OMI_COMPAT_CONTEXT=/path/to/mycelia/gpu/omi
export OMI_DOCKER_STT=external
test "$(docker image inspect mycelia/omiloc-app-audio-compat-r5:2026-10-23 --format '{{.Id}}')" = \
  sha256:e44327794d5a92f9feed491f09b10e714a713f2d0e49baae3deb8ae5d719d6a9 &&
docker build --network none --pull=false -f "$OMI_COMPAT_CONTEXT/Dockerfile.rotation" \
  -t mycelia/omiloc-app-audio-compat-r7:2026-10-23 "$OMI_COMPAT_CONTEXT" &&
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m \
  -e PYTHONPATH=/opt/omiloc/backend:/opt/omiloc/scripts/dev-harness \
  --mount "type=bind,src=$OMI_COMPAT_CONTEXT/tests,dst=/compat-tests,readonly" \
  --entrypoint python mycelia/omiloc-app-audio-compat-r7:2026-10-23 \
  -B -m unittest discover -s /compat-tests -p 'test_*.py'
```

The image suite covers 18 rotation checks, four diagnostic checks, 17 reconnect
checks and nine retained compatibility checks (48 total). The WAV tests use the actual capture writer and decoded-PCM delivery hook
from the image without network access or the state volume. Opus decoding is
verified separately by the real recording replay.

### Updating an existing installation

Build and run the focused image tests before touching the running app. For a
later release, use a new image tag and select that tag in the deployment's copy
of the override; retain the previous tag and image ID for rollback. Reuse the
same base image unless its source change has been reviewed.

Before replacing the app, confirm that capture is idle and the final-processing
queue has no running jobs. Save the **currently running** image ID and image
archive, the original Compose project name, and a private rendered copy of its
current Compose configuration. Save these before changing the desired release;
the rollback configuration must point at the old running image. Rendered
Compose can contain secrets: use a private directory and mode `0600`, never
print or commit it. Preserve a consistent backup of the state volume, including
provider secrets, pairing, queued jobs and recordings; take it with the idle app
stopped rather than copying a changing emulator database.

From the Omi deployment directory, keep both environment variables set and use
all three Compose files. Validate the proposed configuration privately: only
the intended app image/build should change, with the same volume, ports and
ingress. Then replace only the app:

```sh
export OMI_COMPAT_CONTEXT=/path/to/mycelia/gpu/omi
export OMI_DOCKER_STT=external
docker compose -f compose.yaml -f compose.external.yaml \
  -f "$OMI_COMPAT_CONTEXT/compose.override.yaml" config --quiet &&
docker compose -f compose.yaml -f compose.external.yaml \
  -f "$OMI_COMPAT_CONTEXT/compose.override.yaml" up -d --no-deps --no-build app
```

Check the actual container image ID, unchanged state volume and ingress
container, healthy status, `Docker runtime ready`, authenticated provider
profile, and a newly completed recording with its final job. Inspect preview
lifecycle events in `backend.log`. Record which checks actually ran; startup,
image tests and a short recording do not establish long-session reliability.
An ordinary app update does not require stopping the shared GPU services or
running `docker.sh down`. Keep the third override for every later app start;
plain `docker.sh up` rebuilds the standard image.

### Rollback

After capture and final processing are idle, use the saved rendered Compose
configuration and its retained image to recreate only `app`, with the **same
Compose project name**. For the recorded `omiloc-docker` deployment:

```sh
docker compose -p omiloc-docker -f "$OMI_AUDIO_ROLLBACK/compose.yaml" \
  up -d --no-deps --no-build app
```

Set `OMI_AUDIO_ROLLBACK` to the private directory prepared before the update.
The saved r6 image retains rotation without r7 diagnostics; the saved r5 image
retains reconnect handling without rotation. A rollback is not evidence that
either version is reliable for an hour. Keep `omiloc-docker_state` in place and
verify image/readiness/provider selection afterward. Never use `down -v` or
remove the volume; restore state from backup only as a separate recovery action.

## Immediate reconnect admission (r5, 2026-10-23)

Omi can start a new capture while the previous preview is still draining its final
WLK results. The shared WLK server correctly rejects a second live session with
`4409` / `live session busy`. The r4 relay treated that expected admission response
as a permanent protocol error, leaving the new capture with a valid WAV and final
file transcription but no live preview.

`Dockerfile.reconnect` adds an overlay to the retained r4 image. It retries only
that explicit busy response **before** a valid WLK config and before sending any
PCM. All attempts, connect/receive work, context close and backoff share one
45-second admission budget. Cancellation or deadline aborts the provisional
transport; exhausting the total busy-admission budget reports
`live_preview_busy`. Individual connect/config timeouts keep their original error.
Authentication, invalid config, connection failures and failures after accepted
audio do not retry or replay audio.

The backend already buffers up to 60 seconds of PCM for preview while saving the
recording independently. Its relay-only handshake wait increases from 12 to 50
seconds; non-relay handshakes remain 3 seconds. The relay does not consume PCM or
announce live readiness until the provider config is valid. The early Omi
`provider=offline_capture` ready event continues to describe WAV capture, not WLK
readiness. Capture, final transcription and existing r4 fixes are unchanged.

The source-hash guard accepts these exact deployed r4 files, checks both before
writing either, and rejects source drift:

| File | SHA256 |
|---|---|
| `dev_harness/local_provider_relay.py` | `7e6949150356ae07149b025fda1b87b7b5bb2220824de8bed14fa14c1dd9c43e` |
| `backend/utils/local_live_preview.py` | `17110ccb83444d8a46cd493bfa40f3c7c78c3efa80bac579117a45b4bf99c70d` |

From the Omi repository, set the absolute overlay directory and verify the
retained local base image ID. This build does not copy the Omi checkout:

```sh
export OMI_COMPAT_CONTEXT=/path/to/mycelia/gpu/omi
export OMI_DOCKER_STT=external
test "$(docker image inspect mycelia/omiloc-app-audio-compat-r4:2026-10-01 --format '{{.Id}}')" = \
  sha256:c8b35eacf0c97aac57575be9d714c54a2888bed957fce9ddefc8b728ade8d26f &&
docker build --network none --pull=false -f "$OMI_COMPAT_CONTEXT/Dockerfile.reconnect" \
  -t mycelia/omiloc-app-audio-compat-r5:2026-10-23 "$OMI_COMPAT_CONTEXT" &&
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m \
  -e PYTHONPATH=/opt/omiloc/backend:/opt/omiloc/scripts/dev-harness \
  --mount "type=bind,src=$OMI_COMPAT_CONTEXT/tests,dst=/compat-tests,readonly" \
  --entrypoint python mycelia/omiloc-app-audio-compat-r5:2026-10-23 \
  -B /compat-tests/test_reconnect.py &&
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m \
  -e PYTHONPATH=/opt/omiloc/backend:/opt/omiloc/scripts/dev-harness \
  --mount "type=bind,src=$OMI_COMPAT_CONTEXT/tests,dst=/compat-tests,readonly" \
  --entrypoint python mycelia/omiloc-app-audio-compat-r5:2026-10-23 \
  -B /compat-tests/test_overlay.py
```

The r5 commands above document the retained base build. The current Compose
override deploys r7; use the r7 build and deployment instructions above.

The network-free suite exercises busy-frame and close-code retries, exact PCM
ordering/preservation, no consumption before config, cancellation, cumulative
and context-close deadlines, non-retryable failures, no post-admission replay,
and the unchanged PCM capacity bound. Recreate only the idle app service after
recording the active Compose image and rollback reference. A real Omi immediate
reconnect and completed final WAV jobs remain deployment acceptance checks;
passing unit tests alone does not establish the deployed behavior.

The [October 23 verification report](../VERIFICATION-2026-10-23.md) records the
deployed r5 replay, immediate reconnect, final-record provenance, measured
latency and the remaining long-session limits.
