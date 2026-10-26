# Shared Whisper operation scheduler

The image overlays `onerahmet/openai-whisper-asr-webservice:v1.9.1-gpu` at immutable digest `sha256:1132aa08c6eb9b440408864e8c25733d22a197ffea7c6975d60a4f4b6fd7b08b`. It keeps faster-whisper 1.1.1, CTranslate2 4.4.0 and FastAPI 0.115.14. The upstream MIT-licensed source and license remain in the base image (`/app/LICENCE`); source: https://github.com/ahmetoner/whisper-asr-webservice/tree/v1.9.1. The overlay imports upstream configuration, audio decoding and output writers; it does not text-patch or vendor dependency source.

Exactly one `WhisperModel` instance is loaded per service process. Run exactly one replica/process. A proxy around its CTranslate2 model serializes `encode`, `generate`, `align` and `detect_language`. When both classes wait, it grants four live operations then one batch operation. A running GPU operation cannot be interrupted. Native faster-whisper generators keep the complete uploaded audio, prompt history, seek, VAD mappings, segments and word timestamps; uploaded files are never split into separate requests. Feature extraction configuration is fixed.

`POST /asr` and `/detect-language` keep the upstream multipart/query interface and output writers. `X-ASR-Priority: live` is honored only with a matching `X-ASR-Live-Token: $LIVE_ASR_TOKEN`; absent/invalid credentials use batch priority. Keep this port internal. Decode, feature extraction, generation and serialization run in a bounded thread pool, leaving HTTP responsive.

- `ASR_MAX_REQUESTS=8`: total accepted requests including CPU preparation, waiting, running and suspended generators; excess returns 503 with Retry-After.
- `ASR_REQUEST_TIMEOUT=290`: batch lifetime in seconds after admission.
- `ASR_LIVE_REQUEST_TIMEOUT=55`: live lifetime after admission.
- `MODEL_IDLE_TIMEOUT`: inherited unchanged; 0 disables idle unload. Countdown starts after the last accepted request exits, not at its start. New requests prevent idle unload even while they wait for GPU work.
- Model name, device, quantization, cache and sample rate retain upstream environment settings.

Client disconnect, cancellation and deadline expiry cancel queued/subsequent operations. A currently running native operation completes before upload and admission cleanup. No thread is killed and no model unload is attempted under accepted work. A deadline returns 504 after that cleanup. Whole-file decoding and other CPU calls also finish before their resources can safely be released.

`GET /health` reports service readiness separately from `model_state`. `GET /scheduler` reports active requests, counts by priority, queued and running GPU operations, model state and drain state without secrets. `POST /scheduler/drain` and `/scheduler/resume` require `Authorization: Bearer $LIVE_ASR_TOKEN`. Drain rejects new admissions and lets all accepted work finish; wait for `active_requests=0` and `running_operations=0` before recreating the service.

Run focused tests from the repository root:

```sh
PYTHONPATH=gpu/whisper_shared uv run --with-requirements gpu/whisper_shared/tests/requirements.txt python -m unittest discover -s gpu/whisper_shared/tests -v
```

The tests use deterministic synchronization and stub native operations; they verify admission, scheduling, cancellation, lifecycle, preserved generator/options/words, and HTTP responsiveness. GPU execution and performance still require a real request against the built image.
