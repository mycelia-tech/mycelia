# Shared WhisperLiveKit frontend

This image pins WhisperLiveKit v0.2.26 at `aceed595a43e9eed5008c142d90a3f6e86747fbf`. The build checks the upstream commit and SHA-256 of every patched source file before applying the overlay. It installs CUDA 12.9 and Sortformer diarization dependencies and the pinned OpenAI client. Whisper transcription always uses the internal `live-asr:8002/v1` listener; no Whisper weights are loaded in this container. Sortformer v2 four-speaker weights are cached in the existing external `sky-livekit_wlk-cache` volume.

Run the commands below from `gpu/livekit` on the deployment host. Copy
`.env.example` to a protected `.env` (mode `0600`) and set the Tailscale address.
Copy `LIVE_ASR_TOKEN` from the protected STT environment: it must be identical
in Whisper, `live-proxy` and WLK. Generate a separate client-facing
`WLK_API_TOKEN`; do not replace the internal token with a new unrelated value.
`WLK_LANGUAGE` defaults to `auto`; set `ru` to force Russian. The Compose network
`sky-audio` and internal `live-asr` alias must already be provided by the proxy
stack. Build and start only after that listener is ready.

Compose also requires the external cache volume `sky-livekit_wlk-cache`.
For a new installation only, create it if it does not exist:

```sh
if ! docker volume inspect sky-livekit_wlk-cache >/dev/null 2>&1; then
  docker volume create sky-livekit_wlk-cache
fi
```

For an existing installation, verify that this is the original cache volume
and preserve it. If it is unexpectedly missing, check the Docker host/context
and previous mounts before creating an empty replacement.

The remote backend coalesces speech into 0.8-second blocks before inference
(`WLK_ASR_COALESCE_MIN_S`). This avoids re-transcribing the growing buffer for
every tiny VAC frame. Silence and EOF flush any remaining shorter block.

Sortformer GPU work runs in a serialized worker rather than the WebSocket event
loop. Cancellation and shutdown join in-flight ASR and Sortformer work before
closing the diarizer and admitting another session. Tail padding, inference and
clock correction form one worker operation, so cancellation cannot shift speaker
timestamps while inference is still using them.

Processing failures retain their original exception for inspection. Logs expose
exception types, HTTP status and traceback locations without remote response
bodies, credentials or transcript text; a failed processor closes the stream
with 1011 and never acknowledges successful EOF. The private ASR timeout/retry
policy is unchanged by this responsiveness update.

```sh
docker compose -p sky-livekit -f compose.yml build wlk
docker compose -p sky-livekit -f compose.yml up -d wlk
docker compose -p sky-livekit -f compose.yml ps wlk
```

The public WebSocket is `ws://<Tailscale IP>:8010/asr` with `Authorization: Bearer <WLK_API_TOKEN>` or `?token=...`. The latter may enter URL logs, so prefer the header. One active `/asr` session is admitted; another receives `{"type":"error","error":"live session busy"}` and close code 4409. The upstream REST transcription and Deepgram WebSocket routes are disabled in this image. Frames are 16 kHz mono PCM16 little endian. An empty binary frame marks EOF; the server drains results, sends `ready_to_stop`, and releases the slot. The default protocol uses full transcript snapshots. The initial config advertises `diarization: true` and `stt_provider: whisperlivekit-remote` only after Sortformer loads. Unattributed text has a null speaker until Sortformer covers it; no named speaker identity is advertised.

Run the offline overlay checks with a local checkout of the pinned upstream commit:

```sh
WLK_UPSTREAM=/path/to/WhisperLiveKit python3 -m unittest discover -s tests -v
```

Use the same `sky-livekit` project name and protected environment for every
update. Choose a fresh `WLK_IMAGE` release tag before building; preserve the
previous image and configuration. Wait for the active stream and native workers
to finish, then recreate only `wlk` with `up -d --no-deps --no-build wlk`.
Keep the external cache volume and shared network. See
[the shared deployment/update procedure](../SHARED_AUDIO.md#updating-an-existing-deployment)
for the coordinated Whisper/Omi steps and rollback boundary.

The image and protocol tests do not prove live model loading, network connectivity, speaker quality, or end-to-end Omi audio. Verify those on the deployment host before reporting live readiness.
