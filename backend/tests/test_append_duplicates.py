"""The append wizard's duplicate check: one answer, both steps, no ORM load (#1014).

`append_preview` says *"N of M rows match"* and `append_import` skips them. Each
step used to carry its own copy of the check, loading every existing record and
its cells as ORM objects (1.14M on a 40,000 × 30 dataset: 23.5 s / 1,945 MB for
the preview, 27.5 s / 2,582 MB for the import). The copies also DISAGREED, and
these tests enter through BOTH endpoints so that the page's promise and the
import's behaviour are compared, not each step against itself:

- a record repeated WITHIN the file was skipped by the import and counted as
  new by the preview (`TestThePreviewCountsWhatTheImportSkips`);
- a CODE-format file on a value-labelled column matched at the import (#575)
  and not at the preview (`TestACodeMatchesItsLabelAtBothSteps`).

The streamed read keeps normalisation in Python (`TestTheComparisonIsPythons`)
and must still match a record that has no cell at all
(`TestARecordWithNoCellsStillMatchesABlankOne`).
"""

import asyncio
import io
import json

import pytest
from fastapi import UploadFile
from sqlalchemy import event

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import append_import, append_preview


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def db(db_session):
    db_session.add(Project(id=1, name="Waves", user_id=1))
    db_session.flush()
    return db_session


def _dataset(db, records: list[list[str | None]], *, labelled: bool = False) -> Dataset:
    """Two columns Q1, Q2; one record per list, `None` = no cell stored."""
    ds = Dataset(project_id=1, name="Wave 1")
    db.add(ds)
    db.flush()
    cols = []
    for i in range(2):
        col = DatasetColumn(
            dataset_id=ds.id, column_text=f"Q{i + 1}", sequence_order=i, source="imported",
            column_type=ColumnType.ORDINAL if labelled and i == 0 else ColumnType.NOMINAL,
        )
        if labelled and i == 0:
            # A gapped scale, so a code is never its own position (#28).
            col.scale_labels = json.dumps(["Low", "Mid", "High"])
            col.scale_values = json.dumps([1, 4, 6])
        db.add(col)
        cols.append(col)
    db.flush()
    for n, cells in enumerate(records):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{n + 1:04d}")
        db.add(row)
        db.flush()
        for col, text in zip(cols, cells):
            if text is not None:
                db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=text))
    db.flush()
    db.commit()
    return ds


def _file(lines: list[str]) -> bytes:
    return ("Q1,Q2\n" + "".join(line + "\n" for line in lines)).encode()


def _preview(db, ds, body: bytes):
    user = db.get(User, 1)
    return _run(append_preview(
        1, ds.id, UploadFile(filename="w2.csv", file=io.BytesIO(body)),
        encoding="utf-8", sheet_name=None, user=user, db=db,
    ))


def _import(db, ds, body: bytes):
    user = db.get(User, 1)
    cols = (
        db.query(DatasetColumn).filter(DatasetColumn.dataset_id == ds.id)
        .order_by(DatasetColumn.sequence_order).all()
    )
    config = json.dumps({
        "column_mapping": [{"csv_column_index": i, "column_id": c.id} for i, c in enumerate(cols)],
        "skip_duplicates": True,
    })
    return _run(append_import(
        1, ds.id, UploadFile(filename="w2.csv", file=io.BytesIO(body)),
        import_config=config, encoding="utf-8", user=user, db=db,
    ))


def _both(db, ds, body: bytes):
    """The preview's promise and what the import then did, on one file."""
    preview = _preview(db, ds, body)
    result = _import(db, ds, body)
    return preview, result


