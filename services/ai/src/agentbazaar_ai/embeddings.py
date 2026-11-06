"""Text embeddings.

The default ``hash`` backend ("hash-256-v1") is a dependency-free feature-hashing embedder. The
TypeScript core implements the same algorithm, and both sides test against
``tests/fixtures/hash_embeddings.json``, so any change here needs a new model name.
"""

import math
import re
import unicodedata
from collections.abc import Sequence
from typing import Protocol

HASH_MODEL = "hash-256-v1"
HASH_DIM = 256
_TOKEN = re.compile(r"\w+")  # Unicode \w; JavaScript equivalent: /[\p{L}\p{N}_]+/gu


class Embedder(Protocol):
    model: str
    dim: int

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


def fnv1a_32(data: bytes) -> int:
    h = 2166136261
    for byte in data:
        h = ((h ^ byte) * 16777619) & 0xFFFFFFFF
    return h


def features(text: str) -> list[str]:
    """``w:<token>`` plus every code-point trigram of ``#<token>#`` as ``c:<trigram>``."""
    out: list[str] = []
    for token in _TOKEN.findall(unicodedata.normalize("NFKC", text).lower()):
        padded = f"#{token}#"
        out.append("w:" + token)
        out.extend("c:" + padded[i : i + 3] for i in range(len(padded) - 2))
    return out


def hash_embed(text: str) -> list[float]:
    vec = [0.0] * HASH_DIM
    for feature in features(text):
        h = fnv1a_32(feature.encode("utf-8"))
        vec[h % HASH_DIM] += -1.0 if h >> 31 else 1.0
    # Integer counts make the sum of squares exact, so sqrt is bit-identical across languages.
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm else vec


class HashEmbedder:
    model = HASH_MODEL
    dim = HASH_DIM

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [hash_embed(t) for t in texts]


class SentenceTransformerEmbedder:
    """Optional ``ml`` extra. Loads (and may download) the model at startup, never per request."""

    def __init__(self, model_id: str) -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_id)
        self.model = model_id
        self.dim = len(self.embed(["warm-up"])[0])  # also proves the model works before we serve

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = self._model.encode(
            list(texts), normalize_embeddings=True
        ).tolist()
        return vectors
