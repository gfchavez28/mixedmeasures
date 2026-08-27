"""#523 — .xlsx dataset import adapter.

The adapter converts a worksheet to CSV text at the router boundary so the
entire existing CSV pipeline (type inference, N/A handling, import) runs
unchanged. These tests pin the CSV-parity contract: an .xlsx and its CSV twin
must produce identical previews.
"""
import asyncio
import io
import time
from sqlalchemy import text as _sa_text
from app.routers import dataset as dataset_router
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


def test_preview_inference_runs_off_the_event_loop(db_session, monkeypatch):
    """#796: `preview_dataset_csv` must not block the event loop.

    MEASURED on the file that produced the report (75,700 x 41): the inference
    pass alone is **9.8 seconds** of pure Python. Called inline in an `async def`
    endpoint it froze the entire backend for that long — `/health` included,
    which is the Electron probe the media path threadpools to protect. Its two
    neighbours inside `_upload_to_csv_text` were already threadpooled; this call
    was the one that was not.

    Behavioural, not structural: a heartbeat coroutine runs concurrently and must
    tick WHILE the (stubbed-slow) inference is running. A source scan asserting
    `run_in_threadpool` appears would pass on a call that had been moved back
    inline somewhere else in the function.
    """
    db = db_session
    db.add(Project(id=981, name="Threadpool", user_id=1))
    db.flush()
    user = db.get(User, 1)

    real_preview = dataset_router.preview_dataset_csv

    def slow_preview(*args, **kwargs):
        time.sleep(0.30)          # stands in for the measured 9.8s
        return real_preview(*args, **kwargs)

    monkeypatch.setattr(dataset_router, "preview_dataset_csv", slow_preview)

    blob = _xlsx_bytes([["Q1", "Q2"], [12, "yes"], [40, "no"]])
    upload = StarletteUploadFile(filename="survey.xlsx", file=io.BytesIO(blob))

    ticks = 0

    async def heartbeat():
        nonlocal ticks
        # ~30 chances to tick inside the 0.30s stub. If the inference blocks the
        # loop, this coroutine cannot run at all and `ticks` stays 0.
        for _ in range(30):
            await asyncio.sleep(0.01)
            ticks += 1

    async def drive():
        beat = asyncio.create_task(heartbeat())
        resp = await preview_dataset(
            project_id=981, file=upload, encoding="utf-8",
            sheet_name=None, user=user, db=db,
        )
        beat.cancel()
        return resp

    resp = asyncio.run(drive())

    assert [c.column_name for c in resp.columns] == ["Q1", "Q2"]
    # The assertion that bites: revert the `run_in_threadpool` and this is 0.
    assert ticks > 5, (
        f"event loop was blocked during preview inference (only {ticks} ticks) — "
        "preview_dataset_csv is being called inline again"
    )


