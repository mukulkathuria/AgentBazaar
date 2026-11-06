import logging
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentbazaar_ai.config import Settings

MakeClient = Callable[..., TestClient]
SECRET = "my email is secret.person@example.com and the vault code is 8371"
TOKEN = "s3cret-token"


def test_healthz(client: TestClient) -> None:
    response = client.get("/healthz")
    assert (response.status_code, response.json()) == (200, {"status": "ok"})


def test_readyz_reports_the_default_backends(client: TestClient) -> None:
    assert client.get("/readyz").json() == {
        "status": "ok",
        "backends": {
            "classifier": {"backend": "rules", "model": "rules-v1"},
            "embeddings": {"backend": "hash", "model": "hash-256-v1", "dim": 256},
            "redaction": {"backend": "regex"},
        },
    }


def test_classify(client: TestClient) -> None:
    response = client.post("/v1/classify", json={"text": "1800 mein de do", "language_hint": "hi"})
    body = response.json()
    assert response.status_code == 200
    assert (body["intent"], body["language"], body["model"]) == (
        "make_offer",
        "hinglish",
        "rules-v1",
    )
    assert body["entities"] == {"amount_inr": 1800.0, "quantity": None}


def test_embed(client: TestClient) -> None:
    body = client.post("/v1/embed", json={"texts": ["ceramic mug", ""]}).json()
    assert (body["model"], body["dim"]) == ("hash-256-v1", 256)
    assert [len(v) for v in body["vectors"]] == [256, 256]
    assert body["vectors"][1] == [0.0] * 256


def test_redact(client: TestClient) -> None:
    assert client.post("/v1/redact", json={"text": "call 9876543210"}).json() == {
        "text": "call [PHONE]",
        "findings": [{"type": "PHONE", "start": 5, "end": 15}],
    }


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/v1/classify", {"text": "hi", "extra": 1}),
        ("/v1/classify", {}),
        ("/v1/classify", {"text": 123}),
        ("/v1/classify", {"text": "x" * 4001}),
        ("/v1/classify", {"text": "hi", "language_hint": "fr"}),
        ("/v1/classify", {"text": "hi", "language_hint": None}),
        ("/v1/embed", {"texts": []}),
        ("/v1/embed", {"texts": ["a"] * 65}),
        ("/v1/embed", {"texts": ["x" * 2001]}),
        ("/v1/embed", {"texts": "not a list"}),
        ("/v1/embed", {"texts": ["a"], "model": "other"}),
        ("/v1/redact", {"text": "x" * 20001}),
        ("/v1/redact", {"text": "hi", "mode": "strict"}),
        ("/v1/redact", ["hi"]),
    ],
)
def test_invalid_requests_are_422(client: TestClient, path: str, body: Any) -> None:
    assert client.post(path, json=body).status_code == 422


def test_boundary_sizes_are_accepted(client: TestClient) -> None:
    assert client.post("/v1/classify", json={"text": "x" * 4000}).status_code == 200
    assert client.post("/v1/embed", json={"texts": ["x" * 2000] * 64}).status_code == 200
    assert client.post("/v1/redact", json={"text": "x" * 20000}).status_code == 200


@pytest.mark.parametrize("raw", [b'{"text": ', b"not json", b'{"text": "\\ud800"}'])
def test_malformed_bodies_are_422_not_500(client: TestClient, raw: bytes) -> None:
    headers = {"content-type": "application/json"}
    assert client.post("/v1/redact", content=raw, headers=headers).status_code == 422


def test_validation_errors_never_echo_the_input(client: TestClient) -> None:
    response = client.post("/v1/classify", json={"text": SECRET * 100})
    assert response.status_code == 422
    assert "secret.person" not in response.text


def test_oversized_body_is_413(client: TestClient) -> None:
    assert client.post("/v1/redact", json={"text": "x" * 300_000}).status_code == 413


def test_oversized_chunked_body_is_413(client: TestClient) -> None:
    def chunks() -> Iterator[bytes]:  # no Content-Length: the streaming cap must catch it
        yield b'{"text": "'
        for _ in range(40):
            yield b"x" * 8192
        yield b'"}'

    headers = {"content-type": "application/json"}
    response = client.post("/v1/redact", content=chunks(), headers=headers)
    assert response.status_code == 413


@pytest.fixture
def secured(make_client: MakeClient) -> TestClient:
    return make_client(service_token=TOKEN)


