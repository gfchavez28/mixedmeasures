"""#1313 — a record is scored against the items its OWN dataset carries.

Until #1313 a record's score over a variable group was judged against every column
of the group that held a stored cell, across every dataset. In a group over three
datasets a complete record answered a third of it and was never scored; the saved
ANOVA by dataset then failed with "got 0 groups", and the stored scores fed the
Data view, the correlations, the matrix and the R export with nothing said.

Decisions taken (the 2026-10-22 pre-implementation review):
- **D1** — the record's OWN dataset's items, not "collapse equivalence groups
  first" (which drops records on a partial crosswalk; measured, and pinned below);
- **D2** — the denominator is the group's member columns from METADATA, not the
  columns that happen to hold a stored cell.

One helper decides who is scored — `metrics.domain_record_scores` — and both
`_compute_row_scores` branches and the saved t-test / ANOVA
(`statistical_tests._resolve_grouped_values`) read it. Every numeric expectation
below was checked in R 4.3.3 (`sc <- function(m) ifelse(rowSums(!is.na(m)) /
ncol(m) >= 0.5, rowMeans(m, na.rm = TRUE), NA)` per dataset, then `aov` /
`t.test`); the R values are quoted beside each assertion.

The repair (`metrics.repair_record_score_rule`, wired through
`data_repairs.run_data_repairs`) is tested both ways at the bottom.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models import (
    AnalysisDomain,
    AnalysisDomainMember,
    ComputedResult,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
    EquivalenceGroup,
    MetricDefinition,
    Project,
    RowScore,
    StatisticalTest,
)
from app.models.dataset import ColumnType
from app.services import metrics as metrics_service
from app.services.metrics import (
    RECORD_SCORE_RULE_KEY,
    RECORD_SCORE_RULE_OWN_DATASET_ITEMS,
    compute_metric,
    metrics_lacking_record_score_rule,
    repair_record_score_rule,
)
from app.services.statistical_tests import (
    _resolve_grouped_values,
    compute_statistical_test,
)

SCALE_SCORE_CONFIG = {"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}


# ── Fixture builder ──────────────────────────────────────────────────────────


@dataclass
class Built:
    project_id: int
    domain_id: int
    rows: dict[str, list[int]] = field(default_factory=dict)        # dataset → row ids
    cols: dict[str, dict[str, int]] = field(default_factory=dict)   # dataset → item → column id
    role_cols: dict[str, int] = field(default_factory=dict)         # dataset → Role column id


def _build(db, name: str, datasets: dict, linked: list[str], *, with_role: bool = False) -> Built:
    """`datasets`: {name: {"items": [...], "rows": [[value | None, ...]], "roles": [...]}}.

    `linked` items are joined across datasets by an equivalence group. A `None`
    cell stores NO row, as the import does for a blank cell.
    """
    project = Project(name=name, user_id=1)
    db.add(project)
    db.flush()
    groups = {item: EquivalenceGroup(project_id=project.id, label=item) for item in linked}
    db.add_all(groups.values())
    domain = AnalysisDomain(project_id=project.id, name=f"{name} scale")
    db.add(domain)
    db.flush()
    built = Built(project_id=project.id, domain_id=domain.id)
    member_seq = 0
    for ds_name, spec in datasets.items():
        ds = Dataset(project_id=project.id, name=ds_name)
        db.add(ds)
        db.flush()
        cols = []
        for i, item in enumerate(spec["items"]):
            col = DatasetColumn(
                dataset_id=ds.id, column_code=f"{ds_name}_{item}", column_name=f"{ds_name}_{item}",
                column_text=item, column_type=ColumnType.ORDINAL, sequence_order=i, display_order=i,
                equivalence_group_id=groups[item].id if item in groups else None,
            )
            db.add(col)
            cols.append(col)
        role = None
        if with_role:
            role = DatasetColumn(
                dataset_id=ds.id, column_code="Role", column_name="Role", column_text="Role",
                column_type=ColumnType.DEMOGRAPHIC, sequence_order=99, display_order=99,
            )
            db.add(role)
        db.flush()
        built.cols[ds_name] = {item: c.id for item, c in zip(spec["items"], cols)}
        if role is not None:
            built.role_cols[ds_name] = role.id
        for col in cols:
            db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                        member_id=col.id, sequence_order=member_seq))
            member_seq += 1
        built.rows[ds_name] = []
        for r, values in enumerate(spec["rows"]):
            row = DatasetRow(dataset_id=ds.id, row_identifier=f"{ds_name}{r}")
            db.add(row)
            db.flush()
            built.rows[ds_name].append(row.id)
            for col, v in zip(cols, values):
                if v is None:
                    continue
                db.add(DatasetValue(row_id=row.id, column_id=col.id,
                                    value_text=str(v), value_numeric=float(v)))
            if role is not None:
                db.add(DatasetValue(row_id=row.id, column_id=role.id,
                                    value_text=spec["roles"][r]))
        db.flush()
    return built


def _metric(db, built: Built, metric_type: str, config: dict | None = None, **kw) -> MetricDefinition:
    m = MetricDefinition(
        project_id=built.project_id, name=f"{metric_type} {kw}", metric_type=metric_type,
        input_source_type="dataset_domain", input_source_id=built.domain_id,
        config=json.dumps(config or {}), origin="human", **kw,
    )
    db.add(m)
    db.flush()
    compute_metric(db, m)
    return m


def _scale_score(db, built: Built) -> MetricDefinition:
    return _metric(db, built, "domain_aggregate", SCALE_SCORE_CONFIG,
                   origin_context="crosswalk_auto")


def _scores(db, metric: MetricDefinition) -> dict[int, float | None]:
    return {
        r.dataset_row_id: r.score
        for r in db.query(RowScore).filter(RowScore.metric_definition_id == metric.id)
    }


def _in_order(built: Built, scores: dict[int, float | None]) -> list[float | None]:
    """Scores in the fixture's dataset/row order; a record with NO RowScore row is `"absent"`."""
    return [scores.get(rid, "absent") for ds in built.rows for rid in built.rows[ds]]


