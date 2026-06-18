"""Tests for cross-tabulation computation service."""
import json
import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.recode import RecodeDefinition
from app.services.cross_tabulation import compute_cross_tabulation

CROSSTAB_SATISFACTION = [
    "Very Satisfied", "Satisfied", "Satisfied", "Dissatisfied",
    "Very Satisfied", "Very Satisfied", "Satisfied", "Neutral",
    "Neutral", "Dissatisfied", "Satisfied", "Neutral",
    "Very Satisfied", "Satisfied", "Dissatisfied",
]
CROSSTAB_DEPARTMENT = [
    "Engineering", "Engineering", "Engineering", "Engineering",
    "Marketing", "Marketing", "Marketing", "Marketing",
    "Operations", "Operations", "Operations", "Operations",
    "Engineering", "Engineering", "Engineering",
]


@pytest.fixture
def crosstab_fixture(db_session):
    """15-row dataset with satisfaction x department."""
    db = db_session
    project = Project(id=100, name="CrossTab Test", user_id=1)
    db.add(project)
    dataset = Dataset(id=100, project_id=100, name="Survey")
    db.add(dataset)

    sat_col = DatasetColumn(
        id=1001, dataset_id=100, column_code="satisfaction",
        column_name="Satisfaction", column_text="Overall satisfaction",
        column_type="ordinal", sequence_order=0, display_order=0,
        scale_labels='["Very Satisfied","Satisfied","Neutral","Dissatisfied"]',
    )
    dept_col = DatasetColumn(
        id=1002, dataset_id=100, column_code="department",
        column_name="Department", column_text="Department",
        column_type="demographic", sequence_order=1, display_order=1,
    )
    db.add_all([sat_col, dept_col])
    db.flush()

    val_id = 0
    for i in range(15):
        row = DatasetRow(id=5000 + i, dataset_id=100)
        db.add(row)
        val_id += 1
        db.add(DatasetValue(
            id=10000 + val_id, row_id=row.id,
            column_id=sat_col.id, value_text=CROSSTAB_SATISFACTION[i],
        ))
        val_id += 1
        db.add(DatasetValue(
            id=10000 + val_id, row_id=row.id,
            column_id=dept_col.id, value_text=CROSSTAB_DEPARTMENT[i],
        ))

    db.flush()
    return {"project_id": 100, "sat_col_id": sat_col.id, "dept_col_id": dept_col.id}


@pytest.fixture
def crosstab_with_recode_fixture(crosstab_fixture, db_session):
    """Adds a primary scale_map recode that reverses the scale_labels order."""
    recode = RecodeDefinition(
        id=9001,
        column_id=crosstab_fixture["sat_col_id"],
        name="Satisfaction Scale",
        recode_type="scale_map",
        output_type="numeric",
        mapping='{"Very Satisfied": 4, "Satisfied": 3, "Neutral": 2, "Dissatisfied": 1}',
        is_primary=True,
        is_auto_detected=False,
        sequence_order=0,
    )
    db_session.add(recode)
    db_session.flush()
    return crosstab_fixture


@pytest.fixture
def crosstab_with_missing_fixture(crosstab_fixture, db_session):
    """Adds a 16th row with satisfaction but no department value."""
    row = DatasetRow(id=5099, dataset_id=100)
    db_session.add(row)
    db_session.add(DatasetValue(
        id=19001, row_id=row.id,
        column_id=crosstab_fixture["sat_col_id"],
        value_text="Very Satisfied",
    ))
    db_session.flush()
    return crosstab_fixture


def test_contingency_counts(crosstab_fixture, db_session):
    f = crosstab_fixture
    result = compute_cross_tabulation(
        db_session, f["project_id"], f["sat_col_id"], f["dept_col_id"],
    )
    assert result["n_shared"] == 15

    # Without recode, scale_labels ordering applies:
    # ["Very Satisfied", "Satisfied", "Neutral", "Dissatisfied"]
    rv = result["row_values"]
    assert rv == ["Very Satisfied", "Satisfied", "Neutral", "Dissatisfied"]
    assert result["row_totals"] == [4, 5, 3, 3]

    cv = result["col_values"]
    # Departments have no scale_labels → alphabetical
    assert cv == ["Engineering", "Marketing", "Operations"]
    assert result["col_totals"] == [7, 4, 4]

    # Spot-check cells: VS × Engineering = 2, Satisfied × Engineering = 3
    m = result["matrix"]
    ri_vs = rv.index("Very Satisfied")
    ci_eng = cv.index("Engineering")
    assert m[ri_vs][ci_eng]["count"] == 2
    ri_sat = rv.index("Satisfied")
    assert m[ri_sat][ci_eng]["count"] == 3


