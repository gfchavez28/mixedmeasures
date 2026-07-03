"""Track J · J2-3 consensus engine tests.

Slab 3 covers `get_or_create_consensus_user` — the global system coder that owns
the derived consensus layer. Later slabs (materializer, staleness, layer scope)
extend this file.
"""
import asyncio
import json

import pytest

from app.auth import (
    CONSENSUS_CODER_NAME,
    SYSTEM_CODER_TYPES,
    ensure_default_user,
    get_or_create_consensus_user,
)
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.consensus import (
    _decide_consensus,
    materialize_consensus_for_project,
    recompute_consensus_for_target,
)
from app.services.consensus_staleness import mark_consensus_stale, sweep_stale_consensus
from app.routers.coding import apply_code as conv_apply_code
from app.routers.codes import merge_codes
from app.routers.text_coding import apply_code as text_apply_code
from app.services.segment_operations import merge_segments
from app.schemas.coding import ApplyCodeRequest
from app.schemas.text_coding import TextCodeRequest


def _run(coro):
    return asyncio.run(coro)


# ── Slab 3 · get_or_create_consensus_user ────────────────────────────────────


def test_creates_global_consensus_coder_with_system_attrs(db_session):
    consensus = get_or_create_consensus_user(db_session)
    assert consensus.id is not None
    assert consensus.username == CONSENSUS_CODER_NAME
    assert consensus.coder_type == "consensus"
    assert "consensus" in SYSTEM_CODER_TYPES
    assert consensus.password_hash is None  # never selectable / no login
    assert consensus.archived is False
    assert consensus.is_admin is False


def test_get_or_create_consensus_user_is_idempotent(db_session):
    first = get_or_create_consensus_user(db_session)
    second = get_or_create_consensus_user(db_session)
    assert first.id == second.id
    assert db_session.query(User).filter(User.coder_type == "consensus").count() == 1


def test_consensus_username_suffixes_on_collision(db_session):
    """A human coder literally named "Consensus" must not block creation — the
    system coder gets a suffixed username but still owns coder_type='consensus'."""
    db_session.add(User(username=CONSENSUS_CODER_NAME, password_hash=None))
    db_session.flush()

    consensus = get_or_create_consensus_user(db_session)
    assert consensus.username == f"{CONSENSUS_CODER_NAME} (2)"
    assert consensus.coder_type == "consensus"


def test_consensus_coder_excluded_from_roster_and_not_auto_selected(db_session):
    """The consensus coder owns data but is a SYSTEM identity: it stays out of the
    roster query and is never resolved as the active coder by ensure_default_user
    (id=1 'testuser' is the lone human)."""
    consensus = get_or_create_consensus_user(db_session)

    roster = (
        db_session.query(User)
        .filter(User.archived == False, User.coder_type.notin_(SYSTEM_CODER_TYPES))  # noqa: E712
        .all()
    )
    roster_ids = {u.id for u in roster}
    assert consensus.id not in roster_ids
    assert roster_ids == {1}

    assert ensure_default_user(db_session).id == 1


# ── Slab 4 · consensus materializer ───────────────────────────────────────────


def _coder(db, uid, name, coder_type="human"):
    u = User(id=uid, username=name, password_hash=None, coder_type=coder_type)
    db.add(u)
    db.flush()
    return u


def _conv_project(db, pid=900, sid=9000):
    """Project + conversation + one segment. id=1 'testuser' is human coder A."""
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Conversation(id=pid, project_id=pid, name="C"),
        Segment(id=sid, conversation_id=pid, sequence_order=0, text="hi"),
    ])
    db.flush()
    return pid, sid


def _code(db, cid, pid, numeric_id, name="Theme", universal=False, group_id=None):
    db.add(Code(id=cid, project_id=pid, name=name, numeric_id=numeric_id,
                is_active=True, is_universal=universal, code_equivalence_group_id=group_id))
    db.flush()


def _apply(db, code_id, user_id, *, segment_id=None, value_id=None):
    db.add(CodeApplication(code_id=code_id, user_id=user_id,
                           segment_id=segment_id, dataset_value_id=value_id))
    db.flush()


