"""Critical public API compatibility and private live ASR boundary."""

import importlib
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def services(monkeypatch):
    monkeypatch.setenv("API_KEY", "test-public-token")
    monkeypatch.setenv("LIVE_ASR_TOKEN", "test-private-token")
    monkeypatch.setenv("ASR_MODEL", "large-v3-turbo")
    import live_server
    import server

    return importlib.reload(server), importlib.reload(live_server)


def install_upstream(monkeypatch, module, payload, status=200):
    seen = []
    original = httpx.AsyncClient

    def handler(request):
        seen.append(request)
        return httpx.Response(status, json=payload)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
    return seen


def upload(client, key, **fields):
    return client.post(
        "/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {key}"},
        data={"model": "large-v3-turbo", "language": "ru", "prompt": "Mycelia", **fields},
        files={"file": ("speech.wav", b"test-audio", "audio/wav")},
    )


PAYLOAD = {"text": " hello", "language": "en", "segments": [{
    "start": 1.2, "end": 1.8, "text": " hello", "no_speech_prob": 0.01,
    "words": [{"start": 1.2, "end": 1.8, "word": " hello", "probability": 0.95}],
}]}


def test_public_response_and_prompt_remain_unchanged(services, monkeypatch):
    public, _ = services
    seen = install_upstream(monkeypatch, public, PAYLOAD)
    response = upload(TestClient(public.app), "test-public-token", **{"timestamp_granularities[]": "word"})
    assert response.status_code == 200
    assert response.json() == PAYLOAD
    assert seen[0].url.params["initial_prompt"] == "Mycelia"
    assert seen[0].url.params["word_timestamps"] == "true"
    assert "x-asr-priority" not in seen[0].headers


def test_public_rejects_wrong_model_before_inference(services, monkeypatch):
    public, _ = services
    seen = install_upstream(monkeypatch, public, PAYLOAD)
    response = upload(TestClient(public.app), "test-public-token", model="another-model")
    assert response.status_code == 409
    assert not seen


@pytest.mark.parametrize("token", ["test-public-token", "wrong"])
def test_private_listener_does_not_accept_public_or_wrong_key(services, monkeypatch, token):
    _, private = services
    seen = install_upstream(monkeypatch, private, PAYLOAD)
    assert upload(TestClient(private.app), token).status_code == 401
    assert not seen


def test_live_uses_trusted_priority_and_real_word_timestamps(services, monkeypatch):
    _, private = services
    seen = install_upstream(monkeypatch, private, PAYLOAD)
    response = upload(TestClient(private.app), "test-private-token")
    assert response.status_code == 200
    assert response.json()["words"] == PAYLOAD["segments"][0]["words"]
    assert response.json()["segments"] == PAYLOAD["segments"]
    assert seen[0].headers["X-ASR-Priority"] == "live"
    assert seen[0].headers["X-ASR-Live-Token"] == "test-private-token"
    assert seen[0].url.params["word_timestamps"] == "true"
    assert seen[0].url.params["initial_prompt"] == "Mycelia"
    assert seen[0].url.params["language"] == "ru"


def test_silence_is_empty_success(services, monkeypatch):
    _, private = services
    install_upstream(monkeypatch, private, {"text": "", "segments": []})
    response = upload(TestClient(private.app), "test-private-token")
    assert response.status_code == 200
    assert response.json()["words"] == []


def test_missing_word_timestamps_fail_instead_of_fabricating(services, monkeypatch):
    _, private = services
    install_upstream(monkeypatch, private, {"text": "hello", "segments": [{"text": "hello", "start": 0, "end": 1}]})
    response = upload(TestClient(private.app), "test-private-token")
    assert response.status_code == 502


def test_upstream_capacity_error_is_preserved(services, monkeypatch):
    _, private = services
    install_upstream(monkeypatch, private, {"detail": "busy"}, status=429)
    assert upload(TestClient(private.app), "test-private-token").status_code == 429


def test_private_configuration_fails_closed_without_token(services, monkeypatch):
    _, private = services
    monkeypatch.setattr(private, "LIVE_ASR_TOKEN", "")
    assert upload(TestClient(private.app), "test-private-token").status_code == 503
