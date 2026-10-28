"""#1322 (D4) — the formula dialog's "R equivalent" line, RUN in R against `evaluate`.

`to_r_expression` has one consumer since #1322: the formula dialog's preview
(`routers/dataset.py` → `ColumnFormDialog`'s *R equivalent*). The R EXPORT no
longer calls it — no R column can type its cells one at a time the way the
evaluator does, so the export writes the stored values and lists formulas as
comments (`test_export_r_computed_columns.py`).

What the dialog's line promises is narrower and checkable: **on a frame of
NUMERIC columns, the expression computes what `evaluate` computes, NA wherever
the app has no value.** This file runs every expression in real R over such a
frame and compares it, cell by cell, with the evaluator on the same rows.

Three rules exist for that promise, and the fixture is built so each one's
absence is visible (`backend/tests/the internal design notes: a fixture must sit where the
old and new behaviour DISAGREE):

* an all-missing SUM is NA, not R's 0 — row 3 is missing everywhere;
* an all-missing MEAN is NA, not R's NaN — so the R side reports NaN and NA as
  DIFFERENT kinds (`is.na(NaN)` is TRUE in R, and an `is.na` comparison would
  let the unguarded `rowMeans` pass);
* a zero divisor is NA, not ±Inf or NaN — row 2 divides by 0, row 4 is 0/0;
* a string literal is escaped — a backslash written bare is an R parse error.

Each expression is parsed and run in its OWN `tryCatch`, from its own file, so
one expression that fails to parse fails its own test, not every test here.

R-gated (#642: a skip reports green, so CI sets `MM_REQUIRE_R=1`).
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import math
import subprocess
import tempfile
from pathlib import Path

import pytest

from app.services.computed_columns import (
    ColumnInfo,
    evaluate,
    parse,
    to_r_expression,
    validate,
)
from tests import r_support

# A frame of NUMERIC columns — the only frame the dialog's line can promise.
_COLS = [
    ColumnInfo(id=1, code="a", text="A", column_type="numeric"),
    ColumnInfo(id=2, code="b", text="B", column_type="numeric"),
    ColumnInfo(id=3, code="c", text="C", column_type="numeric"),
    ColumnInfo(id=4, code="d", text="D", column_type="numeric"),
]
_R_NAMES = {1: "a", 2: "b", 3: "c", 4: "d"}

# One row per arm the rules above are about. None = no stored cell.
_ROWS: list[dict[str, float | None]] = [
    {"a": 10.0, "b": 2.0, "c": 1.5, "d": None},
    {"a": 6.0, "b": 0.0, "c": None, "d": 3.0},       # x / 0
    {"a": None, "b": None, "c": None, "d": None},    # every cell missing
    {"a": 0.0, "b": 0.0, "c": 2.0, "d": -1.0},       # 0 / 0
    {"a": -3.0, "b": 4.0, "c": 0.25, "d": 7.0},
    {"a": 3.14159, "b": None, "c": 5.0, "d": 0.0},
]

# (test id, formula). Every row of every formula is compared.
FORMULAS: list[tuple[str, str]] = [
    ("add", "[a] + [b]"),
    ("precedence", "[a] - [b] * [c]"),
    ("divide", "[a] / [b]"),
    ("divide_by_literal", "[a] / 2"),
    ("divide_abs", "ABS([a]) / [d]"),
    ("divide_by_literal_zero", "[a] / 0"),
    ("sum_two", "SUM([a], [b])"),
    ("sum_four", "SUM([a], [b], [c], [d])"),
    ("sum_with_literal", "SUM([b], 5)"),
    ("mean_two", "MEAN([a], [c])"),
    ("mean_four", "MEAN([a], [b], [c], [d])"),
    ("mean_then_divide", "MEAN([b], [c]) / [d]"),
    ("min", "MIN([a], [c])"),
    ("max", "MAX([b], [d])"),
    ("count_valid", "COUNT_VALID([a], [b], [c])"),
    ("is_missing", "IS_MISSING([b])"),
    ("not_is_missing", "NOT IS_MISSING([c])"),
    ("coalesce", "COALESCE([a], 0)"),
    ("and", "[a] > 2 AND [b] < 3"),
    ("or", "[a] > 2 OR IS_MISSING([b])"),
    ("equals", "[a] == 6"),
    ("if_numbers", "IF([a] > 1, [b], [c])"),
    ("negate", "-[a]"),
    ("round", "ROUND([a] / 3, 2)"),
    ("abs", "ABS([d])"),
    ("text_backslash", 'IF([a] > 1, "C:\\d", "x\'y")'),
    ("text_newline", 'IF([a] > 1, "line one\nline two", "z")'),
]


def _app_cell(formula: str, row: dict[str, float | None]) -> tuple[str, object]:
    """The evaluator's answer, as (kind, value): NA · NUM · TXT."""
    resolved = validate(parse(formula), _COLS).resolved_ast
    # A missing cell is absent, as the import stores it (no DatasetValue row).
    data = {
        cid: (repr(row[name]), row[name])
        for cid, name in _R_NAMES.items() if row[name] is not None
    }
    text, number = evaluate(resolved, data)
    if text is None and number is None:
        return ("NA", None)
    if number is not None:
        return ("NUM", number)
    return ("TXT", text)


def _r_vector(name: str) -> str:
    vals = ["NA" if r[name] is None else repr(r[name]) for r in _ROWS]
    return f"c({', '.join(vals)})"