def _consensus_rows(db, *, segment_id=None, value_id=None):
    q = db.query(CodeApplication).filter(CodeApplication.origin == "consensus")
    if segment_id is not None:
        q = q.filter(CodeApplication.segment_id == segment_id)
    if value_id is not None:
        q = q.filter(CodeApplication.dataset_value_id == value_id)
    return q.all()


def test_decide_consensus_pure():
    # solo voter → nothing to reconcile
    assert _decide_consensus({1: {10}}) == []
    # two agree → unanimous, no flag
    assert _decide_consensus({1: {10}, 2: {10}}) == [(10, "unanimous", 2, 2)]
    # 2 of 3 → strict majority + flag; the 1-of-3 code is dropped
    assert _decide_consensus({1: {10}, 2: {10}, 3: {20}}) == [(10, "majority", 2, 3)]
    # even split 2/4 is NOT a majority → dropped
    assert _decide_consensus({1: {10}, 2: {10}, 3: {20}, 4: {20}}) == []


def test_unanimous_two_coders_creates_one_consensus_row(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)

    summary = materialize_consensus_for_project(db, pid)

    rows = _consensus_rows(db, segment_id=sid)
    assert len(rows) == 1
    row = rows[0]
    assert row.code_id == 901
    assert row.user_id == summary["consensus_user_id"]
    assert row.origin == "consensus"
    assert json.loads(row.origin_context) == {"rule": "unanimous", "agree": 2, "voters": 2}
    assert summary["created"] == 1 and summary["unanimous"] == 1 and summary["majority"] == 0


