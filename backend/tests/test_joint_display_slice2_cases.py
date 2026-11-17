"""Joint display slice 2 — the case-ordered view and "cases that don't fit" (D173; r3).

Three parts, each against the rule it must keep:

- **The stored shape (C4)** in `joint_display_node.py`: a picked case's participant id is
  remapped on import, and a case whose participant did NOT travel is dropped with its
  reason (r3-5) — a merge skips a withdrawn person, and her reason must not arrive alone;
  a rule's ids follow D202 (null in place); the reason is in the search index.
- **The withdrawal (r3-6):** every picked case naming them is removed, reason and all, in
  sections and snapshot copies; the report counts what the act removes; a display it cannot
  walk stops the withdrawal; a deleted section's undo holding one is a record to refuse.
- **The case read (C3)**: one case per grouped participant in a stable order; code facts by
  the compute's gather (no material = no answer, never "no"); values through the column's
  missing rules and labels; a rule over the row's bindings, AND with three values (r3-2);
  #1615's withheld columns refuse the rule by name (r3-3); paging and the picked list.
"""
from __future__ import annotations

import json

import pytest

from app.models.canvas import CanvasSnapshot, CanvasTheme
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.schemas.joint_display import JointDisplayCasesRequest, JointDisplayCasesResponse
from app.services import joint_display_cases as jdc
from app.services import joint_display_node as node
from app.services.canvas import create_snapshot
from app.services.canvas_embed_scrub import CanvasScrubError, holds_canvas_quotes
from app.services.joint_display import VARIABLE_NOT_SUMMARISABLE, VARIABLE_RATING_WITHHELD
from app.services.withdrawal_report import build_withdrawal_report
from tests.test_joint_display_pins import _section
from tests.test_withdrawal_deleted_history import _project, _withdraw


def _misfit_node(*added, removed=(), rule=None) -> dict:
    return {"type": "joint-display", "attrs": {"displayKey": "k-m", "figureEpoch": 1, "display": {
        "rows": [{"key": "r0", "construct": "Planning", "code_ids": [], "column_ids": [],
                  "pins": [], "misfit": {"rule": rule, "added": [dict(c) for c in added],
                                         "removed": [dict(c) for c in removed]}}]}}}


def _cases_in(content: str) -> list[dict]:
    """Every listed case, added then removed (r3-12's two lists)."""
    doc = json.loads(content)
    return [c for n in doc["content"] for r in n["attrs"]["display"]["rows"]
            for key in ("added", "removed") for c in r["misfit"][key]]


# ── The stored shape ────────────────────────────────────────────────────────────────


class TestTheRemap:
    def _display(self):
        return {"group_by_column_id": 7, "rows": [{
            "key": "r", "code_ids": [3], "column_ids": [8],
            "misfit": {"rule": {"conditions": [
                           {"kind": "variable", "column_id": 8, "op": "lt", "value": 24},
                           {"kind": "code", "strand_key": "codes", "code_id": 3, "present": True},
                           {"kind": "variable", "column_id": 99, "op": "lt", "value": 1},
                           {"kind": "group", "group": "High"}]},
                       "added": [{"participant_id": 11, "reason": "Left mid-year"},
                                 {"participant_id": 12, "reason": "Withdrawn elsewhere"}],
                       "removed": [{"participant_id": 12, "reason": "Hours in days"},
                                   {"participant_id": 11, "reason": "Typo"}]}}]}

    def _lookup(self):
        table = {"dataset_columns": {7: 70, 8: 80}, "codes": {3: 30},
                 "participants": {11: 110}}  # 12 did not travel (a merge skipped her)
        return lambda t, old: table.get(t, {}).get(old)

    def test_a_case_is_remapped_and_one_whose_participant_did_not_travel_is_dropped(self):
        d = self._display()
        node.remap_display(d, self._lookup())
        m = d["rows"][0]["misfit"]
        assert m["added"] == [{"participant_id": 110, "reason": "Left mid-year"}]
        assert m["removed"] == [{"participant_id": 110, "reason": "Typo"}]

    def test_a_rules_ids_follow_d202_null_in_place(self):
        d = self._display()
        node.remap_display(d, self._lookup())
        conds = d["rows"][0]["misfit"]["rule"]["conditions"]
        assert [c.get("column_id") for c in conds] == [80, None, None, None]
        assert conds[1]["code_id"] == 30 and conds[3] == {"kind": "group", "group": "High"}

    def test_control_a_slice_1_display_remaps_as_before(self):
        d = {"group_by_column_id": 7, "rows": [{"key": "r", "code_ids": [3], "column_ids": [8]}]}
        node.remap_display(d, self._lookup())
        assert d == {"group_by_column_id": 70, "rows": [{"key": "r", "code_ids": [30],
                                                          "column_ids": [80]}]}

    def test_a_reason_is_searchable(self):
        assert "Left mid-year" in node.display_search_text(self._display())


