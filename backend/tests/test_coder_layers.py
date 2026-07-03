"""Track J · J2-1b — per-coder code apply/remove layers.

The two `code_applications` unique indexes were widened to
`(segment_id|dataset_value_id, code_id, user_id)` so each coder holds an
INDEPENDENT layer over the same material. This file regression-locks the
matching query-scoping fix in the apply/remove/merge paths
(`routers/coding.py`, `routers/text_coding.py`, `routers/codes.py`):

  - a second coder applying the same code to the same target creates their
    OWN row instead of silently no-op'ing on the first coder's row;
  - a remove deletes only the ACTING coder's row, never another coder's;
  - the grouped-segment remove and the dataset bulk-remove no longer "nuke"
    every coder's applications across the group/selection (the data-loss
    landmines);
  - merge_codes treats a source application as a "duplicate" only when the
    SAME coder already holds the target code on that segment/value, so a
    merge never deletes a different coder's application as a phantom dup.

Local-roster mode (the default, and the test default) shares projects across
the whole coder roster — `_get_project_or_404` does not gate by user_id — so a
second User row can legitimately code the same project's material.
"""
import asyncio

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
# Imported so their tables exist for the segment_operations (J2-0) tests below,
# which log audit entries and touch notes/excerpts during merge/split.
from app.models.note import Note  # noqa: F401
from app.models.excerpt import Excerpt  # noqa: F401
from app.models.audit import AuditEntry  # noqa: F401

from app.routers.coding import apply_code, remove_code
from app.routers.text_coding import (
    apply_code as text_apply_code,
    bulk_remove_code as text_bulk_remove_code,
)
from app.routers.codes import merge_codes
from app.services.segment_operations import (
    merge_segments,
    unmerge_segment,
    split_segment,
    unsplit_segment,
)
from app.schemas.coding import ApplyCodeRequest
from app.schemas.segment import SegmentSplitRange
from app.schemas.text_coding import TextCodeRequest, BulkRemoveCodeRequest


def _run(coro):
    return asyncio.run(coro)


# Conftest pre-creates User(id=1). Track J coder B = a second roster user.
def _add_coder_b(db):
    user_b = User(id=2, username="Coder B", password_hash=None)
    db.add(user_b)
    db.flush()
    return user_b


def _apps_on_segment(db, segment_id, code_id):
    return (
        db.query(CodeApplication)
        .filter(
            CodeApplication.segment_id == segment_id,
            CodeApplication.code_id == code_id,
        )
        .all()
    )


def _apps_on_value(db, dv_id, code_id):
    return (
        db.query(CodeApplication)
        .filter(
            CodeApplication.dataset_value_id == dv_id,
            CodeApplication.code_id == code_id,
        )
        .all()
    )


# ═══════════════════════════════════════════════════════════════════════════
# 1. Two coders apply the SAME code to the SAME segment → two rows, not one.
#    (Pre-widening this silently no-op'd on the second coder.)
# ═══════════════════════════════════════════════════════════════════════════


