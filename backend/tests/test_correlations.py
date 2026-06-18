"""Tests for correlations computation service (mtcars data)."""
import pytest
from app.models.dataset import DatasetColumn, DatasetRow, DatasetValue
from app.services.correlations import compute_correlation_matrix, compute_scatter_data


# Column IDs from conftest: mpg=1, hp=2, wt=3, disp=4, cyl=5, am=6
MPG_ID, HP_ID, WT_ID, DISP_ID = 1, 2, 3, 4

EXPECTED_PEARSON = {
    ("mpg", "wt"):   {"r": -0.86766, "p": 1.293959e-10},
    ("mpg", "hp"):   {"r": -0.77617, "p": 1.787835e-07},
    ("mpg", "disp"): {"r": -0.84755, "p": 9.380327e-10},
    ("hp", "wt"):    {"r":  0.65875, "p": 4.145827e-05},
    ("hp", "disp"):  {"r":  0.79095, "p": 7.142679e-08},
    ("wt", "disp"):  {"r":  0.88798, "p": 1.222320e-11},
}

EXPECTED_SPEARMAN = {
    ("mpg", "wt"):   {"r": -0.88642, "p": 1.487595e-11},
    ("mpg", "hp"):   {"r": -0.89466, "p": 5.085969e-12},
    ("mpg", "disp"): {"r": -0.90888, "p": 6.370336e-13},
    ("hp", "wt"):    {"r":  0.77468, "p": 1.953795e-07},
    ("hp", "disp"):  {"r":  0.85104, "p": 6.791338e-10},
    ("wt", "disp"):  {"r":  0.89771, "p": 3.346362e-12},
}

# Column order in the matrix: mpg(0), hp(1), wt(2), disp(3)
VAR_INDEX = {"mpg": 0, "hp": 1, "wt": 2, "disp": 3}


def _check_matrix(result, expected, corr_type):
    matrix = result["matrix"]
    for (v1, v2), exp in expected.items():
        i, j = VAR_INDEX[v1], VAR_INDEX[v2]
        cell = matrix[i][j]
        assert cell["r"] == pytest.approx(exp["r"], abs=0.001), \
            f"{corr_type} r({v1},{v2}): {cell['r']} != {exp['r']}"
        # Service rounds p to 6 decimals. Assert against round(expected, 6)
        # so very small p-values correctly expect 0.0.
        expected_p = round(exp["p"], 6)
        assert cell["p"] == pytest.approx(expected_p, abs=1e-06), \
            f"{corr_type} p({v1},{v2}): {cell['p']} != {expected_p}"
        assert cell["n"] == 32


def test_pearson_matrix(mtcars_session):
    db = mtcars_session
    result = compute_correlation_matrix(
        db, project_id=1,
        column_ids=[MPG_ID, HP_ID, WT_ID, DISP_ID],
        domain_ids=[],
        correlation_type="pearson",
        bonferroni=False,
    )
    assert len(result["labels"]) == 4
    _check_matrix(result, EXPECTED_PEARSON, "pearson")


def test_spearman_matrix(mtcars_session):
    db = mtcars_session
    result = compute_correlation_matrix(
        db, project_id=1,
        column_ids=[MPG_ID, HP_ID, WT_ID, DISP_ID],
        domain_ids=[],
        correlation_type="spearman",
        bonferroni=False,
    )
    _check_matrix(result, EXPECTED_SPEARMAN, "spearman")


def test_p_values(mtcars_session):
    """Verify p-values match for all pairs (Pearson)."""
    db = mtcars_session
    result = compute_correlation_matrix(
        db, project_id=1,
        column_ids=[MPG_ID, HP_ID, WT_ID, DISP_ID],
        domain_ids=[],
        correlation_type="pearson",
        bonferroni=False,
    )
    matrix = result["matrix"]
    for (v1, v2), exp in EXPECTED_PEARSON.items():
        i, j = VAR_INDEX[v1], VAR_INDEX[v2]
        p = matrix[i][j]["p"]
        expected_p = round(exp["p"], 6)
        assert p == pytest.approx(expected_p, abs=1e-06)


def test_regression(mtcars_session):
    db = mtcars_session
    result = compute_scatter_data(
        db, project_id=1,
        x_id=WT_ID, y_id=MPG_ID,
        id_type="column",
        group_column_id=None,
    )
    reg = result["regression"]
    assert reg["intercept"] == pytest.approx(37.2851, abs=0.01)
    assert reg["slope"] == pytest.approx(-5.3445, abs=0.01)
    assert reg["r_squared"] == pytest.approx(0.7528, abs=0.001)
    assert reg["r"] == pytest.approx(-0.86766, abs=0.001)
    assert result["n"] == 32


