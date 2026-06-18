"""LoopbackTokenMiddleware (an internal audit) — packaged builds require a per-launch
shared secret on every /api request so another local process/OS-user that finds the
loopback port can't read the decrypted data the server returns.

The real app reads the token from MM_LOOPBACK_TOKEN at import (unset in the suite, so
the middleware is inert there). These tests mount the middleware on a throwaway app
with an explicit token to exercise its behavior directly.
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import LoopbackTokenMiddleware


def _make_app(token: str) -> FastAPI:
    app = FastAPI()
    app.add_middleware(LoopbackTokenMiddleware, token=token)

    @app.get("/api/projects")
    async def projects():
        return {"ok": True}

    @app.get("/health")
    async def health():
        return {"status": "healthy"}

    @app.get("/")
    async def root():
        return {"shell": True}

    return app


def test_api_request_without_token_is_forbidden():
    client = TestClient(_make_app("s3cret"))
    assert client.get("/api/projects").status_code == 403


def test_api_request_with_correct_token_passes():
    client = TestClient(_make_app("s3cret"))
    r = client.get("/api/projects", headers={"X-MM-Loopback-Token": "s3cret"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_api_request_with_wrong_token_is_forbidden():
    client = TestClient(_make_app("s3cret"))
    r = client.get("/api/projects", headers={"X-MM-Loopback-Token": "nope"})
    assert r.status_code == 403


def test_health_is_exempt_for_the_electron_startup_probe():
    client = TestClient(_make_app("s3cret"))
    assert client.get("/health").status_code == 200


def test_spa_shell_is_exempt():
    # Non-/api paths are public app code, not data — and the renderer must be able to
    # load the shell. Only the data surface (/api) is guarded.
    client = TestClient(_make_app("s3cret"))
    assert client.get("/").status_code == 200


def test_no_token_configured_is_inert():
    # Dev `uvicorn` and the test suite pass no token → the middleware never blocks.
    client = TestClient(_make_app(""))
    assert client.get("/api/projects").status_code == 200
