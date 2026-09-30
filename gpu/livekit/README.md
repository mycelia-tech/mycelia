# Shared WhisperLiveKit frontend

This image pins WhisperLiveKit v0.2.26 at `aceed595a43e9eed5008c142d90a3f6e86747fbf`. The build checks the upstream commit and SHA-256 of every patched source file before applying the overlay. It installs CUDA 12.9 and Sortformer diarization dependencies and the pinned OpenAI client. Whisper transcription always uses the internal `live-asr:8002/v1` listener; no Whisper weights are loaded in this container. Sortformer v2 four-speaker weights are cached in the existing external `sky-livekit_wlk-cache` volume.

Copy `.env.example` to a protected `.env` on the deployment host and set the Tailscale address and two distinct tokens. `WLK_LANGUAGE` defaults to `auto`; set `ru` to force Russian. The Compose network `sky-audio` and internal `live-asr` alias must already be provided by the proxy stack. Build and start only after that listener is ready:

The remote backend coalesces speech into 0.8-second blocks before inference
(`WLK_ASR_COALESCE_MIN_S`). This avoids re-transcribing the growing buffer for
every tiny VAC frame. Silence and EOF flush any remaining shorter block.

```sh
docker compose -f compose.yml build wlk
docker compose -f compose.yml up -d wlk
docker compose -f compose.yml ps wlk
```

The public WebSocket is `ws://<Tailscale IP>:8010/asr` with `Authorization: Bearer <WLK_API_TOKEN>` or `?token=...`. The latter may enter URL logs, so prefer the header. One active `/asr` session is admitted; another receives `{"type":"error","error":"live session busy"}` and close code 4409. The upstream REST transcription and Deepgram WebSocket routes are disabled in this image. Frames are 16 kHz mono PCM16 little endian. An empty binary frame marks EOF; the server drains results, sends `ready_to_stop`, and releases the slot. The default protocol uses full transcript snapshots. The initial config advertises `diarization: true` and `stt_provider: whisperlivekit-remote` only after Sortformer loads. Unattributed text has a null speaker until Sortformer covers it; no named speaker identity is advertised.

Run the offline overlay checks with a local checkout of the pinned upstream commit:

```sh
WLK_UPSTREAM=/path/to/WhisperLiveKit python3 -m unittest discover -s tests -v
```

The image and protocol tests do not prove live model loading, network connectivity, speaker quality, or end-to-end Omi audio. Verify those on the deployment host before reporting live readiness.