# ── The withdrawal ──────────────────────────────────────────────────────────────────


class TestTheWithdrawal:
    """Wren (participant 1) withdraws; Ola (2) stays — `test_withdrawal_deleted_history`."""

    def test_their_case_and_its_reason_go_and_someone_elses_stays_in_sections_and_snapshots(
            self, db_session):
        db = db_session
        _project(db)
        canvas_id, theme_id = _section(db, _misfit_node(
            {"participant_id": 1, "reason": "Wren moved schools"},
            {"participant_id": 2, "reason": "Ola is new"},
            removed=[{"participant_id": 1, "reason": "Wren's hours were days"}]))
        create_snapshot(db, canvas_id, "Before")

        report = build_withdrawal_report(db, db.get(Participant, 1))
        assert report.canvas_misfit_cases == 4  # added + removed, in the section and the snapshot
        outcome = _withdraw(db)
        assert outcome.canvas_misfit_cases_removed == report.canvas_misfit_cases

        theme = db.get(CanvasTheme, theme_id)
        assert _cases_in(theme.content) == [{"participant_id": 2, "reason": "Ola is new"}]
        assert "Wren moved schools" not in (theme.searchable_text or "")
        assert "were days" not in (theme.searchable_text or "")
        assert "Ola is new" in (theme.searchable_text or "")
        snap = db.query(CanvasSnapshot).one()
        (copy,) = json.loads(snap.snapshot_data)["themes"]
        assert _cases_in(copy["content"]) == [{"participant_id": 2, "reason": "Ola is new"}]
        assert "Wren moved schools" not in (copy["searchable_text"] or "")

    def test_the_wire_carries_the_count(self, db_session):
        from app.schemas.participant import WithdrawalReportResponse
        db = db_session
        _project(db)
        _section(db, _misfit_node({"participant_id": 1, "reason": "x"}))
        sent = build_withdrawal_report(db, db.get(Participant, 1)).to_dict()
        assert WithdrawalReportResponse.model_validate(sent).model_dump()["canvas_misfit_cases"] == 1

    @pytest.mark.parametrize("misfit", ["not an object", {"added": "not a list"},
                                        {"removed": ["not an object"]}],
                             ids=["misfit", "added", "a-removed-case"])
    def test_a_misfit_it_cannot_walk_stops_the_withdrawal(self, db_session, misfit):
        db = db_session
        _project(db)
        _section(db, {"type": "joint-display", "attrs": {"displayKey": "k", "display": {
            "rows": [{"key": "r", "pins": [], "misfit": misfit}]}}})
        with pytest.raises(CanvasScrubError):
            _withdraw(db)

    # ── R11 (the combine; r3-14): a plain DELETE removes the cases naming the person too ──

    def _delete(self, db, participant_id):
        from app.routers.participants import delete_participant  # `def` since the slice 2 build
        return delete_participant(1, participant_id, user=db.get(User, 1), db=db)

    def test_a_plain_delete_removes_their_cases_and_reasons_and_keeps_someone_elses(
            self, db_session):
        """A case's reason is about this person, so it goes with them. (Before #1639's
        AUTOINCREMENT, D319, a case left behind attached its reason to the next person given
        the id; an id freed before that upgrade can still be issued once, D320.)"""
        db = db_session
        _project(db)
        canvas_id, theme_id = _section(db, _misfit_node(
            {"participant_id": 1, "reason": "Wren moved schools"},
            {"participant_id": 2, "reason": "Ola is new"},
            removed=[{"participant_id": 1, "reason": "Wren's hours were days"}]))
        create_snapshot(db, canvas_id, "Before")
        assert self._delete(db, 1)["deleted_id"] == 1
        db.expire_all()
        assert db.get(Participant, 1) is None
        theme = db.get(CanvasTheme, theme_id)
        assert _cases_in(theme.content) == [{"participant_id": 2, "reason": "Ola is new"}]
        assert "Wren moved schools" not in (theme.searchable_text or "")
        assert "Ola is new" in (theme.searchable_text or "")
        (copy,) = json.loads(db.query(CanvasSnapshot).one().snapshot_data)["themes"]
        assert _cases_in(copy["content"]) == [{"participant_id": 2, "reason": "Ola is new"}]

    def test_a_plain_delete_stops_at_a_misfit_it_cannot_walk(self, db_session):
        from fastapi import HTTPException
        db = db_session
        _project(db)
        _section(db, {"type": "joint-display", "attrs": {"displayKey": "k", "display": {
            "rows": [{"key": "r", "pins": [], "misfit": {"added": "not a list"}}]}}})
        db.commit()  # the refusal rolls back: the fixture must not be what it rolls back
        with pytest.raises(HTTPException) as refused:
            self._delete(db, 1)
        assert refused.value.status_code == 409
        db.expire_all()
        assert db.get(Participant, 1) is not None

    def test_a_deleted_sections_record_holding_a_case_is_one_a_restore_must_ask_about(self):
        doc = {"type": "doc", "content": [_misfit_node({"participant_id": 5, "reason": "r"})]}
        assert holds_canvas_quotes(doc)
        empty = {"type": "doc", "content": [_misfit_node()]}
        assert not holds_canvas_quotes(empty), "control: an empty picked list holds no one"


