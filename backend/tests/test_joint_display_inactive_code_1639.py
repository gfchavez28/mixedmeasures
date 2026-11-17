"""#1639 follow-up (r1-8) — a joint display bound to a code the codebook made INACTIVE.

The codebook's merge (`CodebookView` → `merge_codes(delete_source=false)`) moves the
source's codings to the target and leaves the source inactive; the peek panel's and the
slide-out's toggle deactivate a code with its codings kept. Every analysis view drops an
inactive code (`Code.is_active == True` in the comparison, the frequencies and the canvas
charts). At HEAD the display did not: a merged code drew 0 in every group and a deactivated
one its old counts, with nothing said. Wanted: the display leaves it out of the numbers, as
everywhere else, and SAYS so — naming the code a merge moved its coding into.
"""
from __future__ import annotations

from app.models.dataset import ColumnType
from app.services import joint_display as jd
from tests.test_joint_display_id_reuse_1639 import (
    HIGH, LOW, _display, _drawn, _request, _run, _stored, _user, _World,
)


def _row(db, w):
    displays = [d for _, d in _stored(db, w.pid)]
    out = [_drawn(db, w.pid, d)["out"]["rows"][0] for d in displays]
    assert out[0] == out[1]  # section and snapshot bind the same, so they draw the same
    return out[0]


def _world_with_trust(db):
    w = _World(db)
    trust = w.code("Trust")
    for ident in HIGH:
        w.turn(w.conv, ident, [trust])
    w.store(_display(w, codes=[trust]))
    return w, trust


def test_a_merged_code_is_left_out_and_the_display_names_where_its_coding_went(db_session):
    from app.routers.codes import merge_codes
    db = db_session
    w, trust = _world_with_trust(db)
    _run(merge_codes(w.pid, trust.id, w.planning.id, delete_source=False, user=_user(db), db=db))
    row = _row(db, w)
    assert [c["name"] for c in row["codes"]] == [], "a merged-away code is drawn (0 everywhere)"
    assert row.get("inactive_codes") == [{
        "strand_key": "s-int", "code_id": trust.id, "name": "Trust",
        "merged_into_id": w.planning.id, "merged_into_name": "Planning"}]
    assert row["missing_code_ids"] == []  # inactive is not "no longer in the project"


def test_a_deactivated_code_is_left_out_and_said_with_no_merge_named(db_session):
    db = db_session
    w, trust = _world_with_trust(db)
    trust.is_active = False  # the codebook's toggle (`PATCH …/codes/{id}`, is_active=false)
    db.flush()
    row = _row(db, w)
    assert [c["name"] for c in row["codes"]] == [], "a deactivated code is still counted"
    assert row.get("inactive_codes") == [{
        "strand_key": "s-int", "code_id": trust.id, "name": "Trust",
        "merged_into_id": None, "merged_into_name": None}]


def test_the_last_merge_names_the_target_and_a_merge_into_nothing_live_names_none(db_session):
    """Reactivated, merged again elsewhere: the LAST entry wins; a target since deleted
    (the API door) is no longer named."""
    from app.routers.codes import merge_codes
    db = db_session
    w, trust = _world_with_trust(db)
    other = w.code("Confidence")
    _run(merge_codes(w.pid, trust.id, w.planning.id, delete_source=False, user=_user(db), db=db))
    trust.is_active = True
    db.flush()
    _run(merge_codes(w.pid, trust.id, other.id, delete_source=False, user=_user(db), db=db))
    assert _row(db, w)["inactive_codes"][0]["merged_into_name"] == "Confidence"
    _run(merge_codes(w.pid, other.id, w.planning.id, delete_source=True, user=_user(db), db=db))
    assert _row(db, w)["inactive_codes"][0]["merged_into_id"] is None


def test_control_an_active_code_is_drawn_and_nothing_is_said(db_session):
    db = db_session
    w, trust = _world_with_trust(db)
    row = _row(db, w)
    assert [c["name"] for c in row["codes"]] == ["Trust"]
    high = next(c for c in row["codes"][0]["cells"] if c["group"] == "H")
    assert high["count"] == len(HIGH)
    assert row.get("inactive_codes", []) == []


def test_control_the_merges_undo_makes_it_active_again_with_no_coding_of_its_own(db_session):
    """The codebook's Undo reactivates the source; its codings stay with the target, so it
    is drawn again — at 0, which is now TRUE of an active code (the comparison draws it so)."""
    from app.routers.codes import merge_codes
    db = db_session
    w, trust = _world_with_trust(db)
    _run(merge_codes(w.pid, trust.id, w.planning.id, delete_source=False, user=_user(db), db=db))
    trust.is_active = True  # `codesApi.update(…, { is_active: true })`, CodebookView's undo
    db.flush()
    row = _row(db, w)
    assert [c["name"] for c in row["codes"]] == ["Trust"]
    assert all(c["count"] == 0 for c in row["codes"][0]["cells"])
    assert row.get("inactive_codes", []) == []
    assert LOW  # (the fixture's other group, drawn at 0 throughout)


def test_a_merge_target_whose_id_a_new_code_took_is_never_named(db_session):
    """The merge's audit entry names its target by id: a target deleted (the API door) and its
    id taken by the next code would name THAT code as where the coding went — #1639's class,
    closed by D319's AUTOINCREMENT (a strict xfail under option (a), which scrubs no audit row)."""
    from app.routers.codes import merge_codes
    db = db_session
    w, trust = _world_with_trust(db)
    other = w.code("Confidence")          # the newest code
    _run(merge_codes(w.pid, trust.id, other.id, delete_source=False, user=_user(db), db=db))
    _run(merge_codes(w.pid, other.id, w.planning.id, delete_source=True, user=_user(db), db=db))
    stranger = w.code("Budget cuts")
    named = _row(db, w)["inactive_codes"][0]["merged_into_name"]
    assert named != "Budget cuts", f"names the code that took the target's id (collided: {stranger.id == other.id})"


def test_a_code_strands_binding_never_draws_the_variables_it_happens_to_carry(db_session):
    """The build's own (2026-11-15d): the inactive-code walk was placed between the strand
    kinds' `elif` and their `else`, and Python read that `else` as the walk's `for … else` —
    so the variables branch ran for EVERY strand, and a code strand whose binding carried
    `column_ids` drew them as its own, doubling them in the row's slice 1 `variables`. The
    builder never sends that shape; a stored or hand-made request can."""
    db = db_session
    w, trust = _world_with_trust(db)
    band = w.column("Age band", ColumnType.NOMINAL, {p: "x" for p in HIGH + LOW})
    display = _display(w, codes=[trust], columns=[band])
    display["rows"][0]["bindings"]["s-int"]["column_ids"] = [band.id]
    group_by, strands, rows = _request(display)
    out = jd.compute_joint_display(db, w.pid, group_by_column_id=group_by, rows=rows,
                                   coder_ids=None, layer_scope="human", newcombe=False,
                                   strands=strands)
    row = out["rows"][0]
    assert row["by_strand"]["s-int"]["variables"] == [], "a code strand drew a variable"
    assert row["by_strand"]["s-int"]["missing_column_ids"] == []
    assert [v["name"] for v in row["by_strand"]["s-svy"]["variables"]] == ["Age band"]
    assert [v["name"] for v in row["variables"]] == ["Age band"]  # once: the survey strand's
    assert [c["name"] for c in row["codes"]] == ["Trust"]