def test_import_batches_row_flushes_and_inserts_values_without_orm_instances(db_session):
    """#796b: the write path is batched, and stays batched.

    It used to `db.flush()` once per row and `db.add()` an ORM instance per cell.
    MEASURED on a real GSS extract (75,699 x 41 = 3,103,659 values): **374.8s**,
    six minutes for one file and past any timeout a client can offer. Batching
    took it to **76.4s (4.9x)**.

    Timing is machine-dependent, so this pins the two MECHANISMS instead.

    ⚠️ **An earlier version of this test passed against both mutants** — it
    counted `before_flush` events (SQLAlchemy skips the event entirely when a
    flush has nothing pending, so redundant flushes are invisible) and checked
    `session.new` after the function returned (by then everything has been
    flushed to persistent, so the set is always empty). Both assertions were
    vacuous. These two are checked WHILE the import runs.
    """
    from sqlalchemy import event
    from app.models.dataset import Dataset, DatasetRow, DatasetValue
    from app.services.dataset_import import import_dataset_csv

    db = db_session
    db.add(Project(id=982, name="Batch", user_id=1))
    db.flush()

    # ⚠️ MUST cross ROW_BATCH (2000). At 500 the whole import is ONE batch, so a
    # broken batch counter — every batch restarting its record numbering at
    # R0000001 — is invisible. #799 introduced exactly that bug and this fixture
    # did not catch it until the row count crossed the boundary.
    ROWS = 4_500
    COLS = 4
    header = "a,b,c,d"
    body = "\n".join(f"{i},{i+1},{i+2},{i+3}" for i in range(ROWS))
    csv_text = f"{header}\n{body}\n"
    cfgs = [
        {"column_index": i, "column_type": "numeric", "column_text": n, "skip": False}
        for i, n in enumerate(["a", "b", "c", "d"])
    ]

    value_inserts = 0
    flushes_with_work = 0
    orm_values_seen_at_flush = 0

    def _count_stmt(conn, cursor, statement, params, context, executemany):
        nonlocal value_inserts
        if "INSERT INTO dataset_values" in statement:
            value_inserts += 1

    def _inspect_flush(session, ctx, instances):
        # Sampled DURING the import, which is the only time session.new is
        # populated. A Core executemany never puts a DatasetValue here.
        # NOTE SQLAlchemy skips this event entirely when a flush has nothing
        # pending, so the count is "flushes that did work" — which is exactly
        # the metric that separates one-per-row from one-per-batch.
        nonlocal flushes_with_work, orm_values_seen_at_flush
        flushes_with_work += 1
        orm_values_seen_at_flush += sum(
            1 for o in session.new if isinstance(o, DatasetValue)
        )

    event.listen(db.get_bind(), "after_cursor_execute", _count_stmt)
    event.listen(db, "before_flush", _inspect_flush)
    try:
        result = import_dataset_csv(db, 982, "Batched", cfgs, csv_text)
    finally:
        event.remove(db.get_bind(), "after_cursor_execute", _count_stmt)
        event.remove(db, "before_flush", _inspect_flush)

    assert result["rows_created"] == ROWS
    assert result["values_created"] == ROWS * COLS

    # Mechanism 1 — one flush per ROW BATCH, not per row. ROWS=500 fits a single
    # ROW_BATCH (2000), so the whole import costs a handful of real flushes; the
    # per-row version cost 500+. This is the round-trip count that dominated the
    # 374.8s measurement.
    assert flushes_with_work < 20, (
        f"{flushes_with_work} flushes did work for {ROWS} rows — the row flush "
        "is no longer batched"
    )

    # Mechanism 2 — values go in via ONE Core executemany, and no DatasetValue
    # ORM instance is ever constructed. Both halves matter: the ORM path would
    # emit an INSERT per value AND materialise 3.1M objects.
    assert value_inserts <= 2, (
        f"{value_inserts} INSERT statements for {ROWS * COLS} values — the Core "
        "executemany was bypassed"
    )
    assert orm_values_seen_at_flush == 0, (
        f"{orm_values_seen_at_flush} DatasetValue ORM instances reached a flush "
        "— the Core insert was bypassed"
    )

    # Correctness is not negotiable for a speed change.
    ds = db.query(Dataset).filter(Dataset.name == "Batched").one()
    rows = db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id).order_by(DatasetRow.id).all()
    pad = len(str(ROWS)) + 2
    assert [r.row_identifier for r in rows[:2]] == [f"R{'1'.zfill(pad)}", f"R{'2'.zfill(pad)}"]
    assert rows[-1].row_identifier == f"R{str(ROWS).zfill(pad)}"
    # The identifiers must be UNIQUE and contiguous ACROSS batch boundaries.
    idents = [r.row_identifier for r in rows]
    assert len(set(idents)) == ROWS, "duplicate record identifiers across batches"
    assert idents == [f"R{str(i + 1).zfill(pad)}" for i in range(ROWS)]
    assert all(r.uuid for r in rows), "DatasetRow.uuid default must survive batching"
    assert db.query(DatasetValue).join(DatasetRow).filter(
        DatasetRow.dataset_id == ds.id
    ).count() == ROWS * COLS