# ── The case read ───────────────────────────────────────────────────────────────────

PID = 2650
ROSTER, SURVEY = 2650, 2651
GROUP, HOURS, CONF, NOTE = 26501, 26511, 26512, 26513
CONV = 2650
PLAN = 26521
ME, COLLEAGUE = 1, 2


class _Fx:
    """Six teachers: High = T1..T3, Low = T4..T6; T7 has turns and no group.

    Hours: T1 30, T2 10, T3 blank, T4 5, T5 "N/A" (a non-answer), T6 no survey row.
    Confidence (nominal, labelled High/Low): T1 "high", T3 "HIGH" — case variants (#1332).
    T1, T4 used Planning (mine); T5 used it only in a COLLEAGUE's coding; T2 has a turn
    with no coding; T3 and T6 have no material at all.
    """

    def __init__(self, db):
        self.db = db
        db.add(User(id=COLLEAGUE, username="Colleague", password_hash="x", coder_type="human"))
        db.add(Project(id=PID, name="Cases", user_id=ME))
        db.flush()
        db.add_all([Dataset(id=ROSTER, project_id=PID, name="Roster"),
                    Dataset(id=SURVEY, project_id=PID, name="Survey")])
        db.flush()

        def col(cid, ds, name, ctype, order, **kw):
            return DatasetColumn(id=cid, dataset_id=ds, column_code=name, column_name=name,
                                 column_text=name, column_type=ctype, sequence_order=order,
                                 display_order=order, **kw)
        db.add_all([
            col(GROUP, ROSTER, "Gain group", ColumnType.NOMINAL, 0),
            col(HOURS, SURVEY, "Training hours", ColumnType.NUMERIC, 0),
            col(CONF, SURVEY, "Confidence", ColumnType.NOMINAL, 1,
                scale_labels=json.dumps(["High", "Low"]), scale_values=json.dumps([1, 2])),
            col(NOTE, SURVEY, "Comments", ColumnType.OPEN_TEXT, 2),
        ])
        db.add(Conversation(id=CONV, project_id=PID, name="Focus group"))
        db.add(Code(id=PLAN, project_id=PID, numeric_id=1, name="Planning time",
                    is_universal=False, is_active=True))
        db.flush()
        self._seg = 265_000
        survey = {1: ("30", "high"), 2: ("10", "Low"), 3: ("", "HIGH"), 4: ("5", None), 5: ("N/A", None)}
        for p in range(1, 8):
            db.add(Participant(id=26500 + p, project_id=PID, identifier=f"T{p}",
                               display_name=f"Name {p}"))
            db.flush()
            if p <= 6:
                db.add(DatasetRow(id=26500 + p, dataset_id=ROSTER, row_identifier=f"T{p}",
                                  participant_id=26500 + p))
                db.flush()
                db.add(DatasetValue(row_id=26500 + p, column_id=GROUP,
                                    value_text="High" if p <= 3 else "Low"))
            if p in survey:
                hours, conf = survey[p]
                db.add(DatasetRow(id=26600 + p, dataset_id=SURVEY, row_identifier=f"S{p}",
                                  participant_id=26500 + p))
                db.flush()
                db.add(DatasetValue(row_id=26600 + p, column_id=HOURS, value_text=hours,
                                    value_numeric=float(hours) if hours.isdigit() else None))
                db.add(DatasetValue(row_id=26600 + p, column_id=NOTE, value_text="My own words"))
                if conf:
                    db.add(DatasetValue(row_id=26600 + p, column_id=CONF, value_text=conf))
            db.add(Speaker(id=26500 + p, project_id=PID, name=f"S{p}", is_facilitator=0,
                           color_index=0, participant_id=26500 + p))
            db.flush()
        for p, coder in ((1, ME), (4, ME), (5, COLLEAGUE), (2, None), (7, ME)):
            self._seg += 1
            db.add(Segment(id=self._seg, conversation_id=CONV, sequence_order=self._seg,
                           text="t", word_count=1, speaker_id=26500 + p))
            db.flush()
            if coder is not None:
                db.add(CodeApplication(segment_id=self._seg, code_id=PLAN, user_id=coder))
        db.flush()


