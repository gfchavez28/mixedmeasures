"""#1177: a variable group has ONE scale score, and every surface that reads
"the group's scale score" reads that one metric.

🔴 **What was wrong.** Correlations, scatter and Comparisons merged the per-record
scores of EVERY ungrouped `domain_aggregate` metric of a group, last one winning,
so a lookalike — the same aggregate with some answers excluded — was read as the
scale score. The Data view, the R data export and *Compute the scale score*
(`create_scale_score_metric`'s `.first()`) each chose by a looser filter of their
own, so the button could refresh one metric while the tabs read another.

⚠️ **How a lookalike is made through the app.** #1177 was filed with a DECOMPOSED
aggregate, which quick compute refuses (`routers/metrics.py`, *"Cannot decompose
domain aggregate metrics"*). The reachable door is the `exclude` URL parameter: it
survives a change of metric type, and quick compute accepts `exclude_values` on a
Group Aggregate — so a frequency chart's exclusions ride into the aggregate. The
world below makes its lookalike exactly that way.

The eight behavioural tests that read, export or recompute a scale score were run
against the code before the fix (2026-10-11) and each failed there for its reason; the
import test was checked against the old `create_scale_score_metric` the same way. The
definition's unit tests, the list flag and the guard are new surface, proven by mutants.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import zipfile

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.row_score import RowScore
from app.models.user import User


def _run(coro):
    return asyncio.run(coro)


PID = 1
LOCAL, LONELY = 1, 2
A, B, D, ROLE = 11, 12, 13, 14

#: Per record: A, B, D, Role. "4" appears in B (record 1) and A (record 4), so
#: excluding it changes those two records' scores and leaves records 2 and 3 alone.
CELLS = {
    1: ("1", "4", "2", "Staff"),
    2: ("2", "5", "1", "Staff"),
    3: ("3", "6", "4", "Lead"),
    4: ("4", "9", "3", "Lead"),
}
SCALE = {1: 2.5, 2: 3.5, 3: 4.5, 4: 6.5}       # mean of A and B
LOOKALIKE = {1: 1.0, 2: 3.5, 3: 4.5, 4: 9.0}   # the same, with "4" excluded


def _world(db, *, scale_scores=True, lookalike=True):
    """Survey: A, B, D numeric, Role demographic. Local = {A, B}; Lonely = {D}.

    The scale scores are made by `create_scale_score_metric` (what the crosswalk
    and *Compute the scale score* call); the lookalike by quick compute with an
    exclusion — the two real doors.
    """
    from app.services.metrics import create_scale_score_metric

    db.add(Project(id=PID, name="Survey", user_id=1))
    db.add(Dataset(id=1, project_id=PID, name="Survey"))
    db.flush()
    for order, (cid, code, ctype) in enumerate((
        (A, "A", ColumnType.NUMERIC), (B, "B", ColumnType.NUMERIC),
        (D, "D", ColumnType.NUMERIC), (ROLE, "ROLE", ColumnType.DEMOGRAPHIC),
    )):
        db.add(DatasetColumn(
            id=cid, dataset_id=1, column_code=code, column_text=code, column_name=code,
            column_type=ctype, sequence_order=order, display_order=order,
            source="manual",  # so a cell can be edited through the real door
        ))
    db.flush()
    for row_id, texts in CELLS.items():
        db.add(DatasetRow(id=row_id, dataset_id=1))
        db.flush()
        for cid, text in zip((A, B, D, ROLE), texts):
            db.add(DatasetValue(row_id=row_id, column_id=cid, value_text=text,
                                value_numeric=None if cid == ROLE else float(text)))
    db.add_all([AnalysisDomain(id=LOCAL, project_id=PID, name="Local"),
                AnalysisDomain(id=LONELY, project_id=PID, name="Lonely")])
    db.flush()
    for domain_id, cols in ((LOCAL, (A, B)), (LONELY, (D,))):
        for i, cid in enumerate(cols):
            db.add(AnalysisDomainMember(domain_id=domain_id, member_type="column",
                                        member_id=cid, sequence_order=i))
    db.flush()
    if scale_scores:
        for domain_id in (LOCAL, LONELY):
            _metric, computed = create_scale_score_metric(db, db.get(AnalysisDomain, domain_id))
            assert computed
    db.commit()
    if lookalike:
        _quick_compute_aggregate(db, LOCAL, exclude_values=["4"])


def _quick_compute_aggregate(db, domain_id, *, exclude_values=None, grouping_mode=None):
    from app.routers.metrics import quick_compute
    from app.schemas.metric import QuickComputeRequest, QuickComputeSource

    response = _run(quick_compute(
        PID,
        QuickComputeRequest(
            sources=[QuickComputeSource(source_type="dataset_domain", source_id=domain_id)],
            metric_type="domain_aggregate",
            # What AnalysisView sends for a Group Aggregate (`quickComputeConfig`).
            config={"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"},
            exclude_values=exclude_values,
            grouping_mode=grouping_mode,
        ),
        user=db.get(User, 1), db=db,
    ))
    return response.metrics[0].id


def _aggregates(db, domain_id):
    return (db.query(MetricDefinition)
            .filter_by(project_id=PID, metric_type="domain_aggregate",
                       input_source_type="dataset_domain", input_source_id=domain_id)
            .order_by(MetricDefinition.id).all())


def _scores(db, metric_id):
    return {r.dataset_row_id: r.score
            for r in db.query(RowScore).filter_by(metric_definition_id=metric_id)}


def test_the_world_has_a_lookalike_and_it_disagrees(db_session):
    """The fixture is worth running only if the lookalike exists, is ungrouped, and
    gives DIFFERENT per-record scores — otherwise every assertion below passes
    whichever metric is read."""
    _world(db_session)
    scale, lookalike = _aggregates(db_session, LOCAL)
    assert lookalike.grouping_column_id is None and lookalike.grouping_column_id_2 is None
    assert json.loads(lookalike.exclude_values) == ["4"]
    assert _scores(db_session, scale.id) == SCALE
    assert _scores(db_session, lookalike.id) == LOOKALIKE


# ── The readers ───────────────────────────────────────────────────────────────


def test_correlations_read_the_scale_score_not_a_lookalike(db_session):
    from app.services.correlations import _load_domain_vectors, compute_correlation_matrix

    _world(db_session)
    values, _info, unscored = _load_domain_vectors(db_session, [LOCAL, LONELY], PID)
    assert values[LOCAL] == SCALE
    assert unscored == set()

    import numpy as np
    expected = float(np.corrcoef([SCALE[r] for r in CELLS], [float(CELLS[r][2]) for r in CELLS])[0, 1])
    cell = compute_correlation_matrix(db_session, PID, [], [LOCAL, LONELY], "pearson", False)["matrix"][0][1]
    assert cell["r"] == pytest.approx(round(expected, 4))


def test_scatter_reads_the_scale_score_not_a_lookalike(db_session):
    from app.services.correlations import compute_scatter_data

    _world(db_session)
    data = compute_scatter_data(db_session, PID, LOCAL, LONELY, "domain", None)
    assert dict(zip(data["record_ids"], data["x"])) == SCALE


def test_comparisons_read_the_scale_score_not_a_lookalike(db_session):
    from app.services.comparisons import compute_group_comparison

    _world(db_session)
    result = compute_group_comparison(db_session, PID, [], [LOCAL], ROLE, None, "auto", False)
    means = {g["group"]: g["mean"] for g in result["rows"][0]["group_stats"]}
    assert means == {"Lead": pytest.approx((SCALE[3] + SCALE[4]) / 2),
                     "Staff": pytest.approx((SCALE[1] + SCALE[2]) / 2)}


def test_a_lookalike_alone_is_no_scale_score(db_session):
    """With only the lookalike, the tabs say the group HAS no scale score (the
    remedy is to create one) instead of serving the lookalike's numbers."""
    from app.services.comparisons import compute_group_comparison
    from app.services.correlations import _load_domain_vectors
    from app.services.undefined_stats import DOMAIN_SCORES_MISSING

    _world(db_session, scale_scores=False)
    values, _info, unscored = _load_domain_vectors(db_session, [LOCAL], PID)
    assert values == {} and unscored == {LOCAL}
    result = compute_group_comparison(db_session, PID, [], [LOCAL], ROLE, None, "auto", False)
    assert result["rows"] == []
    assert result["unavailable_reason"] == DOMAIN_SCORES_MISSING


