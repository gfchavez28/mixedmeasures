"""Tests for equivalence group domain aggregation and alpha collapsing."""
import json
import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.models.row_score import RowScore
from app.services.metrics import compute_metric
from app.services.statistical_tests import compute_statistical_test


@pytest.fixture
def equivalence_fixture(db_session):
    """Two datasets (Board + Staff) with 2 questions linked by equivalence groups."""
    db = db_session
    project = Project(id=200, name="Equivalence Test", user_id=1)
    db.add(project)

    board_ds = Dataset(id=200, project_id=200, name="Board Survey")
    staff_ds = Dataset(id=201, project_id=200, name="Staff Survey")
    db.add_all([board_ds, staff_ds])

    eq1 = EquivalenceGroup(id=300, project_id=200, label="Q1 Leadership Vision")
    eq2 = EquivalenceGroup(id=301, project_id=200, label="Q2 Leadership Communication")
    db.add_all([eq1, eq2])

    board_q1 = DatasetColumn(
        id=2001, dataset_id=200, column_code="Q1", column_name="Q1",
        column_text="Leadership Vision", column_type="ordinal",
        sequence_order=0, display_order=0, equivalence_group_id=300,
    )
    board_q2 = DatasetColumn(
        id=2002, dataset_id=200, column_code="Q2", column_name="Q2",
        column_text="Leadership Communication", column_type="ordinal",
        sequence_order=1, display_order=1, equivalence_group_id=301,
    )
    staff_q1 = DatasetColumn(
        id=2003, dataset_id=201, column_code="Q1", column_name="Q1",
        column_text="Leadership Vision", column_type="ordinal",
        sequence_order=0, display_order=0, equivalence_group_id=300,
    )
    staff_q2 = DatasetColumn(
        id=2004, dataset_id=201, column_code="Q2", column_name="Q2",
        column_text="Leadership Communication", column_type="ordinal",
        sequence_order=1, display_order=1, equivalence_group_id=301,
    )
    db.add_all([board_q1, board_q2, staff_q1, staff_q2])

    domain = AnalysisDomain(id=400, project_id=200, name="Leadership")
    db.add(domain)
    for i, cid in enumerate([2001, 2002, 2003, 2004]):
        db.add(AnalysisDomainMember(
            domain_id=400, member_type="column", member_id=cid, sequence_order=i,
        ))
    db.flush()

    BOARD_Q1 = [5, 4, 5, 3, 4]
    BOARD_Q2 = [4, 4, 3, 5, 4]
    STAFF_Q1 = [2, 3, 2, 4]
    STAFF_Q2 = [3, 2, 3, 2]

    vid = 20000
    for i in range(5):
        db.add(DatasetRow(id=6000 + i, dataset_id=200))
        vid += 1
        db.add(DatasetValue(id=vid, row_id=6000 + i, column_id=2001,
                            value_text=str(BOARD_Q1[i]), value_numeric=float(BOARD_Q1[i])))
        vid += 1
        db.add(DatasetValue(id=vid, row_id=6000 + i, column_id=2002,
                            value_text=str(BOARD_Q2[i]), value_numeric=float(BOARD_Q2[i])))

    for i in range(4):
        db.add(DatasetRow(id=7000 + i, dataset_id=201))
        vid += 1
        db.add(DatasetValue(id=vid, row_id=7000 + i, column_id=2003,
                            value_text=str(STAFF_Q1[i]), value_numeric=float(STAFF_Q1[i])))
        vid += 1
        db.add(DatasetValue(id=vid, row_id=7000 + i, column_id=2004,
                            value_text=str(STAFF_Q2[i]), value_numeric=float(STAFF_Q2[i])))

    db.flush()
    return {
        "project_id": 200, "domain_id": 400,
        "board_q1_id": 2001, "board_q2_id": 2002,
        "staff_q1_id": 2003, "staff_q2_id": 2004,
    }