def test_majority_flag_and_sub_majority_dropped(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _coder(db, 3, "C")
    _code(db, 901, pid, 1, name="Positive")
    _code(db, 902, pid, 2, name="Negative")
    _apply(db, 901, 1, segment_id=sid)  # A: Positive
    _apply(db, 901, 2, segment_id=sid)  # B: Positive
    _apply(db, 902, 3, segment_id=sid)  # C: Negative

    materialize_consensus_for_project(db, pid)

    rows = _consensus_rows(db, segment_id=sid)
    assert {r.code_id for r in rows} == {901}, "majority code only; sub-majority dropped"
    assert json.loads(rows[0].origin_context) == {"rule": "majority", "agree": 2, "voters": 3}


def test_solo_coder_no_consensus(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)  # only coder A

    summary = materialize_consensus_for_project(db, pid)
    assert _consensus_rows(db, segment_id=sid) == []
    assert summary["created"] == 0


def test_equivalence_group_codes_count_as_agreement(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    db.add(CodeEquivalenceGroup(id=50, project_id=pid, label="positive-ish", canonical_code_id=901))
    db.flush()
    _code(db, 901, pid, 1, name="Positive", group_id=50)
    _code(db, 902, pid, 2, name="POSITIVE", group_id=50)
    _apply(db, 901, 1, segment_id=sid)  # A: Positive
    _apply(db, 902, 2, segment_id=sid)  # B: POSITIVE (≡ via group)

    materialize_consensus_for_project(db, pid)

    rows = _consensus_rows(db, segment_id=sid)
    assert len(rows) == 1 and rows[0].code_id == 901, "agreement on the canonical effective code"


def test_universal_codes_excluded_from_consensus(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1, name="Unclear", universal=True)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)

    materialize_consensus_for_project(db, pid)
    assert _consensus_rows(db, segment_id=sid) == []


def test_unattributed_coder_does_not_vote(db_session):
    """ADJ-2: the merged-legacy 'Unattributed' bucket is one row for many people —
    it never counts as a voter, so its codes neither create voters nor consensus."""
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _coder(db, 9, "Unattributed", coder_type="unattributed")
    _code(db, 901, pid, 1, name="X")
    _code(db, 902, pid, 2, name="Y")
    _apply(db, 901, 1, segment_id=sid)  # human A
    _apply(db, 901, 2, segment_id=sid)  # human B
    _apply(db, 902, 9, segment_id=sid)  # Unattributed → must not vote

    materialize_consensus_for_project(db, pid)

    rows = _consensus_rows(db, segment_id=sid)
    assert {r.code_id for r in rows} == {901}
    # voters = 2 (the two humans), NOT 3 — Unattributed didn't inflate the count
    assert json.loads(rows[0].origin_context)["voters"] == 2


def test_archived_coder_does_not_vote_DECF(db_session):
    """DEC-F: an archived coder is dropped from the consensus voter roster, so the
    stored layer matches consensus_enabled + the IRR gather. Archiving a coder
    recomputes consensus as if they had never coded — both the project materializer
    and the per-target recompute (sweep) path honor it."""
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    c = _coder(db, 3, "C")
    _code(db, 901, pid, 1, name="X")
    _code(db, 902, pid, 2, name="Y")
    _apply(db, 901, 1, segment_id=sid)  # A: X
    _apply(db, 901, 2, segment_id=sid)  # B: X
    _apply(db, 902, 3, segment_id=sid)  # C: Y

    # All three active → X is a 2-of-3 strict majority (flagged), Y dropped.
    materialize_consensus_for_project(db, pid)
    rows = _consensus_rows(db, segment_id=sid)
    assert {r.code_id for r in rows} == {901}
    assert json.loads(rows[0].origin_context) == {"rule": "majority", "agree": 2, "voters": 3}

    # Archive C → it drops out of the voter roster. X is now unanimous (2 voters).
    c.archived = True
    db.flush()
    materialize_consensus_for_project(db, pid)
    rows = _consensus_rows(db, segment_id=sid)
    assert {r.code_id for r in rows} == {901}
    assert json.loads(rows[0].origin_context) == {"rule": "unanimous", "agree": 2, "voters": 2}, \
        "archived coder C no longer votes (DEC-F)"

    # The per-target recompute path (what the staleness sweep calls) honors DEC-F too.
    recompute_consensus_for_target(db, pid, segment_id=sid)
    rows = _consensus_rows(db, segment_id=sid)
    assert json.loads(rows[0].origin_context)["voters"] == 2


def test_dataset_value_consensus(db_session):
    db = db_session
    db.add_all([
        Project(id=903, name="P", user_id=1),
        Dataset(id=903, project_id=903, name="Survey"),
        DatasetColumn(id=9030, dataset_id=903, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9031, dataset_id=903),
    ])
    db.flush()
    db.add(DatasetValue(id=90310, row_id=9031, column_id=9030, value_text="alpha"))
    db.flush()
    _coder(db, 2, "B")
    _code(db, 901, 903, 1)
    _apply(db, 901, 1, value_id=90310)
    _apply(db, 901, 2, value_id=90310)

    materialize_consensus_for_project(db, 903)
    rows = _consensus_rows(db, value_id=90310)
    assert len(rows) == 1 and rows[0].code_id == 901


def test_recompute_is_idempotent(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)

    first = materialize_consensus_for_project(db, pid)
    second = materialize_consensus_for_project(db, pid)
    assert first["created"] == second["created"] == 1
    assert len(_consensus_rows(db, segment_id=sid)) == 1, "rebuild replaces, never accumulates"


def _human_snapshot(db):
    rows = (
        db.query(CodeApplication)
        .filter(CodeApplication.origin != "consensus")
        .order_by(CodeApplication.id)
        .all()
    )
    return [(r.id, r.segment_id, r.dataset_value_id, r.code_id, r.user_id, r.origin,
             r.origin_context, r.attribution) for r in rows]


def test_reconciliation_is_additive_human_rows_untouched_J2E(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)

    before = _human_snapshot(db)
    materialize_consensus_for_project(db, pid)
    materialize_consensus_for_project(db, pid)  # recompute too
    after = _human_snapshot(db)
    assert before == after, "consensus build/recompute must never mutate human rows"


def test_cross_project_consensus_isolation_ADJ1(db_session):
    """A rebuild for project A must not delete project B's consensus rows — the
    consensus coder is global, so the DELETE is scoped by project target set."""
    db = db_session
    # Project A
    pa, sa = _conv_project(db, pid=910, sid=9100)
    _coder(db, 2, "B")
    _code(db, 9101, pa, 1)
    _apply(db, 9101, 1, segment_id=sa)
    _apply(db, 9101, 2, segment_id=sa)
    # Project B
    db.add_all([
        Project(id=920, name="PB", user_id=1),
        Conversation(id=920, project_id=920, name="CB"),
        Segment(id=9200, conversation_id=920, sequence_order=0, text="hi"),
    ])
    db.flush()
    _code(db, 9201, 920, 1)
    _apply(db, 9201, 1, segment_id=9200)
    _apply(db, 9201, 2, segment_id=9200)

    materialize_consensus_for_project(db, pa)
    materialize_consensus_for_project(db, 920)
    assert len(_consensus_rows(db, segment_id=9200)) == 1

    # rebuilding A again must leave B's consensus intact
    materialize_consensus_for_project(db, pa)
    assert len(_consensus_rows(db, segment_id=9200)) == 1, "project B consensus survived A's rebuild"
    assert len(_consensus_rows(db, segment_id=sa)) == 1


# ── Slab 5 · per-target recompute + staleness markers + sweep ─────────────────


def test_recompute_for_target_creates_then_clears(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)

    assert recompute_consensus_for_target(db, pid, segment_id=sid) == 1
    assert len(_consensus_rows(db, segment_id=sid)) == 1

    # remove coder B's human application → solo → recompute clears the consensus
    db.query(CodeApplication).filter(
        CodeApplication.segment_id == sid,
        CodeApplication.user_id == 2,
        CodeApplication.origin != "consensus",
    ).delete(synchronize_session="fetch")
    db.flush()
    assert recompute_consensus_for_target(db, pid, segment_id=sid) == 0
    assert _consensus_rows(db, segment_id=sid) == []


def test_recompute_for_target_requires_exactly_one_target(db_session):
    with pytest.raises(ValueError):
        recompute_consensus_for_target(db_session, 1)
    with pytest.raises(ValueError):
        recompute_consensus_for_target(db_session, 1, segment_id=1, dataset_value_id=2)


def test_mark_consensus_stale_is_idempotent(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    assert mark_consensus_stale(db, pid, segment_ids=[sid]) == 1
    assert mark_consensus_stale(db, pid, segment_ids=[sid]) == 0
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.segment_id == sid).count() == 1


def test_mark_consensus_stale_by_code_ids(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)

    assert mark_consensus_stale(db, pid, code_ids=[901]) == 1
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.segment_id == sid).count() == 1


