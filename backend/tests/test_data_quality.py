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


def test_mcar_never_resurrects_a_declared_missing_sentinel(db_session):
    """#592/#595 (3b): MCAR is a STATISTIC, so it obeys the column's missing
    DECLARATION and never the report toggles.

    The bug #592 CREATED: slab 3 NULLs a declared sentinel's value_numeric, and
    the matrix builder's value_text fallback then parsed float("99") straight
    back into the covariance matrix whenever "Count N/A as missing" was off.
    Bug C inverted — the toggle didn't merely fail to change the math, it
    silently overrode an explicit researcher decision. Text N/A never hit this
    (float("N/A") raises); only sentinels whose TEXT parses.

    Two-sided: the SAME data with and without the declaration.
    """
    import json

    # q1 carries a 99 sentinel; the rest are clean 1..5.
    DATA = {
        "q1": [4, 5, 3, 99, 5, 4, 3, 2, 5, 4, 99, 3, 4, 5, 2, 3, 4, 99, 5, 4],
        "q2": [3, 4, 2, 3, 5, 4, 2, 3, 4, 2, 3, 2, 5, 4, 3, 2, 4, 3, 5, 4],
        "q3": [5, 4, 4, 3, 2, 5, 3, 4, 5, 4, 3, 2, 4, 5, 3, 4, 2, 4, 5, 3],
    }

    def build(project_id, declare):
        db_session.add(Project(id=project_id, name=f"P{project_id}", user_id=1))
        db_session.add(Dataset(id=project_id, project_id=project_id, name="S"))
        db_session.flush()
        col_ids = []
        for i, name in enumerate(DATA):
            cid = project_id * 10 + i
            db_session.add(DatasetColumn(
                id=cid, dataset_id=project_id, column_code=name, column_text=name,
                column_type="ordinal", sequence_order=i, display_order=i,
                missing_values=(json.dumps([{"value": "99", "label": "Refused"}])
                                if declare and name == "q1" else None),
            ))
            col_ids.append(cid)
        db_session.flush()
        for r in range(20):
            rid = project_id * 100 + r
            db_session.add(DatasetRow(id=rid, dataset_id=project_id))
            db_session.flush()
            for i, (name, vals) in enumerate(DATA.items()):
                v = vals[r]
                declared_missing = declare and name == "q1" and v == 99
                db_session.add(DatasetValue(
                    id=project_id * 10000 + r * 10 + i, row_id=rid,
                    column_id=project_id * 10 + i,
                    value_text=str(v),
                    # Slab 3's write-time invariant: a declared-missing cell
                    # carries value_numeric = NULL. That NULL is what exposes
                    # the value_text fallback.
                    value_numeric=None if declared_missing else float(v),
                ))
        db_session.flush()
        return col_ids

    # include_na=False is the toggle state that triggered the resurrection.
    undeclared_cols = build(1, declare=False)
    undeclared = compute_littles_mcar(
        db_session, project_id=1, column_ids=undeclared_cols, include_na=False,
    )
    declared_cols = build(2, declare=True)
    declared = compute_littles_mcar(
        db_session, project_id=2, column_ids=declared_cols, include_na=False,
    )

    # Undeclared: 99 is ordinary data (SPSS and jamovi agree — an undeclared
    # sentinel counts), so the matrix is complete and MCAR has nothing to test.
    assert undeclared["eligibility"]["eligible"] is False
    assert "No missing data" in undeclared["eligibility"]["reason"]

    # Declared: the three 99s ARE missing, so MCAR sees a real second pattern.
    # Pre-3b this arm ALSO reported "No missing data detected" — the sentinels
    # were parsed back out of value_text and filled the matrix, so the toggle
    # silently overrode the declaration.
    assert declared["eligibility"]["eligible"] is True, (
        "the declared sentinel was resurrected from value_text into MCAR"
    )
    assert declared["result"]["n_patterns"] == 2


def test_dq_valid_means_analysis_will_use_the_cell(db_session):
    """#595 (slab 5): DQ's "valid" now means "analysis will actually use this".

    Bug C: DQ answered a value_text question while analysis answered a
    value_numeric IS NULL one. They agreed only at the defaults — because _is_na
    was what NULLed value_numeric at import. Anything ELSE that empties a cell
    (a recode's exclude_values, an unmapped label, a failed parse) showed as
    DQ-"valid" while every mean silently dropped it.

    Two-sided, and the sides are the SCOPING: an ordinal column (value_numeric
    drives its analysis) reports the dropped cell missing; a nominal column
    legitimately carries no value_numeric at all and must keep the text
    judgment, or every response would read as missing.
    """
    db = db_session
    db.add(Project(id=1, name="P", user_id=1))
    db.add(Dataset(id=1, project_id=1, name="S"))
    db.flush()
    # ordinal: analysis reads value_numeric.  nominal: it does not.
    db.add(DatasetColumn(id=1, dataset_id=1, column_code="q1", column_text="q1",
                         column_type="ordinal", sequence_order=0, display_order=0))
    db.add(DatasetColumn(id=2, dataset_id=1, column_code="q2", column_text="q2",
                         column_type="nominal", sequence_order=1, display_order=1))
    db.flush()

    # Row 1: both real. Row 2: the ordinal cell has TEXT but no code — exactly
    # what an exclude_values recode or an unmapped label leaves behind.
    for rid in (1, 2):
        db.add(DatasetRow(id=rid, dataset_id=1))
    db.flush()
    db.add(DatasetValue(id=1, row_id=1, column_id=1, value_text="Agree", value_numeric=4.0))
    db.add(DatasetValue(id=2, row_id=2, column_id=1, value_text="Refused", value_numeric=None))
    db.add(DatasetValue(id=3, row_id=1, column_id=2, value_text="North", value_numeric=None))
    db.add(DatasetValue(id=4, row_id=2, column_id=2, value_text="South", value_numeric=None))
    db.flush()

    res = compute_missing_summary(db, project_id=1, column_ids=[1, 2])
    by_col = {v["column_id"]: v for v in res["variables"]}

    # Ordinal: the code-less cell is what the mean drops, so DQ must say so.
    assert by_col[1]["n_missing"] == 1, (
        "a cell analysis drops must not be reported valid (Bug C)"
    )
    assert by_col[1]["n_valid"] == 1

    # Nominal: NULL value_numeric is normal (_compute_value_numeric NULLs
    # undeclared nominal codes by design). Applying the numeric rule here would
    # report every single response as missing.
    assert by_col[2]["n_missing"] == 0, (
        "nominal cells legitimately have no value_numeric — text judgment only"
    )
    assert by_col[2]["n_valid"] == 2
