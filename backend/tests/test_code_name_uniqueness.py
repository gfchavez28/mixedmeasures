"""A code name is unique within a project — the server half of #963's last item.

Context worth carrying, because it decided where the refusal lives:

- **Nine client surfaces create a code from a typed name** (measured 2026-09-18) and
  only six of them checked for a duplicate first. `create_code` checked nothing, so
  on the other three the twin was simply created — and the codebook has no way to
  tell two identically-named codes apart in a chip.
- **The refusal is at the ROUTER, deliberately.** `services/codebook_exchange.py`
  identifies an incoming code by `(name, category_path)` and constructs `Code(...)`
  directly, as does `ensure_universal_codes`. A service-level refusal would refuse
  `.qdc` / `.mmcodebook` imports that the exchange format permits. The tests at the
  bottom of this file pin that separation, because it is the thing a future
  "single-source this properly" refactor would break.
- **This module is the FIRST test of any kind against `/codes` over HTTP** — the
  suite had zero (`grep -c "client\\.(post|get|…)" … /codes` = 0 on 2026-09-18), so
  the endpoint's ordinary paths are pinned here too, not just the refusal.
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
        for tbl in (
            "code_applications", "codes", "code_categories",
            "audit_entries", "sessions", "projects", "users",
        ):
            db.execute(text(f"DELETE FROM {tbl}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def project(client):
    """Auto-provision the default coder, make a project, return (project_id, csrf)."""
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
    resp = client.post(
        "/api/projects",
        json={"name": "Duplicate-name fixture"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"], csrf


def _create(client, project, name, csrf, **extra):
    return client.post(
        f"/api/projects/{project}/codes",
        json={"name": name, **extra},
        headers={"X-CSRF-Token": csrf},
    )


# ── the ordinary path still works ────────────────────────────────────────────

def test_a_first_code_is_created(client, project):
    pid, csrf = project
    resp = _create(client, pid, "Barriers", csrf)
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Barriers"


def test_two_different_names_are_both_created(client, project):
    pid, csrf = project
    assert _create(client, pid, "Barriers", csrf).status_code == 200
    assert _create(client, pid, "Facilitators", csrf).status_code == 200


# ── the refusal ──────────────────────────────────────────────────────────────

def test_an_exact_duplicate_is_refused(client, project):
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    resp = _create(client, pid, "Barriers", csrf)
    assert resp.status_code == 409
    # The message NAMES the existing code — "already exists" alone leaves the
    # researcher hunting for which one.
    assert "Barriers" in resp.json()["detail"]


def test_a_case_variant_is_refused(client, project):
    """The six client surfaces that hint this compare `toLowerCase()`d, so a
    server that accepted `BARRIERS` would contradict the hint on screen."""
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    assert _create(client, pid, "BARRIERS", csrf).status_code == 409
    assert _create(client, pid, "barriers", csrf).status_code == 409


def test_surrounding_whitespace_is_refused(client, project):
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    assert _create(client, pid, "  Barriers  ", csrf).status_code == 409


def test_a_non_ascii_case_variant_is_refused(client, project):
    """SQLite's own `lower()` is ASCII-only, so a `func.lower()` filter would let
    this through while every client check calls it a duplicate. Compared in
    Python for exactly this case."""
    pid, csrf = project
    _create(client, pid, "École", csrf)
    assert _create(client, pid, "école", csrf).status_code == 409


def test_an_INACTIVE_code_still_holds_its_name(client, project):
    """Deactivating does not release the name: reactivating it later beside a twin
    gives two codes a chip cannot tell apart."""
    pid, csrf = project
    code = _create(client, pid, "Barriers", csrf).json()
    deactivate = client.patch(
        f"/api/projects/{pid}/codes/{code['id']}",
        json={"is_active": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert deactivate.status_code == 200, deactivate.text
    assert _create(client, pid, "Barriers", csrf).status_code == 409


def test_a_universal_codes_name_is_held_too(client, project):
    """`ensure_universal_codes` seeds by `numeric_id`, so its names are ordinary
    names as far as this check is concerned.

    ⚠️ **Seeded explicitly rather than skipped.** A bare project has no universal
    codes — they arrive with the first conversation — and the first draft of this
    test `pytest.skip`ped when it found none, i.e. reported green while asserting
    nothing (`backend/tests/the internal design notes's rule, met the day it was written).
    """
    from app.routers.conversations import ensure_universal_codes

    pid, csrf = project
    db = SessionLocal()
    try:
        ensure_universal_codes(db, pid)
    finally:
        db.close()

    universal = [
        c for c in client.get(f"/api/projects/{pid}/codes").json()["codes"]
        if c["is_universal"]
    ]
    assert universal, "the seeder produced no universal codes — fixture is vacuous"
    assert _create(client, pid, universal[0]["name"], csrf).status_code == 409


def test_the_same_name_in_ANOTHER_project_is_fine(client, project):
    """Scoped to the project — a codebook is per project."""
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    other = client.post(
        "/api/projects", json={"name": "Second study"}, headers={"X-CSRF-Token": csrf}
    ).json()["id"]
    assert _create(client, other, "Barriers", csrf).status_code == 200


def test_a_bad_category_still_wins_the_404(client, project):
    """Placement: the duplicate check runs AFTER the category lookup, so a caller
    sending both errors keeps the more specific one it always got."""
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    resp = _create(client, pid, "Barriers", csrf, category_id=999999)
    assert resp.status_code == 404


# ── the second door: renaming ────────────────────────────────────────────────

def test_renaming_ONTO_an_existing_name_is_refused(client, project):
    """The filed entry named only creation. A rename reaches the same state."""
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    other = _create(client, pid, "Facilitators", csrf).json()
    resp = client.patch(
        f"/api/projects/{pid}/codes/{other['id']}",
        json={"name": "Barriers"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 409
    assert "Barriers" in resp.json()["detail"]


def test_renaming_a_code_to_its_OWN_name_is_allowed(client, project):
    """`exclude_code_id` is what makes this work — without it, saving a form that
    did not change the name would 409."""
    pid, csrf = project
    code = _create(client, pid, "Barriers", csrf).json()
    resp = client.patch(
        f"/api/projects/{pid}/codes/{code['id']}",
        json={"name": "Barriers", "description": "now with a definition"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["description"] == "now with a definition"


def test_recasing_a_codes_OWN_name_is_allowed(client, project):
    pid, csrf = project
    code = _create(client, pid, "barriers", csrf).json()
    resp = client.patch(
        f"/api/projects/{pid}/codes/{code['id']}",
        json={"name": "Barriers"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Barriers"


def test_an_update_that_does_not_touch_the_name_is_allowed(client, project):
    """`exclude_unset` means most edits never reach the check at all; this pins
    that a colour change on a project full of codes is not an accidental 409."""
    pid, csrf = project
    _create(client, pid, "Barriers", csrf)
    other = _create(client, pid, "Facilitators", csrf).json()
    resp = client.patch(
        f"/api/projects/{pid}/codes/{other['id']}",
        json={"color": "#3b82f6"},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200, resp.text


# ── what the refusal must NOT reach ──────────────────────────────────────────

class TestTheImportPathsAreUntouched:
    """The refusal is at the router; every non-interactive creator constructs
    `Code(...)` directly and must keep doing so.

    This is the property a future "move it into a service" refactor would break,
    and the codebook exchange's own identity rule is the reason: it dedupes an
    incoming code by `(name, category_path)`, so two codes sharing a name under
    different categories are two codes to it.
    """

    def test_the_exchange_identifies_a_code_by_name_AND_category_path(self):
        import inspect
        from app.services import codebook_exchange

        src = inspect.getsource(codebook_exchange)
        assert "existing_code_paths" in src, (
            "codebook_exchange no longer keys codes by (name, category path). "
            "If its identity rule has changed, re-read routers/codes.py::"
            "_refuse_duplicate_code_name — its placement at the router rather "
            "than in a service was justified by this exact rule."
        )

    def test_the_refusal_is_not_importable_from_a_service(self):
        """A service importing it would apply it to the import paths."""
        import inspect
        from app.services import codebook_exchange, project_portability

        for module in (codebook_exchange, project_portability):
            assert "_refuse_duplicate_code_name" not in inspect.getsource(module), (
                f"{module.__name__} reaches the router's interactive-only "
                "refusal; that would refuse imports the format permits."
            )

    def test_a_direct_model_insert_of_a_twin_is_still_possible(self, client, project):
        """The database has no unique index on (project_id, name) and must not
        grow one: pre-existing projects legitimately hold duplicates created
        before this refusal, and an import may create them by design."""
        from app.models.code import Code

        pid, csrf = project
        _create(client, pid, "Barriers", csrf)

        db = SessionLocal()
        try:
            db.add(Code(project_id=pid, numeric_id=9001, name="Barriers"))
            db.commit()
            twins = db.query(Code).filter(
                Code.project_id == pid, Code.name == "Barriers"
            ).count()
            assert twins == 2
        finally:
            db.close()

    def test_an_existing_twin_does_not_block_editing_either_of_them(self, client, project):
        """A project that already holds duplicates stays workable — the refusal
        governs new names, and `exclude_code_id` keeps a no-op rename legal even
        when the collision is the code's own twin."""
        from app.models.code import Code

        pid, csrf = project
        first = _create(client, pid, "Barriers", csrf).json()

        db = SessionLocal()
        try:
            db.add(Code(project_id=pid, numeric_id=9001, name="Barriers"))
            db.commit()
        finally:
            db.close()

        # Renaming the twin APART is the remedy, and it must be available.
        resp = client.patch(
            f"/api/projects/{pid}/codes/{first['id']}",
            json={"name": "Barriers (structural)"},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text
