"""A group with one value is LISTED and left out of every test of its row (#1329, D51).

1.5.9's session A, from the git-ignored review record
the internal design notes. The filed
defect, executed there on A(6) B(5) C(1): the comparison's F dropped C (F(1, 9)
= 104.43) while its OWN Tukey table compared C (C–A p .0706, C–B p .0303) — two
models in one row — Levene kept C as a structural zero, the table printed C's SD
as 0.0 with a zero-width interval, and the saved-test ANOVA refused the whole
test. Now one function (`testable_groups.split_testable`) decides which groups
every test of the row uses, and the row names the ones it leaves out.

⚠️ The fixture is the review's, so each number here is one it executed. The
Tukey assertions DISCRIMINATE: the A–B interval over A and B alone differs from
the one a three-group Tukey prints, so a post hoc still handed C fails.
"""

import json
import statistics

import pytest
from scipy.stats import kruskal, levene, ttest_ind

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.statistical_test import StatisticalTest
from app.services.comparisons import compute_group_comparison
from app.services.statistical_tests import compute_statistical_test
from app.services.testable_groups import (
    MIN_VALUES_PER_GROUP_PARAMETRIC,
    MIN_VALUES_PER_GROUP_RANK,
    split_testable,
)
from app.services.undefined_stats import INSUFFICIENT_N

PID = 13290
Y, GRP, GRP2, GRP3 = 132901, 132902, 132903, 132904

A = [3.1, 3.4, 2.9, 3.6, 3.2, 3.0]
B = [4.5, 4.9, 4.7, 5.1, 4.6]
C = [3.9]


