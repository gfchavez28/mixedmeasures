import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import base64
import json
import struct
import zlib

import io

import pytest
from docx import Document
from sqlalchemy import text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.metric import ComputedResult, MetricDefinition
from app.models.project import Project
from app.services.canvas import create_canvas, create_theme, get_canvas_full
from app.services.canvas_export import ChartTable, DisplayAppendix, DisplayTable, export_canvas_docx
from app.routers import canvas as canvas_router
from app.routers.canvas import _decode_chart_images, _decode_chart_tables, _decode_display_tables


def _make_png(w: int = 8, h: int = 8) -> bytes:
    """Build a minimal valid 8-bit RGB PNG (solid red) without external deps."""
    def chunk(typ: bytes, data: bytes) -> bytes:
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit, color type 2 (RGB)
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))  # filter byte + red pixels
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


_PNG = _make_png()


def _canvas_with_chart(db):
    p = Project(name="P", user_id=1)
    db.add(p)
    db.flush()
    c = create_canvas(db, p.id, "C")
    t = create_theme(db, c.id, "Findings")
    t.content = json.dumps({
        "type": "doc",
        "content": [
            {"type": "chart-embed", "attrs": {"materialId": 5, "title": "Pay by Gender", "config": "{}"}},
        ],
    })
    db.flush()
    return p, get_canvas_full(db, p.id, c.id)


# ── #370: chart-embed → image vs. table fallback ─────────────────────────────


def test_export_docx_embeds_chart_image_when_png_provided(db_session):
    p, canvas = _canvas_with_chart(db_session)
    buf = export_canvas_docx(canvas, p.id, {5: _PNG})
    doc = Document(buf)
    # The chart embeds as an inline image rather than a table / "unavailable" text.
    assert len(doc.inline_shapes) == 1
    text = "\n".join(par.text for par in doc.paragraphs)
    assert "Chart data unavailable" not in text


def test_export_docx_falls_back_to_table_text_without_png(db_session):
    p, canvas = _canvas_with_chart(db_session)
    buf = export_canvas_docx(canvas, p.id, None)
    doc = Document(buf)
    assert len(doc.inline_shapes) == 0
    text = "\n".join(par.text for par in doc.paragraphs)
    # Neither an image nor a client table was sent, so it says the data is unavailable.
    assert "Chart data unavailable" in text


def test_export_docx_corrupt_png_falls_back_not_500(db_session):
    p, canvas = _canvas_with_chart(db_session)
    # Passes the magic check at the router but add_picture will reject it.
    buf = export_canvas_docx(canvas, p.id, {5: b"\x89PNG\r\n\x1a\n garbage"})
    doc = Document(buf)
    assert len(doc.inline_shapes) == 0  # embed failed → fell through to table fallback


# ── #1406 D5: the table is the CLIENT's ──────────────────────────────────────

#: A grouped mean as `canvas-export.ts` tabulates it (D7's long table): an
#: undefined group prints `—` with its reason, a real zero prints `0`.
_GROUPED = ChartTable(
    headers=["Metric", "Group", "Value", "N"],
    rows=[
        ["score", "A", "3", "3"],
        ["score", "B", "6", "3"],
        ["score", "C", "— Not computable for this data", "0"],
        ["score", "D", "0", "3"],
    ],
)


def _table_cells(doc) -> list[list[str]]:
    assert len(doc.tables) == 1, len(doc.tables)
    return [[c.text for c in row.cells] for row in doc.tables[0].rows]


def test_export_docx_renders_the_clients_table_without_png(db_session):
    p, canvas = _canvas_with_chart(db_session)
    doc = Document(export_canvas_docx(canvas, p.id, None, {5: _GROUPED}))
    assert _table_cells(doc) == [_GROUPED.headers, *_GROUPED.rows]
    assert all(r.bold for r in doc.tables[0].rows[0].cells[0].paragraphs[0].runs)
    assert not any(r.bold for r in doc.tables[0].rows[1].cells[0].paragraphs[0].runs)
    assert "Chart data unavailable" not in "\n".join(par.text for par in doc.paragraphs)