def test_percentages(crosstab_fixture, db_session):
    f = crosstab_fixture
    result = compute_cross_tabulation(
        db_session, f["project_id"], f["sat_col_id"], f["dept_col_id"],
    )
    rv, cv, m = result["row_values"], result["col_values"], result["matrix"]

    # Engineering × Very Satisfied: count=2
    ri = rv.index("Very Satisfied")
    ci = cv.index("Engineering")
    cell = m[ri][ci]
    assert cell["count"] == 2
    assert cell["row_pct"] == pytest.approx(50.0, abs=0.1)    # 2/4 * 100
    assert cell["col_pct"] == pytest.approx(28.6, abs=0.1)    # 2/7 * 100
    assert cell["total_pct"] == pytest.approx(13.3, abs=0.1)  # 2/15 * 100

    # Operations × Neutral: count=2
    ri2 = rv.index("Neutral")
    ci2 = cv.index("Operations")
    cell2 = m[ri2][ci2]
    assert cell2["count"] == 2
    assert cell2["row_pct"] == pytest.approx(66.7, abs=0.1)   # 2/3 * 100
    assert cell2["col_pct"] == pytest.approx(50.0, abs=0.1)   # 2/4 * 100

    # Marketing × Dissatisfied: count=0
    ri3 = rv.index("Dissatisfied")
    ci3 = cv.index("Marketing")
    cell3 = m[ri3][ci3]
    assert cell3["count"] == 0
    assert cell3["row_pct"] == 0
    assert cell3["col_pct"] == 0


def test_chi_square(crosstab_fixture, db_session):
    f = crosstab_fixture
    result = compute_cross_tabulation(
        db_session, f["project_id"], f["sat_col_id"], f["dept_col_id"],
    )
    chi = result["chi_square"]
    assert chi is not None
    assert chi["statistic"] == pytest.approx(6.607, abs=0.001)
    assert chi["df"] == 6
    assert chi["p_value"] == pytest.approx(0.3587, abs=0.001)
    assert chi["cramers_v"] == pytest.approx(0.469, abs=0.001)


def test_chi_square_disabled(crosstab_fixture, db_session):
    f = crosstab_fixture
    result = compute_cross_tabulation(
        db_session, f["project_id"], f["sat_col_id"], f["dept_col_id"],
        include_chi_square=False,
    )
    assert result["chi_square"] is None
    assert result["n_shared"] == 15


def test_value_ordering_with_recode(crosstab_with_recode_fixture, db_session):
    """With recode {VS:4, S:3, N:2, D:1}, ascending order reverses scale_labels."""
    f = crosstab_with_recode_fixture
    result = compute_cross_tabulation(
        db_session, f["project_id"], f["sat_col_id"], f["dept_col_id"],
    )
    # Recode ascending: D(1), N(2), S(3), VS(4)
    assert result["row_values"][0] == "Dissatisfied"
    assert result["row_values"][-1] == "Very Satisfied"


def test_missing_value_exclusion(crosstab_with_missing_fixture, db_session):
    """16th row (no department) excluded from cross-tab."""
    f = crosstab_with_missing_fixture
    result = compute_cross_tabulation(
        db_session, f["project_id"], f["sat_col_id"], f["dept_col_id"],
    )
    assert result["n_shared"] == 15


