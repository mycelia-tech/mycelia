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
October 1 verification report. The current Compose override selects the r5
image described below, built from the retained r4 image.

Use the same three Compose files for later app updates; Omi's plain `docker.sh
up` rebuilds its standard image. The state volume and ingress are inherited
unchanged. Verify `/v1/health`, the local library, the active Live profile,
and a newly completed synthetic recording before treating the patch as live.
The existing terminal `failed` STT queue entry is not retried by this image
change alone; recover that job separately after confirming the new worker.

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
  sha256:c8b35eacf0c97aac57575be9d714c54a2888bed957fce9ddefc8b728ade8d26f
docker build --network none --pull=false -f "$OMI_COMPAT_CONTEXT/Dockerfile.reconnect" \
  -t mycelia/omiloc-app-audio-compat-r5:2026-10-23 "$OMI_COMPAT_CONTEXT"
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m \
  -e PYTHONPATH=/opt/omiloc/backend:/opt/omiloc/scripts/dev-harness \
  --mount "type=bind,src=$OMI_COMPAT_CONTEXT/tests,dst=/compat-tests,readonly" \
  --entrypoint python mycelia/omiloc-app-audio-compat-r5:2026-10-23 \
  -B /compat-tests/test_reconnect.py
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m \
  -e PYTHONPATH=/opt/omiloc/backend:/opt/omiloc/scripts/dev-harness \
  --mount "type=bind,src=$OMI_COMPAT_CONTEXT/tests,dst=/compat-tests,readonly" \
  --entrypoint python mycelia/omiloc-app-audio-compat-r5:2026-10-23 \
  -B /compat-tests/test_overlay.py
```

After active captures and final jobs finish, preserve the old image and private
Compose configuration, then replace only the app:

```sh
docker compose -f compose.yaml -f compose.external.yaml \
  -f "$OMI_COMPAT_CONTEXT/compose.override.yaml" up -d --no-deps --no-build app
```

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