def test_dataset_data_endpoint_is_paginated(db_session):
    """#800: the grid endpoint returns ONE PAGE, and the totals are the dataset's.

    It used to return every row with every value. MEASURED on a 75,699 x 41
    import: **90.1s, 226.1 MB of JSON, ~5,877 MB peak RSS** against a 30s client
    timeout — the dataset imported fine and then could not be opened at all. The
    same request paginated: **0.24s, 0.60 MB, 96 MB**.

    Pins the four things that make paging usable rather than merely present:
    a bounded page, dataset-wide totals, non-overlapping contiguous pages, and
    a DATASET-scoped already-linked map.
    """
    from app.routers.dataset import get_dataset_data, DATASET_PAGE_SIZE
    from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
    from app.models.participant import Participant

    db = db_session
    db.add(Project(id=983, name="Paging", user_id=1))
    db.flush()
    user = db.get(User, 1)
    ds = Dataset(project_id=983, name="Paged"); db.add(ds); db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_text="Q1", column_type=ColumnType.NUMERIC,
                        sequence_order=0, display_order=0)
    db.add(col); db.flush()

    N = 25
    rows = [DatasetRow(dataset_id=ds.id, row_identifier=f"R{i+1:04d}") for i in range(N)]
    db.add_all(rows); db.flush()
    for i, r in enumerate(rows):
        db.add(DatasetValue(row_id=r.id, column_id=col.id, value_text=str(i), value_numeric=float(i)))
    # ⚠️ MORE linked participants than the page limit, or this fixture cannot
    # measure the thing it is here for: with a single linked row, a page-scoped
    # `.limit(10)` on the (already filtered) linked query still returns it, and
    # the assertion below passes against the very mutant it exists to catch.
    # 12 linked > limit 10, so a page-scoped map is provably short.
    LINKED = 12
    parts = [Participant(project_id=983, identifier=f"P{i:03d}") for i in range(LINKED)]
    db.add_all(parts); db.flush()
    for r, part in zip(rows, parts):
        r.participant_id = part.id
    db.flush()

    page1 = asyncio.run(get_dataset_data(
        project_id=983, dataset_id=ds.id, limit=10, offset=0, user=user, db=db))

    # The page is bounded...
    assert len(page1.rows) == 10
    # ...but every count the UI shows is the DATASET's.
    assert page1.total_rows == N
    assert page1.dataset.row_count == N, "row_count must be the dataset total, not the page"
    assert page1.offset == 0 and page1.limit == 10

    page2 = asyncio.run(get_dataset_data(
        project_id=983, dataset_id=ds.id, limit=10, offset=10, user=user, db=db))
    page3 = asyncio.run(get_dataset_data(
        project_id=983, dataset_id=ds.id, limit=10, offset=20, user=user, db=db))

    ids1 = [r.id for r in page1.rows]
    ids2 = [r.id for r in page2.rows]
    ids3 = [r.id for r in page3.rows]
    assert not (set(ids1) & set(ids2)), "pages must not overlap"
    assert len(ids3) == 5, "the last page is the remainder"
    assert ids1 + ids2 + ids3 == [r.id for r in rows], "pages must tile the dataset in order"

    # The eager-load still works per page: `joinedload` of a COLLECTION plus
    # `limit` is the trap where LIMIT counts JOINed rows instead of entities.
    assert all(len(r.values) == 1 for r in page1.rows)

    # 🔴 The already-linked map is DATASET-scoped. Page 1 holds 10 rows but 12
    # participants are linked — a page-scoped map would be 10 entries and the
    # picker would offer the other two, which
    # `uq_dataset_rows_dataset_participant` then refuses.
    assert len(page1.linked_participants) == LINKED, (
        f"linked_participants covered {len(page1.linked_participants)} of {LINKED} "
        "— it is page-scoped, not dataset-scoped"
    )
    for r, part in zip(rows, parts):
        assert page1.linked_participants[str(part.id)] == r.row_identifier

    # The default is a real bound, not "everything".
    assert 0 < DATASET_PAGE_SIZE <= 1000