def _test(db, built: Built, test_type: str, metric: MetricDefinition) -> StatisticalTest:
    t = StatisticalTest(project_id=built.project_id, test_type=test_type,
                        target_type="metric_definition", target_id=metric.id, origin="human")
    db.add(t)
    db.flush()
    compute_statistical_test(db, t)
    return t


def _approx_list(values):
    return [v if v is None else pytest.approx(v, abs=1e-4) for v in values]


# ── The shapes the issue was filed with ─────────────────────────────────────


S1 = {
    "A": {"items": ["i1", "i2", "i3"], "rows": [[5, None, 4], [4, 4, 4], [3, 3, None]]},
    "B": {"items": ["i1", "i2", "i3"], "rows": [[2, 3, 2], [1, None, None]]},
}

S2_DATA = {
    "W1": [[4, 5, 4], [3, 3, 4], [5, 4, 5]],
    "W2": [[2, 3, 3], [4, 4, 3], [3, 2, 2]],
    "W3": [[3, 4, 2], [2, 2, 3], [4, 3, 3]],
}
S2 = {k: {"items": ["i1", "i2", "i3"], "rows": v} for k, v in S2_DATA.items()}


def test_a_record_missing_one_of_three_items_in_a_two_dataset_group_is_scored(db_session):
    """`[5, –, 4]` answered 2 of the 3 items its dataset asked: 4.5, not NA.

    The old count was 6 (three columns in each of two datasets), so this record
    and `[3, 3, –]` were never scored. `[1, –, –]` answered a third: NA either way.
    """
    built = _build(db_session, "S1", S1, ["i1", "i2", "i3"])
    m = _scale_score(db_session, built)
    assert _in_order(built, _scores(db_session, m)) == _approx_list(
        [4.5, 4.0, 3.0, 2.3333, None],
    )


