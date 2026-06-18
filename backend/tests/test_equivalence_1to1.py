"""Tests for the 1:1-column-per-dataset constraint on equivalence groups.

Equivalence groups express "this column in dataset A and this column in dataset
B are the same item." The design has always been 1:1 per dataset — N-way across
N datasets is valid (Board Q5 = Staff Q12 = Stakeholder Q8) but multi-column
within one dataset is not. This file locks in that constraint at three layers:

1. **Schema** — partial unique index on (equivalence_group_id, dataset_id)
   created in the baseline schema migration. Proven by `test_schema_rejects_direct_insert_violation`.
2. **Backend validators** — `_assert_columns_unique_per_dataset` wired into
   `create_group`, `bulk_create_groups`, `add_columns`, and `merge_groups`,
   raising 409 with structured detail before the DB is hit.
3. **Portability import** — `.mmproject` files with pre-existing violations
   are rejected with a ValueError before any data is written.

See #289 for the full rationale.
"""
import asyncio
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.routers.equivalence import (
    create_group,
    bulk_create_groups,
    add_columns,
    merge_groups,
)
from app.schemas.equivalence import (
    EquivalenceGroupCreate,
    EquivalenceGroupBulkCreate,
    EquivalenceGroupAddColumns,
)
from tests.conftest import mock_request


# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════


def _run(coro):
    """Invoke an async router function synchronously for tests.

    The equivalence router functions are `async def` for FastAPI convention but
    don't actually await anything — pure ORM + Python logic. asyncio.run() is
    the simplest way to call them without spinning up a TestClient.
    """
    return asyncio.run(coro)


