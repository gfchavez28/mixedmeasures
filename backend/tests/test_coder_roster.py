"""Track J · J1 coder-roster tests — passwordless local roster + flag-off project sharing.

Runs in the DEFAULT local mode (MM_MULTIUSER_AUTH_ENABLED off): the ungated
/auth/coders + /auth/switch-coder endpoints, and the conditional ownership
reframe (all coders share all projects locally). The gated multi-user surface
and per-user isolation are covered by test_auth_integration.py (flag forced on).
"""
import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base
from app.models.user import User


@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="module", autouse=True)
def _force_local_mode():
    """Pin MM_MULTIUSER_AUTH_ENABLED off for this module regardless of test order
    (mirror of test_auth_integration's force-on fixture)."""
    from app.config import get_settings
    settings = get_settings()
    original = settings.mm_multiuser_auth_enabled
    settings.mm_multiuser_auth_enabled = False
    yield
    settings.mm_multiuser_auth_enabled = original


@pytest.fixture(autouse=True)
def _clean(_migrated_db):
    yield
    db = SessionLocal()
    try:
        for tbl in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {tbl}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _bootstrap(client) -> str:
    """Auto-provision the default coder (sets the session cookie); return its CSRF token."""
    return client.get("/api/auth/status").json()["user"]["csrf_token"]


# ── roster endpoints ─────────────────────────────────────────────────────────

def test_list_coders_includes_default(client):
    _bootstrap(client)
    coders = client.get("/api/auth/coders").json()
    assert len(coders) == 1
    assert coders[0]["username"] == "Researcher"
    assert coders[0]["coder_type"] == "human"
    assert coders[0]["archived"] is False


