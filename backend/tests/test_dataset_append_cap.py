"""Appending a file asks the cell cap, like adding one record by hand does (#972).

`create_row` has called `cell_count_error` since row 47, on the grounds that
*"nothing else bounds a hand-authored table at all"*. `append_import` — the only
writer that can add tens of thousands of records at once — asked nothing, bounded
only by the 50 MB byte cap on the uploaded file. **The cheap operation was guarded
and the expensive one was not.**

What these guard:

- Both append doors refuse (`TestBothAppendDoorsRefuse`). The preview so the wall
  arrives before the researcher maps every column; the import because a script
  reaches it directly and a guard at one of two doors is not a guard on the
  operation (#589).
- The refusal is asked BEFORE the duplicate-fingerprint load
  (`test_the_refusal_costs_no_row_load`), which pulls every existing row and all of
  its values into memory. A guard placed after it would materialise the whole
  dataset in order to report that the dataset is too large.
- The message does not carry `cell_count_error`'s advice
  (`TestTheMessageAdvisesSomethingThatWorks`), which cannot be acted on here.
"""

import asyncio
import io
import json

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import event

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow
from app.models.project import Project
from app.models.user import User
from app.services import dataset_import
from app.services.dataset_import import MAX_DATASET_CELLS, append_cell_count_error


def _run(coro):
    """asyncio.run, never get_event_loop().run_until_complete — a shared loop that
    another module's asyncio.run has closed makes this fail BY SUITE ORDER
    (`test_observation_coverage.py` carries the same note). The first draft of this
    file used the latter and passed alone while failing in the full suite."""
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=1, name="Wave study", user_id=1))
    db.flush()
    return db


def _user(db):
    return db.query(User).filter(User.id == 1).one()


def _dataset(db, *, n_cols: int = 2, n_rows: int = 0) -> Dataset:
    ds = Dataset(project_id=1, name="Responses")
    db.add(ds)
    db.flush()
    for i in range(n_cols):
        db.add(DatasetColumn(
            dataset_id=ds.id, column_text=f"Q{i + 1}", column_type=ColumnType.NOMINAL,
            sequence_order=i, source="imported",
        ))
    for i in range(n_rows):
        db.add(DatasetRow(dataset_id=ds.id, row_identifier=f"R{i + 1:04d}"))
    db.flush()
    db.commit()
    return ds


def _csv(n_rows: int) -> UploadFile:
    body = "Q1,Q2\n" + "".join(f"a{i},b{i}\n" for i in range(n_rows))
    return UploadFile(filename="more.csv", file=io.BytesIO(body.encode()))


def _config(db, ds: Dataset) -> str:
    cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == ds.id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )
    return json.dumps({
        "column_mapping": [
            {"csv_column_index": i, "column_id": c.id} for i, c in enumerate(cols[:2])
        ],
        "skip_duplicates": False,
    })


# ── the arithmetic, with no database in the way ───────────────────────────


class TestTheArithmetic:
    def test_an_append_that_fits_is_not_refused(self):
        assert append_cell_count_error(10, 10, 3) is None

    def test_the_sum_is_what_counts_not_either_side(self):
        """Neither the existing table nor the file is over on its own."""
        half = MAX_DATASET_CELLS // 2
        assert append_cell_count_error(half, 0, 1) is None
        assert append_cell_count_error(0, half, 1) is None
        assert append_cell_count_error(half, half + 1, 1) is not None

    def test_the_headroom_is_exact_and_is_in_records(self):
        n_cols = 4
        cap_rows = MAX_DATASET_CELLS // n_cols
        existing = cap_rows - 10
        message = append_cell_count_error(existing, 11, n_cols)
        assert message is not None
        assert "room for 10 more records" in message
        assert "This file has 11." in message
        # And the boundary itself is not refused.
        assert append_cell_count_error(existing, 10, n_cols) is None

    def test_a_dataset_already_over_the_cap_says_so_instead_of_negative_room(self):
        """Reachable: a computed or derived column adds WIDTH to every existing
        row, so a table that passed its import cap can grow past it afterwards.
        "room for -3 more records" is nonsense and the remedy is different."""
        n_cols = 4
        over = MAX_DATASET_CELLS // n_cols + 3
        message = append_cell_count_error(over, 1, n_cols)
        assert message is not None
        assert "no more records can be appended" in message
        assert "room for" not in message
        assert "-" not in message.replace("x ", "")  # no negative anywhere

    def test_a_dataset_with_no_columns_is_not_refused(self):
        """Zero width is zero cells however many records arrive; the append
        endpoints refuse an unmapped file earlier, with a better sentence."""
        assert append_cell_count_error(0, 10_000_000, 0) is None