@pytest.mark.parametrize(
    "authorization",
    [None, "Bearer wrong", f"Basic {TOKEN}", TOKEN, "Bearer", f"Bearer {TOKEN}x"],
)
def test_v1_requires_the_token(secured: TestClient, authorization: str | None) -> None:
    headers = {"Authorization": authorization} if authorization else {}
    response = secured.post("/v1/classify", json={"text": "hi"}, headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("scheme", ["Bearer", "bearer"])
def test_v1_accepts_the_token(secured: TestClient, scheme: str) -> None:
    headers = {"Authorization": f"{scheme} {TOKEN}"}
    assert secured.post("/v1/embed", json={"texts": ["mug"]}, headers=headers).status_code == 200


def test_probes_stay_open_when_auth_is_on(secured: TestClient) -> None:
    assert secured.get("/healthz").status_code == 200
    assert secured.get("/readyz").status_code == 200


def test_auth_runs_before_the_body_is_parsed(secured: TestClient) -> None:
    assert secured.post("/v1/classify", content=b"not json").status_code == 401


def test_request_text_is_never_logged(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    headers = {"x-request-id": "req-42"}
    for path, body in (
        ("/v1/classify", {"text": SECRET}),
        ("/v1/embed", {"texts": [SECRET]}),
        ("/v1/redact", {"text": SECRET}),
    ):
        assert client.post(path, json=body, headers=headers).status_code == 200
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "request_id=req-42" in logged
    assert f"chars={len(SECRET)}" in logged
    assert "secret.person" not in logged
    assert "vault" not in logged


OPTIONAL = {
    "classifier_backend": "hf",
    "classifier_model": "acme/laya-intent",
    "embeddings_backend": "sentence-transformers",
    "embeddings_model": "acme/minilm",
    "redact_backend": "presidio",
}


@pytest.mark.usefixtures("block_optional_imports")
def test_unavailable_optional_backends_fall_back_and_report(make_client: MakeClient) -> None:
    client = make_client(**OPTIONAL)
    ready = client.get("/readyz").json()
    assert ready["status"] == "degraded"
    error = "ModuleNotFoundError"
    assert ready["backends"] == {
        "classifier": {"backend": "rules", "requested": "hf", "error": error, "model": "rules-v1"},
        "embeddings": {
            "backend": "hash",
            "requested": "sentence-transformers",
            "error": error,
            "model": "hash-256-v1",
            "dim": 256,
        },
        "redaction": {"backend": "regex", "requested": "presidio", "error": error},
    }
    assert client.post("/v1/classify", json={"text": "hi"}).json()["model"] == "rules-v1"
    assert client.post("/v1/embed", json={"texts": ["hi"]}).json()["model"] == "hash-256-v1"


@pytest.mark.usefixtures("fake_transformers", "fake_sentence_transformers", "fake_presidio")
def test_optional_backends_serve_when_available(make_client: MakeClient) -> None:
    client = make_client(**OPTIONAL)
    assert client.get("/readyz").json() == {
        "status": "ok",
        "backends": {
            "classifier": {"backend": "hf", "model": "acme/laya-intent", "device": "cpu"},
            "embeddings": {
                "backend": "sentence-transformers",
                "model": "acme/minilm",
                "dim": 3,
                "device": "cpu",
            },
            "redaction": {"backend": "presidio"},
        },
    }
    classified = client.post("/v1/classify", json={"text": "can you do 1800"}).json()
    assert classified["model"] == "acme/laya-intent"
    assert client.post("/v1/embed", json={"texts": ["a", "b"]}).json() == {
        "model": "acme/minilm",
        "dim": 3,
        "vectors": [[0.6, 0.8, 0.0], [0.6, 0.8, 0.0]],
    }
    redacted = client.post("/v1/redact", json={"text": "Call Rahul at 9876543210"}).json()
    assert redacted["text"] == "Call [PERSON] at [PHONE]"


@pytest.mark.usefixtures("fake_transformers")
def test_hf_without_a_model_id_falls_back(make_client: MakeClient) -> None:
    classifier = (
        make_client(classifier_backend="hf").get("/readyz").json()["backends"]["classifier"]
    )
    assert classifier["error"] == "ValueError"


def test_settings_from_env() -> None:
    settings = Settings.from_env(
        {
            "CLASSIFIER_BACKEND": " hf ",
            "CLASSIFIER_MODEL": "acme/laya",
            "AI_SERVICE_TOKEN": "t",
            "EMBEDDINGS_BACKEND": "",
        }
    )
    assert settings == Settings(
        classifier_backend="hf", classifier_model="acme/laya", service_token="t"
    )


def test_settings_reject_unknown_backends() -> None:
    with pytest.raises(ValueError, match="REDACT_BACKEND"):
        Settings.from_env({"REDACT_BACKEND": "magic"})


def test_module_level_app_serves_defaults() -> None:
    from agentbazaar_ai.app import app

    assert isinstance(app, FastAPI)
    with TestClient(app) as client:  # runs lifespan too, which the guard must pass through
        assert client.get("/readyz").json()["status"] == "ok"
