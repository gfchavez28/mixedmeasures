"""#486 regression — the Text Coding randomize must actually shuffle.

The original key, abs((dataset_value_id * random_seed) % 2147483647), is
strictly monotone in dataset_value_id whenever id * seed stays below the
modulus — true for every realistic dataset at the frontend's seed range
[2, 99999] — so "randomized" order silently equaled insertion order. The fix
hashes (seed, id), which must: differ from id order, be reproducible for the
same seed (the persisted-seed / export contract), and differ across seeds.
"""

import asyncio

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.user import User
from app.routers.text_coding import list_texts


N_ROWS = 30  # enough that an accidental identity permutation is implausible


def _seed_texts(db):
    db.add_all([
        Project(id=810, name="Randomize", user_id=1),
        Dataset(id=810, project_id=810, name="Survey"),
        DatasetColumn(id=8100, dataset_id=810, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
    ])
    for i in range(N_ROWS):
        db.add(DatasetRow(id=8110 + i, dataset_id=810, row_identifier=f"R{i:03d}"))
        db.add(DatasetValue(id=81100 + i, row_id=8110 + i, column_id=8100,
                            value_text=f"response {i}"))
    db.flush()


def _order(db, random_seed):
    res = asyncio.run(list_texts(
        810, column_ids="8100", dataset_ids=None, hide_empty=True, record_id=None,
        search=None, sort_by="column_asc", random_seed=random_seed,
        quoted_only=False, user=db.get(User, 1), db=db,
    ))
    return [t.dataset_value_id for t in res.texts]


def test_randomize_changes_order_and_is_reproducible(db_session):
    db = db_session
    _seed_texts(db)

    baseline = _order(db, None)
    assert baseline == sorted(baseline)  # default column_asc == id order here

    # Seeds in the frontend's mint range [2, 99999] — the exact range where the
    # old multiplicative key degenerated to a no-op.
    for seed in (2, 137, 4242, 99999):
        shuffled = _order(db, seed)
        assert sorted(shuffled) == baseline  # same items…
        assert shuffled != baseline, f"seed {seed} did not shuffle"  # …new order

    # Same seed twice → identical order (persisted-seed reproducibility).
    assert _order(db, 4242) == _order(db, 4242)

    # Different seeds → different orders.
    assert _order(db, 137) != _order(db, 4242)
