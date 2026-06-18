"""HostValidationMiddleware: the DNS-rebinding guard (an internal audit).

A remote page that rebinds its domain to 127.0.0.1 reaches this server with the
ATTACKER'S hostname in the Host header. Since J0's /api/auth/status auto-provisions
a session and returns the CSRF token in the body, a non-loopback Host must be
rejected before any handler runs. "testserver" (TestClient's default) is allowed
only under the :memory: test gate — the same signal that disables the rate limiter.
"""
from starlette.testclient import TestClient

from app.main import app
from app.database import engine, Base


def _client():
    Base.metadata.create_all(bind=engine)
    return TestClient(app, raise_server_exceptions=False)


# ── Allowed hosts ────────────────────────────────────────────────────────────


def test_default_testserver_host_allowed_in_tests():
    with _client() as c:
        assert c.get("/health").status_code in (200, 503)  # not 400


def test_loopback_hosts_allowed():
    with _client() as c:
        for host in ("127.0.0.1:8000", "127.0.0.1", "localhost:5173", "localhost", "[::1]:8000"):
            resp = c.get("/health", headers={"Host": host})
            assert resp.status_code in (200, 503), f"Host {host!r} was rejected"


def test_host_check_is_case_insensitive():
    with _client() as c:
        assert c.get("/health", headers={"Host": "LocalHost:8000"}).status_code in (200, 503)


# ── Rejected hosts ───────────────────────────────────────────────────────────


def test_non_loopback_host_rejected():
    with _client() as c:
        resp = c.get("/health", headers={"Host": "evil.example.com:8000"})
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid Host header"


def test_rebound_host_cannot_mint_session():
    """The actual H1 vector: /auth/status behind a rebound Host must not
    auto-provision a session or hand back a CSRF token."""
    with _client() as c:
        resp = c.get("/api/auth/status", headers={"Host": "evil.example.com:4173"})
        assert resp.status_code == 400
        assert "csrf_token" not in resp.text
        assert "set-cookie" not in {k.lower() for k in resp.headers}


def test_missing_host_rejected():
    with _client() as c:
        resp = c.get("/health", headers={"Host": ""})
        assert resp.status_code == 400


def test_lookalike_prefix_host_rejected():
    """localhost.evil.com must not pass a sloppy prefix match."""
    with _client() as c:
        assert c.get("/health", headers={"Host": "localhost.evil.com"}).status_code == 400
        assert c.get("/health", headers={"Host": "127.0.0.1.evil.com"}).status_code == 400
