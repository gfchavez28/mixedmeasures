"""#1322 (D3) — the R script DOCUMENTS computed variables and never re-runs them.

The script used to emit `data$<cc> <- <formula translated to R>` after the factor
sections, under a header claiming the formulas "reproduce columns already present
in the CSV". Run in R, they did not: the app types each CELL on its own
(`computed_columns.py::_eval` — missing → NULL, else `value_numeric`, else a
demographic cell parsed, else text) while an R column holds one type and, by that
point, the categorical columns are factors. Ordinal and 0-based arithmetic, nominal
codes, an all-missing SUM, ÷0 and the other dataset's rows of a stacked frame all
disagreed; two shapes HALTED the whole script; and every assignment dropped the
variable label set above it. The overwrite then fed every later statistic.

The decision (D3): the formulas are COMMENTS, and the CSV's stored values — the
ones every analysis in the app reads — stand.

* **(A)** `TestTheScriptLeavesTheStoredValues` sources the REAL exported script in R
  on the review's fixture and requires every computed variable to equal the CSV and
  the database, NA positions included, on both datasets' rows; the saved mean over
  a 0-based computed variable to come out at the app's 1.0; and the label to survive.
* **(B)** `TestTheFixtureCanDisagree` evaluates the formulas the way the script used
  to — and the way the filed Direction proposed (`.mm_num`-wrapped) — into SIDE
  objects, and requires them to disagree with the CSV on the columns named. Without
  this, (A) could pass on a fixture where executing the formula happens to agree.
* **(C)** `TestScriptText` reads the script: no assignment, every formula a comment
  (a newline or carriage return inside a literal must not end it), the stale note.

R-gated arms skip without Rscript (#642: CI sets `MM_REQUIRE_R=1`).
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import ast
import asyncio
import io
import json
import re
import subprocess
import types
import zipfile
from pathlib import Path

import pytest
from sqlalchemy.orm import sessionmaker

from app.models.dataset import (
    ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue,
)
from app.models.metric import ComputedResult, MetricDefinition
from app.models.project import Project
from app.models.user import User
from app.routers.export_r import (
    _build_r_script, _escape_r_string, _make_r_identifier, _slugify, export_r_data,
)
from app.services.computed_columns import (
    ColumnInfo, evaluate_computed_column, parse, to_r_expression, validate,
)
from app.services.metrics import compute_metric
from tests import r_support
from tests.conftest import _make_engine

APP_DIR = Path(__file__).resolve().parent.parent / "app"

AGREE = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"]
ZB = ["None", "A little", "Some", "A lot"]          # codes 0..3
GAP = ["Never", "Rarely", "Often", "Always"]        # codes 1, 2, 4, 5
GAP_CODES = [1, 2, 4, 5]

# n1, n2, q1, q2, f1, f2, g1, b1, nom, nomc, age, txt, n3 — the review's fixture.
# Row 3 has n1 and n2 missing together (an all-missing SUM); rows 2 and 4 divide
# by zero (row 4 is 0/0); n3 = "99" is DECLARED missing; age carries "N/A".
ROWS = [
    (10, 2, 5, 2, 0, 1, 1, 0, "Female", "North", "23", "hi", "99"),
    (6, 0, 1, 4, 3, 2, 2, 1, "Male", "South", "45", None, "4"),
    (None, None, 3, 3, 2, 0, 4, 1, "Female", "North", "67", "x", "99"),
    (0, 0, 4, 1, 1, 1, 5, 0, "Male", "South", "N/A", "y", "7"),
    (-3, 4, 2, None, 0, None, None, 1, "Female", "North", "30", None, None),
]
WAVE2_ROWS = 3  # a second dataset: its rows have no cell in any survey column

# (code, formula, type). Order matters: a chained formula follows what it reads.
COMPUTED = [
    ("c_diff_q", "[q1] - [q2]", ColumnType.NUMERIC),
    ("c_mean_f", "MEAN([f1], [f2])", ColumnType.NUMERIC),
    ("c_sum_n", "SUM([n1], [n2])", ColumnType.NUMERIC),
    ("c_div", "[n1] / [n2]", ColumnType.NUMERIC),
    ("c_mean_n", "MEAN([n1], [n2])", ColumnType.NUMERIC),
    ("c_min_n", "MIN([n1], [n2])", ColumnType.NUMERIC),
    ("c_cnt_n", "COUNT_VALID([n1], [n2])", ColumnType.NUMERIC),
    ("c_cnt_nom", "COUNT_VALID([nom], [q1])", ColumnType.NUMERIC),
    ("c_eq_q", "[q1] == 3", ColumnType.NUMERIC),
    ("c_gt_q", "[q1] > 3", ColumnType.NUMERIC),
    ("c_if_nom", 'IF([nom] == "Female", 1, 0)', ColumnType.NUMERIC),
    ("c_if_nomc_code", "IF([nomc] == 1, 1, 0)", ColumnType.NUMERIC),
    ("c_age_band", "IF([age] < 45, 1, 0)", ColumnType.NUMERIC),
    ("c_bin_plus", "[b1] + 1", ColumnType.NUMERIC),
    ("c_gap_mean", "MEAN([g1], [q1])", ColumnType.NUMERIC),
    ("c_coalesce", "COALESCE([q2], 0)", ColumnType.NUMERIC),
    ("c_sum_decl", "SUM([n3], [n1])", ColumnType.NUMERIC),
    ("c_lvl", "IF([q1] > [f1], 1, 0)", ColumnType.NUMERIC),   # level sets differ
    ("c_bs", 'IF([nom] == "C:\\d", 1, 0)', ColumnType.NUMERIC),  # a backslash
    ("c_nl", 'IF([nom] == "x\nquit(status = 3)", 1, 0)', ColumnType.NUMERIC),
    ("c_cr", 'IF([nom] == "y\rquit(status = 4)", 1, 0)', ColumnType.NUMERIC),
    ("c_text", 'IF([n1] > 5, "High", "Low")', ColumnType.NOMINAL),
    ("c_txt_missing", "IS_MISSING([txt])", ColumnType.NUMERIC),
    ("c_chain", "[c_diff_q] * 2", ColumnType.NUMERIC),
]
STALE = "c_chain"            # marked out of date after it is computed
MEAN_INPUT = "c_mean_f"      # the saved mean the script must reproduce (1.0)
CC_LABEL = "Mean of f1 and f2"

SURVEY_SLUG = _slugify("survey", max_len=20)


def _r(code: str) -> str:
    """The export's R name for a survey column (multi-dataset → prefixed)."""
    return f"{SURVEY_SLUG}__{_make_r_identifier(code)}"


