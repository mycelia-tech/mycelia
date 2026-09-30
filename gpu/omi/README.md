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

From the Omi repository, after the current recording finishes and the app can
be recreated, set `OMI_COMPAT_CONTEXT` to the absolute path of this directory
and run the following with Omi's external STT configuration:

```sh
export OMI_COMPAT_CONTEXT=/path/to/mycelia/gpu/omi
export OMI_DOCKER_STT=external
docker compose -f compose.yaml -f compose.external.yaml \
  -f "$OMI_COMPAT_CONTEXT/compose.override.yaml" build app
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=64m \
  -e PYTHONPATH=/opt/omiloc/backend:/opt/omiloc/scripts/dev-harness \
  --mount "type=bind,src=$OMI_COMPAT_CONTEXT/tests,dst=/compat-tests,readonly" \
  --entrypoint python mycelia/omiloc-app-audio-compat-r4:2026-10-01 \
  /compat-tests/test_overlay.py
docker compose -f compose.yaml -f compose.external.yaml \
  -f "$OMI_COMPAT_CONTEXT/compose.override.yaml" up -d --no-deps --no-build app
```

Use the same three Compose files for later app updates; Omi's plain `docker.sh
up` rebuilds its standard image. The state volume and ingress are inherited
unchanged. Verify `/v1/health`, the local library, the active Live profile,
and a newly completed synthetic recording before treating the patch as live.
The existing terminal `failed` STT queue entry is not retried by this image
change alone; recover that job separately after confirming the new worker.
