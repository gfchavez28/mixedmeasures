"""#1330 (1.5.9, D53/D54): a variable group's pooled intervals count each RECORD once.

A mean, proportion or frequency over a variable group pools every member column's
answers into one list, and each interval treated that list as independent people —
a record that answered four items counted four times in the width. Decisions D53
(the mean: CR1 over records, t on G−1 df, `record_cluster_t`) and D54 (a proportion
and each category: Wilson on a Korn–Graubard effective n, capped at n,
`wilson_effective_n` / `wilson_per_category_effective_n`) of the git-ignored
the internal design notes.

Every arm sits where the naive interval and the record interval DISAGREE, and the
two oracles are independent of `record_cluster_variance`'s code: the t on record
means (`_ci_mean` over per-record means — the balanced identity), and the general
sandwich estimator written in matrix form with numpy (the unbalanced case).
"""

import json
import random
import statistics

import numpy as np
import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.services import metrics as m
from app.services.metrics import ResolvedRow


def _rows(records: list[list[float]]) -> list[ResolvedRow]:
    return [ResolvedRow(row_id=g, value_numeric=float(v), value_text=str(int(v)))
            for g, vals in enumerate(records) for v in vals]


def _balanced(seed=1330, records=25, items=4) -> list[list[float]]:
    rng = random.Random(seed)
    out = []
    for _ in range(records):
        trait = rng.gauss(3.2, 0.9)
        out.append([min(5, max(1, round(trait + rng.gauss(0, 0.5)))) for _ in range(items)])
    return out


def _sandwich_cr1(values, clusters) -> float:
    """The cluster-robust variance of an intercept-only OLS, in matrix form."""
    y = np.asarray(values, float)
    X = np.ones((len(y), 1))
    bread = np.linalg.inv(X.T @ X)
    e = y - X @ (bread @ X.T @ y)
    ids = sorted(set(clusters))
    meat = np.zeros((1, 1))
    for g in ids:
        idx = [i for i, c in enumerate(clusters) if c == g]
        s = X[idx].T @ e[idx]
        meat += np.outer(s, s)
    G = len(ids)
    return float((G / (G - 1)) * (bread @ meat @ bread)[0, 0])


class TestTheMeanIsOverRecords:
    def test_balanced_data_give_the_t_on_record_means_exactly(self):
        """D53's identity: with every record answering every item, the CR1 interval
        for the pooled mean IS the t interval on the records' means."""
        recs = _balanced()
        pooled, n, _ = m.compute_mean(_rows(recs), by_record=True)
        means = [statistics.mean(r) for r in recs]
        on_means = m._ci_mean(round(statistics.mean(means), m.STATS_PRECISION),
                              statistics.stdev(means), len(means))
        assert pooled["ci_method"] == m.CI_METHOD_RECORD_CLUSTER_T
        assert pooled["ci_lower"] == pytest.approx(on_means["ci_lower"], abs=1e-4)
        assert pooled["ci_upper"] == pytest.approx(on_means["ci_upper"], abs=1e-4)
        assert pooled["record_count"] == 25 and n == 100

    def test_and_the_naive_interval_was_far_narrower(self):
        """Discrimination: on this fixture the two disagree (the review's probe,
        [2.817, 3.223] against [2.655, 3.385])."""
        recs = _balanced()
        naive, _, _ = m.compute_mean(_rows(recs))
        pooled, _, _ = m.compute_mean(_rows(recs), by_record=True)
        assert naive["ci_method"] == m.CI_METHOD_T_INTERVAL
        naive_w = naive["ci_upper"] - naive["ci_lower"]
        pooled_w = pooled["ci_upper"] - pooled["ci_lower"]
        assert pooled_w / naive_w > 1.5
        assert (pooled["ci_lower"], pooled["ci_upper"]) == pytest.approx((2.655, 3.385), abs=1e-3)
        assert pooled["mean"] == naive["mean"], "the ESTIMATE does not move"

    def test_unbalanced_data_take_the_sandwich_variance(self):
        """Records answering different numbers of items: the pooled (response-
        weighted) mean's CR1 variance, checked against the matrix-form sandwich."""
        recs = _balanced()
        recs = [r[:2] if i < 7 else r for i, r in enumerate(recs)]
        rows = _rows(recs)
        totals, sizes = m._record_tallies(rows, lambda r: r.value_numeric)
        ours = m.record_cluster_variance(totals, sizes)
        oracle = _sandwich_cr1([r.value_numeric for r in rows], [r.row_id for r in rows])
        assert ours == pytest.approx(oracle, rel=1e-12)
        pooled, _, _ = m.compute_mean(rows, by_record=True)
        half = m._t_critical(24) * oracle ** 0.5
        assert pooled["ci_upper"] - pooled["ci_lower"] == pytest.approx(2 * half, abs=2e-4)
        assert pooled["std_error"] == pytest.approx(oracle ** 0.5, abs=1e-4)

    def test_the_interval_needs_three_records(self):
        """`_ci_mean`'s floor, counted in the unit the interval is over."""
        two, _, _ = m.compute_mean(_rows([[1, 2, 3], [4, 5, 5]]), by_record=True)
        assert two["ci_lower"] is None and two["ci_method"] == m.CI_METHOD_RECORD_CLUSTER_T
        assert two["record_count"] == 2
        three, _, _ = m.compute_mean(_rows([[1, 2, 3], [4, 5, 5], [2, 2, 3]]), by_record=True)
        assert three["ci_lower"] is not None

    def test_excluded_and_missing_answers_leave_the_record_tally(self):
        rows = _rows([[1, 2], [3, 4], [5, 5]])
        rows[0].excluded = True
        rows[1].missing = True  # record 0 now has no valid answer at all
        pooled, n, _ = m.compute_mean(rows, by_record=True)
        assert n == 4 and pooled["record_count"] == 2

    def test_without_by_record_nothing_changes(self):
        plain, _, _ = m.compute_mean(_rows(_balanced()))
        assert "record_count" not in plain and "std_error" not in plain