def _seed(db) -> dict:
    db.add(Project(id=1, name="Computed Export", user_id=1)); db.flush()
    db.add(Dataset(id=1, project_id=1, name="survey")); db.flush()
    order = [0]

    def col(cid, code, ctype, ds=1, **kw):
        db.add(DatasetColumn(
            id=cid, dataset_id=ds, column_code=code, column_name=code,
            column_text=kw.pop("text", code), column_type=ctype,
            sequence_order=order[0], display_order=order[0],
            source=kw.pop("source", "imported"), **kw))
        order[0] += 1

    col(1, "n1", ColumnType.NUMERIC)
    col(2, "n2", ColumnType.NUMERIC)
    col(3, "q1", ColumnType.ORDINAL, scale_labels=json.dumps(AGREE),
        scale_values=json.dumps([1, 2, 3, 4, 5]))
    col(4, "q2", ColumnType.ORDINAL, scale_labels=json.dumps(AGREE),
        scale_values=json.dumps([1, 2, 3, 4, 5]))
    col(5, "f1", ColumnType.ORDINAL, scale_labels=json.dumps(ZB),
        scale_values=json.dumps([0, 1, 2, 3]))
    col(6, "f2", ColumnType.ORDINAL, scale_labels=json.dumps(ZB),
        scale_values=json.dumps([0, 1, 2, 3]))
    col(7, "g1", ColumnType.ORDINAL, scale_labels=json.dumps(GAP),
        scale_values=json.dumps(GAP_CODES))
    col(8, "b1", ColumnType.BINARY, scale_labels=json.dumps(["No", "Yes"]),
        scale_values=json.dumps([0, 1]))
    col(9, "nom", ColumnType.NOMINAL)                      # plain text nominal
    col(10, "nomc", ColumnType.NOMINAL, scale_labels=json.dumps(["North", "South"]),
        scale_values=json.dumps([1, 2]))                   # labelled (.sav shape)
    col(11, "age", ColumnType.DEMOGRAPHIC)
    col(12, "txt", ColumnType.OPEN_TEXT)
    col(13, "n3", ColumnType.NUMERIC, missing_values=json.dumps([{"value": "99"}]))
    db.flush()

    def cell(rid, cid, vt, vn):
        if vt is None and vn is None:
            return
        db.add(DatasetValue(row_id=rid, column_id=cid, value_text=vt, value_numeric=vn))

    for i, r in enumerate(ROWS, start=1):
        db.add(DatasetRow(id=i, dataset_id=1, row_identifier=f"r{i}")); db.flush()
        n1, n2, q1, q2, f1, f2, g1, b1, nom, nomc, age, txt, n3 = r
        cell(i, 1, None if n1 is None else str(n1), n1)
        cell(i, 2, None if n2 is None else str(n2), n2)
        cell(i, 3, None if q1 is None else AGREE[q1 - 1], q1)
        cell(i, 4, None if q2 is None else AGREE[q2 - 1], q2)
        cell(i, 5, None if f1 is None else ZB[f1], f1)
        cell(i, 6, None if f2 is None else ZB[f2], f2)
        cell(i, 7, None if g1 is None else GAP[GAP_CODES.index(g1)], g1)
        cell(i, 8, ["No", "Yes"][b1], b1)
        cell(i, 9, nom, None)
        cell(i, 10, nomc, {"North": 1.0, "South": 2.0}[nomc])
        cell(i, 11, age, None)
        cell(i, 12, txt, None)
        if n3 is not None:
            cell(i, 13, n3, None if n3 == "99" else float(n3))
    db.flush()

    db.add(Dataset(id=2, project_id=1, name="wave2")); db.flush()
    col(101, "w2n", ColumnType.NUMERIC, ds=2)
    db.flush()
    for j in range(WAVE2_ROWS):
        db.add(DatasetRow(id=100 + j, dataset_id=2, row_identifier=f"w{j}")); db.flush()
        db.add(DatasetValue(row_id=100 + j, column_id=101,
                            value_text=str(j), value_numeric=float(j)))
    db.flush()

    ids: dict[str, int] = {}
    for k, (code, expr, ctype) in enumerate(COMPUTED):
        cid = 200 + k
        col(cid, code, ctype, source="computed", expression=expr,
            text=CC_LABEL if code == MEAN_INPUT else code)
        db.flush()
        cc = db.get(DatasetColumn, cid)
        siblings = db.query(DatasetColumn).filter(
            DatasetColumn.dataset_id == 1, DatasetColumn.id != cid).all()
        infos = [ColumnInfo(id=s.id, code=s.column_code, text=s.column_text,
                            column_type=s.column_type.value) for s in siblings]
        cc.depends_on_column_ids = json.dumps(
            validate(parse(expr), infos, self_column_id=cid).dependency_ids)
        evaluate_computed_column(db, cc)  # the app's own values — the oracle
        ids[code] = cid
    db.get(DatasetColumn, ids[STALE]).stale = True
    db.flush()

    metric = MetricDefinition(
        project_id=1, name="Mean of the 0-based computed variable", metric_type="mean",
        config="{}", input_source_type="dataset_column",
        input_source_id=ids[MEAN_INPUT], origin="human")
    db.add(metric); db.flush()
    compute_metric(db, metric)
    db.flush()
    return {"ids": ids, "metric_id": metric.id}


