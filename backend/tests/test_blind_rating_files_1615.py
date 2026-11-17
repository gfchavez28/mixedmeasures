"""#1615 (r4) — the Variables view, the computed-column preview and the FILES, while blind.

#1608 (D198) withheld the participant table's rating columns at the doors that SHOW the
table. These doors COMPUTE or summarise over a score column and still read the shared
snapshot — every coder's ratings. On `scored_project` Ana's T1 carries Alice's 2 and Bob's
5: the snapshot reads 3.5, so any of these showing 3.5 to a blind Alice hands her Bob's 5
(2 × 3.5 − 2). Each door is asked BOTH ways (unscoped: the number is there; scoped to
Alice: it is not, and the door says so), with a scope holding every rater and an ordinary
column as the controls.
"""
from __future__ import annotations

import io
import json

from openpyxl import load_workbook

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import Dataset, DatasetColumn
from app.models.metric import MetricDefinition
from app.services.metrics import compute_metric, create_scale_score_metric
from tests.test_blind_file_scope_1530 import (  # noqa: F401 — fixtures
    ALICE, BOB, NUM_COL, PID, SCOPE, _body, _filename, _member, _r_zip, _run, _user,
    blind_project, scored_project,
)

EVERY_RATER = f"{ALICE},{BOB}"


def _score_col(sp) -> DatasetColumn:
    return sp["cols"]["magnitude_score"]


# ── The Variables view's observed values ──────────────────────────────────────

def _freqs(db, dataset_id, column_id, coder_ids=None):
    from app.routers.recode import column_frequencies
    return _run(column_frequencies(PID, dataset_id, column_id, user=_user(db), db=db,
                                   coder_ids=coder_ids))