class TestTheProportionsAreOverRecords:
    def test_the_effective_n_is_the_korn_graubard_form(self):
        recs = _balanced()
        cfg = {"mode": "numeric", "operator": ">=", "threshold_numeric": 4}
        rows = _rows(recs)
        res, n, _ = m.compute_proportion(rows, cfg, by_record=True)
        k = sum(1 for r in rows if r.value_numeric >= 4)
        p = k / n
        totals, sizes = m._record_tallies(rows, lambda r: 1.0 if r.value_numeric >= 4 else 0.0)
        v = _sandwich_cr1([1.0 if r.value_numeric >= 4 else 0.0 for r in rows],
                          [r.row_id for r in rows])
        n_star = min(n, p * (1 - p) / v * (m._Z_975 / m._t_critical(24)) ** 2)
        expected = m._wilson_bounds(p, n_star, m.CI_METHOD_WILSON_EFFECTIVE_N)
        assert res["ci_method"] == m.CI_METHOD_WILSON_EFFECTIVE_N
        assert (res["ci_lower"], res["ci_upper"]) == (expected["ci_lower"], expected["ci_upper"])
        assert res["std_error"] == pytest.approx(v ** 0.5 * 100, abs=1e-4)
        assert res["record_count"] == 25
        naive, _, _ = m.compute_proportion(rows, cfg)
        assert (res["ci_upper"] - res["ci_lower"]) > 1.3 * (naive["ci_upper"] - naive["ci_lower"])
        assert res["percentage"] == naive["percentage"]

    def test_the_effective_n_is_capped_at_n(self):
        """A design effect below 1 — answers within a record pulling apart — would
        give n* > n; NCHS caps it, and so do we (D54)."""
        # Each record answers two items, nearly always one yes and one no.
        recs = [[1.0, 0.0]] * 20 + [[1.0, 1.0]] * 2
        rows = [ResolvedRow(row_id=g, value_numeric=v, value_text=str(int(v)))
                for g, vals in enumerate(recs) for v in vals]
        totals, sizes = m._record_tallies(rows, lambda r: r.value_numeric)
        v = m.record_cluster_variance(totals, sizes)
        p = sum(r.value_numeric for r in rows) / len(rows)
        uncapped = p * (1 - p) / v * (m._Z_975 / m._t_critical(len(sizes) - 1)) ** 2
        assert uncapped > len(rows), "the fixture must reach the cap"
        assert m.effective_n(p, len(rows), v, len(sizes)) == len(rows)

    def test_no_spread_and_the_boundaries_take_n(self):
        assert m.effective_n(0.0, 30, 0.01, 10) == 30
        assert m.effective_n(1.0, 30, 0.01, 10) == 30
        assert m.effective_n(0.5, 30, 0.0, 10) == 30
        # A zero count still has an honest upper bound, from n.
        res, _, _ = m.compute_proportion(
            _rows([[1, 2], [2, 1], [1, 1]]),
            {"mode": "numeric", "operator": ">=", "threshold_numeric": 5}, by_record=True)
        assert res["ci_lower"] == 0.0 and res["ci_upper"] > 0

    def test_two_records_are_the_floor(self):
        one, _, _ = m.compute_proportion(
            _rows([[1, 5, 5]]), {"mode": "numeric", "operator": ">=", "threshold_numeric": 4},
            by_record=True)
        assert one["ci_lower"] is None and one["ci_method"] == m.CI_METHOD_WILSON_EFFECTIVE_N

    def test_the_text_mode_counts_records_too(self):
        rows = _rows(_balanced())
        res, _, _ = m.compute_proportion(
            rows, {"mode": "values", "threshold_values": ["4", "5"]}, by_record=True)
        num, _, _ = m.compute_proportion(
            rows, {"mode": "numeric", "operator": ">=", "threshold_numeric": 4}, by_record=True)
        assert (res["ci_lower"], res["ci_upper"]) == (num["ci_lower"], num["ci_upper"])

    def test_each_category_of_a_frequency(self):
        rows = _rows(_balanced())
        res, n, _ = m.compute_frequency_distribution(rows, by_record=True)
        naive, _, _ = m.compute_frequency_distribution(rows)
        assert res["ci_method"] == m.CI_METHOD_WILSON_PER_CATEGORY_EFFECTIVE_N
        assert naive["ci_method"] == m.CI_METHOD_WILSON_PER_CATEGORY
        assert res["record_count"] == 25
        for key in res["scale_order"]:
            hits = [1.0 if r.value_text == key else 0.0 for r in rows]
            v = _sandwich_cr1(hits, [r.row_id for r in rows])
            p = sum(hits) / n
            n_star = m.effective_n(p, n, v, 25)
            exp = m._wilson_bounds(p, n_star, "x")
            assert res["ci_lower_by_label"][key] == exp["ci_lower"], key
            assert res["ci_upper_by_label"][key] == exp["ci_upper"], key
        assert res["percentages"] == naive["percentages"]
        widened = [key for key in res["scale_order"]
                   if res["ci_upper_by_label"][key] - res["ci_lower_by_label"][key]
                   > naive["ci_upper_by_label"][key] - naive["ci_lower_by_label"][key] + 0.5]
        assert len(widened) >= 3, "the fixture must separate the two intervals"

    def test_a_category_padded_with_spaces_is_one_category_in_the_tally_too(self):
        """The count keys on the STRIPPED answer, and so must the record tally —
        otherwise the category's records would carry no hits and its interval
        would collapse to the naive one. Records hold 0, 1 or 2 of it, so the
        variance is not zero by construction."""
        rows = [ResolvedRow(row_id=g, value_numeric=None,
                            value_text="Maybe " if j < g % 3 else "No")
                for g in range(12) for j in range(3)]
        res, n, _ = m.compute_frequency_distribution(rows, by_record=True)
        assert set(res["counts"]) == {"Maybe", "No"}
        hits = [1.0 if r.value_text.strip() == "Maybe" else 0.0 for r in rows]
        p = sum(hits) / n
        v = _sandwich_cr1(hits, [r.row_id for r in rows])
        assert v > 0
        exp = m._wilson_bounds(p, m.effective_n(p, n, v, 12), "x")
        assert (res["ci_lower_by_label"]["Maybe"], res["ci_upper_by_label"]["Maybe"]) == (
            exp["ci_lower"], exp["ci_upper"])


