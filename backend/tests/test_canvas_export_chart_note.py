"""The Word export prints the NOTE under a chart's table, as the Markdown and HTML exports do.

`ExportTable.note` is the sentence the client prints under a chart's table — a comparison's
method note, and the groups its tests left out (#1329: "… left out of the tests"). The client
already POSTed it (`docxChartTables` passes the whole table), but `routers/canvas.py::
_decode_chart_tables` read `headers` and `rows` only, so a Word file printed the comparison's
numbers without the words that qualify them. Validated as a joint display's note is (D174).
"""
import io
import json

from docx import Document

from app.database import SessionLocal
from app.routers import canvas as canvas_router
from app.routers.canvas import _decode_chart_tables
from app.services.canvas import create_canvas, create_theme
from app.services.canvas_export import ChartTable, export_canvas_docx
from tests.test_canvas_export import _PNG, _canvas_with_chart, client  # noqa: F401 (fixture)

NOTE = "Welch's t-test. C (n = 1) was left out of the tests: a test needs two values in a group."
TABLE = {"headers": ["Group", "n", "Mean"], "rows": [["A", "6", "3.9"], ["B", "5", "2.1"]]}


def _paragraphs(doc) -> list[str]:
    return [p.text for p in doc.paragraphs]


class TestTheRouterKeepsTheNote:
    def test_a_valid_note_is_kept_and_an_absent_one_reads_as_none(self):
        out = _decode_chart_tables({"5": {**TABLE, "note": NOTE}, "6": TABLE})
        assert out[5].note == NOTE
        assert out[6].note == "" and out[6].rows == TABLE["rows"]       # control: no note, same table

    def test_a_non_string_note_drops_the_entry_as_a_malformed_cell_does(self):
        assert _decode_chart_tables({"5": {**TABLE, "note": 3}, "6": {**TABLE, "note": None}}) == {}

    def test_a_note_over_its_cap_marks_the_table_too_large_never_truncated(self):
        long = "x" * (canvas_router._MAX_TABLE_NOTE_CHARS + 1)
        at_cap = "x" * canvas_router._MAX_TABLE_NOTE_CHARS
        out = _decode_chart_tables({"5": {**TABLE, "note": long}, "6": {**TABLE, "note": at_cap}})
        assert out[5] == ChartTable([], [], too_large=True)
        assert out[6].note == at_cap


class TestTheDocumentPrintsIt:
    def test_the_note_is_printed_under_the_table(self, db_session):
        p, canvas = _canvas_with_chart(db_session)
        doc = Document(export_canvas_docx(canvas, p.id, None, {5: ChartTable(TABLE["headers"], TABLE["rows"], note=NOTE)}))
        assert [[c.text for c in r.cells] for r in doc.tables[0].rows] == [TABLE["headers"], *TABLE["rows"]]
        texts = _paragraphs(doc)
        assert texts.index(NOTE) > texts.index("Pay by Gender")         # after the chart's title

    def test_no_note_adds_no_paragraph(self, db_session):
        p, canvas = _canvas_with_chart(db_session)
        bare = _paragraphs(Document(export_canvas_docx(canvas, p.id, None, {5: ChartTable(TABLE["headers"], TABLE["rows"])})))
        assert NOTE not in bare and "" not in bare[-1:]                 # control

    def test_a_captured_image_carries_its_own_note(self, db_session):
        """The PNG is the rendered figure, which prints the note beneath itself."""
        p, canvas = _canvas_with_chart(db_session)
        doc = Document(export_canvas_docx(canvas, p.id, {5: _PNG}, {5: ChartTable(TABLE["headers"], TABLE["rows"], note=NOTE)}))
        assert len(doc.inline_shapes) == 1 and NOTE not in _paragraphs(doc)


def test_the_posted_note_reaches_the_document(client):  # noqa: F811
    """The pipeline's MOUTH: a `chart_tables` entry's `note` reaches the Word file."""
    headers = {"X-CSRF-Token": client.get("/api/auth/status").json()["user"]["csrf_token"]}
    pid = client.post("/api/projects", json={"name": "P"}, headers=headers).json()["id"]
    db = SessionLocal()
    try:
        c = create_canvas(db, pid, "C")
        t = create_theme(db, c.id, "Findings")
        t.content = json.dumps({"type": "doc", "content": [
            {"type": "chart-embed", "attrs": {"materialId": 5, "title": "Score by group", "config": "{}"}},
        ]})
        db.commit()
        cid = c.id
    finally:
        db.close()
    body = {"chart_tables": {"5": {**TABLE, "note": NOTE}}}
    resp = client.post(f"/api/projects/{pid}/canvases/{cid}/export-docx", json=body, headers=headers)
    assert resp.status_code == 200, resp.text
    assert NOTE in _paragraphs(Document(io.BytesIO(resp.content)))
