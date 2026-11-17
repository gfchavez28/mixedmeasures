"""#1639 — a joint display must never draw the row that takes a deleted row's id.

No table a display binds declares AUTOINCREMENT, so SQLite gives the NEXT row of a table
max(id) + 1: a deleted row's id comes back exactly when it was the table's newest (install-
wide, across projects, and across a restart — it is read from the table, not remembered).
The compute looks a display's ids up by project and id, so after a delete and a new row in
the SAME project, a display that kept the id would draw the new row's numbers under the old
construct's name.

These are the ACCEPTANCE tests for whichever option the developer chooses (r1's brief):
they assert behaviour, never mechanism. For each stored copy of the display (the section
and its snapshot), a request built from it as the client builds one (`_request`, the mirror
of `lib/joint-display.ts::computeRequest`) must not draw the stranger, and the display must
SAY the bound thing is gone — a null in its place (D202: "did not travel / is missing"), the
compute's ``missing_*`` list, or the grouping variable's 404. Option (a) passes by nulling,
(c) by never handing the id out again, (b) by the compute's check.

Every new row is made AFTER the delete with no explicit id, as every create path makes one.
Each test notes whether the ids collided (they do, at HEAD — that is the defect; under D319's
AUTOINCREMENT they never do, and these pass because no id comes back).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.models.canvas import Canvas, CanvasTheme
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.materials import Material, MaterialCollection
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.services import joint_display as jd
from app.services.canvas import create_snapshot, update_theme_content
from app.services.code_analysis import GroupingColumnError
from app.services.joint_display_pins import pin_facts

HIGH, LOW = ("H1", "H2"), ("L1", "L2")


def _run(result):
    """A route called directly — `async def` today; a build that makes a door `def` (it
    walks the canvas: MUST_BE_SYNC) leaves these tests unchanged."""
    return asyncio.run(result) if asyncio.iscoroutine(result) else result


def _user(db):
    return db.get(User, 1)


class _World:
    """Four people in two groups, one interview, two codes, a roster — and a canvas whose
    one section holds a display, snapshotted. Each test adds the row it binds LAST, so it is
    its table's newest (the case reuse needs)."""

    def __init__(self, db):
        self.db = db
        db.add(Project(name="Reuse", user_id=1))
        db.flush()
        self.pid = db.query(Project).filter(Project.name == "Reuse").one().id
        self.roster = Dataset(project_id=self.pid, name="Roster")
        db.add(self.roster)
        db.flush()
        self.people: dict[str, Participant] = {}
        for ident in HIGH + LOW:
            p = Participant(project_id=self.pid, identifier=ident)
            db.add(p)
            db.flush()
            self.people[ident] = p
        self.group = self.column("Group", ColumnType.NOMINAL, {p: p[0] for p in HIGH + LOW})
        self.conv = self.conversation("Interview A")
        self.planning = self.code("Planning")
        for ident in HIGH + LOW:
            self.turn(self.conv, ident, [self.planning])

    def column(self, name, ctype, values: dict[str, str] | None = None, dataset=None, **kw):
        db = self.db
        ds = dataset or self.roster
        n = db.query(DatasetColumn).filter(DatasetColumn.dataset_id == ds.id).count()
        col = DatasetColumn(dataset_id=ds.id, column_code=name, column_name=name, column_text=name,
                            column_type=ctype, sequence_order=n, display_order=n,
                            source=kw.pop("source", "manual"), **kw)
        db.add(col)
        db.flush()
        for ident, text in (values or {}).items():
            row = (db.query(DatasetRow)
                   .filter(DatasetRow.dataset_id == ds.id, DatasetRow.row_identifier == ident).first())
            if row is None:
                row = DatasetRow(dataset_id=ds.id, row_identifier=ident,
                                 participant_id=self.people[ident].id)
                db.add(row)
                db.flush()
            num = float(text) if text.replace(".", "").isdigit() else None
            db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=text, value_numeric=num))
        db.flush()
        return col

    def code(self, name):
        n = self.db.query(Code).filter(Code.project_id == self.pid).count() + 1
        c = Code(project_id=self.pid, numeric_id=n, name=name, is_universal=False, is_active=True)
        self.db.add(c)
        self.db.flush()
        return c

    def conversation(self, name):
        c = Conversation(project_id=self.pid, name=name)
        self.db.add(c)
        self.db.flush()
        return c

    def turn(self, conv, ident, codes, text="t"):
        db = self.db
        sp = (db.query(Speaker).filter(Speaker.project_id == self.pid, Speaker.name == ident).first())
        if sp is None:
            sp = Speaker(project_id=self.pid, name=ident, participant_id=self.people[ident].id)
            db.add(sp)
            db.flush()
        n = db.query(Segment).filter(Segment.conversation_id == conv.id).count()
        seg = Segment(conversation_id=conv.id, sequence_order=n, text=text, word_count=1,
                      speaker_id=sp.id)
        db.add(seg)
        db.flush()
        for c in codes:
            db.add(CodeApplication(segment_id=seg.id, code_id=c.id, user_id=1))
        db.flush()
        return seg

    def store(self, display):
        """The display in a section, then a snapshot of the canvas (the scrub's two places)."""
        db = self.db
        canvas = Canvas(project_id=self.pid, name="Write-up")
        db.add(canvas)
        db.flush()
        theme = CanvasTheme(canvas_id=canvas.id, name="Findings")
        db.add(theme)
        db.flush()
        node = {"type": "joint-display",
                "attrs": {"displayKey": "k1", "figureEpoch": 1, "display": display}}
        update_theme_content(db, theme, {"type": "doc", "content": [node]})
        db.flush()
        create_snapshot(db, canvas.id, "Before the cleanup")
        db.flush()