def test_dataset_delete_does_not_load_children_into_the_session(db_session):
    """#802: deleting a dataset must not materialise its rows and values.

    MEASURED on a 75,699 x 41 dataset (3,103,659 values): the ORM
    `delete-orphan` cascade LOADS every child purely to delete it — abandoned at
    **664s and 2,770 MB RSS**, still running — while the DB-level cascade took
    **22.0s** at constant memory. `passive_deletes=True` is what hands the work
    to the database.

    Behavioural, not structural: count the DELETE statements and watch the
    session's identity map. A source scan for `passive_deletes` would pass on a
    relationship that had been re-added elsewhere.

    ⚠️ Also covers PROJECT delete, which cascades through the same relationships.
    """
    from sqlalchemy import event
    from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType

    db = db_session
    db.add(Project(id=984, name="Cascade", user_id=1))
    db.flush()
    ds = Dataset(project_id=984, name="Doomed"); db.add(ds); db.flush()
    cols = [DatasetColumn(dataset_id=ds.id, column_text=f"Q{i}", column_type=ColumnType.NUMERIC,
                          sequence_order=i, display_order=i) for i in range(4)]
    db.add_all(cols); db.flush()
    rows = [DatasetRow(dataset_id=ds.id, row_identifier=f"R{i:04d}") for i in range(50)]
    db.add_all(rows); db.flush()
    for r in rows:
        for c in cols:
            db.add(DatasetValue(row_id=r.id, column_id=c.id, value_text="1", value_numeric=1.0))
    db.commit()
    N_VALUES = 50 * 4
    ds_id = ds.id  # captured BEFORE expunging — a detached instance cannot be read

    # Clear the identity map so nothing is pre-loaded: the assertion below is
    # that the ORM never ASKS for the children, which a warm session would mask.
    db.expunge_all()
    ds = db.get(Dataset, ds_id)

    deletes = []
    def _stmt(conn, cursor, statement, params, context, executemany):
        s = statement.strip().upper()
        if s.startswith("DELETE FROM"):
            deletes.append(statement.split()[2])

    event.listen(db.get_bind(), "after_cursor_execute", _stmt)
    try:
        db.delete(ds)
        db.flush()
        loaded_values = sum(1 for o in db.identity_map.values() if isinstance(o, DatasetValue))
        loaded_rows = sum(1 for o in db.identity_map.values() if isinstance(o, DatasetRow))
        # Columns are BOUNDED (<=500 by the import cap), so this one is
        # consistency rather than necessity — but a relationship that is
        # passive in four places and not the fifth is the drift this asserts
        # against, and an un-asserted setting is one a refactor can quietly undo.
        loaded_cols = sum(1 for o in db.identity_map.values() if isinstance(o, DatasetColumn))
    finally:
        event.remove(db.get_bind(), "after_cursor_execute", _stmt)

    # The ORM must not have loaded the children to delete them.
    assert loaded_values == 0, f"{loaded_values} DatasetValue objects were loaded to be deleted"
    assert loaded_rows == 0, f"{loaded_rows} DatasetRow objects were loaded to be deleted"

    # ...and must not have emitted per-child DELETEs either.
    assert "dataset_values" not in deletes, (
        "the ORM emitted DELETEs for dataset_values — the DB cascade should own them"
    )
    assert "dataset_rows" not in deletes, "the ORM emitted DELETEs for dataset_rows"
    assert loaded_cols == 0, f"{loaded_cols} DatasetColumn objects were loaded to be deleted"
    assert "dataset_columns" not in deletes, "the ORM emitted DELETEs for dataset_columns"
    assert "datasets" in deletes, "the dataset row itself must still be deleted"

    db.commit()

    # The database really did the cascade — nothing orphaned.
    assert db.query(Dataset).filter(Dataset.id == ds_id).count() == 0
    assert db.query(DatasetRow).filter(DatasetRow.dataset_id == ds_id).count() == 0
    remaining = db.query(DatasetValue).join(
        DatasetColumn, DatasetValue.column_id == DatasetColumn.id
    ).filter(DatasetColumn.dataset_id == ds_id).count()
    assert remaining == 0, f"{remaining} of {N_VALUES} values survived the cascade"
    assert db.execute(_sa_text("PRAGMA foreign_key_check")).fetchall() == []