async def _export_bytes(db) -> bytes:
    user = db.query(User).filter(User.id == 1).one()
    resp = export_r_data(project_id=1, user=user, db=db)
    chunks = [c async for c in resp.body_iterator]
    return b"".join(c if isinstance(c, bytes) else c.encode() for c in chunks)


def _r_lines(text: str) -> list[str]:
    """Lines as R's parser reads them — LF, CRLF or a lone CR all end one."""
    return re.split(r"\r\n|\r|\n", text)


def _section(script: str, title: str) -> list[str]:
    lines = _r_lines(script)
    start = lines.index(f"# ---- {title} ----")
    end = next((i for i in range(start + 1, len(lines))
                if lines[i].startswith("# ---- ")), len(lines))
    return lines[start + 1:end]


@pytest.fixture(scope="module")
def bundle(tmp_path_factory):
    engine = _make_engine()
    db = sessionmaker(bind=engine, autocommit=False, autoflush=False)()
    db.add(User(id=1, username="testuser", password_hash="x", is_admin=True))
    db.flush()
    seeded = _seed(db)
    raw = asyncio.run(_export_bytes(db))
    wd = tmp_path_factory.mktemp("export_r_computed")
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        zf.extractall(wd)
    setup = next(n for n in names if n.endswith("_setup.R"))
    data_csv = next(n for n in names if n.endswith("_data.csv"))
    script = (wd / setup).read_text(encoding="utf-8")

    stored: dict[str, dict[str, tuple]] = {}
    row_ids = {r.id: r.row_identifier for r in db.query(DatasetRow).all()}
    for code, cid in seeded["ids"].items():
        vals = {row_ids[v.row_id]: (v.value_text, v.value_numeric)
                for v in db.query(DatasetValue).filter(DatasetValue.column_id == cid)}
        stored[code] = {rid: vals.get(rid, (None, None)) for rid in row_ids.values()}
    cr = db.query(ComputedResult).filter(
        ComputedResult.metric_definition_id == seeded["metric_id"]).one()
    app_mean = json.loads(cr.result_data)["mean"]

    yield types.SimpleNamespace(
        db=db, wd=wd, setup=setup, data_csv=data_csv, script=script,
        stored=stored, app_mean=app_mean, ids=seeded["ids"])
    db.close()
    engine.dispose()


