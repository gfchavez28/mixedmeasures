"""#1468 — sourcing an exported R script runs no R code that arrived as DATA.

The R export writes user text and saved-chart settings into a script the
researcher runs with their own privileges, and R has `system()`. Every value
that reaches the script is either escaped (`_escape_r_string`), an R name
(`_make_r_identifier` and its family), a number (`_r_number`), or one of a
fixed vocabulary. Before #1468 a newline in a dataset, code or category name
ended a `#` comment so the next line RAN, and a string in a saved chart's
`formatting` or `proportion_config` closed a call and started a new statement.
The 1.5.8 pre-implementation review found three more doors the audit had not
listed: `corr_type` inside a quoted `method = "…"`, and the `compare_by` /
`cross_tab_column_id` ids written into a "Skipped" comment.

Two guards, because each sees what the other cannot:

* **The census** (`TestEveryInterpolationIsClassified`) walks `export_r.py`'s
  AST and fails on any interpolation it cannot classify. It sees a NEW site the
  day it is written. It cannot see a mis-classified binding: it keys on the
  expression's text, not on where the value came from.
* **The behavioural arms** (`TestAHostileValueRunsNothing`) plant a payload
  where each formerly raw site reads it, SOURCE the real script in R, and assert
  that nothing was planted and the script ran to the end. Each arm has a
  CONTROL that proves the fixture reaches the emitter line it is about.
  `TestEveryTextFieldAtOnce` plants a payload in every user-text field the
  export reads at the same time.
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import ast
import asyncio
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.code import Code
from app.models.code_category import CodeCategory
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.equivalence_group import EquivalenceGroup
from app.models.materials import Material
from app.models.project import Project
from app.models.user import User
from app.services.metrics import VALID_OPERATORS, create_scale_score_metric
from tests import r_support
from tests.test_export_r_score_names import _build, _zip

PWN = "PWNED"
EXPORT_R = Path(__file__).resolve().parents[1] / "app" / "routers" / "export_r.py"


# ── Running the real script ──────────────────────────────────────────────────

_RUNNER = r'''
res <- tryCatch({
  invisible(capture.output(suppressWarnings(suppressMessages(
    source("__SETUP__", echo = FALSE)))))
  "COMPLETED"
}, error = function(e) paste("HALTED:", conditionMessage(e)))
cat("RESULT", res, "\n")
'''


def _source(db, pid):
    """Export project `pid`, SOURCE the script in R, and report what happened.

    Returns `(completed, planted, script, output)`: whether `source()` reached
    the end, the `PWNED*` files R wrote, the script text, and R's output. A
    halt is reported rather than raised, so a payload that runs and THEN stops
    the script still shows as planted.
    """
    user = db.query(User).filter(User.id == 1).one()
    raw = asyncio.run(_zip(pid, user, db))
    with tempfile.TemporaryDirectory() as d:
        w = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(w)
            setup = next(n for n in zf.namelist() if n.endswith(".R"))
        script = (w / setup).read_text(encoding="utf-8")
        (w / "run.R").write_text(_RUNNER.replace("__SETUP__", setup), encoding="utf-8")
        p = subprocess.run([r_support.RSCRIPT, "run.R"], cwd=str(w),
                           capture_output=True, text=True, timeout=300)
        planted = sorted(f.name for f in w.iterdir() if f.name.startswith(PWN))
    output = p.stdout + p.stderr
    return "RESULT COMPLETED" in p.stdout, planted, script, output


def _comment(tag: str) -> str:
    """A payload for a `#` comment: the newline ends it and the next line runs."""
    return f'x\nwriteLines("1", "{PWN}_{tag}")\n#'


def _material(db, pid, mid, mtype, tab, config, name="chart"):
    db.add(Material(id=pid * 10 + 250 + mid, collection_id=pid * 10 + 7,
                    material_type=mtype, config=json.dumps(config),
                    auto_name=name, source_tab=tab, display_order=50 + mid))
    db.flush()


# ── One builder per formerly raw site ────────────────────────────────────────
# Each takes (db, pid, value) and puts `value` where that site reads it. The
# columns come from `_build`: grp, grp2 (nominal), then i1, i2 (numeric).


def _base(db, pid):
    col_ids, _doms, _tests = _build(db, pid, domains=[], extra_cols=["i1", "i2"])
    return col_ids


def _chart(mtype, metric_type, **formatting):
    def build(db, pid, value):
        col_ids = _base(db, pid)
        fmt = {k: (value if v is ... else v) for k, v in formatting.items()}
        _material(db, pid, 1, mtype, "descriptives",
                  {"metric_type": metric_type, "column_ids": [col_ids["i1"]],
                   "formatting": fmt})
    return build


def _metric_type_on(mtype):
    def build(db, pid, value):
        col_ids = _base(db, pid)
        _material(db, pid, 1, mtype, "descriptives",
                  {"metric_type": value, "column_ids": [col_ids["i1"]]})
    return build


def _proportion(key):
    def build(db, pid, value):
        col_ids = _base(db, pid)
        cfg = {"mode": "numeric", "operator": ">=", "threshold_numeric": 4}
        cfg[key] = value
        _material(db, pid, 1, "summary_table", "descriptives",
                  {"metric_type": "proportion", "column_ids": [col_ids["i1"]],
                   "proportion_config": cfg})
    return build


def _correlation(db, pid, value):
    col_ids = _base(db, pid)
    _material(db, pid, 1, "correlation_table", "correlations",
              {"column_ids": [col_ids["i1"], col_ids["i2"]], "corr_type": value})


def _comparison_by(db, pid, value):
    col_ids = _base(db, pid)
    _material(db, pid, 1, "comparison_table", "comparisons",
              {"column_ids": [col_ids["i1"]], "compare_by": value})


def _cross_tab(db, pid, value):
    col_ids = _base(db, pid)
    _material(db, pid, 1, "cross_tab_table", "descriptives",
              {"column_ids": [col_ids["grp"]], "cross_tab_column_id": value})


def _code(kind):
    def build(db, pid, value):
        _base(db, pid)
        cat_id = None
        if kind in ("category", "categorised"):
            cat = CodeCategory(project_id=pid, name=value if kind == "category" else "Cat")
            db.add(cat)
            db.flush()
            cat_id = cat.id
        db.add(Code(project_id=pid, numeric_id=2,
                    name="Plain" if kind == "category" else value,
                    category_id=cat_id, is_universal=(kind == "universal")))
        db.flush()
    return build


def _subset_comment(db, pid, value):
    """A cross-dataset variable group with a scale score: its aggregate prints
    one `# <dataset> subset` block per dataset (`_emit_domain_aggregate_r_lines`)."""
    db.add(Project(id=pid, name=f"Subset {pid}", user_id=1))
    db.flush()
    egs = [EquivalenceGroup(id=pid * 10 + k, project_id=pid, label=f"q{k}") for k in (1, 2)]
    db.add_all(egs)
    db.flush()
    cid, rid, vid, members = pid * 100, pid * 1000, pid * 10000, []
    for k, dname in enumerate(["wave1", value]):
        dsid = pid * 10 + 5 + k
        db.add(Dataset(id=dsid, project_id=pid, name=dname))
        db.flush()
        for j, eg in enumerate(egs):
            cid += 1
            db.add(DatasetColumn(id=cid, dataset_id=dsid, column_code=f"q{j + 1}",
                                 column_name=f"q{j + 1}", column_text=f"q{j + 1}",
                                 column_type="numeric", sequence_order=j, display_order=j,
                                 equivalence_group_id=eg.id))
            members.append(cid)
        db.flush()
        for r in range(6):
            rid += 1
            db.add(DatasetRow(id=rid, dataset_id=dsid))
            db.flush()
            for j in range(2):
                vid += 1
                v = float((r + j + k) % 5 + 1)
                db.add(DatasetValue(id=vid, row_id=rid, column_id=members[k * 2 + j],
                                    value_text=f"{v:g}", value_numeric=v))
        db.flush()
    dom = AnalysisDomain(id=pid * 10 + 9, project_id=pid, name="Scale", sequence_order=0)
    db.add(dom)
    db.flush()
    for i, c in enumerate(members):
        db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column",
                                    member_id=c, sequence_order=i))
    db.flush()
    _m, ok = create_scale_score_metric(db, dom)
    assert ok


# (id, builder, hostile value, control value, regex the CONTROL must emit)
SITES = [
    ("dataset_subset_comment", _subset_comment, _comment("ds"), "wave2",
     r"^# wave2 subset$"),
    ("code_name_uncategorised", _code("uncategorised"), _comment("code"), "Theme",
     r"^#       - Theme \(0 uses\)$"),
    ("code_name_universal", _code("universal"), _comment("univ"), "Theme",
     r"^#       - Theme \(0 uses\)$"),
    ("code_name_categorised", _code("categorised"), _comment("ccode"), "Theme",
     r"^#       - Theme \(0 uses\)$"),
    ("category_name", _code("category"), _comment("cat"), "Feelings",
     r"^#   Feelings \(0 uses\)$"),
    # `source()` reads a lone CR as a line end (measured, R 4.3.3) — the reason
    # `_escape_r_string` drops it.
    ("code_name_carriage_return", _code("uncategorised"),
     f'x\rwriteLines("1", "{PWN}_cr")\r#', "Theme", r"^#       - Theme \(0 uses\)$"),
    ("metric_type_line_comment", _metric_type_on("line"), _comment("mtline"), "proportion",
     r"^# Line chart for metric_type 'proportion' not plotted"),
    ("metric_type_unsupported_comment", _metric_type_on("heatmap"), _comment("mtelse"), "mean",
     r"^# Chart type 'heatmap' with metric_type 'mean' not yet supported"),
    ("compare_by_comment", _comparison_by, _comment("cmp"), 987654,
     r"^# Skipped comparison: grouping column 987654 not found$"),
    ("cross_tab_id_comment", _cross_tab, _comment("xtab"), 987654,
     r"^# Skipped cross-tab: column IDs \d+/987654 not found$"),
    ("corr_type", _correlation,
     f'pearson"); writeLines("1", "{PWN}_corr"); cor(1:3, 1:3, method = "pearson',
     "spearman", r'method = "spearman"\)$'),
    ("proportion_operator", _proportion("operator"),
     f'>= 0); writeLines("1", "{PWN}_op"); sum(0 +', "<=",
     r"^count_meeting <- sum\(i1_valid <= 4\)$"),
    ("proportion_threshold", _proportion("threshold_numeric"),
     f'4); writeLines("1", "{PWN}_thr"); (1', 3,
     r"^count_meeting <- sum\(i1_valid >= 3\)$"),
    ("axis_font_size", _chart("vertical_bar", "frequency_distribution", axisFontSize=...),
     f'12); writeLines("1", "{PWN}_axis"); invisible(1', 13,
     r"^  theme_minimal\(base_size = 13\)$"),
    ("point_size", _chart("line", "mean", pointSize=...),
     f'5); writeLines("1", "{PWN}_pt"); list(1', 6,
     r"^  geom_point\(size = 6, color = mm_default_colors\[1\]\) \+$"),
    ("reference_line", _chart("line", "mean", referenceLine=...),
     f'1); writeLines("1", "{PWN}_ref"); list(1', 2.5,
     r"^  geom_hline\(yintercept = 2\.5,"),
    ("axis_min", _chart("vertical_bar", "mean", xAxisMin=...),
     f'0, NA)); writeLines("1", "{PWN}_xmin"); list(c(0', 0,
     r"^  scale_y_continuous\(limits = c\(0, NA\)\) \+$"),
    ("axis_max", _chart("vertical_bar", "mean", xAxisMax=...),
     f'10)); writeLines("1", "{PWN}_xmax"); list(c(10', 10,
     r"^  scale_y_continuous\(limits = c\(NA, 10\)\) \+$"),
]

# Not code, but the same seam: a non-finite number from a hand-edited file
# (Python's json reads NaN and Infinity) halted the script at the line that
# printed it — `base_size = nan` is an R symbol that does not exist.
NON_FINITE = [
    ("axis_font_size_nan", _chart("vertical_bar", "frequency_distribution",
                                  axisFontSize=...), float("nan")),
    ("reference_line_inf", _chart("line", "mean", referenceLine=...), float("inf")),
    ("bar_size_nan", _chart("vertical_bar", "frequency_distribution", barSize=...),
     float("nan")),
    ("point_size_true", _chart("line", "mean", pointSize=...), True),
]


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestAHostileValueRunsNothing:
    @pytest.mark.parametrize("site,build,hostile,control,pattern", SITES,
                             ids=[s[0] for s in SITES])
    def test_the_hostile_value_runs_nothing(self, db_session, site, build, hostile,
                                            control, pattern):
        build(db_session, 9400 + [s[0] for s in SITES].index(site), hostile)
        completed, planted, script, output = _source(
            db_session, 9400 + [s[0] for s in SITES].index(site))
        assert planted == [], f"{site}: R ran code from the project: {planted}"
        assert completed, f"{site}: the script did not run to the end:\n{output}"

    @pytest.mark.parametrize("site,build,hostile,control,pattern", SITES,
                             ids=[s[0] for s in SITES])
    def test_the_control_reaches_the_line(self, db_session, site, build, hostile,
                                          control, pattern):
        """The positive control: the fixture reaches the emitter line the hostile
        arm is about, so a clean hostile arm is evidence and not a miss."""
        pid = 9500 + [s[0] for s in SITES].index(site)
        build(db_session, pid, control)
        completed, planted, script, output = _source(db_session, pid)
        assert re.search(pattern, script, re.M), f"{site}: no line matches {pattern!r}"
        assert planted == [] and completed, output

    @pytest.mark.parametrize("site,build,value", NON_FINITE, ids=[s[0] for s in NON_FINITE])
    def test_a_non_number_is_left_out_and_the_script_runs(self, db_session, site,
                                                          build, value):
        pid = 9600 + [s[0] for s in NON_FINITE].index(site)
        build(db_session, pid, value)
        completed, planted, script, output = _source(db_session, pid)
        assert completed, f"{site}: the script stopped:\n{output}"
        assert not re.search(r"\b(nan|inf|True)\b", script.split("# ---- Charts ----")[-1])

    def test_a_nul_in_a_title_does_not_stop_the_script(self, db_session):
        """`source()` refuses a whole file over one NUL (`embedded nul in
        string`) — nothing runs, not even the lines before it."""
        pid = 9690
        col_ids = _base(db_session, pid)
        _material(db_session, pid, 1, "vertical_bar", "descriptives",
                  {"metric_type": "frequency_distribution", "column_ids": [col_ids["i1"]],
                   "title": "Wave\x00one"})
        completed, planted, script, output = _source(db_session, pid)
        assert 'title = "Waveone"' in script
        assert completed, output


# ── Every user-text field at once ────────────────────────────────────────────


def _everywhere(tag: str) -> str:
    """Both shapes at once: a quote that would close a string literal, and a
    newline that would end a comment."""
    return (f'{tag}"); writeLines("1", "{PWN}_{tag}"); ("'
            f'\nwriteLines("1", "{PWN}_{tag}")\n#')


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestEveryTextFieldAtOnce:
    PID = 9700

    def _build_hostile(self, db):
        pid = self.PID
        col_ids, dom_ids, _ = _build(
            db, pid, domains=[{"name": _everywhere("dom"), "items": ["i1", "i2"]}],
            extra_cols=["i1", "i2"], ds_name=_everywhere("ds"))
        project = db.get(Project, pid)
        project.name = _everywhere("proj")
        for code in ("grp", "i1"):
            db.get(DatasetColumn, col_ids[code]).column_text = _everywhere(f"label{code}")
        # A nominal answer becomes a factor level.
        db.query(DatasetValue).filter(DatasetValue.column_id == col_ids["grp"],
                                      DatasetValue.value_text == "A").update(
            {"value_text": _everywhere("level")})
        cat = CodeCategory(project_id=pid, name=_everywhere("cat"))
        db.add(cat)
        db.flush()
        db.add_all([
            Code(project_id=pid, numeric_id=2, name=_everywhere("code"), category_id=cat.id),
            Code(project_id=pid, numeric_id=3, name=_everywhere("uncat")),
            Code(project_id=pid, numeric_id=0, name=_everywhere("univ"), is_universal=True),
        ])
        texts = {"title": _everywhere("title"), "subtitle": _everywhere("sub"),
                 "footnote": _everywhere("foot"),
                 "hiddenResponseOptions": [_everywhere("hid")],
                 "exclude_values": [_everywhere("exv")]}
        hostile_fmt = {"axisFontSize": "x", "pointSize": "x", "referenceLine": "x",
                       "xAxisMin": "x", "xAxisMax": "x", "barSize": "x"}
        i1 = [col_ids["i1"]]
        for k, (mtype, cfg) in enumerate([
            ("vertical_bar", {"metric_type": "frequency_distribution", "column_ids": i1}),
            ("vertical_bar", {"metric_type": "mean", "column_ids": i1}),
            ("heatmap", {"metric_type": "frequency_distribution", "column_ids": i1}),
            ("stacked_bar", {"metric_type": "frequency_distribution", "column_ids": i1}),
            ("line", {"metric_type": "mean", "column_ids": i1}),
            ("dumbbell", {"metric_type": "mean", "column_ids": i1,
                          "grouping_column_id": col_ids["grp"]}),
            ("line", {"metric_type": _everywhere("mt"), "column_ids": i1}),
            ("summary_table", {"metric_type": "proportion", "column_ids": i1,
                               "proportion_config": {"mode": "numeric",
                                                     "operator": _everywhere("op"),
                                                     "threshold_numeric": "x"}}),
            ("summary_table", {"metric_type": "proportion", "column_ids": [col_ids["grp"]],
                               "proportion_config": {"mode": "values",
                                                     "threshold_values": [_everywhere("tv")]}}),
        ]):
            _material(db, pid, k, mtype, "descriptives",
                      {**cfg, **texts, "formatting": hostile_fmt},
                      name=_everywhere(f"name{k}"))
        _material(db, pid, 20, "correlation_matrix", "correlations",
                  {"column_ids": [col_ids["i1"], col_ids["i2"]],
                   "corr_type": _everywhere("corr"), "title": _everywhere("ctitle")})
        _material(db, pid, 21, "comparison_table", "comparisons",
                  {"column_ids": i1, "compare_by": col_ids["grp"],
                   "exclude_groups": [_everywhere("exg")]})
        _material(db, pid, 22, "comparison_table", "comparisons",
                  {"column_ids": i1, "compare_by": _everywhere("cmp")})
        _material(db, pid, 23, "cross_tab_table", "descriptives",
                  {"column_ids": [col_ids["grp"]],
                   "cross_tab_column_id": _everywhere("xtab")})
        db.flush()
        return pid

    def test_nothing_runs_and_the_script_completes(self, db_session):
        pid = self._build_hostile(db_session)
        completed, planted, script, output = _source(db_session, pid)
        assert planted == [], planted
        assert completed, output
        # The positive control: the hostile text reached the script. Every
        # planted tag must appear in it — escaped, or as an inert comment.
        for tag in ("proj", "ds", "dom", "labelgrp", "labeli1", "level", "cat", "code",
                    "uncat", "univ", "title", "sub", "foot", "hid", "exv", "mt", "tv",
                    "ctitle", "exg", "cmp", "xtab", "name0"):
            assert f"{PWN}_{tag}" in script, f"the {tag!r} payload never reached the script"


# ── The census ───────────────────────────────────────────────────────────────

ESCAPED = "escaped"           # through _escape_r_string
IDENT = "identifier"          # an R name: [a-z0-9_] from the slug family
NUMBER = "number"             # a real number by construction
VOCAB = "vocabulary"          # one of a fixed set the code chose
COMPOSED = "composed"         # an R fragment built from census-classified parts
NOT_SCRIPT = "not script"     # a CSV cell, a file name or a header — never in the .R

# An interpolation whose expression is a call to one of these is classified by
# the call: the function decides the value's shape.
SAFE_CALLS = {
    "_escape_r_string": ESCAPED,
    "_make_r_identifier": IDENT, "_unique_r_name": IDENT, "_slugify": IDENT,
    "_dataset_r_prefix": IDENT, "_score_column_base": IDENT,
    "_r_number": NUMBER,
    "_numeric_vector_r": COMPOSED, "_text_vector_r": COMPOSED,
}

_R_NAMES = "an R name from col_meta / domain_key_by_id / score_col_by_domain, built by the slug family"
_PARTS = "joined from f-strings this census classifies one by one"

# (function, expression) -> (class, reason). An expression NOT in this table and
# not a SAFE_CALLS call is a new interpolation: decide it, then add it here.
CLASSIFIED = {
    ("_unique_r_name", "base"): (IDENT, "the caller's slug"),
    ("_unique_r_name", "counter"): (NUMBER, "a loop counter"),
    **{("_numeric_vector_r", "r_name"): (IDENT, _R_NAMES),
       ("_text_vector_r", "r_name"): (IDENT, _R_NAMES)},
    ("_emit_domain_aggregate_r_lines", "r_name_for_full_set"): (IDENT, "`domains$<key>`"),
    ("_emit_domain_aggregate_r_lines", "n"): (IDENT, _R_NAMES),
    ("_emit_domain_aggregate_r_lines", "slug"): (IDENT, "_dataset_r_prefix"),
    ("_emit_domain_aggregate_r_lines", "ds_name_escaped"): (ESCAPED, "_escape_r_string one line up"),
    ("_emit_domain_aggregate_r_lines", "members_str"): (COMPOSED, _PARTS),
    ("_levels_literal", "_escape_r_string(str(v))"): (ESCAPED, "auto"),
    ("_build_r_script", 'now_utc.strftime("%Y-%m-%d %H:%M UTC")'): (VOCAB, "a timestamp"),
    ("_build_r_script", "n_records"): (NUMBER, "a row count"),
    ("_build_r_script", "n_variables"): (NUMBER, "a header length"),
    ("_build_r_script", "project_slug"): (IDENT, "_slugify(project.name)"),
    ("_build_r_script", "char_spec"): (COMPOSED, _PARTS),
    ("_build_r_script", "id_names"): (COMPOSED, "identifier columns' R names, joined"),
    ("_build_r_script", "r_name"): (IDENT, _R_NAMES + ", or `domains$<key>`"),
    ("_build_r_script", "lo"): (NUMBER, "a reverse scale's bound, or an axis limit through _r_number"),
    ("_build_r_script", "sm"): (NUMBER, "a reverse scale's bound (mapping_numeric_values)"),
    ("_build_r_script", "hi"): (NUMBER, "an axis limit through _r_number, or NA"),
    ("_build_r_script", "levels_str"): (COMPOSED, "_levels_literal or escaped levels"),
    ("_build_r_script", "labels_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "comma"): (VOCAB, "',' or ''"),
    ("_build_r_script", "entry_name"): (IDENT, _R_NAMES),
    ("_build_r_script", "vals_str"): (COMPOSED, "registered codes (numbers or NA), or escaped values"),
    ("_build_r_script", "col_meta[cid]['r_name']"): (IDENT, _R_NAMES),
    ("_build_r_script", "cc_meta['r_name']"): (IDENT, _R_NAMES),
    ("_build_r_script", "n"): (IDENT, _R_NAMES),
    ("_build_r_script", "_key"): (IDENT, "domain_key_by_id"),
    ("_build_r_script", "members_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "eq_slug"): (IDENT, "_make_r_identifier"),
    ("_build_r_script", "col_name"): (IDENT, "excluded_values_map's keys are R names"),
    ("_build_r_script", "domain_key_by_id[did]"): (IDENT, _R_NAMES),
    ("_build_r_script", "domain_key_by_id[hm.input_source_id]"): (IDENT, _R_NAMES),
    ("_build_r_script", "grp_r"): (IDENT, _R_NAMES),
    ("_build_r_script", "grp2_r"): (IDENT, _R_NAMES),
    ("_build_r_script", "freq_src"): (COMPOSED, "_text_vector_r"),
    ("_build_r_script", "grp_expr"): (COMPOSED, "R names, or `dataset`"),
    ("_build_r_script", "mean_src"): (COMPOSED, "_numeric_vector_r"),
    ("_build_r_script", "prop_src"): (COMPOSED, "_numeric_vector_r / _text_vector_r"),
    ("_build_r_script", "valid_obj"): (IDENT, "an R name + `_valid`"),
    ("_build_r_script", "r_op"): (VOCAB, "_R_PROPORTION_OPERATORS, keyed on metrics.VALID_OPERATORS"),
    ("_build_r_script", "thresh"): (NUMBER, "_r_number, or the analysis is skipped"),
    ("_build_r_script", "hm_src"): (COMPOSED, "_numeric_vector_r"),
    ("_build_r_script", "dom_slug"): (IDENT, "domain_key_by_id or _make_r_identifier"),
    ("_build_r_script", "label"): (VOCAB, "Cronbach's alpha / Split-half reliability"),
    ("_build_r_script", "frame"): (IDENT, "dom_slug + `_items`"),
    ("_build_r_script", "c"): (IDENT, _R_NAMES),
    ("_build_r_script", "cols_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "i"): (NUMBER, "enumerate"),
    ("_build_r_script", "st.test_type"): (VOCAB, "only inside a branch that tested it against a literal"),
    ("_build_r_script", "tm_r"): (IDENT, _R_NAMES),
    ("_build_r_script", "tm_grp_r"): (IDENT, _R_NAMES),
    ("_build_r_script", "v"): (IDENT, _R_NAMES),
    ("_build_r_script", "vars_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "corr_method"): (VOCAB, "'spearman' or 'pearson', the service's own rule"),
    ("_build_r_script", "len(var_r_names) * (len(var_r_names) - 1) // 2"): (NUMBER, "arithmetic on a length"),
    ("_build_r_script", "', '.join(heat_labs)"): (COMPOSED, _PARTS),
    ("_build_r_script", "corr_slug"): (IDENT, "_slugify"),
    ("_build_r_script", "excl_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "vr"): (IDENT, _R_NAMES),
    ("_build_r_script", "data_ref"): (VOCAB, "`data` or `comp_data`"),
    ("_build_r_script", "n_groups"): (NUMBER, "len()"),
    ("_build_r_script", "t_ref"): (IDENT, "`tt_data_` + an R name, or data_ref"),
    ("_build_r_script", "pair"): (COMPOSED, _PARTS),
    ("_build_r_script", "aov_obj"): (IDENT, "two R names"),
    ("_build_r_script", "col_r"): (IDENT, _R_NAMES),
    ("_build_r_script", "row_r"): (IDENT, _R_NAMES),
    ("_build_r_script", "hr_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "high_color"): (VOCAB, "_HEATMAP_GRADIENT_HIGH, with a default"),
    ("_build_r_script", "fill_scale"): (VOCAB, "two literals"),
    ("_build_r_script", "', '.join(labs_parts)"): (COMPOSED, _PARTS),
    ("_build_r_script", "base_size"): (NUMBER, "_r_number, default 12"),
    ("_build_r_script", "slug"): (IDENT, "_slugify"),
    ("_build_r_script", "cr"): (IDENT, _R_NAMES),
    ("_build_r_script", "point_size"): (NUMBER, "_r_number, default 5"),
    ("_build_r_script", "ref_line"): (NUMBER, "_r_number; None leaves the line out"),
    ("_build_r_script", "tr_name"): (IDENT, _R_NAMES),
    ("_build_r_script", "var_name"): (IDENT, "`ch_` + _slugify"),
    ("_build_r_script", "ev_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "co_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "aes_x"): (COMPOSED, "literals, or reorder() over an R name"),
    ("_build_r_script", "bar_size / 30"): (NUMBER, "_r_number-checked, formatted :.2f"),
    ("_build_r_script", "cap"): (COMPOSED, "the escaped footnote and a literal"),
    ("_build_r_script", "m"): (IDENT, _R_NAMES),
    ("_build_r_script", "y_field"): (VOCAB, "count / pct"),
    ("_build_r_script", "y_label"): (VOCAB, "two literals"),
    ("_build_r_script", "chart_type"): (VOCAB, "only for a type in _VISUAL_CHART_TYPES"),
    ("_build_r_script", "ds_ts"): (VOCAB, "a date"),
    ("_build_r_script", "cid"): (NUMBER, "users.id (INTEGER PRIMARY KEY)"),
    ("_build_r_script", "coder_cols_r"): (COMPOSED, _PARTS),
    ("_build_r_script", "p"): (VOCAB, "required_packages, all literals"),
    ("_build_r_script", "pkgs_str"): (COMPOSED, _PARTS),
    ("_build_r_script", "na_blanked_count"): (NUMBER, "a counter"),
    ("_build_r_script", "sec_name"): (VOCAB, "toc_sections, all literals"),
    ("write_category_tree", "indent"): (VOCAB, "spaces"),
    ("write_category_tree", "cat_total"): (NUMBER, "a sum of COUNTs"),
    ("write_category_tree", "uses"): (NUMBER, "a COUNT"),
    ("_build_r_script", "uses"): (NUMBER, "a COUNT"),
    ("export_r_data", "ds_slug"): (NOT_SCRIPT, "an R name / a CSV cell"),
    ("export_r_data", "base"): (NOT_SCRIPT, "an R name, built by the slug family"),
    ("export_r_data", "m.input_source_id"): (NOT_SCRIPT, "slugified by _score_column_base"),
    ("export_r_data", "fallback_counters[row_obj.dataset_id]"): (NOT_SCRIPT, "a CSV cell"),
    ("export_r_data", "cid"): (NOT_SCRIPT, "a CSV header"),
    ("export_r_data", "project_slug"): (NOT_SCRIPT, "a zip member name"),
    ("export_r_data", "date_str"): (NOT_SCRIPT, "a file name"),
    ("export_r_data", "filename"): (NOT_SCRIPT, "the Content-Disposition header"),
}


def interpolations(source: str) -> list[tuple[str, str, int]]:
    """Every `{…}` in every f-string, as (enclosing function, expression, line)."""
    tree = ast.parse(source)
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def function_of(node):
        while node in parents:
            node = parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return node.name
        return "<module>"

    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            for value in node.values:
                if isinstance(value, ast.FormattedValue):
                    found.append((function_of(node),
                                  ast.get_source_segment(source, value.value),
                                  value.lineno))
    return found


def classify(func: str, expr: str) -> str | None:
    node = ast.parse(expr, mode="eval").body
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
            and node.func.id in SAFE_CALLS:
        return SAFE_CALLS[node.func.id]
    if isinstance(node, ast.Name) and node.id.isupper():
        return VOCAB  # a module constant
    entry = CLASSIFIED.get((func, expr))
    return entry[0] if entry else None


class TestEveryInterpolationIsClassified:
    def test_the_walk_finds_the_emitter(self):
        found = interpolations(EXPORT_R.read_text(encoding="utf-8"))
        # Measured at 373 when the census was written; a walk that finds a
        # fraction of that has gone blind, not clean.
        assert len(found) > 300, len(found)
        assert {f for f, _, _ in found} >= {"_build_r_script", "export_r_data",
                                            "_emit_domain_aggregate_r_lines"}

    def test_every_interpolation_is_classified(self):
        found = interpolations(EXPORT_R.read_text(encoding="utf-8"))
        unknown = sorted({(f, e, ln) for f, e, ln in found if classify(f, e) is None},
                         key=lambda t: t[2])
        assert not unknown, (
            "export_r.py interpolates values the #1468 census has not classified. "
            "Route user text through _escape_r_string, a config number through "
            "_r_number, a choice through a fixed vocabulary — then add the "
            "expression to CLASSIFIED with its reason:\n"
            + "\n".join(f"  :{ln} {f}: {{{e}}}" for f, e, ln in unknown))

    def test_no_classification_names_an_expression_that_is_gone(self):
        found = {(f, e) for f, e, _ in interpolations(EXPORT_R.read_text(encoding="utf-8"))}
        stale = sorted(set(CLASSIFIED) - found)
        assert not stale, stale

    def test_the_census_reports_a_raw_interpolation(self):
        """The predicate falsifier: the shape #1468 was is reported."""
        planted = (
            "def _build_r_script(code):\n"
            "    lines.append(f'#       - {code.name} (3 uses)')\n"
            "    lines.append(f'  theme_minimal(base_size = {_r_number(x) or 12})')\n"
            "    lines.append(f'# {_escape_r_string(code.name)}')\n"
        )
        found = interpolations(planted)
        unknown = [e for f, e, _ in found if classify(f, e) is None]
        assert unknown == ["code.name", "_r_number(x) or 12"]


