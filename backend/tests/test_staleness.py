import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.services.staleness import mark_metrics_stale


def _setup_staleness_data(db):
    """Create a project with 3 columns, 1 domain (2 members), 3 metrics, 2 stat tests.

    Layout:
      col1 (id=1), col2 (id=2) -> domain (id=1)
      col3 (id=3) -> standalone (not in domain)

      metric1 (id=1): column-sourced from col1
      metric2 (id=2): column-sourced from col3, grouped by col2
      metric3 (id=3): domain-sourced from domain1

      test1 (id=1): targets metric1  (metric_definition)
      test2 (id=2): targets domain1  (analysis_domain)
    """
    project = Project(id=1, name="Staleness Test", user_id=1)
    db.add(project)

    dataset = Dataset(id=1, project_id=1, name="Survey")
    db.add(dataset)

    col1 = DatasetColumn(id=1, dataset_id=1, column_code="Q1", column_text="Q1",
                         column_type="ordinal", sequence_order=0, display_order=0)
    col2 = DatasetColumn(id=2, dataset_id=1, column_code="Q2", column_text="Q2",
                         column_type="ordinal", sequence_order=1, display_order=1)
    col3 = DatasetColumn(id=3, dataset_id=1, column_code="Q3", column_text="Q3",
                         column_type="ordinal", sequence_order=2, display_order=2)
    db.add_all([col1, col2, col3])

    domain = AnalysisDomain(id=1, project_id=1, name="Domain A")
    db.add(domain)
    db.add(AnalysisDomainMember(domain_id=1, member_type="column", member_id=1, sequence_order=0))
    db.add(AnalysisDomainMember(domain_id=1, member_type="column", member_id=2, sequence_order=1))
    db.flush()

    metric1 = MetricDefinition(
        id=1, project_id=1, name="M1", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=1, stale=False, origin="auto",
    )
    metric2 = MetricDefinition(
        id=2, project_id=1, name="M2", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=3,
        grouping_column_id=2, stale=False, origin="auto",
    )
    metric3 = MetricDefinition(
        id=3, project_id=1, name="M3", metric_type="domain_aggregate", config="{}",
        input_source_type="dataset_domain", input_source_id=1, stale=False, origin="auto",
    )
    db.add_all([metric1, metric2, metric3])

    test1 = StatisticalTest(
        id=1, project_id=1, test_type="independent_t_test",
        target_type="metric_definition", target_id=1, stale=False,
    )
    test2 = StatisticalTest(
        id=2, project_id=1, test_type="cronbachs_alpha",
        target_type="analysis_domain", target_id=1, stale=False,
    )
    db.add_all([test1, test2])
    db.flush()


def test_stale_by_column_input(db_session):
    _setup_staleness_data(db_session)

    mark_metrics_stale(db_session, project_id=1, column_ids=[1])

    m1 = db_session.get(MetricDefinition, 1)
    assert m1.stale is True


def test_stale_by_grouping_column(db_session):
    _setup_staleness_data(db_session)

    # col2 is the grouping column for metric2
    mark_metrics_stale(db_session, project_id=1, column_ids=[2])

    m2 = db_session.get(MetricDefinition, 2)
    assert m2.stale is True


def test_stale_by_domain_input(db_session):
    _setup_staleness_data(db_session)

    mark_metrics_stale(db_session, project_id=1, domain_ids=[1])

    m3 = db_session.get(MetricDefinition, 3)
    assert m3.stale is True


def test_stale_cascades_to_stat_tests(db_session):
    _setup_staleness_data(db_session)

    # col1 is input for metric1, which is targeted by test1
    mark_metrics_stale(db_session, project_id=1, column_ids=[1])

    t1 = db_session.get(StatisticalTest, 1)
    assert t1.stale is True

    # col1 is in domain1, which is targeted by test2
    t2 = db_session.get(StatisticalTest, 2)
    assert t2.stale is True


def test_stale_unrelated_preserved(db_session):
    _setup_staleness_data(db_session)

    # Only mark col3 stale — should not affect metric1 (col1) or metric3 (domain)
    mark_metrics_stale(db_session, project_id=1, column_ids=[3])

    m1 = db_session.get(MetricDefinition, 1)
    assert m1.stale is False

    m3 = db_session.get(MetricDefinition, 3)
    assert m3.stale is False

    # metric2 is col3-sourced, so it should be stale
    m2 = db_session.get(MetricDefinition, 2)
    assert m2.stale is True

    # test1 targets metric1 which is not affected
    t1 = db_session.get(StatisticalTest, 1)
    assert t1.stale is False


def test_stale_returns_count(db_session):
    _setup_staleness_data(db_session)

    # col1 affects metric1 (column input) + metric3 (domain cascade) = 2 metrics
    count = mark_metrics_stale(db_session, project_id=1, column_ids=[1])
    assert count >= 2


def test_stale_domain_cascades_to_column_metrics(db_session):
    """When domain_ids given, column metrics for member columns also marked stale."""
    _setup_staleness_data(db_session)

    mark_metrics_stale(db_session, project_id=1, domain_ids=[1])

    # metric1 is sourced from col1, which is a member of domain1
    m1 = db_session.get(MetricDefinition, 1)
    assert m1.stale is True

    # metric3 is domain-sourced from domain1
    m3 = db_session.get(MetricDefinition, 3)
    assert m3.stale is True


def test_stale_already_stale_not_double_counted(db_session):
    """Metrics that are already stale should not be counted again."""
    _setup_staleness_data(db_session)

    count1 = mark_metrics_stale(db_session, project_id=1, column_ids=[1])
    count2 = mark_metrics_stale(db_session, project_id=1, column_ids=[1])
    # Second call should find 0 newly stale (they were already stale)
    assert count2 == 0


def test_stale_different_project_not_affected(db_session):
    """Metrics in a different project should not be touched."""
    _setup_staleness_data(db_session)

    # Add a second project with its own metric on the same column id
    project2 = Project(id=2, name="Other", user_id=1)
    db_session.add(project2)
    ds2 = Dataset(id=2, project_id=2, name="Other DS")
    db_session.add(ds2)
    col2p = DatasetColumn(id=10, dataset_id=2, column_code="Q1", column_text="Q1",
                          column_type="ordinal", sequence_order=0, display_order=0)
    db_session.add(col2p)
    db_session.flush()

    m_other = MetricDefinition(
        id=10, project_id=2, name="Other M", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=10, stale=False, origin="auto",
    )
    db_session.add(m_other)
    db_session.flush()

    mark_metrics_stale(db_session, project_id=1, column_ids=[1])

    m_other = db_session.get(MetricDefinition, 10)
    assert m_other.stale is False
