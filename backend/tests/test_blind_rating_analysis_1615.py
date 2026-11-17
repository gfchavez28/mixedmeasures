"""#1615 — while blind, nothing COMPUTED over a participant rating score reaches the viewer.

#1608 (D198) withheld the participant table's rating columns at the doors that SHOW the
table. This file asks the Quantitative page's doors — the ones that COMPUTE over a
column — both ways on one fixture, as `test_blind_file_scope_1530.py` does for the
files: unscoped (the leak: a number holding Bob's rating), scoped to Alice (left out,
and counted or refused with the reason), and scoped to every rater (D98: kept).

The fixture is #1608's `scored_project` plus a second participant, Ben, whose only
rating is Bob's 4 — so Ben's score IS Bob's judgement — and two of the researcher's own
columns on the participant table (Age, Site), so every door has an ORDINARY variable
beside the score: the positive control that a blind viewer still gets her analysis.

  participant table:  Ana  score 3.5 (Alice 2, Bob 5)   Age 30   Site A
                      Ben  score 4.0 (Bob 4)            Age 40   Site B
"""
import json

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.code_application import CodeApplication
from app.models.dataset import ColumnType, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.participant import Participant
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.statistical_test import StatisticalTest
from app.services.participant_scores import RATING_COLUMNS_WITHHELD_NOTE
from tests.conftest import mock_request
from tests.test_blind_file_scope_1530 import (  # noqa: F401 — fixtures
    ALICE, BOB, PID, SCOPE, SHARED, _body, _filename, _run, _user,
    blind_project, scored_project,
)

BOTH = f"{ALICE},{BOB}"
T5 = 15305


@pytest.fixture
def analysed(scored_project):
    from app.services import participant_scores as ps

    db, ds = scored_project["db"], scored_project["dataset"]
    ben = Participant(project_id=PID, identifier="Ben")
    db.add(ben)
    db.add(Speaker(id=15302, project_id=PID, name="Ben", is_facilitator=0, color_index=2))
    db.flush()
    db.get(Speaker, 15302).participant_id = ben.id
    db.add(Segment(id=T5, conversation_id=PID, sequence_order=5,
                   text="Ben: the clinic moved.", speaker_id=15302))
    db.add(CodeApplication(code_id=SHARED, user_id=BOB, segment_id=T5, magnitude=4.0))
    db.flush()
    ps.refresh_participant_dataset(db, PID)

    rows = {pid: rid for rid, pid in db.query(DatasetRow.id, DatasetRow.participant_id)
            .filter(DatasetRow.dataset_id == ds.id)}
    ana = scored_project["ana"]
    age = DatasetColumn(id=16150, dataset_id=ds.id, column_code="age", column_name="Age",
                        column_text="Age", column_type=ColumnType.NUMERIC, source="manual",
                        sequence_order=50, display_order=50)
    site = DatasetColumn(id=16151, dataset_id=ds.id, column_code="site", column_name="Site",
                         column_text="Site", column_type=ColumnType.NOMINAL, source="manual",
                         sequence_order=51, display_order=51)
    visits = DatasetColumn(id=16154, dataset_id=ds.id, column_code="visits", column_name="Visits",
                           column_text="Visits", column_type=ColumnType.NUMERIC, source="manual",
                           sequence_order=52, display_order=52)
    db.add_all([age, site, visits])
    db.flush()
    for pid, a, s, v in ((ana.id, 30, "A", 2), (ben.id, 40, "B", 5)):
        db.add(DatasetValue(row_id=rows[pid], column_id=age.id, value_text=str(a), value_numeric=a))
        db.add(DatasetValue(row_id=rows[pid], column_id=site.id, value_text=s))
        db.add(DatasetValue(row_id=rows[pid], column_id=visits.id, value_text=str(v), value_numeric=v))
    score = scored_project["cols"]["magnitude_score"]
    domain = AnalysisDomain(id=16152, project_id=PID, name="Mixed")
    db.add(domain)
    db.flush()
    db.add_all([AnalysisDomainMember(domain_id=domain.id, member_type="column", member_id=score.id),
                AnalysisDomainMember(domain_id=domain.id, member_type="column", member_id=age.id)])
    db.flush()
    return {**scored_project, "db": db, "score": score, "age": age, "site": site,
            "visits": visits, "domain": domain, "ben": ben}


