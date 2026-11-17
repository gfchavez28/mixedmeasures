"""The joint display's canvas node, as the server reads it (D162, D164, D202).

`services/joint_display_node.py` is the one statement of where inside a `joint-display`
node the server finds ids, quotes and text. Three readers depend on it: the extractors
(search and the referenced-source list), the withdrawal scrub (`test_joint_display_pins.py`)
and the `.mmproject` remap (here, through a real export and import).
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from app.models.canvas import Canvas, CanvasTheme
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.models.document import Document
from app.models.excerpt import Excerpt
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import joint_display_node as node
from app.services.canvas import (
    extract_referenced_source_ids,
    extract_theme_searchable_text,
    update_theme_content,
)
from app.services.project_portability import (
    CURRENT_FORMAT_VERSION,
    _remap_canvas_content,
    export_project,
    import_project,
)

GONE = 987_654


def _display(**over) -> dict:
    display = {
        "group_by_column_id": 11,
        "conversation_ids": [21, GONE],
        "document_ids": None,
        "attribution": {"label": "participant", "column_id": 12},
        "settings": {"newcombe": False},
        "rows": [{
            "key": "r1", "construct": "Protected planning time",
            "code_ids": [31, GONE], "column_ids": [12], "result_material_ids": [GONE],
            "fit": "discordance",
            "meta_inference": {"text": "Coded planning does not follow the gap.",
                               "author_id": 1, "type": "comparative"},
            "implication": "Fund release time.",
            "pins": [{"excerptId": 41, "displayText": "We plan on Fridays.",
                      "sourceContext": "Focus group", "conversationId": 21,
                      "observationId": None, "group": "High", "role": "typical"}],
        }],
    }
    display.update(over)
    return display


def _doc(display) -> dict:
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Prose."}]},
        {"type": "joint-display", "attrs": {"displayKey": "k", "figureEpoch": 1,
                                            "display": display}},
    ]}


class TestTheExtractors:
    def test_search_indexes_what_was_written_and_pinned(self):
        text = extract_theme_searchable_text(_doc(_display()))
        for part in ("Prose.", "Protected planning time", "does not follow the gap",
                     "Fund release time.", "We plan on Fridays."):
            assert part in text
        assert "discordance" not in text, "a vocabulary key is not the researcher's writing"

    def test_a_discrepant_pins_purpose_is_the_researchers_writing_and_indexed(self):
        """Session B (D163.5): a discrepant quote names its purpose — the researcher's words."""
        display = _display()
        display["rows"][0]["pins"][0].update(role="discrepant",
                                             purpose="The one teacher who planned alone.")
        text = extract_theme_searchable_text(_doc(display))
        assert "The one teacher who planned alone." in text
        assert "discrepant" not in text, "the role is a vocabulary key, not writing"

    def test_a_pinned_quote_is_a_referenced_source(self):
        assert extract_referenced_source_ids(_doc(_display())) == [{"type": "excerpt", "id": 41}]

    def test_a_display_held_as_a_string_reads_the_same(self):
        as_string = _doc(json.dumps(_display()))
        assert extract_referenced_source_ids(as_string) == [{"type": "excerpt", "id": 41}]

    def test_a_broken_display_is_passed_over_not_a_crash(self):
        """The extractors run on every save; only the scrub must refuse it."""
        for broken in ("{not json", ["list"], {"rows": "x"}, {"rows": [{"pins": "x"}]}):
            assert extract_referenced_source_ids(_doc(broken)) is None
            assert extract_theme_searchable_text(_doc(broken)) == "Prose."


