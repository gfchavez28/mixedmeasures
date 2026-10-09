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
    _decide_magnitude,
    has_rating_disagreement,
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


# ── #35 · consensus over RATINGS (median + spread flag) ──────────────────────


def _rate(db, code_id, user_id, segment_id, magnitude):
    db.add(CodeApplication(code_id=code_id, user_id=user_id, segment_id=segment_id,
                           magnitude=magnitude))
    db.flush()


def _scaled_code(db, cid, pid, numeric_id, *, lo=-1.0, hi=1.0, step=0.5, name="Support"):
    """🔴 −1…+1 so ZERO IS INTERIOR — a median of 0 must be written, and a
    truthiness slip on the way to the row would drop it (#35 §2)."""
    db.add(Code(id=cid, project_id=pid, name=name, numeric_id=numeric_id,
                is_active=True, is_universal=False,
                magnitude_min=lo, magnitude_max=hi, magnitude_step=step))
    db.flush()


class TestDecideMagnitudePure:
    SCALE = {"min": -1.0, "max": 1.0, "step": 0.5, "anchors": []}

    def test_no_ratings_is_None_not_a_zero(self):
        assert _decide_magnitude([], self.SCALE) is None
        assert _decide_magnitude([None, None], self.SCALE) is None

    def test_the_median_and_an_unrated_voter_contributes_nothing(self):
        d = _decide_magnitude([1.0, 0.0, None, 0.5], self.SCALE)
        assert d["rule"] == "median"
        assert d["median"] == 0.5 and d["n_rated"] == 3

    def test_a_median_of_ZERO_is_a_rating(self):
        d = _decide_magnitude([0.0, 0.0], self.SCALE)
        assert d is not None and d["median"] == 0.0

    def test_the_flag_fires_only_past_ONE_step(self):
        # Exactly one step apart: neighbours, not a disagreement.
        assert _decide_magnitude([0.0, 0.5], self.SCALE)["flag"] is False
        # Two steps apart: adjudicate.
        assert _decide_magnitude([0.0, 1.0], self.SCALE)["flag"] is True
        # The spread is reported in the scale's units either way.
        assert _decide_magnitude([-1.0, 1.0], self.SCALE)["spread"] == 2.0

    def test_a_fractional_step_does_not_flag_adjacent_ticks(self):
        # 0.1 + 0.2 ≠ 0.3 in binary; the tolerance keeps neighbours unflagged.
        assert _decide_magnitude([0.1, 0.2], {"min": 0, "max": 1, "step": 0.1})["flag"] is False

    def test_an_even_count_may_land_between_steps(self):
        d = _decide_magnitude([7.0, 8.0], {"min": 0, "max": 10, "step": 1})
        assert d["median"] == 7.5

    def test_has_rating_disagreement_asks_the_same_rule_without_a_consensus(self):
        scales = {901: self.SCALE}
        assert has_rating_disagreement({1: {901: 0.0}, 2: {901: 1.0}}, scales) is True
        assert has_rating_disagreement({1: {901: 0.0}, 2: {901: 0.5}}, scales) is False
        # One rater is never a disagreement; an unscaled code never counts.
        assert has_rating_disagreement({1: {901: 0.0}}, scales) is False
        assert has_rating_disagreement({1: {902: 0.0}, 2: {902: 1.0}}, scales) is False