@pytest.fixture
def fx(db_session):
    return _Fx(db_session)


def _read(fx, *, rule=None, coder_ids=None, only="all", added=(), removed=(), offset=0, limit=50,
          columns=(HOURS, CONF, NOTE)):
    return jdc.read_cases(
        fx.db, PID, group_by_column_id=GROUP,
        strands=[jdc.CaseStrand("codes", "codes"), jdc.CaseStrand("variables", "variables")],
        bindings={"codes": jdc.CaseBinding(code_ids=(PLAN,)),
                  "variables": jdc.CaseBinding(column_ids=tuple(columns))},
        coder_ids=coder_ids, layer_scope="human", rule=rule, only=only,
        added_participant_ids=list(added), removed_participant_ids=list(removed),
        offset=offset, limit=limit)


def _by(out) -> dict[str, dict]:
    return {c["label"]: c for c in out["cases"]}


def _value(case, cid):
    (v,) = [v for v in case["facts"]["variables"]["values"] if v["column_id"] == cid]
    return v


class TestTheCases:
    def test_every_grouped_participant_once_in_group_then_identifier_order(self, fx):
        out = _read(fx)
        assert [c["label"] for c in out["cases"]] == ["T1", "T2", "T3", "T4", "T5", "T6"]
        assert out["total"] == out["listed"] == 6 and out["groups"] == ["High", "Low"]
        assert all(c["label"] != "Name 1" for c in out["cases"]), "r3-7: never the display name"
        JointDisplayCasesResponse.model_validate(out)

    def test_code_facts_no_material_is_no_answer_never_no(self, fx):
        by = _by(_read(fx))
        used = {k: c["facts"]["codes"]["codes"][0]["used"] for k, c in by.items()}
        assert used == {"T1": True, "T2": False, "T3": None, "T4": True, "T5": True, "T6": None}
        assert by["T2"]["facts"]["codes"]["coded"] is False  # material, none coded (#1626)

    def test_the_coder_scope_moves_a_code_fact(self, fx):
        by = _by(_read(fx, coder_ids=[ME]))
        assert by["T5"]["facts"]["codes"]["codes"][0]["used"] is False

    def test_values_follow_the_columns_rules_and_open_text_is_never_shown(self, fx):
        by = _by(_read(fx))
        assert _value(by["T1"], HOURS)["value"] == 30
        assert _value(by["T3"], HOURS)["reason"] == jdc.CASE_VALUE_MISSING  # blank
        assert _value(by["T5"], HOURS)["reason"] == jdc.CASE_VALUE_MISSING  # "N/A"
        assert _value(by["T6"], HOURS)["reason"] == jdc.CASE_NO_ROW
        assert _value(by["T1"], CONF)["label"] == "High"  # #1332: a case variant of the label
        assert _value(by["T3"], CONF)["label"] == "High"  # and in capitals
        assert _value(by["T1"], NOTE) == {"column_id": NOTE, "value": None, "label": None,
                                          "reason": VARIABLE_NOT_SUMMARISABLE}

    def test_paging_is_stable(self, fx):
        assert [c["label"] for c in _read(fx, offset=2, limit=2)["cases"]] == ["T3", "T4"]


