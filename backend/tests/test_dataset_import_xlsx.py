"""#523 — .xlsx dataset import adapter.

The adapter converts a worksheet to CSV text at the router boundary so the
entire existing CSV pipeline (type inference, N/A handling, import) runs
unchanged. These tests pin the CSV-parity contract: an .xlsx and its CSV twin
must produce identical previews.
"""
import asyncio
import io
from datetime import datetime

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile as StarletteUploadFile

from openpyxl import Workbook

from app.models.project import Project
from app.models.user import User
from app.routers.dataset import preview_dataset
from app.services.dataset_import import (
    MAX_XLSX_COLS,
    XlsxImportError,
    is_xlsx_upload,
    preview_dataset_csv,
    xlsx_to_csv_text,
)


def _xlsx_bytes(rows: list[list], sheet_title: str = "Sheet1", extra_sheets: list[str] | None = None) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_title
    for row in rows:
        ws.append(row)
    for name in extra_sheets or []:
        wb.create_sheet(name)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_preview_matches_csv_twin():
    # Multi-digit values on purpose (the value-ordering fixture rule).
    rows = [
        ["Respondent", "Score", "Comment"],
        ["R1", 12, "strong start"],
        ["R2", 7, "uneven"],
        ["R3", 104, "N/A"],
    ]
    csv_twin = "Respondent,Score,Comment\nR1,12,strong start\nR2,7,uneven\nR3,104,N/A\n"

    text, sheets = xlsx_to_csv_text(_xlsx_bytes(rows))
    assert sheets == ["Sheet1"]

    from_xlsx = preview_dataset_csv(text)
    from_csv = preview_dataset_csv(csv_twin)
    assert from_xlsx["total_rows"] == from_csv["total_rows"] == 3
    for a, b in zip(from_xlsx["columns"], from_csv["columns"]):
        assert a["column_name"] == b["column_name"]
        assert a["suggested_type"] == b["suggested_type"]
        assert a["na_count"] == b["na_count"]
        assert a["sample_values"] == b["sample_values"]


def test_cell_stringification_matches_excel_csv_conventions():
    rows = [
        ["A", "B", "C", "D", "E"],
        [3.0, 2.5, True, None, datetime(2026, 3, 1)],
        [7, -1.0, False, "x", datetime(2026, 3, 1, 14, 30, 5)],
    ]
    text, _ = xlsx_to_csv_text(_xlsx_bytes(rows))
    lines = text.splitlines()
    # 3.0 -> "3" (typed-integer trim), bools -> TRUE/FALSE, None -> "",
    # midnight datetime -> bare date, timed datetime -> date + time.
    assert lines[1] == "3,2.5,TRUE,,2026-03-01"
    assert lines[2] == "7,-1,FALSE,x,2026-03-01 14:30:05"


def test_sheet_selection_and_unknown_sheet():
    blob = _xlsx_bytes([["H"], ["v"]], sheet_title="Data", extra_sheets=["Notes"])
    _, sheets = xlsx_to_csv_text(blob)
    assert sheets == ["Data", "Notes"]
    with pytest.raises(XlsxImportError, match="was not found"):
        xlsx_to_csv_text(blob, sheet_name="Nope")
    with pytest.raises(XlsxImportError, match="has no data"):
        xlsx_to_csv_text(blob, sheet_name="Notes")  # empty sheet


def test_phantom_trailing_rows_and_columns_trimmed():
    rows = [
        ["Name", "Score", None, None],   # phantom trailing header cells
        ["A", 1, None, None],
        [None, None, None, None],        # phantom trailing row
    ]
    text, _ = xlsx_to_csv_text(_xlsx_bytes(rows))
    assert text.splitlines() == ["Name,Score", "A,1"]


def test_row_and_column_caps(monkeypatch):
    import app.services.dataset_import as di
    monkeypatch.setattr(di, "MAX_XLSX_ROWS", 2)
    with pytest.raises(XlsxImportError, match="more than 2"):
        xlsx_to_csv_text(_xlsx_bytes([["H"], ["a"], ["b"]]))
    wide = [[f"c{i}" for i in range(MAX_XLSX_COLS + 1)]]
    with pytest.raises(XlsxImportError, match="columns"):
        xlsx_to_csv_text(_xlsx_bytes(wide))


def test_is_xlsx_upload_requires_extension_and_magic():
    zippy = _xlsx_bytes([["H"], ["v"]])
    assert is_xlsx_upload("data.xlsx", zippy)
    assert is_xlsx_upload("DATA.XLSX", zippy)
    assert not is_xlsx_upload("data.csv", zippy)              # renamed → text path
    assert not is_xlsx_upload("data.xlsx", b"Name,Score\n")   # masquerading CSV
    assert not is_xlsx_upload(None, zippy)


def test_preview_endpoint_accepts_xlsx_and_reports_sheets(db_session):
    db = db_session
    db.add(Project(id=980, name="XLSX", user_id=1))
    db.flush()
    user = db.get(User, 1)

    blob = _xlsx_bytes([["Q1", "Q2"], [12, "yes"], [40, "no"]], sheet_title="Wave1", extra_sheets=["Wave2"])
    upload = StarletteUploadFile(filename="survey.xlsx", file=io.BytesIO(blob))

    resp = asyncio.run(preview_dataset(
        project_id=980, file=upload, encoding="utf-8", sheet_name=None, user=user, db=db,
    ))
    assert resp.sheet_names == ["Wave1", "Wave2"]
    assert resp.total_rows == 2
    assert [c.column_name for c in resp.columns] == ["Q1", "Q2"]

    # A masqueraded non-zip .xlsx falls through to text decode (parses as CSV or 400s,
    # never reaches openpyxl); a corrupt zip surfaces a clean 400.
    bad = StarletteUploadFile(filename="broken.xlsx", file=io.BytesIO(b"PK\x03\x04garbage"))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(preview_dataset(
            project_id=980, file=bad, encoding="utf-8", sheet_name=None, user=user, db=db,
        ))
    assert exc.value.status_code == 400