class TestTheRemap:
    MAP = {"dataset_columns": {11: 111, 12: 112}, "conversations": {21: 121},
           "codes": {31: 131}, "excerpts": {41: 141}, "coders": {1: 7}}

    def _remapped(self, display):
        node.remap_display(display, lambda table, old: self.MAP.get(table, {}).get(old))
        return display

    def test_every_nested_id_is_rewritten(self):
        d = self._remapped(_display())
        row = d["rows"][0]
        assert d["group_by_column_id"] == 111
        assert d["attribution"]["column_id"] == 112
        assert row["column_ids"] == [112]
        assert row["meta_inference"]["author_id"] == 7
        assert row["pins"][0]["excerptId"] == 141
        assert row["pins"][0]["conversationId"] == 121

    def test_an_id_that_did_not_travel_becomes_null_in_its_place(self):
        """D202 — never kept: on a fresh install a kept SOURCE id can name another row."""
        d = self._remapped(_display())
        assert d["conversation_ids"] == [121, None]
        assert d["rows"][0]["code_ids"] == [131, None]
        assert d["rows"][0]["result_material_ids"] == [None]

    def test_null_and_absent_stay_what_they_were(self):
        d = self._remapped(_display())
        assert d["document_ids"] is None, "null = every document (#1297) must survive"
        assert d["rows"][0]["pins"][0]["observationId"] is None

    def test_a_pin_whose_quote_did_not_travel_keeps_its_words(self):
        d = _display()
        d["rows"][0]["pins"][0]["excerptId"] = GONE
        pin = self._remapped(d)["rows"][0]["pins"][0]
        assert pin["excerptId"] is None and pin["displayText"] == "We plan on Fridays."

    def test_an_unresolved_author_is_never_kept(self):
        d = _display()
        d["rows"][0]["meta_inference"]["author_id"] = 2  # not in the coder remap
        assert self._remapped(d)["rows"][0]["meta_inference"]["author_id"] is None

    def test_the_canvas_remap_reaches_the_node_and_re_derives_the_references(self):
        content, refs = _remap_canvas_content(json.dumps(_doc(_display())), self.MAP)
        display = json.loads(content)["content"][1]["attrs"]["display"]
        assert display["rows"][0]["code_ids"] == [131, None]
        assert json.loads(refs) == [{"type": "excerpt", "id": 141}]

    def test_every_id_key_is_declared_with_a_table_the_import_fills(self):
        """A key whose table name the import never fills would remap everything to null.
        The tables are the import's own `remap` keys (`project_portability`)."""
        from app.services import project_portability as pp
        source = Path(pp.__file__).read_text(encoding="utf-8")
        tables = {t for keys in (node.DISPLAY_ID_KEYS, node.ATTRIBUTION_ID_KEYS,
                                 node.ROW_ID_KEYS, node.META_INFERENCE_ID_KEYS,
                                 node.PIN_ID_KEYS) for t, _ in keys.values()}
        for table in tables:
            assert f'"{table}"' in source, f"no remap table named {table!r} in project_portability"