def _seed(db):
    """Rows 0-5 = A, 6-10 = B, 11 = C on `grp`.

    `grp2` puts the same A rows and the C row in TWO groups (the two-group case);
    `grp3` relabels them so the one-value group sorts SECOND ("A1", "B1", "C1" →
    A, then the singleton, then B's values), for the explicit t-test.
    """
    db.add(Project(id=PID, name="Singletons", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    for i, (cid, name, ctype) in enumerate([
        (Y, "y", ColumnType.NUMERIC), (GRP, "grp", ColumnType.NOMINAL),
        (GRP2, "grp2", ColumnType.NOMINAL), (GRP3, "grp3", ColumnType.NOMINAL),
    ]):
        db.add(DatasetColumn(id=cid, dataset_id=PID, column_code=name, column_name=name,
                             column_text=name, column_type=ctype,
                             sequence_order=i, display_order=i))
    db.flush()
    values = A + B + C
    labels = ["A"] * 6 + ["B"] * 5 + ["C"]
    labels3 = ["A1"] * 6 + ["C1"] * 5 + ["B1"]   # the singleton sorts second
    vid = PID * 100
    for r, (v, g, g3) in enumerate(zip(values, labels, labels3)):
        db.add(DatasetRow(id=PID * 10 + r, dataset_id=PID))
        db.flush()
        cells = {Y: (str(v), v), GRP: (g, None), GRP3: (g3, None)}
        if g in ("A", "C"):
            cells[GRP2] = (g, None)
        for cid, (text, num) in cells.items():
            vid += 1
            db.add(DatasetValue(id=vid, row_id=PID * 10 + r, column_id=cid,
                                value_text=text, value_numeric=num))
    db.flush()


def _compare(db, grouping, test_type="auto", nonparametric=False):
    out = compute_group_comparison(
        db, project_id=PID, column_ids=[Y], domain_ids=[], grouping_column_id=grouping,
        grouping_column_id_2=None, test_type=test_type, include_effect_size_ci=False,
        nonparametric=nonparametric,
    )
    return out["rows"][0]


class TestTheRule:
    def test_testable_and_untested_keep_the_callers_order_and_empties_are_in_neither(self):
        grouped = {"a": [1, 2], "b": [5], "c": [], "d": [1, 2, 3]}
        names = ["d", "c", "b", "a"]
        assert split_testable(grouped, names, MIN_VALUES_PER_GROUP_PARAMETRIC) == (
            ["d", "a"], ["b"])
        assert split_testable(grouped, names, MIN_VALUES_PER_GROUP_RANK) == (
            ["d", "b", "a"], [])

    def test_the_two_minimums(self):
        assert MIN_VALUES_PER_GROUP_PARAMETRIC == 2
        assert MIN_VALUES_PER_GROUP_RANK == 1


class TestTheComparison:
    def test_the_F_does_not_move_and_tukey_reads_the_same_groups(self, db_session):
        from statsmodels.stats.multicomp import pairwise_tukeyhsd

        _seed(db_session)
        row = _compare(db_session, GRP)
        test = row["test"]
        assert test["test_type"] == "one_way_anova"
        # The review's executed F over A and B — what the app showed before.
        assert test["statistic"] == pytest.approx(104.4298, abs=1e-4)
        assert (test["df"], test["df2"]) == (1.0, 9.0)
        pairs = test["post_hoc"]["comparisons"]
        assert {(p["group_a"], p["group_b"]) for p in pairs} == {("A", "B")}
        two = pairwise_tukeyhsd(A + B, ["A"] * 6 + ["B"] * 5)
        assert pairs[0]["ci_lower"] == pytest.approx(round(float(two.confint[0, 0]), 4))
        # Discrimination: the three-group Tukey's A–B interval (the old table).
        assert pairs[0]["ci_lower"] != pytest.approx(1.1338, abs=1e-3)

    def test_the_one_value_group_is_listed_without_an_SD_or_interval(self, db_session):
        _seed(db_session)
        row = _compare(db_session, GRP)
        c = next(s for s in row["group_stats"] if s["group"] == "C")
        assert (c["n"], c["mean"], c["median"]) == (1, 3.9, 3.9)
        assert c["sd"] is None and c["ci_lower"] is None and c["ci_upper"] is None
        assert c["undefined_reason"] == INSUFFICIENT_N
        a = next(s for s in row["group_stats"] if s["group"] == "A")
        assert a["sd"] == pytest.approx(round(statistics.stdev(A), 4))
        assert a["undefined_reason"] is None
        assert row["untested_groups"] == ["C"]

    def test_levene_leaves_it_out_too_and_still_names_it(self, db_session):
        _seed(db_session)
        v = _compare(db_session, GRP)["variance_homogeneity"]
        assert v["singleton_groups"] == ["C"]
        assert v["p"] == pytest.approx(round(float(levene(A, B, center="median").pvalue), 4))

    def test_two_groups_with_a_one_value_group_is_no_test(self, db_session):
        _seed(db_session)
        row = _compare(db_session, GRP2)
        assert row["test"] is None
        assert row["test_omitted_reason"] == INSUFFICIENT_N
        assert row["untested_groups"] == ["C"]

    def test_an_explicit_t_test_takes_the_first_two_TESTABLE_groups(self, db_session):
        """Order A1, B1 (one value), C1: the Welch t compares A1 with C1."""
        _seed(db_session)
        row = _compare(db_session, GRP3, test_type="t_test")
        assert [s["group"] for s in row["group_stats"]] == ["A1", "B1", "C1"]
        expected = ttest_ind(A, B, equal_var=False).statistic
        assert row["test"]["statistic"] == pytest.approx(round(float(expected), 4))
        assert row["untested_groups"] == ["B1"]

    def test_a_rank_test_uses_the_one_value_group(self, db_session):
        _seed(db_session)
        row = _compare(db_session, GRP, nonparametric=True)
        assert row["test"]["test_type"] == "kruskal_wallis"
        assert row["test"]["statistic"] == pytest.approx(
            round(float(kruskal(A, B, C).statistic), 4))
        assert row["untested_groups"] == []

    def test_every_row_carries_the_field(self, db_session):
        _seed(db_session)
        assert _compare(db_session, GRP, nonparametric=True)["untested_groups"] == []


class TestTheSavedAnova:
    def _test(self, db, grouping):
        db.add(MetricDefinition(id=PID + grouping % 10, project_id=PID, name="y by g",
                                metric_type="mean", input_source_type="dataset_column",
                                input_source_id=Y, grouping_column_id=grouping,
                                config="{}", origin="human", stale=False))
        db.flush()
        st = StatisticalTest(id=PID + grouping % 10, project_id=PID, test_type="one_way_anova",
                             target_type="metric_definition", target_id=PID + grouping % 10,
                             config="{}")
        db.add(st)
        db.flush()
        return st

    def test_it_lists_the_group_and_leaves_it_out_of_the_F(self, db_session):
        _seed(db_session)
        result = compute_statistical_test(db_session, self._test(db_session, GRP))
        assert result["f_statistic"] == pytest.approx(104.4298, abs=1e-3)
        assert (result["df_between"], result["df_within"]) == (1, 9)
        c = next(g for g in result["groups"] if g["label"] == "C")
        assert (c["n"], c["mean"], c["sd"]) == (1, 3.9, None)
        assert result["untested_groups"] == ["C"]
        json.dumps(result, allow_nan=False)

    def test_fewer_than_two_testable_groups_is_still_refused(self, db_session):
        """A(6) B(1) C(1): one group can be tested — refused, with every size named."""
        _seed(db_session)
        # Ungroup four of B's five rows: A(6), B(1), C(1).
        for r in range(6, 10):
            db_session.query(DatasetValue).filter(
                DatasetValue.row_id == PID * 10 + r, DatasetValue.column_id == GRP,
            ).delete()
        db_session.flush()
        st = self._test(db_session, GRP)
        with pytest.raises(ValueError, match=r"at least 2 groups with 2 or more"):
            compute_statistical_test(db_session, st)