def _display(w: _World, *, group=None, conversations=None, codes=(), columns=(), dataset=None,
             results=(), pins=(), rule_code=None):
    strands = [{"key": "s-int", "kind": "codes", "label": "Interviews",
                "conversation_ids": None if conversations is None else list(conversations),
                "document_ids": None}]
    strands.append({"key": "s-svy", "kind": "variables", "label": "Survey",
                    "dataset_id": (dataset or w.roster).id})
    row = {"key": "r1", "construct": "Trust in the programme", "code_ids": [], "column_ids": [],
           "result_material_ids": list(results), "pins": list(pins),
           "bindings": {"s-int": {"code_ids": [c.id for c in codes], "column_ids": [],
                                  "marked_formed": False},
                        "s-svy": {"code_ids": [], "column_ids": [c.id for c in columns],
                                  "marked_formed": False}},
           "baseline": {"cells": {f"code:{c.id}@s-int:H": 0.5 for c in codes}}}
    if rule_code is not None:
        row["misfit"] = {"rule": {"conditions": [{"kind": "code", "strand_key": "s-int",
                                                  "code_id": rule_code.id, "present": True}]},
                         "added": [], "removed": []}
    return {"title": "Trust", "group_by_column_id": (group or w.group).id,
            "conversation_ids": None, "document_ids": None,
            "attribution": {"label": "identifier", "column_id": None},
            "strands": strands, "rows": [row], "settings": {"newcombe": False}}


def _stored(db, pid) -> list[tuple[str, dict]]:
    """Every stored copy of the display: the section's, then each snapshot's."""
    out = []
    for theme in db.query(CanvasTheme).join(Canvas).filter(Canvas.project_id == pid):
        db.refresh(theme)
        doc = json.loads(theme.content)
        out.append(("section", doc["content"][0]["attrs"]["display"]))
    from app.models.canvas import CanvasSnapshot
    for snap in db.query(CanvasSnapshot).join(Canvas).filter(Canvas.project_id == pid):
        db.refresh(snap)
        for item in json.loads(snap.snapshot_data)["themes"]:
            doc = json.loads(item["content"])
            out.append(("snapshot", doc["content"][0]["attrs"]["display"]))
    assert len(out) == 2, out  # population: a section AND a snapshot, or a scrub proves nothing
    return out


def _keep(ids):
    return None if ids is None else tuple(i for i in ids if i is not None)


def _request(display):
    """`lib/joint-display.ts::computeRequest`, in Python: null when the display has no
    grouping variable (the screen then says so), and every list loses its null entries."""
    if display["group_by_column_id"] is None:
        return None
    strands = [jd.StrandRequest(key=s["key"], kind=s["kind"],
                                conversation_ids=_keep(s.get("conversation_ids")),
                                document_ids=_keep(s.get("document_ids")),
                                dataset_id=s.get("dataset_id"))
               for s in display["strands"]]
    rows = [jd.RowRequest(key=r["key"], bindings={
        k: jd.BindingRequest(code_ids=_keep(b["code_ids"]), column_ids=_keep(b["column_ids"]))
        for k, b in r["bindings"].items()}) for r in display["rows"]]
    return display["group_by_column_id"], strands, rows


