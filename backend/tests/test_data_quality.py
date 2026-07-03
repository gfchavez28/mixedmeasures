"""Tests for data_quality service (BFI + synthetic data)."""
import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services.data_quality import (
    compute_missing_summary,
    compute_missing_patterns,
    compute_littles_mcar,
)

# BFI column IDs from conftest: A1=1, A2=2, ..., O5=25
BFI_ITEM_IDS = list(range(1, 26))

EXPECTED_ITEM_MISSING = {
    "A1": 16, "A2": 27, "A3": 26, "A4": 19, "A5": 16,
    "C1": 21, "C2": 24, "C3": 20, "C4": 26, "C5": 16,
    "E1": 23, "E2": 16, "E3": 25, "E4":  9, "E5": 21,
    "N1": 22, "N2": 21, "N3": 11, "N4": 36, "N5": 29,
    "O1": 22, "O2":  0, "O3": 28, "O4": 14, "O5": 20,
}


def test_missing_summary(bfi_session):
    db = bfi_session
    result = compute_missing_summary(
        db, project_id=1, column_ids=BFI_ITEM_IDS,
    )

    assert result["total_cells"] == 70000  # 2800 × 25
    assert result["total_missing"] == 508

    for var in result["variables"]:
        name = var["variable_name"]
        if name in EXPECTED_ITEM_MISSING:
            assert var["n_missing"] == EXPECTED_ITEM_MISSING[name], \
                f"{name}: n_missing {var['n_missing']} != {EXPECTED_ITEM_MISSING[name]}"


def test_missing_percentage(bfi_session):
    db = bfi_session
    result = compute_missing_summary(
        db, project_id=1, column_ids=BFI_ITEM_IDS,
    )
    assert result["overall_pct_missing"] == pytest.approx(0.73, abs=0.1)


def test_missing_patterns(bfi_session):
    db = bfi_session
    result = compute_missing_patterns(
        db, project_id=1, column_ids=BFI_ITEM_IDS,
    )
    assert result["n_unique_patterns"] == 87


def test_mcar_significant(bfi_session):
    """BFI 25 items: data NOT MCAR → p < 0.05.

    The service uses pooled pairwise covariance (not EM estimation like
    naniar::mcar_test in R), so chi2/df values differ from R references.
    Values below are the service's actual output.
    """
    db = bfi_session
    result = compute_littles_mcar(
        db, project_id=1, column_ids=BFI_ITEM_IDS,
    )
    assert result["eligibility"]["eligible"] is True
    mcar = result["result"]
    assert mcar["chi2"] == pytest.approx(720.4877, abs=5.0)
    assert mcar["df"] == 632
    assert mcar["n_patterns"] == 87
    assert mcar["p"] < 0.05  # data is NOT MCAR (p ≈ .008 here)
    # #429: APA string always carries its operator (never a bare "p .008").
    assert ", p = ." in mcar["apa_string"]
    assert ", p ." not in mcar["apa_string"]


def test_mcar_not_significant(db_session):
    """Synthetic 20×4 dataset: data IS MCAR → p > 0.05."""
    db = db_session

    SYNTH_DATA = {
        "q1": [4, 5, 3, None, 5, 4, 3, 2, 5, 4, None, 3, 4, 5, 2, 3, 4, None, 5, 4],
        "q2": [3, 4, None, 3, 5, 4, 2, 3, 4, None, 3, 2, 5, 4, 3, None, 4, 3, 5, 4],
        "q3": [5, 4, 4, 3, None, 5, 3, 4, 5, 4, 3, None, 4, 5, 3, 4, None, 4, 5, 3],
        "q4": [4, None, 3, 4, 5, 3, None, 4, 5, 4, 3, 4, None, 5, 3, 4, 5, 3, None, 4],
    }

    project = Project(id=1, name="Synth", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="Synth")
    db.add(ds)

    col_ids = []
    for i, name in enumerate(SYNTH_DATA.keys()):
        col = DatasetColumn(
            id=i + 1, dataset_id=1, column_code=name,
            column_text=name, column_type="ordinal",
            sequence_order=i, display_order=i,
        )
        db.add(col)
        col_ids.append(col.id)
    db.flush()

    val_id = 0
    for row_idx in range(20):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        db.add(dr)
        for col_idx, (name, values) in enumerate(SYNTH_DATA.items()):
            val = values[row_idx]
            val_id += 1
            dv = DatasetValue(
                id=val_id, row_id=dr.id, column_id=col_idx + 1,
                value_text=str(val) if val is not None else None,
                value_numeric=float(val) if val is not None else None,
            )
            db.add(dv)
    db.flush()

    result = compute_littles_mcar(db, project_id=1, column_ids=col_ids)
    assert result["eligibility"]["eligible"] is True
    mcar = result["result"]
    assert mcar["chi2"] == pytest.approx(11.3342, abs=1.0)
    assert mcar["df"] == 12
    assert mcar["n_patterns"] == 5
    assert mcar["p"] > 0.05  # data IS MCAR
    # #429: non-significant APA string uses "= ." (operator + stripped zero),
    # never the old bare "p .415".
    assert ", p = ." in mcar["apa_string"]
    assert ", p ." not in mcar["apa_string"]


