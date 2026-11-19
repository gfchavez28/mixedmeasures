"""#1677 — an ordinal or binary column's undeclared CODES and ANSWERS in the R script.

The numeric branch of `export_r._get_factor_mapping` built a factor's levels from the
declaration alone, so `factor(levels = c(1, 2, 3))` turned every cell holding a code the
declaration never named into NA, silently, while the app counts it as a category, as a
group and in the mean. #1636's per-group rows then printed such a group at n = 0.

- **D364:** a stored code the declaration does not name is a LEVEL, labelled by its
  stored text and registered in `.mm_scale_codes`, so R counts, groups and averages it
  as the app does (#765's rule for nominal columns, reaching the numeric branch).
- **D365:** an answer with NO number cannot ride the numeric CSV cell, so the script
  NAMES it — a comment and a printed line per column — and a test grouped by such a
  column does not print *"as in Mixed Measures"* when it is not computed.

The fixture is the 1.7.0 pre-cut audit's R7 probe (kept with its private probes), widened
with a grouping for each `.mm_testable` door and a hostile label (#1468). Everything is
SOURCED in real R and held against the app's own `compute_metric` (#1039 h). D365's
residual is pinned as exactly that: the only groups and categories where R still
disagrees are the answers the script names.
"""
from __future__ import annotations

import asyncio
import io
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models import Project
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.materials import Material, MaterialCollection
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.models.user import User
from app.routers.export_r import _escape_r_string
from app.services.metrics import STATS_PRECISION, compute_metric
from app.services.statistical_tests import compute_statistical_test
from tests import r_support
from tests.test_export_r_grouped_metric_1636 import _FREQ_DUMP, _MEAN_DUMP, _emitted_object, _rows
from tests.test_export_r_score_names import _zip

PID = 16770
DSID = PID * 10
C_SCORE, C_LVL, C_ANS, C_GRP, C_YN, C_TAG, C_SITE = (PID * 100 + i for i in range(1, 8))
M_MEAN, M_FREQ, M_GRP = PID + 1, PID + 2, PID + 3
ST_ANOVA = PID + 4
LEVELS = ["Low", "Mid", "High"]

# #1468: a stray code's LABEL and an unnumbered ANSWER are user text written into the
# script — the label into `factor(labels = …)`, the answer into a comment and a cat().
# The newline is the one character that ends a comment.
HOSTILE_LABEL = 'x"); assign("INJECTED", TRUE, envir = globalenv()); # \\ \' end'
HOSTILE_ANSWER = 'y\nassign("INJECTED", TRUE, envir = globalenv()) # "q"'

# (lvl text, lvl code, score, ans text, ans code) — the audit's R7 rows. `lvl` and `ans`
# are ordinal Low/Mid/High (1–3) holding a STRAY CODE ("4", code 4) and a STRAY ANSWER
# ("Medium", no number).
R7 = [("Low", 1, 1, "Low", 1), ("Low", 1, 2, "4", 4), ("Mid", 2, 5, "Mid", 2),
      ("Mid", 2, 6, "4", 4), ("High", 3, 9, "High", 3), ("High", 3, 10, "Low", 1),
      ("4", 4, 20, "Mid", 2), ("4", 4, 22, "4", 4), ("4", 4, 24, "High", 3),
      ("Medium", None, 30, "Medium", None), ("Medium", None, 32, "Low", 1)]
# `grp` (ordinal A/B, codes 1–2) has a third group "C" with no number: the app's saved
# ANOVA has three groups, R's two. `yn` (binary No/Yes, 0–1) holds "Yes" and an
# unnumbered "Maybe": the app compares two groups, R has one.
GRP = ["A", "B", "C"]
UNNUMBERED = {"lvl": [("Medium", 2)], "ans": [("Medium", 1)], "grp": [("C", 4)],
              "yn": [("Maybe", 5)], "tag": [(HOSTILE_ANSWER, 1)]}


def _cells(r: int, row) -> list[tuple[int, str, float | None]]:
    lt, lc, sc, at, ac = row
    g = GRP[r % 3] if r < 9 else ("C" if r == 9 else "A")
    yn = ("Yes", 1.0) if r % 2 == 0 else ("Maybe", None)
    tag = {0: (HOSTILE_LABEL, 7.0), 1: (HOSTILE_ANSWER, None)}.get(
        r, ("Yes", 1.0) if r % 2 == 0 else ("No", 2.0))
    return [
        (C_SCORE, str(sc), float(sc)),
        (C_LVL, lt, None if lc is None else float(lc)),
        (C_ANS, at, None if ac is None else float(ac)),
        (C_GRP, g, None if g == "C" else float(GRP.index(g) + 1)),
        (C_YN, yn[0], yn[1]),
        (C_TAG, tag[0], tag[1]),
        (C_SITE, "North" if r % 2 == 0 else "South", None),
    ]