def test_sweep_recomputes_and_drains_markers(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)
    mark_consensus_stale(db, pid, segment_ids=[sid])

    assert sweep_stale_consensus(db) == 1
    assert len(_consensus_rows(db, segment_id=sid)) == 1
    assert db.query(ConsensusStaleTarget).count() == 0, "markers drained after sweep"


def test_sweep_scoped_to_project(db_session):
    db = db_session
    pa, sa = _conv_project(db, pid=910, sid=9100)
    _coder(db, 2, "B")
    _code(db, 9101, pa, 1)
    _apply(db, 9101, 1, segment_id=sa)
    _apply(db, 9101, 2, segment_id=sa)
    db.add_all([
        Project(id=920, name="PB", user_id=1),
        Conversation(id=920, project_id=920, name="CB"),
        Segment(id=9200, conversation_id=920, sequence_order=0, text="hi"),
    ])
    db.flush()
    _code(db, 9201, 920, 1)
    _apply(db, 9201, 1, segment_id=9200)
    _apply(db, 9201, 2, segment_id=9200)
    mark_consensus_stale(db, pa, segment_ids=[sa])
    mark_consensus_stale(db, 920, segment_ids=[9200])

    assert sweep_stale_consensus(db, project_id=pa) == 1
    assert len(_consensus_rows(db, segment_id=sa)) == 1
    assert _consensus_rows(db, segment_id=9200) == [], "project B not swept"
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.project_id == 920).count() == 1


