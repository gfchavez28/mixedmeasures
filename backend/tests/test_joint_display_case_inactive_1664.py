"""#1664 (D332–D334) — the case view leaves an INACTIVE bound code out, as the compute does.

The codebook's Merge moves a code's coding to its target and makes the source inactive; the
compute leaves it out of the numbers and names it (D325, `inactive_codes`). The case read did
not: MEASURED at HEAD `e161b389` on this fixture, after merging "Planning time" away, the rule
*"did not use Planning time"* ran — ``matched 4, unknown 2, total 6`` — selecting T1 and T4,
who used it, and every case read "not used". Wanted: the code leaves the heads, the gather
and every case fact; ``inactive_codes`` names it and where its coding went; a saved condition
naming it is KEPT and NOT RUN, with its own reason (`MISFIT_RULE_CODE_INACTIVE`).
"""
from __future__ import annotations

from app.models.code import Code
from app.schemas.joint_display import JointDisplayCasesResponse
from app.services import joint_display_cases as jdc
from tests.test_joint_display_id_reuse_1639 import _run, _user
from tests.test_joint_display_slice2_cases import PID, PLAN, _Fx, _read

TARGET = 26599
DID_NOT_USE = [{"kind": "code", "strand_key": "codes", "code_id": PLAN, "present": False}]


def _merge_plan_away(db):
    from app.routers.codes import merge_codes
    db.add(Code(id=TARGET, project_id=PID, numeric_id=2, name="Barrier noted",
                is_universal=False, is_active=True))
    db.flush()
    _run(merge_codes(PID, PLAN, TARGET, delete_source=False, user=_user(db), db=db))
    db.expire_all()
    assert db.get(Code, PLAN).is_active is False  # precondition: the codebook's merge


def test_a_merged_code_leaves_the_case_view_and_is_named_with_its_target(db_session):
    fx = _Fx(db_session)
    _merge_plan_away(db_session)
    out = _read(fx)
    JointDisplayCasesResponse.model_validate(out)  # the wire carries it (extra='forbid' here)
    assert out["codes"] == [], "a merged-away code is offered as a column and a rule option"
    assert all(c["facts"]["codes"]["codes"] == [] for c in out["cases"]), "…and read per case"
    assert out["inactive_codes"] == [{
        "strand_key": "codes", "code_id": PLAN, "name": "Planning time",
        "merged_into_id": TARGET, "merged_into_name": "Barrier noted"}]


def test_a_saved_rule_naming_it_is_kept_and_not_run(db_session):
    fx = _Fx(db_session)
    _merge_plan_away(db_session)
    out = _read(fx, rule=DID_NOT_USE)
    assert out["rule_unavailable_reason"] == jdc.MISFIT_RULE_CODE_INACTIVE
    assert out["matched"] is None and out["unknown"] is None, "the rule ran over a merged code"
    assert out["list_size"] == 0 and all(c["matches"] is None for c in out["cases"])


def test_a_deactivated_code_is_named_with_no_target_and_its_rule_not_run(db_session):
    fx = _Fx(db_session)
    db_session.get(Code, PLAN).is_active = False  # the codebook's toggle, no merge
    db_session.flush()
    out = _read(fx, rule=DID_NOT_USE)
    assert out["codes"] == []
    assert out["inactive_codes"][0]["merged_into_id"] is None
    assert out["rule_unavailable_reason"] == jdc.MISFIT_RULE_CODE_INACTIVE


def test_a_condition_on_a_strand_the_row_lacks_is_still_a_missing_reference(db_session):
    """The inactive arm answers only for a code the row's strand BINDS."""
    fx = _Fx(db_session)
    _merge_plan_away(db_session)
    out = _read(fx, rule=[{"kind": "code", "strand_key": "gone", "code_id": PLAN, "present": False}])
    assert out["rule_unavailable_reason"] == jdc.MISFIT_RULE_REFERENCE_MISSING


def test_control_an_active_code_is_read_and_its_rule_runs(db_session):
    fx = _Fx(db_session)
    out = _read(fx, rule=DID_NOT_USE)
    assert [c["name"] for c in out["codes"]] == ["Planning time"]
    assert out["inactive_codes"] == []
    assert out["rule_unavailable_reason"] is None and out["matched"] is not None