def _seed(db):
    db.add(Project(id=PID, name="Undeclared codes", user_id=1))
    db.flush()
    db.add(Dataset(id=DSID, project_id=PID, name="survey"))
    db.flush()

    def scale(labels, values):
        return {"scale_labels": json.dumps(labels), "scale_values": json.dumps(values)}

    cols = [
        (C_SCORE, "score", ColumnType.NUMERIC, {}),
        (C_LVL, "lvl", ColumnType.ORDINAL, scale(LEVELS, [1, 2, 3])),
        (C_ANS, "ans", ColumnType.ORDINAL, scale(LEVELS, [1, 2, 3])),
        (C_GRP, "grp", ColumnType.ORDINAL, scale(["A", "B"], [1, 2])),
        (C_YN, "yn", ColumnType.BINARY, scale(["No", "Yes"], [0, 1])),
        (C_TAG, "tag", ColumnType.ORDINAL, scale(["Yes", "No"], [1, 2])),
        (C_SITE, "site", ColumnType.NOMINAL, {}),
    ]
    for order, (cid, name, ctype, extra) in enumerate(cols):
        db.add(DatasetColumn(id=cid, dataset_id=DSID, column_code=name, column_name=name,
                             column_text=name, column_type=ctype, sequence_order=order,
                             display_order=order, **extra))
    db.flush()
    vid = PID * 1000
    for r, row in enumerate(R7):
        rid = PID * 100 + 50 + r
        db.add(DatasetRow(id=rid, dataset_id=DSID, row_identifier=f"R{r}"))
        db.flush()
        for cid, text, num in _cells(r, row):
            vid += 1
            db.add(DatasetValue(id=vid, row_id=rid, column_id=cid, value_text=text,
                                value_numeric=num))
    db.flush()
    for mid, name, mtype, src, grp in ((M_MEAN, "score by lvl", "mean", C_SCORE, C_LVL),
                                       (M_FREQ, "ans by lvl", "frequency_distribution",
                                        C_ANS, C_LVL),
                                       (M_GRP, "score by grp", "mean", C_SCORE, C_GRP)):
        db.add(MetricDefinition(id=mid, project_id=PID, name=name, metric_type=mtype,
                                input_source_type="dataset_column", input_source_id=src,
                                grouping_column_id=grp, config="{}", origin="human",
                                stale=False))
    db.flush()
    for mid in (M_MEAN, M_FREQ, M_GRP):
        compute_metric(db, db.get(MetricDefinition, mid))
    db.add(StatisticalTest(id=ST_ANOVA, project_id=PID, test_type="one_way_anova",
                           target_type="metric_definition", target_id=M_GRP,
                           config="{}", result_data="{}"))
    db.flush()
    compute_statistical_test(db, db.get(StatisticalTest, ST_ANOVA))
    coll = MaterialCollection(id=PID * 10 + 7, project_id=PID, name="Materials")
    db.add(coll)
    db.flush()
    for j, (name, by) in enumerate((("score by yn", C_YN), ("score by site", C_SITE))):
        db.add(Material(id=PID * 10 + 200 + j, collection_id=coll.id,
                        material_type="comparison", source_tab="comparisons",
                        config=json.dumps({"column_ids": [C_SCORE], "compare_by": by}),
                        auto_name=name, display_order=j))
    db.flush()


def _app_auto(db, mid, src, mtype):
    """The app's own ungrouped number — an auto metric, added AFTER the script is
    exported (an `origin="auto"` metric is never emitted, but this keeps it out)."""
    db.add(MetricDefinition(id=mid, project_id=PID, name=f"auto {mid}", metric_type=mtype,
                            input_source_type="dataset_column", input_source_id=src,
                            config="{}", origin="auto", stale=False))
    db.flush()
    compute_metric(db, db.get(MetricDefinition, mid))
    db.flush()
    (res,) = db.get(MetricDefinition, mid).results
    return res.valid_n, json.loads(res.result_data)


def _app_groups(db, mid) -> dict[str, dict]:
    return {r.group_value: {"n": r.valid_n, **json.loads(r.result_data)}
            for r in db.get(MetricDefinition, mid).results if r.group_value is not None}


def _script(db) -> str:
    raw = asyncio.run(_zip(PID, db.get(User, 1), db))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        return zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()


# Source the script with its printed output KEPT (each line tagged), then run `after`.
_RUNNER = '''
out <- capture.output(suppressWarnings(suppressMessages(source("__S__", echo = FALSE))))
for (l in out) cat("OUT\\t", l, "\\n", sep = "")
__AFTER__
'''


