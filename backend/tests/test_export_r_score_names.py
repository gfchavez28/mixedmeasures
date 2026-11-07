"""#1371 — the R script reads every CSV column by the name the CSV was written
under, and reproduces the app's numbers through it (`statistics.md` §4).

The script used to rebuild a variable group's score column from the group's
name (`_make_r_identifier(name) + "_score"`: 60 characters, no collision suffix)
while the CSV wrote `_slugify(name, 40) + "_score"` with `x_` and `_2`. Measured
at 477199b7 by running each exported script in R 4.3.3:

  * a name over 40 characters, a non-ASCII name, or a group with no scale score
    HALTED the script (`invalid type (NULL) for variable`, `Can't subset columns
    that don't exist`) — #821's precedent: every later line never ran;
  * a dataset carrying its own `Wellbeing score` beside a `Wellbeing` group, or
    two groups sharing a slug, ran GREEN and read the wrong column (F = 0.12 and
    40.5 where the app shows 161.99 and 72.0);
  * `domains` listed only scored groups, and R's `$` partial-matches a list, so a
    mean over an unscored group `Well` read `Wellbeing`'s items (4.5 vs 6.0), and
    with no scored group at all `object 'domains' not found` halted;
  * a multi-dataset project whose dataset is named `2023 survey` (the default for
    `2023_survey.csv`) or wholly non-ASCII emitted `data$2023_survey__grp` /
    `data$__grp`, which R refuses to PARSE — not one line of the script ran.

Each project's script must source to completion; every number is the app's.
The discrimination arms prove the fixture could have told the columns apart.
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.models.materials import MaterialCollection, Material
from app.routers.export_r import export_r_data
from app.services.comparisons import compute_group_comparison
from app.services.correlations import compute_correlation_matrix
from app.services.metrics import compute_metric, create_scale_score_metric
from app.services.statistical_tests import compute_statistical_test
from tests import r_support

N = 30
GROUPS3 = ["A", "B", "C"]
LONG = "Organisational commitment and engagement scale"   # slug: 46 characters
CJK = "幸福感"                                            # slug: empty


def _val(r: int, item: int) -> float:
    g = r % 3
    return float(1 + g * (item % 3 + 1) + ((r * 7 + item * 3) % 5))


def _build(db, pid, *, domains, extra_cols=(), materials=(), saved_tests=(),
           ds_name="survey", second_ds_name=None):
    db.add(Project(id=pid, name=f"Names {pid}", user_id=1))
    db.flush()
    dsid = pid * 10
    db.add(Dataset(id=dsid, project_id=pid, name=ds_name))
    db.flush()
    col_ids, order, cid = {}, 0, pid * 1000

    def add_col(code, ctype, ds=dsid):
        nonlocal cid, order
        cid += 1
        db.add(DatasetColumn(id=cid, dataset_id=ds, column_code=code, column_name=code,
                             column_text=code, column_type=ctype,
                             sequence_order=order, display_order=order))
        order += 1
        col_ids[code] = cid

    add_col("grp", "nominal")
    add_col("grp2", "nominal")
    item_codes = sorted({c for d in domains for c in d["items"]} | set(extra_cols))
    for code in item_codes:
        add_col(code, "numeric")
    db.flush()
    vid = pid * 100000
    for r in range(N):
        dr = DatasetRow(id=pid * 1000 + r, dataset_id=dsid)
        db.add(dr)
        db.flush()
        cells = {"grp": GROUPS3[r % 3], "grp2": "X" if r % 2 else "Y"}
        for i, code in enumerate(item_codes):
            # An IMPORTED precomputed score: values unrelated to the group's items.
            cells[code] = 100.0 + r if code.endswith("_score") else _val(r, i)
        for code, v in cells.items():
            vid += 1
            num = v if isinstance(v, float) else None
            db.add(DatasetValue(id=vid, row_id=dr.id, column_id=col_ids[code],
                                value_text=v if num is None else f"{v:g}",
                                value_numeric=num))
    db.flush()
    if second_ds_name is not None:
        ds2 = dsid + 1
        db.add(Dataset(id=ds2, project_id=pid, name=second_ds_name))
        db.flush()
        add_col("other_q", "numeric", ds=ds2)
        db.flush()
        for r in range(5):
            dr = DatasetRow(id=pid * 1000 + 500 + r, dataset_id=ds2)
            db.add(dr)
            db.flush()
            vid += 1
            db.add(DatasetValue(id=vid, row_id=dr.id, column_id=col_ids["other_q"],
                                value_text=str(r + 1), value_numeric=float(r + 1)))
        db.flush()

    dom_ids = {}
    for k, d in enumerate(domains):
        did = pid * 10 + 100 + k
        dom = AnalysisDomain(id=did, project_id=pid, name=d["name"], sequence_order=k)
        db.add(dom)
        db.flush()
        for i, code in enumerate(d["items"]):
            db.add(AnalysisDomainMember(domain_id=did, member_type="column",
                                        member_id=col_ids[code], sequence_order=i))
        db.flush()
        dom_ids[d["name"]] = did
        if d.get("score", True):
            _m, computed = create_scale_score_metric(db, dom)
            assert computed, d["name"]
    db.flush()

    coll = MaterialCollection(id=pid * 10 + 7, project_id=pid, name="Materials")
    db.add(coll)
    db.flush()
    for j, mat in enumerate(materials):
        cfg = dict(mat["config"])
        if "domain_names" in cfg:
            cfg["domain_ids"] = [dom_ids[n] for n in cfg.pop("domain_names")]
        if "compare_by_code" in cfg:
            cfg["compare_by"] = col_ids[cfg.pop("compare_by_code")]
        if "column_codes" in cfg:
            cfg["column_ids"] = [col_ids[c] for c in cfg.pop("column_codes")]
        db.add(Material(id=pid * 10 + 200 + j, collection_id=coll.id,
                        material_type=mat["type"], config=json.dumps(cfg),
                        auto_name=mat["name"], source_tab=mat["tab"], display_order=j))
    test_ids = []
    for j, st in enumerate(saved_tests):
        mid = pid * 10 + 300 + j
        db.add(MetricDefinition(id=mid, project_id=pid, name=f"t{j}",
                                metric_type="domain_aggregate",
                                input_source_type="dataset_domain",
                                input_source_id=dom_ids[st["domain"]],
                                grouping_column_id=col_ids[st["by"]],
                                config=json.dumps({"child_metric_type": "mean",
                                                   "child_config": {}, "aggregation": "mean"}),
                                origin="human", stale=False))
        db.flush()
        db.add(StatisticalTest(id=mid, project_id=pid, test_type=st["test"],
                               target_type="metric_definition", target_id=mid,
                               config="{}", result_data="{}"))
        test_ids.append(mid)
    db.flush()
    return col_ids, dom_ids, test_ids


async def _zip(pid, user, db) -> bytes:
    resp = export_r_data(project_id=pid, user=user, db=db)
    chunks = [c async for c in resp.body_iterator]
    return b"".join(chunks if isinstance(chunks[0], bytes) else [c.encode() for c in chunks])


_RUN = r'''
invisible(capture.output(suppressWarnings(suppressMessages(source("__SETUP__", echo = FALSE)))))
emit <- function(k, v) cat("RT", k, format(v, digits = 12, scientific = TRUE), "\n")
__AFTER__
'''


def _emitted(script: str, pattern: str) -> str:
    """One line the export WROTE, verbatim — the runner re-evaluates what the
    script emitted, never a restatement of it (#1039 h)."""
    m = re.search(pattern, script, re.M)
    assert m, f"the export emitted no line matching {pattern!r}"
    return m.group(0)


def _run(db, pid, after=lambda script: ""):
    """Source the ACTUAL exported script (a halt or a parse error fails here),
    then evaluate `after(script)` against the objects it left behind."""
    user = db.query(User).filter(User.id == 1).one()
    raw = asyncio.run(_zip(pid, user, db))
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(w)
            setup = next(n for n in zf.namelist() if n.endswith(".R"))
        script = (w / setup).read_text(encoding="utf-8")
        tail = after(script) if callable(after) else after
        (w / "run.R").write_text(
            _RUN.replace("__SETUP__", setup).replace("__AFTER__", tail), encoding="utf-8")
        p = subprocess.run([r_support.RSCRIPT, "run.R"], cwd=str(w),
                           capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, f"exported script did not run:\n{p.stdout}\n{p.stderr}"
    out = {m.group(1): float(m.group(2)) for m in
           re.finditer(r"^RT (\w+)\s+([-\d.eE+]+)\s*$", p.stdout, re.M)}
    return out, script


def _cmp(db, pid, grp, *, cols=(), doms=(), nonparametric=False):
    res = compute_group_comparison(db, project_id=pid, column_ids=list(cols),
                                   domain_ids=list(doms), grouping_column_id=grp,
                                   grouping_column_id_2=None, test_type="auto",
                                   include_effect_size_ci=False,
                                   nonparametric=nonparametric)
    return [row["test"]["statistic"] for row in res["rows"]]


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_score_columns_are_read_by_the_csvs_own_names(db_session):
    db = db_session
    PID = 9710
    cols, doms, test_ids = _build(
        db, PID,
        domains=[{"name": LONG, "items": ["i1", "i2", "i3"]},
                 {"name": "Wellbeing", "items": ["j1", "j2", "j3"]},
                 {"name": "Trust", "items": ["k1", "k2"]},
                 {"name": "trust!", "items": ["k3", "k4"]},
                 {"name": CJK, "items": ["m1", "m2"]},
                 {"name": "Well", "items": ["j3"], "score": False},
                 {"name": "Morale", "items": ["i1", "m1"], "score": False}],
        extra_cols=["wellbeing_score"],
        materials=[
            {"type": "comparison", "tab": "comparisons", "name": "aov",
             "config": {"domain_names": [LONG, "Wellbeing", "trust!", CJK],
                        "compare_by_code": "grp"}},
            {"type": "comparison", "tab": "comparisons", "name": "kw",
             "config": {"domain_names": [LONG], "compare_by_code": "grp",
                        "nonparametric": True}},
            {"type": "correlation_matrix", "tab": "correlations", "name": "cor",
             "config": {"domain_names": [LONG, "Wellbeing", "trust!"],
                        "corr_type": "pearson"}},
            {"type": "domain_aggregate", "tab": "descriptives", "name": "well mean",
             "config": {"metric_type": "mean", "domain_names": ["Well"]}},
            {"type": "domain_aggregate", "tab": "descriptives", "name": "trust mean",
             "config": {"metric_type": "mean", "domain_names": ["trust!"]}},
            {"type": "comparison", "tab": "comparisons", "name": "morale",
             "config": {"domain_names": ["Morale"], "compare_by_code": "grp"}},
        ],
        saved_tests=[{"domain": LONG, "by": "grp2", "test": "independent_t_test"}],
    )
    grp = cols["grp"]
    order = [LONG, "Wellbeing", "trust!", CJK]
    app_F = dict(zip(order, _cmp(db, PID, grp, doms=[doms[n] for n in order])))
    app_H = _cmp(db, PID, grp, doms=[doms[LONG]], nonparametric=True)[0]
    cm = compute_correlation_matrix(db, project_id=PID, column_ids=[],
                                    domain_ids=[doms[LONG], doms["Wellbeing"], doms["trust!"]],
                                    correlation_type="pearson", bonferroni=False)["matrix"]
    app_t = compute_statistical_test(db, db.get(StatisticalTest, test_ids[0]))["t_statistic"]
    app_mean = {}
    for name in ("Well", "Wellbeing", "trust!", "Trust"):
        md = MetricDefinition(project_id=PID, name=f"m {name}", metric_type="mean",
                              input_source_type="dataset_domain",
                              input_source_id=doms[name], config="{}", origin="human")
        db.add(md)
        db.flush()
        app_mean[name] = json.loads(compute_metric(db, md)[0].result_data)["mean"]
        db.delete(md)
        db.flush()

    # Discrimination: the wrong columns would have given different numbers.
    assert abs(_cmp(db, PID, grp, cols=[cols["wellbeing_score"]])[0] - app_F["Wellbeing"]) > 1
    assert abs(_cmp(db, PID, grp, doms=[doms["Trust"]])[0] - app_F["trust!"]) > 1
    assert abs(app_mean["Trust"] - app_mean["trust!"]) > 0.1
    # `domains$well` partial-matching `wellbeing` would read j1..j3, not j3.
    assert abs(app_mean["Well"] - app_mean["Wellbeing"]) > 0.1

    def after(script):
        # Every line below was WRITTEN by the export; the runner only re-evaluates it.
        # Since #1329 (D52) each test reads a `.mm_testable` frame and is wrapped in
        # `if (!is.null(frame)) print(…)`: the call is lifted from inside the print.
        kw = _emitted(script, r"(?<=print\()kruskal\.test\(y ~ g, data = cmp_rank_\w+\)")
        _emitted(script, r"^tt_frame <- \.mm_testable\(.*, data\$grp2, have_groups = c\(2, 2\),"
                         r" test_name = \"Independent t-test\"\)$")  # the saved t-test's frame (#1540)
        tt = _emitted(script, r"(?<=print\()t\.test\(y ~ g, data = tt_frame, var\.equal = FALSE\)")
        well = _emitted(script, r"(?<=^# well mean\n)mean\(.*\)$")
        trust = _emitted(script, r"(?<=^# trust mean\n)mean\(.*\)$")
        return f'''
for (o in ls(pattern = "^aov_")) emit(o, summary(get(o))[[1]][["F value"]][1])
emit("kw_H", unname(({kw})$statistic))
cmr <- cor(.mm_num(data[, cor_vars]), use = "pairwise.complete.obs", method = "pearson")
emit("r12", cmr[1, 2]); emit("r13", cmr[1, 3]); emit("r23", cmr[2, 3])
emit("t", unname(({tt})$statistic))
emit("well_mean", {well})
emit("trust_mean", {trust})
'''

    out, script = _run(db, PID, after)
    aov_by_score = {k[len("aov_"):-len("_by_grp")]: v for k, v in out.items() if k.startswith("aov_")}
    assert aov_by_score == pytest.approx({
        "organisational_commitment_and_engagement_score": app_F[LONG],
        "wellbeing_score_2": app_F["Wellbeing"],
        "trust_score_2": app_F["trust!"],
        "group_score": app_F[CJK],
    }, abs=1e-3)
    assert out["kw_H"] == pytest.approx(app_H, abs=1e-3)
    assert [out["r12"], out["r13"], out["r23"]] == pytest.approx(
        [cm[0][1]["r"], cm[0][2]["r"], cm[1][2]["r"]], abs=1e-3)
    assert out["t"] == pytest.approx(app_t, abs=1e-3)
    assert out["well_mean"] == pytest.approx(app_mean["Well"], abs=1e-9)
    assert out["trust_mean"] == pytest.approx(app_mean["trust!"], abs=1e-9)
    # An unscored group in a comparison is SAID, never a name that is not there.
    assert "Skipped variable group Morale: it has no scale score" in script
    assert "morale_score" not in script


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
@pytest.mark.parametrize("first, second", [("2023 survey", "调查"), ("调查", "2024")])
def test_dataset_prefixes_are_r_names(db_session, first, second):
    db = db_session
    PID = 9720 if first.startswith("2023") else 9721
    cols, doms, _ = _build(
        db, PID, domains=[], extra_cols=["i1"], ds_name=first, second_ds_name=second,
        materials=[{"type": "comparison", "tab": "comparisons", "name": "cmp",
                    "config": {"column_codes": ["i1"], "compare_by_code": "grp"}}])
    app_F = _cmp(db, PID, cols["grp"], cols=[cols["i1"]])[0]
    out, script = _run(db, PID, r'''
for (o in ls(pattern = "^aov_")) emit("F", summary(get(o))[[1]][["F value"]][1])
''')
    assert out["F"] == pytest.approx(app_F, abs=1e-3)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_a_project_whose_groups_are_all_unscored_still_defines_domains(db_session):
    db = db_session
    PID = 9730
    _build(db, PID, domains=[{"name": "Morale", "items": ["i1", "i2"], "score": False}],
           materials=[{"type": "domain_aggregate", "tab": "descriptives", "name": "m",
                       "config": {"metric_type": "mean", "domain_names": ["Morale"]}}])
    out, _ = _run(db, PID, r'''
emit("m", mean(unlist(.mm_num(data[, domains$morale, drop = FALSE]), use.names = FALSE), na.rm = TRUE))
emit("ref", mean(c(data$i1, data$i2), na.rm = TRUE))
''')
    assert out["m"] == pytest.approx(out["ref"], abs=1e-12)