class TestARoundTrip:
    """D164 — through a real export and import, as a v8 file."""

    def _project(self, db):
        db.add(User(id=2, username="Elsewhere", password_hash="x", coder_type="human"))
        project = Project(name="JD", user_id=1)
        db.add(project)
        db.flush()
        pid = project.id
        ds = Dataset(project_id=pid, name="Roster")
        db.add(ds)
        db.flush()
        group = DatasetColumn(dataset_id=ds.id, column_code="G", column_name="Gain group",
                              column_text="Gain group", column_type=ColumnType.NOMINAL,
                              sequence_order=0, display_order=0)
        db.add(group)
        conv = Conversation(project_id=pid, name="Focus group")
        doc = Document(project_id=pid, name="Journal", source_filename="j.txt", source_format="txt")
        code = Code(project_id=pid, numeric_id=1, name="Planning", is_universal=False,
                    is_active=True)
        db.add_all([conv, doc, code])
        db.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=0, text="We plan on Fridays.")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1))
        quote = Excerpt(project_id=pid, segment_id=seg.id)
        db.add(quote)
        canvas = Canvas(project_id=pid, name="Report")
        db.add(canvas)
        db.flush()
        display = {
            "group_by_column_id": group.id,
            "conversation_ids": [conv.id], "document_ids": [doc.id],
            "rows": [{
                "key": "r1", "construct": "Planning", "code_ids": [code.id, GONE],
                "column_ids": [group.id],
                "meta_inference": {"text": "…", "author_id": 1},
                "pins": [{"excerptId": quote.id, "displayText": seg.text,
                          "sourceContext": "Focus group", "conversationId": conv.id,
                          "observationId": None, "group": "High", "role": None}],
            }, {
                "key": "r2", "construct": "Other", "code_ids": [], "column_ids": [],
                "meta_inference": {"text": "…", "author_id": 2},  # no coding: not in the file
                "pins": [],
            }],
        }
        theme = CanvasTheme(canvas_id=canvas.id, name="Findings")
        db.add(theme)
        db.flush()
        update_theme_content(db, theme, {"type": "doc", "content": [
            {"type": "joint-display", "attrs": {"displayKey": "k", "figureEpoch": 1,
                                                "display": display}}]})
        db.flush()
        return pid, {"group": group.id, "conv": conv.id, "doc": doc.id, "code": code.id,
                     "quote": quote.id}

    def _import(self, db, pid) -> int:
        buf = export_project(db, pid, Path("/nonexistent"))
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(buf.getvalue())
            tmp.close()
            new_id, _ = import_project(db, Path(tmp.name), Path("/tmp/docs_test"), user_id=1)
            db.flush()
            return new_id
        finally:
            os.unlink(tmp.name)

    def test_the_file_is_v8_and_every_id_lands_on_the_imported_rows(self, db_session):
        db = db_session
        assert CURRENT_FORMAT_VERSION == 8
        pid, old = self._project(db)
        new_pid = self._import(db, pid)

        new = {
            "group": db.query(DatasetColumn.id).join(Dataset).filter(
                Dataset.project_id == new_pid).scalar(),
            "conv": db.query(Conversation.id).filter_by(project_id=new_pid).scalar(),
            "doc": db.query(Document.id).filter_by(project_id=new_pid).scalar(),
            "code": db.query(Code.id).filter_by(project_id=new_pid).scalar(),
            "quote": db.query(Excerpt.id).filter_by(project_id=new_pid).scalar(),
        }
        assert all(new[k] != old[k] for k in old), "precondition: the import minted new ids"
        theme = (db.query(CanvasTheme).join(Canvas)
                 .filter(Canvas.project_id == new_pid).one())
        display = json.loads(theme.content)["content"][0]["attrs"]["display"]
        first, second = display["rows"]
        assert display["group_by_column_id"] == new["group"]
        assert display["conversation_ids"] == [new["conv"]]
        assert display["document_ids"] == [new["doc"]]
        assert first["code_ids"] == [new["code"], None], "D202: the deleted code is null"
        assert first["column_ids"] == [new["group"]]
        assert first["pins"][0]["excerptId"] == new["quote"]
        assert first["pins"][0]["conversationId"] == new["conv"]
        assert first["meta_inference"]["author_id"] == 1, "a coder in the file resolves"
        assert second["meta_inference"]["author_id"] is None, "one not in the file is nulled"
        assert json.loads(theme.referenced_source_ids) == [{"type": "excerpt", "id": new["quote"]}]

    def test_a_build_that_knows_only_v7_refuses_the_file(self, db_session, monkeypatch):
        """The refusal gate (D164): what an older build does is the test of a bump."""
        import pytest
        from app.services import project_portability as pp
        db = db_session
        pid, _ = self._project(db)
        buf = export_project(db, pid, Path("/nonexistent"))
        monkeypatch.setattr(pp, "CURRENT_FORMAT_VERSION", 7)
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(buf.getvalue())
            tmp.close()
            with pytest.raises(ValueError, match="newer"):
                import_project(db, Path(tmp.name), Path("/tmp/docs_test"), user_id=1)
        finally:
            os.unlink(tmp.name)
