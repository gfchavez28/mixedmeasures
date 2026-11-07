"""#1482 — an R reserved word as a name stops the exported script from parsing.

`_make_r_identifier` lowercases and keeps `[a-z0-9_]`, so of R's reserved words
(`?Reserved`, R 4.3.3) only the nine lowercase ones can come out of it — `if`
`else` `repeat` `while` `function` `for` `in` `next` `break`; `TRUE` … `NA_*`
are neutralised by the lowercasing and `...` / `..1` by dropping the dots.
Measured at 02c97c77: a variable group named *Function* gave
`domains <- list(function = …)` (`unexpected '='`), a column coded `next` gave
`attr(data$next, …)` (`unexpected 'next'`), and `source()` refused the WHOLE
script — not one line ran.

The fix suffixes `_` inside the name maker, so the CSV header and every script
line change together. `_dataset_r_prefix` is deliberately unchanged: it never
reaches R bare (always `<prefix>__<col>`, `<prefix>_subset`, `<prefix>_means`),
so a dataset named *Function* already parsed — the filed entry's second half.
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import csv
import io
import json
import re
import subprocess
import zipfile

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.materials import Material
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.models.user import User
from app.routers.export_r import (
    _R_RESERVED_WORDS, _dataset_r_prefix, _make_r_identifier,
)
from app.services.metrics import compute_metric, create_scale_score_metric
from app.services.statistical_tests import compute_statistical_test
from tests import r_support
from tests.test_export_r_score_names import _build, _cmp, _emitted, _run, _zip

# R's own list, `?Reserved` in R 4.3.3 (printed by
# `tools::Rd2txt(utils:::.getHelpFile(help("Reserved")))` during the review).
R_RESERVED = ["if", "else", "repeat", "while", "function", "for", "in", "next", "break",
              "TRUE", "FALSE", "NULL", "Inf", "NaN", "NA",
              "NA_integer_", "NA_real_", "NA_complex_", "NA_character_",
              "...", "..1", "..2"]

# Names a researcher can type that slugify ONTO a reserved word, plus the
# shapes the maker already handled (a digit first, nothing left).
HOSTILE = R_RESERVED + ["Function", "IF", "Next", "BREAK", "for!", " while ", "in-",
                        "Repeat.", "else?", "function_", "next 2", "2023", "", "…"]


def _r_lines(code: str) -> str:
    p = subprocess.run([r_support.RSCRIPT, "-e", code], capture_output=True, text=True,
                       timeout=120)
    assert p.returncode == 0, p.stderr
    return p.stdout


def test_the_module_list_is_rs_list():
    """Every non-dot word of `?Reserved` is in the module's set, and nothing else."""
    assert _R_RESERVED_WORDS == {w for w in R_RESERVED if not w.startswith(".")}


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_every_made_name_is_syntactic_in_r():
    """R's own definition of a syntactic name is the oracle: `make.names(x) == x`
    (it appends `.` to a reserved word). Every name the maker can produce from a
    hostile corpus must be one, and so must every composed prefix form."""
    names = sorted({_make_r_identifier(w) for w in HOSTILE})
    prefixed = sorted({f"{_dataset_r_prefix(w)}{tail}" for w in HOSTILE
                       for tail in ("__q1", "_subset", "_means")})
    vec = ", ".join(json.dumps(n) for n in names + prefixed)
    out = _r_lines(f"x <- c({vec}); bad <- x[make.names(x) != x]; "
                   f"cat('N', length(x), '\\n'); cat('BAD', bad, '\\n')")
    assert re.search(r"^N (\d+)", out, re.M).group(1) == str(len(names + prefixed))
    bad = re.search(r"^BAD(.*)$", out, re.M).group(1).split()
    assert bad == [], f"not syntactic in R: {bad}"


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_the_oracle_can_fail():
    """The predicate falsifier: `make.names` flags each of the nine words the
    maker emitted before the fix."""
    vec = ", ".join(json.dumps(w) for w in sorted(_R_RESERVED_WORDS))
    out = _r_lines(f"x <- c({vec}); cat('BAD', sum(make.names(x) != x), '\\n')")
    assert re.search(r"^BAD (\d+)", out, re.M).group(1) == str(len(_R_RESERVED_WORDS))