# The census keys on an expression's TEXT, so `{base_size}` reads the same
# whether `base_size` holds a checked number or the raw setting — which is
# exactly what #1468 was. These names are interpolated into live code, so
# every assignment to them is pinned to the helper that makes them safe.
BOUND = {
    "base_size": r"_r_number\(",
    "bar_size": r"float\(_r_number\(",
    "point_size": r"_r_number\(",
    "ref_line": r"_r_number\(",
    "x_min": r"_r_number\(",
    "x_max": r"_r_number\(",
    "thresh": r"_r_number\(",
    "r_op": r"_R_PROPORTION_OPERATORS\.get\(",
    "corr_method": r'"spearman" if .* else "pearson"$',
}


def bindings(source: str, function: str) -> dict[str, list[str]]:
    """Every value assigned to a BOUND name inside `function`, as source text."""
    tree = ast.parse(source)
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == function)
    out: dict[str, list[str]] = {name: [] for name in BOUND}
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in BOUND:
                    out[target.id].append(ast.get_source_segment(source, node.value))
    return out


class TestALiveCodeNumberIsBoundThroughItsHelper:
    def test_every_binding_goes_through_the_helper(self):
        found = bindings(EXPORT_R.read_text(encoding="utf-8"), "_build_r_script")
        assert all(found.values()), {k: v for k, v in found.items() if not v}
        wrong = {name: values for name, values in found.items()
                 if not all(re.match(BOUND[name], v, re.S) for v in values)}
        assert not wrong, f"a live-code value is bound without its helper (#1468): {wrong}"

    def test_the_check_reports_a_raw_binding(self):
        planted = ("def _build_r_script(fmt):\n"
                   "    base_size = fmt.get('axisFontSize', 12)\n")
        assert bindings(planted, "_build_r_script")["base_size"] == [
            "fmt.get('axisFontSize', 12)"]
        assert not re.match(BOUND["base_size"], "fmt.get('axisFontSize', 12)")


def test_the_operator_vocabulary_is_the_services():
    """`=` is the app's equality too (`metrics._compare`); in R it would name an
    argument — `sum(x_valid = 4)` is 4, not a count."""
    from app.routers.export_r import _R_PROPORTION_OPERATORS
    assert set(_R_PROPORTION_OPERATORS) == VALID_OPERATORS
    assert _R_PROPORTION_OPERATORS["="] == "=="
    assert all(op in {">", ">=", "<", "<=", "=="} for op in _R_PROPORTION_OPERATORS.values())
