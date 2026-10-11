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


def test_a_membership_edit_marks_the_group_not_its_members_metrics(db_session):
    """#1149 — `domain_ids` reaches the group's own metrics and tests only.

    This test asserted the opposite until 2026-10-10 (arm (d)): a membership edit
    marked every member column's metric stale, and `compute_metric` then marked
    that metric's t-test stale, although no member's cells had moved. The false
    marker is the fault, so the inverted assertion is the guard.
    """
    _setup_staleness_data(db_session)

    mark_metrics_stale(db_session, project_id=1, domain_ids=[1])

    # metric3 is domain-sourced from domain1, and the α test targets domain1
    assert db_session.get(MetricDefinition, 3).stale is True
    assert db_session.get(StatisticalTest, 2).stale is True
    # metric1 is sourced from col1, a MEMBER of domain1 — its input did not move
    assert db_session.get(MetricDefinition, 1).stale is False
    assert db_session.get(StatisticalTest, 1).stale is False


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


# ── #1168 door 8 — a grouped variable-group metric's SIBLING grouping columns ──


def _sibling_world(db):
    """Two datasets, one variable group over a paired item, grouped by role.

    Layout (project 20):
      wave1 (id=20): item Q (201, numeric), role (202, demographic "Role"),
                     region (203, demographic "Region")
      wave2 (id=21): item Q (211, numeric, paired with 201), role (212,
                     demographic "Role" — the anchor's sibling by name),
                     notes (213, numeric — in no group, nobody's sibling)

      group (id=20): members 201, 211
      metric 20: domain_aggregate over group 20, grouped by 202 (the anchor)
      test 20:   t-test on metric 20
    """
    from app.models.dataset import ColumnType
    from app.models.equivalence_group import EquivalenceGroup

    db.add(Project(id=20, name="Siblings", user_id=1))
    db.add_all([
        Dataset(id=20, project_id=20, name="Wave 1"),
        Dataset(id=21, project_id=20, name="Wave 2"),
    ])
    db.add(EquivalenceGroup(id=20, project_id=20, label="Q"))
    db.flush()

    def col(cid, ds, code, ctype, name=None, eg=None, order=0):
        return DatasetColumn(
            id=cid, dataset_id=ds, column_code=code, column_text=code,
            column_name=name, column_type=ctype, equivalence_group_id=eg,
            sequence_order=order, display_order=order,
        )

    db.add_all([
        col(201, 20, "Q", ColumnType.NUMERIC, eg=20, order=0),
        col(202, 20, "ROLE", ColumnType.DEMOGRAPHIC, name="Role", order=1),
        col(203, 20, "REGION", ColumnType.DEMOGRAPHIC, name="Region", order=2),
        col(211, 21, "Q", ColumnType.NUMERIC, eg=20, order=0),
        col(212, 21, "ROLE", ColumnType.DEMOGRAPHIC, name="Role", order=1),
        col(213, 21, "NOTES", ColumnType.NUMERIC, name="Notes", order=2),
    ])
    db.add(AnalysisDomain(id=20, project_id=20, name="Wellbeing"))
    db.flush()
    db.add_all([
        AnalysisDomainMember(domain_id=20, member_type="column", member_id=201, sequence_order=0),
        AnalysisDomainMember(domain_id=20, member_type="column", member_id=211, sequence_order=1),
    ])
    db.add(MetricDefinition(
        id=20, project_id=20, name="Wellbeing by role", metric_type="domain_aggregate",
        config="{}", input_source_type="dataset_domain", input_source_id=20,
        grouping_column_id=202, stale=False, origin="auto",
    ))
    db.add(StatisticalTest(
        id=20, project_id=20, test_type="independent_t_test",
        target_type="metric_definition", target_id=20, stale=False,
    ))
    db.flush()


def test_a_sibling_grouping_column_edit_marks_the_grouped_group_metric(db_session):
    """The metric groups wave 2's rows by wave 2's Role (a sibling by name), so an
    edit to those cells moves its groups. Arm (b) knew only the anchor (202)."""
    _sibling_world(db_session)

    mark_metrics_stale(db_session, project_id=20, column_ids=[212])

    assert db_session.get(MetricDefinition, 20).stale is True
    assert db_session.get(StatisticalTest, 20).stale is True