def test_three_complete_datasets_score_every_record_and_the_anova_by_dataset_runs(db_session):
    """0 of 9 records were scored, and the saved ANOVA failed with "got 0 groups".

    R: `aov(score ~ dataset)` F = 3.666667, p = .091125.
    """
    built = _build(db_session, "S2", S2, ["i1", "i2", "i3"])
    m = _scale_score(db_session, built)
    scores = _scores(db_session, m)
    assert len(scores) == 9 and all(s is not None for s in scores.values())
    assert _in_order(built, scores) == _approx_list(
        [4.3333, 3.3333, 4.6667, 2.6667, 3.6667, 2.3333, 3.0, 2.3333, 3.3333],
    )

    pooled = _metric(db_session, built, "mean", grouping_mode="dataset")
    anova = json.loads(_test(db_session, built, "one_way_anova", pooled).result_data)
    assert anova["f_statistic"] == pytest.approx(3.666667, abs=1e-4)
    assert anova["p_value"] == pytest.approx(0.091125, abs=1e-4)
    assert [g["n"] for g in anova["groups"]] == [3, 3, 3]


def test_alpha_is_not_moved_by_the_scoring_rule(db_session):
    """α reads its own listwise matrix, not the record scores (0.7773, n 9 before and after)."""
    built = _build(db_session, "S2a", S2, ["i1", "i2", "i3"])
    t = StatisticalTest(project_id=built.project_id, test_type="cronbachs_alpha",
                        target_type="analysis_domain", target_id=built.domain_id, origin="human")
    db_session.add(t)
    db_session.flush()
    result = compute_statistical_test(db_session, t)
    assert result["alpha"] == pytest.approx(0.7773, abs=1e-4)
    assert result["n"] == 9


# ── A partial crosswalk (datasets carrying 2, 3 and 2 of the items) ─────────

S3 = {
    "A": {"items": ["i1", "i2"], "rows": [[4, None], [4, 2], [5, 5], [3, 4]]},
    "B": {"items": ["i1", "i2", "i3"], "rows": [[4, 4, None], [2, 3, 3], [5, 4, 4], [1, None, None]]},
    "C": {"items": ["i1", "i3"], "rows": [[None, 2], [3, 3], [4, 5], [2, 2]]},
}
# R oracle (own-dataset rule): 4 3 5 3.5 · 4 2.666667 4.333333 NA · 2 3 4.5 2
S3_OWN = [4.0, 3.0, 5.0, 3.5, 4.0, 2.6667, 4.3333, None, 2.0, 3.0, 4.5, 2.0]


def test_a_partial_crosswalk_scores_each_record_against_its_own_datasets_items(db_session):
    """A at exactly ½ (`[4, –]`, and C's `[–, 2]`) is scored; B at ⅓ (`[1, –, –]`) is not.

    A dataset carrying the largest count (3) or the first dataset's (2) gives a
    different answer here, which is what kills those mutants.
    """
    built = _build(db_session, "S3", S3, ["i1", "i2", "i3"])
    m = _scale_score(db_session, built)
    assert _in_order(built, _scores(db_session, m)) == _approx_list(S3_OWN)


@pytest.mark.parametrize("grouping_mode", [None, "dataset"])
def test_the_pooled_branch_scores_the_partial_crosswalk_by_the_same_rule(db_session, grouping_mode):
    """The pooled `mean` branch (`metrics.py` had its own `len(column_groups)`) — ungrouped,
    and grouped by dataset so each record sits in a non-None bucket."""
    built = _build(db_session, "S3p", S3, ["i1", "i2", "i3"])
    m = _metric(db_session, built, "mean", grouping_mode=grouping_mode)
    assert _in_order(built, _scores(db_session, m)) == _approx_list(S3_OWN)


