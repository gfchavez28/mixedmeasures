"""Track J · J2-5 (M-1) reconciliation grid tests.

Exercises ``build_reconciliation`` — the per-unit pivot of the multi-coder layers.
The load-bearing property: the grid's consensus column is LIVE-derived at TARGET
level (the coders who coded THAT unit) and must be byte-identical to the
materialized consensus layer, while by_coder + has_disagreement use SOURCE-level
engagement (Option B). Fixtures mirror test_consensus.py.
"""
import json

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
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