def _nulls(display) -> int:
    """References the stored display holds as null — what `unresolvedReferenceCount` counts,
    plus a null grouping variable."""
    n = 0 if display["group_by_column_id"] is not None else 1
    for s in display["strands"]:
        n += sum(1 for i in (s.get("conversation_ids") or []) if i is None)
    for r in display["rows"]:
        for b in r["bindings"].values():
            n += sum(1 for i in b["code_ids"] + b["column_ids"] if i is None)
        n += sum(1 for i in r.get("result_material_ids") or [] if i is None)
        n += sum(1 for p in r.get("pins") or [] if p.get("excerptId") is None)
        for c in ((r.get("misfit") or {}).get("rule") or {}).get("conditions") or []:
            n += 1 if c.get("kind") == "code" and c.get("code_id") is None else 0
    return n


def _drawn(db, pid, display) -> dict:
    """What the display draws from this stored copy: names, missing ids, a refusal."""
    req = _request(display)
    if req is None:
        return {"names": set(), "missing": [], "refused": None, "groups": None}
    group_by, strands, rows = req
    try:
        out = jd.compute_joint_display(db, pid, group_by_column_id=group_by, rows=rows,
                                       coder_ids=None, layer_scope="human", newcombe=False,
                                       strands=strands)
    except GroupingColumnError as exc:
        return {"names": set(), "missing": [], "refused": exc.status_code, "groups": None}
    r = out["rows"][0]
    names = {c["name"] for c in r["codes"]} | {v["name"] for v in r["variables"]}
    return {"names": names, "missing": r["missing_code_ids"] + r["missing_column_ids"],
            "refused": None, "groups": out["group_by"]["name"], "out": out}


def _assert_never_drawn_and_gone(db, w, stranger_name, collided):
    for where, display in _stored(db, w.pid):
        drawn = _drawn(db, w.pid, display)
        assert stranger_name not in drawn["names"] and drawn["groups"] != stranger_name, (
            f"the {where}'s display draws “{stranger_name}”, the row that took the deleted "
            f"one's id (ids collided: {collided})")
        said = _nulls(display) > 0 or drawn["missing"] or drawn["refused"] == 404
        assert said, f"the {where}'s display does not say the bound thing is gone"


# ── The doors ───────────────────────────────────────────────────────────────────────


def test_a_merged_away_code_is_never_drawn_as_the_next_code(db_session):
    """`merge_codes(delete_source=True)` — the one door that deletes a code row (API only:
    the codebook's merge sends `delete_source=false`)."""
    from app.routers.codes import merge_codes
    db, w = db_session, _World(db_session)
    trust = w.code("Trust")                     # the newest code, bound by the display
    for ident in HIGH:
        w.turn(w.conv, ident, [trust])
    w.store(_display(w, codes=[trust], rule_code=trust))
    old = trust.id
    _run(merge_codes(w.pid, trust.id, w.planning.id, delete_source=True, user=_user(db), db=db))
    stranger = w.code("Budget cuts")            # made later, no id given
    for ident in LOW:
        w.turn(w.conv, ident, [stranger])
    _assert_never_drawn_and_gone(db, w, "Budget cuts", stranger.id == old)
    # The case rule's code and the drift stamp's key are bound ids too.
    for _, display in _stored(db, w.pid):
        row = display["rows"][0]
        rule_ids = [c["code_id"] for c in row["misfit"]["rule"]["conditions"]]
        assert stranger.id not in rule_ids or stranger.id != old
        assert not any(k.startswith(f"code:{stranger.id}@") for k in row["baseline"]["cells"]) \
            or stranger.id != old


def test_control_an_unrelated_code_stays_bound_and_drawn(db_session):
    """Positive control: a delete elsewhere leaves the display's own code alone."""
    from app.routers.codes import merge_codes
    db, w = db_session, _World(db_session)
    trust = w.code("Trust")
    for ident in HIGH:
        w.turn(w.conv, ident, [trust])
    spare = w.code("Spare")                     # the newest, and NOT bound
    w.store(_display(w, codes=[trust]))
    _run(merge_codes(w.pid, spare.id, w.planning.id, delete_source=True, user=_user(db), db=db))
    for _, display in _stored(db, w.pid):
        assert display["rows"][0]["bindings"]["s-int"]["code_ids"] == [trust.id]
        assert _drawn(db, w.pid, display)["names"] == {"Trust"}