def _rule_scored_sets(datasets: dict, linked: list[str]) -> dict[str, set[tuple[str, int]]]:
    """Who each candidate rule scores on a fixture — computed from the fixture alone."""
    stored_columns = sum(
        1 for spec in datasets.values() for i in range(len(spec["items"]))
        if any(row[i] is not None for row in spec["rows"])
    )
    logical_items = len({item for spec in datasets.values() for item in spec["items"]})
    rules = {"old": {}, "collapse": {}, "own": {}}
    for ds, spec in datasets.items():
        for r, row in enumerate(spec["rows"]):
            answered = sum(v is not None for v in row)
            for rule, k in (("old", stored_columns), ("collapse", logical_items),
                            ("own", len(spec["items"]))):
                if answered / k >= 0.5:
                    rules[rule][(ds, r)] = True
    return {rule: set(scored) for rule, scored in rules.items()}


def test_the_partial_fixture_tells_the_three_rules_apart(db_session):
    """Discrimination: on this fixture the old rule, "collapse equivalence groups first"
    and the own-dataset rule each score a DIFFERENT set of records — so a test that
    passes here could not pass under either of the others. The app scores the own set.
    """
    sets = _rule_scored_sets(S3, ["i1", "i2", "i3"])
    assert sets["old"] != sets["collapse"] != sets["own"] != sets["old"]
    assert len(sets["old"]) == 0 and len(sets["collapse"]) == 9 and len(sets["own"]) == 11

    built = _build(db_session, "S3d", S3, ["i1", "i2", "i3"])
    scores = _scores(db_session, _scale_score(db_session, built))
    app_scored = {
        (ds, r) for ds, ids in built.rows.items() for r, rid in enumerate(ids)
        if scores.get(rid) is not None
    }
    assert app_scored == sets["own"]


# ── D2: the denominator is the group's member columns, not the stored ones ──


def test_a_never_answered_item_still_counts_toward_its_datasets_items(db_session):
    """One dataset, five items, the fifth answered by nobody (so no cell is stored).

    `[4, 4, –, –, –]` answered 2 of 5: NA. Counting only columns holding a cell
    made it 2 of 4 and scored it 4.0 — a score that depended on whether the
    survey tool exported non-response as a blank.
    """
    built = _build(db_session, "S5", {
        "A": {"items": ["i1", "i2", "i3", "i4", "i5"],
              "rows": [[4, 4, None, None, None], [3, None, 3, 3, None]]},
    }, [])
    m = _scale_score(db_session, built)
    assert _in_order(built, _scores(db_session, m)) == [None, pytest.approx(3.0)]


# ── Decompose reaches the saved test ────────────────────────────────────────


def _decomposed_i1(db, built: Built) -> MetricDefinition:
    i1_cols = sorted(cols["i1"] for cols in built.cols.values())
    return _metric(db, built, "mean",
                   {"decompose_column_ids": i1_cols, "decompose_label": "i1"},
                   grouping_mode="dataset")


def test_a_decomposed_items_scores_are_its_values_and_its_anova_reads_only_that_item(db_session):
    """One equivalence group over three datasets, decomposed to i1.

    Its scores were 0 of 9 (divided by 3). Its saved ANOVA read the WHOLE group
    through a resolver that never saw `decompose_column_ids` — with only the count
    fixed it would silently report the group's F 3.6667. R on i1 alone:
    `aov(i1 ~ wave)` F = 1, p = .421875.
    """
    built = _build(db_session, "S6", S2, ["i1", "i2", "i3"])
    m = _decomposed_i1(db_session, built)
    assert _in_order(built, _scores(db_session, m)) == _approx_list(
        [row[0] for ds in S2_DATA for row in S2_DATA[ds]],
    )
    anova = json.loads(_test(db_session, built, "one_way_anova", m).result_data)
    assert anova["f_statistic"] == pytest.approx(1.0, abs=1e-4)
    assert anova["p_value"] == pytest.approx(0.421875, abs=1e-4)
    assert anova["f_statistic"] != pytest.approx(3.6667, abs=1e-3)


# ── Grouped tests read the same sample the stored scores hold ───────────────