# ── The R run, shared by (A) and (B) ─────────────────────────────────────────

_DUMP = r"""
.dump <- function(tag, nm, x) {
  if (is.factor(x)) x <- as.character(x)
  if (is.logical(x)) x <- as.numeric(x)
  x <- rep_len(x, nrow(.csv))
  for (j in seq_len(nrow(.csv))) {
    v <- x[[j]]
    rid <- .csv$record_id[[j]]
    if (is.character(x)) {
      if (is.na(v)) cat(sprintf("%s\t%s\t%s\tNA\t\n", tag, nm, rid))
      else cat(sprintf("%s\t%s\t%s\tTXT\t%s\n", tag, nm, rid,
                       paste(utf8ToInt(v), collapse = ",")))
    } else if (is.nan(v)) {
      cat(sprintf("%s\t%s\t%s\tNAN\t\n", tag, nm, rid))
    } else if (is.na(v)) {
      cat(sprintf("%s\t%s\t%s\tNA\t\n", tag, nm, rid))
    } else {
      cat(sprintf("%s\t%s\t%s\tNUM\t%.17g\n", tag, nm, rid, v))
    }
  }
}
"""


def _old_expressions(db, ids: dict[str, int]) -> dict[str, str]:
    """Each formula as the script used to EXECUTE it: `to_r_expression` over the
    export's R names, `data` as the frame (the pre-#1322 export's own call)."""
    cols = db.query(DatasetColumn).filter(DatasetColumn.dataset_id == 1).all()
    names = {c.id: _r(c.column_code) for c in cols}
    out = {}
    for code, cid in ids.items():
        cc = db.get(DatasetColumn, cid)
        infos = [ColumnInfo(id=c.id, code=c.column_code, text=c.column_text,
                            column_type=c.column_type.value) for c in cols if c.id != cid]
        resolved = validate(parse(cc.expression), infos, self_column_id=cid).resolved_ast
        out[code] = to_r_expression(resolved, names, df_name="data")
    return out