def _metric(db, column_id, *, grouping=None, name="m"):
    from app.services.metrics import compute_metric
    m = MetricDefinition(project_id=PID, name=name, metric_type="mean", config="{}",
                         input_source_type="dataset_column", input_source_id=column_id,
                         grouping_column_id=grouping, sequence_order=0)
    db.add(m)
    db.flush()
    compute_metric(db, m)
    db.flush()
    return m


# ── The predicate ────────────────────────────────────────────────────────────


class TestThePredicate:
    def test_the_project_helper_is_the_tables_rule(self, analysed):
        from app.services.participant_scores import withheld_rating_columns_in_project
        db = analysed["db"]
        withheld = withheld_rating_columns_in_project(db, PID, [ALICE])
        assert analysed["score"].id in withheld
        assert analysed["age"].id not in withheld and analysed["site"].id not in withheld
        assert withheld_rating_columns_in_project(db, PID, [ALICE, BOB]) == frozenset()
        assert withheld_rating_columns_in_project(db, PID, None) == frozenset()

    def test_a_metric_is_withheld_by_what_it_reads(self, analysed):
        from app.services.rating_withholding import rating_withholding
        db = analysed["db"]
        w = rating_withholding(db, PID, [ALICE])
        assert w.metric(db, _metric(db, analysed["score"].id))
        assert not w.metric(db, _metric(db, analysed["age"].id))
        # Grouped BY a column computed from a score is reading it too.
        band = DatasetColumn(id=16153, dataset_id=analysed["dataset"].id, column_code="band",
                             column_name="band", column_text="Band", source="computed",
                             column_type=ColumnType.NOMINAL, expression="x", sequence_order=60,
                             depends_on_column_ids=json.dumps([analysed["score"].id]))
        db.add(band)
        db.flush()
        w = rating_withholding(db, PID, [ALICE])
        assert w.metric(db, _metric(db, analysed["age"].id, grouping=band.id))
        assert w.domain(db, analysed["domain"].id)

    def test_a_variable_group_metric_is_withheld_by_a_sibling_grouping_column(self, analysed):
        """Grouped by the SURVEY's "Band", a variable group spanning the survey and the
        participant table groups the table's rows by ITS "Band" (matched by name,
        `_resolve_grouping_siblings`) — here a band of the score, so the groups are
        people's every-coder scores though the anchor the researcher picked is not."""
        from app.services.rating_withholding import rating_withholding
        from tests.test_blind_file_scope_1530 import NUM_COL
        db, table = analysed["db"], analysed["dataset"]
        db.add_all([
            DatasetColumn(id=16155, dataset_id=PID, column_code="band", column_name="Band",
                          column_text="Band", column_type=ColumnType.DEMOGRAPHIC,
                          sequence_order=5, display_order=5),
            DatasetColumn(id=16156, dataset_id=table.id, column_code="band", column_name="Band",
                          column_text="Band", column_type=ColumnType.DEMOGRAPHIC,
                          source="computed", expression="x", sequence_order=61,
                          depends_on_column_ids=json.dumps([analysed["score"].id])),
            AnalysisDomain(id=16157, project_id=PID, name="Cross"),
        ])
        db.flush()
        db.add_all([AnalysisDomainMember(domain_id=16157, member_type="column", member_id=NUM_COL),
                    AnalysisDomainMember(domain_id=16157, member_type="column",
                                         member_id=analysed["age"].id)])
        m = MetricDefinition(project_id=PID, name="cross", metric_type="mean", config="{}",
                             input_source_type="dataset_domain", input_source_id=16157,
                             grouping_column_id=16155, sequence_order=0)
        db.add(m)
        db.flush()
        w = rating_withholding(db, PID, [ALICE])
        assert not w.domain(db, 16157)        # neither member is a score …
        assert not w.column(16155)            # … nor is the anchor …
        assert w.metric(db, m)                # … but its sibling grouping column is


# ── The picker list (C4) ─────────────────────────────────────────────────────


class TestTheAnalysisColumns:
    def _cols(self, db, coder_ids=None):
        from app.routers.metrics import get_analysis_columns
        resp = _run(get_analysis_columns(PID, user=_user(db), db=db, coder_ids=coder_ids))
        cols = {c.id: c for g in resp.datasets for c in g.columns}
        return cols, {d.id: d for d in resp.domains}

    def test_a_rating_score_is_marked_not_dropped(self, analysed):
        db, score, age = analysed["db"], analysed["score"], analysed["age"]
        cols, doms = self._cols(db)
        assert not cols[score.id].withheld_while_blind          # unscoped: offered as today
        cols, doms = self._cols(db, SCOPE)
        assert cols[score.id].withheld_while_blind               # still listed, marked
        assert not cols[age.id].withheld_while_blind             # control
        assert doms[analysed["domain"].id].withheld_while_blind  # a group holding a score
        cols, _ = self._cols(db, BOTH)
        assert not cols[score.id].withheld_while_blind


