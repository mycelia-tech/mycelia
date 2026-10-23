# GPU Services

This directory contains Docker Compose configuration for GPU-accelerated AI
services used by Mycelia. The Portainer compose in this directory is STT-only:
it deploys Whisper and the authenticated proxy. Remote speaker diarization has
one canonical Portainer definition in
[`diarizator/compose.portainer.yml`](../diarizator/compose.portainer.yml).

The local-development `gpu/docker-compose.yml` still provides the older
combined Whisper, Ollama, diarization, and proxy setup. Do not use that combined
file or `gpu/docker-compose.portainer.yml` to create a remote diarization stack.

## Services

For one Whisper model shared between existing file transcription and Omi live
audio, see [SHARED_AUDIO.md](SHARED_AUDIO.md). The opt-in
`docker-compose.shared-live.yml` overlay adds scheduling and an internal live
adapter; WhisperLiveKit remains a separate Compose project. The existing
Portainer compose by itself retains the batch-only deployment.
See the [October 23 stability verification](VERIFICATION-2026-10-23.md) for
the deployed WLK follow-up, measured results and long-session limitations.

### Whisper ASR
- **Image**: `onerahmet/openai-whisper-asr-webservice:v1.9.1-gpu`
- **Purpose**: Audio transcription using OpenAI Whisper
- **Port**: Internal only (accessed via proxy)

### Ollama
- **Image**: `ollama/ollama:0.13.5`
- **Purpose**: Local LLM inference with GPU acceleration
- **Port**: Internal only (accessed via proxy)

### Diarization (Speaker Recognition)
- **Remote Portainer stack**: `../diarizator/compose.portainer.yml`
- **Build**: From `../diarizator` Dockerfile
- **Purpose**: Speaker diarization using PyAnnote with voice identification
- **Port**: `8085` (direct access via Tailscale or VPN)
- **Features**:
  - Speaker segmentation (who spoke when)
  - 256-dim speaker embeddings for voice fingerprinting
  - Seeded clustering for matching against enrolled speakers

### Proxy Server
- **Purpose**: API gateway providing:
  - OpenAI-compatible transcription endpoint
  - Authentication
  - Unified API access to Whisper and Ollama

## Prerequisites

- Docker with GPU support (NVIDIA Docker runtime)
- NVIDIA GPU with CUDA support
- Hugging Face account with accepted model agreements

### Hugging Face Setup (Required for Diarization)

1. Get your token from https://huggingface.co/settings/tokens
2. Accept terms for these models:
   - https://huggingface.co/pyannote/speaker-diarization-community-1
   - https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM

## Setup

For a focused Whisper + authenticated proxy deployment in Portainer, see
[PORTAINER.md](PORTAINER.md) and use `docker-compose.portainer.yml`. For remote
diarization, use [`../diarizator/PORTAINER.md`](../diarizator/PORTAINER.md) and
`../diarizator/compose.portainer.yml` instead.

Tested with:
```
NVIDIA GeForce RTX 4090
CUDA 13.0
Driver Version: 580.95.05
VRAM: 24GB (recommended 16GB+ for all services)
```

### 1. Configure Environment

Create the deployment-specific `.env` from its template:

```bash
cp .env.example .env
```

Set both required secrets:

```bash
# Required for proxy authentication
PROXY_API_KEY=your_secret_api_key

# Required for diarization service
HF_TOKEN=your_huggingface_token
```

### 2. Start All Services

```bash
# On your GPU machine
cd mycelia/gpu
docker compose up -d --build
```

This starts Whisper, Ollama, Diarization, and the Proxy.

### 3. Verify Services

```bash
# Check proxy (Whisper + Ollama)
curl http://localhost:8000/health

# Check diarization
curl http://localhost:8085/health
```

### 4. First-Time Model Download

The diarization service downloads ~1.5GB of models on first start. Monitor with:

```bash
docker compose logs -f diarization
```

Wait until you see: `Models ready ✔ – device=cuda`

## Network Access

### Option A: Tailscale (Recommended)

Use Tailscale for secure direct access to services:

```bash
# Install Tailscale on GPU machine
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Get the Tailscale IP
tailscale ip -4
```

Then configure your main Mycelia instance to use:
- `DIARIZATION_SERVER_URL=http://<tailscale-ip>:8085`
- Proxy: `http://<tailscale-ip>:8000`

### Option B: SSH Tunnel

```bash
# From your main server
ssh -L 8085:localhost:8085 -L 8000:localhost:8000 user@gpu-machine
```

## Running on Mac (Apple Silicon)

The diarization service can run on Mac with MPS (Metal Performance Shaders) acceleration, but GPU services require NVIDIA. For Mac development:

### CPU-only Diarization (Slow but works)

```bash
cd diarizator

# Create .env
echo "HF_TOKEN=your_token" > .env
echo "COMPUTE_MODE=cpu" >> .env

# Run with CPU
docker compose --profile cpu up --build
```

### Native Python (Faster on Apple Silicon)

```bash
cd diarizator

# Install with uv
uv sync --extra cpu

# Run service
HF_TOKEN=your_token COMPUTE_MODE=cpu uv run simple-speaker-service
```

Note: Apple Silicon MPS support is experimental in PyAnnote. Performance is ~3-5x slower than NVIDIA GPU.

## VRAM Usage

Approximate VRAM requirements when running all services:

| Service | VRAM (approx) |
|---------|---------------|
| Whisper large-v3-turbo | 4-6 GB |
| Ollama (depends on model) | 4-16 GB |
| Diarization (PyAnnote) | 2-3 GB |
| **Total (with 8B LLM)** | **10-15 GB** |

If you have limited VRAM, consider:
- Using a smaller Whisper model (`ASR_MODEL=small` or `medium`)
- Using a smaller LLM model in Ollama
- Running services on demand rather than all at once

## Troubleshooting

### Diarization service won't start
- Check HF_TOKEN is set correctly
- Verify you accepted terms for all required models on Hugging Face
- Check logs: `docker compose logs diarization`

### Out of VRAM
- Stop unused services: `docker compose stop ollama`
- Use smaller models
- Increase swap (not recommended for performance)

### Models not downloading
- Check internet connectivity
- Verify HF_TOKEN permissions
- Models are cached in `./docker/diarization-models/`