def _mm_num_wrapped(expr: str) -> str:
    """The filed Direction: every reference wrapped in `.mm_num` (#537)."""
    return re.sub(r"data\$(\w+)", r'.mm_num(data$\1, "\1")', expr)


@pytest.fixture(scope="module")
def r_run(bundle):
    """Source the REAL exported script, then dump what it left. Never asserts —
    a failure here would ERROR every test rather than FAIL the one it is about."""
    wd = bundle.wd
    # The saved mean's line exactly as emitted, run below — never a restatement.
    mean_line = next(
        (ln for ln in _section(bundle.script, "Metric computation")
         if ln.startswith(f"mean(.mm_num(data${_r(MEAN_INPUT)}")), None)
    old = _old_expressions(bundle.db, bundle.ids)
    variants = {"OLD": old, "MMNUM": {k: _mm_num_wrapped(v) for k, v in old.items()}}
    files = []
    for tag, exprs in variants.items():
        for code, expr in exprs.items():
            f = f"{tag}_{code}.R"
            (wd / f).write_text(expr + "\n", encoding="utf-8")
            files.append((tag, code, f))
    if mean_line is not None:
        (wd / "mean_line.R").write_text(mean_line + "\n", encoding="utf-8")

    cc = [code for code, _, _ in COMPUTED]
    runner = [
        f'source("{bundle.setup}")',
        f'.csv <- readr::read_csv("{bundle.data_csv}", na = c("", "NA"), show_col_types = FALSE)',
        _DUMP,
    ]
    for code in cc:
        runner.append(f'.dump("R", "{code}", data[["{_r(code)}"]])')
        runner.append(f'.dump("CSV", "{code}", .csv[["{_r(code)}"]])')
    lab = f'attr(data[["{_r(MEAN_INPUT)}"]], "label")'
    runner.append(f'cat(sprintf("LABEL\\t%s\\n", if (is.null({lab})) "<NULL>" else {lab}))')
    if mean_line is not None:
        runner.append('cat(sprintf("MEAN\\t%.17g\\n", eval(parse(file = "mean_line.R"))))')
    for tag, code, f in files:
        runner.append(
            f'.res <- tryCatch(eval(parse(file = "{f}"), envir = globalenv()), '
            f'error = function(e) e)')
        runner.append(
            f'if (inherits(.res, "error")) cat(sprintf("ERR\\t{tag}\\t{code}\\t%s\\n", '
            f'gsub("[\\t\\n]", " ", conditionMessage(.res)))) else .dump("{tag}", "{code}", .res)')
    (wd / "runner.R").write_text("\n".join(runner) + "\n", encoding="utf-8")

    proc = subprocess.run([r_support.RSCRIPT, "--vanilla", "runner.R"], cwd=str(wd),
                          capture_output=True, text=True, timeout=300)
    cells: dict[tuple[str, str, str], tuple[str, str]] = {}
    errors: dict[tuple[str, str], str] = {}
    extra: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if parts[0] in ("LABEL", "MEAN") and len(parts) == 2:
            extra[parts[0]] = parts[1]
        elif parts[0] == "ERR" and len(parts) == 4:
            errors[(parts[1], parts[2])] = parts[3]
        elif len(parts) == 5:
            cells[(parts[0], parts[1], parts[2])] = (parts[3], parts[4])
    return types.SimpleNamespace(proc=proc, cells=cells, errors=errors, extra=extra,
                                 mean_line=mean_line)