# ── Saved metrics ────────────────────────────────────────────────────────────


class TestTheMetricDoors:
    def test_quick_compute_returns_no_numbers_for_a_score(self, analysed):
        from app.routers.metrics import quick_compute
        from app.schemas.metric import QuickComputeRequest
        db = analysed["db"]

        def ask(coder_ids=None):
            body = QuickComputeRequest(
                sources=[{"source_type": "dataset_column", "source_id": analysed["score"].id},
                         {"source_type": "dataset_column", "source_id": analysed["age"].id}],
                metric_type="mean", config={})
            out = _run(quick_compute(PID, body, user=_user(db), db=db, coder_ids=coder_ids))
            return {m.input_source_id: m for m in out.metrics}

        full = ask()
        (r,) = full[analysed["score"].id].results
        assert r.result_data["mean"] == pytest.approx(3.75)    # the leak: (3.5 + Bob's 4) / 2
        blind = ask(SCOPE)
        assert blind[analysed["score"].id].withheld_while_blind
        assert blind[analysed["score"].id].results == []
        assert not blind[analysed["age"].id].withheld_while_blind
        assert blind[analysed["age"].id].results[0].result_data["mean"] == pytest.approx(35)
        assert ask(BOTH)[analysed["score"].id].results

    def test_every_single_metric_read_leaves_the_numbers_out(self, analysed):
        from app.routers.metrics import (
            compute_single_metric, get_metric, get_metric_results, list_metrics,
        )
        db = analysed["db"]
        m = _metric(db, analysed["score"].id)
        u = _user(db)
        assert _run(get_metric(PID, m.id, user=u, db=db)).results
        assert _run(get_metric(PID, m.id, user=u, db=db, coder_ids=SCOPE)).results == []
        assert _run(get_metric_results(PID, m.id, user=u, db=db))
        assert _run(get_metric_results(PID, m.id, user=u, db=db, coder_ids=SCOPE)) == []
        assert _run(compute_single_metric(PID, m.id, user=u, db=db, coder_ids=SCOPE)) == []
        summary = {s.id: s for s in _run(list_metrics(PID, user=u, db=db, coder_ids=SCOPE)).metrics}
        assert summary[m.id].withheld_while_blind and summary[m.id].total_valid_n is None
        full = {s.id: s for s in _run(list_metrics(PID, user=u, db=db)).metrics}
        assert full[m.id].total_valid_n == 2

    def test_the_record_matrix_leaves_the_score_column_out(self, analysed):
        from app.routers.metrics import get_row_matrix, get_row_matrix_csv
        db = analysed["db"]
        u = _user(db)
        ms, ma = _metric(db, analysed["score"].id, name="s"), _metric(db, analysed["age"].id, name="a")
        ids = f"{ms.id},{ma.id}"
        full = get_row_matrix(PID, ids, u, db)
        assert {c.metric_id for c in full.columns} == {ms.id, ma.id}
        assert sorted(r.scores[str(ms.id)] for r in full.rows) == [3.5, 4.0]   # Ben's 4 is Bob's
        blind = get_row_matrix(PID, ids, u, db, coder_ids=SCOPE)
        assert [c.metric_id for c in blind.columns] == [ma.id]
        assert all(str(ms.id) not in r.scores for r in blind.rows)
        assert blind.withheld_rating_variables == 1
        resp = get_row_matrix_csv(PID, ids, u, db, coder_ids=SCOPE)
        assert _filename(resp) == "row_matrix_coder-Alice.csv"
        assert "3.5" not in _body(resp).decode()

    def test_the_cross_tab_with_a_score_axis_is_not_computed(self, analysed):
        from app.routers.metrics import cross_tabulation
        from app.schemas.metric import CrossTabRequest
        db = analysed["db"]
        body = CrossTabRequest(row_column_id=analysed["score"].id, col_column_id=analysed["site"].id)
        assert _run(cross_tabulation(PID, body, user=_user(db), db=db)).row_values   # the leak
        blind = _run(cross_tabulation(PID, body, user=_user(db), db=db, coder_ids=SCOPE))
        assert blind.row_values == [] and blind.matrix == []
        assert blind.withheld_rating_variables == 1


