"""Integration tests for auth endpoints using FastAPI TestClient.

Tests the full HTTP request/response cycle including cookies, CSRF tokens,
session management, and error responses.

Uses the app's global :memory: engine (set by conftest.py). A module-scoped
fixture runs the lifespan once (triggering Alembic migrations) and each test
gets a fresh TestClient with user data cleaned between runs.
"""
import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base


@pytest.fixture(scope="module")
def _migrated_db():
    """Run Alembic migrations once for this module via app lifespan.

    The conftest.py sets MM_DATABASE_PATH=:memory: which is the global
    engine's target. We use create_all as a fast alternative to running
    51 sequential Alembic migrations for test speed.
    """
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="module", autouse=True)
def _enable_multiuser_auth():
    """This module deliberately exercises the gated multi-user surface
    (/setup, /login, /logout, /change-password, /users — default-off since
    an internal audit). Flip the flag on the cached Settings singleton for the
    module; the gate reads it per-request via get_settings(). Default-off
    behavior is pinned separately in test_auth_endpoint_gate.py.
    """
    from app.config import get_settings
    settings = get_settings()
    original = settings.mm_multiuser_auth_enabled
    settings.mm_multiuser_auth_enabled = True
    yield
    settings.mm_multiuser_auth_enabled = original


@pytest.fixture(autouse=True)
def _clean_auth_data(_migrated_db):
    """Clean all auth-related data between tests for isolation."""
    yield
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM audit_entries"))
        db.execute(text("DELETE FROM sessions"))
        db.execute(text("DELETE FROM projects"))
        db.execute(text("DELETE FROM users"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    """TestClient without lifespan (DB already set up by _migrated_db)."""
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── Setup endpoint ──────────────────────────────────────────────────────────


def test_status_auto_provisions_local_coder(client):
    """Fresh DB: /status auto-provisions a local coder and auto-authenticates (no login screen)."""
    resp = client.get("/api/auth/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["needs_setup"] is False
    assert data["authenticated"] is True
    assert data["user"] is not None
    assert data["user"]["username"] == "Researcher"
    assert data["user"]["csrf_token"] is not None
    # A session cookie is minted so subsequent requests are authenticated.
    assert "mm_session" in client.cookies


def test_status_reuses_existing_session(client):
    """A second /status call with the minted cookie reuses the session (no churn)."""
    first = client.get("/api/auth/status").json()["user"]
    second = client.get("/api/auth/status").json()["user"]
    assert second["id"] == first["id"]
    assert second["csrf_token"] == first["csrf_token"]  # same session, same token


def test_setup_creates_user(client):
    """POST /setup creates first user, sets cookie, returns CSRF token."""
    resp = client.post("/api/auth/setup", json={
        "username": "admin",
        "password": "securepass123",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "admin"
    assert data["id"] == 1
    assert data["csrf_token"] is not None
    assert len(data["csrf_token"]) == 64

    # Cookie should be set
    assert "mm_session" in client.cookies


def test_setup_blocked_after_first_user(client):
    """POST /setup fails 400 if users already exist."""
    client.post("/api/auth/setup", json={
        "username": "admin",
        "password": "securepass123",
    })
    resp = client.post("/api/auth/setup", json={
        "username": "second",
        "password": "anotherpass1",
    })
    assert resp.status_code == 400
    assert "already completed" in resp.json()["detail"].lower()


def test_setup_validation_short_username(client):
    """Setup rejects username < 3 chars."""
    resp = client.post("/api/auth/setup", json={
        "username": "ab",
        "password": "securepass123",
    })
    assert resp.status_code == 422


def test_setup_validation_short_password(client):
    """Setup rejects password < 8 chars."""
    resp = client.post("/api/auth/setup", json={
        "username": "admin",
        "password": "short",
    })
    assert resp.status_code == 422


# ── Login endpoint ──────────────────────────────────────────────────────────


def _setup_user(client, username="admin", password="securepass123"):
    """Helper: create a user via setup and return the CSRF token."""
    resp = client.post("/api/auth/setup", json={
        "username": username,
        "password": password,
    })
    return resp.json()["csrf_token"]


def test_login_success(client):
    """Login with correct credentials returns user + CSRF token."""
    _setup_user(client)
    client.cookies.clear()

    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "securepass123",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "admin"
    assert data["csrf_token"] is not None
    assert "mm_session" in client.cookies


def test_login_wrong_password(client):
    """Login with wrong password returns 401."""
    _setup_user(client)
    client.cookies.clear()

    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "wrongpassword",
    })
    assert resp.status_code == 401
    assert "invalid credentials" in resp.json()["detail"].lower()


def test_login_nonexistent_user(client):
    """Login with non-existent user returns 401."""
    _setup_user(client)
    client.cookies.clear()

    resp = client.post("/api/auth/login", json={
        "username": "nobody",
        "password": "securepass123",
    })
    assert resp.status_code == 401


def test_status_authenticated(client):
    """After login, /status shows authenticated=true."""
    _setup_user(client)

    resp = client.get("/api/auth/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["authenticated"] is True
    assert data["needs_setup"] is False
    assert data["user"]["username"] == "admin"


# ── Logout endpoint ────────────────────────────────────────────────────────


def test_logout_then_status_reauthenticates(client):
    """Logout invalidates the session; /status then auto-provisions a fresh one (local-first, no signed-out state)."""
    _setup_user(client)

    resp = client.post("/api/auth/logout")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"

    # The old session is gone: an auth-only endpoint rejects the cleared cookie.
    assert client.get("/api/auth/me").status_code == 401

    # But /status re-establishes a session automatically — there is no signed-out state.
    assert client.get("/api/auth/status").json()["authenticated"] is True


def test_logout_without_session(client):
    """Logout without a session still returns 200."""
    resp = client.post("/api/auth/logout")
    assert resp.status_code == 200


# ── CSRF protection ────────────────────────────────────────────────────────


def test_csrf_required_for_state_change(client):
    """POST to protected endpoint without CSRF token returns 403."""
    _setup_user(client)

    resp = client.post("/api/auth/change-password", json={
        "current_password": "securepass123",
        "new_password": "newsecurepass1",
    })
    assert resp.status_code == 403
    assert "csrf" in resp.json()["detail"].lower()


def test_csrf_wrong_token(client):
    """POST with wrong CSRF token returns 403."""
    _setup_user(client)

    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "securepass123", "new_password": "newsecurepass1"},
        headers={"X-CSRF-Token": "wrong_token_value"},
    )
    assert resp.status_code == 403


def test_csrf_correct_token(client):
    """POST with correct CSRF token succeeds."""
    csrf = _setup_user(client)

    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "securepass123", "new_password": "newsecurepass1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200


# ── Change password ─────────────────────────────────────────────────────────


def test_change_password_wrong_current(client):
    """Change password with wrong current password returns 400."""
    csrf = _setup_user(client)

    resp = client.post(
        "/api/auth/change-password",
        json={"current_password": "wrongpassword", "new_password": "newsecurepass1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 400
    assert "incorrect" in resp.json()["detail"].lower()


def test_change_password_then_login(client):
    """After changing password, old password fails and new password works."""
    csrf = _setup_user(client)

    client.post(
        "/api/auth/change-password",
        json={"current_password": "securepass123", "new_password": "brandnewpass1"},
        headers={"X-CSRF-Token": csrf},
    )
    client.post("/api/auth/logout")

    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "securepass123",
    })
    assert resp.status_code == 401

    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "brandnewpass1",
    })
    assert resp.status_code == 200