def _expected(bundle, code: str, rid: str) -> tuple[str, str]:
    """What the DATABASE holds, in the dump's terms — never read from the script."""
    vt, vn = bundle.stored[code][rid]
    ctype = next(t for c, _, t in COMPUTED if c == code)
    if ctype == ColumnType.NOMINAL:
        return ("NA", "") if vt is None else ("TXT", ",".join(str(ord(ch)) for ch in vt))
    return ("NA", "") if vn is None else ("NUM", repr(float(vn)))


def _same(a: tuple[str, str], b: tuple[str, str]) -> bool:
    if a[0] != b[0]:
        return False
    if a[0] == "NUM":
        return abs(float(a[1]) - float(b[1])) <= 1e-9 * max(1.0, abs(float(a[1])))
    return a[1] == b[1]


def _record_ids(bundle) -> list[str]:
    return [f"r{i}" for i in range(1, len(ROWS) + 1)] + [f"w{j}" for j in range(WAVE2_ROWS)]


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestTheScriptLeavesTheStoredValues:
    """(A) Every computed variable in R equals the CSV and the database."""

    def test_the_exported_script_runs_to_the_end(self, r_run):
        # Two of the fixture's formulas HALTED the old script: factors with
        # different level sets (c_lvl) and a backslash literal (c_bs).
        assert r_run.proc.returncode == 0, f"the exported script failed in R:\n{r_run.proc.stderr}"

    @pytest.mark.parametrize("code", [c for c, _, _ in COMPUTED])
    def test_each_computed_variable_is_the_stored_value(self, bundle, r_run, code):
        assert r_run.proc.returncode == 0, r_run.proc.stderr
        mismatches = []
        for rid in _record_ids(bundle):
            want = _expected(bundle, code, rid)
            got_r = r_run.cells.get(("R", code, rid), ("MISSING", ""))
            got_csv = r_run.cells.get(("CSV", code, rid), ("MISSING", ""))
            if not _same(want, got_csv):
                mismatches.append(f"{rid}: CSV {got_csv}, database {want}")
            if not _same(want, got_r):
                mismatches.append(f"{rid}: R {got_r}, database {want}")
        assert not mismatches, f"{code} ({_r(code)}):\n" + "\n".join(mismatches)

    def test_the_other_datasets_rows_stay_NA(self, r_run):
        """A stacked frame has rows the app never computed (#1322's spill):
        `COUNT_VALID` gave 0 there, `IS_MISSING` TRUE, `SUM` 0."""
        assert r_run.proc.returncode == 0, r_run.proc.stderr
        for code in ("c_cnt_n", "c_txt_missing", "c_sum_n", "c_coalesce"):
            for j in range(WAVE2_ROWS):
                assert r_run.cells.get(("R", code, f"w{j}")) == ("NA", ""), (code, j)

    def test_the_saved_mean_over_a_zero_based_variable_is_the_apps(self, bundle, r_run):
        """The emitted metric line, RUN (statistics.md §4) — not a restatement.
        The old overwrite read the factor POSITIONS and printed 2.0."""
        assert r_run.mean_line is not None, "no saved-mean line was emitted"
        assert r_run.proc.returncode == 0, r_run.proc.stderr
        assert bundle.app_mean == pytest.approx(1.0)
        assert float(r_run.extra["MEAN"]) == pytest.approx(bundle.app_mean, abs=1e-9)

    def test_the_variable_label_survives(self, r_run):
        """The label is set in *Variable labels*; an assignment after it dropped it."""
        assert r_run.proc.returncode == 0, r_run.proc.stderr
        assert r_run.extra.get("LABEL") == CC_LABEL


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestTheFixtureCanDisagree:
    """(B) The discrimination half (`backend/tests/the internal design notes, #707a): executing
    the formula — as the script did, or wrapped in `.mm_num` as filed — must
    DISAGREE with the CSV here, or (A) proves nothing. Each column named is one
    failure class; the old shape is rebuilt with today's translator, so its
    all-missing SUM and ÷0 guards (D4) are IN it and the disagreement is the data
    model's, not the translator's."""

    def _differs(self, bundle, r_run, tag, code) -> bool:
        if (tag, code) in r_run.errors:
            return True
        return any(
            not _same(r_run.cells.get(("CSV", code, rid), ("MISSING", "")),
                      r_run.cells.get((tag, code, rid), ("MISSING", "")))
            for rid in _record_ids(bundle))

    @pytest.mark.parametrize("code,why", [
        ("c_diff_q", "arithmetic on two ordered factors"),
        ("c_mean_f", "a 0-based scale read as level positions"),
        ("c_if_nomc_code", "a labelled nominal's code compared with its label"),
        ("c_cnt_n", "the other dataset's rows counted as 0"),
        ("c_lvl", "factors with different level sets (R stops)"),
    ])
    def test_the_old_executed_formula_disagrees(self, bundle, r_run, code, why):
        assert r_run.proc.returncode == 0, r_run.proc.stderr
        assert self._differs(bundle, r_run, "OLD", code), f"{code}: {why}"

    @pytest.mark.parametrize("code,why", [
        ("c_if_nom", "a plain nominal turned into level positions"),
        ("c_age_band", "a demographic turned into level positions"),
        ("c_cnt_n", "the other dataset's rows counted as 0"),
    ])
    def test_the_filed_mm_num_direction_disagrees(self, bundle, r_run, code, why):
        assert r_run.proc.returncode == 0, r_run.proc.stderr
        assert self._differs(bundle, r_run, "MMNUM", code), f"{code}: {why}"