# ── The Relationships & Comparisons tab ──────────────────────────────────────


class TestTheComparisonAndCorrelations:
    def _compare(self, db, coder_ids=None, **kw):
        from app.routers.comparisons import group_comparison
        from app.schemas.comparison import GroupComparisonRequest, GroupComparisonResponse
        body = GroupComparisonRequest(**{"test_type": "auto", **kw})
        out = _run(group_comparison(PID, body, user=_user(db), db=db, coder_ids=coder_ids))
        return GroupComparisonResponse(**out)    # the wire's own check

    def test_the_comparison_leaves_a_score_out_and_counts_it(self, analysed):
        from app.services.undefined_stats import RATING_WITHHELD_BLIND
        db, score, age, site = analysed["db"], analysed["score"], analysed["age"], analysed["site"]
        kw = dict(column_ids=[score.id, age.id], grouping_column_id=site.id)
        assert {r.source_id for r in self._compare(db, **kw).rows} == {score.id, age.id}
        blind = self._compare(db, SCOPE, **kw)
        assert [r.source_id for r in blind.rows] == [age.id]
        assert blind.withheld_rating_variables == 1 and blind.unavailable_reason is None
        only = self._compare(db, SCOPE, column_ids=[score.id], grouping_column_id=site.id)
        assert only.rows == [] and only.unavailable_reason == RATING_WITHHELD_BLIND
        assert {r.source_id for r in self._compare(db, BOTH, **kw).rows} == {score.id, age.id}

    def test_grouping_by_a_score_is_not_computed(self, analysed):
        from app.services.undefined_stats import RATING_WITHHELD_BLIND
        db = analysed["db"]
        blind = self._compare(db, SCOPE, column_ids=[analysed["age"].id],
                              grouping_column_id=analysed["score"].id)
        assert blind.rows == [] and blind.groups == []
        assert blind.unavailable_reason == RATING_WITHHELD_BLIND

    def test_a_variable_group_holding_a_score_is_left_out(self, analysed):
        from app.services.undefined_stats import RATING_WITHHELD_BLIND
        db = analysed["db"]
        blind = self._compare(db, SCOPE, domain_ids=[analysed["domain"].id],
                              grouping_column_id=analysed["site"].id)
        assert blind.rows == [] and blind.unavailable_reason == RATING_WITHHELD_BLIND

    def test_the_comparison_csv_says_what_it_left_out(self, analysed):
        from app.routers.comparisons import group_comparison_csv
        db = analysed["db"]
        ids = f"{analysed['score'].id},{analysed['age'].id}"
        resp = _run(group_comparison_csv(PID, column_ids=ids, domain_ids=None,
                                         grouping_column_id=analysed["site"].id,
                                         grouping_column_id_2=None, test_type="auto",
                                         exclude_groups=None, nonparametric=False,
                                         user=_user(db), db=db, coder_ids=SCOPE))
        text = _body(resp).decode()
        assert "Scope: 1 rating variable(s) left out. " + RATING_COLUMNS_WITHHELD_NOTE in text
        assert "Shared theme" not in text
        assert _filename(resp).endswith("_coder-Alice.csv")

    def test_the_correlation_matrix_leaves_a_score_out(self, analysed):
        from app.routers.correlations import correlation_matrix
        from app.schemas.correlation import CorrelationMatrixRequest, CorrelationMatrixResponse
        db, score, age, visits = analysed["db"], analysed["score"], analysed["age"], analysed["visits"]
        body = CorrelationMatrixRequest(column_ids=[score.id, age.id, visits.id])
        full = _run(correlation_matrix(PID, body, user=_user(db), db=db))
        assert len(full["labels"]) == 3
        blind = CorrelationMatrixResponse(**_run(
            correlation_matrix(PID, body, user=_user(db), db=db, coder_ids=SCOPE)))
        assert blind.labels == ["Age", "Visits"] and blind.withheld_rating_variables == 1

    def test_a_scatter_point_is_a_person_so_a_score_axis_is_refused(self, analysed):
        from fastapi import HTTPException
        from app.routers.correlations import scatter_data
        from app.schemas.correlation import ScatterDataRequest
        db, score, age, site = analysed["db"], analysed["score"], analysed["age"], analysed["site"]
        body = ScatterDataRequest(x_id=score.id, y_id=age.id, id_type="column")
        assert sorted(_run(scatter_data(PID, body, user=_user(db), db=db))["x"]) == [3.5, 4.0]
        with pytest.raises(HTTPException) as e:
            _run(scatter_data(PID, body, user=_user(db), db=db, coder_ids=SCOPE))
        assert e.value.status_code == 409 and e.value.detail == RATING_COLUMNS_WITHHELD_NOTE
        # A score as the COLOUR: dropped and counted, the points kept.
        coloured = ScatterDataRequest(x_id=age.id, y_id=age.id, id_type="column",
                                      group_column_id=score.id)
        out = _run(scatter_data(PID, coloured, user=_user(db), db=db, coder_ids=SCOPE))
        assert out["groups"] is None and out["withheld_rating_variables"] == 1
        assert _run(scatter_data(PID, body, user=_user(db), db=db, coder_ids=BOTH))["x"]