S4 = {
    "A": {"items": ["i1", "i2", "i3"],
          "rows": [[5, None, 4], [4, 4, 4], [3, 3, 3], [2, 2, None], [1, None, None]],
          "roles": ["staff", "board", "staff", "board", "staff"]},
    "B": {"items": ["i1", "i2", "i3"],
          "rows": [[2, 3, 2], [1, 2, 1], [4, None, 4], [3, 3, 3]],
          "roles": ["staff", "board", "board", "staff"]},
}


def test_a_grouped_t_test_by_role_across_two_datasets_matches_r(db_session):
    """Welch's t by Role, the anchor in A and its sibling matched by name in B.

    R: `t.test(board, staff)` t = −0.453990, df = 5.228175, p = .668064. The fifth
    A record answered a third and is NA in R too (t.test drops it).
    """
    built = _build(db_session, "S4", S4, ["i1", "i2", "i3"], with_role=True)
    m = _metric(db_session, built, "mean", grouping_column_id=built.role_cols["A"])
    tt = json.loads(_test(db_session, built, "independent_t_test", m).result_data)
    assert tt["t_statistic"] == pytest.approx(-0.453990, abs=1e-4)
    assert tt["df"] == pytest.approx(5.228175, abs=1e-4)
    assert tt["p_value"] == pytest.approx(0.668064, abs=1e-4)


def test_each_groups_n_in_the_saved_test_is_that_groups_non_null_scores(db_session):
    """The saved test and the stored scores agree about WHO is scored.

    staff has five records and four scores (the fifth answered a third), so this
    tells "records in the group" from "scored records in the group".
    """
    built = _build(db_session, "S4n", S4, ["i1", "i2", "i3"], with_role=True)
    m = _metric(db_session, built, "mean", grouping_column_id=built.role_cols["A"])
    tt = json.loads(_test(db_session, built, "independent_t_test", m).result_data)
    scores = _scores(db_session, m)
    by_role: dict[str, int] = {}
    for ds, spec in S4.items():
        for rid, role in zip(built.rows[ds], spec["roles"]):
            by_role[role] = by_role.get(role, 0) + (scores.get(rid) is not None)
    assert by_role == {"staff": 4, "board": 4}
    assert sum(r == "staff" for spec in S4.values() for r in spec["roles"]) == 5
    assert {tt["group1_label"]: tt["group1_n"], tt["group2_label"]: tt["group2_n"]} == by_role


@pytest.mark.parametrize("metric_type,config", [
    ("domain_aggregate", SCALE_SCORE_CONFIG),
    ("mean", {}),
    ("proportion", {"mode": "numeric", "operator": ">=", "threshold_numeric": 4}),
])
def test_the_test_resolver_reads_exactly_the_stored_scores(db_session, metric_type, config):
    """Per group, the values a saved test reads ARE the metric's non-null stored
    scores (to their 4-decimal rounding) — one rule, two readers."""
    built = _build(db_session, f"agree-{metric_type}", S3, ["i1", "i2", "i3"])
    m = _metric(db_session, built, metric_type, config, grouping_mode="dataset")
    stored = _scores(db_session, m)
    expected: dict[str, list[float]] = {}
    for ds, ids in built.rows.items():
        for rid in ids:
            if stored.get(rid) is not None:
                expected.setdefault(ds, []).append(stored[rid])
    if metric_type == "domain_aggregate":
        # A Group Aggregate's stored scores are its UNGROUPED records (the None
        # bucket, as compute_domain_aggregate reads it); grouped by dataset there
        # are none, while the test scores every record. Compare to the ungrouped twin.
        twin = _metric(db_session, built, metric_type, config)
        stored = _scores(db_session, twin)
        expected = {}
        for ds, ids in built.rows.items():
            for rid in ids:
                if stored.get(rid) is not None:
                    expected.setdefault(ds, []).append(stored[rid])
    got = _resolve_grouped_values(db_session, m, {})
    assert {k: sorted(round(v, 4) for v in vs) for k, vs in got.items()} == \
        {k: sorted(vs) for k, vs in expected.items()}


