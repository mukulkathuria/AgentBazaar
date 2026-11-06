"""Wire models. They mirror packages/contracts/generated/ai/*.json exactly (tests enforce it)."""

from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator

Intent = Literal[
    "greeting",
    "search",
    "product_question",
    "availability",
    "customization",
    "ask_price",
    "make_offer",
    "accept",
    "order_status",
    "return_request",
    "complaint",
    "competitor_claim",
    "human_handoff",
    "injection_attempt",
    "off_topic",
    "unknown",
]
INTENTS: frozenset[str] = frozenset(get_args(Intent))
Level = Literal["low", "medium", "high"]
DetectedLanguage = Literal["en", "hi", "hinglish", "other"]
LanguageHint = Literal["en", "hi"]

MAX_SAFE_INT = 2**53 - 1  # the contract's integer bound (JavaScript's Number.MAX_SAFE_INTEGER)
SafeInt = Annotated[int, Field(ge=-MAX_SAFE_INT, le=MAX_SAFE_INT)]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClassifyRequest(_Request):
    text: str = Field(max_length=4000)
    language_hint: LanguageHint | None = None

    @field_validator("language_hint", mode="before")
    @classmethod
    def _omit_rather_than_null(cls, value: object) -> object:
        # The contract makes the field optional, not nullable: an explicit null is invalid.
        if value is None:
            raise ValueError("language_hint must be omitted or one of 'en', 'hi'")
        return value


class Entities(BaseModel):
    amount_inr: float | None
    quantity: SafeInt | None


class ClassifyResponse(BaseModel):
    intent: Intent
    complexity: Level
    risk: Level
    language: DetectedLanguage
    confidence: float = Field(ge=0, le=1)
    entities: Entities
    model: str


class EmbedRequest(_Request):
    texts: list[Annotated[str, Field(max_length=2000)]] = Field(min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    model: str
    dim: SafeInt = Field(ge=1)
    vectors: list[list[float]]


class RedactRequest(_Request):
    text: str = Field(max_length=20000)


class RedactFinding(BaseModel):
    type: str
    start: SafeInt
    end: SafeInt


class RedactResponse(BaseModel):
    text: str
    findings: list[RedactFinding]
