"""FastAPI app factory. ``app`` is what ``uvicorn agentbazaar_ai.app:app`` serves."""

import logging
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .classifier import RULES_MODEL, Classifier, HFClassifier, classify_rules
from .config import Settings
from .device import resolve_device
from .embeddings import Embedder, HashEmbedder, SentenceTransformerEmbedder
from .redaction import PresidioRedactor, Redactor, redact
from .schemas import (
    ClassifyRequest,
    ClassifyResponse,
    EmbedRequest,
    EmbedResponse,
    RedactRequest,
    RedactResponse,
)
from .security import GuardMiddleware

log = logging.getLogger("agentbazaar_ai")
Status = dict[str, dict[str, Any]]


def _load[T](
    kind: str, requested: str, default: str, fallback: T, build: Callable[[], T], status: Status
) -> T:
    """Builds an optional backend. Any failure serves the built-in default and shows in /readyz."""
    if requested == default:
        status[kind] = {"backend": default}
        return fallback
    try:
        impl = build()
    except Exception as exc:  # optional backends fail in many ways (missing extra, download, OOM)
        log.warning("%s backend %r unavailable: %s", kind, requested, type(exc).__name__)
        status[kind] = {"backend": default, "requested": requested, "error": type(exc).__name__}
        return fallback
    status[kind] = {"backend": requested}
    return impl


def _request_id(request: Request) -> str:
    return request.headers.get("x-request-id", "-")[:64]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    status: Status = {}
    device = resolve_device(settings.ai_device)
    classify: Classifier = _load(
        "classifier",
        settings.classifier_backend,
        "rules",
        classify_rules,
        lambda: HFClassifier(settings.classifier_model, device),
        status,
    )
    hash_embedder: Embedder = HashEmbedder()
    embedder = _load(
        "embeddings",
        settings.embeddings_backend,
        "hash",
        hash_embedder,
        lambda: SentenceTransformerEmbedder(settings.embeddings_model, device),
        status,
    )
    redactor: Redactor = _load(
        "redaction", settings.redact_backend, "regex", redact, PresidioRedactor, status
    )
    status["classifier"]["model"] = getattr(classify, "model", RULES_MODEL)
    status["embeddings"] |= {"model": embedder.model, "dim": embedder.dim}
    # Only model-backed backends have a device; a CUDA request that fell back shows here too.
    placed = {"device": device} | (
        {"requested_device": settings.ai_device} if device != settings.ai_device else {}
    )
    if classify is not classify_rules:
        status["classifier"] |= placed
    if embedder is not hash_embedder:
        status["embeddings"] |= placed
    readiness = {
        "status": "degraded" if any("error" in s for s in status.values()) else "ok",
        "backends": status,
    }

    app = FastAPI(
        title="AgentBazaar AI service",
        summary="Intent classification, embeddings and PII redaction for the AgentBazaar core.",
    )
    app.add_middleware(GuardMiddleware, token=settings.service_token)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Never echo the input back: callers may log error bodies, and inputs can hold PII.
        detail = [{"type": e["type"], "loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        return JSONResponse({"detail": detail}, status_code=422)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, Any]:
        return readiness

    # Sync handlers run in the threadpool, so model-backed backends never block the event loop.
    @app.post("/v1/classify")
    def classify_text(body: ClassifyRequest, request: Request) -> ClassifyResponse:
        result = classify(body.text, body.language_hint)
        log.info(
            "classify request_id=%s chars=%d intent=%s",
            _request_id(request),
            len(body.text),
            result.intent,
        )
        return result

    @app.post("/v1/embed")
    def embed_texts(body: EmbedRequest, request: Request) -> EmbedResponse:
        vectors = embedder.embed(body.texts)
        log.info("embed request_id=%s texts=%d", _request_id(request), len(body.texts))
        return EmbedResponse(model=embedder.model, dim=embedder.dim, vectors=vectors)

    @app.post("/v1/redact")
    def redact_text(body: RedactRequest, request: Request) -> RedactResponse:
        result = redactor(body.text)
        log.info(
            "redact request_id=%s chars=%d findings=%d",
            _request_id(request),
            len(body.text),
            len(result.findings),
        )
        return result

    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
app = create_app()