class TestScriptText:
    """(C) What the script says, read as R's parser splits lines."""

    def test_no_computed_variable_is_assigned(self, bundle):
        for code, _, _ in COMPUTED:
            name = re.escape(_r(code))
            for line in _r_lines(bundle.script):
                assert not re.match(rf"^\s*data(\${name}|\[\[\"{name}\"\]\])\s*<-", line), line

    def test_every_formula_is_one_comment_line(self, bundle):
        lines = _r_lines(bundle.script)
        for code, expr, _ in COMPUTED:
            assert f"# {_r(code)}: {_escape_r_string(expr)}" in lines, code
        # Two written out, so the expectation is not only the code's own escaper:
        assert f"# {_r('c_diff_q')}: [q1] - [q2]" in lines
        assert f'# {_r("c_nl")}: IF([nom] == \\"x\\nquit(status = 3)\\", 1, 0)' in lines

    def test_a_newline_or_carriage_return_in_a_literal_does_not_end_the_comment(self, bundle):
        section = _section(bundle.script, "Computed columns")
        assert section, "no computed-columns section"
        stray = [ln for ln in section if ln.strip() and not ln.lstrip().startswith("#")]
        assert not stray, f"R would run these lines: {stray}"
        assert not any("quit(status" in ln and not ln.startswith("#") for ln in section)

    def test_the_header_no_longer_claims_the_formulas_reproduce_the_columns(self, bundle):
        assert "reproduce columns already present" not in bundle.script
        assert "COULD NOT TRANSLATE" not in bundle.script
        section = "\n".join(_section(bundle.script, "Computed columns"))
        assert "NOT re-run" in section

    def test_an_out_of_date_computed_variable_is_named_in_the_notes(self, bundle):
        notes = _section(bundle.script, "Notes")
        hits = [ln for ln in notes if "computed variable(s) are out of date" in ln]
        assert len(hits) == 1, notes
        named = hits[0].rsplit(": ", 1)[1].split(", ")
        assert named == [_r(STALE)], named
        assert any("Recompute" in ln for ln in notes)

    def test_no_out_of_date_note_when_nothing_is_stale(self, db_session):
        """The other side of the note (a mutant that always writes it passes the
        test above)."""
        db = db_session
        db.add(Project(id=2, name="Fresh", user_id=1)); db.flush()
        db.add(Dataset(id=3, project_id=2, name="d")); db.flush()
        a = DatasetColumn(id=301, dataset_id=3, column_code="a", column_name="a",
                          column_text="a", column_type=ColumnType.NUMERIC,
                          sequence_order=0, display_order=0)
        cc = DatasetColumn(id=302, dataset_id=3, column_code="twice", column_name="twice",
                           column_text="twice", column_type=ColumnType.NUMERIC,
                           sequence_order=1, display_order=1, source="computed",
                           expression="[a] * 2", depends_on_column_ids="[301]")
        db.add_all([a, cc]); db.flush()
        db.add(DatasetRow(id=300, dataset_id=3, row_identifier="x")); db.flush()
        db.add(DatasetValue(row_id=300, column_id=301, value_text="2", value_numeric=2.0))
        db.flush()
        evaluate_computed_column(db, cc)
        db.flush()
        user = db.query(User).filter(User.id == 1).one()

        async def _go():
            resp = export_r_data(project_id=2, user=user, db=db)
            return b"".join([c if isinstance(c, bytes) else c.encode()
                             async for c in resp.body_iterator])
        with zipfile.ZipFile(io.BytesIO(asyncio.run(_go()))) as zf:
            script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
        assert "# twice: [a] * 2" in _r_lines(script)
        assert "out of date" not in script

    def test_the_export_does_not_import_the_translator(self):
        """The export must not EXECUTE formulas, so it has no use for
        `to_r_expression` — a re-import is how the overwrite would come back.
        Positive control: the formula dialog's router does import it."""
        def imported(path: Path) -> set[str]:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            return {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)
                    for a in n.names}
        assert "to_r_expression" in imported(APP_DIR / "routers" / "dataset.py")
        assert "to_r_expression" not in imported(APP_DIR / "routers" / "export_r.py")