@pytest.mark.parametrize("door", ["manual", "computed"])
def test_a_deleted_variable_is_never_drawn_as_the_next_variable(db_session, door):
    from app.routers.dataset import delete_computed_column, delete_manual_column
    db, w = db_session, _World(db_session)
    if door == "manual":
        bound = w.column("Hours", ColumnType.NUMERIC, {"H1": "10", "H2": "12", "L1": "30", "L2": "33"})
    else:
        bound = w.column("Hours x2", ColumnType.NUMERIC,
                         {"H1": "20", "H2": "24", "L1": "60", "L2": "66"},
                         source="computed", expression="[Group] = 'H'",
                         depends_on_column_ids=json.dumps([w.group.id]))
    w.store(_display(w, columns=[bound]))
    old = bound.id
    if door == "manual":
        _run(delete_manual_column(w.pid, w.roster.id, bound.id, user=_user(db), db=db))
    else:
        _run(delete_computed_column(w.pid, w.roster.id, bound.id, user=_user(db), db=db))
    stranger = w.column("Salary band", ColumnType.NUMERIC, {"H1": "1", "H2": "1", "L1": "5", "L2": "5"})
    _assert_never_drawn_and_gone(db, w, "Salary band", stranger.id == old)


def test_a_deleted_datasets_variable_is_never_drawn_as_the_next_one(db_session):
    from app.routers.dataset import delete_dataset
    db, w = db_session, _World(db_session)
    survey = Dataset(project_id=w.pid, name="Survey")
    db.add(survey)
    db.flush()
    bound = w.column("Confidence", ColumnType.NUMERIC,
                     {"H1": "4", "H2": "5", "L1": "1", "L2": "2"}, dataset=survey)
    w.store(_display(w, columns=[bound], dataset=survey))
    old = bound.id
    _run(delete_dataset(w.pid, survey.id, user=_user(db), db=db))
    db.expunge(bound)  # gone by the database's cascade; this session outlives the request
    again = Dataset(project_id=w.pid, name="Survey (re-imported)")
    db.add(again)
    db.flush()
    stranger = w.column("Absences", ColumnType.NUMERIC,
                        {"H1": "9", "H2": "9", "L1": "0", "L2": "0"}, dataset=again)
    _assert_never_drawn_and_gone(db, w, "Absences", stranger.id == old)


def test_a_deleted_grouping_variable_never_groups_by_the_next_variable(db_session):
    from app.routers.dataset import delete_manual_column
    db, w = db_session, _World(db_session)
    cohort = w.column("Cohort", ColumnType.NOMINAL, {"H1": "2019", "H2": "2019", "L1": "2020", "L2": "2020"})
    w.store(_display(w, group=cohort))
    old = cohort.id
    _run(delete_manual_column(w.pid, w.roster.id, cohort.id, user=_user(db), db=db))
    stranger = w.column("Region", ColumnType.NOMINAL, {"H1": "N", "H2": "S", "L1": "N", "L2": "S"})
    _assert_never_drawn_and_gone(db, w, "Region", stranger.id == old)


# ── The doors option (a)'s prototype did not reach — under (c) the same rule holds ─────────


def test_a_deleted_chosen_conversation_is_never_read_as_the_next_one(db_session):
    from app.routers.conversations import delete_conversation
    db, w = db_session, _World(db_session)
    trust = w.code("Trust")
    chosen = w.conversation("Interview B")      # the newest conversation, chosen by the strand
    for ident in HIGH:
        w.turn(chosen, ident, [trust])
    w.store(_display(w, conversations=[chosen.id], codes=[trust]))
    old = chosen.id
    _run(delete_conversation(w.pid, chosen.id, user=_user(db), db=db))
    stranger = w.conversation("Board meeting")
    for ident in LOW:
        w.turn(stranger, ident, [trust])
    for where, display in _stored(db, w.pid):
        out = _drawn(db, w.pid, display)["out"]
        low = next(c for c in out["rows"][0]["codes"][0]["cells"] if c["group"] == "L")
        assert low["count"] == 0, (
            f"the {where}'s strand counts the Low group's Trust from “Board meeting”, the "
            f"conversation that took the chosen one's id (collided: {stranger.id == old})")
        assert _nulls(display) > 0 or out["strands"][0]["scope"]["conversations"] == 0


