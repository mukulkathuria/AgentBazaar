import logging
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agentbazaar_ai.config import Settings
from agentbazaar_ai.device import resolve_device

MakeClient = Callable[..., TestClient]


def test_cpu_is_the_default_and_needs_no_pytorch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    assert resolve_device("cpu") == "cpu"


def test_cuda_when_pytorch_sees_a_gpu(fake_torch: types.SimpleNamespace) -> None:
    assert resolve_device("cuda") == "cuda"


def test_falls_back_to_cpu_when_no_gpu_is_visible(
    fake_torch: types.SimpleNamespace, caplog: pytest.LogCaptureFixture
) -> None:
    fake_torch.available = False
    with caplog.at_level(logging.WARNING, logger="agentbazaar_ai"):
        assert resolve_device("cuda") == "cpu"
    assert "no CUDA device" in caplog.text


def test_falls_back_to_cpu_without_pytorch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    assert resolve_device("cuda") == "cpu"


def test_falls_back_to_cpu_when_the_cuda_probe_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> bool:
        raise RuntimeError("CUDA driver is too old")

    module = types.ModuleType("torch")
    module.cuda = types.SimpleNamespace(is_available=broken)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", module)
    assert resolve_device("cuda") == "cpu"


@pytest.mark.usefixtures("fake_torch", "fake_sentence_transformers")
def test_optional_models_load_on_the_gpu(
    make_client: MakeClient, fake_transformers: list[dict[str, Any]]
) -> None:
    client = make_client(
        classifier_backend="hf",
        classifier_model="acme/laya-intent",
        embeddings_backend="sentence-transformers",
        embeddings_model="acme/minilm",
        ai_device="cuda",
    )
    backends = client.get("/readyz").json()["backends"]
    assert (backends["classifier"]["device"], backends["embeddings"]["device"]) == ("cuda", "cuda")
    assert sys.modules["transformers"].devices == ["cuda"]
    assert sys.modules["sentence_transformers"].SentenceTransformer.devices == ["cuda"]
    assert (
        client.post("/v1/classify", json={"text": "can you do 1800"}).json()["intent"]
        == "make_offer"
    )


@pytest.mark.usefixtures("fake_transformers")
def test_readiness_shows_a_gpu_request_that_fell_back(
    make_client: MakeClient, fake_torch: types.SimpleNamespace
) -> None:
    fake_torch.available = False
    client = make_client(classifier_backend="hf", classifier_model="m", ai_device="cuda")
    ready = client.get("/readyz").json()
    assert ready["status"] == "ok"
    assert ready["backends"]["classifier"] == {
        "backend": "hf",
        "model": "m",
        "device": "cpu",
        "requested_device": "cuda",
    }
    assert sys.modules["transformers"].devices == ["cpu"]


def test_rules_and_hash_defaults_run_no_model_so_have_no_device(client: TestClient) -> None:
    backends = client.get("/readyz").json()["backends"]
    assert "device" not in backends["classifier"]
    assert "device" not in backends["embeddings"]


def test_settings_read_and_check_ai_device() -> None:
    assert Settings.from_env({"AI_DEVICE": " cuda "}).ai_device == "cuda"
    assert Settings.from_env({}).ai_device == "cpu"
    with pytest.raises(ValueError, match="AI_DEVICE"):
        Settings(ai_device="tpu")
