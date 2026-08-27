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


# ═══════════════════════════════════════════════════════════════════════════════
# #591 — a declared level nobody chose belongs on the AXIS, never in the TEST
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeclaredZeroResponseLevels:
    """The frequency computer zero-fills a declared level (which is what makes
    #577 work); the cross-tab used to filter its axis down to values that
    actually appear. Same declaration, two answers on two surfaces — and a
    structural zero is exactly what a declared scale exists to express.

    ⚠️ The fix is NOT "stop filtering". `chi2_contingency` **raises** on the
    all-zero row that a displayed-but-unchosen level produces:

        ValueError: The internally computed table of expected frequencies has a
        zero element at (2, 0)

    and that call sits inside a `try`, so the naive version would make the whole
    chi-square block silently disappear from every cross-tab that has one. The
    table and the statistic legitimately differ in dimension; the payload says by
    how much (`omitted_levels`) rather than leaving df to be reverse-engineered.
    """

    def _seed(self, db, *, mapping_extra=None, pairs=None):
        db.add(Project(id=591, name="P591", user_id=1)); db.flush()
        db.add(Dataset(id=591, project_id=591, name="D")); db.flush()
        row = DatasetColumn(
            id=5911, dataset_id=591, column_code="Sat", column_text="Satisfaction",
            column_type="ordinal", sequence_order=0, display_order=0,
            scale_labels=json.dumps(["Low", "Neutral", "High"]),
            scale_values=json.dumps([1, 2, 3]))
        col = DatasetColumn(
            id=5912, dataset_id=591, column_code="Grp", column_text="Group",
            column_type="nominal", sequence_order=1, display_order=1)
        db.add_all([row, col]); db.flush()
        mapping = {"Low": 1, "Neutral": 2, "High": 3}
        mapping.update(mapping_extra or {})
        db.add(RecodeDefinition(
            id=5913, column_id=row.id, name="scale", recode_type="scale_map",
            output_type="numeric", is_primary=True, sequence_order=0,
            mapping=json.dumps(mapping)))
        db.flush()
        # "Neutral" is declared and never chosen.
        for rv, cv in (pairs or [("Low", "A"), ("Low", "A"), ("Low", "B"),
                                 ("High", "A"), ("High", "B"), ("High", "B")]):
            r = DatasetRow(dataset_id=591); db.add(r); db.flush()
            db.add(DatasetValue(row_id=r.id, column_id=row.id, value_text=rv))
            db.add(DatasetValue(row_id=r.id, column_id=col.id, value_text=cv))
        db.flush()
        return row, col

    def test_a_declared_level_nobody_chose_stays_on_the_axis(self, db_session):
        self._seed(db_session)
        out = compute_cross_tabulation(db_session, project_id=591,
                                       row_column_id=5911, col_column_id=5912)
        assert out["row_values"] == ["Low", "Neutral", "High"], (
            "the declared scale, in declared order — a structural zero is a level"
        )
        assert out["row_totals"] == [3, 0, 3]
        assert [c["count"] for c in out["matrix"][1]] == [0, 0]

    def test_the_empty_level_does_not_break_the_chi_square(self, db_session):
        """The half that makes the naive fix unshippable."""
        self._seed(db_session)
        out = compute_cross_tabulation(db_session, project_id=591,
                                       row_column_id=5911, col_column_id=5912)
        assert out["chi_square"] is not None, (
            "scipy raises on the all-zero row; the block must run on the "
            "observed submatrix instead of silently vanishing"
        )
        assert out["chi_square"]["df"] == 1, (
            "df comes from the 2x2 the test could use, not the displayed 3x2"
        )

    def test_the_payload_says_how_many_levels_the_test_could_not_use(self, db_session):
        self._seed(db_session)
        out = compute_cross_tabulation(db_session, project_id=591,
                                       row_column_id=5911, col_column_id=5912)
        assert out["chi_square"]["omitted_levels"] == 1

    def test_nothing_is_omitted_when_every_level_was_chosen(self, db_session):
        """Two-sided: the field must be 0 on an ordinary table, or a display
        that trusts it would caveat every cross-tab in the app."""
        self._seed(db_session, pairs=[
            ("Low", "A"), ("Low", "B"), ("Neutral", "A"), ("Neutral", "B"),
            ("High", "A"), ("High", "B"), ("High", "A"),
        ])
        out = compute_cross_tabulation(db_session, project_id=591,
                                       row_column_id=5911, col_column_id=5912)
        assert out["row_values"] == ["Low", "Neutral", "High"]
        assert out["chi_square"]["omitted_levels"] == 0
        assert out["chi_square"]["df"] == 2

    def test_a_declared_level_the_column_treats_as_MISSING_is_not_resurrected(self, db_session):
        """`_get_ordered_values` reads a primary scale_map's mapping keys, and a
        hand-authored mapping can name a value the column treats as missing.
        Zero-filling it would undo #384/#592 on this surface — the write-side C4
        strip never touched this read path."""
        self._seed(db_session, mapping_extra={"N/A": 99})
        out = compute_cross_tabulation(db_session, project_id=591,
                                       row_column_id=5911, col_column_id=5912)
        assert "N/A" not in out["row_values"], (
            "a missing value is not a scale point, and a phantom category here "
            "would also inflate the axis the test omits"
        )
        assert out["row_values"] == ["Low", "Neutral", "High"]

    def test_percentages_survive_a_zero_row(self, db_session):
        """Divide-by-zero is one line away in the row-% computation."""
        self._seed(db_session)
        out = compute_cross_tabulation(db_session, project_id=591,
                                       row_column_id=5911, col_column_id=5912)
        assert all(c["row_pct"] == 0 for c in out["matrix"][1])
        assert out["n_shared"] == 6, "an empty level adds no records"


