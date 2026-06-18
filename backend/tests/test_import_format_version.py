"""Universal format_version enforcement on all import paths.

The forward-compat gate (refuse files written by a NEWER app version with a
clear message instead of crashing mid-import) originally lived only in
validate_project_file, which only the /validate-import endpoint calls. The UI
calls validate before import, but direct API/script imports hit
POST /import-project (and /import-codebook) without it — so the guard must be
enforced inside the import paths themselves. It only protects v1.0 installs
if it ships in the v1.0 binaries (ROADMAP step-9 pre-build item; multi-coder
plan §3b item 1; an internal audit squash-agent finding).

Service-level tests cover the ValueError; TestClient tests pin the 400 (not
500) at the response layer per feedback_wire_format_flip_verification.
"""
import io
import json
import zipfile
from pathlib import Path

import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base
from app.services.project_portability import import_project, CURRENT_FORMAT_VERSION
from app.services.codebook_exchange import import_codebook_native
from app.models import Project


def _future_mmproject_bytes(version: int = CURRENT_FORMAT_VERSION + 1) -> bytes:
    buf = io.BytesIO()
    manifest = {"format_version": version, "format_type": "mmproject", "app_version": "9.0.0"}
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("project.json", "{}")
    return buf.getvalue()


# ── Service layer ────────────────────────────────────────────────────────


class TestImportProjectFormatGate:

    def test_future_version_rejected(self, db_session, tmp_path):
        file_path = tmp_path / "future.mmproject"
        file_path.write_bytes(_future_mmproject_bytes())
        with pytest.raises(ValueError, match="newer version"):
            import_project(db_session, file_path, tmp_path / "docs", user_id=1)

    def test_missing_manifest_rejected(self, db_session, tmp_path):
        file_path = tmp_path / "no_manifest.mmproject"
        with zipfile.ZipFile(file_path, "w") as zf:
            zf.writestr("project.json", "{}")
        with pytest.raises(ValueError, match="missing manifest.json"):
            import_project(db_session, file_path, tmp_path / "docs", user_id=1)

    def test_wrong_format_type_rejected(self, db_session, tmp_path):
        """A .mmbackup posted to import-project fails the gate, not deep in import."""
        file_path = tmp_path / "actually_a_backup.mmproject"
        manifest = {"format_version": 1, "app_version": "1.0.0"}  # no format_type, like .mmbackup
        with zipfile.ZipFile(file_path, "w") as zf:
            zf.writestr("manifest.json", json.dumps(manifest))
            zf.writestr("project.json", "{}")
        with pytest.raises(ValueError, match="format_type"):
            import_project(db_session, file_path, tmp_path / "docs", user_id=1)


class TestImportCodebookFormatGate:

    def test_future_version_rejected(self, db_session):
        data = {"format_type": "mmcodebook", "format_version": CURRENT_FORMAT_VERSION + 1}
        with pytest.raises(ValueError, match="newer version"):
            import_codebook_native(db_session, 1, data)

    def test_missing_format_version_tolerated(self, db_session):
        """Legacy tolerance: absent format_version defaults to 0 (older), not an error."""
        project = Project(name="Codebook gate", user_id=1)
        db_session.add(project)
        db_session.flush()
        data = {"format_type": "mmcodebook", "categories": [], "codes": []}
        counts = import_codebook_native(db_session, project.id, data)
        assert counts["codes_created"] == 0


# ── Response layer (TestClient) ──────────────────────────────────────────


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


def _csrf(client: TestClient) -> str:
    """J0 flow: /status auto-provisions the local coder and returns the CSRF token."""
    resp = client.get("/api/auth/status")
    assert resp.status_code == 200, resp.text
    return resp.json()["user"]["csrf_token"]


class TestImportEndpointsFormatGate:

    def test_import_project_future_version_400(self, client):
        csrf = _csrf(client)
        resp = client.post(
            "/api/projects/import-project",
            files={"file": ("future.mmproject", _future_mmproject_bytes(), "application/zip")},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 400, resp.text
        assert "newer version" in resp.json()["detail"]

    def test_import_project_missing_manifest_400(self, client):
        """Friendly 400, not a KeyError 500, for a manifest-less zip."""
        csrf = _csrf(client)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("project.json", "{}")
        resp = client.post(
            "/api/projects/import-project",
            files={"file": ("bad.mmproject", buf.getvalue(), "application/zip")},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 400, resp.text
        assert "missing manifest.json" in resp.json()["detail"]

    def test_import_codebook_future_version_400(self, client):
        csrf = _csrf(client)
        proj = client.post(
            "/api/projects", json={"name": "Gate"}, headers={"X-CSRF-Token": csrf}
        )
        assert proj.status_code in (200, 201), proj.text
        pid = proj.json()["id"]

        data = {"format_type": "mmcodebook", "format_version": CURRENT_FORMAT_VERSION + 1}
        resp = client.post(
            f"/api/projects/{pid}/import-codebook",
            files={"file": ("future.mmcodebook", json.dumps(data).encode(), "application/json")},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 400, resp.text
        assert "newer version" in resp.json()["detail"]