def test_a_proportion_metrics_test_reads_per_record_proportions(db_session):
    """The stated behaviour change: a domain `proportion` metric is tested on each
    record's PROPORTION of items at or above the threshold — what its stored scores
    always held — not on the mean of the raw item values."""
    built = _build(db_session, "prop", S1, ["i1", "i2", "i3"])
    m = _metric(db_session, built, "proportion",
                {"mode": "numeric", "operator": ">=", "threshold_numeric": 4},
                grouping_mode="dataset")
    got = _resolve_grouped_values(db_session, m, {})
    # A: [5,–,4] → 2/2 · [4,4,4] → 3/3 · [3,3,–] → 0/2 ; B: [2,3,2] → 0/3 · [1,–,–] → NA
    assert {k: sorted(v) for k, v in got.items()} == {"A": [0.0, 1.0, 1.0], "B": [0.0]}


def test_a_frequency_metrics_test_still_reads_record_means(db_session):
    """A grouped frequency distribution has no per-record rule of its own; a saved
    t-test on it reads each record's item mean, as it always did — now judged
    against the record's own dataset's items."""
    built = _build(db_session, "freq", S1, ["i1", "i2", "i3"])
    m = _metric(db_session, built, "frequency_distribution", grouping_mode="dataset")
    got = _resolve_grouped_values(db_session, m, {})
    assert {k: sorted(round(x, 4) for x in v) for k, v in got.items()} == {
        "A": [3.0, 4.0, 4.5], "B": [2.3333],
    }


# ── The marker ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("metric_type,config,kw", [
    ("domain_aggregate", SCALE_SCORE_CONFIG, {}),
    ("mean", {}, {"grouping_mode": "dataset"}),
    ("proportion", {"mode": "numeric", "operator": ">=", "threshold_numeric": 4}, {}),
    ("frequency_distribution", {}, {"grouping_mode": "dataset"}),
])
def test_compute_writes_the_marker_on_every_result_of_a_variable_group_metric(
    db_session, metric_type, config, kw,
):
    built = _build(db_session, f"mark-{metric_type}", S1, ["i1", "i2", "i3"])
    m = _metric(db_session, built, metric_type, config, **kw)
    results = db_session.query(ComputedResult).filter_by(metric_definition_id=m.id).all()
    assert results
    for r in results:
        assert json.loads(r.result_data)[RECORD_SCORE_RULE_KEY] == RECORD_SCORE_RULE_OWN_DATASET_ITEMS


# ── The repair ──────────────────────────────────────────────────────────────


def _as_an_older_build_wrote_it(db, *metrics: MetricDefinition) -> None:
    """Strip the marker, as a result computed before #1313 lacks it."""
    for m in metrics:
        for r in db.query(ComputedResult).filter_by(metric_definition_id=m.id):
            data = json.loads(r.result_data)
            data.pop(RECORD_SCORE_RULE_KEY, None)
            r.result_data = json.dumps(data)
        m.stale = False
    db.flush()


def _repair(db):
    report = repair_record_score_rule(db, metrics_lacking_record_score_rule(db))
    db.flush()
    db.expire_all()
    return report


def test_the_repair_marks_a_cross_dataset_score_and_its_saved_test_out_of_date(db_session):
    db = db_session
    built = _build(db, "R1", S2, ["i1", "i2", "i3"])
    score = _scale_score(db, built)
    pooled = _metric(db, built, "mean", grouping_mode="dataset")
    test = _test(db, built, "one_way_anova", pooled)
    _as_an_older_build_wrote_it(db, score, pooled)
    assert test.stale is False

    report = _repair(db)
    assert sorted(report.marked_stale) == sorted([score.id, pooled.id])
    assert db.get(MetricDefinition, score.id).stale is True
    assert db.get(MetricDefinition, pooled.id).stale is True
    assert db.get(StatisticalTest, test.id).stale is True
    # Quiet: a stale metric is not a candidate, and recomputing writes the marker.
    assert metrics_lacking_record_score_rule(db) == []
    compute_metric(db, db.get(MetricDefinition, score.id))
    assert metrics_lacking_record_score_rule(db) == []