# ── Through compute_metric: only a variable group's pooled metrics change ───────

PID = 13300
Q1, Q2, Q3, GRP = (PID * 10 + k for k in range(1, 5))


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=PID, name="Pooled intervals", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    for i, (cid, name, ctype) in enumerate(
            [(Q1, "q1", ColumnType.NUMERIC), (Q2, "q2", ColumnType.NUMERIC),
             (Q3, "q3", ColumnType.NUMERIC), (GRP, "site", ColumnType.NOMINAL)]):
        db.add(DatasetColumn(id=cid, dataset_id=PID, column_code=name, column_name=name,
                             column_text=name, column_type=ctype, sequence_order=i,
                             display_order=i))
    db.flush()
    vid = PID * 1000
    for g, vals in enumerate(_balanced(records=24, items=3)):
        db.add(DatasetRow(id=PID * 100 + g, dataset_id=PID))
        db.flush()
        cells = list(zip((Q1, Q2, Q3), vals)) + [(GRP, "North" if g % 2 else "South")]
        for cid, v in cells:
            vid += 1
            text = v if isinstance(v, str) else str(v)
            db.add(DatasetValue(id=vid, row_id=PID * 100 + g, column_id=cid,
                                value_text=text,
                                value_numeric=None if isinstance(v, str) else float(v)))
    db.add(AnalysisDomain(id=PID, project_id=PID, name="Scale"))
    db.flush()
    for i, cid in enumerate((Q1, Q2, Q3)):
        db.add(AnalysisDomainMember(domain_id=PID, member_type="column", member_id=cid,
                                    sequence_order=i))
    db.flush()
    return db


