FROM python:3.12-slim

WORKDIR /app

# Install build dependencies for pyaudio and other native packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc-dev \
    portaudio19-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.7.3

COPY python/pyproject.toml python/uv.lock ./

RUN --mount=type=cache,id=mycelia-python-uv,target=/root/.cache/uv,sharing=locked \
    uv export --frozen --no-dev > /tmp/requirements.txt && \
    uv pip install --system --require-hashes --link-mode=copy -r /tmp/requirements.txt && \
    rm -f /tmp/requirements.txt

COPY python/ .

# Run the worker server
CMD ["uvicorn", "worker_server:app", "--host", "0.0.0.0", "--port", "8000"]