def test_two_coders_independent_apply_conversation(db_session):
    db = db_session
    user_a = db.get(User, 1)
    user_b = _add_coder_b(db)
    db.add_all([
        Project(id=900, name="Layers Conv", user_id=1),
        Conversation(id=900, project_id=900, name="C1"),
        Segment(id=9000, conversation_id=900, sequence_order=0, text="hi"),
        Code(id=901, project_id=900, name="Theme", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()

    _run(apply_code(9000, 901, ApplyCodeRequest(attribution="A"), user=user_a, db=db))
    _run(apply_code(9000, 901, ApplyCodeRequest(attribution="B"), user=user_b, db=db))

    apps = _apps_on_segment(db, 9000, 901)
    assert len(apps) == 2, "each coder must get their own layer row"
    by_user = {a.user_id: a for a in apps}
    assert by_user[1].attribution == "A"
    assert by_user[2].attribution == "B"


# ═══════════════════════════════════════════════════════════════════════════
# 2. Per-coder remove isolation — A removes X, only A's row is gone.
# ═══════════════════════════════════════════════════════════════════════════


def test_per_coder_remove_isolation_conversation(db_session):
    db = db_session
    user_a = db.get(User, 1)
    user_b = _add_coder_b(db)
    db.add_all([
        Project(id=901, name="Remove Iso", user_id=1),
        Conversation(id=901, project_id=901, name="C1"),
        Segment(id=9010, conversation_id=901, sequence_order=0, text="hi"),
        Code(id=911, project_id=901, name="Theme", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9010, code_id=911, user_id=1),
        CodeApplication(segment_id=9010, code_id=911, user_id=2),
    ])
    db.flush()

    _run(remove_code(9010, 911, user=user_a, db=db))

    apps = _apps_on_segment(db, 9010, 911)
    assert len(apps) == 1, "only the acting coder's row should be removed"
    assert apps[0].user_id == 2, "coder B's application must survive"


# ═══════════════════════════════════════════════════════════════════════════
# 3. Group-remove no longer nukes — A removes a grouped code, B's survive.
#    (The critical landmine: pre-fix the group .delete() killed every coder.)
# ═══════════════════════════════════════════════════════════════════════════


def test_group_remove_does_not_nuke_other_coder(db_session):
    db = db_session
    user_a = db.get(User, 1)
    user_b = _add_coder_b(db)
    db.add_all([
        Project(id=902, name="Group Nuke", user_id=1),
        Conversation(id=902, project_id=902, name="C1"),
    ])
    db.flush()
    db.add(SegmentGroup(id=9020, conversation_id=902))
    db.flush()
    # Two adjacent grouped segments.
    db.add_all([
        Segment(id=9021, conversation_id=902, sequence_order=0, text="one", group_id=9020),
        Segment(id=9022, conversation_id=902, sequence_order=1, text="two", group_id=9020),
        Code(id=921, project_id=902, name="Theme", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    # Both coders apply the code across both grouped segments.
    db.add_all([
        CodeApplication(segment_id=9021, code_id=921, user_id=1),
        CodeApplication(segment_id=9022, code_id=921, user_id=1),
        CodeApplication(segment_id=9021, code_id=921, user_id=2),
        CodeApplication(segment_id=9022, code_id=921, user_id=2),
    ])
    db.flush()

    # Coder A removes the code from the group via one member segment.
    _run(remove_code(9021, 921, user=user_a, db=db))

    a_rows = (
        db.query(CodeApplication)
        .filter(CodeApplication.code_id == 921, CodeApplication.user_id == 1)
        .all()
    )
    b_rows = (
        db.query(CodeApplication)
        .filter(CodeApplication.code_id == 921, CodeApplication.user_id == 2)
        .all()
    )
    assert a_rows == [], "acting coder's grouped applications should all be gone"
    assert len(b_rows) == 2, "coder B's applications across the group must survive"
    assert {r.segment_id for r in b_rows} == {9021, 9022}


# ═══════════════════════════════════════════════════════════════════════════
# 4. Text bulk-remove isolation — analogous nuke guard for dataset values.
# ═══════════════════════════════════════════════════════════════════════════


def test_text_bulk_remove_isolation(db_session):
    db = db_session
    user_a = db.get(User, 1)
    user_b = _add_coder_b(db)
    db.add_all([
        Project(id=903, name="Text Nuke", user_id=1),
        Dataset(id=903, project_id=903, name="Survey"),
        DatasetColumn(id=9030, dataset_id=903, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9031, dataset_id=903),
        DatasetRow(id=9032, dataset_id=903),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=90310, row_id=9031, column_id=9030, value_text="alpha"),
        DatasetValue(id=90320, row_id=9032, column_id=9030, value_text="beta"),
        Code(id=931, project_id=903, name="Theme", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    # Both coders code both values.
    db.add_all([
        CodeApplication(dataset_value_id=90310, code_id=931, user_id=1),
        CodeApplication(dataset_value_id=90320, code_id=931, user_id=1),
        CodeApplication(dataset_value_id=90310, code_id=931, user_id=2),
        CodeApplication(dataset_value_id=90320, code_id=931, user_id=2),
    ])
    db.flush()

    # Coder A bulk-removes across both values.
    res = _run(text_bulk_remove_code(
        903,
        BulkRemoveCodeRequest(dataset_value_ids=[90310, 90320], code_id=931),
        user=user_a, db=db,
    ))
    assert res.deleted_count == 2, "only the acting coder's rows should be deleted"

    a_rows = (
        db.query(CodeApplication)
        .filter(CodeApplication.code_id == 931, CodeApplication.user_id == 1)
        .all()
    )
    b_rows = (
        db.query(CodeApplication)
        .filter(CodeApplication.code_id == 931, CodeApplication.user_id == 2)
        .all()
    )
    assert a_rows == [], "acting coder's applications should be gone"
    assert len(b_rows) == 2, "coder B's applications must survive the bulk-remove"
    assert {r.dataset_value_id for r in b_rows} == {90310, 90320}


def test_text_apply_independent_layer(db_session):
    """Sanity check for site #7 — second coder applying same code → own row."""
    db = db_session
    user_a = db.get(User, 1)
    user_b = _add_coder_b(db)
    db.add_all([
        Project(id=904, name="Text Apply", user_id=1),
        Dataset(id=904, project_id=904, name="Survey"),
        DatasetColumn(id=9040, dataset_id=904, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9041, dataset_id=904),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=90410, row_id=9041, column_id=9040, value_text="alpha"),
        Code(id=941, project_id=904, name="Theme", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()

    _run(text_apply_code(
        904, TextCodeRequest(dataset_value_id=90410, code_id=941, attribution="A"),
        user=user_a, db=db,
    ))
    _run(text_apply_code(
        904, TextCodeRequest(dataset_value_id=90410, code_id=941, attribution="B"),
        user=user_b, db=db,
    ))

    apps = _apps_on_value(db, 90410, 941)
    assert len(apps) == 2
    assert {a.user_id for a in apps} == {1, 2}


# ═══════════════════════════════════════════════════════════════════════════
# 5. merge_codes preserves other coders' applications.
#    A applied SOURCE code to V; B applied TARGET code to V. Merging
#    source→target must reassign A's row to target and leave B's untouched —
#    NOT collapse to one row (which the old (target)-only dedup key did).
# ═══════════════════════════════════════════════════════════════════════════


def test_merge_codes_preserves_other_coder_dataset_value(db_session):
    db = db_session
    user_admin = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=905, name="Merge Iso", user_id=1),
        Dataset(id=905, project_id=905, name="Survey"),
        DatasetColumn(id=9050, dataset_id=905, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9051, dataset_id=905),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=90510, row_id=9051, column_id=9050, value_text="alpha"),
        Code(id=9501, project_id=905, name="Source", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
        Code(id=9502, project_id=905, name="Target", color="#222222",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        # Coder A holds SOURCE on the value.
        CodeApplication(dataset_value_id=90510, code_id=9501, user_id=1),
        # Coder B holds TARGET on the SAME value.
        CodeApplication(dataset_value_id=90510, code_id=9502, user_id=2),
    ])
    db.flush()

    # delete_source=False here keeps this test focused on the dedup loop;
    # the delete_source=True data-loss regression is covered separately below
    # (test_merge_codes_delete_source_preserves_reassigned_apps).
    res = _run(merge_codes(
        905, source_code_id=9501, target_code_id=9502,
        delete_source=False, user=user_admin, db=db,
    ))

    # A's source app is reassigned to target (not deleted as a phantom dup);
    # B's pre-existing target app is untouched.
    assert res.merged == 1, "A's source application reassigns to target"
    assert res.skipped == 0, "no row is a per-coder duplicate"

    target_apps = _apps_on_value(db, 90510, 9502)
    assert len(target_apps) == 2, "both coders' target applications survive"
    assert {a.user_id for a in target_apps} == {1, 2}


def test_merge_codes_skips_real_same_coder_duplicate(db_session):
    """Same-coder dup IS still collapsed (the dedup must remain correct)."""
    db = db_session
    user_admin = db.get(User, 1)
    db.add_all([
        Project(id=906, name="Merge Dup", user_id=1),
        Dataset(id=906, project_id=906, name="Survey"),
        DatasetColumn(id=9060, dataset_id=906, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9061, dataset_id=906),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=90610, row_id=9061, column_id=9060, value_text="alpha"),
        Code(id=9601, project_id=906, name="Source", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
        Code(id=9602, project_id=906, name="Target", color="#222222",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        # SAME coder (id=1) holds both source and target on the value.
        CodeApplication(dataset_value_id=90610, code_id=9601, user_id=1),
        CodeApplication(dataset_value_id=90610, code_id=9602, user_id=1),
    ])
    db.flush()

    res = _run(merge_codes(
        906, source_code_id=9601, target_code_id=9602,
        delete_source=False, user=user_admin, db=db,
    ))

    assert res.merged == 0
    assert res.skipped == 1, "the same-coder source app is a real duplicate"
    target_apps = _apps_on_value(db, 90610, 9602)
    assert len(target_apps) == 1, "collapsed to the single existing target row"
    assert target_apps[0].user_id == 1


# ═══════════════════════════════════════════════════════════════════════════
# 6c. merge_codes with delete_source=True must NOT lose the reassigned apps.
#     Data-loss bug (fixed 2026-06-22): the source-Code delete cascaded
#     (all,delete-orphan + DB ON DELETE CASCADE) against rows whose reassigning
#     code_id=target UPDATE was still pending, sweeping them. The merge reported
#     merged=N but the applications vanished. Fix: flush before deleting source.
#     Reproduces single-coder too (orthogonal to per-coder layers).
# ═══════════════════════════════════════════════════════════════════════════


def test_merge_codes_delete_source_preserves_reassigned_apps(db_session):
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=907, name="Merge DelSrc", user_id=1),
        Dataset(id=907, project_id=907, name="Survey"),
        DatasetColumn(id=9070, dataset_id=907, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9071, dataset_id=907),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=90710, row_id=9071, column_id=9070, value_text="alpha"),
        Code(id=9701, project_id=907, name="Source", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
        Code(id=9702, project_id=907, name="Target", color="#222222",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    # Two coders each hold the SOURCE code on the value (two layers, no target yet).
    db.add_all([
        CodeApplication(dataset_value_id=90710, code_id=9701, user_id=1),
        CodeApplication(dataset_value_id=90710, code_id=9701, user_id=2),
    ])
    db.flush()

    res = _run(merge_codes(
        907, source_code_id=9701, target_code_id=9702,
        delete_source=True, user=user_a, db=db,
    ))

    assert res.merged == 2, "both coders' source applications reassign to target"
    assert res.source_action == "deleted"
    target_apps = _apps_on_value(db, 90710, 9702)
    assert len(target_apps) == 2, "reassigned applications must survive source deletion"
    assert {a.user_id for a in target_apps} == {1, 2}
    # Source code row is gone; no orphaned source applications remain.
    assert db.get(Code, 9701) is None
    assert _apps_on_value(db, 90710, 9701) == []


# ═══════════════════════════════════════════════════════════════════════════
# 7. Track J · J2-0 — attribution-preserving split/merge in segment_operations.
#    Forward path (merge/split) must CARRY each coder's (code, coder,
#    attribution, origin) layer onto the product rather than re-stamping every
#    application to the operator. Reverse path (unmerge/unsplit) must PROJECT
#    post-operation coding back onto the restored segment(s) rather than
#    hard-deleting it. All benign under one shared layer; data loss under layers.
# ═══════════════════════════════════════════════════════════════════════════


def _code(code_id, project_id, numeric_id, name):
    return Code(id=code_id, project_id=project_id, name=name, color="#111111",
                numeric_id=numeric_id, is_active=True, is_universal=False)


def _seg_apps(db, segment_id):
    """(code_id, user_id) -> application, for a segment."""
    apps = db.query(CodeApplication).filter(
        CodeApplication.segment_id == segment_id,
    ).all()
    return {(a.code_id, a.user_id): a for a in apps}


def test_merge_segments_carries_per_coder_layers(db_session):
    """Merge unions DISTINCT (code, coder) layers — not a code_id union
    re-stamped to the operator — and preserves attribution/origin."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=910, name="Merge Carry", user_id=1),
        Conversation(id=910, project_id=910, name="C1"),
        Segment(id=9101, conversation_id=910, sequence_order=0, text="one part", word_count=2),
        Segment(id=9102, conversation_id=910, sequence_order=1, text="two part", word_count=2),
        _code(9110, 910, 1, "ThemeX"),
        _code(9111, 910, 2, "ThemeY"),
    ])
    db.flush()
    db.add_all([
        # Coder A: ThemeX on seg1 (with a note). Coder B: ThemeY on seg2.
        CodeApplication(segment_id=9101, code_id=9110, user_id=1, attribution="A-note"),
        CodeApplication(segment_id=9102, code_id=9111, user_id=2, attribution="B-note"),
    ])
    db.flush()

    merged, deleted = merge_segments(
        db, segment_ids=[9101, 9102], parent_type="conversation",
        parent_id=910, project_id=910, user_id=user_a.id,
    )
    assert deleted == 2

    by = _seg_apps(db, merged.id)
    assert set(by) == {(9110, 1), (9111, 2)}, "both coders' layers carried, not collapsed"
    assert by[(9110, 1)].attribution == "A-note"
    assert by[(9111, 2)].attribution == "B-note"
    assert by[(9111, 2)].origin == "human"


def test_merge_segments_dedups_same_code_same_coder(db_session):
    """One coder applying the SAME code to both originals → ONE row on the merge
    (the widened (segment, code, user_id) index permits only one); a second
    coder's same code → a SECOND row."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=912, name="Merge Dedup", user_id=1),
        Conversation(id=912, project_id=912, name="C1"),
        Segment(id=9121, conversation_id=912, sequence_order=0, text="one part", word_count=2),
        Segment(id=9122, conversation_id=912, sequence_order=1, text="two part", word_count=2),
        _code(9120, 912, 1, "Theme"),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9121, code_id=9120, user_id=1),  # A on seg1
        CodeApplication(segment_id=9122, code_id=9120, user_id=1),  # A on seg2  (dup coder+code)
        CodeApplication(segment_id=9122, code_id=9120, user_id=2),  # B on seg2
    ])
    db.flush()

    merged, _ = merge_segments(
        db, segment_ids=[9121, 9122], parent_type="conversation",
        parent_id=912, project_id=912, user_id=user_a.id,
    )
    by = _seg_apps(db, merged.id)
    assert set(by) == {(9120, 1), (9120, 2)}, "A collapses to one row; B keeps their own"


def test_split_single_copies_each_coder_layer_to_children(db_session):
    """Splitting a segment clones every coder's application onto each child."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=913, name="Split Carry", user_id=1),
        Conversation(id=913, project_id=913, name="C1"),
        # "alpha beta gamma" → start=6,end=10 selects "beta"; before "alpha", after "gamma" (3 parts)
        Segment(id=9130, conversation_id=913, sequence_order=0, text="alpha beta gamma", word_count=3),
        _code(9131, 913, 1, "Theme"),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9130, code_id=9131, user_id=1, attribution="A"),
        CodeApplication(segment_id=9130, code_id=9131, user_id=2, attribution="B"),
    ])
    db.flush()

    r = SegmentSplitRange(segment_id=9130, start_offset=6, end_offset=10)
    new_segs, _ = split_segment(
        db, ranges=[r], parent_type="conversation",
        parent_id=913, project_id=913, user_id=user_a.id,
    )
    assert len(new_segs) == 3
    for seg in new_segs:
        by = _seg_apps(db, seg.id)
        assert set(by) == {(9131, 1), (9131, 2)}, "each child inherits BOTH coders' layers"


def test_unsplit_projects_post_split_coding_back(db_session):
    """After a split, a second coder codes one child. Unsplit must re-home that
    post-split application onto the restored original (project-back, not delete),
    while the original's own pre-split coding survives untouched."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=914, name="Unsplit Back", user_id=1),
        Conversation(id=914, project_id=914, name="C1"),
        Segment(id=9140, conversation_id=914, sequence_order=0, text="alpha beta gamma", word_count=3),
        _code(9141, 914, 1, "Pre"),   # A's pre-split code
        _code(9142, 914, 2, "Post"),  # the code B adds after the split
    ])
    db.flush()
    db.add(CodeApplication(segment_id=9140, code_id=9141, user_id=1))
    db.flush()

    r = SegmentSplitRange(segment_id=9140, start_offset=6, end_offset=10)
    new_segs, _ = split_segment(
        db, ranges=[r], parent_type="conversation",
        parent_id=914, project_id=914, user_id=user_a.id,
    )
    # Coder B codes the "selected" child post-split.
    selected = [s for s in new_segs if s.text == "beta"][0]
    db.add(CodeApplication(segment_id=selected.id, code_id=9142, user_id=2))
    db.flush()

    restored, _ = unsplit_segment(
        db, segment_id=selected.id, parent_type="conversation",
        parent_id=914, project_id=914, user_id=user_a.id,
    )
    by = _seg_apps(db, restored.id)
    assert (9141, 1) in by, "original's own pre-split coding survives"
    assert (9142, 2) in by, "coder B's post-split coding projected back, not deleted"
    # The forward-carried copies (Pre on every child, all coder A) collapse back
    # onto the single (9141, 1) already present — no duplicate row.
    assert sum(1 for k in by if k == (9141, 1)) == 1


def test_unmerge_projects_post_merge_coding_to_first_original(db_session):
    """After a merge, a second coder codes the merged whole. Unmerge must re-home
    that post-merge application onto the FIRST restored original, without
    duplicating forward-carried copies or cross-polluting sibling originals."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=915, name="Unmerge Back", user_id=1),
        Conversation(id=915, project_id=915, name="C1"),
        Segment(id=9151, conversation_id=915, sequence_order=0, text="one part", word_count=2),
        Segment(id=9152, conversation_id=915, sequence_order=1, text="two part", word_count=2),
        _code(9153, 915, 1, "OnSeg1"),  # A's code, originally only on seg1
        _code(9154, 915, 2, "OnSeg2"),  # A's code, originally only on seg2
        _code(9155, 915, 3, "PostMerge"),  # B codes the merged whole
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9151, code_id=9153, user_id=1),
        CodeApplication(segment_id=9152, code_id=9154, user_id=1),
    ])
    db.flush()

    merged, _ = merge_segments(
        db, segment_ids=[9151, 9152], parent_type="conversation",
        parent_id=915, project_id=915, user_id=user_a.id,
    )
    # Coder B codes the merged whole (post-merge).
    db.add(CodeApplication(segment_id=merged.id, code_id=9155, user_id=2))
    db.flush()

    unmerge_segment(
        db, segment_id=merged.id, parent_type="conversation",
        parent_id=915, project_id=915, user_id=user_a.id,
    )

    seg1 = _seg_apps(db, 9151)
    seg2 = _seg_apps(db, 9152)
    # Each original keeps its own pre-merge coding...
    assert (9153, 1) in seg1
    assert (9154, 1) in seg2
    # ...the post-merge addition lands on the FIRST original only...
    assert (9155, 2) in seg1
    assert (9155, 2) not in seg2
    # ...and forward-carried codes are NOT cross-polluted back onto the wrong sibling.
    assert (9154, 1) not in seg1, "seg2's code must not leak onto seg1"
    assert (9153, 1) not in seg2, "seg1's code must not leak onto seg2"
