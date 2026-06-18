"""Tests for statistical_tests service (BFI + mtcars data)."""
import pytest
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.services.statistical_tests import compute_statistical_test
from tests.conftest import BFI_SUBSCALES, MTCARS

# BFI domain IDs match conftest order (dict ordering):
# Agreeableness=1, Conscientiousness=2, Extraversion=3, Neuroticism=4, Openness=5
BFI_DOMAIN_IDS = {
    "Agreeableness": 1,
    "Conscientiousness": 2,
    "Extraversion": 3,
    "Neuroticism": 4,
    "Openness": 5,
}

# Actual service output with listwise deletion on the BFI CSV.
# These differ slightly from R's psych::alpha (pairwise deletion).
EXPECTED_ALPHA = {
    "Agreeableness":     {"alpha": 0.7038, "n": 2709},
    "Conscientiousness": {"alpha": 0.7293, "n": 2707},
    "Extraversion":      {"alpha": 0.7609, "n": 2713},
    "Neuroticism":       {"alpha": 0.8133, "n": 2694},
    "Openness":          {"alpha": 0.6025, "n": 2726},
}

# Actual service output: listwise deletion, odd/even split, Spearman-Brown.
# N values reflect listwise complete cases per subscale.
EXPECTED_SPLIT_HALF = {
    "Agreeableness":     {"split_half_r": 0.544,  "spearman_brown": 0.7046, "n": 2709},
    "Conscientiousness": {"split_half_r": 0.6155, "spearman_brown": 0.762,  "n": 2707},
    "Extraversion":      {"split_half_r": 0.616,  "spearman_brown": 0.7624, "n": 2713},
    "Neuroticism":       {"split_half_r": 0.7293, "spearman_brown": 0.8435, "n": 2694},
    "Openness":          {"split_half_r": 0.4269, "spearman_brown": 0.5984, "n": 2726},
}


