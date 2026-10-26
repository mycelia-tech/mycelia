FROM ghcr.io/astral-sh/uv:0.12.3 AS uvbin

FROM nvidia/cuda:12.9.2-cudnn-devel-ubuntu24.04 AS builder
ENV DEBIAN_FRONTEND=noninteractive UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1
ENV UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_INSTALL_DIR=/python
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential python3-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=uvbin /uv /uvx /bin/
WORKDIR /app
RUN git clone --filter=blob:none https://github.com/QuentinFuxa/WhisperLiveKit.git /app && \
    git checkout aceed595a43e9eed5008c142d90a3f6e86747fbf && \
    test "$(git rev-parse HEAD)" = aceed595a43e9eed5008c142d90a3f6e86747fbf
RUN uv python install 3.12 && \
    uv sync --frozen --no-install-project --no-editable --no-cache --extra cu129 --extra diarization-sortformer
COPY patch_upstream.py shared_livekit.py /overlay/
RUN python3 /overlay/patch_upstream.py /app && \
    uv sync --frozen --no-editable --no-cache --extra cu129 --extra diarization-sortformer
COPY openai-requirements.txt /overlay/
RUN uv pip install --python /app/.venv/bin/python --no-deps --require-hashes -r /overlay/openai-requirements.txt && \
    /app/.venv/bin/python -c "import openai; from openai import OpenAI" && \
    uv pip check --python /app/.venv/bin/python

FROM nvidia/cuda:12.9.2-cudnn-runtime-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PATH=/app/.venv/bin:$PATH UV_PYTHON_DOWNLOADS=0
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && update-ca-certificates
COPY --from=builder /python /python
COPY --from=builder /app/.venv /app/.venv
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)" || exit 1
ENTRYPOINT ["wlk", "--host", "0.0.0.0"]
CMD ["--backend-policy", "localagreement", "--backend", "openai-api", "--language", "auto", "--pcm-input", "--diarization", "--diarization-backend", "sortformer", "--sortformer-max-speakers", "4", "--warmup-file", ""]