class TestRatingConsensusIsMaterialized:
    def test_the_consensus_row_carries_the_median_and_says_the_rule(self, db_session):
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        _coder(db, 3, "C")
        _scaled_code(db, 901, pid, 1)
        _rate(db, 901, 1, sid, 1.0)
        _rate(db, 901, 2, sid, 0.0)
        _rate(db, 901, 3, sid, 0.5)

        summary = materialize_consensus_for_project(db, pid)
        row = _consensus_rows(db, segment_id=sid)[0]
        assert row.magnitude == 0.5
        ctx = json.loads(row.origin_context)
        assert ctx["rule"] == "unanimous" and ctx["agree"] == 3
        assert ctx["magnitude"] == {
            "rule": "median", "median": 0.5, "n_rated": 3,
            "spread": 1.0, "step": 0.5, "flag": True,
        }
        assert summary["rated"] == 1

    def test_a_median_of_zero_is_WRITTEN_not_dropped(self, db_session):
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        _scaled_code(db, 901, pid, 1)
        _rate(db, 901, 1, sid, 0.0)
        _rate(db, 901, 2, sid, 0.0)
        materialize_consensus_for_project(db, pid)
        row = _consensus_rows(db, segment_id=sid)[0]
        assert row.magnitude == 0.0 and row.magnitude is not None
        assert json.loads(row.origin_context)["magnitude"]["median"] == 0.0

    def test_an_unrated_code_keeps_the_exact_old_shape(self, db_session):
        """Backward-compatible by construction: no `magnitude` key, NULL column —
        the four pre-#35 tests asserting the exact dict stay honest."""
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        _scaled_code(db, 901, pid, 1)
        _apply(db, 901, 1, segment_id=sid)   # applied, unrated
        _apply(db, 901, 2, segment_id=sid)
        materialize_consensus_for_project(db, pid)
        row = _consensus_rows(db, segment_id=sid)[0]
        assert row.magnitude is None
        assert json.loads(row.origin_context) == {"rule": "unanimous", "agree": 2, "voters": 2}

    def test_one_rater_among_two_voters_still_gives_a_median_of_one(self, db_session):
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        _scaled_code(db, 901, pid, 1)
        _rate(db, 901, 1, sid, -0.5)
        _apply(db, 901, 2, segment_id=sid)   # B applied it but skipped the rating
        materialize_consensus_for_project(db, pid)
        row = _consensus_rows(db, segment_id=sid)[0]
        ctx = json.loads(row.origin_context)["magnitude"]
        assert row.magnitude == -0.5 and ctx["n_rated"] == 1 and ctx["flag"] is False

    def test_per_target_recompute_agrees_with_the_rebuild(self, db_session):
        """Two writers, one constructor: the sweep's per-target path must produce
        the byte-identical row the project rebuild does."""
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        _scaled_code(db, 901, pid, 1)
        _rate(db, 901, 1, sid, 1.0)
        _rate(db, 901, 2, sid, -1.0)
        materialize_consensus_for_project(db, pid)
        rebuilt = _consensus_rows(db, segment_id=sid)[0]
        rebuilt_ctx, rebuilt_mag = rebuilt.origin_context, rebuilt.magnitude
        recompute_consensus_for_target(db, pid, segment_id=sid)
        again = _consensus_rows(db, segment_id=sid)[0]
        assert again.origin_context == rebuilt_ctx and again.magnitude == rebuilt_mag
        assert json.loads(again.origin_context)["magnitude"]["flag"] is True

    def test_a_cleared_scale_yields_no_rating_consensus(self, db_session):
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        _code(db, 901, pid, 1)   # no scale declared; ratings are hand-edited state
        _rate(db, 901, 1, sid, 1.0)
        _rate(db, 901, 2, sid, 1.0)
        materialize_consensus_for_project(db, pid)
        row = _consensus_rows(db, segment_id=sid)[0]
        assert row.magnitude is None
        assert "magnitude" not in json.loads(row.origin_context)

    def test_ratings_come_only_from_the_canonical_code_of_a_group(self, db_session):
        """A grouped sibling's rating was given on the SIBLING's scale, which may
        differ, so it is never pooled into the canonical code's consensus."""
        db = db_session
        pid, sid = _conv_project(db)
        _coder(db, 2, "B")
        db.add(CodeEquivalenceGroup(id=77, project_id=pid, label="Support", canonical_code_id=None))
        db.flush()
        db.add(Code(id=901, project_id=pid, name="Support", numeric_id=1, is_active=True,
                    is_universal=False, code_equivalence_group_id=77,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.add(Code(id=902, project_id=pid, name="SUPPORT", numeric_id=2, is_active=True,
                    is_universal=False, code_equivalence_group_id=77,
                    magnitude_min=0.0, magnitude_max=100.0, magnitude_step=1.0))
        db.flush()
        _rate(db, 901, 1, sid, 1.0)     # canonical (lowest id), on −1…+1
        _rate(db, 902, 2, sid, 90.0)    # sibling, on 0–100
        materialize_consensus_for_project(db, pid)
        row = _consensus_rows(db, segment_id=sid)[0]
        assert row.code_id == 901, "the group agrees categorically"
        ctx = json.loads(row.origin_context)["magnitude"]
        assert ctx["n_rated"] == 1 and row.magnitude == 1.0, "90 on a 0–100 scale is not pooled"


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


# ── #1017 — one target that raises must not block the queue ───────────────────
#
# The recompute is made to raise for ONE segment by patching the name the sweep
# calls. The failure #1017 actually shipped (a row for code id −2) is fixed at
# its root and pinned in `test_code_sets.py`; these pin the CONTAINMENT, which
# has to hold for whatever the next such failure is.


def _poisoned_queue(db, monkeypatch):
    """Two projects, each with a two-coder target and a marker; the FIRST marker
    (the lower id, so the head of every batch) belongs to a target whose
    recompute raises. Returns (bad marker id, good segment, attempts on bad)."""
    import app.services.consensus_staleness as staleness

    bad_pid, bad_sid = _conv_project(db, pid=930, sid=9300)
    good_pid, good_sid = _conv_project(db, pid=940, sid=9400)
    _coder(db, 2, "B")
    for pid, sid, cid in ((bad_pid, bad_sid, 9301), (good_pid, good_sid, 9401)):
        _code(db, cid, pid, 1)
        _apply(db, cid, 1, segment_id=sid)
        _apply(db, cid, 2, segment_id=sid)
    mark_consensus_stale(db, bad_pid, segment_ids=[bad_sid])
    mark_consensus_stale(db, good_pid, segment_ids=[good_sid])
    db.commit()
    bad_marker = db.query(ConsensusStaleTarget).filter(
        ConsensusStaleTarget.segment_id == bad_sid).one().id

    attempts = {"bad": 0}
    real = staleness.recompute_consensus_for_target

    def flaky(db_, project_id, *, segment_id=None, dataset_value_id=None):
        if segment_id == bad_sid:
            attempts["bad"] += 1
            raise RuntimeError("simulated recompute failure")
        return real(db_, project_id, segment_id=segment_id, dataset_value_id=dataset_value_id)

    monkeypatch.setattr(staleness, "recompute_consensus_for_target", flaky)
    return bad_marker, good_sid, attempts


def test_drain_isolates_a_target_that_raises(db_session, monkeypatch):
    """Before #1017's containment the batch rolled back whole, the bad marker
    stayed at its head, and the healthy project was never written — on every
    tick, for every project on the install."""
    from app.services.consensus_staleness import drain_stale_consensus

    db = db_session
    bad_marker, good_sid, _attempts = _poisoned_queue(db, monkeypatch)

    result = drain_stale_consensus(db, limit=500)

    assert result.recomputed == 1
    assert result.failed_marker_ids == (bad_marker,)
    assert {r.code_id for r in _consensus_rows(db, segment_id=good_sid)} == {9401}
    remaining = [m.id for m in db.query(ConsensusStaleTarget).all()]
    assert remaining == [bad_marker], "the failing marker stays queued; the rest drained"


def test_a_known_failure_is_left_out_of_the_batch_and_retried_alone(db_session, monkeypatch):
    """Carried forward, a known failure must not fail the NEXT batch: it is
    tried exactly once, on its own, and new work drains in the batch path."""
    import app.services.consensus_staleness as staleness
    from app.services.consensus_staleness import drain_stale_consensus

    db = db_session
    bad_marker, _good, attempts = _poisoned_queue(db, monkeypatch)
    first = drain_stale_consensus(db, limit=500)
    assert attempts["bad"] == 2, "batch attempt + one isolated retry"

    pid3, sid3 = _conv_project(db, pid=950, sid=9500)
    _code(db, 9501, pid3, 1)
    _apply(db, 9501, 1, segment_id=sid3)
    _apply(db, 9501, 2, segment_id=sid3)
    mark_consensus_stale(db, pid3, segment_ids=[sid3])
    db.commit()

    second = drain_stale_consensus(db, limit=500, known_failed=first.failed_marker_ids)
    assert attempts["bad"] == 3, "left out of the batch, retried once on its own"
    assert second.recomputed == 1 and second.failed_marker_ids == (bad_marker,)
    assert {r.code_id for r in _consensus_rows(db, segment_id=sid3)} == {9501}

    # A fix (here: the failure going away) clears it on the next retry.
    monkeypatch.setattr(staleness, "recompute_consensus_for_target", recompute_consensus_for_target)
    third = drain_stale_consensus(db, limit=500, known_failed=second.failed_marker_ids)
    assert third.recomputed == 1 and third.failed_marker_ids == ()
    assert db.query(ConsensusStaleTarget).count() == 0


def _systematic_failure(db, monkeypatch, n):
    """``n`` markers on two-coder targets whose recompute ALL raise — the shape of
    a defect that fails a whole class of targets, as #1017's did. Returns the
    marker ids in queue order and a log of which marker each call attempted."""
    import app.services.consensus_staleness as staleness

    _coder(db, 2, "B")
    sids = []
    for i in range(n):
        pid, sid = _conv_project(db, pid=960 + i, sid=9600 + i)
        _code(db, 9600 + i, pid, 1)
        _apply(db, 9600 + i, 1, segment_id=sid)
        _apply(db, 9600 + i, 2, segment_id=sid)
        mark_consensus_stale(db, pid, segment_ids=[sid])
        sids.append(sid)
    db.commit()
    marker_of = {
        m.segment_id: m.id for m in db.query(ConsensusStaleTarget).all()
    }
    attempted: list[int] = []

    def always_fails(db_, project_id, *, segment_id=None, dataset_value_id=None):
        attempted.append(marker_of[segment_id])
        raise RuntimeError("simulated systematic failure")

    monkeypatch.setattr(staleness, "recompute_consensus_for_target", always_fails)
    return [marker_of[s] for s in sids], attempted


def test_known_failures_are_retried_a_BATCH_at_a_time_in_ROTATION(db_session, monkeypatch):
    """#1039 (g): every known failure was retried on every call, so a systematic
    failure grew each tick's work by a whole batch, without bound. Now a call
    retries at most ``limit`` of them, the ones that waited longest first — so
    the work per call is bounded AND every stuck marker still gets its turn."""
    from app.services.consensus_staleness import drain_stale_consensus

    db = db_session
    limit = 3
    markers, attempted = _systematic_failure(db, monkeypatch, 7)
    m1, m2, m3, m4, m5, m6, m7 = markers

    known: tuple[int, ...] = ()
    per_call: list[list[int]] = []
    for _ in range(5):
        attempted.clear()
        result = drain_stale_consensus(db, limit=limit, known_failed=known)
        assert result.recomputed == 0
        per_call.append(list(attempted))
        known = result.failed_marker_ids
        # Bounded: one failed batch attempt, its isolation, and `limit` retries.
        assert len(attempted) <= limit + limit + limit

    # Call 3: m7 is the last new one; m4–m6 are retried and m1–m3 WAIT their turn.
    assert set(per_call[2]) == {m7, m4, m5, m6}
    # Call 4: nothing new is left, so only the three that waited longest are tried…
    assert per_call[3] == [m1, m2, m3]
    # …and call 5 takes the next three — the rotation reaches every marker.
    assert per_call[4] == [m7, m4, m5]
    assert set(known) == set(markers), "every failing marker is still queued and known"
    assert db.query(ConsensusStaleTarget).count() == 7


def test_a_retried_marker_that_now_SUCCEEDS_leaves_the_rotation(db_session, monkeypatch):
    """The rotation must still clear a fixed target — the reason retries exist."""
    import app.services.consensus_staleness as staleness
    from app.services.consensus_staleness import drain_stale_consensus

    db = db_session
    markers, _attempted = _systematic_failure(db, monkeypatch, 4)
    first = drain_stale_consensus(db, limit=500)
    assert set(first.failed_marker_ids) == set(markers)
    monkeypatch.setattr(staleness, "recompute_consensus_for_target", recompute_consensus_for_target)
    second = drain_stale_consensus(db, limit=2, known_failed=first.failed_marker_ids)
    assert second.recomputed == 2
    assert second.failed_marker_ids == tuple(first.failed_marker_ids[2:]), (
        "the two retried and fixed are gone; the two still waiting keep their place"
    )


def test_a_database_lock_is_not_isolated(db_session, monkeypatch):
    """`OperationalError` is SQLite's "database is locked" — a property of the
    moment, not of a target — so it propagates exactly as before, and a marker
    that hit it is NOT recorded as a failing target."""
    from sqlalchemy.exc import OperationalError

    import app.services.consensus_staleness as staleness
    from app.services.consensus_staleness import drain_stale_consensus

    db = db_session
    _bad, _good, _attempts = _poisoned_queue(db, monkeypatch)

    def locked(*_a, **_k):
        raise OperationalError("UPDATE …", {}, Exception("database is locked"))

    monkeypatch.setattr(staleness, "recompute_consensus_for_target", locked)
    with pytest.raises(OperationalError):
        drain_stale_consensus(db, limit=500)
    assert db.query(ConsensusStaleTarget).count() == 2, "nothing drained, nothing lost"


def test_a_lock_during_the_isolated_retry_still_propagates(db_session, monkeypatch):
    """The retry path's own lock arm: the batch fails on the bad target, and
    then the database is locked while the GOOD one is retried alone. That must
    propagate — recording the healthy target as a failure would leave it out of
    every later batch. Found by a surviving mutant: the batch-level lock test
    never reaches this arm."""
    from sqlalchemy.exc import OperationalError

    import app.services.consensus_staleness as staleness
    from app.services.consensus_staleness import drain_stale_consensus

    db = db_session
    _bad, good_sid, _attempts = _poisoned_queue(db, monkeypatch)
    flaky = staleness.recompute_consensus_for_target

    def locked_on_good(db_, project_id, *, segment_id=None, dataset_value_id=None):
        if segment_id == good_sid:
            raise OperationalError("UPDATE …", {}, Exception("database is locked"))
        return flaky(db_, project_id, segment_id=segment_id, dataset_value_id=dataset_value_id)

    monkeypatch.setattr(staleness, "recompute_consensus_for_target", locked_on_good)
    with pytest.raises(OperationalError):
        drain_stale_consensus(db, limit=500)
    assert db.query(ConsensusStaleTarget).count() == 2


def test_the_recompute_button_survives_a_target_that_raises(db_session, monkeypatch):
    """The M-3 button went through the same all-or-nothing sweep, so one bad
    target made it a 500 and left the project's other markers undrained."""
    from app.routers.code_analysis import recompute_consensus
    from tests.conftest import mock_request

    db = db_session
    bad_marker, _good, _attempts = _poisoned_queue(db, monkeypatch)
    # Give the poisoned PROJECT a second, healthy target so the button has
    # something to drain beside the failure.
    db.add(Segment(id=9301, conversation_id=930, sequence_order=1, text="more"))
    db.flush()
    _apply(db, 9301, 1, segment_id=9301)
    _apply(db, 9301, 2, segment_id=9301)
    mark_consensus_stale(db, 930, segment_ids=[9301])
    db.commit()

    resp = _run(recompute_consensus(mock_request(), 930, user=db.get(User, 1), db=db))
    assert resp.recomputed == 1 and resp.remaining == 1
    assert {r.code_id for r in _consensus_rows(db, segment_id=9301)} == {9301}


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


# ── #958 · the writer's gather skips targets that cannot decide ───────────────
#
# The rebuild asks SQL only for targets with >= MIN_CONSENSUS_VOTERS eligible
# voters and flushes its rows in batches. Measured on BES: import peak
# 1,907 -> 675 MB with a byte-identical layer. BES has no code sets, ratings or
# observations, so the equivalence is pinned HERE on a fixture that has all of
# them — and one target per way a naive "two voters" count could be wrong.


class TestTheWritersGatherSkipsTargetsThatCannotDecide:
    PID = 960

    def _world(self, db):
        from datetime import datetime

        from app.models.code_set import CodeSet
        from app.models.observation import Observation

        pid = self.PID
        db.add_all([
            Project(id=pid, name="P", user_id=1),
            Conversation(id=pid, project_id=pid, name="C"),
            Dataset(id=pid, project_id=pid, name="Survey"),
            DatasetColumn(id=9600, dataset_id=pid, column_code="Q", column_name="Q",
                          column_text="Open", column_type="open_text",
                          sequence_order=0, display_order=0),
            DatasetRow(id=9601, dataset_id=pid),
            DatasetRow(id=9602, dataset_id=pid),
            Observation(id=pid, project_id=pid, name="frozen",
                        segmentation_frozen_at=datetime(2026, 9, 23, 12, 0, 0)),
            Observation(id=pid + 1, project_id=pid, name="open"),
            CodeSet(id=pid, project_id=pid, label="Stance", exhaustive=False),
            CodeEquivalenceGroup(id=pid, project_id=pid, label="Pos", canonical_code_id=None),
        ])
        db.flush()
        for vid, rid in ((96010, 9601), (96020, 9602)):
            db.add(DatasetValue(id=vid, row_id=rid, column_id=9600, value_text="x"))
        for i in range(1, 9):
            db.add(Segment(id=9600 + i, conversation_id=pid, sequence_order=i, text="t"))
        db.add(Segment(id=9611, observation_id=pid, sequence_order=0, text="clip",
                       start_time=0.0, end_time=1.0))
        db.add(Segment(id=9612, observation_id=pid + 1, sequence_order=0, text="clip",
                       start_time=0.0, end_time=1.0))
        db.flush()
        _coder(db, 2, "B")
        _coder(db, 3, "Model", coder_type="ai")
        archived = _coder(db, 4, "Gone")
        archived.archived = True
        _code(db, 9701, pid, 1, name="A")
        _code(db, 9702, pid, 2, name="B")
        _code(db, 9703, pid, 3, name="Unclear", universal=True)
        _code(db, 9704, pid, 4, name="G1", group_id=pid)
        _code(db, 9705, pid, 5, name="G2", group_id=pid)
        _scaled_code(db, 9706, pid, 6, name="Positive")
        db.query(Code).filter(Code.id == 9706).update({"code_set_id": pid})
        _code(db, 9707, pid, 7, name="Negative")
        db.query(Code).filter(Code.id == 9707).update({"code_set_id": pid})
        db.flush()

        a, b = 9701, 9702
        _apply(db, a, 1, segment_id=9601); _apply(db, a, 2, segment_id=9601)      # decides
        _apply(db, a, 1, segment_id=9602); _apply(db, b, 1, segment_id=9602)      # 1 voter, 2 rows
        _apply(db, a, 1, segment_id=9603); _apply(db, a, 3, segment_id=9603)      # + a machine
        _apply(db, a, 1, segment_id=9604); _apply(db, a, 4, segment_id=9604)      # + archived
        _apply(db, a, 1, segment_id=9605); _apply(db, 9703, 2, segment_id=9605)   # + universal only
        _rate(db, 9706, 1, 9606, 0.5); _rate(db, 9706, 2, 9606, 0.0)             # set + ratings
        _apply(db, 9704, 1, segment_id=9607); _apply(db, 9705, 2, segment_id=9607)  # equivalents
        _apply(db, 9706, 1, segment_id=9608); _apply(db, 9707, 1, segment_id=9608)  # lone contradiction
        _apply(db, a, 1, segment_id=9611); _apply(db, a, 2, segment_id=9611)      # frozen clip
        _apply(db, a, 1, segment_id=9612); _apply(db, a, 2, segment_id=9612)      # open clip: out of scope
        _apply(db, a, 1, value_id=96010); _apply(db, a, 2, value_id=96010)        # value decides
        _apply(db, a, 1, value_id=96020)                                          # value, 1 voter

    DECIDING = {("seg", 9601), ("seg", 9606), ("seg", 9607), ("seg", 9611), ("val", 96010)}
    ONE_VOTER = {("seg", 9602), ("seg", 9603), ("seg", 9604), ("seg", 9605), ("seg", 9608),
                 ("val", 96020)}

    @staticmethod
    def _keys(votes):
        return {(b.kind, b.target_id) for b in votes.ballots()}

    def _gather(self, db, n):
        from app.services.consensus import (
            SEGMENT_SCOPE_CONSENSUS_ELIGIBLE,
            gather_target_votes,
        )
        return gather_target_votes(
            db, self.PID, segment_scope=SEGMENT_SCOPE_CONSENSUS_ELIGIBLE, min_voters=n,
        )

    def test_the_filter_keeps_exactly_the_targets_that_can_decide(self, db_session):
        """Each ONE_VOTER target is one way a naive count goes wrong — two rows
        from one coder, a machine, an archived coder, a universal-only second
        coder, a lone contradiction. Unfiltered they are all present (so the
        fixture could have caught a leak); filtered, only DECIDING remains."""
        from app.services.consensus import MIN_CONSENSUS_VOTERS

        db = db_session
        self._world(db)
        everything = self._keys(self._gather(db, 1))
        assert self.ONE_VOTER <= everything, "precondition: the fixture reaches every arm"
        assert self._keys(self._gather(db, MIN_CONSENSUS_VOTERS)) == self.DECIDING

    def test_a_skipped_target_decides_nothing_and_a_kept_one_is_unchanged(self, db_session):
        """The equivalence the filter's safety rests on, asked of `decide_target`
        directly rather than assumed from the constant."""
        from app.services.consensus import MIN_CONSENSUS_VOTERS, decide_target

        db = db_session
        self._world(db)
        full_votes = self._gather(db, 1)
        full = {(b.kind, b.target_id): b for b in full_votes.ballots()}
        kept = {(b.kind, b.target_id): b for b in self._gather(db, MIN_CONSENSUS_VOTERS).ballots()}
        for key, ballot in full.items():
            if key in kept:
                assert kept[key].per_coder == ballot.per_coder
                assert kept[key].ratings == ballot.ratings
            else:
                assert decide_target(ballot.per_coder, full_votes.set_index) == [], key

    def test_the_rebuild_equals_a_per_target_recompute_of_every_target(self, db_session):
        """An INDEPENDENT oracle: `recompute_consensus_for_target` has no
        filter, so the filtered rebuild must reproduce it target for target."""
        import json as _json

        db = db_session
        self._world(db)

        def layer():
            return sorted((
                (r.segment_id, r.dataset_value_id, r.code_id,
                 _json.dumps(_json.loads(r.origin_context), sort_keys=True), r.magnitude)
                for r in db.query(CodeApplication).filter(CodeApplication.origin == "consensus")
            ), key=repr)

        materialize_consensus_for_project(db, self.PID)
        rebuilt = layer()
        db.query(CodeApplication).filter(CodeApplication.origin == "consensus").delete()
        db.flush()
        for sid in list(range(9601, 9609)) + [9611, 9612]:
            recompute_consensus_for_target(db, self.PID, segment_id=sid)
        for vid in (96010, 96020):
            recompute_consensus_for_target(db, self.PID, dataset_value_id=vid)
        assert rebuilt == layer()
        assert len(rebuilt) == 5, "one row per DECIDING target — the oracle is not vacuous"

    def test_the_rebuild_writes_as_it_streams_in_bounded_batches(self, db_session, monkeypatch):
        """The memory half, pinned in the channel it lives in: the STATEMENTS.

        Three properties, each of which a single mutant breaks: the rows go out
        as bulk inserts of at most one batch (the ORM wrote one statement per
        row — 169,347 on BES); the first batch is written BEFORE the value arm
        is even read (a rebuild that gathered every ballot first would hold the
        whole project again); and no consensus row ever waits in the session as
        an ORM object."""
        from sqlalchemy import event

        import app.services.consensus as consensus

        db = db_session
        self._world(db)
        monkeypatch.setattr(consensus, "CONSENSUS_REBUILD_INSERT_BATCH", 2)
        log: list[tuple[str, int]] = []
        pending: list[int] = []

        def before_cursor_execute(_conn, _cursor, statement, parameters, _ctx, executemany):
            sql = " ".join(statement.split())
            if sql.startswith("INSERT INTO code_applications"):
                log.append(("insert", len(parameters) if executemany else 1))
            elif sql.startswith("SELECT code_applications.dataset_value_id AS"):
                log.append(("read the value arm", 0))

        def before_flush(session, _ctx, _instances):
            pending.append(sum(
                1 for o in session.new
                if isinstance(o, CodeApplication) and o.origin == "consensus"
            ))

        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", before_cursor_execute)
        event.listen(db, "before_flush", before_flush)
        try:
            summary = consensus.materialize_consensus_for_project(db, self.PID)
        finally:
            event.remove(engine, "before_cursor_execute", before_cursor_execute)
            event.remove(db, "before_flush", before_flush)

        assert summary["created"] == 5
        inserts = [n for kind, n in log if kind == "insert"]
        assert inserts == [2, 2, 1], log
        assert log.index(("insert", 2)) < log.index(("read the value arm", 0)), log
        assert not any(pending), pending
        # And the rebuild ASKED for the filter: its output is identical either
        # way, so `targets` (what it gathered) is the only observable trace.
        assert summary["targets"] == len(self.DECIDING)

    def test_ballots_arrive_one_per_target_in_target_order(self, db_session, monkeypatch):
        """The ORDER BY is what makes the grouping correct: with a fetch of ONE
        row at a time, every row boundary is a batch boundary, and a target
        whose rows were not contiguous would arrive as two ballots."""
        import app.services.consensus as consensus

        db = db_session
        self._world(db)
        monkeypatch.setattr(consensus, "GATHER_STREAM_BATCH", 1)
        ballots = list(self._gather(db, 1).ballots())
        keys = [(b.kind, b.target_id) for b in ballots]
        assert len(keys) == len(set(keys)), keys
        segs = [t for k, t in keys if k == "seg"]
        vals = [t for k, t in keys if k == "val"]
        assert keys == [("seg", t) for t in segs] + [("val", t) for t in vals]
        assert segs == sorted(segs) and vals == sorted(vals)
        # Non-vacuous: two voters' rows on one target were grouped into one.
        assert any(len(b.per_coder) >= 2 for b in ballots)

    def test_a_ballot_is_whole_whatever_order_the_plan_reads_in(self, db_session, monkeypatch):
        """What the ORDER BY is FOR, which the gather's own queries cannot show:
        SQLite's plans for them read each target's rows together (driven from
        the targets), so a mutant REMOVING the ORDER BY survived every other
        test. A bare scan of the table reads in INSERTION order, where a late
        row splits its target — and the stream must still give it ONE ballot.
        The ORDER BY is kept for the plan that does this to the real query:
        SQLite promises no order without one."""
        import app.services.consensus as consensus

        db = db_session
        self._world(db)
        _apply(db, 9702, 2, segment_id=9601)  # a LATE second code on the first target
        monkeypatch.setattr(consensus, "GATHER_STREAM_BATCH", 1)
        bare = db.query(
            CodeApplication.segment_id, CodeApplication.user_id,
            CodeApplication.code_id, CodeApplication.magnitude,
        ).filter(CodeApplication.id > 0)  # a rowid range: insertion order
        # Precondition — the bare read really does split 9601, or this proves nothing.
        order = [row[0] for row in bare]
        first, last = order.index(9601), len(order) - 1 - order[::-1].index(9601)
        assert any(sid != 9601 for sid in order[first:last]), order

        ballots = [b for b in consensus._stream_ballots(bare, CodeApplication.segment_id, "seg", {})
                   if b.target_id == 9601]
        assert len(ballots) == 1, ballots
        assert ballots[0].per_coder == {1: {9701}, 2: {9701, 9702}}

    def test_min_voters_has_no_default_and_refuses_nonsense(self, db_session):
        import inspect

        from app.services.consensus import gather_target_votes

        param = inspect.signature(gather_target_votes).parameters["min_voters"]
        assert param.default is inspect.Parameter.empty
        assert param.kind is inspect.Parameter.KEYWORD_ONLY
        for bad in (0, -1, True, 1.5):
            with pytest.raises(ValueError, match="min_voters"):
                gather_target_votes(db_session, 1, segment_scope="project", min_voters=bad)


# ── #958 · the shared gather STREAMS ─────────────────────────────────────────
#
# The gather used to read every vote of a project into nested dicts — 1,267 MB
# on BES unfiltered. It now yields one ballot per target from an ordered,
# batched read. The property lives in MEMORY, so it is asserted there:
# `tracemalloc` over a corpus at two sizes ten times apart.


class TestTheGatherStreams:
    SMALL, LARGE = 400, 4000

    @staticmethod
    def _corpus(db, pid, n_targets):
        """One open-text column, `n_targets` cells, two coders on every cell —
        so every cell is a two-voter target. Core inserts: the corpus is the
        fixture, not the subject."""
        from sqlalchemy import insert

        db.add_all([Project(id=pid, name=f"P{pid}", user_id=1),
                    Dataset(id=pid, project_id=pid, name="Survey")])
        db.flush()
        db.add(DatasetColumn(id=pid, dataset_id=pid, column_code="Q", column_name="Q",
                             column_text="Open", column_type="open_text",
                             sequence_order=0, display_order=0))
        _code(db, pid, pid, 1, name="A")
        db.flush()
        base = pid * 100_000
        db.execute(insert(DatasetRow.__table__), [
            {"id": base + i, "dataset_id": pid} for i in range(n_targets)
        ])
        db.execute(insert(DatasetValue.__table__), [
            {"id": base + i, "row_id": base + i, "column_id": pid, "value_text": "x"}
            for i in range(n_targets)
        ])
        db.execute(insert(CodeApplication.__table__), [
            {"dataset_value_id": base + i, "code_id": pid, "user_id": uid, "origin": "human"}
            for i in range(n_targets) for uid in (1, 2)
        ])
        db.flush()

    @staticmethod
    def _peak(fn):
        import gc
        import tracemalloc

        gc.collect()
        tracemalloc.start()
        try:
            fn()
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    def test_the_gathers_memory_does_not_grow_with_the_project(self, db_session, monkeypatch):
        import app.services.consensus as consensus
        from app.services.consensus import SEGMENT_SCOPE_PROJECT, gather_target_votes

        db = db_session
        _coder(db, 2, "B")
        self._corpus(db, 971, self.SMALL)
        self._corpus(db, 972, self.LARGE)
        monkeypatch.setattr(consensus, "GATHER_STREAM_BATCH", 50)

        def stream(pid):
            votes = gather_target_votes(db, pid, segment_scope=SEGMENT_SCOPE_PROJECT, min_voters=2)
            return lambda: sum(1 for _ in votes.ballots())

        # Warm SQLAlchemy's statement caches on BOTH sizes first: they grow with
        # the number of distinct statements run, not with the data, and are not
        # the subject. Measured without this, a cold small run read lower.
        stream(971)(), stream(972)()
        small, large = self._peak(stream(971)), self._peak(stream(972))
        held = self._peak(lambda: list(
            gather_target_votes(db, 972, segment_scope=SEGMENT_SCOPE_PROJECT,
                                min_voters=2).ballots()
        ))
        # The fixture could have disagreed: HOLDING the large project's ballots
        # costs many times what streaming it does (#707a).
        assert held > 5 * large, (small, large, held)
        # Ten times the targets, and the stream's peak barely moves.
        assert large < 2 * small, (small, large, held)

    def test_the_rollups_memory_does_not_grow_with_the_project(self, db_session, monkeypatch):
        """The rollup is the gather's other consumer, and it could hold the
        stream again on its own — by batching a LIST, or by resolving every
        target before scoring one (which it did until #958's last step)."""
        import app.services.consensus as consensus
        from app.services import magnitude_rollup as mr

        db = db_session
        _coder(db, 2, "B")
        self._corpus(db, 973, self.SMALL)
        self._corpus(db, 974, self.LARGE)
        monkeypatch.setattr(consensus, "GATHER_STREAM_BATCH", 50)
        monkeypatch.setattr(mr, "GATHER_STREAM_BATCH", 50)

        # Warm the statement caches on both sizes (see the gather test above).
        mr.compute_magnitude_rollup(db, 973), mr.compute_magnitude_rollup(db, 974)
        small = self._peak(lambda: mr.compute_magnitude_rollup(db, 973))
        large = self._peak(lambda: mr.compute_magnitude_rollup(db, 974))
        assert large < 2 * small, (small, large)
