"""Critical public API compatibility and private live ASR boundary."""

import asyncio
import importlib
import json
import logging
import sys
from pathlib import Path
from uuid import UUID

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
        if isinstance(payload, Exception):
            raise payload
        return httpx.Response(status, json=payload)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
    return seen


def upload(client, key, *, headers=None, **fields):
    return client.post(
        "/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {key}", **(headers or {})},
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


@pytest.mark.parametrize(("payload", "upstream_status", "status", "code"), [
    ({"detail": "PRIVATE_UPSTREAM_BODY"}, 429, 429, "upstream_busy"),
    (httpx.ReadTimeout("PRIVATE_TIMEOUT_URL"), 200, 504, "upstream_timeout"),
    (httpx.ConnectError("PRIVATE_CONNECTION_URL"), 200, 502, "upstream_unavailable"),
    ({"text": "PRIVATE_TRANSCRIPT", "segments": []}, 200, 502, "invalid_timing_response"),
])
def test_failure_ids_and_codes_cross_adapter_without_private_content(
    services, monkeypatch, caplog, payload, upstream_status, status, code,
):
    _, private = services
    seen = install_upstream(monkeypatch, private, payload, upstream_status)
    ids = {"X-Request-ID": "a4c789df-a629-481c-b59a-39b210424fe4",
           "X-Mycelia-Capture-ID": "4305706a-9185-434e-848b-42c66c419fa7",
           "X-Mycelia-Session-ID": "82a690e7-9301-4ac1-a737-6d02c5e720c7"}
    with caplog.at_level(logging.WARNING, logger=private.__name__):
        response = upload(TestClient(private.app), "test-private-token",
                          headers={**ids, "X-Mycelia-Window-Index": "2"}, prompt="PRIVATE_PROMPT")
    assert response.status_code == status
    assert response.headers["x-live-error-code"] == code
    assert response.json()["detail"]["code"] == code
    assert response.json()["detail"]["window_index"] == 2
    for header, value in ids.items():
        assert response.headers[header] == value
        assert seen[0].headers[header] == value
    records = [json.loads(r.getMessage()) for r in caplog.records if r.name == private.__name__]
    assert len(records) == 1
    assert records[0]["code"] == code
    assert records[0]["request_id"] == ids["X-Request-ID"]
    assert len(json.dumps(records[0])) < 1000
    for text in ("PRIVATE_", "test-private-token", "speech.wav", "test-audio"):
        assert text not in caplog.text + response.text


def test_untrusted_correlation_values_are_replaced_and_success_contract_is_preserved(services, monkeypatch):
    _, private = services
    seen = install_upstream(monkeypatch, private, PAYLOAD)
    response = upload(TestClient(private.app), "test-private-token", headers={
        "X-Request-ID": "PRIVATE_URL", "X-Mycelia-Capture-ID": "PRIVATE_TRANSCRIPT",
        "X-Mycelia-Session-ID": "PRIVATE_TOKEN", "X-Mycelia-Window-Index": "999999999999",
    })
    assert response.status_code == 200
    assert response.json() == {**PAYLOAD, "words": PAYLOAD["segments"][0]["words"]}
    for header in ("X-Request-ID", "X-Mycelia-Capture-ID", "X-Mycelia-Session-ID"):
        UUID(response.headers[header])
        assert response.headers[header] == seen[0].headers[header]
    assert "PRIVATE_" not in str(response.headers)


def test_disconnected_live_client_cancels_pending_upstream_request(services, monkeypatch):
    _, private = services
    original = httpx.AsyncClient

    async def scenario():
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def handler(_request):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        transport = httpx.MockTransport(handler)
        monkeypatch.setattr(private.httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
        request = httpx.Request('POST', 'http://test/v1/audio/transcriptions',
            headers={'Authorization': 'Bearer test-private-token'}, data={'model': 'large-v3-turbo'},
            files={'file': ('synthetic.wav', b'synthetic-audio', 'audio/wav')})
        body = request.read()
        sent_body = False
        async def receive():
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {'type': 'http.request', 'body': body, 'more_body': False}
            await started.wait()
            return {'type': 'http.disconnect'}
        async def send(_message):
            pass
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                 'method': 'POST', 'scheme': 'http', 'path': '/v1/audio/transcriptions',
                 'raw_path': b'/v1/audio/transcriptions', 'query_string': b'',
                 'root_path': '', 'headers': [(name.lower(), value) for name, value in request.headers.raw],
                 'server': ('test', 80), 'client': ('127.0.0.1', 12345)}
        await asyncio.wait_for(private.app(scope, receive, send), 1)
        assert started.is_set()
        assert cancelled.is_set()
    asyncio.run(scenario())
