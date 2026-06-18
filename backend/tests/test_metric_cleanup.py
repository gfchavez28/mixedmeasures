import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import pytest
from datetime import datetime, timedelta, timezone

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.services.metric_cleanup import cleanup_auto_metrics, _last_cleanup, _RETENTION_DAYS


@pytest.fixture(autouse=True)
def reset_throttle():
    """Clear the module-level throttle dict between tests."""
    _last_cleanup.clear()


def _old_timestamp():
    """Return a naive UTC datetime older than the retention period."""
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=_RETENTION_DAYS + 1)


def _recent_timestamp():
    """Return a naive UTC datetime within the retention period."""
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)


def _setup_project(db, project_id=1):
    project = Project(id=project_id, name=f"Project {project_id}", user_id=1)
    db.add(project)
    dataset = Dataset(id=project_id, project_id=project_id, name="DS")
    db.add(dataset)
    col = DatasetColumn(
        id=project_id, dataset_id=project_id, column_code="Q1", column_text="Q1",
        column_type="ordinal", sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()
    return project, dataset, col


def test_cleanup_deletes_old_auto(db_session):
    _setup_project(db_session)

    m = MetricDefinition(
        id=1, project_id=1, name="Old Auto", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1,
        origin="auto", last_accessed_at=_old_timestamp(), stale=False,
    )
    db_session.add(m)
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 1

    assert db_session.get(MetricDefinition, 1) is None


def test_cleanup_preserves_recent(db_session):
    _setup_project(db_session)

    m = MetricDefinition(
        id=1, project_id=1, name="Recent", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1,
        origin="auto", last_accessed_at=_recent_timestamp(), stale=False,
    )
    db_session.add(m)
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 0
    assert db_session.get(MetricDefinition, 1) is not None


def test_cleanup_preserves_manual(db_session):
    _setup_project(db_session)

    m = MetricDefinition(
        id=1, project_id=1, name="Manual Old", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1,
        origin="manual", last_accessed_at=_old_timestamp(), stale=False,
    )
    db_session.add(m)
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 0
    assert db_session.get(MetricDefinition, 1) is not None


def test_cleanup_preserves_with_test_ref(db_session):
    _setup_project(db_session)

    m = MetricDefinition(
        id=1, project_id=1, name="Protected", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1,
        origin="auto", last_accessed_at=_old_timestamp(), stale=False,
    )
    db_session.add(m)

    t = StatisticalTest(
        id=1, project_id=1, test_type="independent_t_test",
        target_type="metric_definition", target_id=1, stale=False,
    )
    db_session.add(t)
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 0
    assert db_session.get(MetricDefinition, 1) is not None


def test_cleanup_returns_count(db_session):
    _setup_project(db_session)

    for i in range(1, 4):
        db_session.add(MetricDefinition(
            id=i, project_id=1, name=f"M{i}", metric_type="mean", config="{}",
            input_source_type="dataset_column", input_source_id=1,
            origin="auto", last_accessed_at=_old_timestamp(), stale=False,
        ))
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 3


def test_cleanup_project_scoped(db_session):
    _setup_project(db_session, project_id=1)
    _setup_project(db_session, project_id=2)

    db_session.add(MetricDefinition(
        id=1, project_id=1, name="P1 Old", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1,
        origin="auto", last_accessed_at=_old_timestamp(), stale=False,
    ))
    db_session.add(MetricDefinition(
        id=2, project_id=2, name="P2 Old", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=2,
        origin="auto", last_accessed_at=_old_timestamp(), stale=False,
    ))
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 1

    # Project 2's metric should still exist
    assert db_session.get(MetricDefinition, 2) is not None


def test_cleanup_null_last_accessed_treated_as_old(db_session):
    """Metrics with no last_accessed_at should be cleaned up."""
    _setup_project(db_session)

    m = MetricDefinition(
        id=1, project_id=1, name="No Access", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1,
        origin="auto", last_accessed_at=None, stale=False,
    )
    db_session.add(m)
    db_session.flush()

    deleted = cleanup_auto_metrics(db_session, project_id=1)
    assert deleted == 1