def test_regression_mpg_hp(mtcars_session):
    db = mtcars_session
    result = compute_scatter_data(
        db, project_id=1,
        x_id=HP_ID, y_id=MPG_ID,
        id_type="column",
        group_column_id=None,
    )
    reg = result["regression"]
    assert reg["intercept"] == pytest.approx(30.0989, abs=0.01)
    assert reg["slope"] == pytest.approx(-0.0682, abs=0.001)
    assert reg["r_squared"] == pytest.approx(0.6024, abs=0.001)


def test_bonferroni(mtcars_session):
    db = mtcars_session
    result = compute_correlation_matrix(
        db, project_id=1,
        column_ids=[MPG_ID, HP_ID, WT_ID, DISP_ID],
        domain_ids=[],
        correlation_type="pearson",
        bonferroni=True,
    )
    assert result["num_comparisons"] == 6
    assert result["adjusted_alpha"] == pytest.approx(0.05 / 6, abs=0.0001)

    # Bonferroni-corrected p-values: service's own p * num_comparisons,
    # capped at 1.0, rounded to 6 decimals. The service computes p from
    # its own t-distribution calculation, which may differ slightly from
    # the R reference p-values in EXPECTED_PEARSON. Use abs=1e-05 tolerance
    # to account for this compound rounding.
    matrix = result["matrix"]
    for (v1, v2), exp in EXPECTED_PEARSON.items():
        i, j = VAR_INDEX[v1], VAR_INDEX[v2]
        corrected_p = matrix[i][j]["p"]
        expected_corrected = round(min(exp["p"] * 6, 1.0), 6)
        assert corrected_p == pytest.approx(expected_corrected, abs=1e-05), \
            f"Bonferroni p({v1},{v2}): {corrected_p} != {expected_corrected}"


def test_constant_variable(mtcars_session):
    """A variable with identical values should return r=0, p=1 for correlations."""
    db = mtcars_session

    # Add a constant column
    const_col = DatasetColumn(
        id=100, dataset_id=1, column_code="const",
        column_name="const", column_text="constant", column_type="numeric",
        sequence_order=100, display_order=100,
    )
    db.add(const_col)
    db.flush()

    for row_id in range(1, 33):
        dv = DatasetValue(
            id=10000 + row_id, row_id=row_id, column_id=100,
            value_text="5", value_numeric=5.0,
        )
        db.add(dv)
    db.flush()

    result = compute_correlation_matrix(
        db, project_id=1,
        column_ids=[MPG_ID, 100],
        domain_ids=[],
        correlation_type="pearson",
        bonferroni=False,
    )
    # Constant vs mpg: r should be 0 or NaN-handled
    cell = result["matrix"][0][1]
    assert cell["r"] == pytest.approx(0.0, abs=0.001) or cell["p"] == 1.0


def test_n_equals_2(db_session):
    """With only 2 data points, correlations should handle gracefully."""
    db = db_session
    from app.models.project import Project
    from app.models.dataset import Dataset

    project = Project(id=1, name="Small", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="Small")
    db.add(ds)

    for i, name in enumerate(["x", "y"]):
        col = DatasetColumn(
            id=i + 1, dataset_id=1, column_code=name,
            column_name=name, column_text=name, column_type="numeric",
            sequence_order=i, display_order=i,
        )
        db.add(col)
    db.flush()

    val_id = 0
    for row_idx in range(2):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        db.add(dr)
        for col_id, val in [(1, float(row_idx + 1)), (2, float(row_idx * 2 + 1))]:
            val_id += 1
            dv = DatasetValue(
                id=val_id, row_id=dr.id, column_id=col_id,
                value_text=str(val), value_numeric=val,
            )
            db.add(dv)
    db.flush()

    result = compute_correlation_matrix(
        db, project_id=1,
        column_ids=[1, 2],
        domain_ids=[],
        correlation_type="pearson",
        bonferroni=False,
    )
    # n < 3 → service returns r=0.0, p=1.0
    cell = result["matrix"][0][1]
    assert cell["n"] == 2
    assert cell["r"] == pytest.approx(0.0, abs=0.001)
    assert cell["p"] == 1.0