class TestTheRule:
    HIGH_FEW_HOURS = [{"kind": "group", "group": "High"},
                      {"kind": "variable", "column_id": HOURS, "op": "lt", "value": 24}]

    def test_and_with_three_values_matched_and_unknown_never_folded(self, fx):
        out = _read(fx, rule=self.HIGH_FEW_HOURS)
        m = {c["label"]: c["matches"] for c in out["cases"]}
        assert m == {"T1": False, "T2": True, "T3": None, "T4": False, "T5": False, "T6": False}
        assert (out["matched"], out["unknown"]) == (1, 1)

    def test_a_code_condition_on_someone_with_no_material_cannot_be_checked(self, fx):
        out = _read(fx, rule=[{"kind": "code", "strand_key": "codes", "code_id": PLAN,
                               "present": False}])
        m = {c["label"]: c["matches"] for c in out["cases"]}
        assert m == {"T1": False, "T2": True, "T3": None, "T4": False, "T5": False, "T6": None}

    def test_a_label_condition_takes_a_case_variant_and_missing_is_its_own_operator(self, fx):
        out = _read(fx, rule=[{"kind": "variable", "column_id": CONF, "op": "is", "value": "high"}])
        assert {c["label"] for c in out["cases"] if c["matches"]} == {"T1", "T3"}
        out = _read(fx, rule=[{"kind": "variable", "column_id": HOURS, "op": "missing"}])
        assert {c["label"] for c in out["cases"] if c["matches"]} == {"T3", "T5", "T6"}
        assert out["unknown"] == 0

    def test_the_list_holds_the_selected_cases(self, fx):
        out = _read(fx, rule=self.HIGH_FEW_HOURS, only="list")
        assert [c["label"] for c in out["cases"]] == ["T2"] and out["listed"] == 1

    @pytest.mark.parametrize("cond,reason", [
        ({"kind": "variable", "column_id": 999, "op": "lt", "value": 1},
         jdc.MISFIT_RULE_REFERENCE_MISSING),
        ({"kind": "code", "strand_key": "codes", "code_id": 999, "present": True},
         jdc.MISFIT_RULE_REFERENCE_MISSING),
        ({"kind": "code", "strand_key": "nope", "code_id": PLAN, "present": True},
         jdc.MISFIT_RULE_REFERENCE_MISSING),
        ({"kind": "variable", "column_id": CONF, "op": "lt", "value": 1},
         jdc.MISFIT_RULE_CONDITION_INVALID),
        ({"kind": "variable", "column_id": NOTE, "op": "is", "value": "x"},
         jdc.MISFIT_RULE_CONDITION_INVALID),
        ({"kind": "variable", "column_id": HOURS, "op": "lt", "value": "many"},
         jdc.MISFIT_RULE_CONDITION_INVALID),
        ({"kind": "someday"}, jdc.MISFIT_RULE_CONDITION_INVALID),
    ], ids=["column", "code", "strand", "op-for-type", "open-text", "value", "kind"])
    def test_a_rule_it_cannot_check_selects_nothing_and_says_why(self, fx, cond, reason):
        out = _read(fx, rule=[{"kind": "group", "group": "High"}, cond])
        assert out["rule_unavailable_reason"] == reason
        assert out["matched"] is None and all(c["matches"] is None for c in out["cases"])

    def test_a_column_the_row_does_not_bind_is_not_a_condition(self, fx):
        out = _read(fx, rule=[{"kind": "variable", "column_id": HOURS, "op": "lt", "value": 1}],
                    columns=(CONF,))
        assert out["rule_unavailable_reason"] == jdc.MISFIT_RULE_REFERENCE_MISSING

    def test_while_blind_a_withheld_column_is_named_and_the_rule_not_checked(self, fx, monkeypatch):
        # The seam the compute asks (#1615); its own rule is pinned by test_blind_grouping_1615.
        monkeypatch.setattr(jdc, "withheld_rating_columns_in_project",
                            lambda db, pid, coder_ids: frozenset({HOURS}) if coder_ids else frozenset())
        out = _read(fx, rule=self.HIGH_FEW_HOURS, coder_ids=[ME])
        assert out["rule_unavailable_reason"] == VARIABLE_RATING_WITHHELD
        assert out["rule_withheld_columns"] == ["Training hours"] and out["matched"] is None
        assert _value(_by(out)["T1"], HOURS)["reason"] == VARIABLE_RATING_WITHHELD
        assert _read(fx, rule=self.HIGH_FEW_HOURS)["matched"] == 1, "control: not blind"