def test_the_data_view_shows_one_score_column_per_group(db_session):
    from app.routers.dataset import get_domain_scores

    _world(db_session)
    scale_id = _aggregates(db_session, LOCAL)[0].id
    columns = _run(get_domain_scores(PID, 1, user=db_session.get(User, 1), db=db_session))["domain_scores"]
    local = [c for c in columns if c["domain_id"] == LOCAL]
    assert [c["metric_id"] for c in local] == [scale_id]
    assert {int(k): v for k, v in local[0]["scores"].items()} == SCALE


def test_the_r_data_export_writes_one_score_column_per_group(db_session):
    from app.routers.export_r import export_r_data

    _world(db_session)

    async def collect(resp):
        out = []
        async for chunk in resp.body_iterator:
            out.append(chunk if isinstance(chunk, bytes) else chunk.encode())
        return b"".join(out)

    raw = _run(collect(export_r_data(project_id=PID, user=db_session.get(User, 1), db=db_session)))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        name = next(n for n in zf.namelist() if n.endswith("_data.csv"))
        rows = list(csv.DictReader(io.StringIO(zf.read(name).decode("utf-8-sig"))))
    score_columns = [h for h in rows[0] if h.startswith("local")]
    assert score_columns == ["local_score"]
    # The CSV is written in record order (`ORDER BY dataset, id`).
    assert [float(r["local_score"]) for r in rows] == [SCALE[r] for r in sorted(CELLS)]


