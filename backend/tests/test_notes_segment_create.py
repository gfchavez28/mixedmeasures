"""Regression: POST /api/conversations/{cid}/notes with a segment_id must not
500-error on an undefined `conversation` reference.

Surfaced by Scenario 2 hardening (2026-05-20). The `create_note` handler
called `_verify_conversation_ownership(...)` without capturing the returned
Conversation, then referenced `conversation.project_id` in the log_action
call — NameError → 500. Any segment-attached note creation through this
endpoint hit it. Scenario 1's driver never exercised the segment-note path
so the bug stayed latent for ~7 months.
"""
import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base
from app.models import User, Project, Conversation, Segment, Speaker
from app.auth import hash_password


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
        for t in ("notes", "code_applications", "segments", "speakers",
                  "conversations", "projects", "sessions", "audit_entries", "users"):
            db.execute(text(f"DELETE FROM {t}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _seed_project_with_segment() -> tuple[int, int]:
    """Create one user, one project, one conversation with one segment.

    Returns (conversation_id, segment_id). The conversation is owned by user_id=1.
    """
    db = SessionLocal()
    try:
        u = User(id=1, username="alice", password_hash=hash_password("password123"), is_admin=True)
        db.add(u)
        p = Project(name="Notes test", user_id=1)
        db.add(p)
        db.flush()
        c = Conversation(project_id=p.id, name="Conv")
        db.add(c)
        db.flush()
        sp = Speaker(project_id=p.id, name="Speaker A", color_index=0)
        db.add(sp)
        db.flush()
        s = Segment(conversation_id=c.id, speaker_id=sp.id, sequence_order=0, text="Hello world", word_count=2)
        db.add(s)
        db.commit()
        return c.id, s.id
    finally:
        db.close()


def _login(client: TestClient) -> str:
    """J0 flow: /status adopts the existing lowest-id user (alice) and mints a session."""
    r = client.get("/api/auth/status")
    assert r.status_code == 200, r.text
    assert r.json()["user"]["username"] == "alice"
    return r.json()["user"]["csrf_token"]


def test_create_segment_note_does_not_500(client):
    """The bug: 500 due to NameError on `conversation.project_id` in create_note.

    Pre-fix: every POST /api/conversations/{cid}/notes with a segment_id raised
    NameError -> 500. Post-fix: returns 200 and creates the note.
    """
    cid, sid = _seed_project_with_segment()
    csrf = _login(client)
    headers = {"X-CSRF-Token": csrf}

    r = client.post(
        f"/api/conversations/{cid}/notes",
        json={"segment_id": sid, "content": "Anchor quote — landmark moment."},
        headers=headers,
    )
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body["content"] == "Anchor quote — landmark moment."
    assert body["segment_id"] == sid
    assert body["conversation_id"] == cid


def test_create_standalone_note_does_not_500(client):
    """The same NameError could fire on a standalone note (no segment_id) because
    log_action's project_id arg references conversation.project_id unconditionally.
    """
    cid, _sid = _seed_project_with_segment()
    csrf = _login(client)
    headers = {"X-CSRF-Token": csrf}

    r = client.post(
        f"/api/conversations/{cid}/notes",
        json={"content": "Standalone note on the conversation."},
        headers=headers,
    )
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body["content"] == "Standalone note on the conversation."
    assert body["conversation_id"] == cid
    assert body.get("segment_id") is None
