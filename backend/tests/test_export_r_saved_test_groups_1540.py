"""#1540 — a saved t-test or ANOVA never halts the exported R script when its grouping
has changed since it was computed.

A saved test keeps its stored result when its data changes — `mark_metrics_stale`
marks it stale, and only a recompute clears it — so the export emits a test whose
grouping column may since have GAINED a group. The script read every testable group
(`.mm_testable(y, g)`), so `t.test` met three levels and R stopped with *"grouping
factor must have exactly 2 levels"*: every section after it — the rest of the tests,
the comparisons, the charts, the agreement sections — never ran. D52 (#1329) said no
emitted test may halt the script. The sibling: a saved ANOVA whose grouping LOST a
group printed an F over two groups, which the app refuses (*"requires at least 3
groups"*).

The script now asks each saved test's own group-count rule at RUN time — the groups
that hold a value, as `statistical_tests.compute_independent_t_test` /
`compute_one_way_anova` count them — and outside it prints the app's refusal and
carries on. Each case is sourced in real R; each has a control where the old call's
outcome is shown beside the new one.
"""
from __future__ import annotations

import asyncio
import io
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.dataset import DatasetValue
from app.models.statistical_test import StatisticalTest
from app.models.user import User
from app.services.staleness import mark_metrics_stale
from app.services.statistical_tests import (
    compute_independent_t_test, compute_one_way_anova, compute_statistical_test,
)
from tests import r_support
from tests.test_export_r_score_names import _build, _zip

PID = 15400

# Source the script whole, then report: did it COMPLETE, and what did the saved test print?
RUNNER = r'''
out <- character(0)
res <- tryCatch({
  out <- capture.output(suppressWarnings(suppressMessages(source("__S__", echo = FALSE))))
  "COMPLETED"
}, error = function(e) paste("HALTED:", conditionMessage(e)))
cat("RESULT", res, "\n")
for (l in out) cat("OUT", l, "\n")
cat("REACHED_END", exists("mm_default_colors") || exists("data"), "\n")
'''


def _source(db, pid) -> str:
    raw = asyncio.run(_zip(pid, db.get(User, 1), db))
    with tempfile.TemporaryDirectory() as d:
        work = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(work)
            setup = next(n for n in zf.namelist() if n.endswith(".R"))
        (work / "run.R").write_text(RUNNER.replace("__S__", setup), encoding="utf-8")
        proc = subprocess.run([r_support.RSCRIPT, "run.R"], cwd=str(work),
                              capture_output=True, text=True, timeout=300)
        return proc.stdout


def _script(db, pid) -> str:
    raw = asyncio.run(_zip(pid, db.get(User, 1), db))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        return zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()


def _set_group(db, cols, frm: str, to: str) -> list[DatasetValue]:
    cells = db.query(DatasetValue).filter(
        DatasetValue.column_id == cols["grp"], DatasetValue.value_text == frm,
    ).all()
    for v in cells:
        v.value_text = to
    db.flush()
    return cells