class TestTheMessageAdvisesSomethingThatWorks:
    """#973's defect is a refusal that names an action the researcher cannot take.
    `cell_count_error`'s wording is exactly that on THIS path, so importing it
    would have imported the bug."""

    def _message(self) -> str:
        n_cols = 4
        message = append_cell_count_error(MAX_DATASET_CELLS // n_cols - 10, 11, n_cols)
        assert message is not None
        return message

    def test_it_does_not_offer_to_skip_columns(self):
        """An append maps onto the dataset's EXISTING columns, so deselecting a
        file column does not change the dataset's width by one cell."""
        assert "fewer columns" not in self._message()
        assert "skip any you don't need" not in self._message()

    def test_it_does_not_offer_to_split_the_file(self):
        """The cap counts the whole dataset, so two appends of half the rows land
        at exactly the same total."""
        assert "splitting the file" not in self._message()

    def test_it_states_the_dataset_not_the_file_as_the_subject(self):
        message = self._message()
        assert message.startswith("This dataset holds")
        assert f"{MAX_DATASET_CELLS:,}-value limit" in message


# ── both doors, over HTTP-shaped calls ────────────────────────────────────


class TestBothAppendDoorsRefuse:
    """The cap is lowered rather than a 4,000,000-cell fixture built."""

    @pytest.fixture(autouse=True)
    def small_cap(self, monkeypatch):
        monkeypatch.setattr(dataset_import, "MAX_DATASET_CELLS", 20)

    def test_the_import_refuses_and_writes_nothing(self, project):
        from app.routers.dataset import append_import

        db = project
        ds = _dataset(db, n_cols=2, n_rows=8)  # 16 of 20 cells: room for 2 records

        with pytest.raises(HTTPException) as exc:
            _run(append_import(
                project_id=1, dataset_id=ds.id, file=_csv(3),
                import_config=_config(db, ds), encoding="utf-8",
                user=_user(db), db=db,
            ))

        assert exc.value.status_code == 400
        assert "room for 2 more records" in exc.value.detail
        assert "This file has 3." in exc.value.detail
        assert db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id).count() == 8

    def test_the_import_still_allows_an_append_that_fits(self, project):
        """The positive control. Without it a guard that refused everything would
        pass every assertion above."""
        from app.routers.dataset import append_import

        db = project
        ds = _dataset(db, n_cols=2, n_rows=8)

        resp = _run(append_import(
            project_id=1, dataset_id=ds.id, file=_csv(2),
            import_config=_config(db, ds), encoding="utf-8",
            user=_user(db), db=db,
        ))
        assert resp.rows_created == 2

    def test_the_preview_refuses_before_the_researcher_maps_columns(self, project):
        """The preview is where the append wizard starts. Refusing only at the
        import means the wall arrives after every column has been mapped."""
        from app.routers.dataset import append_preview

        db = project
        ds = _dataset(db, n_cols=2, n_rows=8)

        with pytest.raises(HTTPException) as exc:
            _run(append_preview(
                project_id=1, dataset_id=ds.id, file=_csv(3),
                encoding="utf-8", sheet_name=None, user=_user(db), db=db,
            ))

        assert exc.value.status_code == 400
        assert "room for 2 more records" in exc.value.detail

    def test_the_width_is_the_datasets_not_the_files(self, project):
        """The file carries two columns; the dataset is four wide, so four is what
        each appended record costs. Counting the FILE's width would let a narrow
        file grow a wide table without limit."""
        from app.routers.dataset import append_import

        db = project
        ds = _dataset(db, n_cols=4, n_rows=4)  # 16 of 20 cells: room for 1 record

        with pytest.raises(HTTPException) as exc:
            _run(append_import(
                project_id=1, dataset_id=ds.id, file=_csv(2),
                import_config=_config(db, ds), encoding="utf-8",
                user=_user(db), db=db,
            ))
        assert "4 variables" in exc.value.detail
        assert "room for 1 more records" in exc.value.detail

    def test_the_refusal_costs_no_row_load(self, project, db_session):
        """🔴 The ORDERING, which is the half the filed entry did not name.

        `append_import` builds its duplicate fingerprints from every existing
        value of the mapped columns — ~3.6M on the GSS corpus. Streamed since
        #1014 rather than loaded as ORM objects, but still the expensive part, so
        a refusal placed after it pays for the read it exists to refuse. Nothing
        else in the refused path reads `dataset_values`, so its absence from the
        SQL is the assertion.
        """
        from app.routers.dataset import append_import

        db = project
        ds = _dataset(db, n_cols=2, n_rows=8)

        seen: list[str] = []

        def record(conn, cursor, statement, parameters, context, executemany):
            seen.append(statement)

        event.listen(db.get_bind(), "before_cursor_execute", record)
        try:
            with pytest.raises(HTTPException):
                _run(append_import(
                    project_id=1, dataset_id=ds.id, file=_csv(3),
                    import_config=_config(db, ds), encoding="utf-8",
                    user=_user(db), db=db,
                ))
        finally:
            event.remove(db.get_bind(), "before_cursor_execute", record)

        assert seen, "no SQL was captured — this test would pass vacuously"
        touched_values = [s for s in seen if "dataset_values" in s]
        assert not touched_values, (
            "the refusal loaded dataset values before refusing:\n"
            + "\n".join(touched_values)
        )


