import json
import math
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from agentbazaar_ai.embeddings import HASH_DIM, HashEmbedder, features, fnv1a_32, hash_embed

# Shared with the TypeScript core, which must reproduce these vectors too.
FIXTURE = Path(__file__).parent / "fixtures" / "hash_embeddings.json"
SHARED_FIXTURE = json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_covers_the_agreed_texts() -> None:
    assert [case["text"] for case in SHARED_FIXTURE] == [
        "RTX 5070 12GB graphics card",
        "dark chocolate 70%",
        "मग पर नाम छपवाना है",
        "",
        "Ceramic Mug — Personalised!",
    ]


@pytest.mark.parametrize("case", SHARED_FIXTURE, ids=lambda case: case["text"] or "<empty>")
def test_reproduces_the_shared_fixture(case: dict[str, object]) -> None:
    assert hash_embed(str(case["text"])) == pytest.approx(case["vector"], abs=1e-6)


@pytest.mark.parametrize(
    ("data", "expected"),
    [(b"", 0x811C9DC5), (b"a", 0xE40C292C), (b"foobar", 0xBF9CF968)],
)
def test_fnv1a_32_reference_vectors(data: bytes, expected: int) -> None:
    assert fnv1a_32(data) == expected


def test_features() -> None:
    assert features("a") == ["w:a", "c:#a#"]
    assert features("Ab!") == ["w:ab", "c:#ab", "c:ab#"]
    assert features("ﬁ") == ["w:fi", "c:#fi", "c:fi#"]  # NFKC folds the ligature


def test_embedder_reports_its_model() -> None:
    embedder = HashEmbedder()
    assert (embedder.model, embedder.dim) == ("hash-256-v1", 256)
    assert embedder.embed(["mug", "mug"])[0] == embedder.embed(["mug"])[0]


@given(st.text(max_size=2000))
def test_vectors_are_deterministic_and_unit_or_zero(text: str) -> None:
    vector = hash_embed(text)
    assert vector == hash_embed(text)
    assert len(vector) == HASH_DIM
    norm = math.sqrt(sum(x * x for x in vector))
    assert norm == pytest.approx(1.0, abs=1e-9) or all(x == 0.0 for x in vector)


@given(st.text(alphabet=" !?.,-—%₹\n", max_size=50))
def test_text_without_word_characters_embeds_to_zero(text: str) -> None:
    assert all(x == 0.0 for x in hash_embed(text))