def test_row_and_column_deletes_also_hand_their_values_to_the_database(db_session):
    """#802, the arms the dataset-delete path CANNOT cover.

    ⚠️ Written because the dataset-delete test above passed against a mutant that
    removed `passive_deletes` from `DatasetRow.values`: with `Dataset.rows`
    passive the ORM never loads the rows, so it never walks to their values and
    the inner setting is invisible from that path. `DatasetRow.values` and
    `DatasetColumn.values` are load-bearing for the SINGLE-row and SINGLE-column
    delete endpoints, which is where a column of 75,699 values would otherwise
    be materialised one object at a time.
    """
    from sqlalchemy import event
    from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType

    db = db_session
    db.add(Project(id=985, name="Arms", user_id=1))
    db.flush()
    ds = Dataset(project_id=985, name="Arms"); db.add(ds); db.flush()
    cols = [DatasetColumn(dataset_id=ds.id, column_text=f"Q{i}", column_type=ColumnType.NUMERIC,
                          sequence_order=i, display_order=i) for i in range(3)]
    db.add_all(cols); db.flush()
    rows = [DatasetRow(dataset_id=ds.id, row_identifier=f"R{i:04d}") for i in range(20)]
    db.add_all(rows); db.flush()
    for r in rows:
        for c in cols:
            db.add(DatasetValue(row_id=r.id, column_id=c.id, value_text="1", value_numeric=1.0))
    db.commit()
    row_id, col_id = rows[0].id, cols[0].id

    def _delete_and_watch(obj_type, obj_id):
        db.expunge_all()
        obj = db.get(obj_type, obj_id)
        emitted = []
        def _stmt(conn, cursor, statement, params, context, executemany):
            if statement.strip().upper().startswith("DELETE FROM"):
                emitted.append(statement.split()[2])
        event.listen(db.get_bind(), "after_cursor_execute", _stmt)
        try:
            db.delete(obj)
            db.flush()
            loaded = sum(1 for o in db.identity_map.values() if isinstance(o, DatasetValue))
        finally:
            event.remove(db.get_bind(), "after_cursor_execute", _stmt)
        db.commit()
        return emitted, loaded

    emitted, loaded = _delete_and_watch(DatasetRow, row_id)
    assert loaded == 0, f"deleting one ROW loaded {loaded} DatasetValue objects"
    assert "dataset_values" not in emitted, "the ORM deleted a row's values itself"

    emitted, loaded = _delete_and_watch(DatasetColumn, col_id)
    assert loaded == 0, f"deleting one COLUMN loaded {loaded} DatasetValue objects"
    assert "dataset_values" not in emitted, "the ORM deleted a column's values itself"

    # The database really removed them.
    assert db.query(DatasetValue).filter(DatasetValue.row_id == row_id).count() == 0
    assert db.query(DatasetValue).filter(DatasetValue.column_id == col_id).count() == 0
    assert db.execute(_sa_text("PRAGMA foreign_key_check")).fetchall() == []


