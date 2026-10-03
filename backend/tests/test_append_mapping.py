"""#1020 — `append_import` no longer trusts its column mapping.

`DatasetAppendRequest.column_mapping` was ``list[dict]`` and the router indexed
the file with it. All three filed cases were reproduced by execution: a
``csv_column_index`` of ``-1`` read the file's LAST column (Python indexes from
the end) and reported a successful append of the wrong data; the same
``column_id`` twice wrote two values into one cell (`IntegrityError`, a 500); an
entry without ``csv_column_index`` raised `KeyError` (a 500). The review of the
same path found three more the entry did not name: an index past the file's
width stored NOTHING for every record and reported success; a column of ANOTHER
dataset was dropped from the mapping in silence and the append went ahead
without it; and a computed or hand-made column — which the preview never offers
— took the file's values. The wizard sends none of these; a script can send all.

Every refusal must also write NOTHING, so each case checks the row count.
"""

import asyncio
import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow
from app.models.project import Project
from app.models.user import User

FILE = "Q1,Q2\na,b\nc,d\n"


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def db(db_session):
    db_session.add(Project(id=1020, name="Append", user_id=1))
    db_session.flush()
    return db_session


def _dataset(db, name="Responses"):
    ds = Dataset(project_id=1020, name=name)
    db.add(ds)
    db.flush()
    for i in range(2):
        db.add(DatasetColumn(dataset_id=ds.id, column_text=f"Q{i + 1}",
                             column_type=ColumnType.NOMINAL, sequence_order=i,
                             source="imported"))
    db.flush()
    return ds


def _cols(db, ds):
    return (db.query(DatasetColumn).filter(DatasetColumn.dataset_id == ds.id)
            .order_by(DatasetColumn.sequence_order).all())


def _append(db, ds, mapping):
    from app.routers.dataset import append_import

    return _run(append_import(
        project_id=1020, dataset_id=ds.id,
        file=UploadFile(filename="more.csv", file=io.BytesIO(FILE.encode())),
        import_config=json.dumps({"column_mapping": mapping, "skip_duplicates": False}),
        encoding="utf-8", user=db.query(User).filter(User.id == 1).one(), db=db,
    ))


def _refused(db, ds, mapping) -> str:
    with pytest.raises(HTTPException) as exc:
        _append(db, ds, mapping)
    assert exc.value.status_code == 400
    assert db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id).count() == 0
    return exc.value.detail


class TestTheMappingIsChecked:
    def test_a_well_formed_mapping_still_appends(self, db):
        """The positive control — a guard that refused everything would pass
        every test below."""
        ds = _dataset(db)
        c1, c2 = _cols(db, ds)
        resp = _append(db, ds, [{"csv_column_index": 0, "column_id": c1.id},
                                {"csv_column_index": 1, "column_id": c2.id}])
        assert resp.rows_created == 2

    def test_a_negative_index_is_refused_not_read_from_the_end(self, db):
        ds = _dataset(db)
        c1, _ = _cols(db, ds)
        detail = _refused(db, ds, [{"csv_column_index": -1, "column_id": c1.id}])
        assert "column_mapping.0.csv_column_index" in detail

    def test_a_dataset_column_mapped_twice_is_refused_by_name(self, db):
        ds = _dataset(db)
        c1, _ = _cols(db, ds)
        detail = _refused(db, ds, [{"csv_column_index": 0, "column_id": c1.id},
                                   {"csv_column_index": 1, "column_id": c1.id}])
        assert f"dataset column {c1.id} more than once" in detail

    def test_a_file_column_mapped_twice_is_refused(self, db):
        ds = _dataset(db)
        c1, c2 = _cols(db, ds)
        detail = _refused(db, ds, [{"csv_column_index": 0, "column_id": c1.id},
                                   {"csv_column_index": 0, "column_id": c2.id}])
        assert "file column 1 more than once" in detail

    @pytest.mark.parametrize("entry", [
        {"column_id": 1},                                  # no index
        {"csv_column_index": 0},                           # no column
        {"csv_column_index": True, "column_id": 1},        # a bool is not column 1
        {"csv_column_index": "0", "column_id": 1},         # nor is a string
    ])
    def test_a_malformed_entry_is_refused(self, db, entry):
        ds = _dataset(db)
        entry = {k: (_cols(db, ds)[0].id if k == "column_id" else v) for k, v in entry.items()}
        detail = _refused(db, ds, [entry])
        assert detail.startswith("Invalid import configuration: column_mapping.0")

    def test_an_index_past_the_files_width_is_refused(self, db):
        """It used to store nothing for every record, and report success."""
        ds = _dataset(db)
        c1, _ = _cols(db, ds)
        detail = _refused(db, ds, [{"csv_column_index": 2, "column_id": c1.id}])
        assert detail == "The column mapping names file column 3, but this file has 2 columns."

    def test_a_column_of_another_dataset_is_refused_not_dropped(self, db):
        ds = _dataset(db)
        other = _dataset(db, name="Other")
        c1, _ = _cols(db, ds)
        foreign = _cols(db, other)[0]
        detail = _refused(db, ds, [{"csv_column_index": 0, "column_id": c1.id},
                                   {"csv_column_index": 1, "column_id": foreign.id}])
        assert detail == f"Column {foreign.id} is not a column of this dataset."

    @pytest.mark.parametrize("source", ["computed", "manual"])
    def test_a_column_the_preview_never_offers_is_refused(self, db, source):
        ds = _dataset(db)
        c1, c2 = _cols(db, ds)
        c2.source = source
        if source == "computed":
            c2.expression = "[Q1]"
        db.flush()
        detail = _refused(db, ds, [{"csv_column_index": 0, "column_id": c1.id},
                                   {"csv_column_index": 1, "column_id": c2.id}])
        assert detail.startswith(f"“Q2” is a {source} column.")