def test_recompute_consensus_endpoint_drains_markers(db_session):
    """M-3: the on-demand endpoint drains THIS project's staleness markers via a
    bounded sweep, forms consensus, and reports the counts."""
    from app.routers.code_analysis import recompute_consensus
    from tests.conftest import mock_request

    db = db_session
    pid, sid = _conv_project(db)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 901, 2, segment_id=sid)
    mark_consensus_stale(db, pid, segment_ids=[sid])
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.project_id == pid).count() == 1

    resp = _run(recompute_consensus(mock_request(), pid, user=db.get(User, 1), db=db))
    assert resp.recomputed == 1 and resp.remaining == 0
    assert {r.code_id for r in _consensus_rows(db, segment_id=sid)} == {901}


# ── Slab 5b · mutation-site wiring (mark-stale + sweep) ───────────────────────


def test_conversation_apply_marks_stale_then_sweep_forms_consensus(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    user_a = db.get(User, 1)
    user_b = _coder(db, 2, "B")
    _code(db, 901, pid, 1)

    _run(conv_apply_code(sid, 901, ApplyCodeRequest(), user=user_a, db=db))
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.segment_id == sid).count() == 1
    _run(conv_apply_code(sid, 901, ApplyCodeRequest(), user=user_b, db=db))
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.segment_id == sid).count() == 1, "idempotent"

    sweep_stale_consensus(db)
    rows = _consensus_rows(db, segment_id=sid)
    assert len(rows) == 1 and rows[0].code_id == 901
    assert db.query(ConsensusStaleTarget).count() == 0


def test_single_coder_apply_does_not_mark(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    user_a = db.get(User, 1)  # lone roster coder
    _code(db, 901, pid, 1)

    _run(conv_apply_code(sid, 901, ApplyCodeRequest(), user=user_a, db=db))
    assert db.query(ConsensusStaleTarget).count() == 0, "single-coder skips consensus work"


def test_text_apply_marks_stale(db_session):
    db = db_session
    db.add_all([
        Project(id=903, name="P", user_id=1),
        Dataset(id=903, project_id=903, name="S"),
        DatasetColumn(id=9030, dataset_id=903, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9031, dataset_id=903),
    ])
    db.flush()
    db.add(DatasetValue(id=90310, row_id=9031, column_id=9030, value_text="alpha"))
    db.flush()
    user_a = db.get(User, 1)
    _coder(db, 2, "B")
    _code(db, 901, 903, 1)

    _run(text_apply_code(903, TextCodeRequest(dataset_value_id=90310, code_id=901), user=user_a, db=db))
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.dataset_value_id == 90310).count() == 1


def test_merge_codes_marks_stale(db_session):
    db = db_session
    pid, sid = _conv_project(db)
    user_a = db.get(User, 1)
    _coder(db, 2, "B")
    _code(db, 901, pid, 1, name="src")
    _code(db, 902, pid, 2, name="dst")
    _apply(db, 901, 1, segment_id=sid)
    _apply(db, 902, 2, segment_id=sid)

    _run(merge_codes(pid, 901, 902, delete_source=False, user=user_a, db=db))
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.segment_id == sid).count() == 1


def test_segment_merge_marks_and_sweep_reconciles(db_session):
    db = db_session
    db.add_all([
        Project(id=905, name="P", user_id=1),
        Conversation(id=905, project_id=905, name="C"),
        Segment(id=9051, conversation_id=905, sequence_order=0, text="a"),
        Segment(id=9052, conversation_id=905, sequence_order=1, text="b"),
    ])
    db.flush()
    _coder(db, 2, "B")
    _code(db, 901, 905, 1)
    _apply(db, 901, 1, segment_id=9051)
    _apply(db, 901, 2, segment_id=9052)

    merged, _ = merge_segments(db, [9051, 9052], "conversation", 905, 905, user_id=1)
    assert db.query(ConsensusStaleTarget).count() >= 1

    sweep_stale_consensus(db)
    # the merged (visible) segment carries both coders' 901 → consensus forms
    assert len(_consensus_rows(db, segment_id=merged.id)) == 1
    # the soft-deleted originals get no consensus (visibility guard)
    assert _consensus_rows(db, segment_id=9051) == []
    assert _consensus_rows(db, segment_id=9052) == []