def test_export_docx_image_wins_over_the_table_and_a_failed_image_falls_back_to_it(db_session):
    p, canvas = _canvas_with_chart(db_session)
    doc = Document(export_canvas_docx(canvas, p.id, {5: _PNG}, {5: _GROUPED}))
    assert len(doc.inline_shapes) == 1 and len(doc.tables) == 0
    doc = Document(export_canvas_docx(canvas, p.id, {5: b"\x89PNG\r\n\x1a\n garbage"}, {5: _GROUPED}))
    assert len(doc.inline_shapes) == 0
    assert _table_cells(doc)[1] == ["score", "A", "3", "3"]


def test_export_docx_derives_no_table_of_its_own(db_session):
    """🔴 #1406 — the deleted `_get_chart_table_data` matched a metric by column
    and type and read its ungrouped result, which on a grouped metric is the
    MISSING-GROUP bucket: EXECUTED at 3d1d7380, `Mean: score | 100.0 | 1` under
    every grouped embed. With no client table, the server now derives none."""
    p, canvas = _canvas_with_chart(db_session)
    theme = canvas.themes[0]
    theme.content = json.dumps({"type": "doc", "content": [{"type": "chart-embed", "attrs": {
        "materialId": 5, "title": "Mean by group",
        "config": json.dumps({"column_ids": [3], "metric_type": "mean", "grouping_column_id": 2}),
    }}]})
    m = MetricDefinition(project_id=p.id, name="Mean: score", metric_type="mean", config="{}",
                         input_source_type="dataset_column", input_source_id=3)
    db_session.add(m)
    db_session.flush()
    for gv, mean, n in [(None, 100.0, 1), ("A", 3.0, 3), ("B", 6.0, 3)]:
        db_session.add(ComputedResult(metric_definition_id=m.id, group_value=gv,
                                      result_data=json.dumps({"mean": mean}), valid_n=n, total_n=n))
    db_session.flush()
    doc = Document(export_canvas_docx(canvas, p.id, None, None))
    assert len(doc.tables) == 0
    body = "\n".join(par.text for par in doc.paragraphs)
    assert "Chart data unavailable" in body
    assert "100.0" not in body


def test_export_docx_says_a_refused_table_was_too_large(db_session):
    p, canvas = _canvas_with_chart(db_session)
    doc = Document(export_canvas_docx(canvas, p.id, None, {5: ChartTable([], [], too_large=True)}))
    assert len(doc.tables) == 0
    body = "\n".join(par.text for par in doc.paragraphs)
    assert "Table too large for the Word export" in body
    assert "Chart data unavailable" not in body


# ── #1406 D5: the router's table guard ───────────────────────────────────────


def test_decode_chart_tables_keeps_a_valid_table_and_pads_a_short_row():
    out = _decode_chart_tables({"5": {"headers": ["A", "B", "C"], "rows": [["1", "2", "3"], ["x"]]}})
    assert out == {5: ChartTable(headers=["A", "B", "C"], rows=[["1", "2", "3"], ["x", "", ""]])}


def test_decode_chart_tables_drops_malformed_input():
    out = _decode_chart_tables({
        "notint": {"headers": ["A"], "rows": []},          # non-integer key
        "1": "a table",                                    # not an object
        "2": {"headers": [], "rows": []},                  # no columns
        "3": {"headers": ["A"], "rows": [["1", "2"]]},     # a value with no column
        "4": {"headers": ["A"], "rows": [[1]]},            # a non-string cell
        "6": {"headers": ["A", 2], "rows": []},            # a non-string header
        "7": {"headers": ["A"]},                           # no rows key
    })
    assert out == {}