def test_a_suffixed_name_never_meets_a_real_one(db_session):
    """`function` and `function_` and `Function` in one dataset (and as group
    names) stay three names. `_slugify` strips a trailing `_`, so the suffixed
    form is not any real name's slug — the de-duplication pool decides."""
    db = db_session
    pid = 9771
    cols, doms, _ = _build(
        db, pid, domains=[{"name": "function", "items": ["a1", "a2"], "score": False},
                          {"name": "Function!", "items": ["a3", "a4"], "score": False},
                          {"name": "function_", "items": ["a1", "a3"], "score": False}],
        extra_cols=["b1", "b2", "b3"])
    for code, new in (("b1", "function"), ("b2", "function_"), ("b3", "Function ")):
        c = db.get(DatasetColumn, cols[code])
        c.column_code = c.column_name = new
    db.flush()
    user = db.query(User).filter(User.id == 1).one()
    with zipfile.ZipFile(io.BytesIO(asyncio.run(_zip(pid, user, db)))) as zf:
        data = zf.read(next(n for n in zf.namelist() if n.endswith("_data.csv")))
        script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
    header = next(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    assert len(header) == len(set(header))
    made = [h for h in header if h.startswith("function")]
    assert sorted(made) == ["function_", "function__2", "function__3"], header
    keys = re.findall(r"^  (\w+) = c\(", script.split("domains <- list(")[1], re.M)
    assert sorted(keys) == ["function_", "function__2", "function__3"], keys


def _material(db, pid, k, mtype, tab, cfg):
    db.add(Material(id=pid * 10 + 250 + k, collection_id=pid * 10 + 7, material_type=mtype,
                    config=json.dumps(cfg), auto_name=f"m{k}", source_tab=tab,
                    display_order=50 + k))


@pytest.mark.skipif(not r_support.HAS_PSYCH, reason=r_support.SKIP_REASON_PSYCH)
def test_reserved_names_source_and_reproduce_the_apps_numbers(db_session):
    """One project whose every name class is a reserved word — a grouping column
    `if`, items `next` `for` `while`, a nominal `else`, groups *Function* and
    *in* — through the site classes that read a name bare: `data$`, `list()`,
    dplyr `filter`/`group_by`/`count`/`summarise`, a formula, a composed object
    name (`aov_<v>_by_<g>`, `<group>_valid`, `<group>_items`)."""
    db = db_session
    pid = 9772
    cols, doms, _ = _build(
        db, pid,
        domains=[{"name": "Function", "items": ["i1", "i2", "i3"]},
                 {"name": "in", "items": ["j1", "j2"]}],
        extra_cols=["k1", "k2"],
        materials=[
            {"type": "comparison", "tab": "comparisons", "name": "cmp",
             "config": {"domain_names": ["Function"], "column_codes": ["i1"],
                        "compare_by_code": "grp"}},
            {"type": "domain_aggregate", "tab": "descriptives", "name": "in mean",
             "config": {"metric_type": "mean", "domain_names": ["in"]}},
            {"type": "correlation_matrix", "tab": "correlations", "name": "cor",
             "config": {"column_codes": ["k1", "k2"], "corr_type": "pearson"}},
        ])
    grp, grp2, i1 = cols["grp"], cols["grp2"], cols["i1"]
    _material(db, pid, 1, "summary_table", "descriptives",
              {"metric_type": "frequency_distribution", "column_ids": [grp2],
               "grouping_column_id": grp})
    _material(db, pid, 2, "summary_table", "descriptives",
              {"metric_type": "mean", "column_ids": [i1], "grouping_column_id": grp})
    _material(db, pid, 3, "summary_table", "descriptives",
              {"metric_type": "proportion", "domain_ids": [doms["Function"]],
               "proportion_config": {"mode": "numeric", "operator": ">=",
                                     "threshold_numeric": 4}})
    _material(db, pid, 4, "vertical_bar", "descriptives",
              {"metric_type": "mean", "column_ids": [i1], "grouping_column_id": grp})
    db.add(StatisticalTest(id=pid * 10 + 5, project_id=pid, test_type="cronbachs_alpha",
                           target_type="analysis_domain", target_id=doms["Function"],
                           config="{}", result_data="{}"))
    for code, new in (("grp", "if"), ("grp2", "else"), ("i1", "next"),
                      ("k1", "for"), ("k2", "while")):
        c = db.get(DatasetColumn, cols[code])
        c.column_code = c.column_name = new
    db.flush()

    app_F = (_cmp(db, pid, grp, doms=[doms["Function"]])[0], _cmp(db, pid, grp, cols=[i1])[0])
    md = MetricDefinition(project_id=pid, name="m", metric_type="mean",
                          input_source_type="dataset_domain", input_source_id=doms["in"],
                          config="{}", origin="human")
    db.add(md)
    db.flush()
    app_mean = json.loads(compute_metric(db, md)[0].result_data)["mean"]
    db.delete(md)
    db.flush()
    app_alpha = compute_statistical_test(db, db.get(StatisticalTest, pid * 10 + 5))["alpha"]

    def after(script):
        mean_line = _emitted(script, r"(?<=^# in mean\n)mean\(.*\)$")
        return f'''
emit("aov_score", summary(aov_function_score_by_if_)[[1]][["F value"]][1])
emit("aov_next", summary(aov_next__by_if_)[[1]][["F value"]][1])
emit("in_mean", {mean_line})
emit("alpha", suppressWarnings(psych::alpha(function__items, check.keys = FALSE))$total$raw_alpha)
emit("valid_n", sum(function__valid_ok))
emit("nlev_else", nlevels(data$else_))
'''

    out, script = _run(db, pid, after)
    assert out["aov_score"] == pytest.approx(app_F[0], abs=1e-3)
    assert out["aov_next"] == pytest.approx(app_F[1], abs=1e-3)
    assert out["in_mean"] == pytest.approx(app_mean, abs=1e-9)
    assert out["alpha"] == pytest.approx(app_alpha, abs=1e-4)
    assert out["valid_n"] > 0 and out["nlev_else"] == 2
    # Every bare-name site class was emitted with the suffixed name.
    for pattern in (r"^domains <- list\($", r"^  function_ = c\(", r"^  in_ = c\(",
                    r"group_by\(if_\) %>% count\(else_\)", r"filter\(!is\.na\(next_\)\)",
                    # The comparison's grouping column, inside its `.mm_testable`
                    # frame since #1329 (D52) — it read `~ data$if_)` before.
                    r"\.mm_testable\(\.mm_num\(data\$\w+, \"\w+\"\), data\$if_\)$",
                    # The pooled proportion's objects, over the items frame since
                    # #1330 (D55) — it was one flat `function__valid` vector.
                    r"^function__valid_items <- ", r"^function__valid_ok <- ",
                    r"^function__items <- ",
                    r'attr\(data\$next_, "label"\)'):
        assert re.search(pattern, script, re.M), pattern


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
@pytest.mark.parametrize("eg_label", ["wave link", "function"])
def test_datasets_named_as_reserved_words_keep_their_prefix(db_session, eg_label):
    """Datasets named *Function* and *if*, a cross-dataset group and its
    per-dataset `<prefix>_subset` blocks. With a plain equivalence label this
    arm PASSES at 02c97c77 — the record that `_dataset_r_prefix` never needed
    the check; with an equivalence group labelled *function* it did not parse
    (`equivalence_groups <- list(function = …)`)."""
    db = db_session
    pid = 9773 if eg_label == "function" else 9774
    cols, _doms, _ = _build(db, pid, domains=[], extra_cols=["i1"], ds_name="Function",
                            second_ds_name="if")
    eg = EquivalenceGroup(id=pid * 10 + 3, project_id=pid, label=eg_label)
    db.add(eg)
    db.flush()
    for code in ("i1", "other_q"):
        db.get(DatasetColumn, cols[code]).equivalence_group_id = eg.id
    dom = AnalysisDomain(id=pid * 10 + 4, project_id=pid, name="Scale", sequence_order=0)
    db.add(dom)
    db.flush()
    for k, code in enumerate(("i1", "other_q")):
        db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column",
                                    member_id=cols[code], sequence_order=k))
    db.flush()
    _m, ok = create_scale_score_metric(db, dom)
    assert ok
    _material(db, pid, 1, "summary_table", "descriptives",
              {"metric_type": "domain_aggregate", "domain_ids": [dom.id]})
    db.flush()
    out, script = _run(db, pid, r'''
emit("function_n", nrow(function_subset))
emit("if_n", nrow(if_subset))
''')
    assert re.search(r'^function_subset <- data\[data\$dataset == "Function", c\("function__i1"\)\]$',
                     script, re.M)
    assert out == {"function_n": 30.0, "if_n": 5.0}