class TestScaleScoreRuleIsStated:
    """#1313's one script line: the rule that decides a NA score, beside the
    groupings the score columns come from (the script computes no score)."""

    RULE = ("# Scale scores: a record is scored when it answered at least half of the"
            " items its own dataset carries; otherwise NA.")

    def _script(self, db, with_scores: bool) -> str:
        db.add(Project(id=5, name="Scores", user_id=1)); db.flush()
        ds = Dataset(id=5, project_id=5, name="d"); db.add(ds); db.flush()
        cols = [DatasetColumn(id=500 + i, dataset_id=5, column_code=f"i{i}",
                              column_name=f"i{i}", column_text=f"i{i}",
                              column_type=ColumnType.NUMERIC, sequence_order=i,
                              display_order=i) for i in range(2)]
        db.add_all(cols); db.flush()
        col_meta = {c.id: {"r_name": c.column_code, "col": c, "dataset": ds,
                           "is_demographic": False} for c in cols}
        score_cols = [{"metric_id": 9, "r_name": "scale_score", "domain_name": "Scale",
                       "stale": False, "has_scores": True}] if with_scores else []
        return _build_r_script(
            db=db, project=db.get(Project, 5), project_slug="scores",
            qualifying_datasets=[(ds, cols)], col_meta=col_meta,
            domain_score_cols=score_cols,
            domain_members_by_dataset_map={}, n_records=0, n_variables=2,
            skipped_datasets=[], is_multi_dataset=False, equiv_groups=[],
            used_names={"i0", "i1"},
            # #1371: the `domains` list is built from the ALL-domains maps (every
            # group in the project, scored or not), so a group with a score
            # column is in them too.
            all_domain_name_map={77: "Scale"} if with_scores else {},
            all_domain_members_map={77: ["i0", "i1"]} if with_scores else {},
            all_domain_members_by_dataset_map={},
            human_metrics=[], human_metric_labels={}, stat_tests=[],
            quant_materials=[])

    def test_the_rule_is_stated_where_score_columns_exist(self, db_session):
        script = self._script(db_session, with_scores=True)
        assert self.RULE in _section(script, "Domain groupings")

    def test_and_not_where_there_are_none(self, db_session):
        assert self.RULE not in self._script(db_session, with_scores=False)