def test_the_repair_marks_a_single_dataset_group_with_an_unanswered_item(db_session):
    """D2: the one single-dataset shape whose scores move."""
    db = db_session
    built = _build(db, "R3", {
        "A": {"items": ["i1", "i2", "i3", "i4", "i5"],
              "rows": [[4, 4, None, None, None], [3, None, 3, 3, None]]},
    }, [])
    score = _scale_score(db, built)
    _as_an_older_build_wrote_it(db, score)
    report = _repair(db)
    assert report.marked_stale == [score.id]
    assert db.get(MetricDefinition, score.id).stale is True


SINGLE = {
    "A": {"items": ["i1", "i2", "i3"],
          "rows": [[4, 5, 4], [3, None, 4], [5, 4, 5], [2, 3, 3], [4, 4, None], [1, 2, 2]],
          "roles": ["staff", "board", "staff", "board", "staff", "board"]},
}


def test_the_repair_leaves_a_group_whose_numbers_cannot_move_and_stamps_it(db_session):
    """One dataset, every item answered by someone, a mean: the old count equals
    the new one, so neither the scores nor a saved test can move. Marking them
    would be the marker that teaches a researcher to ignore it (#1149)."""
    db = db_session
    built = _build(db, "R2", SINGLE, [], with_role=True)
    score = _scale_score(db, built)
    grouped = _metric(db, built, "mean", grouping_column_id=built.role_cols["A"])
    test = _test(db, built, "independent_t_test", grouped)
    _as_an_older_build_wrote_it(db, score, grouped)

    report = _repair(db)
    assert report.marked_stale == [] and report.tests_marked == 0
    assert sorted(report.stamped) == sorted([score.id, grouped.id])
    assert db.get(MetricDefinition, score.id).stale is False
    assert db.get(MetricDefinition, grouped.id).stale is False
    assert db.get(StatisticalTest, test.id).stale is False
    for r in db.query(ComputedResult).filter(
        ComputedResult.metric_definition_id.in_([score.id, grouped.id]),
    ):
        assert json.loads(r.result_data)[RECORD_SCORE_RULE_KEY] == RECORD_SCORE_RULE_OWN_DATASET_ITEMS
    assert metrics_lacking_record_score_rule(db) == []


@pytest.mark.parametrize("kind", ["decomposed", "proportion"])
def test_the_repair_marks_only_the_test_when_only_the_tests_sample_moves(db_session, kind):
    """A single-dataset metric whose own scores cannot move, but whose saved test
    read something else before #1313: the WHOLE group (decomposed) or raw item
    means (proportion). Its tests are marked; the metric is stamped, not staled."""
    db = db_session
    built = _build(db, f"R4-{kind}", SINGLE, [], with_role=True)
    if kind == "decomposed":
        m = _metric(db, built, "mean", {"decompose_column_ids": [built.cols["A"]["i1"]],
                                        "decompose_label": "i1"},
                    grouping_column_id=built.role_cols["A"])
    else:
        m = _metric(db, built, "proportion",
                    {"mode": "numeric", "operator": ">=", "threshold_numeric": 4},
                    grouping_column_id=built.role_cols["A"])
    test = _test(db, built, "independent_t_test", m)
    _as_an_older_build_wrote_it(db, m)

    report = _repair(db)
    assert report.marked_stale == [] and report.tests_marked_for == [m.id]
    assert report.tests_marked == 1
    assert db.get(MetricDefinition, m.id).stale is False
    assert db.get(StatisticalTest, test.id).stale is True
    assert metrics_lacking_record_score_rule(db) == []


