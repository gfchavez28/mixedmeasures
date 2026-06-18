"""Response-layer regression tests for an internal audit: non-ASCII export filenames.

Content-Disposition filename= values are encoded latin-1 at the ASGI layer.
`sanitize_csv_filename` used a Unicode-aware `\\w` class, so CJK/Cyrillic/Greek
letters in a project name survived into the header and raised UnicodeEncodeError
at response time — every export endpoint 500'd for a project named outside
latin-1 (live-reproduced 2026-06-10). The helper now NFKD-folds accented Latin
to base letters, drops anything else non-ASCII, and falls back to "project"
when nothing survives.

Wire-format behavior needs coverage at the HTTP response layer, not the
service layer (same lesson as test_datetime_wire_format.py).
"""
import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from app.main import app
from app.database import engine, SessionLocal, Base
from app.routers.helpers import sanitize_csv_filename, sanitize_content_disposition


# ---------------------------------------------------------------- unit layer

def test_cyrillic_cjk_folds_to_ascii():
    out = sanitize_csv_filename("Оценка программы 数学")
    out.encode("latin-1")  # must not raise
    assert out.isascii()

def test_accented_latin_transliterates():
    assert sanitize_csv_filename("Évaluation finale") == "Evaluation_finale"

def test_fully_non_latin_falls_back():
    assert sanitize_csv_filename("数学课程评估") == "project"
    assert sanitize_csv_filename("Оценка") == "project"

def test_ascii_passthrough_unchanged():
    assert sanitize_csv_filename("My Project-2.1") == "My_Project-2.1"

def test_control_chars_still_stripped():
    out = sanitize_content_disposition('Ev\r\nil"name\0')
    assert "\r" not in out and "\n" not in out and "\0" not in out
    out.encode("latin-1")


# ------------------------------------------------------------ response layer

@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM audit_entries"))
        db.execute(text("DELETE FROM sessions"))
        db.execute(text("DELETE FROM projects"))
        db.execute(text("DELETE FROM users"))
        db.commit()
    finally:
        db.close()


def test_export_succeeds_for_non_latin_project_name(client):
    """The live-repro case: a Cyrillic+CJK project name must not 500 the export."""
    status = client.get("/api/auth/status")
    headers = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
    resp = client.post(
        "/api/projects", json={"name": "Оценка программы 数学"}, headers=headers
    )
    assert resp.status_code in (200, 201), resp.text
    pid = resp.json()["id"]

    export = client.get(f"/api/projects/{pid}/export/csv")
    assert export.status_code == 200, export.text
    disposition = export.headers["content-disposition"]
    disposition.encode("latin-1")  # the header must be encodable
    assert "project_export_" in disposition
