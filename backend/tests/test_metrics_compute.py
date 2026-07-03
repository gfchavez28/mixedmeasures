"""Tests for metrics computation service (Board 360 data)."""
import json
import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.models.row_score import RowScore
from app.services.metrics import compute_metric
from tests.conftest import (
    BOARD_COL9, BOARD_COL10, BOARD_COL11, BOARD_COL12, BOARD_COL13,
    BOARD_GENDER, RECODE_MAP, NA_VALUE,
)


def _setup_board(db):
    """Populate the DB with Board 360 data (20 rows, 5+1 columns)."""
    project = Project(id=1, name="Board 360", user_id=1)
    db.add(project)

    dataset = Dataset(id=1, project_id=1, name="Board Survey")
    db.add(dataset)

    columns_data = [
        (1, "col9", "Vision and strategy", BOARD_COL9),
        (2, "col10", "Measurable goals", BOARD_COL10),
        (3, "col11", "Communicating vision", BOARD_COL11),
        (4, "col12", "Building relationships", BOARD_COL12),
        (5, "col13", "Pivoting/adapting", BOARD_COL13),
    ]

    col_objects = {}
    for col_id, code, text, _ in columns_data:
        col = DatasetColumn(
            id=col_id, dataset_id=1, column_code=code,
            column_name=code, column_text=text, column_type="ordinal",
            sequence_order=col_id - 1, display_order=col_id - 1,
            scale_labels=json.dumps(["Poor", "Fair", "Good", "Very Good", "Excellent"]),
            scale_values=json.dumps([1, 2, 3, 4, 5]),
            scale_points=5,
        )
        db.add(col)
        col_objects[code] = col

    gender_col = DatasetColumn(
        id=6, dataset_id=1, column_code="gender",
        column_name="gender", column_text="Gender", column_type="demographic",
        demographic_subtype="gender",
        sequence_order=5, display_order=5,
    )
    db.add(gender_col)
    col_objects["gender"] = gender_col

    db.flush()

    val_id = 0
    for row_idx in range(20):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        db.add(dr)

        for col_id, code, text, values in columns_data:
            label = values[row_idx]
            val_id += 1
            dv = DatasetValue(
                id=val_id, row_id=dr.id,
                column_id=col_objects[code].id,
                value_text=label,
                value_numeric=RECODE_MAP.get(label),
            )
            db.add(dv)

        # Gender
        val_id += 1
        gender_val = BOARD_GENDER[row_idx]
        dv = DatasetValue(
            id=val_id, row_id=dr.id,
            column_id=gender_col.id,
            value_text=gender_val if gender_val else None,
            value_numeric=None,
        )
        db.add(dv)

    db.flush()
    return col_objects