class TestTheList:
    """r3-12 — the rule's cases, less the removed, plus the added; each says why."""

    def test_the_rules_cases_less_the_removed_plus_the_added(self, fx):
        # The rule selects T2 only; T2 is removed, T5 and T1 added, T7 (no group) and 99 too.
        out = _read(fx, rule=TestTheRule.HIGH_FEW_HOURS, only="list",
                    added=[26505, 26501, 26507, 99], removed=[26502])
        assert [(c["label"], c["listed_by"]) for c in out["cases"]] == [
            ("T1", jdc.MISFIT_LISTED_BY_ADDED), ("T5", jdc.MISFIT_LISTED_BY_ADDED)]
        assert out["list_size"] == 2 and out["matched"] == 1
        assert out["added_outside"] == 2  # T7 has no group; 99 is no one here
        by = _by(_read(fx, rule=TestTheRule.HIGH_FEW_HOURS, removed=[26502]))
        assert by["T2"]["matches"] is True and by["T2"]["removed"] and by["T2"]["listed_by"] is None

    def test_with_no_rule_the_list_is_what_was_added(self, fx):
        out = _read(fx, only="list", added=[26504])
        assert [c["label"] for c in out["cases"]] == ["T4"] and out["matched"] is None


class TestAStrandsOwnDataset:
    """R10 + R5 (the combine): a variables strand naming ONE dataset (D205) shows, and lets a
    rule name, only that dataset's columns — as the compute lists the others as missing;
    ``dataset_id`` None reads any dataset (slice 1's implicit strand)."""

    def _read_strand(self, fx, dataset_id, rule=None):
        return jdc.read_cases(
            fx.db, PID, group_by_column_id=GROUP,
            strands=[jdc.CaseStrand("v", "variables", dataset_id=dataset_id)],
            bindings={"v": jdc.CaseBinding(column_ids=(HOURS,))},
            coder_ids=None, layer_scope="human", rule=rule, only="all",
            added_participant_ids=[], removed_participant_ids=[], offset=0, limit=50)

    def test_another_datasets_column_is_not_the_strands(self, fx):
        rule = [{"kind": "variable", "column_id": HOURS, "op": "lt", "value": 24}]
        own, anyone = self._read_strand(fx, SURVEY, rule), self._read_strand(fx, None, rule)
        assert [v["column_id"] for v in own["variables"]] == [HOURS] == [
            v["column_id"] for v in anyone["variables"]]
        assert own["matched"] == anyone["matched"] is not None
        other = self._read_strand(fx, ROSTER, rule)
        assert other["variables"] == [] and all(c["facts"]["v"]["values"] == [] for c in other["cases"])
        assert other["rule_unavailable_reason"] == jdc.MISFIT_RULE_REFERENCE_MISSING


