"""Joint display slice 2 — explicit strands (r1-1 … r1-7): the stored shape, its remap and
the compute over N strands, with an observation strand beside the groups.

Positive control: `test_joint_display.py` runs UNCHANGED — slice 1's request is read as the
implicit pair (r1-2) — and `TestTheImplicitPair` holds the two shapes equal on its fixture.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from app.models.canvas import Canvas, CanvasTheme
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.models.document import Document
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.schemas.joint_display import JointDisplayComputeRequest, JointDisplayComputeResponse
from app.services import joint_display as jd
from app.services import joint_display_node as node
from app.services.canvas import update_theme_content
from app.services.project_portability import export_project, import_project
from tests.test_joint_display import (  # noqa: F401 — `fx` is a fixture
    CONV, COLLEAGUE, DOC, GAIN, GROUP, HIGH, HOURS, LOW, ME, PID, PLAN, RESP, ROSTER, SURVEY, fx,
)

GONE = 987_654
# getattr: so on a build without strands each test fails on its own claim, not at collection.
B = getattr(jd, "BindingRequest", None)
S = getattr(jd, "StrandRequest", None)


def _compute(fx, strands, rows, **kw):
    kw.setdefault("coder_ids", None)
    kw.setdefault("layer_scope", None)
    kw.setdefault("newcombe", False)
    result = jd.compute_joint_display(fx.db, PID, group_by_column_id=GROUP, rows=rows,
                                      strands=strands, **kw)
    JointDisplayComputeResponse.model_validate(result)
    return result


def _cells(strand_row, code_id):
    (code,) = [c for c in strand_row["codes"] if c["code_id"] == code_id]
    return {c["group"]: (c["count"], c["n"]) for c in code["cells"]}


# ── The stored shape and its remap (half (a)) ───────────────────────────────────────

def _display3() -> dict:
    return {
        "group_by_column_id": 11,
        "strands": [
            {"key": "int", "kind": "codes", "label": "Interviews", "conversation_ids": [21, GONE],
             "document_ids": None, "text_column_ids": [12]},
            {"key": "fg", "kind": "codes", "label": "Focus groups", "conversation_ids": None,
             "document_ids": [61]},
            {"key": "svy", "kind": "variables", "label": "Baseline survey", "dataset_id": 71},
            {"key": "obs", "kind": "observation_codes", "label": "Classrooms",
             "observation_ids": [81, GONE]},
        ],
        "rows": [{
            "key": "r1", "construct": "Planning",
            "bindings": {"int": {"code_ids": [31]}, "fg": {"code_ids": [31, GONE]},
                         "svy": {"column_ids": [12], "marked_formed": True},
                         "obs": {"code_ids": [31]}},
            "status": {"fg": "silent"}, "fit_strands": ["int", "svy"],
            "baseline": {"hash": "h", "stamped_at": "2026-11-15",
                         "cells": {"code:31:High": "1 of 2", "code:31:High@fg": "2 of 2",
                                   "code:31@fg:Low": "0 of 1", "observation:31@obs:beside": "1 of 2",
                                   "variable:12:effect@svy": "d = 1", f"code:{GONE}:Low": "0 of 1",
                                   "note": "kept"}},
        }],
    }


class TestTheStoredShape:
    MAP = {"dataset_columns": {11: 111, 12: 112}, "conversations": {21: 121},
           "documents": {61: 161}, "datasets": {71: 171}, "observations": {81: 181},
           "codes": {31: 131}}

    def _remapped(self):
        d = _display3()
        node.remap_display(d, lambda table, old: self.MAP.get(table, {}).get(old))
        return d

    def test_every_strand_source_is_remapped_and_an_unresolved_one_is_null(self):
        s = {x["key"]: x for x in self._remapped()["strands"]}
        assert s["int"]["conversation_ids"] == [121, None]
        assert s["int"]["text_column_ids"] == [112]
        assert s["int"]["document_ids"] is None, "null = every document (#1297) survives"
        assert s["fg"]["document_ids"] == [161]
        assert s["svy"]["dataset_id"] == 171
        assert s["obs"]["observation_ids"] == [181, None]

    def test_every_binding_is_remapped(self):
        b = self._remapped()["rows"][0]["bindings"]
        assert b["int"]["code_ids"] == [131]
        assert b["fg"]["code_ids"] == [131, None], "D202: never kept"
        assert b["svy"]["column_ids"] == [112]
        assert b["obs"]["code_ids"] == [131]
        assert b["svy"]["marked_formed"] is True

    def test_the_drift_stamp_keys_follow_the_ids(self):
        """r1-7: the stamp is keyed by id; unremapped, an import made EVERY stamped cell move."""
        cells = self._remapped()["rows"][0]["baseline"]["cells"]
        assert cells == {"code:131:High": "1 of 2", "code:131:High@fg": "2 of 2",
                         "code:131@fg:Low": "0 of 1", "observation:131@obs:beside": "1 of 2",
                         "variable:112:effect@svy": "d = 1", "note": "kept"}

    def test_strand_keys_fit_pair_and_status_are_plain(self):
        row = self._remapped()["rows"][0]
        assert row["fit_strands"] == ["int", "svy"] and row["status"] == {"fg": "silent"}

    def test_a_strand_label_is_the_researchers_writing_and_indexed(self):
        assert {"Interviews", "Focus groups", "Baseline survey", "Classrooms"} <= set(
            node.display_search_text(_display3()))

    def test_every_id_table_is_one_the_import_fills(self):
        from app.services import project_portability as pp
        source = Path(pp.__file__).read_text(encoding="utf-8")
        for table, _ in [*node.STRAND_ID_KEYS.values(), *node.BINDING_ID_KEYS.values()]:
            assert f'"{table}"' in source, table
        for table in node.BASELINE_KEY_TABLES.values():
            assert f'"{table}"' in source, table

    def test_every_id_table_the_module_declares_is_walked_by_the_remap(self):
        """Census: a `*_ID_KEYS` table nothing walks would be a key copied verbatim."""
        source = Path(node.__file__).read_text(encoding="utf-8")
        declared = set(re.findall(r"^([A-Z_]+_ID_KEYS)\b", source, re.M))
        assert len(declared) >= 7, "population floor"
        body = source[source.index("def remap_display"):]
        assert {t for t in declared if t not in body} == set()


class TestARoundTrip:
    """A display with three strands and an observation strand, through a real v8 file."""

    def test_every_id_lands_on_the_imported_rows(self, db_session):
        db = db_session
        project = Project(name="JD2", user_id=1)
        db.add(project)
        db.flush()
        pid = project.id
        ds = Dataset(project_id=pid, name="Survey")
        db.add(ds)
        db.flush()
        col = DatasetColumn(dataset_id=ds.id, column_code="G", column_name="G", column_text="G",
                            column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0)
        conv = Conversation(project_id=pid, name="Interview")
        doc = Document(project_id=pid, name="FG", source_filename="f.txt", source_format="txt")
        obs = Observation(project_id=pid, name="Room 4")
        code = Code(project_id=pid, numeric_id=1, name="Planning", is_universal=False, is_active=True)
        canvas = Canvas(project_id=pid, name="Report")
        db.add_all([col, conv, doc, obs, code, canvas])
        db.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=0, text="x")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1))
        display = _display3()
        display["group_by_column_id"] = col.id
        st = {x["key"]: x for x in display["strands"]}
        st["int"].update(conversation_ids=[conv.id, GONE], text_column_ids=[col.id])
        st["fg"]["document_ids"] = [doc.id]
        st["svy"]["dataset_id"] = ds.id
        st["obs"]["observation_ids"] = [obs.id, GONE]
        b = display["rows"][0]["bindings"]
        b["int"]["code_ids"] = [code.id]
        b["fg"]["code_ids"] = [code.id, GONE]
        b["svy"]["column_ids"] = [col.id]
        b["obs"]["code_ids"] = [code.id]
        display["rows"][0]["baseline"]["cells"] = {f"code:{code.id}:High@fg": "2 of 2"}
        theme = CanvasTheme(canvas_id=canvas.id, name="Findings")
        db.add(theme)
        db.flush()
        update_theme_content(db, theme, {"type": "doc", "content": [{
            "type": "joint-display", "attrs": {"displayKey": "k", "figureEpoch": 1, "display": display}}]})
        db.flush()
        old = (col.id, conv.id, doc.id, obs.id, code.id, ds.id)

        buf = export_project(db, pid, Path("/nonexistent"))
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(buf.getvalue())
            tmp.close()
            new_pid, _ = import_project(db, Path(tmp.name), Path("/tmp/docs_test"), user_id=1)
            db.flush()
        finally:
            os.unlink(tmp.name)
        new_col = db.query(DatasetColumn.id).join(Dataset).filter(Dataset.project_id == new_pid).scalar()
        new_ds = db.query(Dataset.id).filter_by(project_id=new_pid).scalar()
        new_conv = db.query(Conversation.id).filter_by(project_id=new_pid).scalar()
        new_doc = db.query(Document.id).filter_by(project_id=new_pid).scalar()
        new_obs = db.query(Observation.id).filter_by(project_id=new_pid).scalar()
        new_code = db.query(Code.id).filter_by(project_id=new_pid).scalar()
        assert set(old).isdisjoint({new_col, new_conv, new_doc, new_obs, new_code, new_ds}) or \
            old != (new_col, new_conv, new_doc, new_obs, new_code, new_ds), "precondition: new ids"
        theme = db.query(CanvasTheme).join(Canvas).filter(Canvas.project_id == new_pid).one()
        got = json.loads(theme.content)["content"][0]["attrs"]["display"]
        s = {x["key"]: x for x in got["strands"]}
        assert s["int"]["conversation_ids"] == [new_conv, None]
        assert s["int"]["text_column_ids"] == [new_col]
        assert s["fg"]["document_ids"] == [new_doc]
        assert s["svy"]["dataset_id"] == new_ds
        assert s["obs"]["observation_ids"] == [new_obs, None]
        rb = got["rows"][0]["bindings"]
        assert rb["int"]["code_ids"] == [new_code] and rb["fg"]["code_ids"] == [new_code, None]
        assert rb["svy"]["column_ids"] == [new_col] and rb["obs"]["code_ids"] == [new_code]
        assert got["rows"][0]["baseline"]["cells"] == {f"code:{new_code}:High@fg": "2 of 2"}
        assert "Interviews" in (theme.searchable_text or "")


# ── The compute over N strands (half (b)) ───────────────────────────────────────────

class TestTheImplicitPair:
    def test_slice_1s_request_and_its_strands_are_one_answer(self, fx):
        legacy = jd.compute_joint_display(
            fx.db, PID, group_by_column_id=GROUP, conversation_ids=None, document_ids=None,
            rows=[jd.RowRequest(key="r", code_ids=(PLAN, RESP), column_ids=(HOURS, GAIN),
                                codes_marked_formed=True)],
            coder_ids=None, layer_scope=None, newcombe=True)
        explicit = _compute(fx, [S("codes", "codes"), S("variables", "variables")], [
            jd.RowRequest(key="r", bindings={"codes": B(code_ids=(PLAN, RESP), marked_formed=True),
                                             "variables": B(column_ids=(HOURS, GAIN))})],
            newcombe=True)
        assert legacy == explicit
        assert legacy["rows"][0]["by_strand"]["codes"]["codes"] == legacy["rows"][0]["codes"]


class TestSeveralStrands:
    def test_each_codes_strand_counts_over_its_own_sources(self, fx):
        out = _compute(fx, [S("talk", "codes", conversation_ids=(CONV,), document_ids=()),
                            S("journal", "codes", conversation_ids=(), document_ids=(DOC,))],
                       [jd.RowRequest(key="r", bindings={"talk": B(code_ids=(RESP,)),
                                                         "journal": B(code_ids=(RESP,))})])
        row = out["rows"][0]["by_strand"]
        # Participant 6 has only the journal; the focus group never reaches them.
        assert _cells(row["talk"], RESP) == {"High": (2, 4), "Low": (2, 2)}
        assert _cells(row["journal"], RESP) == {"High": (0, 0), "Low": (1, 1)}
        groups = {s["key"]: {g["key"]: g["with_material"] for g in s["groups"]} for s in out["strands"]}
        assert groups == {"talk": {"High": 4, "Low": 2}, "journal": {"High": 0, "Low": 1}}

    def test_a_variables_strand_reads_its_own_dataset_and_marks_its_own_formed(self, fx):
        out = _compute(fx, [S("svy", "variables", dataset_id=SURVEY),
                            S("roster", "variables", dataset_id=ROSTER)],
                       [jd.RowRequest(key="r", bindings={
                           "svy": B(column_ids=(HOURS, GAIN), marked_formed=True),
                           "roster": B(column_ids=(GAIN, GROUP, HOURS))})])
        row = out["rows"][0]["by_strand"]
        assert [v["column_id"] for v in row["svy"]["variables"]] == [HOURS]
        # D205: not this strand's dataset — left out, and (#1665, D336) never "missing".
        assert row["svy"]["other_dataset_column_ids"] == [GAIN]
        assert row["svy"]["missing_column_ids"] == []
        assert row["svy"]["variables"][0]["formed_groups"] == jd.FORMED_BY_MARK
        roster = {v["column_id"]: v["formed_groups"] for v in row["roster"]["variables"]}
        assert roster == {GAIN: jd.FORMED_BY_DERIVATION, GROUP: jd.FORMED_BY_GROUPING_VARIABLE}
        assert row["roster"]["other_dataset_column_ids"] == [HOURS]
        assert row["roster"]["missing_column_ids"] == []
        # The row's own lists gather every strand's, in display order (the Compact view reads them).
        assert out["rows"][0]["other_dataset_column_ids"] == [GAIN, HOURS]
        assert out["rows"][0]["missing_column_ids"] == []

    def test_status_is_per_strand_and_derived(self, fx):
        out = _compute(fx, [S("a", "codes"), S("b", "codes"), S("v", "variables")],
                       [jd.RowRequest(key="r", bindings={"a": B(code_ids=(PLAN,))})])
        row = out["rows"][0]["by_strand"]
        assert {k: v["status"] for k, v in row.items()} == {
            "a": jd.STRAND_COVERS, "b": jd.STRAND_NOT_MEASURED, "v": jd.STRAND_NOT_MEASURED}

    def test_one_rollup_serves_every_codes_strand(self, fx, monkeypatch):
        calls = []
        real = jd.compute_magnitude_rollup
        monkeypatch.setattr(jd, "compute_magnitude_rollup",
                            lambda *a, **k: calls.append(k["code_ids"]) or real(*a, **k))
        _compute(fx, [S("a", "codes", document_ids=()), S("b", "codes", conversation_ids=())],
                 [jd.RowRequest(key="r", bindings={"a": B(code_ids=(RESP,)), "b": B(code_ids=(RESP,))})])
        assert calls == [[RESP]]


class TestTheTextCodesStrand:
    """r4-1 after L3: open-text answers as their own strand, over the people who answered."""

    def test_its_base_is_who_answered_beside_who_was_surveyed(self, fx):
        from tests.test_joint_display import FREE
        from app.models.dataset import DatasetValue
        fx.db.add(CodeApplication(dataset_value_id=fx.db.query(DatasetValue.id).filter_by(
            column_id=FREE).scalar(), code_id=PLAN, user_id=ME))
        fx.db.flush()
        out = _compute(fx, [S("ans", "text_codes", text_column_ids=(FREE,)),
                            S("none", "text_codes")],
                       [jd.RowRequest(key="r", bindings={"ans": B(code_ids=(PLAN,)),
                                                         "none": B(code_ids=(PLAN,))})])
        row = out["rows"][0]["by_strand"]
        assert _cells(row["ans"], PLAN) == {"High": (0, 0), "Low": (1, 1)}, "only participant 7 answered"
        groups = {s["key"]: {g["key"]: (g["with_material"], g["surveyed"]) for g in s["groups"]}
                  for s in out["strands"]}
        assert groups["ans"] == {"High": (0, 3), "Low": (1, 3)}
        # R12 (the combine): no columns = NONE, and a strand that reads no question measures
        # nothing — "not measured", never "covers" over 0 of 0 (r1's found-beside).
        assert row["none"]["codes"] == [] and row["none"]["missing_code_ids"] == []
        assert row["none"]["status"] == jd.STRAND_NOT_MEASURED
        assert row["ans"]["status"] == jd.STRAND_COVERS
        assert groups["none"] == {"High": (None, 0), "Low": (None, 0)}


class TestTheObservationStrand:
    """r1-4 after L2: observations, coded time and (agreed only) clips — never participants."""

    def _observations(self, fx):
        db = fx.db
        db.add_all([
            Observation(id=1660, project_id=PID, name="Room 4", media_duration_seconds=100.0,
                        segmentation_frozen_at=datetime(2026, 11, 1)),
            Observation(id=1661, project_id=PID, name="Room 5", media_duration_seconds=100.0),
            Observation(id=1662, project_id=PID, name="Room 6", media_duration_seconds=50.0),
        ])
        db.add(Code(id=16529, project_id=PID, numeric_id=9, name="All", is_universal=True,
                    is_active=True))
        db.flush()
        seg_id = [166_000]

        def clip(obs, start, end, codes, hidden=False):
            seg_id[0] += 1
            db.add(Segment(id=seg_id[0], observation_id=obs, sequence_order=seg_id[0], text="clip",
                           start_time=start, end_time=end,
                           split_into_id=seg_id[0] if hidden else None))
            db.flush()
            for code, coder in codes:
                db.add(CodeApplication(segment_id=seg_id[0], code_id=code, user_id=coder))
            db.flush()
        clip(1660, 0, 10, [(PLAN, ME)])
        clip(1660, 5, 20, [(PLAN, ME)])            # overlaps the first: 20 s, never 25
        clip(1660, 30, 40, [(RESP, ME)])
        clip(1660, 50, 60, [(16529, ME)])          # universal only: not a coded clip
        clip(1661, 0, 30, [(PLAN, COLLEAGUE)])     # the colleague's open cut
        clip(1661, 10, 20, [(PLAN, ME)])           # my open cut of the same moment
        clip(1661, 40, 90, [(PLAN, ME)], hidden=True)  # split away: not visible
        clip(1662, 0, 5, [])                       # uncoded

    def _row(self, fx, strands=None, **kw):
        out = _compute(fx, strands or [S("obs", "observation_codes")],
                       [jd.RowRequest(key="r", bindings={s.key: B(code_ids=(PLAN, RESP))
                                                         for s in (strands or [S("obs", "observation_codes")])})],
                       **kw)
        return out, {o["code_id"]: o for o in out["rows"][0]["by_strand"][out["strands"][0]["key"]]["observation_codes"]}

    def test_sessions_time_and_agreed_clips_beside_the_groups(self, fx):
        self._observations(fx)
        out, codes = self._row(fx)
        (strand,) = out["strands"]
        assert strand["unit"] == jd.UNIT_OBSERVATIONS and strand["groups"] is None
        assert strand["observations"] == {"chosen": 3, "with_coding": 2, "agreed": 1,
                                          "observed_seconds": 250.0,
                                          "segmentation": jd.STRAND_SEGMENTATION_MIXED}
        plan = codes[PLAN]
        assert (plan["observations"], plan["of_observations"]) == (2, 3)
        assert plan["seconds"] == 50.0, "a union: 20 s in Room 4 + 30 s in Room 5, overlaps once"
        assert plan["time_share"] == round(50 / 250, 4)
        assert (plan["clips"], plan["of_clips"]) == (2, 3), "clips in the AGREED room only"
        assert codes[RESP]["rating_unavailable_reason"] == jd.RATING_NOT_ON_CLIPS
        assert plan["rating_unavailable_reason"] is None
        assert out["rows"][0]["codes"] == [], "beside the groups: never in a per-group list"

    def test_open_cuts_alone_give_no_clip_count_and_say_why(self, fx):
        self._observations(fx)
        _out, codes = self._row(fx, [S("open", "observation_codes", observation_ids=(1661,))])
        assert codes[PLAN]["clips"] is None
        assert codes[PLAN]["clips_undefined_reason"] == jd.STRAND_CLIPS_OPEN_CUTS
        assert codes[PLAN]["seconds"] == 30.0

    def test_blind_every_measure_is_over_the_viewers_own_clips(self, fx):
        self._observations(fx)
        out, codes = self._row(fx, coder_ids=[ME], layer_scope="human")
        assert out["strands"][0]["observations"]["with_coding"] == 2
        assert codes[PLAN]["seconds"] == 30.0, "my 20 s + my 10 s; the colleague's 30 s is out"
        assert (codes[PLAN]["clips"], codes[PLAN]["of_clips"]) == (2, 3)

    def test_an_unknown_duration_gives_no_share_and_none_is_none(self, fx):
        self._observations(fx)
        fx.db.get(Observation, 1662).media_duration_seconds = None
        fx.db.flush()
        _out, codes = self._row(fx)
        assert codes[PLAN]["time_share"] is None
        assert codes[PLAN]["time_share_undefined_reason"] == jd.STRAND_DURATION_UNKNOWN
        out, codes = self._row(fx, [S("none", "observation_codes", observation_ids=())])
        assert out["strands"][0]["observations"]["chosen"] == 0 and codes[PLAN]["observations"] == 0

    def test_the_union_of_intervals(self):
        assert jd._union_seconds([(0, 10), (5, 20), (30, 40), (40, 45)]) == 35
        assert jd._union_seconds([]) == 0


class TestTheWire:
    def test_through_the_router(self, fx):
        from app.routers.joint_display import compute
        body = JointDisplayComputeRequest(
            group_by_column_id=GROUP,
            strands=[{"key": "a", "kind": "codes", "conversation_ids": [CONV], "document_ids": []},
                     {"key": "o", "kind": "observation_codes"}],
            rows=[{"key": "r", "bindings": {"a": {"code_ids": [PLAN]}, "o": {"code_ids": [PLAN]}}}])
        out = compute(project_id=PID, body=body, user=fx.db.get(User, ME), db=fx.db)
        assert _cells(out["rows"][0]["by_strand"]["a"], PLAN)["High"] == (3, 4)

    @pytest.mark.parametrize("bad", [
        {"rows": [{"key": "r", "bindings": {"a": {}}}]},                       # bindings, no strands
        {"strands": [{"key": "a", "kind": "codes"}, {"key": "a", "kind": "codes"}]},
        {"strands": [{"key": "a", "kind": "codes"}], "conversation_ids": [1]},
        {"strands": [{"key": "a", "kind": "codes"}], "rows": [{"key": "r", "code_ids": [1]}]},
        {"strands": [{"key": "a", "kind": "codes"}], "rows": [{"key": "r", "bindings": {"b": {}}}]},
        {"strands": [{"key": "a", "kind": "images"}]},
        {"strands": [{"key": str(i), "kind": "codes"} for i in range(9)]},
    ])
    def test_a_request_of_two_shapes_or_beyond_bounds_is_refused(self, bad):
        with pytest.raises(ValueError):
            JointDisplayComputeRequest(group_by_column_id=1, **bad)