def test_decode_chart_tables_marks_an_oversize_table_never_truncates_it():
    tall = {"headers": ["A"], "rows": [["x"]] * (canvas_router._MAX_TABLE_ROWS + 1)}
    wide = {"headers": ["h"] * (canvas_router._MAX_TABLE_COLS + 1), "rows": []}
    long_cell = {"headers": ["A"], "rows": [["x" * (canvas_router._MAX_TABLE_CELL_CHARS + 1)]]}
    out = _decode_chart_tables({"1": tall, "2": wide, "3": long_cell})
    assert out == {k: ChartTable([], [], too_large=True) for k in (1, 2, 3)}


def test_decode_chart_tables_bounds_the_total_across_tables():
    cols = 10  # each table, header row included, is exactly half the total budget
    rows = canvas_router._MAX_TABLE_TOTAL_CELLS // 2 // cols - 1
    assert rows <= canvas_router._MAX_TABLE_ROWS  # the per-table limit is not what decides
    half = {"headers": ["h"] * cols, "rows": [["1"] * cols] * rows}
    out = _decode_chart_tables({"1": half, "2": half, "3": half})
    assert not out[1].too_large and not out[2].too_large  # exactly AT the total fits
    assert out[3].too_large


# ── #1406 D5: the endpoint passes the client's tables through ────────────────


@pytest.fixture()
def client():
    Base.metadata.create_all(bind=engine)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    db = SessionLocal()
    try:
        for table in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()
    finally:
        db.close()


def test_export_docx_endpoint_renders_the_posted_chart_table(client):
    """The pipeline's MOUTH: a `chart_tables` body reaches the document."""
    headers = {"X-CSRF-Token": client.get("/api/auth/status").json()["user"]["csrf_token"]}
    pid = client.post("/api/projects", json={"name": "P"}, headers=headers).json()["id"]
    db = SessionLocal()
    try:
        c = create_canvas(db, pid, "C")
        t = create_theme(db, c.id, "Findings")
        t.content = json.dumps({"type": "doc", "content": [
            {"type": "chart-embed", "attrs": {"materialId": 5, "title": "Mean by group", "config": "{}"}},
        ]})
        db.commit()
        cid = c.id
    finally:
        db.close()
    body = {"chart_tables": {"5": {"headers": _GROUPED.headers, "rows": _GROUPED.rows}}}
    resp = client.post(f"/api/projects/{pid}/canvases/{cid}/export-docx", json=body, headers=headers)
    assert resp.status_code == 200, resp.text
    assert _table_cells(Document(io.BytesIO(resp.content))) == [_GROUPED.headers, *_GROUPED.rows]


# ── Joint display (ROADMAP row 56, D174): the report table is the CLIENT's ────


def _canvas_with_display(db, key="k-1"):
    p = Project(name="P", user_id=1)
    db.add(p)
    db.flush()
    c = create_canvas(db, p.id, "C")
    t = create_theme(db, c.id, "Findings")
    t.content = json.dumps({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Before"}]},
        {"type": "joint-display", "attrs": {"displayKey": key, "figureEpoch": 3, "display": {"title": "T", "rows": []}}},
        {"type": "paragraph", "content": [{"type": "text", "text": "After"}]},
    ]})
    db.flush()
    return p, get_canvas_full(db, p.id, c.id)


#: The report `lib/joint-display-report.ts` builds: a construct row, then a different-unit
#: result BESIDE it (one cell, merged across), then its own table in the appendix.
_REPORT = DisplayTable(
    title="Side-by-side joint display by construct: T",
    headers=["Construct", "High (2 participants)", "Low (2 participants)", "High − Low", "Fit", "Meta-inference (type)"],
    rows=[
        ["Training", "Coded: Adequacy 2 of 2.", "Coded: Adequacy 0 of 2.", "Adequacy: +100 pp.", "Confirmation", "Not written."],
        ["Beside “Training”: Post-test by School, a saved comparison (rows of Scores, by School)."],
    ],
    span_rows=frozenset({1}),
    note="Groups: the participants with each value of Gain. Numbers as computed on 12 Nov 2026.",
    appendix=[DisplayAppendix(title="Post-test by School", headers=["Group", "n"], rows=[["A", "5"]], note="Welch t")],
)


def _body(doc) -> str:
    return "\n".join(par.text for par in doc.paragraphs)


