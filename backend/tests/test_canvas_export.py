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
from app.services.canvas_export import ChartTable, export_canvas_docx
from app.routers import canvas as canvas_router
from app.routers.canvas import _decode_chart_images, _decode_chart_tables


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