def _metric(db, mid, mtype, source_type, source_id, config=None, grouping=None):
    md = MetricDefinition(id=mid, project_id=PID, name=f"m{mid}", metric_type=mtype,
                          input_source_type=source_type, input_source_id=source_id,
                          grouping_column_id=grouping,
                          config=json.dumps(config or {}), origin="human", stale=False)
    db.add(md)
    db.flush()
    return [json.loads(r.result_data) for r in m.compute_metric(db, md)]


class TestThroughComputeMetric:
    def test_a_variable_groups_three_pooled_metrics(self, project):
        db = project
        mean = _metric(db, PID + 1, "mean", "dataset_domain", PID)[0]
        prop = _metric(db, PID + 2, "proportion", "dataset_domain", PID,
                       {"mode": "numeric", "operator": ">=", "threshold_numeric": 4})[0]
        freq = _metric(db, PID + 3, "frequency_distribution", "dataset_domain", PID)[0]
        assert mean["ci_method"] == m.CI_METHOD_RECORD_CLUSTER_T
        assert prop["ci_method"] == m.CI_METHOD_WILSON_EFFECTIVE_N
        assert freq["ci_method"] == m.CI_METHOD_WILSON_PER_CATEGORY_EFFECTIVE_N
        assert mean["record_count"] == prop["record_count"] == freq["record_count"] == 24
        assert mean["std_error"] is not None and prop["std_error"] is not None

    def test_a_column_metric_is_untouched(self, project):
        db = project
        mean = _metric(db, PID + 4, "mean", "dataset_column", Q1)[0]
        freq = _metric(db, PID + 5, "frequency_distribution", "dataset_column", Q1)[0]
        assert mean["ci_method"] == m.CI_METHOD_T_INTERVAL
        assert freq["ci_method"] == m.CI_METHOD_WILSON_PER_CATEGORY
        assert "record_count" not in mean and "std_error" not in mean

    def test_a_grouped_pooled_metric_counts_each_groups_records(self, project):
        db = project
        md = MetricDefinition(id=PID + 6, project_id=PID, name="by site", metric_type="mean",
                              input_source_type="dataset_domain", input_source_id=PID,
                              grouping_column_id=GRP, config="{}", origin="human", stale=False)
        db.add(md)
        db.flush()
        by_group = {r.group_value: json.loads(r.result_data) for r in m.compute_metric(db, md)}
        assert by_group["North"]["record_count"] == by_group["South"]["record_count"] == 12
        assert by_group["North"]["ci_method"] == m.CI_METHOD_RECORD_CLUSTER_T


def _detail_text(db) -> str:
    import io

    from openpyxl import load_workbook

    from app.models.user import User
    from app.routers.export_excel import export_datasets_excel
    from tests.test_export_formula_injection import _stream_to_bytes

    wb = load_workbook(io.BytesIO(_stream_to_bytes(
        export_datasets_excel(project_id=PID, user=db.get(User, 1), db=db))))
    ws = wb["Metrics Detail"]
    return " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None)


class TestTheWorkbookSaysWhichInterval:
    def test_a_pooled_frequency_is_described_as_counting_records(self, project):
        _metric(project, PID + 7, "frequency_distribution", "dataset_domain", PID)
        text = _detail_text(project)
        assert "not simultaneous" in text
        assert "each interval counts each record once" in text

    def test_a_column_frequency_alone_keeps_the_one_sentence(self, project):
        _metric(project, PID + 8, "frequency_distribution", "dataset_column", Q1)
        text = _detail_text(project)
        assert "not simultaneous" in text
        assert "counts each record once" not in text