# ── The writer: *Compute the scale score* refreshes what the tabs read ────────


def test_recomputing_the_scale_scores_clears_the_out_of_date_notice(db_session):
    """#1176's notice offers *Recompute scale scores*, which calls
    `create-score-metric` per named group. A member's edit marks the scale score
    AND the lookalike; the button recomputes the scale score — so a notice keyed on
    the lookalike stayed up after the button was pressed, every time."""
    from app.routers.analysis_domains import create_score_metric
    from app.routers.dataset import update_value
    from app.schemas.dataset import ValueUpdate
    from app.services.correlations import compute_correlation_matrix, stale_score_domain_ids
    from tests.conftest import mock_request

    _world(db_session)
    value_id = db_session.query(DatasetValue.id).filter_by(row_id=2, column_id=B).scalar()
    _run(update_value(PID, 1, value_id, ValueUpdate(value_text="7"),
                      user=db_session.get(User, 1), db=db_session))
    assert all(m.stale for m in _aggregates(db_session, LOCAL)), "precondition: the edit marks both"
    assert stale_score_domain_ids(db_session, [LOCAL, LONELY], PID) == [LOCAL]

    _run(create_score_metric(request=mock_request(), project_id=PID, domain_id=LOCAL,
                             user=db_session.get(User, 1), db=db_session))
    assert stale_score_domain_ids(db_session, [LOCAL, LONELY], PID) == []
    matrix = compute_correlation_matrix(db_session, PID, [], [LOCAL, LONELY], "pearson", False)
    assert matrix["stale_domain_ids"] == []


def test_compute_the_scale_score_never_adopts_a_lookalike(db_session):
    """With only a lookalike, *Compute the scale score* used to return it as the
    group's scale score (`.first()` over every ungrouped aggregate). It creates the
    real one and leaves the lookalike as it was."""
    from app.services.metrics import create_scale_score_metric

    _world(db_session, scale_scores=False)
    (lookalike,) = _aggregates(db_session, LOCAL)
    metric, computed = create_scale_score_metric(db_session, db_session.get(AnalysisDomain, LOCAL))
    assert computed
    assert metric.id != lookalike.id
    assert metric.exclude_values is None and metric.origin == "human"
    assert _scores(db_session, metric.id) == SCALE
    db_session.refresh(lookalike)
    assert json.loads(lookalike.exclude_values) == ["4"]
    assert _scores(db_session, lookalike.id) == LOOKALIKE