class TestThePreviewCountsWhatTheImportSkips:
    def test_a_record_repeated_within_the_file_is_a_duplicate_at_both_steps(self, db):
        ds = _dataset(db, [["a", "b"]])
        preview, result = _both(db, ds, _file(["a,b", "new,1", "new,1", "other,2"]))

        assert result.duplicates_skipped == 2 and result.rows_created == 2
        assert preview.duplicate_count == result.duplicates_skipped, (
            "the page promises total_rows - duplicate_count new records; "
            "it must be what the import writes"
        )
        assert preview.in_file_duplicate_count == 1
        assert [r.is_duplicate for r in preview.preview_rows] == [True, False, True, False]

    def test_the_whole_file_is_counted_while_only_a_sample_is_shown(self, db):
        ds = _dataset(db, [["a", "b"]])
        lines = [f"x{i},y{i}" for i in range(14)] + ["a,b"]
        preview, result = _both(db, ds, _file(lines))

        assert len(preview.preview_rows) == 10
        assert preview.duplicate_count == 1 == result.duplicates_skipped


class TestACodeMatchesItsLabelAtBothSteps:
    def test_a_code_format_file_finds_the_labelled_record(self, db):
        # The existing record holds the LABEL; the file carries its CODE.
        ds = _dataset(db, [["High", "b"]], labelled=True)
        preview, result = _both(db, ds, _file(["6,b"]))

        assert result.duplicates_skipped == 1, "the import resolves 6 → High (#575)"
        assert preview.duplicate_count == 1, "and so must the preview's count"
        assert preview.preview_rows[0].values[str(
            db.query(DatasetColumn).filter_by(dataset_id=ds.id, column_text="Q1").one().id
        )] == "6", "the preview still SHOWS the file's own cell"


class TestTheComparisonIsPythons:
    def test_case_and_whitespace_fold_beyond_ascii(self, db):
        # SQLite's lower() folds ASCII only and trim() strips spaces only; the
        # check must fold the way Python does, as it did before it streamed.
        ds = _dataset(db, [["été", "b"]])
        preview, result = _both(db, ds, _file(["\tÉTÉ ,B"]))
        assert preview.duplicate_count == 1 == result.duplicates_skipped

    def test_a_different_value_is_not_a_duplicate(self, db):
        ds = _dataset(db, [["a", "b"]])
        preview, result = _both(db, ds, _file(["a,c"]))
        assert preview.duplicate_count == 0 == result.duplicates_skipped


class TestARecordWithNoCellsStillMatchesABlankOne:
    def test_an_all_blank_record_matches_a_record_with_no_stored_cells(self, db):
        # The importer stores no cell for a blank, so this record never appears
        # in the streamed values at all.
        ds = _dataset(db, [["a", "b"], [None, None]])
        preview, result = _both(db, ds, _file([","]))
        assert preview.duplicate_count == 1 == result.duplicates_skipped

    def test_without_one_an_all_blank_record_is_new(self, db):
        ds = _dataset(db, [["a", "b"], ["c", None]])
        preview, result = _both(db, ds, _file([","]))
        assert preview.duplicate_count == 0 == result.duplicates_skipped

    def test_a_missing_cell_matches_a_blank_one(self, db):
        ds = _dataset(db, [["a", None]])
        preview, result = _both(db, ds, _file(["a,"]))
        assert preview.duplicate_count == 1 == result.duplicates_skipped


class TestNoRecordIsLoadedAsAnObject:
    def test_neither_step_loads_a_cell_as_an_orm_object(self, db):
        """The cost this entry was filed for: every existing cell as an ORM
        object. Counted with the mapper's `load` event, which fires for every
        instance built from a row. ⚠️ Not the identity map — it holds instances
        WEAKLY, so a loaded-and-discarded list leaves it empty and a first draft
        of this test passed with the ORM load put back."""
        ds = _dataset(db, [[f"a{i}", f"b{i}"] for i in range(20)])
        loads = []

        def on_load(target, _context):
            loads.append(target)

        event.listen(DatasetValue, "load", on_load)
        try:
            preview = _preview(db, ds, _file(["a3,b3"]))
            assert preview.duplicate_count == 1, "the check ran"
            assert loads == []

            result = _import(db, ds, _file(["a3,b3", "new,1"]))
            assert result.duplicates_skipped == 1, "the check ran"
            assert loads == []
        finally:
            event.remove(DatasetValue, "load", on_load)