@pytest.mark.parametrize("subscale", list(EXPECTED_ALPHA.keys()))
def test_alpha(bfi_session, subscale):
    db = bfi_session
    domain_id = BFI_DOMAIN_IDS[subscale]
    expected = EXPECTED_ALPHA[subscale]

    test = StatisticalTest(
        project_id=1,
        test_type="cronbachs_alpha",
        target_type="analysis_domain",
        target_id=domain_id,
        config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["alpha"] == pytest.approx(expected["alpha"], abs=0.001), \
        f"{subscale} alpha: {result['alpha']} != {expected['alpha']}"
    assert result["k"] == 5
    assert result["n"] == expected["n"]


def test_alpha_constant(db_session):
    """All identical values: total_variance=0 → alpha should be 0."""
    db = db_session
    from app.models.project import Project

    project = Project(id=1, name="Constant", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="Const")
    db.add(ds)

    cols = []
    for i in range(3):
        col = DatasetColumn(
            id=i + 1, dataset_id=1, column_code=f"q{i}",
            column_text=f"q{i}", column_type="ordinal",
            sequence_order=i, display_order=i,
        )
        db.add(col)
        cols.append(col)

    domain = AnalysisDomain(id=1, project_id=1, name="Constant Domain")
    db.add(domain)
    for i, col in enumerate(cols):
        db.add(AnalysisDomainMember(
            domain_id=1, member_type="column", member_id=col.id, sequence_order=i,
        ))
    db.flush()

    val_id = 0
    for row_idx in range(10):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        db.add(dr)
        for col in cols:
            val_id += 1
            dv = DatasetValue(
                id=val_id, row_id=dr.id, column_id=col.id,
                value_text="5", value_numeric=5.0,
            )
            db.add(dv)
    db.flush()

    test = StatisticalTest(
        project_id=1,
        test_type="cronbachs_alpha",
        target_type="analysis_domain",
        target_id=1,
        config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)
    assert result["alpha"] == pytest.approx(0.0, abs=0.001)


def test_alpha_single_item(db_session):
    """k=1: should raise ValueError."""
    db = db_session
    from app.models.project import Project

    project = Project(id=1, name="Single", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="Single")
    db.add(ds)

    col = DatasetColumn(
        id=1, dataset_id=1, column_code="q1",
        column_text="q1", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    db.add(col)

    domain = AnalysisDomain(id=1, project_id=1, name="Single")
    db.add(domain)
    db.add(AnalysisDomainMember(
        domain_id=1, member_type="column", member_id=1, sequence_order=0,
    ))
    db.flush()

    for i in range(5):
        dr = DatasetRow(id=i + 1, dataset_id=1)
        db.add(dr)
        dv = DatasetValue(
            id=i + 1, row_id=dr.id, column_id=1,
            value_text=str(i + 1), value_numeric=float(i + 1),
        )
        db.add(dv)
    db.flush()

    test = StatisticalTest(
        project_id=1,
        test_type="cronbachs_alpha",
        target_type="analysis_domain",
        target_id=1,
        config="{}",
    )
    db.add(test)
    db.flush()

    with pytest.raises(ValueError, match="at least 2 items"):
        compute_statistical_test(db, test)


@pytest.mark.parametrize("subscale", list(EXPECTED_SPLIT_HALF.keys()))
def test_split_half(bfi_session, subscale):
    db = bfi_session
    domain_id = BFI_DOMAIN_IDS[subscale]
    expected = EXPECTED_SPLIT_HALF[subscale]

    test = StatisticalTest(
        project_id=1,
        test_type="split_half",
        target_type="analysis_domain",
        target_id=domain_id,
        config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["split_half_r"] == pytest.approx(expected["split_half_r"], abs=0.001)
    assert result["spearman_brown"] == pytest.approx(expected["spearman_brown"], abs=0.001)
    assert result["n"] == expected["n"]


def _setup_mtcars_for_stat_test(db):
    """Set up mtcars in a fresh db_session for t-test/ANOVA via statistical_tests service."""
    from app.models.project import Project

    project = Project(id=1, name="Mtcars Stat", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="mtcars")
    db.add(ds)

    mpg_col = DatasetColumn(
        id=1, dataset_id=1, column_code="mpg",
        column_name="mpg", column_text="mpg", column_type="numeric",
        sequence_order=0, display_order=0,
    )
    am_col = DatasetColumn(
        id=2, dataset_id=1, column_code="am",
        column_name="am", column_text="am", column_type="nominal",
        sequence_order=1, display_order=1,
    )
    cyl_col = DatasetColumn(
        id=3, dataset_id=1, column_code="cyl",
        column_name="cyl", column_text="cyl", column_type="nominal",
        sequence_order=2, display_order=2,
    )
    db.add(mpg_col)
    db.add(am_col)
    db.add(cyl_col)
    db.flush()

    val_id = 0
    for row_idx, row in enumerate(MTCARS):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        db.add(dr)
        for col, name in [(mpg_col, "mpg"), (am_col, "am"), (cyl_col, "cyl")]:
            val_id += 1
            dv = DatasetValue(
                id=val_id, row_id=dr.id, column_id=col.id,
                value_text=str(row[name]),
                value_numeric=float(row[name]),
            )
            db.add(dv)
    db.flush()
    return mpg_col, am_col, cyl_col


def test_t_test(db_session):
    db = db_session
    mpg_col, am_col, _ = _setup_mtcars_for_stat_test(db)

    metric = MetricDefinition(
        project_id=1, name="mpg by am",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=mpg_col.id,
        grouping_column_id=am_col.id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    test = StatisticalTest(
        project_id=1,
        test_type="independent_t_test",
        target_type="metric_definition",
        target_id=metric.id,
        config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["t_statistic"] == pytest.approx(-3.7671, abs=0.001)
    assert result["df"] == pytest.approx(18.3323, abs=0.1)
    # Service rounds p to STATS_PRECISION=4: round(1.37e-3, 4) = 0.0014
    assert result["p_value"] == pytest.approx(round(1.373638e-03, 4), abs=0.0001)
    assert result["cohens_d"] == pytest.approx(-1.4779, abs=0.01)


def test_t_test_one_group(db_session):
    """Only 1 group: should raise ValueError."""
    db = db_session
    from app.models.project import Project

    project = Project(id=1, name="OneGroup", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="OneGroup")
    db.add(ds)

    val_col = DatasetColumn(
        id=1, dataset_id=1, column_code="val",
        column_name="val", column_text="val", column_type="numeric",
        sequence_order=0, display_order=0,
    )
    group_col = DatasetColumn(
        id=2, dataset_id=1, column_code="group",
        column_name="group", column_text="group", column_type="nominal",
        sequence_order=1, display_order=1,
    )
    db.add(val_col)
    db.add(group_col)
    db.flush()

    for i in range(5):
        dr = DatasetRow(id=i + 1, dataset_id=1)
        db.add(dr)
        dv1 = DatasetValue(
            id=i * 2 + 1, row_id=dr.id, column_id=1,
            value_text=str(float(i)), value_numeric=float(i),
        )
        dv2 = DatasetValue(
            id=i * 2 + 2, row_id=dr.id, column_id=2,
            value_text="A", value_numeric=None,
        )
        db.add(dv1)
        db.add(dv2)
    db.flush()

    metric = MetricDefinition(
        project_id=1, name="one group test",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=1,
        grouping_column_id=2,
        config="{}",
    )
    db.add(metric)
    db.flush()

    test = StatisticalTest(
        project_id=1,
        test_type="independent_t_test",
        target_type="metric_definition",
        target_id=metric.id,
        config="{}",
    )
    db.add(test)
    db.flush()

    with pytest.raises(ValueError, match="exactly 2 groups"):
        compute_statistical_test(db, test)


def test_anova(db_session):
    db = db_session
    mpg_col, _, cyl_col = _setup_mtcars_for_stat_test(db)

    metric = MetricDefinition(
        project_id=1, name="mpg by cyl",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=mpg_col.id,
        grouping_column_id=cyl_col.id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    test = StatisticalTest(
        project_id=1,
        test_type="one_way_anova",
        target_type="metric_definition",
        target_id=metric.id,
        config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["f_statistic"] == pytest.approx(39.6975, abs=0.01)
    assert result["df_between"] == 2
    assert result["df_within"] == 29
    # Service rounds p to STATS_PRECISION=4: round(4.978919e-09, 4) → 0.0
    assert result["p_value"] == round(4.978919e-09, 4)  # exactly 0.0
    assert result["eta_squared"] == pytest.approx(0.7325, abs=0.001)
    assert result["omega_squared"] == pytest.approx(0.7075, abs=0.001)


def test_anova_groups(db_session):
    """Verify per-group stats in ANOVA groups array."""
    db = db_session
    mpg_col, _, cyl_col = _setup_mtcars_for_stat_test(db)

    metric = MetricDefinition(
        project_id=1, name="mpg by cyl",
        metric_type="mean",
        input_source_type="dataset_column",
        input_source_id=mpg_col.id,
        grouping_column_id=cyl_col.id,
        config="{}",
    )
    db.add(metric)
    db.flush()

    test = StatisticalTest(
        project_id=1,
        test_type="one_way_anova",
        target_type="metric_definition",
        target_id=metric.id,
        config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    groups = {g["label"]: g for g in result["groups"]}
    assert groups["4"]["n"] == 11
    assert groups["6"]["n"] == 7
    assert groups["8"]["n"] == 14
    assert groups["4"]["mean"] == pytest.approx(26.6636, abs=0.01)
    assert groups["6"]["mean"] == pytest.approx(19.7429, abs=0.01)
    assert groups["8"]["mean"] == pytest.approx(15.1000, abs=0.01)


# ── Split-half edge cases ────────────────────────────────────────────────────


def _setup_split_half_domain(db, columns_data: list[list[float]]) -> int:
    """Helper: create a project, dataset, N columns, and a domain containing them.

    columns_data: list of columns, each column is a list of numeric values
    (one per row).  Returns the domain ID.
    """
    from app.models.project import Project

    project = Project(id=1, name="SH Test", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="SH DS")
    db.add(ds)

    n_records = len(columns_data[0])
    col_objs = []
    for ci, col_values in enumerate(columns_data):
        col = DatasetColumn(
            id=ci + 1, dataset_id=1, column_code=f"q{ci + 1}",
            column_text=f"q{ci + 1}", column_type="ordinal",
            sequence_order=ci, display_order=ci,
        )
        db.add(col)
        col_objs.append(col)

    domain = AnalysisDomain(id=1, project_id=1, name="SH Domain")
    db.add(domain)
    for ci, col in enumerate(col_objs):
        db.add(AnalysisDomainMember(
            domain_id=1, member_type="column", member_id=col.id,
            sequence_order=ci,
        ))
    db.flush()

    val_id = 1
    for ri in range(n_records):
        row = DatasetRow(id=ri + 1, dataset_id=1)
        db.add(row)
        for ci, col_values in enumerate(columns_data):
            db.add(DatasetValue(
                id=val_id, row_id=row.id, column_id=ci + 1,
                value_text=str(col_values[ri]),
                value_numeric=col_values[ri],
            ))
            val_id += 1
    db.flush()

    return 1  # domain_id


def test_split_half_k2_rejected(db_session):
    """k=2: should raise ValueError (fewer than 4 items)."""
    db = db_session
    domain_id = _setup_split_half_domain(db, [
        [1, 2, 3, 4, 5],
        [5, 4, 3, 2, 1],
    ])
    test = StatisticalTest(
        project_id=1, test_type="split_half",
        target_type="analysis_domain", target_id=domain_id, config="{}",
    )
    db.add(test)
    db.flush()

    with pytest.raises(ValueError, match="at least 4 items"):
        compute_statistical_test(db, test)


def test_split_half_k3_rejected(db_session):
    """k=3: should raise ValueError (fewer than 4 items)."""
    db = db_session
    domain_id = _setup_split_half_domain(db, [
        [1, 2, 3, 4, 5],
        [5, 4, 3, 2, 1],
        [2, 3, 4, 5, 6],
    ])
    test = StatisticalTest(
        project_id=1, test_type="split_half",
        target_type="analysis_domain", target_id=domain_id, config="{}",
    )
    db.add(test)
    db.flush()

    with pytest.raises(ValueError, match="at least 4 items"):
        compute_statistical_test(db, test)


def test_split_half_k4_balanced(db_session):
    """k=4: should succeed with balanced 2+2 split."""
    db = db_session
    domain_id = _setup_split_half_domain(db, [
        [1, 2, 3, 4, 5, 6, 7, 8],
        [2, 3, 4, 5, 6, 7, 8, 9],
        [1, 3, 5, 7, 2, 4, 6, 8],
        [2, 4, 6, 8, 1, 3, 5, 7],
    ])
    test = StatisticalTest(
        project_id=1, test_type="split_half",
        target_type="analysis_domain", target_id=domain_id, config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["k"] == 4
    assert result["k_half1"] == 2
    assert result["k_half2"] == 2
    assert result["n"] == 8
    assert -1.0 <= result["split_half_r"] <= 1.0
    assert result["spearman_brown"] >= 0.0
    assert result["negative_half_correlation"] is False


def test_split_half_negative_correlation_clamped(db_session):
    """Negatively correlated halves: SB should be clamped to 0."""
    db = db_session
    # Items designed so odd-indexed and even-indexed halves are inversely related
    domain_id = _setup_split_half_domain(db, [
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],  # half1: items 0, 2
        [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],   # half2: items 1, 3
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],   # half1
        [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],   # half2
    ])
    test = StatisticalTest(
        project_id=1, test_type="split_half",
        target_type="analysis_domain", target_id=domain_id, config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["split_half_r"] < 0, "Half-scores should be negatively correlated"
    assert result["spearman_brown"] == 0.0, "Negative SB should be clamped to 0"
    assert result["negative_half_correlation"] is True
    assert result["interpretation"] == "unacceptable"


def test_split_half_perfect_positive(db_session):
    """Perfectly correlated halves: SB should be 1.0."""
    db = db_session
    # All items increase together — perfect positive half-correlation
    domain_id = _setup_split_half_domain(db, [
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
        [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    ])
    test = StatisticalTest(
        project_id=1, test_type="split_half",
        target_type="analysis_domain", target_id=domain_id, config="{}",
    )
    db.add(test)
    db.flush()

    result = compute_statistical_test(db, test)

    assert result["split_half_r"] == pytest.approx(1.0, abs=0.001)
    assert result["spearman_brown"] == pytest.approx(1.0, abs=0.001)
    assert result["negative_half_correlation"] is False
    assert result["interpretation"] == "excellent"