def test_an_import_gives_a_group_with_only_a_lookalike_its_scale_score(db_session, tmp_path):
    """The `.mmproject` import's Tier 3 backfill asks `create_scale_score_metric`
    for every group, which used to accept any ungrouped aggregate as "already
    has one". An imported group whose only aggregate is a lookalike now gets its
    scale score, created and computed exactly as for a group the file carried
    without one (the backfill's ordinary path — it is the metrics the FILE carried
    that arrive out of date, #958 §6)."""
    from app.services.project_portability import export_project, import_project
    from app.services.scale_scores import scale_score_metrics

    _world(db_session, scale_scores=False)
    docs = tmp_path / "docs"
    docs.mkdir()
    archive = tmp_path / "survey.mmproject"
    archive.write_bytes(export_project(db_session, PID, docs).getvalue())
    new_pid, _name = import_project(
        db_session, archive, tmp_path / "imported", media_dir=None, user_id=1, import_mode="new",
    )
    db_session.flush()

    new_local = db_session.query(AnalysisDomain).filter_by(project_id=new_pid, name="Local").one()
    imported = db_session.query(MetricDefinition).filter_by(project_id=new_pid, input_source_id=new_local.id).all()
    assert len(imported) == 2, "the lookalike travels, and the backfill adds the scale score"
    scale = scale_score_metrics(db_session, new_pid, [new_local.id])[new_local.id]
    assert scale.exclude_values is None and scale.origin == "human"
    assert scale.stale is False
    assert sorted(_scores(db_session, scale.id).values()) == sorted(SCALE.values())
    lookalike = next(m for m in imported if m.id != scale.id)
    assert lookalike.stale is True
    assert json.loads(lookalike.exclude_values) == ["4"]


# ── The metrics list states which metric is the scale score ───────────────────


def test_the_metrics_list_names_one_scale_score_per_group(db_session):
    """The crosswalk's Σ badge, its rename cascade and the analysis picker read
    this flag instead of re-deriving it from the grouping fields, which a
    lookalike shares."""
    from app.routers.metrics import list_metrics

    _world(db_session)
    # Split by dataset: quick compute refuses this for an aggregate today (*"Group
    # by dataset is not supported for domain aggregate metrics"*), but the suite's
    # own fixtures carry one and an older or hand-edited file can.
    db_session.add(MetricDefinition(
        project_id=PID, name="Local by dataset", metric_type="domain_aggregate",
        config="{}", input_source_type="dataset_domain", input_source_id=LOCAL,
        grouping_mode="dataset", origin="human",
    ))
    db_session.flush()
    scale_local, lookalike, by_dataset = _aggregates(db_session, LOCAL)
    (scale_lonely,) = _aggregates(db_session, LONELY)

    listed = _run(list_metrics(PID, user=db_session.get(User, 1), db=db_session)).metrics
    flagged = {m.id for m in listed if m.is_scale_score}
    assert flagged == {scale_local.id, scale_lonely.id}
    assert {lookalike.id, by_dataset.id}.isdisjoint(flagged)


# ── The definition ────────────────────────────────────────────────────────────