class TestTheRequest:
    def test_bounds(self):
        with pytest.raises(ValueError):
            JointDisplayCasesRequest(group_by_column_id=1, row_key="r", limit=jdc.MAX_CASE_PAGE + 1)
        with pytest.raises(ValueError):
            JointDisplayCasesRequest(group_by_column_id=1, row_key="r",
                                     added_participant_ids=list(range(jdc.MAX_LISTED_CASES + 1)))

    def test_the_router_reads_slice_1s_implicit_pair(self, fx):
        from app.routers.joint_display import case_rows
        body = JointDisplayCasesRequest(
            group_by_column_id=GROUP, row_key="r",
            bindings={"codes": {"code_ids": [PLAN]}, "variables": {"column_ids": [HOURS]}},
            rule={"conditions": TestTheRule.HIGH_FEW_HOURS})
        out = case_rows(PID, body, user=fx.db.get(User, ME), db=fx.db)
        assert out["matched"] == 1 and out["total"] == 6

    def test_it_refuses_what_the_compute_refuses(self):
        """The case read answers only for a display the compute would draw (the build's
        open item: it ignored display-level sources beside strands, and bindings to a strand
        the request did not carry). Same words as the compute's, from one rule."""
        from app.schemas.joint_display import JointDisplayComputeRequest
        strands = [{"key": "a", "kind": "codes"}, {"key": "b", "kind": "variables"}]
        refused = [
            ({"strands": strands, "conversation_ids": [1]}, "each strand names its own sources"),
            ({"strands": strands, "document_ids": []}, "each strand names its own sources"),
            ({"strands": [strands[0], {"key": "a", "kind": "variables"}]}, "two strands share a key"),
        ]
        for extra, words in refused:
            with pytest.raises(ValueError, match=words):
                JointDisplayCasesRequest(group_by_column_id=1, row_key="r", **extra)
            with pytest.raises(ValueError, match=words):
                JointDisplayComputeRequest(group_by_column_id=1, **extra)
        with pytest.raises(ValueError, match="does not have"):
            JointDisplayCasesRequest(group_by_column_id=1, row_key="r", strands=strands,
                                     bindings={"gone": {"code_ids": [1]}})
        with pytest.raises(ValueError, match="does not have"):
            JointDisplayCasesRequest(group_by_column_id=1, row_key="r",
                                     bindings={"a": {"code_ids": [1]}})  # no strands: the pair's keys only
        # What the client sends is accepted (lib/joint-display-cases.ts::caseRequest).
        JointDisplayCasesRequest(group_by_column_id=1, row_key="r", strands=strands,
                                 conversation_ids=None, document_ids=None,
                                 bindings={"a": {"code_ids": [1]}, "b": {"column_ids": [2]}})
