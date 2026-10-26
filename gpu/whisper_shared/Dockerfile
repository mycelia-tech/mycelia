# v1.9.1-gpu as deployed on faeon; immutable linux/amd64 base, no dependency upgrades.
FROM onerahmet/openai-whisper-asr-webservice:v1.9.1-gpu@sha256:1132aa08c6eb9b440408864e8c25733d22a197ffea7c6975d60a4f4b6fd7b08b
COPY scheduler.py engine.py service.py /app/shared_whisper/
ENV PYTHONPATH=/app/shared_whisper:/app
ENV ASR_ENGINE=faster_whisper
# Fail build if upstream versions drift away from the audited implementation.
RUN /app/.venv/bin/python -c "from importlib.metadata import version; expected={'faster-whisper':'1.1.1','ctranslate2':'4.4.0','fastapi':'0.115.14','whisper-asr-webservice':'1.9.1'}; actual={k:version(k) for k in expected}; assert actual == expected, actual"
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 CMD /app/.venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/health', timeout=4)"
ENTRYPOINT ["/app/.venv/bin/python", "/app/shared_whisper/service.py"]