# ── Data Quality ─────────────────────────────────────────────────────────────


class TestDataQuality:
    def test_the_missing_summary_leaves_a_score_out(self, analysed):
        from fastapi import HTTPException
        from app.routers.data_quality import missing_summary
        from app.schemas.data_quality import DataQualityRequest, MissingSummaryResponse
        db, score, age = analysed["db"], analysed["score"], analysed["age"]
        body = DataQualityRequest(column_ids=[score.id, age.id])
        assert len(_run(missing_summary(PID, body, user=_user(db), db=db))["variables"]) == 2
        blind = MissingSummaryResponse(**_run(
            missing_summary(PID, body, user=_user(db), db=db, coder_ids=SCOPE)))
        assert [v.column_id for v in blind.variables] == [age.id]
        assert blind.withheld_rating_variables == 1
        with pytest.raises(HTTPException) as e:
            _run(missing_summary(PID, DataQualityRequest(column_ids=[score.id]),
                                 user=_user(db), db=db, coder_ids=SCOPE))
        assert e.value.status_code == 409


# ── Saved tests, variable-group scores ───────────────────────────────────────


class TestSavedTestsAndGroupScores:
    def test_a_saved_test_over_a_score_shows_no_result(self, analysed):
        from app.routers.statistical_tests import get_test, list_tests
        db = analysed["db"]
        m = _metric(db, analysed["score"].id, grouping=analysed["site"].id)
        t = StatisticalTest(project_id=PID, test_type="independent_t_test", config="{}",
                            target_type="metric_definition", target_id=m.id,
                            result_data=json.dumps({"t": 1.0, "p": 0.5}), valid_n=2, stale=False)
        alpha = StatisticalTest(project_id=PID, test_type="cronbachs_alpha", config="{}",
                                target_type="analysis_domain", target_id=analysed["domain"].id,
                                result_data=json.dumps({"alpha": 0.7}), valid_n=2, stale=False)
        db.add_all([t, alpha])
        db.flush()
        assert _run(get_test(PID, t.id, user=_user(db), db=db)).result_data   # the leak
        blind = _run(get_test(PID, t.id, user=_user(db), db=db, coder_ids=SCOPE))
        assert blind.result_data is None and blind.valid_n is None and blind.withheld_while_blind
        listed = {x.id: x for x in _run(list_tests(PID, user=_user(db), db=db, coder_ids=SCOPE)).tests}
        assert listed[alpha.id].withheld_while_blind and listed[alpha.id].result_data is None

    def test_the_data_views_group_scores_leave_a_score_group_out(self, analysed):
        from app.routers.dataset import get_domain_scores
        from app.services.metrics import create_scale_score_metric
        db, ds = analysed["db"], analysed["dataset"]
        create_scale_score_metric(db, analysed["domain"])
        db.flush()
        full = _run(get_domain_scores(PID, ds.id, user=_user(db), db=db))
        assert [d["domain_id"] for d in full["domain_scores"]] == [analysed["domain"].id]
        blind = _run(get_domain_scores(PID, ds.id, user=_user(db), db=db, coder_ids=SCOPE))
        assert blind == {"domain_scores": [], "withheld_rating_variables": 1}

    def test_creating_a_score_groups_scale_score_returns_no_numbers(self, analysed):
        from app.routers.analysis_domains import create_score_metric
        db = analysed["db"]
        out = _run(create_score_metric(mock_request(), PID, analysed["domain"].id,
                                       user=_user(db), db=db, coder_ids=SCOPE))
        assert out["metric"].withheld_while_blind and out["metric"].results == []