def test_frequency_normal(db_session):
    db = db_session
    cols = _setup_board(db)

    metric = MetricDefinition(
        project_id=1, name="Col 9 Freq",
        metric_type="frequency_distribution",
        input_source_type="dataset_column",
        input_source_id=cols["col9"].id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    results = compute_metric(db, metric)
    assert len(results) == 1
    data = json.loads(results[0].result_data)

    assert data["counts"]["Excellent"] == 9
    assert data["counts"]["Very Good"] == 9
    assert data["counts"]["Good"] == 2
    assert results[0].valid_n == 20
    assert results[0].total_n == 20


def test_na_exclusion_mean(db_session):
    db = db_session
    cols = _setup_board(db)

    metric = MetricDefinition(
        project_id=1, name="Col 12 Mean",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=cols["col12"].id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    results = compute_metric(db, metric)
    assert len(results) == 1

    data = json.loads(results[0].result_data)
    assert results[0].valid_n == 17
    assert data["mean"] == pytest.approx(4.3529, abs=0.001)
    assert data["std_dev"] == pytest.approx(0.7019, abs=0.001)


def test_grouped_mean(db_session):
    db = db_session
    cols = _setup_board(db)

    metric = MetricDefinition(
        project_id=1, name="Col 9 by Gender",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=cols["col9"].id,
        grouping_column_id=cols["gender"].id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    results = compute_metric(db, metric)
    by_group = {r.group_value: json.loads(r.result_data) for r in results}

    # #384: "Decline to state" is a recognized N/A → treated as missing, so it
    # is NOT a labeled group; those rows fold into the None (missing) group, the
    # same idiom used for a truly-missing grouping value.
    assert "Decline to state" not in by_group

    expected = {
        "Female": {"n": 10, "mean": 4.3000, "std_dev": 0.4830},
        "Male": {"n": 4, "mean": 4.7500, "std_dev": 0.5000},
    }
    for group, exp in expected.items():
        assert group in by_group, f"Missing group: {group}"
        data = by_group[group]
        result_obj = next(r for r in results if r.group_value == group)
        assert result_obj.valid_n == exp["n"]
        assert data["mean"] == pytest.approx(exp["mean"], abs=0.001)
        assert data["std_dev"] == pytest.approx(exp["std_dev"], abs=0.001)

    # The former "Decline to state" rows now sit in the None/missing group
    # (alongside any truly-missing-gender rows), not in a labeled group.
    assert None in by_group
    none_result = next(r for r in results if r.group_value is None)
    assert none_result.valid_n >= 2


def test_summary_real_group_count_excludes_none_bucket(db_session):
    """#506: the metrics-list summary must report REAL groups (non-null
    group_value) separately from result_count, which also counts the None
    listwise-deletion bucket. Gender here has exactly 2 real groups
    (Female, Male) + a None bucket — the t-vs-ANOVA boundary the bug broke.
    """
    import asyncio
    from app.models.user import User
    from app.routers.metrics import list_metrics

    db = db_session
    cols = _setup_board(db)

    metric = MetricDefinition(
        project_id=1, name="Col 9 by Gender",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=cols["col9"].id,
        grouping_column_id=cols["gender"].id,
        config="{}",
    )
    db.add(metric)
    db.flush()
    compute_metric(db, metric)

    user = db.get(User, 1)
    resp = asyncio.run(list_metrics(1, user=user, db=db))
    summary = next(m for m in resp.metrics if m.id == metric.id)

    assert summary.result_count == 3  # Female, Male, None bucket
    assert summary.real_group_count == 2  # the count test pickers must use


# ── #384: recognized N/A excluded from all grouping paths ────────────────────

def test_load_grouping_values_excludes_na(db_session):
    db = db_session
    cols = _setup_board(db)
    from app.services.grouping import load_grouping_values
    row_ids = [r.id for r in db.query(DatasetRow).all()]
    gmap = load_grouping_values(db, cols["gender"].id, row_ids)
    assert "Decline to state" not in set(gmap.values())
    assert {"Female", "Male"} <= set(gmap.values())


def test_cross_tabulation_excludes_na(db_session):
    db = db_session
    cols = _setup_board(db)
    from app.services.cross_tabulation import compute_cross_tabulation
    # gender (rows) × col9 (cols); gender carries the N/A "Decline to state"
    ct = compute_cross_tabulation(db, 1, cols["gender"].id, cols["col9"].id, include_chi_square=False)
    assert "Decline to state" not in ct["row_values"]
    assert "Female" in ct["row_values"]


def test_group_comparison_excludes_na(db_session):
    db = db_session
    cols = _setup_board(db)
    from app.services.comparisons import compute_group_comparison
    gc = compute_group_comparison(
        db, 1, column_ids=[cols["col9"].id], domain_ids=[],
        grouping_column_id=cols["gender"].id, grouping_column_id_2=None,
        test_type="auto", include_effect_size_ci=False,
    )
    assert "Decline to state" not in gc["groups"]
    assert "Female" in gc["groups"]


def test_scatter_grouping_excludes_na(db_session):
    db = db_session
    cols = _setup_board(db)
    from app.services.correlations import compute_scatter_data
    sd = compute_scatter_data(
        db, 1, cols["col9"].id, cols["col10"].id,
        id_type="column", group_column_id=cols["gender"].id,
    )
    assert sd["groups"] is not None
    assert "Decline to state" not in set(sd["groups"])


def test_domain_aggregate(db_session):
    db = db_session
    cols = _setup_board(db)

    domain = AnalysisDomain(id=1, project_id=1, name="Vision & Strategy")
    db.add(domain)

    col_keys = ["col9", "col10", "col11", "col12", "col13"]
    for seq, key in enumerate(col_keys):
        member = AnalysisDomainMember(
            domain_id=1, member_type="column",
            member_id=cols[key].id, sequence_order=seq,
        )
        db.add(member)
    db.flush()

    metric = MetricDefinition(
        project_id=1, name="V&S Domain",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        config='{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}',
    )
    db.add(metric)
    db.flush()

    results = compute_metric(db, metric)
    assert len(results) == 1

    data = json.loads(results[0].result_data)
    # aggregate_value is mean of per-column means:
    # col9=4.35, col10=3.95, col11=4.50, col12=4.3529, col13=4.55
    # → mean = 4.3406
    assert data["aggregate_value"] == pytest.approx(4.3406, abs=0.001)
    assert data["column_count"] == 5

    # Check per-row scores (mean of valid items per row)
    scores = (
        db.query(RowScore)
        .filter(RowScore.metric_definition_id == metric.id)
        .order_by(RowScore.dataset_row_id)
        .all()
    )
    assert len(scores) == 20

    expected_scores = [
        5.0000, 5.0000, 4.7500, 4.6000, 4.0000,
        3.2000, 3.6000, 4.4000, 4.0000, 4.8000,
        4.7500, 4.2000, 4.4000, 4.2000, 5.0000,
        4.2500, 3.8000, 4.2000, 5.0000, 3.8000,
    ]
    for score, expected in zip(scores, expected_scores):
        assert score.score == pytest.approx(expected, abs=0.001)


def test_all_na_column(db_session):
    db = db_session
    project = Project(id=1, name="Edge Test", user_id=1)
    db.add(project)
    dataset = Dataset(id=1, project_id=1, name="Edge")
    db.add(dataset)
    col = DatasetColumn(
        id=1, dataset_id=1, column_code="q1",
        column_text="Q1", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()

    for i in range(5):
        dr = DatasetRow(id=i + 1, dataset_id=1)
        db.add(dr)
        dv = DatasetValue(
            id=i + 1, row_id=dr.id, column_id=col.id,
            value_text=NA_VALUE, value_numeric=None,
        )
        db.add(dv)
    db.flush()

    metric = MetricDefinition(
        project_id=1, name="All NA Mean",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=col.id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    results = compute_metric(db, metric)
    assert len(results) == 1
    assert results[0].valid_n == 0


def test_empty_column(db_session):
    db = db_session
    project = Project(id=1, name="Edge Test", user_id=1)
    db.add(project)
    dataset = Dataset(id=1, project_id=1, name="Edge")
    db.add(dataset)
    col = DatasetColumn(
        id=1, dataset_id=1, column_code="q1",
        column_text="Q1", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()

    metric = MetricDefinition(
        project_id=1, name="Empty Mean",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=col.id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    results = compute_metric(db, metric)
    assert len(results) == 1
    assert results[0].valid_n == 0