def _run(db, after: str = "") -> tuple[str, list[str]]:
    raw = asyncio.run(_zip(PID, db.get(User, 1), db))
    with tempfile.TemporaryDirectory() as d:
        work = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(work)
            setup = next(n for n in zf.namelist() if n.endswith(".R"))
        (work / "run.R").write_text(_RUNNER.replace("__S__", setup).replace("__AFTER__", after),
                                    encoding="utf-8")
        proc = subprocess.run([r_support.RSCRIPT, "run.R"], cwd=str(work),
                              capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"the exported script did not run:\n{proc.stdout}\n{proc.stderr}"
    printed = [l[4:] for l in proc.stdout.splitlines() if l.startswith("OUT\t")]
    return proc.stdout, printed


def _note(col: str) -> str:
    answers = UNNUMBERED[col]
    total = sum(n for _, n in answers)
    which = ", ".join(f"“{a}” {n}" for a, n in answers)
    noun = "answer has" if total == 1 else "answers have"
    return (f"{col}: {total} {noun} no number ({which}); Mixed Measures counts them as a "
            "category, this script cannot.")


def test_the_fixture_puts_answers_where_the_declared_levels_cannot_reach(db_session):
    """#707a — the app counts what a declared-levels-only factor makes NA: the stray code
    is a group of three and part of the mean, and the stray answer a group of two."""
    db = db_session
    _seed(db)
    lvl = _app_groups(db, M_MEAN)
    assert set(lvl) == {"Low", "Mid", "High", "4", "Medium"}
    assert (lvl["4"]["n"], lvl["Medium"]["n"]) == (3, 2)
    # Over the declared codes alone `ans` has n 7 and mean 1.857 — the old script's.
    n, res = _app_auto(db, PID + 8, C_ANS, "mean")
    assert (n, res["mean"]) == (10, 2.5)
    # Each grouping the two test doors read has one more group in the app than in R.
    assert set(_app_groups(db, M_GRP)) == {"A", "B", "C"}
    anova = json.loads(db.get(StatisticalTest, ST_ANOVA).result_data)
    assert anova.get("f_statistic") is not None, anova      # the app computes it
    # Every unnumbered answer the fixture means the script to name is really stored so.
    for col, cid in (("lvl", C_LVL), ("ans", C_ANS), ("grp", C_GRP), ("yn", C_YN),
                     ("tag", C_TAG)):
        stored = db.query(DatasetValue.value_text).filter(
            DatasetValue.column_id == cid, DatasetValue.value_numeric.is_(None)).all()
        texts = sorted(t for (t,) in stored)
        assert texts == sorted(a for a, k in UNNUMBERED[col] for _ in range(k)), col


def test_a_stray_code_is_a_level_labelled_by_its_stored_text(db_session):
    _seed(db_session)
    script = _script(db_session)
    assert ("data$lvl <- factor(data$lvl,\n  levels = c(1, 2, 3, 4),\n"
            '  labels = c("Low", "Mid", "High", "4"),\n  ordered = TRUE)') in script
    # A binary column takes the same rule; it holds no stray code here, so no new level.
    assert 'data$yn <- factor(data$yn,\n  levels = c(0, 1),\n  labels = c("No", "Yes"))' in script
    # The comment names exactly the five columns holding an answer with no number.
    noted = {l[2:].split(":", 1)[0] for l in script.splitlines()
             if l.startswith("# ") and "no number (" in l and "counts them as a category" in l}
    assert noted == set(UNNUMBERED)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_R_counts_groups_and_averages_a_stray_code_as_the_app_does(db_session):
    db = db_session
    _seed(db)
    script = _script(db)
    mean_obj = _emitted_object(script, "mean", "score_by_lvl")
    freq_obj = _emitted_object(script, "freq", "ans_by_lvl")
    out, _printed = _run(db, _MEAN_DUMP.format(obj=mean_obj) + _FREQ_DUMP.format(obj=freq_obj) + (
        'x <- .mm_num(data$ans, "ans")\n'
        'cat("ANS", sum(!is.na(x)), format(mean(x, na.rm = TRUE), digits = 15), "\\n", sep = "\\t")\n'
        't <- table(data$ans)\n'
        'for (k in names(t)) cat("TAB", k, t[[k]], "\\n", sep = "\\t")\n'
        'cat("LEVELS", levels(data$lvl), "\\n", sep = "\\t")\n'))

    # The ungrouped variable: the stray code counts in n and in the mean (.mm_scale_codes).
    (ans,) = [l.split("\t")[1:3] for l in out.splitlines() if l.startswith("ANS\t")]
    n, res = _app_auto(db, PID + 8, C_ANS, "mean")
    assert int(ans[0]) == n == 10
    assert round(float(ans[1]), STATS_PRECISION) == res["mean"]
    tab = {l.split("\t")[1]: int(l.split("\t")[2]) for l in out.splitlines()
           if l.startswith("TAB\t") and int(l.split("\t")[2])}
    _n, freq = _app_auto(db, PID + 9, C_ANS, "frequency_distribution")
    named = {a for a, _ in UNNUMBERED["ans"]}
    assert tab == {k: v for k, v in freq["counts"].items() if v and k not in named}
    assert tab["4"] == 3
    (levels,) = [l.split("\t")[1:-1] for l in out.splitlines() if l.startswith("LEVELS\t")]
    assert [s.strip() for s in levels] == ["Low", "Mid", "High", "4"]

    # Grouped by `lvl`: every group the app forms from a NUMBER is R's group, n and mean.
    # The one group R cannot form is the answer the script names (D365's residual).
    app = _app_groups(db, M_MEAN)
    rows = {g: (int(k), m) for g, k, m, _sd in _rows(out, "MEAN", mean_obj)}
    lvl_named = {a for a, _ in UNNUMBERED["lvl"]}
    for g, res in app.items():
        if g in lvl_named:
            assert rows[g][0] == 0, (g, rows[g])
            continue
        assert rows[g][0] == res["n"], g
        assert round(float(rows[g][1]), STATS_PRECISION) == res["mean"], g
    assert rows["4"][0] == 3 and round(float(rows["4"][1]), 6) == 22.0   # the audit's row

    got: dict[str, dict[str, int]] = {}
    for group, value, k in _rows(out, "FREQ", freq_obj):
        if int(k):
            got.setdefault(group, {})[value] = int(k)
    want = {g: {v: k for v, k in res["counts"].items() if k and v not in named}
            for g, res in _app_groups(db, M_FREQ).items() if g not in lvl_named}
    assert got == {g: c for g, c in want.items() if c}
    assert got["4"] == {"Mid": 1, "4": 1, "High": 1}


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_the_script_names_each_answer_it_cannot_count(db_session):
    _seed(db_session)
    script = _script(db_session)
    _out, printed = _run(db_session)
    for col in ("lvl", "ans", "grp", "yn"):
        sentence = _note(col)
        assert f"# {sentence}" in script.splitlines(), col
        assert sentence in printed, (col, printed)
    # One line per column, and none for a column with no unnumbered answer.
    assert sum(1 for l in printed if "Mixed Measures counts them as a category" in l) == 5
    assert not any(l.startswith(("score:", "site:")) for l in printed)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_a_test_grouped_by_such_a_variable_does_not_claim_the_apps_groups(db_session):
    _seed(db_session)
    script = _script(db_session)
    clause = ("(Mixed Measures also counts this variable's answers that have no number, "
              "which this script cannot).")
    # The saved ANOVA by `grp`: three groups in the app, two in R.
    assert '.mm_num(data$score, "score"), data$grp, as_in_app = FALSE, have_groups = c(3, Inf)' in script
    # The comparison by `yn`: two groups in the app, one in R. The control by `site`
    # (a nominal, every answer a level) keeps the default.
    assert '.mm_num(data$score, "score"), data$yn, as_in_app = FALSE)' in script
    assert '.mm_num(data$score, "score"), data$site)' in script
    _out, printed = _run(db_session)
    anova = [l for l in printed if l.startswith("Not computed: One-way ANOVA")]
    assert anova == [f"Not computed: One-way ANOVA requires at least 3 groups, got 2 (A, B), {clause}"], printed
    cmp = [l for l in printed if l.startswith("Not computed: fewer than two groups")]
    assert cmp == [f"Not computed: fewer than two groups have 2 or more values, {clause}"], printed
    assert not any("as in Mixed Measures" in l for l in anova + cmp)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_a_hostile_stray_label_or_answer_is_text_not_code(db_session):
    _seed(db_session)
    script = _script(db_session)
    # Controls: the fixture reaches both emitter lines (#1468's rule).
    assert ("data$tag <- factor(data$tag,\n  levels = c(1, 2, 7),\n"
            f'  labels = c("Yes", "No", "{_escape_r_string(HOSTILE_LABEL)}"),\n'
            "  ordered = TRUE)") in script
    assert f"# {_escape_r_string(_note('tag'))}" in script.splitlines()
    out, _printed = _run(db_session, 'cat("INJECTED_RAN", exists("INJECTED"), "\\n")\n')
    assert "INJECTED_RAN FALSE" in out, "a stray label or answer ran as code (#1468)"
