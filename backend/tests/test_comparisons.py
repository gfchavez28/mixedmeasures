"""Tests for comparisons computation service (mtcars data)."""
import pytest
from app.services.comparisons import compute_group_comparison

# Column IDs from conftest: mpg=1, hp=2, wt=3, disp=4, cyl=5, am=6
MPG_ID, HP_ID, WT_ID, DISP_ID, CYL_ID, AM_ID = 1, 2, 3, 4, 5, 6


def test_2_group(mtcars_session):
    """mpg by am: Welch's t-test, Cohen's d, CI."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=AM_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=True,
    )
    assert len(result["rows"]) == 1
    test = result["rows"][0]["test"]

    assert test["test_type"] == "independent_t_test"
    assert test["statistic"] == pytest.approx(-3.7671, abs=0.001)
    assert test["df"] == pytest.approx(18.3323, abs=0.1)
    assert test["p"] == pytest.approx(0.001374, abs=0.001)
    assert test["effect_size"] == pytest.approx(-1.4779, abs=0.01)
    assert test["effect_size_type"] == "cohens_d"

    # Group stats
    stats = {s["group"]: s for s in result["rows"][0]["group_stats"]}
    assert stats["0"]["n"] == 19
    assert stats["0"]["mean"] == pytest.approx(17.1474, abs=0.001)
    assert stats["0"]["sd"] == pytest.approx(3.8340, abs=0.001)
    assert stats["1"]["n"] == 13
    assert stats["1"]["mean"] == pytest.approx(24.3923, abs=0.001)
    assert stats["1"]["sd"] == pytest.approx(6.1665, abs=0.001)


def test_3_group(mtcars_session):
    """mpg by cyl: One-way ANOVA."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=CYL_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=False,
    )
    test = result["rows"][0]["test"]

    assert test["test_type"] == "one_way_anova"
    assert test["statistic"] == pytest.approx(39.6975, abs=0.01)
    assert test["df"] == pytest.approx(2.0, abs=0.01)
    assert test["df2"] == pytest.approx(29.0, abs=0.01)
    # Service rounds p to 6 decimals: round(4.978919e-09, 6) → 0.0
    assert test["p"] == round(4.978919e-09, 6)  # exactly 0.0
    assert test["effect_size"] == pytest.approx(0.7325, abs=0.001)
    assert test["effect_size_type"] == "eta_squared"
    assert test["omega_squared"] == pytest.approx(0.7075, abs=0.001)


def test_post_hoc(mtcars_session):
    """Tukey HSD post-hoc for mpg by cyl."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=CYL_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=False,
    )
    test = result["rows"][0]["test"]
    post_hoc = test["post_hoc"]
    assert post_hoc is not None
    assert post_hoc["post_hoc_method"] == "tukey_hsd"

    comparisons = {
        (c["group_a"], c["group_b"]): c
        for c in post_hoc["comparisons"]
    }

    # mean_diff = group_b_mean - group_a_mean (statsmodels convention)
    expected = {
        ("4", "6"): {"diff": -6.9208, "p": 0.0003},
        ("4", "8"): {"diff": -11.5636, "p": 0.0000},
        ("6", "8"): {"diff": -4.6429, "p": 0.0112},
    }

    for pair, exp in expected.items():
        comp = comparisons[pair]
        assert comp["mean_diff"] == pytest.approx(exp["diff"], abs=0.01)
        assert comp["p"] == pytest.approx(exp["p"], abs=0.002)


def test_exclude_groups(mtcars_session):
    """Exclude cyl=6 → should get 2-group comparison (4 vs 8)."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=CYL_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=False,
        exclude_groups=["6"],
    )
    assert result["groups"] == ["4", "8"]
    test = result["rows"][0]["test"]
    assert test["test_type"] == "independent_t_test"


def test_mann_whitney(mtcars_session):
    """Non-parametric 2-group: Mann-Whitney U."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=AM_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=False,
        nonparametric=True,
    )
    test = result["rows"][0]["test"]

    assert test["test_type"] == "mann_whitney_u"
    assert test["statistic"] == pytest.approx(42.0, abs=0.5)
    assert test["df"] == pytest.approx(30.0, abs=0.01)
    assert test["p"] == pytest.approx(1.871391e-03, rel=0.05)
    assert test["effect_size_type"] == "rank_biserial_r"
    assert test["effect_size"] == pytest.approx(0.6599, abs=0.01)


def test_kruskal_wallis(mtcars_session):
    """Non-parametric 3-group: Kruskal-Wallis H."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=CYL_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=False,
        nonparametric=True,
    )
    test = result["rows"][0]["test"]

    assert test["test_type"] == "kruskal_wallis"
    assert test["statistic"] == pytest.approx(25.7462, abs=0.01)
    assert test["df"] == pytest.approx(2.0, abs=0.01)
    # Service rounds p to 6 decimals: round(2.566217e-06, 6) → 0.000003
    assert test["p"] == pytest.approx(2.566217e-06, abs=1e-06)
    assert test["effect_size_type"] == "epsilon_squared"
    assert test["effect_size"] == pytest.approx(0.766, abs=0.01)


def test_effect_size_ci(mtcars_session):
    """Cohen's d CI bounds for mpg by am."""
    db = mtcars_session
    result = compute_group_comparison(
        db, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=AM_ID,
        grouping_column_id_2=None,
        test_type="auto",
        include_effect_size_ci=True,
    )
    test = result["rows"][0]["test"]

    assert test["effect_size_ci_lower"] == pytest.approx(-2.3042, abs=0.05)
    assert test["effect_size_ci_upper"] == pytest.approx(-0.6517, abs=0.05)
    # CI should contain the point estimate
    assert test["effect_size_ci_lower"] < test["effect_size"] < test["effect_size_ci_upper"]


