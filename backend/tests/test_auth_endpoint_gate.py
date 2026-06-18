"""The dormant multi-user auth surface is gated OFF by default (an internal audit).

Post-J0 there is no login screen and no UI caller for /setup, /login, /logout,
/change-password, or GET/POST /users. They are kept as the substrate for
Track J (coder roster) / the cloud build, but 404 unless
MM_MULTIUSER_AUTH_ENABLED is set — which also closes the /setup first-launch
race (a local process racing the first /status call could otherwise claim the
admin account). The J0 endpoints (/status, GET/PATCH /me) stay ungated.

test_auth_integration.py covers the flag-ON behavior of the same endpoints.
"""
import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base


@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _clean(_migrated_db):
    yield
    db = SessionLocal()
    try:
        for t in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {t}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


GATED_CALLS = [
    ("POST", "/api/auth/setup", {"username": "eve", "password": "password123"}),
    ("POST", "/api/auth/login", {"username": "eve", "password": "password123"}),
    ("POST", "/api/auth/logout", None),
    ("POST", "/api/auth/change-password", {"current_password": "a" * 8, "new_password": "b" * 8}),
    ("GET", "/api/auth/users", None),
    ("POST", "/api/auth/users", {"username": "eve", "password": "password123"}),
]


@pytest.mark.parametrize("method,path,body", GATED_CALLS, ids=[p for _, p, _ in GATED_CALLS])
def test_gated_endpoint_404_by_default(client, method, path, body):
    """No session, default settings: the surface is indistinguishable from absent."""
    resp = client.request(method, path, json=body)
    assert resp.status_code == 404, f"{method} {path} -> {resp.status_code}: {resp.text}"


@pytest.mark.parametrize("method,path,body", GATED_CALLS, ids=[p for _, p, _ in GATED_CALLS])
def test_gated_endpoint_404_even_with_session(client, method, path, body):
    """The gate is a config flag, not an auth check — a valid session doesn't open it."""
    status = client.get("/api/auth/status")
    csrf = status.json()["user"]["csrf_token"]
    resp = client.request(method, path, json=body, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 404, f"{method} {path} -> {resp.status_code}: {resp.text}"


def test_setup_race_is_closed(client):
    """The L2 first-launch race: /setup can no longer claim the admin account
    before the first /status call auto-provisions the local coder."""
    race = client.post("/api/auth/setup", json={"username": "attacker", "password": "password123"})
    assert race.status_code == 404

    status = client.get("/api/auth/status")
    assert status.status_code == 200
    assert status.json()["user"]["username"] != "attacker"


def test_j0_endpoints_stay_ungated(client):
    """/status auto-provisions; GET /me and PATCH /me (coder rename) keep working."""
    status = client.get("/api/auth/status")
    assert status.status_code == 200
    csrf = status.json()["user"]["csrf_token"]

    me = client.get("/api/auth/me")
    assert me.status_code == 200

    renamed = client.patch(
        "/api/auth/me", json={"username": "Dana"}, headers={"X-CSRF-Token": csrf}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["username"] == "Dana"
