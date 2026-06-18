"""#371 — nominal columns are valid group-by / cross-tab candidates.

The `analysis-columns` endpoint feeds the AnalysisView ColumnPicker. Its
`demographics` list is the group-by candidate set; before the fix it only held
`demographic`-typed columns, so a chart couldn't be grouped by e.g. Department
(nominal). The compute path buckets grouping by value_text (no numeric or type
requirement), so nominal grouping computes correctly — the only barrier was UI
eligibility. Nominal columns must ALSO remain selectable as metric inputs, so
they appear in both `demographics` and the per-dataset column list.
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn
from app.models.user import User
from app.routers.metrics import get_analysis_columns


def _run(coro):
    return asyncio.run(coro)


def _seed(db):
    db.add(Project(id=900, name="Group-By Test", user_id=1)); db.flush()
    db.add(Dataset(id=900, project_id=900, name="Compensation")); db.flush()
    db.add_all([
        DatasetColumn(id=9001, dataset_id=900, column_code="Department", column_name="Department",
                      column_text="Department", column_type="nominal",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=9002, dataset_id=900, column_code="Salary", column_name="Salary",
                      column_text="Base Salary", column_type="numeric",
                      sequence_order=1, display_order=1),
        DatasetColumn(id=9003, dataset_id=900, column_code="Gender", column_name="Gender",
                      column_text="Gender", column_type="demographic",
                      demographic_subtype="gender", sequence_order=2, display_order=2),
    ])
    db.flush()
    return db.query(User).filter(User.id == 1).one()


def test_nominal_column_is_a_group_by_candidate(db_session):
    user = _seed(db_session)
    resp = _run(get_analysis_columns(project_id=900, user=user, db=db_session))

    demo_ids = {d.id for d in resp.demographics}
    assert 9001 in demo_ids   # Department (nominal) — now groupable (#371)
    assert 9003 in demo_ids   # Gender (demographic) — still groupable
    assert 9002 not in demo_ids  # Salary (numeric) — not a grouping candidate


def test_nominal_column_still_selectable_as_metric_input(db_session):
    """Adding nominal to the group-by list must not remove it from the per-dataset
    selectable columns (it's still a valid frequency-metric input)."""
    user = _seed(db_session)
    resp = _run(get_analysis_columns(project_id=900, user=user, db=db_session))

    all_column_ids = {c.id for ds in resp.datasets for c in ds.columns}
    assert 9001 in all_column_ids   # Department still selectable
    assert 9002 in all_column_ids   # Salary still selectable
    # Demographic columns are intentionally NOT in the per-dataset column list.
    assert 9003 not in all_column_ids