# ── #742 — the effect-size LABEL must describe the statistic it is printed beside ──
#
# Both comparison surfaces display omega-squared for a one-way ANOVA, and both
# were printing `effect_size_label` next to it — a word classified from
# ETA-squared. `omega <= eta` always, so any pair straddling a threshold showed
# a number from one statistic under a verdict from the other. The table was the
# worse of the two: `effectSizeBadge` ignores the value entirely when a label is
# supplied, so the badge was purely eta-driven.

def test_omega_squared_carries_its_own_label():
    """`_run_anova` is pure, so the straddling case needs no dataset.

    ⚠️ The mtcars fixture CANNOT see this defect — eta .7325 and omega .7075 are
    both "large", so a label taken from the wrong statistic still reads right.
    This fixture is built where the two DISAGREE, which is the only place the
    claim is testable at all (`backend/tests/the internal design notes: put the fixture where
    old and new behaviour differ).
    """
    from app.services.comparisons import _run_anova

    # Three tight, evenly-spaced groups: a large eta, a much-shrunk omega.
    grouped = {
        "a": [10.0, 12.0, 11.0, 13.0],
        "b": [10.9, 12.9, 11.9, 13.9],
        "c": [11.8, 13.8, 12.8, 14.8],
    }
    test = _run_anova(grouped, ["a", "b", "c"], include_ci=False)

    assert test["effect_size"] == pytest.approx(0.3017, abs=0.001)
    assert test["omega_squared"] == pytest.approx(0.1359, abs=0.001)

    # They straddle the 0.14 "large" boundary — without this the fixture is
    # degenerate and the assertions below pass on the old code too.
    assert test["effect_size_label"] == "large"
    assert test["omega_squared_label"] == "medium", (
        "omega-squared sits below the 0.14 boundary that eta-squared cleared; "
        "labelling the displayed omega 'large' overstates the finding (#742)"
    )
    assert test["effect_size_label"] != test["omega_squared_label"]


def test_every_anova_result_labels_both_effect_sizes(mtcars_session):
    """The pair travels together, so a consumer can never find one without the other."""
    result = compute_group_comparison(
        mtcars_session, project_id=1,
        column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=CYL_ID, grouping_column_id_2=None,
        test_type="auto", include_effect_size_ci=False,
    )
    test = result["rows"][0]["test"]
    assert test["omega_squared"] is not None
    assert test["omega_squared_label"] is not None


# ── #823(l) — the residual cell of a CROSSED comparison ──────────────────────


def test_crossed_residual_is_named_not_left_bare(mtcars_session):
    """A row with a primary group and NO secondary value is not the marginal.

    Measured on GSS: with a Secondary Grouping set, `Associate/junior college`
    (n = 26 — the rows whose secondary value is missing) sat beside
    `Associate/junior college · Under 45` and `… · 45 and over` and read as
    their marginal total of 2,444. The rows are real and must not be dropped;
    what was wrong is that nothing said which cell they were.
    """
    from app.models.dataset import DatasetRow, DatasetValue
    from app.services.comparisons import _load_grouping_map
    from app.services.grouping import MISSING_GROUP_LABEL

    db = mtcars_session
    # Remove the SECONDARY value from a few rows so they fall to the residual.
    orphaned = db.query(DatasetValue).filter(DatasetValue.column_id == AM_ID).limit(4).all()
    orphan_ids = [v.row_id for v in orphaned]
    for v in orphaned:
        db.delete(v)
    db.flush()

    row_ids = [r.id for r in db.query(DatasetRow).all()]
    mapping = _load_grouping_map(db, CYL_ID, AM_ID, row_ids, project_id=1)

    # POPULATION self-check: without residual rows every assertion below is vacuous.
    residuals = {rid: lbl for rid, lbl in mapping.items() if rid in orphan_ids}
    assert len(residuals) == len(orphan_ids), (
        "the fixture produced no residual rows, so this test proves nothing"
    )
    crossed = {rid: lbl for rid, lbl in mapping.items() if rid not in orphan_ids}
    assert crossed, "no fully-crossed rows either — the fixture is degenerate"

    for label in residuals.values():
        assert label.endswith(f" · {MISSING_GROUP_LABEL}"), (
            f"residual cell {label!r} is the bare primary name, which in a crossed "
            "table reads as that group's marginal total"
        )

    # The positive control: an ordinary crossed row is UNCHANGED, and in
    # particular does not acquire the missing label.
    for label in crossed.values():
        assert " · " in label
        assert MISSING_GROUP_LABEL not in label


def test_uncrossed_grouping_is_untouched_by_the_residual_rule(mtcars_session):
    """With no secondary column there is no residual, and no label may change."""
    from app.models.dataset import DatasetRow
    from app.services.comparisons import _load_grouping_map
    from app.services.grouping import MISSING_GROUP_LABEL

    db = mtcars_session
    row_ids = [r.id for r in db.query(DatasetRow).all()]
    mapping = _load_grouping_map(db, CYL_ID, None, row_ids, project_id=1)

    assert mapping, "no grouping values loaded — the assertion below is vacuous"
    for label in mapping.values():
        assert MISSING_GROUP_LABEL not in label
        assert " · " not in label