def _metric(**overrides):
    fields = dict(
        id=1, metric_type="domain_aggregate", input_source_type="dataset_domain",
        input_source_id=LOCAL, grouping_column_id=None, grouping_column_id_2=None,
        grouping_mode=None, exclude_values=None,
        config=json.dumps({"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}),
        origin="human", origin_context="crosswalk_auto",
    )
    fields.update(overrides)
    return MetricDefinition(**fields)


@pytest.mark.parametrize("overrides", [
    {},
    {"grouping_mode": "column"},           # the same as None (`_normalize_metric_key`)
    {"config": "{}"},                      # `compute_domain_aggregate`'s defaults
    {"config": None},
    {"config": json.dumps({"child_metric_type": "mean", "child_config": {}})},
    {"exclude_values": "[]"},              # an empty list excludes nothing
    {"exclude_values": "null"},
    {"origin": "auto", "origin_context": "quick-compute"},  # provenance is not identity
], ids=lambda o: ",".join(o) or "the crosswalk's")
def test_what_computes_the_scale_score(overrides):
    from app.services.scale_scores import is_scale_score

    assert is_scale_score(_metric(**overrides)) is True


@pytest.mark.parametrize("overrides", [
    {"exclude_values": json.dumps(["Don't know"])},
    {"grouping_mode": "dataset"},
    {"grouping_column_id": 99},
    {"grouping_column_id_2": 99},
    {"config": json.dumps({"child_metric_type": "proportion", "child_config": {"mode": "values"}})},
    {"config": json.dumps({"child_metric_type": "mean", "aggregation": "pomp"})},
    {"config": json.dumps({**{"child_metric_type": "mean"}, "decompose_column_ids": [A]})},
    {"config": json.dumps("not an object")},   # `compute_domain_aggregate` cannot read it
    {"metric_type": "mean"},
    {"input_source_type": "dataset_column"},
], ids=lambda o: ",".join(o))
def test_what_does_not(overrides):
    from app.services.scale_scores import is_scale_score

    assert is_scale_score(_metric(**overrides)) is False


def test_when_two_compute_it_the_crosswalks_wins_then_the_oldest():
    from app.services.scale_scores import pick_scale_scores

    legacy = _metric(id=1, origin="auto", origin_context=None, config="{}")
    crosswalk = _metric(id=2)
    later = _metric(id=3, origin="auto", origin_context=None)
    assert pick_scale_scores([legacy, crosswalk, later])[LOCAL] is crosswalk
    assert pick_scale_scores([later, legacy])[LOCAL] is legacy
    assert pick_scale_scores([_metric(exclude_values='["4"]')]) == {}


def test_a_tie_is_broken_the_same_way_by_every_reader(db_session):
    """Two metrics that both compute the scale score — the crosswalk's, and an
    older-style config posted beside it — are one choice everywhere: the tabs, the
    list's flag, and *Compute the scale score*."""
    from app.routers.metrics import list_metrics
    from app.services.correlations import _domain_score_metrics
    from app.services.metrics import compute_metric, create_scale_score_metric, find_or_create_metric

    _world(db_session, lookalike=False)
    (crosswalk,) = _aggregates(db_session, LOCAL)
    twin, is_new = find_or_create_metric(
        db_session, PID, "dataset_domain", LOCAL, "domain_aggregate",
        {"child_metric_type": "mean", "child_config": {}},   # no `aggregation` key
    )
    assert is_new and twin.id > crosswalk.id
    compute_metric(db_session, twin)
    db_session.flush()

    assert [m.id for m in _domain_score_metrics(db_session, [LOCAL], PID)] == [crosswalk.id]
    listed = _run(list_metrics(PID, user=db_session.get(User, 1), db=db_session)).metrics
    assert [m.id for m in listed if m.is_scale_score and m.input_source_id == LOCAL] == [crosswalk.id]
    metric, _ = create_scale_score_metric(db_session, db_session.get(AnalysisDomain, LOCAL))
    assert metric.id == crosswalk.id


# ── The guard: nothing else in the app chooses "the scale score" ──────────────


def _ungrouped_metric_filters(source: str) -> int:
    """How many SQL filters in `source` ask for an UNGROUPED metric —
    `MetricDefinition.grouping_column_id{,_2}` compared with None, in either
    spelling. That is how each of the five readers #1177 replaced began."""
    import ast

    count = 0
    for node in ast.walk(ast.parse(source)):
        target = None
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "is_" and node.args
                and isinstance(node.args[0], ast.Constant) and node.args[0].value is None):
            target = node.func.value
        elif (isinstance(node, ast.Compare) and len(node.ops) == 1
                and isinstance(node.ops[0], ast.Eq)
                and isinstance(node.comparators[0], ast.Constant)
                and node.comparators[0].value is None):
            target = node.left
        if (isinstance(target, ast.Attribute)
                and target.attr in ("grouping_column_id", "grouping_column_id_2")
                and isinstance(target.value, ast.Name) and target.value.id == "MetricDefinition"):
            count += 1
    return count


#: The one module allowed to ask, and why.
_ALLOWED = {"services/scale_scores.py": "the definition itself — its SQL prefilter"}


def test_only_the_definition_selects_ungrouped_metrics():
    """🔴 A new reader of "the group's scale score" written as a query for an
    ungrouped `domain_aggregate` is the defect #1177 fixed, five times over. Route
    it through `services/scale_scores.py`; if a query genuinely wants every
    ungrouped metric, add it here with the reason."""
    from tests.guard_support import APP_DIR, app_files

    found = {}
    for path in app_files(floor=150, sentinels=("services/scale_scores.py", "services/correlations.py")):
        hits = _ungrouped_metric_filters(path.read_text(encoding="utf-8"))
        if hits:
            found[path.relative_to(APP_DIR).as_posix()] = hits
    # Population: the definition's own prefilter must be SEEN, or the scan is blind.
    assert found.get("services/scale_scores.py") == 2, found
    assert set(found) == set(_ALLOWED), {k: v for k, v in found.items() if k not in _ALLOWED}


def test_the_guards_matcher_fires_on_both_spellings():
    """Predicate falsifier: the two shapes the replaced readers used."""
    assert _ungrouped_metric_filters("q.filter(MetricDefinition.grouping_column_id.is_(None))") == 1
    assert _ungrouped_metric_filters("q.filter(MetricDefinition.grouping_column_id_2 == None)") == 1
    assert _ungrouped_metric_filters("if m.grouping_column_id is None: pass") == 0