class TestTheObservedValues:
    def test_a_score_columns_values_are_withheld_while_blind(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        col = _score_col(scored_project)
        full = _freqs(db, ds.id, col.id)
        assert [f.value_text for f in full.frequencies] == ["3.500"]   # the leak, unscoped
        assert full.withheld_while_blind is False

        scoped = _freqs(db, ds.id, col.id, SCOPE)
        assert scoped.frequencies == [] and scoped.total == 0
        assert scoped.withheld_while_blind is True

    def test_a_scope_holding_every_rater_keeps_them(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        col = _score_col(scored_project)
        every = _freqs(db, ds.id, col.id, EVERY_RATER)
        assert [f.value_text for f in every.frequencies] == ["3.500"]
        assert every.withheld_while_blind is False

    def test_an_ordinary_column_is_untouched_while_blind(self, scored_project):
        db = scored_project["db"]
        num = db.get(DatasetColumn, NUM_COL)
        assert _freqs(db, num.dataset_id, NUM_COL, SCOPE).model_dump() == \
            _freqs(db, num.dataset_id, NUM_COL).model_dump()

    def test_the_rated_passage_count_is_withheld_too(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        count_col = scored_project["cols"]["magnitude_rated_targets"]
        assert _freqs(db, ds.id, count_col.id, SCOPE).withheld_while_blind is True


# ── The computed-column preview ───────────────────────────────────────────────

def _preview(db, ds_id, expression, coder_ids=None):
    from app.routers.dataset import preview_computed_column
    from app.schemas.dataset import ComputedColumnCreate
    req = ComputedColumnCreate(column_text="Band", expression=expression)
    return _run(preview_computed_column(PID, ds_id, req, user=_user(db), db=db,
                                        coder_ids=coder_ids))


class TestTheComputedPreview:
    def test_a_preview_over_a_score_shows_no_value_while_blind(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        expr = f"[{_score_col(scored_project).column_text}] * 2"
        full = _preview(db, ds.id, expr)
        assert full["valid"] is True
        assert [r["result_numeric"] for r in full["preview_rows"]] == [7.0]   # the leak
        assert "3.5" in json.dumps(full["preview_rows"])

        scoped = _preview(db, ds.id, expr, SCOPE)
        assert scoped["valid"] is True                      # the expression is still checked
        assert scoped["preview_rows"] == []
        assert scoped["values_withheld_while_blind"] is True
        assert "3.5" not in json.dumps(scoped) and "7.0" not in json.dumps(scoped)

    def test_a_preview_over_ordinary_columns_is_untouched(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        ident = next(c for c in ds.columns if c.source == "managed"
                     and c.id not in {x.id for x in scored_project["cols"].values()})
        expr = f'if ([{ident.column_text}] == "Ana", 1, 0)'
        full, scoped = _preview(db, ds.id, expr), _preview(db, ds.id, expr, SCOPE)
        assert full["preview_rows"] and scoped["preview_rows"] == full["preview_rows"]
        assert scoped["values_withheld_while_blind"] is False


# ── The datasets workbook's Computed Metrics sheets ───────────────────────────

def _mean_metric(db, column_id, name, grouping_column_id=None):
    m = MetricDefinition(project_id=PID, name=name, metric_type="mean", config="{}",
                         input_source_type="dataset_column", input_source_id=column_id,
                         grouping_column_id=grouping_column_id)
    db.add(m)
    db.flush()
    compute_metric(db, m)
    db.flush()
    return m


def _book(db, coder_ids=None):
    from app.routers.export_excel import export_datasets_excel
    resp = export_datasets_excel(PID, user=_user(db), db=db, coder_ids=coder_ids)
    return load_workbook(io.BytesIO(_body(resp)), read_only=False)


def _all_text(book) -> str:
    return " ".join(str(c) for ws in book.worksheets
                    for r in ws.iter_rows(values_only=True) for c in r if c is not None)


def _summary_names(book):
    if "Metrics Summary" not in book.sheetnames:
        return []
    return [r[1] for r in book["Metrics Summary"].iter_rows(min_row=2, values_only=True)]


class TestTheWorkbooksMetrics:
    def test_a_metric_over_a_score_is_left_out_and_said(self, scored_project):
        db = scored_project["db"]
        _mean_metric(db, _score_col(scored_project).id, "Shared mean")
        _mean_metric(db, NUM_COL, "Survey mean")                     # the control
        full = _book(db)
        rows = {r[1]: r[5] for r in full["Metrics Summary"].iter_rows(min_row=2, values_only=True)}
        assert rows["Shared mean"] == 3.5                            # the leak, unscoped

        scoped = _book(db, SCOPE)
        assert _summary_names(scoped) == ["Survey mean"]
        note = list(scoped["Data Dictionary"].iter_rows(min_row=2, values_only=True))[-1][0]
        assert "1 computed metric that uses them is left out too." in note
        assert "3.5" not in _all_text(scoped)

    def test_a_metric_GROUPED_by_a_score_is_left_out_too(self, scored_project):
        """Its groups are the score's values: a group per participant band is the score."""
        db = scored_project["db"]
        _mean_metric(db, NUM_COL, "Survey by score",
                     grouping_column_id=_score_col(scored_project).id)
        assert "Survey by score" in _all_text(_book(db))
        assert "Survey by score" not in _all_text(_book(db, SCOPE))

    def test_a_scale_score_over_a_group_holding_a_score_is_left_out_too(self, scored_project):
        db = scored_project["db"]
        _score_group(db, scored_project)
        assert "Rated scale" in _all_text(_book(db))
        assert "Rated scale" not in _all_text(_book(db, SCOPE))

    def test_every_rater_keeps_the_metric(self, scored_project):
        db = scored_project["db"]
        _mean_metric(db, _score_col(scored_project).id, "Shared mean")
        assert _summary_names(_book(db, EVERY_RATER)) == ["Shared mean"]


# ── The R export: a variable group over a score ───────────────────────────────

def _score_group(db, sp):
    dom = AnalysisDomain(project_id=PID, name="Rated scale")
    db.add(dom)
    db.flush()
    db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column",
                                member_id=_score_col(sp).id))
    db.flush()
    metric, _ = create_scale_score_metric(db, dom)
    db.flush()
    compute_metric(db, metric)
    db.flush()
    return dom


class TestTheRExportsVariableGroups:
    def test_a_groups_scale_score_over_a_score_is_left_out_while_blind(self, scored_project):
        db = scored_project["db"]
        _score_group(db, scored_project)
        full, _ = _r_zip(db)
        full_csv = _member(full, "_data.csv").decode("utf-8-sig")
        assert "rated_scale" in full_csv.splitlines()[0].lower()       # the score column …
        assert "3.5" in full_csv                                       # … holding the leak

        scoped, _ = _r_zip(db, SCOPE)
        csv = _member(scoped, "_data.csv").decode("utf-8-sig")
        assert "rated_scale" not in csv.splitlines()[0].lower()
        assert "3.5" not in csv
        setup = _member(scoped, ".R").decode("utf-8")
        assert "Rated scale" not in setup.split("# ---- Helpers")[0].replace(
            "1 variable group over them left out", "")
        assert "1 variable group over them left out" in setup

    def test_every_rater_keeps_the_group(self, scored_project):
        db = scored_project["db"]
        _score_group(db, scored_project)
        every, _ = _r_zip(db, EVERY_RATER)
        assert "rated_scale" in _member(every, "_data.csv").decode("utf-8-sig").splitlines()[0].lower()


def _mixed_group(db, sp):
    """A group of the score and two hand-made items on the participant table, with a
    saved α — the script must not rebuild either over the two items that remain."""
    from app.models.dataset import ColumnType, DatasetRow, DatasetValue
    from app.models.statistical_test import StatisticalTest
    ds = sp["dataset"]
    row = db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id,
                                      DatasetRow.participant_id == sp["ana"].id).one()
    top = max(c.sequence_order for c in ds.columns)
    items = []
    for i, name in enumerate(("Item A", "Item B"), 1):
        col = DatasetColumn(dataset_id=ds.id, column_text=name, column_code=f"ITEM{i}",
                            column_type=ColumnType.NUMERIC, source="manual",
                            sequence_order=top + i)
        db.add(col)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text="4", value_numeric=4.0))
        items.append(col)
    db.expire(ds)  # its loaded `columns` would hide the two new ones from the export
    dom = AnalysisDomain(project_id=PID, name="Mixed scale")
    db.add(dom)
    db.flush()
    for order, col in enumerate([_score_col(sp), *items]):
        db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column",
                                    member_id=col.id, sequence_order=order))
    db.add(StatisticalTest(project_id=PID, test_type="cronbachs_alpha",
                           target_type="analysis_domain", target_id=dom.id,
                           result_data='{"alpha": 0.5}', stale=False))
    db.flush()
    return dom


class TestTheRExportsMixedGroups:
    def test_a_group_with_one_withheld_item_is_not_rebuilt_from_the_rest(self, scored_project):
        db = scored_project["db"]
        _mixed_group(db, scored_project)
        full = _member(_r_zip(db)[0], ".R").decode("utf-8")
        assert "mixed_scale = c(" in full and "# Cronbach's alpha: Mixed scale" in full

        scoped = _member(_r_zip(db, SCOPE)[0], ".R").decode("utf-8")
        assert "mixed_scale" not in scoped
        assert "# Cronbach's alpha: Mixed scale" not in scoped
        assert "# 1 variable group over them left out, with its scale score;" in scoped

    def test_every_rater_keeps_the_mixed_group(self, scored_project):
        db = scored_project["db"]
        _mixed_group(db, scored_project)
        every = _member(_r_zip(db, EVERY_RATER)[0], ".R").decode("utf-8")
        assert "mixed_scale = c(" in every and "# Cronbach's alpha: Mixed scale" in every
