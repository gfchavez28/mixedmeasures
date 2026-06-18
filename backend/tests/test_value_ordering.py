"""#406 regression tests: numeric-aware ordering of value_text display labels.

`services/grouping.py::order_value_labels` is the single ordering decision;
these tests pin it directly plus at the representative consuming surfaces
(frequency distribution, cross-tab axes, group comparisons). The remaining
call sites (statistical_tests group order, text_analysis cross values /
code-density groups) are one-line swaps to the same helper.

Every fixture here deliberately uses multi-digit (and 3-digit) values —
lexicographic ordering equals numeric ordering for 1–5 Likert data, which is
exactly how #406 stayed hidden (see backend/tests/CLAUDE.md).
"""
import pytest

from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.services.comparisons import compute_group_comparison
from app.services.cross_tabulation import compute_cross_tabulation
from app.services.grouping import order_value_labels, value_label_sort_key
from app.services.metrics import ResolvedRow, compute_frequency_distribution


# ── order_value_labels unit ──────────────────────────────────────────────────


class TestOrderValueLabels:
    def test_numeric_labels_sort_numerically(self):
        assert order_value_labels(["1", "12", "15", "2", "9", "3"]) == [
            "1", "2", "3", "9", "12", "15",
        ]

    def test_three_digit_and_decimal_values(self):
        assert order_value_labels(["100", "2.5", "10", "2"]) == ["2", "2.5", "10", "100"]

    def test_negative_and_zero(self):
        assert order_value_labels(["-5", "10", "0"]) == ["-5", "0", "10"]

    def test_pure_text_stays_lexicographic(self):
        assert order_value_labels(["Gamma", "Alpha", "Beta"]) == ["Alpha", "Beta", "Gamma"]

    def test_mixed_set_numeric_first_then_text(self):
        assert order_value_labels(["Other", "12", "2", "Unknown"]) == [
            "2", "12", "Other", "Unknown",
        ]

    def test_nan_string_treated_as_text_not_number(self):
        # float("nan") parses but must not poison the numeric bucket
        assert order_value_labels(["nan", "2", "10"]) == ["2", "10", "nan"]

    def test_sort_key_is_public_for_composite_keys(self):
        # text_analysis composes this under a recode-mapping primary key
        assert value_label_sort_key("12") < value_label_sort_key("100")
        assert value_label_sort_key("99")[0] == 0
        assert value_label_sort_key("Other")[0] == 1


# ── frequency distribution (metrics.py) ──────────────────────────────────────


def _rows(values: list[str]) -> list[ResolvedRow]:
    return [
        ResolvedRow(row_id=i, value_numeric=None, value_text=v, excluded=False)
        for i, v in enumerate(values)
    ]


class TestFrequencyDistributionOrdering:
    def test_scale_order_is_numeric_for_numeric_labels(self):
        data, valid_n, total_n = compute_frequency_distribution(
            _rows(["1", "12", "15", "2", "2", "9"])
        )
        assert data["scale_order"] == ["1", "2", "9", "12", "15"]
        assert valid_n == 6 and total_n == 6

    def test_scale_labels_still_win_extras_numeric_after(self):
        data, _, _ = compute_frequency_distribution(
            _rows(["Low", "High", "12", "2"]), scale_labels=["Low", "High"]
        )
        assert data["scale_order"] == ["Low", "High", "2", "12"]


# ── cross-tab axes + group comparisons (db-backed) ───────────────────────────

TEAM_SIZES = ["8", "12", "100"]  # lexicographic would render 100, 12, 8


@pytest.fixture
def multidigit_fixture(db_session):
    """12-row dataset: numeric score by a 'team size' column whose labels are
    multi-digit numeric strings, plus a second grouping column for cross-tab."""
    db = db_session
    db.add(Project(id=300, name="Ordering Test", user_id=1))
    db.add(Dataset(id=300, project_id=300, name="Teams"))
    db.add_all([
        DatasetColumn(
            id=3001, dataset_id=300, column_code="score", column_name="Score",
            column_text="Score", column_type="numeric", sequence_order=0, display_order=0,
        ),
        DatasetColumn(
            id=3002, dataset_id=300, column_code="team_size", column_name="Team Size",
            column_text="Team size", column_type="ordinal", sequence_order=1, display_order=1,
        ),
        DatasetColumn(
            id=3003, dataset_id=300, column_code="site", column_name="Site",
            column_text="Site", column_type="nominal", sequence_order=2, display_order=2,
        ),
    ])
    db.flush()

    scores = {
        "8": [10.0, 12.0, 11.0, 13.0],
        "12": [20.0, 21.0, 19.0, 22.0],
        "100": [30.0, 31.0, 29.0, 32.0],
    }
    sites = ["North", "South"]
    rid, vid = 7000, 70000
    for label in TEAM_SIZES:
        for i, s in enumerate(scores[label]):
            db.add(DatasetRow(id=rid, dataset_id=300))
            db.add(DatasetValue(
                id=vid, row_id=rid, column_id=3001, value_text=str(s), value_numeric=s,
            ))
            vid += 1
            db.add(DatasetValue(id=vid, row_id=rid, column_id=3002, value_text=label))
            vid += 1
            db.add(DatasetValue(id=vid, row_id=rid, column_id=3003, value_text=sites[i % 2]))
            vid += 1
            rid += 1
    db.flush()
    return db


class TestCrossTabAxisOrdering:
    def test_axis_values_numeric_order(self, multidigit_fixture):
        result = compute_cross_tabulation(
            multidigit_fixture, project_id=300,
            row_column_id=3002, col_column_id=3003,
        )
        assert result["row_values"] == ["8", "12", "100"]
        assert result["col_values"] == ["North", "South"]


class TestGroupComparisonOrdering:
    def test_group_stats_numeric_order(self, multidigit_fixture):
        result = compute_group_comparison(
            multidigit_fixture, project_id=300,
            column_ids=[3001], domain_ids=[],
            grouping_column_id=3002, grouping_column_id_2=None,
            test_type="auto", include_effect_size_ci=False,
        )
        assert len(result["rows"]) == 1
        labels = [s["group"] for s in result["rows"][0]["group_stats"]]
        assert labels == ["8", "12", "100"]