def test_export_docx_renders_a_joint_display_report(db_session):
    p, canvas = _canvas_with_display(db_session)
    doc = Document(export_canvas_docx(canvas, p.id, None, None, {"k-1": _REPORT}))
    assert len(doc.tables) == 2  # the display, then the beside result's own table
    grid = [[c.text for c in row.cells] for row in doc.tables[0].rows]
    assert grid[0] == _REPORT.headers and grid[1] == _REPORT.rows[0]
    # The beside row is ONE cell spanning the table (python-docx repeats a merged cell per column).
    assert len(doc.tables[0].rows[2]._tr.tc_lst) == 1
    assert grid[2] == [_REPORT.rows[1][0]] * len(_REPORT.headers)
    assert all(r.bold for r in doc.tables[0].rows[0].cells[0].paragraphs[0].runs)
    body = _body(doc)
    assert _REPORT.title in body and _REPORT.note in body  # the note reaches Word (D176's build note)
    assert "Post-test by School" in body and "Welch t" in body
    assert [[c.text for c in row.cells] for row in doc.tables[1].rows] == [["Group", "n"], ["A", "5"]]
    # In its place in the theme, between the prose around it.
    assert body.index("Before") < body.index(_REPORT.title) < body.index("After")


def test_export_docx_never_renders_a_display_as_nothing(db_session):
    """Before session C the node had no arm: the walker found no children and the display
    vanished from the Word file without a word."""
    p, canvas = _canvas_with_display(db_session)
    doc = Document(export_canvas_docx(canvas, p.id, None, None, None))
    assert len(doc.tables) == 0
    assert "Joint display not available in this export." in _body(doc)
    doc = Document(export_canvas_docx(canvas, p.id, None, None, {"another-key": _REPORT}))
    assert "Joint display not available in this export." in _body(doc)


def test_export_docx_prints_a_displays_message_or_its_size_refusal(db_session):
    p, canvas = _canvas_with_display(db_session)
    msg = DisplayTable(title="Side-by-side joint display by construct", message="This display has no grouping variable yet.")
    doc = Document(export_canvas_docx(canvas, p.id, None, None, {"k-1": msg}))
    assert len(doc.tables) == 0
    assert msg.title in _body(doc) and msg.message in _body(doc)
    big = DisplayTable(title="Side-by-side joint display by construct: T", too_large=True)
    doc = Document(export_canvas_docx(canvas, p.id, None, None, {"k-1": big}))
    assert len(doc.tables) == 0 and "Table too large for the Word export" in _body(doc)


def _wire(over=None, **kw):
    t = {
        "title": _REPORT.title, "message": None, "headers": _REPORT.headers,
        "rows": _REPORT.rows, "span_rows": [1], "note": _REPORT.note,
        "appendix": [{"title": "Post-test by School", "headers": ["Group", "n"], "rows": [["A", "5"]], "note": "Welch t"}],
    }
    t.update(over or {})
    t.update(kw)
    return t


def test_decode_display_tables_keeps_a_valid_report_and_pads_a_short_row():
    out = _decode_display_tables({"k-1": _wire()}, 0)
    assert out == {"k-1": _REPORT}
    short = _decode_display_tables({"k": _wire(rows=[["Training", "x"]], span_rows=[])}, 0)
    assert short["k"].rows == [["Training", "x", "", "", "", ""]]
    msg = _decode_display_tables({"k": {"title": "T", "message": "No grouping variable."}}, 0)
    assert msg == {"k": DisplayTable(title="T", message="No grouping variable.")}


