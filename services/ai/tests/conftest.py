import os
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from hypothesis import settings as hypothesis_settings

from agentbazaar_ai.config import Settings

# Hermetic: agentbazaar_ai.app builds a module-level app from the environment when imported.
for _name in (
    "AI_SERVICE_TOKEN",
    "CLASSIFIER_BACKEND",
    "CLASSIFIER_MODEL",
    "EMBEDDINGS_BACKEND",
    "EMBEDDINGS_MODEL",
    "REDACT_BACKEND",
):
    os.environ.pop(_name, None)

hypothesis_settings.register_profile("agentbazaar", deadline=None)
hypothesis_settings.load_profile("agentbazaar")


@pytest.fixture
def make_client() -> Callable[..., TestClient]:
    from agentbazaar_ai.app import create_app

    def make(**overrides: str) -> TestClient:
        return TestClient(create_app(Settings(**overrides)))

    return make


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()


@pytest.fixture
def fake_transformers(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Stub `transformers`; tests set the label the fake pipeline returns. Nothing is downloaded."""
    prediction = [{"label": "MAKE_OFFER", "score": 0.91}]
    module = types.ModuleType("transformers")
    module.pipeline = lambda task, model: lambda text, truncation: prediction  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", module)
    return prediction


@pytest.fixture
def fake_sentence_transformers(monkeypatch: pytest.MonkeyPatch) -> None:
    class Vectors(list[list[float]]):
        def tolist(self) -> list[list[float]]:
            return list(self)

    class SentenceTransformer:
        def __init__(self, model_id: str) -> None:
            self.model_id = model_id

        def encode(self, texts: list[str], normalize_embeddings: bool) -> Vectors:
            assert normalize_embeddings
            return Vectors([[0.6, 0.8, 0.0] for _ in texts])

    module = types.ModuleType("sentence_transformers")
    module.SentenceTransformer = SentenceTransformer  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)


@pytest.fixture
def fake_presidio(monkeypatch: pytest.MonkeyPatch) -> None:
    class AnalyzerEngine:
        def analyze(self, text: str, language: str, score_threshold: float) -> list[Any]:
            assert language == "en"
            found = []
            for word, kind, score in (
                ("Rahul", "PERSON", 0.85),
                ("9876543210", "PHONE_NUMBER", 0.9),
            ):
                if (start := text.find(word)) >= 0:
                    found.append(
                        types.SimpleNamespace(
                            entity_type=kind, start=start, end=start + len(word), score=score
                        )
                    )
            return found

    module = types.ModuleType("presidio_analyzer")
    module.AnalyzerEngine = AnalyzerEngine  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "presidio_analyzer", module)


@pytest.fixture
def block_optional_imports(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the optional extras unimportable even if they happen to be installed."""
    for name in ("transformers", "sentence_transformers", "presidio_analyzer"):
        monkeypatch.setitem(sys.modules, name, None)
