"""#1203 — a file that is not a codebook is refused in a sentence naming it.

The codebook import decoded the upload OUTSIDE its `try`, so a binary file — a
project or a backup is a ZIP — answered a 500; a CSV toasted the JSON parser's
"Expecting value: line 1 column 1 (char 0)"; a JSON list reached `.get` and 500'd.
The client now refuses the wrong KIND at selection (`lib/mm-file-refusal.ts`), so
these are the server's own answers to a file that got past it (a renamed file, a
direct request) — entered at the endpoint, through the real router.
"""

import io
import json
import zipfile

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.services.codebook_exchange import CURRENT_FORMAT_VERSION  # the codebook's own, not the project's


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
        for t in ("audit_entries", "codes", "code_categories", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {t}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _post(client: TestClient, name: str, body: bytes):
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
    pid = client.post("/api/projects", json={"name": "Codebook"}, headers={"X-CSRF-Token": csrf}).json()["id"]
    return client.post(
        f"/api/projects/{pid}/import-codebook",
        files={"file": (name, body, "application/octet-stream")},
        headers={"X-CSRF-Token": csrf},
    )


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps({"format_type": "mmproject"}))
        zf.writestr("blob.bin", bytes(range(256)) * 64)
    return buf.getvalue()


@pytest.mark.parametrize("name,body", [
    ("study.mmproject", _zip_bytes()),            # a ZIP: was a 500 from the decode
    ("survey.csv", b"id,age\n1,34\n2,51\n"),     # was "Expecting value: line 1 column 1 (char 0)"
    ("list.json", b"[1, 2, 3]"),                 # was a 500 from `.get` on a list
    ("other.json", b'{"rows": []}'),             # was "Invalid format_type: None"
], ids=lambda v: v if isinstance(v, str) else "")
def test_a_file_that_is_not_a_codebook_is_refused_by_name(client, name, body):
    resp = _post(client, name, body)
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert detail.startswith(f"“{name}” is not a codebook file."), detail
    assert ".mmcodebook" in detail and ".qdc" in detail


def test_a_real_codebook_still_imports_and_reports_its_code_sets(client):
    """The positive control: a refusal that fired on everything would pass above.

    #1222, found by writing it: the native import has returned `code_sets_created`
    since row 48 and `CodebookImportResult` did not declare it, so under pytest's
    `extra='forbid'` this success answered 500 (and production dropped the count).
    No test had imported a native codebook through the ENDPOINT before."""
    code_set = {"label": "Stance", "exhaustive": False}
    body = json.dumps({
        "format_type": "mmcodebook",
        "format_version": CURRENT_FORMAT_VERSION,
        "categories": [],
        "codes": [
            {"name": "For", "numeric_id": 2, "code_set": code_set},
            {"name": "Against", "numeric_id": 3, "code_set": code_set},
        ],
    }).encode()
    resp = _post(client, "codes.mmcodebook", body)
    assert resp.status_code == 200, resp.text
    assert resp.json()["codes_created"] == 2
    assert resp.json()["code_sets_created"] == 1


def test_a_newer_codebook_keeps_the_services_own_sentence(client):
    """The dict check must not swallow the format gate's refusal, which names the
    reason (a newer version) the researcher can act on."""
    body = json.dumps({"format_type": "mmcodebook", "format_version": CURRENT_FORMAT_VERSION + 1}).encode()
    resp = _post(client, "future.mmcodebook", body)
    assert resp.status_code == 400
    assert "newer version" in resp.json()["detail"]
