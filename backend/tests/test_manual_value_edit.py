"""#582: editing a manual dataset cell must (re)populate value_numeric.

`update_value` unconditionally nulled value_numeric and only re-derived it from a
PRIMARY recode — so a manual numeric/ordinal/binary column (which typically has no
recode) silently lost its numeric encoding on every edit, dropping it out of means,
correlations and scale scores. The fix falls back to `_compute_value_numeric`,
mirroring import.
"""
import asyncio
import json

import pytest

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.user import User
from app.schemas.dataset import ValueUpdate
from app.routers.dataset import update_value


def _run(coro):
    return asyncio.run(coro)


def _edit(db, col, raw):
    row = DatasetRow(dataset_id=col.dataset_id)
    db.add(row); db.flush()
    v = DatasetValue(row_id=row.id, column_id=col.id, value_text=None, value_numeric=None)
    db.add(v); db.flush()
    user = db.get(User, 1)
    _run(update_value(col.dataset.project_id, col.dataset_id, v.id,
                      ValueUpdate(value_text=raw), user=user, db=db))
    db.refresh(v)
    return v


@pytest.fixture
def dataset(db_session):
    p = Project(id=1, name="P", user_id=1)
    db_session.add(p); db_session.flush()
    d = Dataset(id=1, project_id=1, name="D")
    db_session.add(d); db_session.flush()
    return db_session, d


def _col(db, d, ctype, seq, **kw):
    c = DatasetColumn(dataset_id=d.id, column_code=f"C{seq}", column_text=f"c{seq}",
                      column_type=ColumnType(ctype), sequence_order=seq, display_order=seq,
                      source="manual", **kw)
    db.add(c); db.flush()
    return c


def test_manual_numeric_edit_populates_value_numeric(dataset):
    db, d = dataset
    col = _col(db, d, "numeric", 0)
    assert _edit(db, col, "42").value_numeric == 42.0


def test_manual_ordinal_no_labels_edit_populates_value_numeric(dataset):
    # #580 + #582 together: a bare-numeric ordinal cell is its own code.
    db, d = dataset
    col = _col(db, d, "ordinal", 1)
    assert _edit(db, col, "3").value_numeric == 3.0


def test_manual_ordinal_with_labels_edit_maps_to_code(dataset):
    db, d = dataset
    col = _col(db, d, "ordinal", 2,
               scale_labels=json.dumps(["Poor", "Fair", "Good"]),
               scale_values=json.dumps([1, 2, 3]))
    assert _edit(db, col, "Good").value_numeric == 3.0


def test_manual_binary_edit_populates(dataset):
    db, d = dataset
    col = _col(db, d, "binary", 3)
    assert _edit(db, col, "Yes").value_numeric == 1.0


def test_manual_nominal_edit_stays_null(dataset):
    # A categorical/text type has no numeric encoding — None, as at import.
    db, d = dataset
    col = _col(db, d, "nominal", 4)
    v = _edit(db, col, "Apples")
    assert v.value_text == "Apples"
    assert v.value_numeric is None