def test_a_frequency_metric_across_datasets_has_its_tests_marked_not_itself(db_session):
    """A frequency distribution has no record scores, so nothing of its own moves;
    a saved test on it scored records across every dataset's columns."""
    db = db_session
    built = _build(db, "R5", S2, ["i1", "i2", "i3"])
    m = _metric(db, built, "frequency_distribution", grouping_mode="dataset")
    test = _test(db, built, "one_way_anova", m)
    _as_an_older_build_wrote_it(db, m)
    report = _repair(db)
    assert report.marked_stale == [] and report.tests_marked_for == [m.id]
    assert db.get(StatisticalTest, test.id).stale is True


def test_a_result_this_build_wrote_is_never_a_candidate(db_session):
    """The gate keys on the marker: freshly computed cross-dataset metrics (whose
    scores DO differ from an older build's) are left alone, with their tests."""
    db = db_session
    built = _build(db, "R6", S2, ["i1", "i2", "i3"])
    score = _scale_score(db, built)
    pooled = _metric(db, built, "mean", grouping_mode="dataset")
    test = _test(db, built, "one_way_anova", pooled)
    assert metrics_lacking_record_score_rule(db) == []
    report = _repair(db)
    assert report.marked_stale == [] and report.tests_marked == 0
    assert db.get(MetricDefinition, score.id).stale is False
    assert db.get(StatisticalTest, test.id).stale is False


def test_an_already_stale_metric_is_left_to_its_recompute(db_session):
    db = db_session
    built = _build(db, "R7", S2, ["i1", "i2", "i3"])
    score = _scale_score(db, built)
    _as_an_older_build_wrote_it(db, score)
    score.stale = True
    db.flush()
    assert metrics_lacking_record_score_rule(db) == []


def test_an_unreadable_result_is_marked_stale_so_a_recompute_rewrites_it(db_session):
    db = db_session
    built = _build(db, "R8", SINGLE, [])
    score = _scale_score(db, built)
    r = db.query(ComputedResult).filter_by(metric_definition_id=score.id).one()
    r.result_data = "{not json"
    db.flush()
    report = _repair(db)
    assert report.marked_stale == [score.id]


# ── Wiring: entered at the mouth, one gating query, never raises ────────────


def _session_factory(db):
    return lambda: Session(bind=db.get_bind())


def test_the_repair_runs_from_run_data_repairs(db_session):
    """Entered at `run_data_repairs` — the ONE list the lifespan and a restore call."""
    from app.services.data_repairs import run_data_repairs

    db = db_session
    built = _build(db, "W1", S2, ["i1", "i2", "i3"])
    score = _scale_score(db, built)
    _as_an_older_build_wrote_it(db, score)
    db.commit()

    run_data_repairs(_session_factory(db))
    db.expire_all()
    assert db.get(MetricDefinition, score.id).stale is True


def test_a_settled_install_pays_exactly_one_query(db_session):
    from app.services.data_repairs import repair_record_scores

    db = db_session
    built = _build(db, "W2", S2, ["i1", "i2", "i3"])
    _scale_score(db, built)
    _metric(db, built, "mean", grouping_mode="dataset")
    db.commit()

    statements: list[str] = []
    engine = db.get_bind()

    def spy(conn, cursor, statement, *args):
        statements.append(statement.lstrip().split(None, 1)[0].upper())

    event.listen(engine, "before_cursor_execute", spy)
    try:
        repair_record_scores(_session_factory(db))
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    assert statements == ["SELECT"], statements


def test_the_repair_never_raises_into_startup(db_session, monkeypatch):
    from app.services import data_repairs

    def boom(_db):
        raise RuntimeError("simulated")

    monkeypatch.setattr(metrics_service, "metrics_lacking_record_score_rule", boom)
    ran_after: list[bool] = []
    monkeypatch.setattr(
        "app.services.media_backfill.run_media_duration_backfill",
        lambda _f: ran_after.append(True),
    )
    data_repairs.run_data_repairs(_session_factory(db_session))  # must not raise
    assert ran_after == [True]