def test_an_unrelated_column_in_the_sibling_dataset_does_not_mark_it(db_session):
    """Over-mark falsifier: same dataset as the sibling, in no group, nobody's
    sibling — and a demographic in the anchor's dataset that is not the anchor."""
    _sibling_world(db_session)

    mark_metrics_stale(db_session, project_id=20, column_ids=[213, 203])

    assert db_session.get(MetricDefinition, 20).stale is False
    assert db_session.get(StatisticalTest, 20).stale is False


def test_a_dataset_grouped_metric_has_no_grouping_columns(db_session):
    """`grouping_mode="dataset"` groups by dataset NAME; a demographic edit cannot
    move it even when `grouping_column_id` is set on the row."""
    from app.services.metrics import effective_grouping_column_ids

    _sibling_world(db_session)
    metric = db_session.get(MetricDefinition, 20)
    metric.grouping_mode = "dataset"
    db_session.flush()

    assert effective_grouping_column_ids(db_session, metric) == set()
    mark_metrics_stale(db_session, project_id=20, column_ids=[212])
    assert db_session.get(MetricDefinition, 20).stale is False


def test_a_subtype_edit_that_creates_a_sibling_marks_the_metric(db_session):
    """Metadata door: `mark_regrouped_metrics_stale` compares the grouping sets.
    Renaming wave 2's Role takes it out of the match; giving both a subtype
    brings it back through tier 2."""
    from app.services.staleness import grouping_sets, mark_regrouped_metrics_stale

    _sibling_world(db_session)
    db_session.get(DatasetColumn, 212).column_name = "Job"
    db_session.flush()

    before = grouping_sets(db_session, 20)
    assert before[20] == frozenset({202})
    db_session.get(DatasetColumn, 202).demographic_subtype = "role"
    db_session.get(DatasetColumn, 212).demographic_subtype = "role"
    marked = mark_regrouped_metrics_stale(db_session, 20, before)

    assert marked == 1
    assert db_session.get(MetricDefinition, 20).stale is True
    assert db_session.get(StatisticalTest, 20).stale is True


def test_a_metadata_edit_that_changes_no_grouping_marks_nothing(db_session):
    """Over-mark falsifier for the metadata marker: renaming the unrelated
    column changes no grouping set."""
    from app.services.staleness import grouping_sets, mark_regrouped_metrics_stale

    _sibling_world(db_session)
    before = grouping_sets(db_session, 20)
    db_session.get(DatasetColumn, 213).column_name = "Role notes"

    assert mark_regrouped_metrics_stale(db_session, 20, before) == 0
    assert db_session.get(MetricDefinition, 20).stale is False


def test_a_pairing_change_marks_the_groups_reliability_test_not_its_scale_score(db_session):
    """α collapses paired columns into one item, so re-pairing a member re-shapes
    its item matrix; the scale score averages a record's own items and does not
    read the pairing."""
    from app.services.staleness import grouping_sets, mark_pairing_stale

    _sibling_world(db_session)
    db_session.add(StatisticalTest(
        id=21, project_id=20, test_type="cronbachs_alpha",
        target_type="analysis_domain", target_id=20, stale=False,
    ))
    db_session.flush()
    before = grouping_sets(db_session, 20)
    db_session.get(DatasetColumn, 211).equivalence_group_id = None

    mark_pairing_stale(db_session, 20, [211], before)

    assert db_session.get(StatisticalTest, 21).stale is True
    assert db_session.get(MetricDefinition, 20).stale is False


def test_a_rename_marks_only_dataset_grouped_group_metrics(db_session):
    from app.services.staleness import mark_dataset_grouped_metrics_stale

    _sibling_world(db_session)
    db_session.add(MetricDefinition(
        id=21, project_id=20, name="Wellbeing by wave", metric_type="domain_aggregate",
        config="{}", input_source_type="dataset_domain", input_source_id=20,
        grouping_mode="dataset", stale=False, origin="auto",
    ))
    db_session.flush()

    assert mark_dataset_grouped_metrics_stale(db_session, 20, 21) == 1
    assert db_session.get(MetricDefinition, 21).stale is True
    assert db_session.get(MetricDefinition, 20).stale is False


def test_the_install_wide_marker_resolves_each_columns_project(db_session):
    from app.services.staleness import mark_metrics_stale_for_columns

    _setup_staleness_data(db_session)
    _sibling_world(db_session)

    mark_metrics_stale_for_columns(db_session, [1, 212])

    assert db_session.get(MetricDefinition, 1).stale is True   # project 1
    assert db_session.get(MetricDefinition, 20).stale is True  # project 20
    assert db_session.get(MetricDefinition, 2).stale is False