def test_mcar_negative_chi2_clamps_to_zero(db_session):
    """#514: the pooled pairwise covariance matrix is not guaranteed
    positive-semidefinite, so pattern quadratic forms — and their sum — can go
    negative (the audit corpus hit χ² = −2.13 on an ordinary 4-column
    selection; the complete-cases pattern alone contributed −3.12). A χ²
    statistic is non-negative by definition: clamp to 0 for display (p is
    unchanged — sf of any negative statistic is already 1.0), flag the clamp
    in the warning, and never emit a minus sign in the APA string.

    Data = the numbers-audit corpus's Hours/Delta/Satisfaction/MissingMix
    columns verbatim ("DK" = the recognized-N/A "Don't know").
    """
    db = db_session
    COLS = {
        "Hours": [10, 5, 20, 0, 12, 8, 15, 25, 2, 6, 12, 3, 30, 6, 18, 9, 4, 14, 120, 9, None, None, 7, 11],
        "Delta": [-3, 2, 0, -1, 4, -2, 1, 3, -4, 0, 2, -1, 5, -2, 2, 0, -5, 1, 6, -1, 0, 2, -2, 1],
        "Satisfaction": [7, 5, 9, 3, 7, 6, 8, 9, 2, 5, 7, 4, 10, 5, 8, 6, 3, 7, 9, 6, 5, None, 5, 7],
        "MissingMix": [12, "DK", 15, 8, 11, "DK", 9, 14, 6, 10, 13, None, 16, 7, 12, "DK", 5, 10, 18, "DK", 9, None, 8, 12],
    }

    db.add(Project(id=1, name="Clamp", user_id=1))
    db.add(Dataset(id=1, project_id=1, name="Clamp"))
    col_ids = []
    for i, name in enumerate(COLS.keys()):
        db.add(DatasetColumn(
            id=i + 1, dataset_id=1, column_code=name,
            column_text=name, column_type="numeric",
            sequence_order=i, display_order=i,
        ))
        col_ids.append(i + 1)
    db.flush()

    val_id = 0
    for row_idx in range(24):
        db.add(DatasetRow(id=row_idx + 1, dataset_id=1))
        for col_idx, values in enumerate(COLS.values()):
            v = values[row_idx]
            val_id += 1
            if v == "DK":
                text, numeric = "Don't know", None
            elif v is None:
                text, numeric = None, None
            else:
                text, numeric = str(v), float(v)
            db.add(DatasetValue(
                id=val_id, row_id=row_idx + 1, column_id=col_idx + 1,
                value_text=text, value_numeric=numeric,
            ))
    db.flush()

    result = compute_littles_mcar(db, project_id=1, column_ids=col_ids)
    assert result["eligibility"]["eligible"] is True
    mcar = result["result"]
    assert mcar["chi2"] == 0.0
    assert mcar["p"] == 1.0
    assert mcar["df"] == 3
    assert "-" not in mcar["apa_string"], mcar["apa_string"]
    warning = result["eligibility"]["warning"] or ""
    assert "clamped" in warning, (
        "fixture must actually trip the negative-χ² path; if this fails the "
        "data no longer produces a non-PSD pairwise covariance"
    )


def test_mcar_subset(bfi_session):
    """BFI Agreeableness subset (A1-A5): verify values."""
    db = bfi_session
    a_ids = list(range(1, 6))  # A1=1, A2=2, A3=3, A4=4, A5=5
    result = compute_littles_mcar(db, project_id=1, column_ids=a_ids)
    assert result["eligibility"]["eligible"] is True
    mcar = result["result"]
    assert mcar["chi2"] == pytest.approx(30.784, abs=2.0)
    assert mcar["df"] == 25
    assert mcar["n_patterns"] == 13
    # For a small 5-item subset, MCAR hypothesis is not rejected
    assert mcar["p"] > 0.05


def test_no_missing(db_session):
    """Complete data: overall_pct_missing should be 0."""
    db = db_session

    project = Project(id=1, name="Complete", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="Complete")
    db.add(ds)

    col = DatasetColumn(
        id=1, dataset_id=1, column_code="q1",
        column_text="q1", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()

    for i in range(10):
        dr = DatasetRow(id=i + 1, dataset_id=1)
        db.add(dr)
        dv = DatasetValue(
            id=i + 1, row_id=dr.id, column_id=1,
            value_text=str(i + 1), value_numeric=float(i + 1),
        )
        db.add(dv)
    db.flush()

    result = compute_missing_summary(db, project_id=1, column_ids=[1])
    assert result["total_missing"] == 0
    assert result["overall_pct_missing"] == 0.0


def test_all_missing(db_session):
    """All NULL column: should not crash."""
    db = db_session

    project = Project(id=1, name="AllMissing", user_id=1)
    db.add(project)
    ds = Dataset(id=1, project_id=1, name="AllMissing")
    db.add(ds)

    col = DatasetColumn(
        id=1, dataset_id=1, column_code="q1",
        column_text="q1", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()

    for i in range(10):
        dr = DatasetRow(id=i + 1, dataset_id=1)
        db.add(dr)
        dv = DatasetValue(
            id=i + 1, row_id=dr.id, column_id=1,
            value_text=None, value_numeric=None,
        )
        db.add(dv)
    db.flush()

    result = compute_missing_summary(db, project_id=1, column_ids=[1])
    assert result["total_missing"] == 10
    assert result["overall_pct_missing"] == 100.0
