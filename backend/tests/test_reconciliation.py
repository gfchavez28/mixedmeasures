"""Track J · J2-5 (M-1) reconciliation grid tests.

Exercises ``build_reconciliation`` — the per-unit pivot of the multi-coder layers.
The load-bearing property: the grid's consensus column is LIVE-derived at TARGET
level (the coders who coded THAT unit) and must be byte-identical to the
materialized consensus layer, while by_coder + has_disagreement use SOURCE-level
engagement (Option B). Fixtures mirror test_consensus.py.
"""
import json
import pytest
from datetime import datetime

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.consensus import materialize_consensus_for_project
from app.services.reconciliation import build_reconciliation


# ── fixtures ──────────────────────────────────────────────────────────────────
# db_session pre-creates User(id=1) 'testuser' (human, not archived) = coder A.


def _coder(db, uid, name, coder_type="human"):
    db.add(User(id=uid, username=name, password_hash=None, coder_type=coder_type))
    db.flush()


def _conv(db, pid=900, cid=900, name="C"):
    db.add_all([Project(id=pid, name="P", user_id=1), Conversation(id=cid, project_id=pid, name=name)])
    db.flush()
    return pid, cid


def _seg(db, sid, cid, seq, text="hi"):
    db.add(Segment(id=sid, conversation_id=cid, sequence_order=seq, text=text))
    db.flush()
    return sid


def _code(db, cid, pid, numeric_id, name="Theme", universal=False, group_id=None):
    db.add(Code(id=cid, project_id=pid, name=name, numeric_id=numeric_id,
                is_active=True, is_universal=universal, code_equivalence_group_id=group_id))
    db.flush()


def _apply(db, code_id, user_id, *, segment_id=None, value_id=None):
    db.add(CodeApplication(code_id=code_id, user_id=user_id,
                           segment_id=segment_id, dataset_value_id=value_id))
    db.flush()


def _unit(resp, unit_type, unit_id):
    for u in resp["units"]:
        if u["unit_type"] == unit_type and u["unit_id"] == unit_id:
            return u
    return None


# ── availability ────────────────────────────────────────────────────────────


def test_unavailable_under_two_coders(db_session):
    db = db_session
    pid, cid = _conv(db)
    _seg(db, 9001, cid, 0)
    _code(db, 901, pid, 1)
    _apply(db, 901, 1, segment_id=9001)  # only coder A

    resp = build_reconciliation(db, pid)
    assert resp["available"] is False
    assert resp["reason"]
    assert resp["units"] == [] and resp["total"] == 0 and resp["has_more"] is False


# ── consensus column + disagreement flag ──────────────────────────────────────