def _project(db, test_type, pid):
    cols, _doms, tids = _build(
        db, pid, domains=[{"name": "Scale", "items": ["i1", "i2"]}],
        saved_tests=[{"domain": "Scale", "by": "grp", "test": test_type}],
    )
    return cols, db.get(StatisticalTest, tids[0])


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestASavedTestWhoseGroupingChanged:
    def test_a_t_test_that_gained_a_group_prints_the_apps_refusal_and_the_script_finishes(self, db_session):
        db = db_session
        cols, st = _project(db, "independent_t_test", PID)
        moved = _set_group(db, cols, "C", "B")            # computed over TWO groups
        compute_statistical_test(db, st)
        db.flush()
        control = _source(db, PID)
        assert "RESULT COMPLETED" in control
        assert "Welch Two Sample t-test" in control       # the control runs the test

        for v in moved:                                   # the third group's rows arrive
            v.value_text = "C"
        db.flush()
        mark_metrics_stale(db, PID, column_ids=[cols["grp"]])
        db.flush()
        db.refresh(st)
        assert st.stale and st.result_data is not None    # the stored result stands

        # What the app says on recompute — asked of the computation itself, because
        # `compute_statistical_test` clears a refused test's stored result (and the
        # export then has nothing to emit).
        with pytest.raises(ValueError) as refusal:
            compute_independent_t_test(db, st)
        assert "requires exactly 2 groups, got 3" in str(refusal.value)

        out = _source(db, PID)
        assert "RESULT COMPLETED" in out, out
        assert "Independent t-test requires exactly 2 groups, got 3 (A, B, C)" in out, out
        assert "Welch Two Sample t-test" not in out

    def test_an_anova_that_lost_a_group_prints_the_apps_refusal(self, db_session):
        db = db_session
        cols, st = _project(db, "one_way_anova", PID + 1)
        compute_statistical_test(db, st)                  # computed over THREE groups
        db.flush()
        assert "Df" in _source(db, PID + 1)               # control: the ANOVA table prints

        _set_group(db, cols, "C", "B")
        mark_metrics_stale(db, PID + 1, column_ids=[cols["grp"]])
        db.flush()
        db.refresh(st)
        with pytest.raises(ValueError) as refusal:
            compute_one_way_anova(db, st)
        assert "requires at least 3 groups, got 2" in str(refusal.value)

        out = _source(db, PID + 1)
        assert "RESULT COMPLETED" in out, out
        assert "One-way ANOVA requires at least 3 groups, got 2 (A, B)" in out, out
        assert "Df" not in out                            # no F the app refuses

    def test_a_current_test_runs_unchanged(self, db_session):
        db = db_session
        cols, st = _project(db, "independent_t_test", PID + 2)
        _set_group(db, cols, "C", "B")
        res = compute_statistical_test(db, st)
        db.flush()
        out = _source(db, PID + 2)
        assert "RESULT COMPLETED" in out
        t_line = next(l for l in out.splitlines() if l.startswith("OUT t = "))
        r_t = float(t_line.split("t = ")[1].split(",")[0])
        assert r_t == pytest.approx(res["t_statistic"], abs=1e-3)
        assert "Out of date in Mixed Measures" not in _script(db, PID + 2)


def test_a_stale_saved_test_says_so_in_the_script(db_session):
    """The app shows a stale test's LAST result; the script computes it on the data as it
    is now. A researcher comparing the two is told why they may differ."""
    db = db_session
    cols, st = _project(db, "independent_t_test", PID + 3)
    _set_group(db, cols, "C", "B")
    compute_statistical_test(db, st)
    db.flush()
    assert "Out of date in Mixed Measures" not in _script(db, PID + 3)   # control
    st.stale = True
    db.flush()
    assert "Out of date in Mixed Measures" in _script(db, PID + 3)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_an_alpha_whose_records_have_gone_prints_the_apps_refusal(db_session):
    """The sibling arm: `psych::alpha` RAISES on 0 or 1 complete rows ("'x' is empty",
    executed), and the app's own rule is at least 3 complete records."""
    db = db_session
    pid = PID + 4
    cols, doms, _t = _build(db, pid, domains=[{"name": "Scale", "items": ["i1", "i2"]}])
    st = StatisticalTest(project_id=pid, test_type="cronbachs_alpha",
                         target_type="analysis_domain", target_id=doms["Scale"],
                         config="{}")
    db.add(st)
    db.flush()
    compute_statistical_test(db, st)
    db.flush()
    control = _source(db, pid)
    assert "RESULT COMPLETED" in control

    # Every record but one loses its i1 answer, after the result was stored.
    gone = db.query(DatasetValue).filter(DatasetValue.column_id == cols["i1"]).all()[1:]
    for v in gone:
        db.delete(v)
    st.stale = True
    db.flush()
    out = _source(db, pid)
    assert "RESULT COMPLETED" in out, out
    assert "Cronbach's alpha requires at least 3 complete records, got 1" in out, out


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_an_alpha_prints_its_table_when_the_script_is_sourced(db_session):
    """A bare top-level `psych::alpha(...)` prints nothing under `source()` (the way the
    researcher runs the script), unlike the t-test and ANOVA arms, which `print()`."""
    db = db_session
    pid = PID + 5
    _cols, doms, _t = _build(db, pid, domains=[{"name": "Scale", "items": ["i1", "i2"]}])
    st = StatisticalTest(project_id=pid, test_type="cronbachs_alpha",
                         target_type="analysis_domain", target_id=doms["Scale"], config="{}")
    db.add(st)
    db.flush()
    compute_statistical_test(db, st)
    db.flush()
    assert "Reliability analysis" in _source(db, pid)