def test_a_deleted_result_is_never_shown_as_the_next_result(db_session):
    from app.routers.materials import delete_material
    db, w = db_session, _World(db_session)
    coll = MaterialCollection(project_id=w.pid, name="Results")
    db.add(coll)
    db.flush()

    def material(name):
        m = Material(collection_id=coll.id, material_type="frequency", config="{}", auto_name=name)
        db.add(m)
        db.flush()
        return m

    bound = material("Attendance by term")
    w.store(_display(w, results=[bound.id]))
    old = bound.id
    _run(delete_material(w.pid, coll.id, bound.id, user=_user(db), db=db))
    stranger = material("Exam scores")
    for where, display in _stored(db, w.pid):
        ids = display["rows"][0]["result_material_ids"]
        # The client draws a result by reading the material with this id (`useDisplayResults`).
        assert stranger.id not in ids, (
            f"the {where}'s display shows “Exam scores” beside the construct (collided: "
            f"{stranger.id == old})")


def test_a_deleted_quote_is_never_attributed_as_the_next_quote(db_session):
    """A pin keeps its words (a snapshot) but its attribution is read live by `excerptId`."""
    from app.routers.excerpts import delete_excerpt
    db, w = db_session, _World(db_session)
    said = w.turn(w.conv, "H1", [], text="I trust them")
    heard = w.turn(w.conv, "L2", [], text="They cut the budget")
    quote = Excerpt(project_id=w.pid, segment_id=said.id)
    db.add(quote)
    db.flush()
    pin = {"excerptId": quote.id, "displayText": "I trust them", "sourceContext": "Interview A",
           "conversationId": w.conv.id, "observationId": None, "group": "H", "role": "typical",
           "purpose": None}
    w.store(_display(w, pins=[pin]))
    old = quote.id
    _run(delete_excerpt(w.pid, quote.id, user=_user(db), db=db))
    stranger = Excerpt(project_id=w.pid, segment_id=heard.id)
    db.add(stranger)
    db.flush()
    for where, display in _stored(db, w.pid):
        eid = display["rows"][0]["pins"][0]["excerptId"]
        facts = pin_facts(db, w.pid, excerpt_ids=[eid] if eid else [], column_id=None, coder_ids=None)
        assert facts == [] or {f["participant_identifier"] for f in facts} == {"H1"}, (
            f"the {where}'s pin has no live attribution to check")
        assert not any(f["participant_identifier"] == "L2" for f in facts), (
            f"the {where}'s pin “I trust them” is attributed to L2, who said the quote that "
            f"took its id (collided: {stranger.id == old})")


def test_the_compute_names_a_gone_grouping_variable_by_code(db_session):
    """r1-5: the route's 404 for the grouping variable carries a stable code (D207's vocabulary),
    so the display says it in its own words — keyed on the code, never on the message."""
    from fastapi import HTTPException
    from app.routers.dataset import delete_manual_column
    from app.routers.joint_display import compute
    from app.schemas.joint_display import JointDisplayComputeRequest
    db, w = db_session, _World(db_session)
    cohort = w.column("Cohort", ColumnType.NOMINAL, {"H1": "2019", "L1": "2020"})
    _run(delete_manual_column(w.pid, w.roster.id, cohort.id, user=_user(db), db=db))
    body = JointDisplayComputeRequest(group_by_column_id=cohort.id, layer_scope="human")
    with pytest.raises(HTTPException) as exc:
        compute(w.pid, body, user=_user(db), db=db)
    assert exc.value.status_code == 404
    assert exc.value.detail == {"code": jd.GROUPING_GONE,
                                "message": "That variable is not in this project."}
    # control: a variable that cannot form groups is a 400 with the server's own sentence
    hours = w.column("Hours", ColumnType.NUMERIC, {"H1": "1"})
    with pytest.raises(HTTPException) as other:
        compute(w.pid, JointDisplayComputeRequest(group_by_column_id=hours.id, layer_scope="human"),
                user=_user(db), db=db)
    assert other.value.status_code == 400 and isinstance(other.value.detail, str)
