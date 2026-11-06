"""Guards that run before a request body is read: optional bearer auth on /v1/* and a size cap."""

import hmac

from fastapi import HTTPException
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 256 * 1024


def bearer_matches(authorization: str | None, token: str) -> bool:
    scheme, _, credentials = (authorization or "").partition(" ")
    # Headers arrive latin-1 decoded, so encoding back gives the raw bytes. Constant-time compare.
    supplied = credentials.strip().encode("latin-1")
    return scheme.lower() == "bearer" and hmac.compare_digest(supplied, token.encode())


class GuardMiddleware:
    """Pure ASGI, so unauthenticated or oversized requests never reach body parsing."""

    def __init__(self, app: ASGIApp, token: str = "", max_body_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.token = token
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if (
            self.token
            and scope["path"].startswith("/v1/")
            and not bearer_matches(headers.get("authorization"), self.token)
        ):
            response = JSONResponse(
                {"detail": "Not authenticated"}, 401, {"WWW-Authenticate": "Bearer"}
            )
            await response(scope, receive, send)
            return
        declared = headers.get("content-length", "")
        if declared.isascii() and declared.isdigit() and int(declared[:12]) > self.max_body_bytes:
            await JSONResponse({"detail": "Request body too large"}, 413)(scope, receive, send)
            return

        received = 0

        async def capped_receive() -> Message:  # also covers chunked bodies with no Content-Length
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > self.max_body_bytes:
                raise HTTPException(413, "Request body too large")
            return message

        await self.app(scope, capped_receive, send)
