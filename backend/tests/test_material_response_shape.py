"""Wire-format shape tests for the materials endpoints (#343).

After the element_type → material_type rename, the JSON response shape
must contain the new keys and reject the old ones. Service-level
construction tests bypass FastAPI's response_model serialization (which
is where Pydantic Literal mismatches surface), so this file uses
TestClient to exercise the full HTTP round-trip — see
``feedback_wire_format_flip_verification.md``.
"""

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from app.main import app
from app.database import engine, SessionLocal, Base


# ── Module-scoped DB setup (mirrors test_auth_integration.py) ────────────────


@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _clean_data(_migrated_db):
    yield
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM materials"))
        db.execute(text("DELETE FROM material_collections"))
        db.execute(text("DELETE FROM audit_entries"))
        db.execute(text("DELETE FROM sessions"))
        db.execute(text("DELETE FROM projects"))
        db.execute(text("DELETE FROM users"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _setup_authed(client):
    """Auth (J0 /status auto-provision) + project; returns (csrf_token, project_id)."""
    resp = client.get("/api/auth/status")
    csrf = resp.json()["user"]["csrf_token"]
    proj_resp = client.post(
        "/api/projects",
        json={"name": "WireShape"},
        headers={"X-CSRF-Token": csrf},
    )
    return csrf, proj_resp.json()["id"]


# ── Wire-format response shape tests ─────────────────────────────────────────


def test_create_material_response_uses_material_type(client):
    """POST /materials with material_type returns material_type, not element_type."""
    csrf, pid = _setup_authed(client)
    coll_resp = client.post(
        f"/api/projects/{pid}/material-collections",
        json={"name": "C1"},
        headers={"X-CSRF-Token": csrf},
    )
    cid = coll_resp.json()["id"]

    resp = client.post(
        f"/api/projects/{pid}/material-collections/{cid}/materials",
        json={
            "material_type": "horizontal_bar",
            "config": {"foo": "bar"},
            "auto_name": "Test Chart",
            "source_tab": "descriptives",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert "material_type" in body
    assert body["material_type"] == "horizontal_bar"
    assert "element_type" not in body  # legacy key fully gone


def test_collection_list_response_uses_material_count(client):
    """GET /material-collections returns material_count, not element_count."""
    csrf, pid = _setup_authed(client)
    client.post(
        f"/api/projects/{pid}/material-collections",
        json={"name": "C1"},
        headers={"X-CSRF-Token": csrf},
    )

    resp = client.get(f"/api/projects/{pid}/material-collections")
    assert resp.status_code == 200
    body = resp.json()
    # New projects auto-provision a default "Materials" collection plus the
    # one we created above; both must use the new key.
    assert len(body["collections"]) >= 1
    for coll in body["collections"]:
        assert "material_count" in coll
        assert coll["material_count"] == 0
        assert "element_count" not in coll


def test_all_materials_endpoint_uses_material_type(client):
    """GET /all-materials returns each material with material_type."""
    csrf, pid = _setup_authed(client)
    coll = client.post(
        f"/api/projects/{pid}/material-collections",
        json={"name": "C1"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    client.post(
        f"/api/projects/{pid}/material-collections/{coll['id']}/materials",
        json={
            "material_type": "qual_bar_chart",
            "config": {},
            "auto_name": "Q",
            "source_tab": "qualitative-codes",
        },
        headers={"X-CSRF-Token": csrf},
    )

    resp = client.get(f"/api/projects/{pid}/material-collections/all-materials")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["material_type"] == "qual_bar_chart"
    assert "element_type" not in items[0]


def test_create_material_rejects_legacy_element_type_key(client):
    """Sending element_type (old wire format) on create should fail validation."""
    csrf, pid = _setup_authed(client)
    coll = client.post(
        f"/api/projects/{pid}/material-collections",
        json={"name": "C1"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    resp = client.post(
        f"/api/projects/{pid}/material-collections/{coll['id']}/materials",
        json={
            "element_type": "horizontal_bar",  # legacy key — should 422
            "config": {},
            "auto_name": "Test",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 422


def test_reorder_endpoint_accepts_material_ids(client):
    """POST /materials/reorder takes material_ids (renamed from element_ids)."""
    csrf, pid = _setup_authed(client)
    coll = client.post(
        f"/api/projects/{pid}/material-collections",
        json={"name": "C1"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    cid = coll["id"]
    m1 = client.post(
        f"/api/projects/{pid}/material-collections/{cid}/materials",
        json={"material_type": "chart", "config": {}, "auto_name": "M1"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    m2 = client.post(
        f"/api/projects/{pid}/material-collections/{cid}/materials",
        json={"material_type": "chart", "config": {}, "auto_name": "M2"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    resp = client.post(
        f"/api/projects/{pid}/material-collections/{cid}/materials/reorder",
        json={"material_ids": [m2["id"], m1["id"]]},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200, resp.text