def test_create_coder_passwordless(client):
    csrf = _bootstrap(client)
    resp = client.post(
        "/api/auth/coders",
        json={"username": "Dr. Alvarez", "display_color": "#3b82f6"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200, resp.text
    coder = resp.json()
    assert coder["username"] == "Dr. Alvarez"
    assert coder["display_color"] == "#3b82f6"
    assert coder["coder_type"] == "human"
    assert len(client.get("/api/auth/coders").json()) == 2

    db = SessionLocal()
    try:
        u = db.query(User).filter(User.username == "Dr. Alvarez").first()
        assert u.password_hash is None  # passwordless
    finally:
        db.close()


def test_update_profile_sets_and_clears_display_color(client):
    """PATCH /me: an explicit color sets it, an omitted field leaves it, an
    explicit null clears it (the Settings "Use default color" reset)."""
    csrf = _bootstrap(client)
    h = {"X-CSRF-Token": csrf}
    name = client.get("/api/auth/coders").json()[0]["username"]

    def color():
        return client.get("/api/auth/coders").json()[0]["display_color"]

    assert client.patch("/api/auth/me", json={"username": name, "display_color": "#22c55e"}, headers=h).status_code == 200
    assert color() == "#22c55e"
    # omitting display_color leaves the saved value untouched
    assert client.patch("/api/auth/me", json={"username": name}, headers=h).status_code == 200
    assert color() == "#22c55e"
    # explicit null clears it
    assert client.patch("/api/auth/me", json={"username": name, "display_color": None}, headers=h).status_code == 200
    assert color() is None


def test_active_user_payload_carries_display_color(client):
    """#452 — the active-user object (/auth/me + /auth/status) must carry
    display_color, so the TopRail dot renders the same color as the roster +
    attribution badges instead of the palette-by-id fallback."""
    csrf = _bootstrap(client)
    h = {"X-CSRF-Token": csrf}
    name = client.get("/api/auth/me").json()["username"]
    # No color set yet → the field is present and null (not absent).
    assert client.get("/api/auth/me").json()["display_color"] is None
    assert client.get("/api/auth/status").json()["user"]["display_color"] is None
    # Setting it is reflected in BOTH active-user payloads (the #452 gap).
    assert client.patch("/api/auth/me", json={"username": name, "display_color": "#a855f7"}, headers=h).status_code == 200
    assert client.get("/api/auth/me").json()["display_color"] == "#a855f7"
    assert client.get("/api/auth/status").json()["user"]["display_color"] == "#a855f7"


def test_create_coder_duplicate_409(client):
    csrf = _bootstrap(client)
    client.post("/api/auth/coders", json={"username": "Sam"}, headers={"X-CSRF-Token": csrf})
    resp = client.post("/api/auth/coders", json={"username": "Sam"}, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 409


# ── active-coder switch (Option A) ───────────────────────────────────────────

def test_switch_coder_repoints_session(client):
    csrf = _bootstrap(client)
    b = client.post("/api/auth/coders", json={"username": "Coder B"}, headers={"X-CSRF-Token": csrf}).json()
    assert client.get("/api/auth/me").json()["username"] == "Researcher"
    sw = client.post("/api/auth/switch-coder", json={"coder_id": b["id"]}, headers={"X-CSRF-Token": csrf})
    assert sw.status_code == 200, sw.text
    # the SAME session cookie now resolves to Coder B (server-stamped attribution follows)
    assert client.get("/api/auth/me").json()["id"] == b["id"]


def test_switch_to_unknown_coder_404(client):
    csrf = _bootstrap(client)
    resp = client.post("/api/auth/switch-coder", json={"coder_id": 99999}, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 404


def test_active_coder_survives_session_loss(client):
    """After a switch, losing the session must re-resolve to the last-active coder,
    NOT silently revert to the lowest-id 'Researcher' (the [MEDIUM] misattribution
    fix — ensure_default_user prefers last_active_at)."""
    csrf = _bootstrap(client)
    b = client.post("/api/auth/coders", json={"username": "Persist B"}, headers={"X-CSRF-Token": csrf}).json()
    client.post("/api/auth/switch-coder", json={"coder_id": b["id"]}, headers={"X-CSRF-Token": csrf})

    # simulate session expiry / cookie loss
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM sessions"))
        db.commit()
    finally:
        db.close()
    client.cookies.clear()

    # re-provision (no session) must land on the most-recently-active coder
    user = client.get("/api/auth/status").json()["user"]
    assert user["username"] == "Persist B"


# ── archive (never hard-delete) ──────────────────────────────────────────────

def test_archive_coder_drops_from_roster(client):
    csrf = _bootstrap(client)
    b = client.post("/api/auth/coders", json={"username": "Temp"}, headers={"X-CSRF-Token": csrf}).json()
    resp = client.post(f"/api/auth/coders/{b['id']}/archive", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 200, resp.text
    assert resp.json()["archived"] is True
    names = [c["username"] for c in client.get("/api/auth/coders").json()]
    assert "Temp" not in names
    # row still exists (archive, not delete) — attribution preserved
    db = SessionLocal()
    try:
        assert db.query(User).filter(User.username == "Temp").first() is not None
    finally:
        db.close()


def test_cannot_archive_self(client):
    csrf = _bootstrap(client)
    me = client.get("/api/auth/me").json()
    resp = client.post(f"/api/auth/coders/{me['id']}/archive", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 400


def test_unarchive_restores_to_roster(client):
    csrf = _bootstrap(client)
    b = client.post("/api/auth/coders", json={"username": "BackAgain"}, headers={"X-CSRF-Token": csrf}).json()
    client.post(f"/api/auth/coders/{b['id']}/archive", headers={"X-CSRF-Token": csrf})
    assert "BackAgain" not in [c["username"] for c in client.get("/api/auth/coders").json()]
    resp = client.post(f"/api/auth/coders/{b['id']}/unarchive", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 200, resp.text
    assert resp.json()["archived"] is False
    assert "BackAgain" in [c["username"] for c in client.get("/api/auth/coders").json()]


def test_unarchive_unknown_coder_404(client):
    csrf = _bootstrap(client)
    resp = client.post("/api/auth/coders/99999/unarchive", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 404


def test_list_coders_include_archived(client):
    """Default roster hides archived; ?include_archived=true surfaces them (Settings
    manager) — system coders stay excluded in BOTH modes."""
    csrf = _bootstrap(client)
    b = client.post("/api/auth/coders", json={"username": "Shelved"}, headers={"X-CSRF-Token": csrf}).json()
    client.post(f"/api/auth/coders/{b['id']}/archive", headers={"X-CSRF-Token": csrf})
    _insert_system_coder()  # Unattributed — must never appear

    default_names = [c["username"] for c in client.get("/api/auth/coders").json()]
    assert "Shelved" not in default_names and "Unattributed" not in default_names

    all_coders = client.get("/api/auth/coders?include_archived=true").json()
    names = [c["username"] for c in all_coders]
    assert "Shelved" in names, "archived coder should appear with include_archived"
    assert "Unattributed" not in names, "system coder excluded even with include_archived"
    shelved = next(c for c in all_coders if c["username"] == "Shelved")
    assert shelved["archived"] is True


# ── ownership reframe: projects shared across the roster when flag is off ─────

def test_projects_shared_across_roster_flag_off(client):
    csrf = _bootstrap(client)
    proj = client.post("/api/projects", json={"name": "Shared Study"}, headers={"X-CSRF-Token": csrf})
    assert proj.status_code == 200, proj.text
    pid = proj.json()["id"]

    b = client.post("/api/auth/coders", json={"username": "Coder B"}, headers={"X-CSRF-Token": csrf}).json()
    client.post("/api/auth/switch-coder", json={"coder_id": b["id"]}, headers={"X-CSRF-Token": csrf})

    listed = client.get("/api/projects").json()
    assert any(p["id"] == pid for p in listed["projects"]), "Coder B should see the shared project"
    assert client.get(f"/api/projects/{pid}").status_code == 200, "Coder B should be able to open it"


# ── system coders (Unattributed / consensus) are hidden (Track J · D7) ────────


def _insert_system_coder(username="Unattributed", coder_type="unattributed") -> int:
    """Insert a system coder directly (the D7 migration creates one like this)."""
    db = SessionLocal()
    try:
        u = User(username=username, password_hash=None, coder_type=coder_type)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u.id
    finally:
        db.close()


def test_system_coder_excluded_from_roster(client):
    """A coder_type='unattributed'/'consensus' row owns data but is NOT a
    selectable coder — it stays out of the roster (so multiCoder, derived from
    the roster length, doesn't trip on a single-human project with legacy data)."""
    _bootstrap(client)  # provisions the human "Researcher"
    _insert_system_coder()
    coders = client.get("/api/auth/coders").json()
    assert [c["username"] for c in coders] == ["Researcher"]
    # also covers the future consensus coder
    _insert_system_coder(username="Consensus", coder_type="consensus")
    assert [c["username"] for c in client.get("/api/auth/coders").json()] == ["Researcher"]


def test_cannot_switch_to_system_coder(client):
    csrf = _bootstrap(client)
    uid = _insert_system_coder()
    resp = client.post("/api/auth/switch-coder", json={"coder_id": uid}, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 404


def test_system_coder_not_auto_selected_as_active(client):
    """ensure_default_user must never resolve the active identity to a system
    coder, even after session loss with one present."""
    _bootstrap(client)  # Researcher (human)
    _insert_system_coder()
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM sessions"))
        db.commit()
    finally:
        db.close()
    client.cookies.clear()
    user = client.get("/api/auth/status").json()["user"]
    assert user["username"] == "Researcher", "must re-resolve to the human coder, not Unattributed"