def test_single_row_value(db_session):
    """All same satisfaction → chi_square is None, matrix still returned."""
    db = db_session
    project = Project(id=101, name="Single", user_id=1)
    db.add(project)
    ds = Dataset(id=101, project_id=101, name="S")
    db.add(ds)
    col_a = DatasetColumn(
        id=1101, dataset_id=101, column_code="sat",
        column_name="sat", column_text="sat", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    col_b = DatasetColumn(
        id=1102, dataset_id=101, column_code="dept",
        column_name="dept", column_text="dept", column_type="demographic",
        sequence_order=1, display_order=1,
    )
    db.add_all([col_a, col_b])
    db.flush()

    vid = 0
    for i, dept in enumerate(["A", "B", "A", "B"]):
        row = DatasetRow(id=9000 + i, dataset_id=101)
        db.add(row)
        vid += 1
        db.add(DatasetValue(id=50000 + vid, row_id=row.id, column_id=1101, value_text="Good"))
        vid += 1
        db.add(DatasetValue(id=50000 + vid, row_id=row.id, column_id=1102, value_text=dept))
    db.flush()

    result = compute_cross_tabulation(db, 101, 1101, 1102)
    # Only 1 row value → chi_square requires ≥2
    assert result["chi_square"] is None
    assert result["n_shared"] == 4
    assert len(result["row_values"]) == 1
    assert result["row_values"] == ["Good"]


# ═══════════════════════════════════════════════════════════════════════════════
# #362 — router cross_tabulation must not 500 when the cross column has a primary
#         recode (it read a non-existent `.definition` field → AttributeError).
# ═══════════════════════════════════════════════════════════════════════════════
#
# NOTE: this exercises the ROUTER path (routers/text_analysis.py::cross_tabulation),
# which builds its own matrix inline — distinct from the service-layer
# compute_cross_tabulation tested above. (Recreated here — original lived in /tmp.)

import asyncio

from app.models.user import User
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.routers.text_analysis import cross_tabulation as router_cross_tabulation
from app.schemas.text_analysis import CrossTabulationRequest


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def recoded_crosstab_fixture(db_session):
    """One dataset: an open_text comment column (coded) + an ordinal Benefits_Tier
    column carrying a primary SCALE_MAP recode. Labels chosen so recode order
    (Standard < Plus < Premium) differs from alphabetical (Plus, Premium, Standard).
    """
    db = db_session
    db.add(Project(id=200, name="Recoded CrossTab", user_id=1)); db.flush()
    db.add(Dataset(id=200, project_id=200, name="Comp Survey")); db.flush()

    comment_col = DatasetColumn(
        id=2001, dataset_id=200, column_code="why", column_name="Why",
        column_text="Why this rating?", column_type="open_text",
        sequence_order=0, display_order=0,
    )
    tier_col = DatasetColumn(
        id=2002, dataset_id=200, column_code="Benefits_Tier", column_name="Benefits_Tier",
        column_text="Benefits Tier", column_type="ordinal",
        sequence_order=1, display_order=1,
    )
    db.add_all([comment_col, tier_col]); db.flush()

    db.add(RecodeDefinition(
        id=2001, column_id=2002, name="Tier map", recode_type="scale_map",
        output_type="numeric",
        mapping=json.dumps({"Standard": 1, "Plus": 2, "Premium": 3}),
        exclude_values=json.dumps([]), is_primary=True, is_auto_detected=True,
        sequence_order=0,
    ))
    db.flush()

    code = Code(id=2001, project_id=200, name="Cost concern", color="#FF0000",
                numeric_id=1, is_active=True)
    db.add(code); db.flush()

    # 3 rows: comment + tier each; code applied to the comment values.
    tiers = ["Premium", "Standard", "Plus"]
    comments = ["Too expensive", "Fair value", "Good deal"]
    for i in range(3):
        row = DatasetRow(id=2100 + i, dataset_id=200)
        db.add(row); db.flush()
        cv = DatasetValue(id=2200 + i, row_id=row.id, column_id=2001, value_text=comments[i])
        db.add(cv)
        db.add(DatasetValue(id=2300 + i, row_id=row.id, column_id=2002, value_text=tiers[i]))
        db.flush()
        db.add(CodeApplication(dataset_value_id=cv.id, code_id=2001))
    db.flush()
    return db.query(User).filter(User.id == 1).one()


def test_R3_cross_tab_with_recoded_cross_column_does_not_500(db_session, recoded_crosstab_fixture):
    """The presence of a primary recode on the cross column no longer raises,
    and the cross-tab columns are ordered by the recode's numeric mapping."""
    user = recoded_crosstab_fixture
    result = _run(router_cross_tabulation(
        project_id=200,
        body=CrossTabulationRequest(text_column_ids=[2001], cross_column_id=2002),
        db=db_session,
        user=user,
    ))

    # Ordered by recode value (Standard=1 < Plus=2 < Premium=3), NOT alphabetical
    # (which would be ["Plus", "Premium", "Standard"]).
    assert result.response_values == ["Standard", "Plus", "Premium"]
    # The coded comments mapped onto their tiers (one each).
    assert result.total_coded_texts == 3
    assert result.column_totals == {"Standard": 1, "Plus": 1, "Premium": 1}


def test_R3_cross_tab_unmapped_value_still_appears(db_session, recoded_crosstab_fixture):
    """A data value not covered by the recode mapping (a typo) is not dropped —
    it sorts after the mapped values rather than disappearing from the columns."""
    db = db_session
    # Add a 4th row whose tier is a typo ("Premum") absent from the mapping.
    row = DatasetRow(id=2199, dataset_id=200)
    db.add(row); db.flush()
    cv = DatasetValue(id=2299, row_id=row.id, column_id=2001, value_text="Typo row")
    db.add(cv)
    db.add(DatasetValue(id=2399, row_id=row.id, column_id=2002, value_text="Premum"))
    db.flush()
    db.add(CodeApplication(dataset_value_id=cv.id, code_id=2001))
    db.flush()

    result = _run(router_cross_tabulation(
        project_id=200,
        body=CrossTabulationRequest(text_column_ids=[2001], cross_column_id=2002),
        db=db, user=recoded_crosstab_fixture,
    ))
    # Mapped values first (numeric order), the unmapped typo last.
    assert result.response_values == ["Standard", "Plus", "Premium", "Premum"]