_RUNNER = r"""
df <- data.frame(%(columns)s)
n <- nrow(df)
for (i in seq_len(%(count)d)) {
  res <- tryCatch({
    x <- eval(parse(file = sprintf("expr_%%d.R", i)), envir = list(df = df))
    # An expression the dialog shows is assigned to a column; assignment recycles.
    x <- rep_len(x, n)
    if (is.logical(x)) x <- as.numeric(x)
    x
  }, error = function(e) e)
  if (inherits(res, "error")) {
    cat(sprintf("%%d\tERR\t%%s\n", i, gsub("[\t\n]", " ", conditionMessage(res))))
    next
  }
  for (j in seq_len(n)) {
    v <- res[[j]]
    if (is.character(res)) {
      if (is.na(v)) cat(sprintf("%%d\t%%d\tNA\t\n", i, j))
      else cat(sprintf("%%d\t%%d\tTXT\t%%s\n", i, j, paste(utf8ToInt(v), collapse = ",")))
    } else if (is.nan(v)) {
      cat(sprintf("%%d\t%%d\tNAN\t\n", i, j))
    } else if (is.na(v)) {
      cat(sprintf("%%d\t%%d\tNA\t\n", i, j))
    } else {
      cat(sprintf("%%d\t%%d\tNUM\t%%.17g\n", i, j, v))
    }
  }
}
"""


@pytest.fixture(scope="module")
def r_results() -> dict:
    """Run every translated expression in ONE Rscript. Never asserts — a failure
    here would ERROR every test rather than FAIL the one it belongs to."""
    exprs = [
        to_r_expression(validate(parse(f), _COLS).resolved_ast, _R_NAMES)
        for _, f in FORMULAS
    ]
    columns = ", ".join(f"{name} = {_r_vector(name)}" for name in _R_NAMES.values())
    with tempfile.TemporaryDirectory() as d:
        wd = Path(d)
        for i, expr in enumerate(exprs, start=1):
            (wd / f"expr_{i}.R").write_text(expr + "\n", encoding="utf-8")
        (wd / "runner.R").write_text(
            _RUNNER % {"columns": columns, "count": len(exprs)}, encoding="utf-8")
        proc = subprocess.run([r_support.RSCRIPT, "--vanilla", "runner.R"], cwd=str(wd),
                              capture_output=True, text=True, timeout=300)
    cells: dict[tuple[int, int], tuple[str, str]] = {}
    errors: dict[int, str] = {}
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[1] == "ERR":
            errors[int(parts[0])] = parts[2]
        elif len(parts) == 4:
            cells[(int(parts[0]), int(parts[1]))] = (parts[2], parts[3])
    return {"proc": proc, "cells": cells, "errors": errors, "exprs": exprs}


def _same(app: tuple[str, object], r: tuple[str, str]) -> bool:
    a_kind, a_val = app
    r_kind, r_val = r
    if a_kind != r_kind:
        return False
    if a_kind == "NA":
        return True
    if a_kind == "NUM":
        return math.isclose(float(a_val), float(r_val), rel_tol=1e-12, abs_tol=1e-12)
    return [ord(ch) for ch in a_val] == [int(x) for x in r_val.split(",") if x]


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
@pytest.mark.parametrize(
    "index,formula", [(i, f) for i, (_, f) in enumerate(FORMULAS, start=1)],
    ids=[name for name, _ in FORMULAS],
)
def test_the_dialogs_r_line_computes_what_the_app_computes(r_results, index, formula):
    proc = r_results["proc"]
    assert proc.returncode == 0, f"the runner failed in R:\n{proc.stderr}"
    expr = r_results["exprs"][index - 1]
    assert index not in r_results["errors"], (
        f"{formula!r} → {expr!r} did not run in R: {r_results['errors'].get(index)}")
    mismatches = []
    for j, row in enumerate(_ROWS, start=1):
        app = _app_cell(formula, row)
        r = r_results["cells"].get((index, j), ("MISSING", ""))
        if not _same(app, r):
            mismatches.append(f"row {j}: app {app}, R {r}")
    assert not mismatches, f"{formula!r} → {expr!r}\n" + "\n".join(mismatches)


class TestTheFixtureCanDisagree:
    """The discrimination half (`backend/tests/the internal design notes, #707a): each rule is
    only tested if the fixture holds the case the rule exists for. These read the
    APP side alone, so they hold with or without R."""

    def test_an_all_missing_row_exists_and_the_app_calls_its_sum_and_mean_NA(self):
        assert _app_cell("SUM([a], [b])", _ROWS[2]) == ("NA", None)
        assert _app_cell("MEAN([a], [b], [c], [d])", _ROWS[2]) == ("NA", None)

    def test_a_zero_divisor_and_a_zero_over_zero_exist_and_the_app_calls_them_NA(self):
        assert _ROWS[1]["b"] == 0 and _ROWS[1]["a"] != 0
        assert _ROWS[3]["a"] == 0 and _ROWS[3]["b"] == 0
        assert _app_cell("[a] / [b]", _ROWS[1]) == ("NA", None)
        assert _app_cell("[a] / [b]", _ROWS[3]) == ("NA", None)

    def test_a_literal_carries_a_backslash_and_a_newline(self):
        texts = {f for _, f in FORMULAS if '"' in f}
        assert any("\\" in f for f in texts)
        assert any("\n" in f for f in texts)