@pytest.fixture
def two_dataset_project(db_session):
    """Project with two datasets, each with two ordinal columns.

    IDs are chosen to not collide with other test fixtures:
    - Project 700, user 1
    - Dataset 700 (Board): columns 7001 (Q1), 7002 (Q2)
    - Dataset 701 (Staff): columns 7101 (Q1), 7102 (Q2)
    """
    db = db_session
    project = Project(id=700, name="1to1 Test", user_id=1)
    db.add(project)

    board = Dataset(id=700, project_id=700, name="Board")
    staff = Dataset(id=701, project_id=700, name="Staff")
    db.add_all([board, staff])

    db.add_all([
        DatasetColumn(id=7001, dataset_id=700, column_code="Q1", column_name="Q1",
                      column_text="Leadership Vision", column_type="ordinal",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=7002, dataset_id=700, column_code="Q2", column_name="Q2",
                      column_text="Leadership Communication", column_type="ordinal",
                      sequence_order=1, display_order=1),
        DatasetColumn(id=7101, dataset_id=701, column_code="Q1", column_name="Q1",
                      column_text="Leadership Vision", column_type="ordinal",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=7102, dataset_id=701, column_code="Q2", column_name="Q2",
                      column_text="Leadership Communication", column_type="ordinal",
                      sequence_order=1, display_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


@pytest.fixture
def three_dataset_project(db_session):
    """Project with three datasets. Used for merge conflict tests."""
    db = db_session
    project = Project(id=800, name="Merge Test", user_id=1)
    db.add(project)

    for ds_id, ds_name in [(800, "Board"), (801, "Staff"), (802, "Stakeholder")]:
        db.add(Dataset(id=ds_id, project_id=800, name=ds_name))

    # Board: 8001=Q1, 8002=Q2
    # Staff: 8101=Q1, 8102=Q2
    # Stakeholder: 8201=Q1
    db.add_all([
        DatasetColumn(id=8001, dataset_id=800, column_code="Q1", column_name="Q1",
                      column_text="Leadership", column_type="ordinal",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=8002, dataset_id=800, column_code="Q2", column_name="Q2",
                      column_text="Communication", column_type="ordinal",
                      sequence_order=1, display_order=1),
        DatasetColumn(id=8101, dataset_id=801, column_code="Q1", column_name="Q1",
                      column_text="Leadership", column_type="ordinal",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=8102, dataset_id=801, column_code="Q2", column_name="Q2",
                      column_text="Communication", column_type="ordinal",
                      sequence_order=1, display_order=1),
        DatasetColumn(id=8201, dataset_id=802, column_code="Q1", column_name="Q1",
                      column_text="Leadership", column_type="ordinal",
                      sequence_order=0, display_order=0),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


def _detail_of(exc: HTTPException) -> dict:
    """Extract the dict detail from a 409 HTTPException."""
    detail = exc.detail
    assert isinstance(detail, dict), f"Expected dict detail, got {type(detail)}: {detail}"
    return detail


# ═════════════════════════════════════════════════════════════════════════════
# create_group
# ═════════════════════════════════════════════════════════════════════════════


def test_create_group_with_duplicate_dataset_rejected(two_dataset_project, db_session):
    """POST /equivalence-groups with two columns from the same dataset → 409."""
    _, user = two_dataset_project

    with pytest.raises(HTTPException) as exc_info:
        _run(create_group(
            project_id=700,
            data=EquivalenceGroupCreate(label="bad group", column_ids=[7001, 7002]),
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "duplicate_dataset"
    assert "at most one column per equivalence group" in detail["message"]
    assert len(detail["conflicts"]) == 1
    conflict = detail["conflicts"][0]
    assert conflict["dataset_id"] == 700
    assert sorted(conflict["column_ids"]) == [7001, 7002]


def test_create_group_cross_dataset_accepted(two_dataset_project, db_session):
    """Sanity check: the validator doesn't overreach. Cross-dataset groups still work."""
    _, user = two_dataset_project

    resp = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Q1 pair", column_ids=[7001, 7101]),
        user=user,
        db=db_session,
    ))
    assert resp.label == "Q1 pair"
    assert {c.id for c in resp.columns} == {7001, 7101}


# ═════════════════════════════════════════════════════════════════════════════
# add_columns
# ═════════════════════════════════════════════════════════════════════════════


def test_add_columns_rejects_duplicate_dataset(two_dataset_project, db_session):
    """Group already has Board Q1; adding Board Q2 → 409."""
    _, user = two_dataset_project

    group = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Q1", column_ids=[7001]),
        user=user,
        db=db_session,
    ))

    with pytest.raises(HTTPException) as exc_info:
        _run(add_columns(
            request=mock_request(),
            project_id=700,
            group_id=group.id,
            data=EquivalenceGroupAddColumns(column_ids=[7002]),
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "duplicate_dataset"
    # Board column 7002 conflicts with existing Board column 7001
    conflict = detail["conflicts"][0]
    assert conflict["dataset_id"] == 700
    assert set(conflict["column_ids"]) == {7001, 7002}


def test_add_columns_allows_new_dataset(two_dataset_project, db_session):
    """Sanity check: adding a column from a new dataset to an existing group works."""
    _, user = two_dataset_project

    group = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Q1", column_ids=[7001]),
        user=user,
        db=db_session,
    ))
    resp = _run(add_columns(
        request=mock_request(),
        project_id=700,
        group_id=group.id,
        data=EquivalenceGroupAddColumns(column_ids=[7101]),
        user=user,
        db=db_session,
    ))
    assert {c.id for c in resp.columns} == {7001, 7101}


# ═════════════════════════════════════════════════════════════════════════════
# merge_groups
# ═════════════════════════════════════════════════════════════════════════════


def test_merge_groups_with_duplicate_dataset_rejected(three_dataset_project, db_session):
    """Group A has Board Q1 + Staff Q1. Group B has Staff Q2 + Stakeholder Q1.
    Merge would put two Staff columns in one group → 409, both groups untouched."""
    _, user = three_dataset_project

    group_a = _run(create_group(
        project_id=800,
        data=EquivalenceGroupCreate(label="A", column_ids=[8001, 8101]),
        user=user,
        db=db_session,
    ))
    group_b = _run(create_group(
        project_id=800,
        data=EquivalenceGroupCreate(label="B", column_ids=[8102, 8201]),
        user=user,
        db=db_session,
    ))

    with pytest.raises(HTTPException) as exc_info:
        _run(merge_groups(
            project_id=800,
            group_id=group_a.id,
            other_group_id=group_b.id,
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "duplicate_dataset"
    conflict_dataset_ids = {c["dataset_id"] for c in detail["conflicts"]}
    assert 801 in conflict_dataset_ids  # Staff

    # Both groups still exist and unchanged
    a_cols = {c.id for c in db_session.query(DatasetColumn).filter(
        DatasetColumn.equivalence_group_id == group_a.id).all()}
    b_cols = {c.id for c in db_session.query(DatasetColumn).filter(
        DatasetColumn.equivalence_group_id == group_b.id).all()}
    assert a_cols == {8001, 8101}
    assert b_cols == {8102, 8201}


def test_merge_groups_compatible_succeeds(three_dataset_project, db_session):
    """Group A has Board Q1. Group B has Staff Q1. Merge → group A has both."""
    _, user = three_dataset_project

    group_a = _run(create_group(
        project_id=800,
        data=EquivalenceGroupCreate(label="A", column_ids=[8001]),
        user=user,
        db=db_session,
    ))
    group_b = _run(create_group(
        project_id=800,
        data=EquivalenceGroupCreate(label="B", column_ids=[8101]),
        user=user,
        db=db_session,
    ))
    resp = _run(merge_groups(
        project_id=800,
        group_id=group_a.id,
        other_group_id=group_b.id,
        user=user,
        db=db_session,
    ))
    assert {c.id for c in resp.columns} == {8001, 8101}
    # Source group deleted
    assert db_session.query(EquivalenceGroup).filter(
        EquivalenceGroup.id == group_b.id).first() is None


# ═════════════════════════════════════════════════════════════════════════════
# bulk_create_groups
# ═════════════════════════════════════════════════════════════════════════════


def test_bulk_create_groups_rejects_on_any_violation(two_dataset_project, db_session):
    """POST /bulk with two groups, second has a duplicate dataset → 409 before
    any group is created (all-or-nothing semantics)."""
    _, user = two_dataset_project

    batch = EquivalenceGroupBulkCreate(groups=[
        EquivalenceGroupCreate(label="good", column_ids=[7001, 7101]),
        EquivalenceGroupCreate(label="bad", column_ids=[7002, 7102, 7001]),  # 7001 + 7002 = same dataset
    ])

    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_groups(
            request=mock_request(),
            project_id=700,
            data=batch,
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    # Neither group should have been committed — because the validation runs
    # before any db.add() calls, no partial state.
    assert db_session.query(EquivalenceGroup).filter(
        EquivalenceGroup.project_id == 700).count() == 0


def test_bulk_create_groups_all_valid_succeeds(two_dataset_project, db_session):
    """Sanity check: valid bulk create still works."""
    _, user = two_dataset_project

    batch = EquivalenceGroupBulkCreate(groups=[
        EquivalenceGroupCreate(label="Q1", column_ids=[7001, 7101]),
        EquivalenceGroupCreate(label="Q2", column_ids=[7002, 7102]),
    ])
    resp = _run(bulk_create_groups(
        request=mock_request(),
        project_id=700,
        data=batch,
        user=user,
        db=db_session,
    ))
    assert resp.created == 2
    assert {g.label for g in resp.groups} == {"Q1", "Q2"}


# ═════════════════════════════════════════════════════════════════════════════
# Schema-level enforcement (partial unique index)
# ═════════════════════════════════════════════════════════════════════════════


def test_schema_rejects_direct_insert_violation(two_dataset_project, db_session):
    """Prove the schema constraint is load-bearing, not just the validators.
    A direct ORM insert that bypasses the router validators must still fail."""
    _, user = two_dataset_project

    # Create the group via the router (valid, 1:1)
    group = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Q1", column_ids=[7001]),
        user=user,
        db=db_session,
    ))

    # Now bypass the router and assign Board Q2 directly. The partial unique
    # index should reject this on flush.
    col = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7002).one()
    col.equivalence_group_id = group.id
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


# ═════════════════════════════════════════════════════════════════════════════
# .mmproject import validation
# ═════════════════════════════════════════════════════════════════════════════


def _build_mmproject_zip_bytes(project_data: dict) -> bytes:
    """Build a minimal .mmproject zip in memory for testing import validation."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(
            {"format_type": "mmproject", "format_version": 1, "app_version": "1.0.0"}
        ))
        zf.writestr("project.json", json.dumps(project_data))
    return buf.getvalue()


def test_mmproject_import_rejects_duplicate_dataset(tmp_path, db_session):
    """Import a .mmproject whose equivalence group contains two columns from
    the same dataset → ValueError with a clear message. No partial import."""
    from app.services.project_portability import import_project

    # Minimal payload shaped like a real export. Only the fields the importer
    # actually reads for equivalence-group + column processing.
    payload = {
        "format_version": 1,
        "app_version": "1.0.0",
        "project": {
            "_original_id": 9001,
            "name": "Import Violation Test",
            "description": None,
        },
        "participants": [],
        "speakers": [],
        "conversations": [],
        "documents": [],
        "segment_groups": [],
        "segments": [],
        "code_categories": [],
        "codes": [],
        "code_applications": [],
        "datasets": [{
            "_original_id": 9100,
            "name": "Board",
            "source": None,
            "project_id": 9001,
        }],
        "equivalence_groups": [{
            "_original_id": 9200,
            "label": "bad group",
            "description": None,
            "sequence_order": 0,
            "origin": "manual",
        }],
        "dataset_columns": [
            {
                "_original_id": 9300,
                "dataset_id": 9100,
                "equivalence_group_id": 9200,
                "column_code": "Q1",
                "column_name": "Q1",
                "column_text": "Leadership Vision",
                "column_type": "ordinal",
                "sequence_order": 0,
                "display_order": 0,
            },
            {
                "_original_id": 9301,
                "dataset_id": 9100,  # Same dataset!
                "equivalence_group_id": 9200,  # Same group!
                "column_code": "Q2",
                "column_name": "Q2",
                "column_text": "Leadership Communication",
                "column_type": "ordinal",
                "sequence_order": 1,
                "display_order": 1,
            },
        ],
        "dataset_rows": [],
        "dataset_values": [],
        "recode_definitions": [],
        "excerpts": [],
        "notes": [],
        "memos": [],
        "analysis_domains": [],
        "analysis_domain_members": [],
        "metric_definitions": [],
        "computed_results": [],
        "row_scores": [],
        "statistical_tests": [],
        "material_collections": [],
        "materials": [],
        "scratchpad_entries": [],
        "canvases": [],
        "canvas_themes": [],
        "canvas_theme_relationships": [],
        "canvas_pending_items": [],
    }

    zip_bytes = _build_mmproject_zip_bytes(payload)
    project_path = tmp_path / "violation.mmproject"
    project_path.write_bytes(zip_bytes)

    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()

    with pytest.raises(ValueError) as exc_info:
        import_project(db_session, project_path, docs_dir, user_id=1)

    msg = str(exc_info.value)
    assert "at most one column per dataset" in msg
    assert "9200" in msg or "dataset_id" in msg  # violation detail present

    # No project should have been committed
    db_session.rollback()
    assert db_session.query(Project).filter(Project.name == "Import Violation Test").count() == 0


# ═════════════════════════════════════════════════════════════════════════════
# #301 — strict hijack guard: reject silent column reassignment between EGs
# ═════════════════════════════════════════════════════════════════════════════


def test_create_group_rejects_already_linked_column(two_dataset_project, db_session):
    """create_group with a column already linked to another EG → 409 column_already_linked."""
    _, user = two_dataset_project

    # Pre-link Board Q1 (id=7001) to a "Vision" group
    existing = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Vision", column_ids=[7001]),
        user=user,
        db=db_session,
    ))

    # Attempt to create a NEW group containing the already-linked column
    with pytest.raises(HTTPException) as exc_info:
        _run(create_group(
            project_id=700,
            data=EquivalenceGroupCreate(label="Hijack attempt", column_ids=[7001, 7101]),
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "column_already_linked"
    assert len(detail["conflicts"]) == 1
    conflict = detail["conflicts"][0]
    assert conflict["column_id"] == 7001
    assert conflict["column_code"] == "Q1"
    assert conflict["current_group_id"] == existing.id
    assert conflict["current_group_label"] == "Vision"


def test_add_columns_rejects_already_linked_column(two_dataset_project, db_session):
    """add_columns with a column already in EG-A targeting EG-B → 409."""
    _, user = two_dataset_project

    # EG-A holds Board Q1
    eg_a = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Group A", column_ids=[7001]),
        user=user,
        db=db_session,
    ))
    # EG-B holds Staff Q1
    eg_b = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Group B", column_ids=[7101]),
        user=user,
        db=db_session,
    ))

    # Attempt to add Board Q1 (already in EG-A) to EG-B
    with pytest.raises(HTTPException) as exc_info:
        _run(add_columns(
            request=mock_request(),
            project_id=700,
            group_id=eg_b.id,
            data=EquivalenceGroupAddColumns(column_ids=[7001]),
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "column_already_linked"
    assert detail["conflicts"][0]["current_group_id"] == eg_a.id
    assert detail["conflicts"][0]["current_group_label"] == "Group A"


def test_add_columns_idempotent_to_same_group(two_dataset_project, db_session):
    """add_columns with a column already in the target EG → no 409 (idempotent)."""
    _, user = two_dataset_project

    eg = _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Group", column_ids=[7001]),
        user=user,
        db=db_session,
    ))

    # Add Q1 again (already in this group) → should not 409 on the hijack guard
    # (it may still 409 on the 1:1 dataset check if the same column is re-added,
    # but that's a different error class — verify the hijack guard doesn't fire).
    resp = _run(add_columns(
        request=mock_request(),
        project_id=700,
        group_id=eg.id,
        data=EquivalenceGroupAddColumns(column_ids=[7001]),
        user=user,
        db=db_session,
    ))
    # State unchanged: still has just Q1
    assert {c.id for c in resp.columns} == {7001}


def test_bulk_create_rejects_already_linked_column(two_dataset_project, db_session):
    """bulk_create_groups with one group containing an already-linked column → entire batch fails."""
    _, user = two_dataset_project

    # Pre-link Board Q1
    _run(create_group(
        project_id=700,
        data=EquivalenceGroupCreate(label="Existing", column_ids=[7001]),
        user=user,
        db=db_session,
    ))

    # Attempt bulk: first group is fine, second group hijacks Board Q1
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_groups(
            request=mock_request(),
            project_id=700,
            data=EquivalenceGroupBulkCreate(groups=[
                EquivalenceGroupCreate(label="Fine", column_ids=[7002, 7102]),
                EquivalenceGroupCreate(label="Hijack", column_ids=[7001]),
            ]),
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "column_already_linked"
    # Entire batch failed: only the pre-existing "Existing" group remains
    db_session.rollback()
    remaining = db_session.query(EquivalenceGroup).filter(
        EquivalenceGroup.project_id == 700
    ).all()
    assert len(remaining) == 1
    assert remaining[0].label == "Existing"


def test_merge_groups_does_not_hit_hijack_guard(three_dataset_project, db_session):
    """merge_groups intentionally bypasses the #301 hijack guard — source columns
    are by definition linked to source_group_id, but consolidation IS the operation's
    purpose. Sanity check that a clean cross-dataset merge still succeeds.
    """
    _, user = three_dataset_project

    eg_a = _run(create_group(
        project_id=800,
        data=EquivalenceGroupCreate(label="A", column_ids=[8001]),
        user=user,
        db=db_session,
    ))
    eg_b = _run(create_group(
        project_id=800,
        data=EquivalenceGroupCreate(label="B", column_ids=[8101]),
        user=user,
        db=db_session,
    ))

    # Both columns are linked to their respective EGs. Merge should NOT 409 on
    # the hijack guard — it's the merge's job to reassign.
    resp = _run(merge_groups(
        project_id=800,
        group_id=eg_a.id,
        other_group_id=eg_b.id,
        user=user,
        db=db_session,
    ))
    assert {c.id for c in resp.columns} == {8001, 8101}