def test_decode_display_tables_drops_malformed_input():
    out = _decode_display_tables({
        "": _wire(),                                             # no key
        "x" * 65: _wire(),                                       # a key no displayKey has
        "a": "a report",                                         # not an object
        "b": _wire(title=None),                                  # no title
        "c": _wire(headers=[]),                                  # no columns
        "d": _wire(rows=[["1"] * 7], span_rows=[]),              # a value with no column
        "e": _wire(span_rows=[0]),                               # a span over a row of six cells
        "f": _wire(span_rows=[5]),                               # a span over a row that is not there
        "g": _wire(span_rows=[True]),                            # a bool is not a row index
        "h": _wire(rows=[[1, 2, 3, 4, 5, 6]], span_rows=[]),     # a non-string cell
        "i": _wire(appendix=[{"title": "x", "headers": [], "rows": []}]),  # an appendix with no columns
        "j": _wire(note=None),                                   # a note that is not text
    }, 0)
    assert out == {}


def test_decode_display_tables_marks_an_oversize_report_never_truncates_it():
    long_cell = _wire(rows=[["Training", "x" * (canvas_router._MAX_DISPLAY_CELL_CHARS + 1), "", "", "", ""]], span_rows=[])
    long_note = _wire(note="n" * (canvas_router._MAX_DISPLAY_NOTE_CHARS + 1))
    tall = _wire(rows=[["c", "", "", "", "", ""]] * (canvas_router._MAX_TABLE_ROWS + 1), span_rows=[])
    out = _decode_display_tables({"1": long_cell, "2": long_note, "3": tall}, 0)
    assert {k: v.too_large for k, v in out.items()} == {"1": True, "2": True, "3": True}
    assert all(v.title for v in out.values()) and not any(v.rows for v in out.values())
    # A meta-inference longer than a chart cell may be is still printed (the display's own limit).
    ok = _decode_display_tables({"k": _wire(rows=[["c", "x" * 5000, "", "", "", ""]], span_rows=[])}, 0)
    assert not ok["k"].too_large


def test_decode_display_tables_shares_the_documents_cell_total_with_the_charts():
    cells = len(_REPORT.headers) * (len(_REPORT.rows) + 1) + 2 * 2  # the display + its appendix
    assert not _decode_display_tables({"k": _wire()}, canvas_router._MAX_TABLE_TOTAL_CELLS - cells)["k"].too_large
    assert _decode_display_tables({"k": _wire()}, canvas_router._MAX_TABLE_TOTAL_CELLS - cells + 1)["k"].too_large


def test_export_docx_endpoint_renders_the_posted_display_table(client):
    """The pipeline's MOUTH: a `display_tables` body reaches the document."""
    headers = {"X-CSRF-Token": client.get("/api/auth/status").json()["user"]["csrf_token"]}
    pid = client.post("/api/projects", json={"name": "P"}, headers=headers).json()["id"]
    db = SessionLocal()
    try:
        c = create_canvas(db, pid, "C")
        t = create_theme(db, c.id, "Findings")
        t.content = json.dumps({"type": "doc", "content": [
            {"type": "joint-display", "attrs": {"displayKey": "k-1", "display": {"rows": []}}},
        ]})
        db.commit()
        cid = c.id
    finally:
        db.close()
    resp = client.post(f"/api/projects/{pid}/canvases/{cid}/export-docx",
                       json={"display_tables": {"k-1": _wire()}}, headers=headers)
    assert resp.status_code == 200, resp.text
    doc = Document(io.BytesIO(resp.content))
    assert [c.text for c in doc.tables[0].rows[1].cells] == _REPORT.rows[0]
    assert _REPORT.note in _body(doc)


# ── #370: base64/PNG validation guard (router helper) ────────────────────────


def test_decode_chart_images_accepts_valid_and_data_url():
    good = base64.b64encode(_PNG).decode()
    out = _decode_chart_images({
        "5": good,
        "7": "data:image/png;base64," + good,
    })
    assert set(out.keys()) == {5, 7}
    assert out[5] == _PNG


def test_decode_chart_images_rejects_bad_input():
    good = base64.b64encode(_PNG).decode()
    out = _decode_chart_images({
        "1": "!!!not-base64!!!",                              # not decodable
        "2": base64.b64encode(b"GIF89a not a png").decode(),  # wrong magic
        "notint": good,                                       # non-integer key
        "": good,                                             # empty key
        "3": "",                                              # empty value
    })
    assert out == {}
