# Shared audio verifier

`verify_shared_audio.py` sends an existing PCM16 mono 16 kHz WAV at real-time pace to either WLK `/asr` or Omi `/v4/listen`. It can send concurrent real multipart requests to the existing batch proxy. The JSON report contains only timings and counts; no recognized text, audio, or credential value. The fixture's PCM is repeated to reach `--duration 1800`.

Use Python 3.11+ with `websockets<14` and `httpx`. Omi CV1 mode also needs `opuslib` and the host `libopus` library. Use a temporary virtual environment if the project environment lacks those packages.

Place each Bearer token in its own mode `0600` local file, containing only the token and an optional final newline. Do not use shell command substitutions or put tokens in URLs. Use the new WLK token for `--wlk-url`, the Omi pairing key for `--omi-url`, and the existing batch proxy key for `--batch-key-file`.

```bash
python gpu/scripts/verify_shared_audio.py \
  --wlk-url ws://FAEON_TAILNET_IP:8010/asr \
  --token-file /private/path/wlk-token \
  --fixture /path/to/synthetic-two-speakers.wav \
  --duration 1800 --reconnect-check \
  --batch-url http://FAEON_TAILNET_IP:8001/v1/audio/transcriptions \
  --batch-key-file /private/path/batch-key \
  --batch-interval 60 \
  --json-output /private/path/wlk-30m.json
```

To verify the actual Omi software path, use `--omi-url http://127.0.0.1:21000` and `--token-file` containing the Omi Docker pairing key. This sends 20 ms CV1 Opus frames with `source=omi` through `/v4/listen`, then closes that socket to finalize the recording. Its live transcript metrics come from Omi's `local_transcript_snapshot` messages. WLK mode sends binary PCM16 and explicitly requires `ready_to_stop` after binary EOF. A successful Omi socket run does not itself prove the asynchronous final transcription job completed; inspect the library job and WAV separately. Use generated synthetic speech, such as `/private/tmp/shared-audio-synthetic/synthetic-two-speakers.wav` with its provenance record; private recordings are unnecessary. This fixture can test two voices, not four-speaker accuracy or physical CV1/iPhone reliability.

`--language` sets the Omi `/v4/listen` language parameter. Direct WLK mode uses the server's `WLK_LANGUAGE` setting, which defaults to `auto`; set it in the WLK deployment if a fixed language is needed. Do not append a language query to the URL until the pinned WLK server is shown to support one.

`first_committed_text_s` and `first_speaker_s` are measured from WebSocket connection start. `first_text_after_audio_start_s` excludes connection and Omi preparation; `audio_relative_line_lag` likewise measures new committed line-end observations relative to the start of paced audio. WLK speaker IDs count only when the initial config advertises diarization; Omi speaker IDs come from its projected snapshot, where unknown is `-1`. `last_line_lag_s` includes connection setup. `p95_recent_s` covers the last 1024 new line-end observations, while counts and mean cover the whole run. None of these aggregate metrics proves speaker assignment accuracy or refinement latency.

The verifier counts Omi's literal `ping` frames as heartbeats. It prints technical progress once per minute and retains partial metrics on failure, including fixed WebSocket close codes and whether the client hit a keepalive timeout. Failed or incomplete streams return a failing exit status. Reader failures are propagated even after sending the last audio frame; protocol errors in either the initial stream or reconnect fail acceptance. Only deliberate reader cancellation during cleanup is ignored. Batch success means a real multipart response with a `text` field; words and segment counts are reported without text. For a 30-minute soak, inspect queue depth, GPU memory, model owners, completed Omi jobs, and waveform/WAV duration separately.

Run the verifier's acceptance-report regression checks with `python -m unittest discover -s gpu/scripts/tests -q` from the repository root.