class TestTheImportCapRemedyIsReachable:
    """#973 defect 1 — both cap messages named a screen the file cannot reach.

    The cap is enforced at PREVIEW (`.xlsx` on declared dimensions, `.sav` on
    metadata, CSV by bailing mid-stream), and the wizard is downstream of the
    preview. So *"the wizard can skip any you don't need"* described an action
    no researcher shown that message could take.

    ⚠️ Deliberately does NOT assert anything about whether skipping would reduce
    the count — that is #973 (a), it is inert until the two-stage preview exists,
    and a test asserting it here would pin a behaviour nothing implements.
    """

    def test_neither_cap_message_names_the_wizard(self):
        from app.services.dataset_import import (
            cell_cap_exceeded_message,
            cell_count_error,
        )

        counted = cell_count_error(10_000_000, 40)
        streamed = cell_cap_exceeded_message(40)
        assert counted is not None
        for message in (counted, streamed):
            assert "wizard" not in message.lower(), message
            assert "skip" not in message.lower(), message

    def test_both_say_what_to_do_and_where(self):
        from app.services.dataset_import import (
            cell_cap_exceeded_message,
            cell_count_error,
        )

        counted = cell_count_error(10_000_000, 40)
        streamed = cell_cap_exceeded_message(40)
        assert counted is not None
        for message in (counted, streamed):
            # The action, and the fact it happens OUTSIDE the tool — which is
            # the half that was missing, not the half that was wrong.
            assert "Removing columns" in message
            assert "before importing" in message

    def test_the_counted_message_still_reports_the_dimensions_it_knows(self):
        """The streaming one deliberately quotes no row TOTAL — it bails the
        moment the cap is crossed, so it never finished counting (#797's lesson:
        report what you know, never a plausible-looking guess). The counted one
        knows all three and must keep saying them.

        ⚠️ The check is for a row FIGURE, not for the word "rows": the shared
        remedy legitimately says "splitting the rows across more than one file",
        and a first draft of this test banned the word and failed on the fix it
        was written for."""
        import re

        from app.services.dataset_import import cell_cap_exceeded_message, cell_count_error

        counted = cell_count_error(200_000, 40)
        assert counted is not None
        assert "200,000 rows x 40 columns = 8,000,000 values" in counted

        streamed = cell_cap_exceeded_message(40)
        assert re.search(r"[\d,]+\s+rows", streamed) is None, streamed