def test_cell_cap_refuses_every_format_at_the_same_size(db_session, monkeypatch):
    """#803: the size gate is CELLS, and all three formats share it.

    The caps this replaces were three different limits in three different units,
    none of them cells: 50 MB of bytes (which buys ~4x more data as compressed
    .xlsx than as CSV), and 100,000 rows x 500 columns — two individually
    defensible numbers that MULTIPLY to 50,000,000 cells, 16x the file that
    already exceeded every memory target here.

    Pins the four properties that make it a real gate: shared threshold, both
    enforcement layers, an early bail, and an honest message.
    """
    from app.services import dataset_import as di

    # A small cap so the fixtures stay fast; the real one is 4,000,000.
    monkeypatch.setattr(di, "MAX_DATASET_CELLS", 100)

    def csv_text(n_rows, n_cols):
        hdr = ",".join(f"Q{i}" for i in range(n_cols))
        body = "\n".join(",".join(str(r) for _ in range(n_cols)) for r in range(n_rows))
        return f"{hdr}\n{body}\n"

    # ── Under the cap: accepted ──────────────────────────────────────────────
    ok = di.preview_dataset_csv(csv_text(9, 10))          # 90 cells
    assert ok["total_rows"] == 9

    # ── Over the cap, CSV preview: refused ───────────────────────────────────
    with pytest.raises(ValueError) as exc:
        di.preview_dataset_csv(csv_text(50, 10))          # 500 cells
    msg = str(exc.value)
    assert "limit" in msg and "10 columns" in msg
    # ⚠️ The streaming path bails before it has counted, so it must NOT quote a
    # row total it does not know (the #797 rule: never a plausible-looking guess).
    assert "50 rows" not in msg

    # ── The same threshold on the IMPORT path ────────────────────────────────
    # A router guard is not a guard on the operation (#589): scripts and direct
    # API callers never pass the preview.
    db = db_session
    db.add(Project(id=986, name="Cap", user_id=1))
    db.flush()
    cfgs = [{"column_index": i, "column_type": "numeric", "column_text": f"Q{i}",
             "skip": False} for i in range(10)]
    # A SAVEPOINT, not a rollback: a bare `db.rollback()` here discards the
    # fixture's own rows (the project above, and the user) and every assertion
    # after it fails for an unrelated reason.
    sp = db.begin_nested()
    with pytest.raises(ValueError) as exc2:
        di.import_dataset_csv(db, 986, "TooBig", cfgs, csv_text(50, 10))
    assert "limit" in str(exc2.value)
    sp.rollback()

    # ── .xlsx refuses at the SAME size, not its own ──────────────────────────
    blob = _xlsx_bytes([[f"Q{i}" for i in range(10)]] + [[1] * 10 for _ in range(50)])
    with pytest.raises(di.XlsxImportError) as exc3:
        di.xlsx_to_csv_text(blob)
    assert "limit" in str(exc3.value)

    # ...and accepts an under-cap workbook, so the gate is not simply always-on.
    small = _xlsx_bytes([[f"Q{i}" for i in range(5)]] + [[1] * 5 for _ in range(5)])
    text, _sheets = di.xlsx_to_csv_text(small)
    assert text.count("\n") == 6

    # ── The threshold really is shared, not three coincidences ───────────────
    assert di.cell_count_error(10, 10) is None            # exactly at the cap
    assert di.cell_count_error(11, 10) is not None        # one cell over

    # ── 🔴 The message must SURVIVE the router ───────────────────────────────
    # The preview endpoint catches (ValueError, csv.Error, TypeError) and
    # replaces it with "Unable to parse CSV file. Check the file format" — a
    # diagnosis it has not established, about a file that parses fine. That is
    # #797 exactly, and a bare ValueError would have walked straight into it.
    assert issubclass(di.DatasetTooLargeError, ValueError)
    user = db.get(User, 1)
    big = StarletteUploadFile(filename="big.csv",
                              file=io.BytesIO(csv_text(50, 10).encode()))
    with pytest.raises(HTTPException) as http_exc:
        asyncio.run(preview_dataset(project_id=986, file=big, encoding="utf-8",
                                    sheet_name=None, user=user, db=db))
    assert http_exc.value.status_code == 400
    assert "limit" in http_exc.value.detail
    assert "check the file format" not in http_exc.value.detail.lower()