def test_domain_aggregate(equivalence_fixture, db_session):
    """Domain aggregate = mean of 4 column means across 2 datasets."""
    f = equivalence_fixture
    metric = MetricDefinition(
        project_id=f["project_id"], name="Leadership",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=f["domain_id"],
        config='{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}',
    )
    db_session.add(metric)
    db_session.flush()

    results = compute_metric(db_session, metric)
    data = json.loads(results[0].result_data)

    assert data["aggregate_value"] == pytest.approx(3.3625, abs=0.001)
    assert data["column_count"] == 4


def test_row_scores(equivalence_fixture, db_session):
    """Per-row scores: Board rows use Board columns only, Staff use Staff only."""
    f = equivalence_fixture
    metric = MetricDefinition(
        project_id=f["project_id"], name="Leadership",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=f["domain_id"],
        config='{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}',
    )
    db_session.add(metric)
    db_session.flush()
    compute_metric(db_session, metric)

    scores = {
        s.dataset_row_id: s.score
        for s in db_session.query(RowScore)
        .filter(RowScore.metric_definition_id == metric.id)
        .all()
    }

    expected = {
        6000: 4.5, 6001: 4.0, 6002: 4.0, 6003: 4.0, 6004: 4.0,
        7000: 2.5, 7001: 2.5, 7002: 2.5, 7003: 3.0,
    }
    assert len(scores) == 9
    for row_id, expected_score in expected.items():
        assert scores[row_id] == pytest.approx(expected_score, abs=0.001), \
            f"Row {row_id}: {scores[row_id]} != {expected_score}"


def test_child_results(equivalence_fixture, db_session):
    """Child results contain per-column means for all 4 columns."""
    f = equivalence_fixture
    metric = MetricDefinition(
        project_id=f["project_id"], name="Leadership",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=f["domain_id"],
        config='{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}',
    )
    db_session.add(metric)
    db_session.flush()

    results = compute_metric(db_session, metric)
    data = json.loads(results[0].result_data)
    child = data["child_results"]

    assert child[str(f["board_q1_id"])]["mean"] == pytest.approx(4.2, abs=0.001)
    assert child[str(f["board_q2_id"])]["mean"] == pytest.approx(4.0, abs=0.001)
    assert child[str(f["staff_q1_id"])]["mean"] == pytest.approx(2.75, abs=0.001)
    assert child[str(f["staff_q2_id"])]["mean"] == pytest.approx(2.5, abs=0.001)


def test_single_equivalence_group_domain(equivalence_fixture, db_session):
    """Domain with only Q1 columns (2 columns, 1 equivalence group)."""
    f = equivalence_fixture
    domain = AnalysisDomain(id=401, project_id=f["project_id"], name="Vision Only")
    db_session.add(domain)
    db_session.add(AnalysisDomainMember(
        domain_id=401, member_type="column", member_id=f["board_q1_id"], sequence_order=0,
    ))
    db_session.add(AnalysisDomainMember(
        domain_id=401, member_type="column", member_id=f["staff_q1_id"], sequence_order=1,
    ))
    db_session.flush()

    metric = MetricDefinition(
        project_id=f["project_id"], name="Vision Only",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=401,
        config='{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}',
    )
    db_session.add(metric)
    db_session.flush()

    results = compute_metric(db_session, metric)
    data = json.loads(results[0].result_data)

    # mean(4.2, 2.75) = 3.475
    assert data["aggregate_value"] == pytest.approx(3.475, abs=0.001)
    assert data["column_count"] == 2


def test_alpha_equivalence_collapsing(equivalence_fixture, db_session):
    """Cronbach's alpha collapses 4 columns into 2 logical items via equivalence groups."""
    f = equivalence_fixture
    test = StatisticalTest(
        project_id=f["project_id"],
        test_type="cronbachs_alpha",
        target_type="analysis_domain",
        target_id=f["domain_id"],
        config="{}",
    )
    db_session.add(test)
    db_session.flush()

    result = compute_statistical_test(db_session, test)

    # 4 columns → 2 equivalence groups → k=2 logical items
    assert result["k"] == 2
    assert result["n"] == 9  # 5 Board + 4 Staff, all with both items
    # Alpha is low (~0.26) because Board and Staff populations differ greatly
    assert result["alpha"] == pytest.approx(0.2553, abs=0.005)
