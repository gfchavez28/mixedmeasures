"""#834/#835 — the row→page resolver, and the ordering it must agree with.

The search deep link knows a row's primary key; the grid is addressed by page
offset. `get_row_position` bridges the two, and it is only correct if it uses
the SAME ordering as `get_dataset_data`. These tests pin the agreement rather
than either side's implementation, because the failure mode is silent: a
mismatch lands the jump on the wrong page, which reads to a researcher as "the
record isn't there".
"""
import asyncio
from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, ColumnType
from app.models.user import User
from app.routers.dataset import get_dataset_data, get_row_position


def _run(coro):
    return asyncio.run(coro)


def _seed(db, n_rows: int, *, dated: bool = False, project_id: int = 900):
    p = Project(id=project_id, name="P", user_id=1)
    db.add(p)
    db.flush()
    d = Dataset(id=project_id, project_id=project_id, name="D")
    db.add(d)
    db.flush()
    db.add(DatasetColumn(
        dataset_id=d.id, column_code="Q1", column_name="Q1", column_text="Q1 text",
        column_type=ColumnType.NUMERIC, sequence_order=0, display_order=0,
    ))
    rows = []
    for i in range(n_rows):
        r = DatasetRow(
            dataset_id=d.id,
            row_identifier=f"R{i + 1:05d}",
            # Descending dates on purpose when `dated`: id order and
            # submitted_at order then DISAGREE, which is the only way to tell
            # the two-key ordering from a plain `id` sort.
            submitted_at=datetime(2020, 1, 1, 0, 0, n_rows - i) if dated else None,
        )
        db.add(r)
        rows.append(r)
    db.flush()
    return db.get(User, 1), d, rows


def _positions(db, user, dataset, rows, limit):
    return [
        _run(get_row_position(
            project_id=dataset.project_id, dataset_id=dataset.id, row_id=r.id,
            limit=limit, user=user, db=db,
        ))
        for r in rows
    ]


def test_position_matches_the_page_the_grid_actually_returns(db_session):
    """The load-bearing assertion: resolve → page → the row is on it."""
    user, ds, rows = _seed(db_session, 25)
    limit = 10

    for row in rows:
        pos = _run(get_row_position(
            project_id=ds.project_id, dataset_id=ds.id, row_id=row.id,
            limit=limit, user=user, db=db_session,
        ))
        page = _run(get_dataset_data(
            project_id=ds.project_id, dataset_id=ds.id,
            limit=limit, offset=pos.offset, user=user, db=db_session,
        ))
        ids = [r.id for r in page.rows]
        assert row.id in ids, f"row {row.id} absent from the page its position named"
        # And at the exact slot the index implies — not merely somewhere on it.
        assert ids.index(row.id) == pos.index - pos.offset


def test_index_is_dataset_scoped_and_zero_based(db_session):
    user, ds, rows = _seed(db_session, 7)
    got = [p.index for p in _positions(db_session, user, ds, rows, 10)]
    assert got == list(range(7))


def test_offset_is_the_page_start_not_the_index(db_session):
    user, ds, rows = _seed(db_session, 25)
    pos = _positions(db_session, user, ds, rows, 10)
    assert [p.offset for p in pos[:10]] == [0] * 10
    assert [p.offset for p in pos[10:20]] == [10] * 10
    assert [p.offset for p in pos[20:]] == [20] * 5


def test_ordering_is_two_key_not_id_alone(db_session):
    """The regression this file exists for.

    With `submitted_at` populated in DESCENDING order, `ORDER BY id` and the
    grid's real ordering disagree completely. A resolver written against `id`
    passes every other test here and fails this one.
    """
    user, ds, rows = _seed(db_session, 6, dated=True)
    limit = 3

    page = _run(get_dataset_data(
        project_id=ds.project_id, dataset_id=ds.id, limit=limit, offset=0,
        user=user, db=db_session,
    ))
    # Sanity: the grid really did reverse them, so the assertion below has teeth.
    assert [r.id for r in page.rows] == [r.id for r in reversed(rows)][:limit]

    for row in rows:
        pos = _run(get_row_position(
            project_id=ds.project_id, dataset_id=ds.id, row_id=row.id,
            limit=limit, user=user, db=db_session,
        ))
        got = _run(get_dataset_data(
            project_id=ds.project_id, dataset_id=ds.id, limit=limit,
            offset=pos.offset, user=user, db=db_session,
        ))
        assert row.id in [r.id for r in got.rows]


def test_nulls_sort_last_alongside_dated_rows(db_session):
    """Mixed NULL/dated is the branch `rows_before` splits on."""
    user, ds, rows = _seed(db_session, 3, dated=True)
    undated = DatasetRow(dataset_id=ds.id, row_identifier="R99999", submitted_at=None)
    db_session.add(undated)
    db_session.flush()

    page = _run(get_dataset_data(
        project_id=ds.project_id, dataset_id=ds.id, limit=50, offset=0,
        user=user, db=db_session,
    ))
    assert page.rows[-1].id == undated.id, "NULLS LAST"

    pos = _run(get_row_position(
        project_id=ds.project_id, dataset_id=ds.id, row_id=undated.id,
        limit=50, user=user, db=db_session,
    ))
    assert pos.index == 3


def test_total_rows_is_the_dataset_not_the_page(db_session):
    user, ds, rows = _seed(db_session, 25)
    pos = _run(get_row_position(
        project_id=ds.project_id, dataset_id=ds.id, row_id=rows[0].id,
        limit=10, user=user, db=db_session,
    ))
    assert pos.total_rows == 25


def test_row_from_another_dataset_is_404_not_a_position(db_session):
    """Scoped to the dataset: a foreign row id must not resolve to a page here."""
    user, ds_a, rows_a = _seed(db_session, 3, project_id=900)
    _user_b, ds_b, rows_b = _seed(db_session, 3, project_id=901)

    with pytest.raises(HTTPException) as exc:
        _run(get_row_position(
            project_id=ds_a.project_id, dataset_id=ds_a.id, row_id=rows_b[0].id,
            limit=10, user=user, db=db_session,
        ))
    assert exc.value.status_code == 404