class TestExpectedCountDisclosure:
    """Chi-square is a large-sample approximation and the table never said so
    (#709). `chi2_contingency` was already returning the expected-frequency
    table and the code discarded it into `_`, so the disclosure cost one
    destructured value.

    ⚠️ The subtle half is WHICH table the counts come from. Post-#591 the
    statistic runs on the observed submatrix, and the sparsity check has to run
    on the same one: a declared level nobody chose is not a sparse cell — it is
    a level nobody was offered — so counting it would fire the warning on tables
    that are perfectly well powered. `test_a_declared_empty_level_does_not_make
    _a_healthy_table_look_sparse` is the case that separates the two.
    """

    def _seed(self, db, pairs, *, pid=709):
        db.add(Project(id=pid, name=f"P{pid}", user_id=1)); db.flush()
        db.add(Dataset(id=pid, project_id=pid, name="D")); db.flush()
        row = DatasetColumn(
            id=pid * 10 + 1, dataset_id=pid, column_code="Row", column_text="Row",
            column_type="nominal", sequence_order=0, display_order=0)
        col = DatasetColumn(
            id=pid * 10 + 2, dataset_id=pid, column_code="Col", column_text="Col",
            column_type="nominal", sequence_order=1, display_order=1)
        db.add_all([row, col]); db.flush()
        for rv, cv in pairs:
            r = DatasetRow(dataset_id=pid); db.add(r); db.flush()
            db.add(DatasetValue(row_id=r.id, column_id=row.id, value_text=rv))
            db.add(DatasetValue(row_id=r.id, column_id=col.id, value_text=cv))
        db.flush()
        return row, col

    def _run(self, db, pid=709):
        return compute_cross_tabulation(
            db, project_id=pid, row_column_id=pid * 10 + 1, col_column_id=pid * 10 + 2)

    def test_a_sparse_table_says_so_and_shows_its_figures(self, db_session):
        # 16 records over 2x2, deliberately lopsided: expected counts fall well
        # under 5 in the thin cells.
        pairs = ([("Yes", "A")] * 10 + [("Yes", "B")] * 2
                 + [("No", "A")] * 3 + [("No", "B")] * 1)
        self._seed(db_session, pairs)
        cs = self._run(db_session)["chi_square"]

        assert cs["low_expected_warning"] is True
        assert cs["cell_count"] == 4, "figures come from the 2x2 submatrix"
        assert cs["cells_below_5"] >= 1
        assert cs["min_expected"] is not None and cs["min_expected"] < 5
        assert cs["statistic"] is not None, (
            "the warning is a caveat on the number, not a refusal to compute it"
        )

    def test_a_well_powered_table_carries_no_warning(self, db_session):
        pairs = ([("Yes", "A")] * 50 + [("Yes", "B")] * 60
                 + [("No", "A")] * 55 + [("No", "B")] * 45)
        self._seed(db_session, pairs)
        cs = self._run(db_session)["chi_square"]

        assert cs["low_expected_warning"] is False
        assert cs["cells_below_5"] == 0
        assert cs["min_expected"] > 5

    def test_fisher_exact_is_offered_on_2x2_and_absent_elsewhere(self, db_session):
        """scipy implements Fisher for 2x2 ONLY, so the field is shape-gated.

        Absent must mean absent — never a silent fallback to chi-square's own p,
        which would present one test's number under another test's name.
        """
        self._seed(db_session, [("Yes", "A")] * 10 + [("Yes", "B")] * 2
                   + [("No", "A")] * 3 + [("No", "B")] * 1)
        two_by_two = self._run(db_session)["chi_square"]
        assert two_by_two["fisher_exact_p"] is not None

        wide = ([("Yes", "A")] * 8 + [("Yes", "B")] * 6 + [("Yes", "C")] * 5
                + [("No", "A")] * 4 + [("No", "B")] * 7 + [("No", "C")] * 9)
        self._seed(db_session, wide, pid=710)
        cs = self._run(db_session, pid=710)["chi_square"]
        assert cs["fisher_exact_p"] is None
        assert cs["p_value"] is not None
        assert cs["fisher_exact_p"] != cs["p_value"]

    def test_a_declared_empty_level_does_not_make_a_healthy_table_look_sparse(
        self, db_session,
    ):
        """The #591 interaction, and the reason the check runs on the submatrix.

        A declared-but-unchosen level contributes an all-zero row. Counted as
        cells, its zeros would drag `cells_below_5` past the 20% threshold and
        warn about a table whose observed counts are ample — a warning that
        fires on correct data is how researchers learn to ignore warnings.
        """
        db_session.add(Project(id=7091, name="P7091", user_id=1)); db_session.flush()
        db_session.add(Dataset(id=7091, project_id=7091, name="D")); db_session.flush()
        row = DatasetColumn(
            id=70911, dataset_id=7091, column_code="Sat", column_text="Satisfaction",
            column_type="ordinal", sequence_order=0, display_order=0,
            scale_labels=json.dumps(["Low", "Neutral", "High"]),
            scale_values=json.dumps([1, 2, 3]))
        col = DatasetColumn(
            id=70912, dataset_id=7091, column_code="Grp", column_text="Group",
            column_type="nominal", sequence_order=1, display_order=1)
        db_session.add_all([row, col]); db_session.flush()
        db_session.add(RecodeDefinition(
            id=70913, column_id=row.id, name="scale", recode_type="scale_map",
            output_type="numeric", is_primary=True, sequence_order=0,
            mapping=json.dumps({"Low": 1, "Neutral": 2, "High": 3})))
        db_session.flush()
        pairs = ([("Low", "A")] * 30 + [("Low", "B")] * 25
                 + [("High", "A")] * 28 + [("High", "B")] * 32)
        for rv, cv in pairs:
            r = DatasetRow(dataset_id=7091); db_session.add(r); db_session.flush()
            db_session.add(DatasetValue(row_id=r.id, column_id=row.id, value_text=rv))
            db_session.add(DatasetValue(row_id=r.id, column_id=col.id, value_text=cv))
        db_session.flush()

        out = compute_cross_tabulation(
            db_session, project_id=7091, row_column_id=70911, col_column_id=70912)
        cs = out["chi_square"]

        assert "Neutral" in out["row_values"], "precondition: the empty level is displayed"
        assert cs["omitted_levels"] == 1, "precondition: the test could not use it"
        assert cs["cell_count"] == 4, (
            "2x2 submatrix, not the 3x2 displayed table — the zero row is not a cell"
        )
        assert cs["low_expected_warning"] is False
        assert cs["cells_below_5"] == 0

    # ── The two arms, separated ──────────────────────────────────────────────
    #
    # The rule is a disjunction: >20% of cells below 5, OR any cell below 1. The
    # obvious sparse fixture trips BOTH, so it cannot tell them apart and would
    # keep passing if either arm were deleted. These three fixtures were solved
    # for numerically rather than guessed — the expected table is smoothed by the
    # marginals, so isolating the second arm needs a table with at least 5 rows
    # (a tiny row contributes c cells, and c/(r*c) must stay under the 20% gate).

    def test_the_proportion_arm_fires_on_its_own(self, db_session):
        """All expected counts >= 1, but every one of them under 5."""
        pairs = ([("Yes", "A")] * 3 + [("Yes", "B")] * 3
                 + [("No", "A")] * 3 + [("No", "B")] * 3)
        self._seed(db_session, pairs, pid=7092)
        cs = self._run(db_session, pid=7092)["chi_square"]
        assert cs["min_expected"] >= 1, "precondition: the below-1 arm is NOT what fires"
        assert cs["cells_below_5"] == 4
        assert cs["low_expected_warning"] is True

    def test_the_below_one_arm_fires_on_its_own(self, db_session):
        """Exactly 20% of cells below 5 — under the proportion gate — but one
        expected count is 0.5."""
        pairs = []
        for label in ("A", "B", "C", "D"):
            pairs += [(label, "L")] * 20 + [(label, "R")] * 20
        pairs += [("E", "L")]
        self._seed(db_session, pairs, pid=7093)
        cs = self._run(db_session, pid=7093)["chi_square"]
        assert cs["cell_count"] == 10
        assert cs["cells_below_5"] == 2, "20%, which does NOT clear the > 0.2 gate"
        assert cs["min_expected"] < 1
        assert cs["low_expected_warning"] is True

    def test_neither_arm_fires_at_the_exact_boundary(self, db_session):
        """The negative control for both thresholds at once: 20% of cells below
        5 (not *more* than 20%) and a smallest expected count of exactly 1.0.

        A `>=` slip in either comparison turns this green table amber.
        """
        pairs = []
        for label in ("A", "B", "C", "D"):
            pairs += [(label, "L")] * 20 + [(label, "R")] * 20
        pairs += [("E", "L"), ("E", "R")]
        self._seed(db_session, pairs, pid=7094)
        cs = self._run(db_session, pid=7094)["chi_square"]
        assert cs["cells_below_5"] == 2 and cs["cell_count"] == 10
        assert cs["min_expected"] == 1.0
        assert cs["low_expected_warning"] is False