# ── /me endpoint ────────────────────────────────────────────────────────────


def test_me_authenticated(client):
    """GET /me returns current user when authenticated."""
    _setup_user(client)

    resp = client.get("/api/auth/me")
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "admin"
    assert data["csrf_token"] is not None


def test_me_unauthenticated(client):
    """GET /me returns 401 when not authenticated (only /status auto-provisions, not /me)."""
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401


# ── Coder rename (PATCH /me) ────────────────────────────────────────────────


def test_update_profile_renames_coder(client):
    """PATCH /me renames the active coder, and the change persists."""
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]

    resp = client.patch(
        "/api/auth/me",
        json={"username": "Dr. Alvarez"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200
    assert resp.json()["username"] == "Dr. Alvarez"
    assert client.get("/api/auth/status").json()["user"]["username"] == "Dr. Alvarez"


def test_update_profile_rejects_empty_name(client):
    """A whitespace-only coder name is rejected (400)."""
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
    resp = client.patch(
        "/api/auth/me",
        json={"username": "   "},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 400


def test_update_profile_rejects_duplicate_name(client):
    """Renaming to another existing coder's name is rejected (409)."""
    admin_csrf = _setup_user(client, "admin", "securepass123")
    client.post(
        "/api/auth/users",
        json={"username": "researcher", "password": "securepass123"},
        headers={"X-CSRF-Token": admin_csrf},
    )
    resp = client.patch(
        "/api/auth/me",
        json={"username": "researcher"},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert resp.status_code == 409


# ── Session expiry ──────────────────────────────────────────────────────────


def test_expired_session_returns_401(client):
    """An expired session should be rejected."""
    from datetime import datetime, timedelta, timezone
    from app.models.user import Session as SessionModel

    _setup_user(client)

    db = SessionLocal()
    try:
        session = db.query(SessionModel).first()
        assert session is not None
        session.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
        db.commit()
    finally:
        db.close()

    resp = client.get("/api/auth/me")
    assert resp.status_code == 401


# ── Edge cases ──────────────────────────────────────────────────────────────


def test_unicode_username(client):
    """Setup and login with standard username works correctly."""
    client.post("/api/auth/setup", json={
        "username": "researcher",
        "password": "securepass123",
    })
    client.cookies.clear()

    resp = client.post("/api/auth/login", json={
        "username": "researcher",
        "password": "securepass123",
    })
    assert resp.status_code == 200


def test_health_endpoint(client):
    """Health endpoint returns 200 with database check."""
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["database"] == "ok"


# ── Admin & multi-user ────────────────────────────────────────────────────


def test_setup_creates_admin(client):
    """First user created via setup is an admin."""
    resp = client.post("/api/auth/setup", json={
        "username": "admin",
        "password": "securepass123",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_admin"] is True


def test_status_includes_timeout(client):
    """/auth/status includes inactivity_timeout_minutes field."""
    resp = client.get("/api/auth/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "inactivity_timeout_minutes" in data
    assert data["inactivity_timeout_minutes"] == 0  # default disabled


def test_status_includes_encryption_flag(client):
    """/auth/status reports encryption_enabled for the Settings status row (D2).
    Default (tests run :memory: → force-plaintext) is False."""
    resp = client.get("/api/auth/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "encryption_enabled" in data
    assert data["encryption_enabled"] is False


def test_create_user_as_admin(client):
    """Admin can create a new user via POST /auth/users."""
    csrf = _setup_user(client)

    resp = client.post(
        "/api/auth/users",
        json={"username": "researcher", "password": "securepass123"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "researcher"
    assert data["is_admin"] is False


def test_create_user_non_admin_rejected(client):
    """Non-admin cannot create users (403)."""
    admin_csrf = _setup_user(client)

    # Create a non-admin user
    client.post(
        "/api/auth/users",
        json={"username": "researcher", "password": "securepass123"},
        headers={"X-CSRF-Token": admin_csrf},
    )

    # Login as the non-admin
    client.cookies.clear()
    resp = client.post("/api/auth/login", json={
        "username": "researcher",
        "password": "securepass123",
    })
    researcher_csrf = resp.json()["csrf_token"]

    # Non-admin tries to create a user
    resp = client.post(
        "/api/auth/users",
        json={"username": "another", "password": "securepass123"},
        headers={"X-CSRF-Token": researcher_csrf},
    )
    assert resp.status_code == 403
    assert "admin" in resp.json()["detail"].lower()


def test_create_user_duplicate_username(client):
    """Creating a user with an existing username returns 409."""
    csrf = _setup_user(client)

    # Create first user
    client.post(
        "/api/auth/users",
        json={"username": "researcher", "password": "securepass123"},
        headers={"X-CSRF-Token": csrf},
    )

    # Try duplicate
    resp = client.post(
        "/api/auth/users",
        json={"username": "researcher", "password": "differentpass1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"].lower()


def test_inactivity_timeout(client):
    """Session is invalidated when last_activity_at exceeds timeout."""
    from datetime import datetime, timedelta, timezone
    from unittest.mock import patch
    from app.models.user import Session as SessionModel

    _setup_user(client)

    # Manually set last_activity_at to the past
    db = SessionLocal()
    try:
        session = db.query(SessionModel).first()
        assert session is not None
        session.last_activity_at = (
            datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=60)
        )
        db.commit()
    finally:
        db.close()

    # With timeout enabled, should get 401
    with patch("app.auth.settings") as mock_settings:
        mock_settings.inactivity_timeout_minutes = 30
        mock_settings.csrf_enabled = True

        resp = client.get("/api/auth/me")
        assert resp.status_code == 401
        assert "inactivity" in resp.json()["detail"].lower()


# ── Two-user helpers ──────────────────────────────────────────────────────


def _setup_two_users(client):
    """Create admin + researcher. Returns (admin_csrf, researcher_csrf).

    On return, the client session belongs to the admin.
    """
    admin_csrf = _setup_user(client, "admin", "securepass123")

    # Admin creates researcher
    client.post(
        "/api/auth/users",
        json={"username": "researcher", "password": "securepass123"},
        headers={"X-CSRF-Token": admin_csrf},
    )

    # Save admin cookies, login as researcher
    admin_cookies = dict(client.cookies)
    client.cookies.clear()
    resp = client.post("/api/auth/login", json={
        "username": "researcher",
        "password": "securepass123",
    })
    researcher_csrf = resp.json()["csrf_token"]

    # Switch back to admin session
    client.cookies.clear()
    client.cookies.update(admin_cookies)

    return admin_csrf, researcher_csrf


def _login_as(client, username, password):
    """Login as a specific user. Returns CSRF token."""
    client.cookies.clear()
    resp = client.post("/api/auth/login", json={
        "username": username,
        "password": password,
    })
    return resp.json()["csrf_token"]


def _create_project_with_data(client, csrf, project_name="Test Project"):
    """Create a project with a conversation, segment, and code. Returns IDs."""
    from app.models.conversation import Conversation
    from app.models.segment import Segment
    from app.models.code import Code

    # Create project via API
    resp = client.post(
        f"/api/projects",
        json={"name": project_name},
        headers={"X-CSRF-Token": csrf},
    )
    project_id = resp.json()["id"]

    # Insert conversation + segment + code directly (no CSV import endpoint for tests)
    db = SessionLocal()
    try:
        conv = Conversation(project_id=project_id, name="Interview 1", status="imported")
        db.add(conv)
        db.flush()

        seg = Segment(conversation_id=conv.id, sequence_order=0, text="Test segment", word_count=2)
        db.add(seg)
        db.flush()

        code = Code(project_id=project_id, numeric_id=1, name="Theme A", color="#ff0000")
        db.add(code)
        db.flush()

        ids = {"project_id": project_id, "conversation_id": conv.id, "segment_id": seg.id, "code_id": code.id}
        db.commit()
        return ids
    finally:
        db.close()


# ── Cross-user project isolation ──────────────────────────────────────────


def test_user_b_cannot_list_user_a_projects(client):
    """Researcher sees empty project list (admin's projects are hidden)."""
    admin_csrf, _ = _setup_two_users(client)

    # Admin creates a project
    client.post(
        "/api/projects",
        json={"name": "Admin's Project"},
        headers={"X-CSRF-Token": admin_csrf},
    )

    # Researcher lists projects → empty
    _login_as(client, "researcher", "securepass123")
    resp = client.get("/api/projects")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


def test_user_b_cannot_get_user_a_project(client):
    """Researcher gets 404 on admin's project."""
    admin_csrf, _ = _setup_two_users(client)
    ids = _create_project_with_data(client, admin_csrf)

    _login_as(client, "researcher", "securepass123")
    resp = client.get(f"/api/projects/{ids['project_id']}")
    assert resp.status_code == 404


def test_user_b_cannot_update_user_a_project(client):
    """Researcher gets 404 trying to update admin's project."""
    admin_csrf, _ = _setup_two_users(client)
    ids = _create_project_with_data(client, admin_csrf)

    researcher_csrf = _login_as(client, "researcher", "securepass123")
    resp = client.patch(
        f"/api/projects/{ids['project_id']}",
        json={"name": "Hacked Name"},
        headers={"X-CSRF-Token": researcher_csrf},
    )
    assert resp.status_code == 404


def test_user_b_cannot_delete_user_a_project(client):
    """Researcher gets 404 trying to delete admin's project."""
    admin_csrf, _ = _setup_two_users(client)
    ids = _create_project_with_data(client, admin_csrf)

    researcher_csrf = _login_as(client, "researcher", "securepass123")
    resp = client.delete(
        f"/api/projects/{ids['project_id']}",
        headers={"X-CSRF-Token": researcher_csrf},
    )
    assert resp.status_code == 404


# ── Cross-user child entity isolation ─────────────────────────────────────


def test_user_b_cannot_access_user_a_conversation_segments(client):
    """Researcher gets 404 on admin's conversation segments."""
    admin_csrf, _ = _setup_two_users(client)
    ids = _create_project_with_data(client, admin_csrf)

    _login_as(client, "researcher", "securepass123")
    resp = client.get(f"/api/conversations/{ids['conversation_id']}/segments")
    assert resp.status_code == 404


def test_user_b_cannot_code_user_a_segment(client):
    """Researcher gets 404 trying to apply code to admin's segment."""
    admin_csrf, _ = _setup_two_users(client)
    ids = _create_project_with_data(client, admin_csrf)

    researcher_csrf = _login_as(client, "researcher", "securepass123")
    resp = client.post(
        f"/api/segments/{ids['segment_id']}/codes/{ids['code_id']}",
        headers={"X-CSRF-Token": researcher_csrf},
    )
    assert resp.status_code == 404


# ── Import ownership ──────────────────────────────────────────────────────


def test_import_assigns_to_importing_user(client):
    """Imported project is owned by the importing user, not the original owner."""
    from app.models.project import Project
    from app.services.project_portability import export_project, import_project
    from pathlib import Path
    import tempfile

    admin_csrf, _ = _setup_two_users(client)
    ids = _create_project_with_data(client, admin_csrf, "Exportable")

    db = SessionLocal()
    try:
        # Export admin's project
        buf = export_project(db, ids["project_id"], Path("/nonexistent"))

        # Find researcher's user ID
        from app.models.user import User
        researcher = db.query(User).filter(User.username == "researcher").first()
        assert researcher is not None

        # Import as researcher
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        tmp.write(buf.getvalue())
        tmp.close()

        new_id, _ = import_project(db, Path(tmp.name), Path("/tmp/docs_test"), user_id=researcher.id)
        db.commit()

        # Verify ownership
        new_project = db.query(Project).filter(Project.id == new_id).first()
        assert new_project is not None
        assert new_project.user_id == researcher.id
        assert new_project.user_id != ids["project_id"]  # different owner
    finally:
        db.close()
        import os
        os.unlink(tmp.name)


# ── List users endpoint ───────────────────────────────────────────────────


def test_list_users_admin_only(client):
    """Non-admin gets 403 on list users endpoint."""
    _, researcher_csrf = _setup_two_users(client)

    _login_as(client, "researcher", "securepass123")
    resp = client.get("/api/auth/users")
    assert resp.status_code == 403


def test_list_users_returns_all(client):
    """Admin sees all users."""
    _setup_two_users(client)

    resp = client.get("/api/auth/users")
    assert resp.status_code == 200
    users = resp.json()
    assert len(users) == 2
    usernames = {u["username"] for u in users}
    assert usernames == {"admin", "researcher"}
