"""Settings from the environment. All optional: the defaults need no keys or model downloads."""

import os
from collections.abc import Mapping
from dataclasses import dataclass

BACKENDS = {
    "CLASSIFIER_BACKEND": ("rules", "hf"),
    "EMBEDDINGS_BACKEND": ("hash", "sentence-transformers"),
    "REDACT_BACKEND": ("regex", "presidio"),
}


@dataclass(frozen=True, slots=True)
class Settings:
    classifier_backend: str = "rules"
    classifier_model: str = ""
    embeddings_backend: str = "hash"
    embeddings_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    redact_backend: str = "regex"
    service_token: str = ""  # empty disables bearer auth

    def __post_init__(self) -> None:
        for env_name, allowed in BACKENDS.items():
            value = getattr(self, env_name.lower())
            if value not in allowed:
                raise ValueError(f"{env_name}={value!r} is not one of: {', '.join(allowed)}")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env

        def get(name: str, default: str) -> str:
            return env.get(name, "").strip() or default

        defaults = cls()
        return cls(
            classifier_backend=get("CLASSIFIER_BACKEND", defaults.classifier_backend),
            classifier_model=get("CLASSIFIER_MODEL", defaults.classifier_model),
            embeddings_backend=get("EMBEDDINGS_BACKEND", defaults.embeddings_backend),
            embeddings_model=get("EMBEDDINGS_MODEL", defaults.embeddings_model),
            redact_backend=get("REDACT_BACKEND", defaults.redact_backend),
            service_token=get("AI_SERVICE_TOKEN", defaults.service_token),
        )