def test_agreement_unit_has_consensus_and_no_disagreement(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    _seg(db, 9001, cid, 0)
    _code(db, 901, pid, 1, name="X")
    _apply(db, 901, 1, segment_id=9001)
    _apply(db, 901, 2, segment_id=9001)

    resp = build_reconciliation(db, pid)
    assert resp["available"] is True and resp["n_coders"] == 2
    u = _unit(resp, "segment", 9001)
    assert u["consensus"] == [901]
    assert u["consensus_context"]["901"] == {"rule": "unanimous", "agree": 2, "voters": 2}
    assert u["has_disagreement"] is False
    assert u["by_coder"] == {"1": [901], "2": [901]}
    assert sorted(u["engaged"]) == [1, 2]
    assert {c["id"] for c in resp["codes"]} == {901}


def test_majority_unit_has_consensus_and_disagreement(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    _coder(db, 3, "C")
    _seg(db, 9001, cid, 0)
    _code(db, 901, pid, 1, name="X")
    _code(db, 902, pid, 2, name="Y")
    _apply(db, 901, 1, segment_id=9001)  # A: X
    _apply(db, 901, 2, segment_id=9001)  # B: X
    _apply(db, 902, 3, segment_id=9001)  # C: Y

    u = _unit(build_reconciliation(db, pid), "segment", 9001)
    assert u["consensus"] == [901]
    assert u["consensus_context"]["901"] == {"rule": "majority", "agree": 2, "voters": 3}
    # A unit can have a consensus AND be flagged (C dissents) — the reconciliation signal.
    assert u["has_disagreement"] is True


def test_tie_no_consensus_but_disagreement(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    _seg(db, 9001, cid, 0)
    _code(db, 901, pid, 1, name="X")
    _code(db, 902, pid, 2, name="Y")
    _apply(db, 901, 1, segment_id=9001)  # A: X
    _apply(db, 902, 2, segment_id=9001)  # B: Y

    u = _unit(build_reconciliation(db, pid), "segment", 9001)
    assert u["consensus"] == []
    assert u["has_disagreement"] is True
    assert u["by_coder"] == {"1": [901], "2": [902]}


# ── the decisive target-level-vs-source-level case ────────────────────────────


def test_target_vs_source_level_blank_matches_materializer(db_session):
    """B is SOURCE-engaged (coded S1) but left S2 blank. S2's consensus is
    TARGET-level (voters = {A} → none), matching the materialized layer; the
    grid still flags S2 as a disagreement because B reviewed the source."""
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    s1 = _seg(db, 9001, cid, 0)
    s2 = _seg(db, 9002, cid, 1)
    _code(db, 901, pid, 1, name="X")
    _apply(db, 901, 1, segment_id=s1)  # A: S1=X
    _apply(db, 901, 1, segment_id=s2)  # A: S2=X
    _apply(db, 901, 2, segment_id=s1)  # B: S1=X  (B engaged the conversation)
    # B leaves S2 blank.

    resp = build_reconciliation(db, pid)
    u1, u2 = _unit(resp, "segment", s1), _unit(resp, "segment", s2)
    assert u1["consensus"] == [901] and u1["has_disagreement"] is False
    # S2: only A coded it → no target-level consensus, but B's blank is a disagreement.
    assert u2["consensus"] == []
    assert u2["has_disagreement"] is True
    assert u2["by_coder"] == {"1": [901], "2": []}, "B shows an explicit blank (reviewed)"

    # The grid's consensus column is byte-identical to the materialized layer.
    materialize_consensus_for_project(db, pid)
    for u in resp["units"]:
        stored = {
            r.code_id for r in db.query(CodeApplication).filter(
                CodeApplication.origin == "consensus",
                CodeApplication.segment_id == u["unit_id"],
            ).all()
        }
        assert set(u["consensus"]) == stored, f"unit {u['unit_id']} grid consensus != materialized"


# ── filters / pagination ──────────────────────────────────────────────────────


def test_disagreements_only_filter(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    s1 = _seg(db, 9001, cid, 0)  # agree
    s2 = _seg(db, 9002, cid, 1)  # disagree
    _code(db, 901, pid, 1, name="X")
    _code(db, 902, pid, 2, name="Y")
    _apply(db, 901, 1, segment_id=s1)
    _apply(db, 901, 2, segment_id=s1)
    _apply(db, 901, 1, segment_id=s2)
    _apply(db, 902, 2, segment_id=s2)

    full = build_reconciliation(db, pid)
    assert {u["unit_id"] for u in full["units"]} == {s1, s2}
    only = build_reconciliation(db, pid, disagreements_only=True)
    assert {u["unit_id"] for u in only["units"]} == {s2}
    assert only["total"] == 1


def test_pagination_total_has_more_and_order(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    # 5 visible segments in a multi-coder conversation → all 5 are in-play units.
    for i in range(5):
        _seg(db, 9001 + i, cid, seq=i)
    _code(db, 901, pid, 1, name="X")
    _apply(db, 901, 1, segment_id=9001)  # A + B both engage the conversation
    _apply(db, 901, 2, segment_id=9001)

    page0 = build_reconciliation(db, pid, limit=2, offset=0)
    assert page0["total"] == 5 and page0["has_more"] is True
    assert [u["unit_id"] for u in page0["units"]] == [9001, 9002], "ordered by sequence"
    page2 = build_reconciliation(db, pid, limit=2, offset=4)
    assert [u["unit_id"] for u in page2["units"]] == [9005] and page2["has_more"] is False


def test_source_filter(db_session):
    db = db_session
    pid, cid = _conv(db, cid=900, name="C1")
    db.add(Conversation(id=901, project_id=pid, name="C2"))
    db.flush()
    _coder(db, 2, "B")
    _seg(db, 9001, 900, 0)   # in C1
    _seg(db, 9101, 901, 0)   # in C2
    _code(db, 901, pid, 1, name="X")
    for sid in (9001, 9101):
        _apply(db, 901, 1, segment_id=sid)
        _apply(db, 901, 2, segment_id=sid)

    resp = build_reconciliation(db, pid, source_type="conversation", source_id=900)
    assert {u["unit_id"] for u in resp["units"]} == {9001}
    assert all(u["source_id"] == 900 for u in resp["units"])


# ── exclusions / equivalence / coder subset / dataset values ──────────────────


def test_universal_and_consensus_excluded(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    _seg(db, 9001, cid, 0)
    _code(db, 901, pid, 1, name="X")
    _code(db, 990, pid, 2, name="Unclear", universal=True)
    _apply(db, 901, 1, segment_id=9001)
    _apply(db, 901, 2, segment_id=9001)
    _apply(db, 990, 1, segment_id=9001)  # universal — must not appear
    materialize_consensus_for_project(db, pid)  # creates origin='consensus' rows

    u = _unit(build_reconciliation(db, pid), "segment", 9001)
    assert u["by_coder"] == {"1": [901], "2": [901]}, "universal + consensus rows excluded"
    assert {c["id"] for c in build_reconciliation(db, pid)["codes"]} == {901}


def test_equivalence_group_agreement(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    _seg(db, 9001, cid, 0)
    db.add(CodeEquivalenceGroup(id=50, project_id=pid, label="positive-ish", canonical_code_id=901))
    db.flush()
    _code(db, 901, pid, 1, name="Positive", group_id=50)
    _code(db, 902, pid, 2, name="POSITIVE", group_id=50)
    _apply(db, 901, 1, segment_id=9001)  # A: Positive
    _apply(db, 902, 2, segment_id=9001)  # B: POSITIVE (≡ canonical 901)

    u = _unit(build_reconciliation(db, pid), "segment", 9001)
    assert u["consensus"] == [901], "agreement on the canonical effective code"
    assert u["by_coder"] == {"1": [901], "2": [901]}, "both resolved to the effective code"
    assert u["has_disagreement"] is False


def test_coder_ids_subset(db_session):
    db = db_session
    pid, cid = _conv(db)
    _coder(db, 2, "B")
    _coder(db, 3, "C")
    _seg(db, 9001, cid, 0)
    _code(db, 901, pid, 1, name="X")
    _code(db, 902, pid, 2, name="Y")
    _apply(db, 901, 1, segment_id=9001)
    _apply(db, 901, 2, segment_id=9001)
    _apply(db, 902, 3, segment_id=9001)

    # Restrict to A + C: now only their layers count → tie (X vs Y), no consensus.
    resp = build_reconciliation(db, pid, coder_ids=[1, 3])
    assert {c["id"] for c in resp["coders"]} == {1, 3}
    u = _unit(resp, "segment", 9001)
    assert u["consensus"] == [] and u["has_disagreement"] is True
    assert u["by_coder"] == {"1": [901], "3": [902]}


def test_dataset_value_units(db_session):
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
    _code(db, 901, 903, 1, name="X")
    _apply(db, 901, 1, value_id=90310)
    _apply(db, 901, 2, value_id=90310)

    resp = build_reconciliation(db, 903)
    u = _unit(resp, "dataset_value", 90310)
    assert u is not None
    assert u["source_type"] == "column" and u["consensus"] == [901]
    assert u["text"] == "alpha"
    assert "Survey" in u["source_label"]


# ── Observation clips (slab 6b-B) ────────────────────────────────────────────


def _obs_with_clips(db, pid, oid, clip_ids, *, frozen, name="Classroom"):
    db.add(Observation(
        id=oid, project_id=pid, name=name,
        segmentation_frozen_at=datetime(2026, 7, 19, 12, 0, 0) if frozen else None,
    ))
    db.flush()
    for i, sid in enumerate(clip_ids):
        db.add(Segment(id=sid, conversation_id=None, observation_id=oid,
                       sequence_order=i, start_time=i * 30.0, end_time=i * 30.0 + 12.5,
                       text=""))
    db.flush()


class TestReconciliationClips:

    def test_a_frozen_clip_renders_with_its_source_and_time_range(self, db_session):
        """Before the maps gained an "obs" entry this did not degrade — it 500ed:
        `_SOURCE_TYPE[src_t]` is a bare subscript. And `_source_label` used to fall
        through to the column branch, so the source name came back silently blank.
        """
        db = db_session
        pid, _cid = _conv(db, cid=920, name="Interview")
        _coder(db, 2, "B")
        _obs_with_clips(db, pid, 920, [9201, 9202], frozen=True, name="Playground")
        _code(db, 920, pid, 1, name="Off-task")
        for sid in (9201, 9202):
            _apply(db, 920, 1, segment_id=sid)
            _apply(db, 920, 2, segment_id=sid)

        resp = build_reconciliation(db, pid)
        clip = next(u for u in resp["units"] if u["unit_id"] == 9201)

        assert clip["source_type"] == "observation"
        assert clip["source_id"] == 920
        assert clip["source_label"] == "Playground", "not a silently blank label"
        assert clip["unit_type"] == "segment", "a clip IS a Segment — unit type is unchanged"
        assert clip["start_time"] == 0.0 and clip["end_time"] == 12.5

    def test_open_clips_never_reach_the_grid(self, db_session):
        """Two-sided in one project: frozen in, open out. A one-sided fixture
        cannot distinguish "frozen only" from "all clips"."""
        db = db_session
        pid, _cid = _conv(db, cid=921, name="Interview")
        _coder(db, 2, "B")
        _obs_with_clips(db, pid, 921, [9211, 9212], frozen=True, name="Frozen")
        _obs_with_clips(db, pid, 1921, [9221, 9222, 9223], frozen=False, name="Open")
        _code(db, 921, pid, 1, name="X")
        for sid in (9211, 9212, 9221, 9222, 9223):
            _apply(db, 921, 1, segment_id=sid)
            _apply(db, 921, 2, segment_id=sid)

        resp = build_reconciliation(db, pid)
        by_source = {u["source_id"] for u in resp["units"] if u["source_type"] == "observation"}
        assert by_source == {921}
        assert {u["unit_id"] for u in resp["units"] if u["source_type"] == "observation"} \
            == {9211, 9212}

    def test_source_filter_narrows_to_one_observation(self, db_session):
        db = db_session
        pid, _cid = _conv(db, cid=922, name="Interview")
        _coder(db, 2, "B")
        _obs_with_clips(db, pid, 922, [9231, 9232], frozen=True, name="A")
        _obs_with_clips(db, pid, 1922, [9241], frozen=True, name="B")
        _code(db, 922, pid, 1, name="X")
        for sid in (9231, 9232, 9241):
            _apply(db, 922, 1, segment_id=sid)
            _apply(db, 922, 2, segment_id=sid)

        resp = build_reconciliation(db, pid, source_type="observation", source_id=922)
        assert {u["unit_id"] for u in resp["units"]} == {9231, 9232}

    def test_clip_consensus_matches_the_materialized_layer(self, db_session):
        """The contract reconciliation's docstring promises. It holds only because
        the gather is frozen-only — reconciliation itself never applies the
        eligibility clause, so an open clip reaching here would be live-derived a
        consensus the materializer refuses to store."""
        db = db_session
        pid, _cid = _conv(db, cid=923, name="Interview")
        _coder(db, 2, "B")
        _obs_with_clips(db, pid, 923, [9251, 9252], frozen=True)
        _code(db, 923, pid, 1, name="X")
        for sid in (9251, 9252):
            _apply(db, 923, 1, segment_id=sid)
            _apply(db, 923, 2, segment_id=sid)

        materialize_consensus_for_project(db, pid)
        db.flush()
        stored = {
            (ca.segment_id, ca.code_id)
            for ca in db.query(CodeApplication).filter(CodeApplication.origin == "consensus").all()
        }
        resp = build_reconciliation(db, pid)
        live = {
            (u["unit_id"], code)
            for u in resp["units"] if u["source_type"] == "observation"
            for code in u["consensus"]
        }
        assert live == {(9251, 923), (9252, 923)}
        assert live <= stored, "live-derived consensus must match what was materialized"

    def test_clip_times_survive_schema_validation(self, db_session):
        """Pins the field against the SCHEMA, not just the service dict.

        `build_reconciliation` returns a plain dict; the response_model only applies
        on a real HTTP request, so a direct endpoint call returns that dict
        unvalidated and would pass whether or not `ReconciliationUnit` declares the
        times. Validating explicitly is what actually proves they survive — an
        undeclared field is dropped silently (the #586 class, arriving through the
        response_model rather than a splat).
        """
        import asyncio
        from app.routers.code_analysis import reconciliation as reconciliation_endpoint
        from app.schemas.code_analysis import ReconciliationResponse

        db = db_session
        pid, _cid = _conv(db, cid=924, name="Interview")
        _coder(db, 2, "B")
        _obs_with_clips(db, pid, 924, [9261], frozen=True, name="Yard")
        _code(db, 924, pid, 1, name="X")
        _apply(db, 924, 1, segment_id=9261)
        _apply(db, 924, 2, segment_id=9261)

        user = db.get(User, 1)
        # Every Query() param is passed explicitly: their defaults are SENTINEL
        # OBJECTS in a direct call (FastAPI resolves them only on a real request),
        # and downstream code that does `value.split(",")` chokes on one.
        resp = asyncio.run(reconciliation_endpoint(
            project_id=pid, source_type=None, source_id=None,
            disagreements_only=False, coder_ids=None, limit=50, offset=0,
            user=user, db=db,
        ))
        validated = ReconciliationResponse(**resp)
        clip = next(u for u in validated.units if u.unit_id == 9261)

        assert clip.source_type == "observation"
        assert clip.start_time == 0.0 and clip.end_time == 12.5, \
            "declared on the schema, or the response_model drops them without a word"

    def test_an_unknown_source_type_is_refused_not_silently_empty(self, db_session):
        """Failing open here is indistinguishable from "these coders agree on
        everything" — the service resolves an unrecognized tag to a sentinel that
        matches nothing, so the grid came back empty with available: true."""
        import asyncio
        from fastapi import HTTPException
        from app.routers.code_analysis import reconciliation as reconciliation_endpoint

        db = db_session
        pid, _cid = _conv(db, cid=925, name="Interview")
        _coder(db, 2, "B")
        user = db.get(User, 1)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(reconciliation_endpoint(
                project_id=pid, source_type="recording", source_id=1,
                disagreements_only=False, coder_ids=None, limit=50, offset=0,
                user=user, db=db))
        assert exc.value.status_code == 400
        assert "observation" in str(exc.value.detail), "the message names the valid kinds"
