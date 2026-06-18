"""End-to-end R-export round-trip: does the exported script, run in real R,
reproduce the numbers the tool itself computes?

`test_export_r_runnable.py` is *parse-only* — it proves the emitted `.R` is
syntactically valid R (no BOM, CRAN mirror set, factor-coercion helper applied).
It never runs the script, never loads the CSV, and never compares R's output
back to the tool. This test closes that gap for the full statistical surface:

  1. Seed one dataset (32-row mtcars + 4 complete ordinal Likert items) plus the
     metric / statistical-test / material rows that drive each export emission.
  2. Compute the TOOL's results via the same services the analysis views use
     (compute_group_comparison / compute_correlation_matrix /
     compute_cross_tabulation / compute_statistical_test / compute_metric).
  3. Export → unzip the real `.R` + `.csv`.
  4. In R: `source()` the ACTUAL exported script (proving it runs to completion —
     packages load, CSV parses, every stat computes — strictly stronger than
     parse-only), then emit R's computed numbers on stdout for capture.
  5. Assert R ≈ tool within tolerance.

Capture strategy: after `source()`, reuse the objects the exported script leaves
in the global env (`aov_result`, `cor_vars`, `cross_tab`, `sh_r`/`sh_sb`,
`domain_means`) rather than parsing R's verbose auto-print. Calls the script
makes without assigning (t.test, kruskal.test, mean/sd, table) are re-run with
the identical expression — `source()` already proved each runs.

Coverage (every statistical output the export can emit):
  - Welch's t-test (t, df)            exact
  - One-way ANOVA (F, df)             exact
  - Tukey HSD post-hoc (diff, p)      exact
  - Pearson correlation (r)           exact
  - Spearman correlation (r)          exact
  - Chi-square (X^2, df)              exact
  - Cramer's V                        exact
  - Kruskal-Wallis (H, df)            exact (epsilon^2 effect size diverges — unit-anchored, not here)
  - Mann-Whitney U (W, p)             exact (2-group non-param; wilcox.test defaults == scipy.stats.mannwhitneyu)
  - Cronbach's alpha                  exact on COMPLETE data (listwise == pairwise == psych::alpha)
  - Split-half r + Spearman-Brown     exact (both use odd-even split)
  - mean / sd                         exact
  - frequency distribution (counts)   exact
  - domain-aggregate scale score      exact (mean of per-column means)

The export branches the non-parametric path by effective group count (N/A-aware,
matching the tool): 2 groups -> `wilcox.test` (Mann-Whitney), 3+ -> `kruskal.test`.
Both branches are exercised here (mpg by am = 2 groups, mpg by cyl = 3 groups).
KW epsilon-squared effect size and the MCAR test diverge from R by design and are
unit-anchored, not asserted equal here.

Gated on Rscript like the runnable test; skips cleanly when R is absent.
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import io
import json
import re
import shutil
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
from app.services.cross_tabulation import compute_cross_tabulation
from app.services.statistical_tests import compute_statistical_test
from app.services.metrics import compute_metric

from tests.conftest import MTCARS

PID = 900
DSID = 900
MPG, HP, WT, DISP, CYL, AM = 9001, 9002, 9003, 9004, 9005, 9006
Q1, Q2, Q3, Q4 = 9011, 9012, 9013, 9014
SCALE_COLS = [Q1, Q2, Q3, Q4]


def _likert(row_idx: int, item: int) -> int:
    """Deterministic, correlated, complete 1..5 Likert values (no NAs)."""
    latent = (row_idx % 5) + 1
    v = latent + ((row_idx + item) % 3) - 1
    return max(1, min(5, v))


def _seed(db):
    db.add(Project(id=PID, name="R Roundtrip", user_id=1))
    db.flush()
    db.add(Dataset(id=DSID, project_id=PID, name="combined"))
    db.flush()

    numeric = [(MPG, "mpg"), (HP, "hp"), (WT, "wt"), (DISP, "disp")]
    nominal = [(CYL, "cyl"), (AM, "am")]
    order = 0
    for cid, code in numeric:
        db.add(DatasetColumn(id=cid, dataset_id=DSID, column_code=code,
                             column_name=code, column_text=code,
                             column_type="numeric", sequence_order=order,
                             display_order=order))
        order += 1
    for cid, code in nominal:
        db.add(DatasetColumn(id=cid, dataset_id=DSID, column_code=code,
                             column_name=code, column_text=code,
                             column_type="nominal", sequence_order=order,
                             display_order=order))
        order += 1
    labels = json.dumps(["1", "2", "3", "4", "5"])
    for cid, code in [(Q1, "Q1"), (Q2, "Q2"), (Q3, "Q3"), (Q4, "Q4")]:
        db.add(DatasetColumn(id=cid, dataset_id=DSID, column_code=code,
                             column_name=code, column_text=code,
                             column_type="ordinal", scale_labels=labels,
                             sequence_order=order, display_order=order))
        order += 1
    db.flush()

    vid = 0
    for r, row in enumerate(MTCARS):
        dr = DatasetRow(id=90000 + r, dataset_id=DSID)
        db.add(dr)
        db.flush()
        cells = {MPG: row["mpg"], HP: row["hp"], WT: row["wt"],
                 DISP: row["disp"], CYL: row["cyl"], AM: row["am"]}
        for cid, val in cells.items():
            vid += 1
            db.add(DatasetValue(id=900000 + vid, row_id=dr.id, column_id=cid,
                                value_text=str(val), value_numeric=float(val)))
        for item, cid in enumerate(SCALE_COLS, start=1):
            v = _likert(r, item)
            vid += 1
            db.add(DatasetValue(id=900000 + vid, row_id=dr.id, column_id=cid,
                                value_text=str(v), value_numeric=float(v)))
    db.flush()

    # --- metric definitions (origin="human" so the export emits them) ---
    # t-test target: mpg by am
    db.add(MetricDefinition(id=9101, project_id=PID, name="mpg by am",
                            metric_type="mean", input_source_type="dataset_column",
                            input_source_id=MPG, grouping_column_id=AM,
                            config="{}", origin="human", stale=False))
    # ANOVA target: mpg by cyl
    db.add(MetricDefinition(id=9102, project_id=PID, name="mpg by cyl",
                            metric_type="mean", input_source_type="dataset_column",
                            input_source_id=MPG, grouping_column_id=CYL,
                            config="{}", origin="human", stale=False))
    # mean/sd metric on wt (distinct input so it isn't deduped against mpg)
    db.add(MetricDefinition(id=9103, project_id=PID, name="wt mean",
                            metric_type="mean", input_source_type="dataset_column",
                            input_source_id=WT, config="{}", origin="human", stale=False))
    # frequency distribution on cyl
    db.add(MetricDefinition(id=9104, project_id=PID, name="cyl freq",
                            metric_type="frequency_distribution",
                            input_source_type="dataset_column", input_source_id=CYL,
                            config="{}", origin="human", stale=False))
    db.flush()

    # Cronbach + split-half domain over the 4 Likert items
    db.add(AnalysisDomain(id=9300, project_id=PID, name="Scale", sequence_order=0))
    db.flush()
    for i, cid in enumerate(SCALE_COLS):
        db.add(AnalysisDomainMember(domain_id=9300, member_type="column",
                                    member_id=cid, sequence_order=i))
    db.flush()
    # domain-aggregate scale-score metric on the same domain
    db.add(MetricDefinition(id=9105, project_id=PID, name="Scale score",
                            metric_type="domain_aggregate",
                            input_source_type="dataset_domain", input_source_id=9300,
                            config=json.dumps({"child_metric_type": "mean",
                                               "child_config": {}, "aggregation": "mean"}),
                            origin="human", stale=False))
    db.flush()

    # result_data must be non-null: the export only emits tests the user has
    # actually run (computed), via `StatisticalTest.result_data != None`.
    db.add(StatisticalTest(id=9201, project_id=PID, test_type="independent_t_test",
                           target_type="metric_definition", target_id=9101,
                           config="{}", result_data="{}"))
    db.add(StatisticalTest(id=9202, project_id=PID, test_type="one_way_anova",
                           target_type="metric_definition", target_id=9102,
                           config="{}", result_data="{}"))
    db.add(StatisticalTest(id=9203, project_id=PID, test_type="cronbachs_alpha",
                           target_type="analysis_domain", target_id=9300,
                           config="{}", result_data="{}"))
    db.add(StatisticalTest(id=9204, project_id=PID, test_type="split_half",
                           target_type="analysis_domain", target_id=9300,
                           config="{}", result_data="{}"))

    # Materials
    coll = MaterialCollection(id=9400, project_id=PID, name="Materials")
    db.add(coll)
    db.flush()
    # Pearson correlation (mpg/hp/wt/disp) — drives `cor_vars`
    db.add(Material(id=9401, collection_id=9400, material_type="correlation",
                    config=json.dumps({"column_ids": [MPG, HP, WT, DISP],
                                       "corr_type": "pearson"}),
                    auto_name="Correlations", source_tab="correlations",
                    display_order=0))
    # Cross-tab (cyl x am) — drives `cross_tab`
    db.add(Material(id=9402, collection_id=9400, material_type="cross_tabulation",
                    config=json.dumps({"column_ids": [CYL],
                                       "cross_tab_column_id": AM}),
                    auto_name="cyl x am", source_tab="cross_tabulation",
                    display_order=1))
    # Non-parametric comparison (mpg by cyl, 3 groups) — drives `kruskal.test`
    db.add(Material(id=9403, collection_id=9400, material_type="comparison",
                    config=json.dumps({"column_ids": [MPG], "compare_by": CYL,
                                       "nonparametric": True}),
                    auto_name="mpg by cyl (KW)", source_tab="comparisons",
                    display_order=2))
    # Non-parametric comparison (mpg by am, 2 groups) — drives `wilcox.test`
    # (Mann-Whitney). Exercises the 2-group branch of the export fix.
    db.add(Material(id=9405, collection_id=9400, material_type="comparison",
                    config=json.dumps({"column_ids": [MPG], "compare_by": AM,
                                       "nonparametric": True}),
                    auto_name="mpg by am (MW)", source_tab="comparisons",
                    display_order=4))
    # Descriptives material for the domain — drives `domain_means <- colMeans(...)`
    # (the domain-aggregate emission lives in the materials loop, not human_metrics).
    db.add(Material(id=9404, collection_id=9400, material_type="domain_aggregate",
                    config=json.dumps({"metric_type": "domain_aggregate",
                                       "domain_ids": [9300]}),
                    auto_name="Scale score", source_tab="descriptives",
                    display_order=3))
    db.flush()
    return db.query(User).filter(User.id == 1).one()


async def _export_zip_bytes(pid, user, db) -> bytes:
    resp = await export_r_data(project_id=pid, user=user, db=db)
    chunks = [c async for c in resp.body_iterator]
    return b"".join(chunks if isinstance(chunks[0], bytes)
                    else [c.encode() for c in chunks])


def _pair_key(a: str, b: str) -> tuple:
    return tuple(sorted([str(a), str(b)]))


def _tool_expected(db) -> dict:
    """The numbers the tool itself shows the user, via its own services."""
    exp = {}
    # Welch t-test (mpg by am)
    t = compute_group_comparison(db, project_id=PID, column_ids=[MPG], domain_ids=[],
                                 grouping_column_id=AM, grouping_column_id_2=None,
                                 test_type="auto", include_effect_size_ci=False)
    tt = t["rows"][0]["test"]
    assert tt["test_type"] == "independent_t_test"
    exp["t_stat"], exp["t_df"] = tt["statistic"], tt["df"]
    # One-way ANOVA + Tukey post-hoc (mpg by cyl)
    a = compute_group_comparison(db, project_id=PID, column_ids=[MPG], domain_ids=[],
                                 grouping_column_id=CYL, grouping_column_id_2=None,
                                 test_type="auto", include_effect_size_ci=False)
    at = a["rows"][0]["test"]
    assert at["test_type"] == "one_way_anova"
    exp["anova_F"], exp["anova_df1"] = at["statistic"], at["df"]
    exp["tukey"] = {}
    for c in at["post_hoc"]["comparisons"]:
        exp["tukey"][_pair_key(c["group_a"], c["group_b"])] = {
            "diff": abs(c["mean_diff"]), "p": c["p"],
        }
    # Kruskal-Wallis (mpg by cyl) — exact H + df; effect size diverges by design
    kw = compute_group_comparison(db, project_id=PID, column_ids=[MPG], domain_ids=[],
                                  grouping_column_id=CYL, grouping_column_id_2=None,
                                  test_type="auto", include_effect_size_ci=False,
                                  nonparametric=True)
    kwt = kw["rows"][0]["test"]
    assert kwt["test_type"] == "kruskal_wallis"
    exp["kw_H"], exp["kw_df"] = kwt["statistic"], kwt["df"]
    # Mann-Whitney (mpg by am, 2 groups) — exact; R wilcox.test defaults == scipy
    mw = compute_group_comparison(db, project_id=PID, column_ids=[MPG], domain_ids=[],
                                  grouping_column_id=AM, grouping_column_id_2=None,
                                  test_type="auto", include_effect_size_ci=False,
                                  nonparametric=True)
    mwt = mw["rows"][0]["test"]
    assert mwt["test_type"] == "mann_whitney_u"
    exp["mw_stat"], exp["mw_p"] = mwt["statistic"], mwt["p"]
    # Pearson + Spearman correlation (mpg/hp/wt/disp); order mpg(0) hp(1) wt(2) disp(3)
    cp = compute_correlation_matrix(db, project_id=PID, column_ids=[MPG, HP, WT, DISP],
                                    domain_ids=[], correlation_type="pearson",
                                    bonferroni=False)["matrix"]
    exp["cor_mpg_hp"], exp["cor_mpg_wt"] = cp[0][1]["r"], cp[0][2]["r"]
    cs = compute_correlation_matrix(db, project_id=PID, column_ids=[MPG, HP, WT, DISP],
                                    domain_ids=[], correlation_type="spearman",
                                    bonferroni=False)["matrix"]
    exp["scor_mpg_hp"], exp["scor_mpg_wt"] = cs[0][1]["r"], cs[0][2]["r"]
    # Chi-square + Cramer's V (cyl x am)
    x = compute_cross_tabulation(db, PID, CYL, AM)
    exp["chisq"], exp["chisq_df"] = x["chi_square"]["statistic"], x["chi_square"]["df"]
    exp["cramers_v"] = x["chi_square"]["cramers_v"]
    # Cronbach's alpha (complete data → listwise == pairwise == psych::alpha)
    cron = compute_statistical_test(db, db.get(StatisticalTest, 9203))
    exp["cronbach"] = cron["alpha"]
    # Split-half (odd-even, Spearman-Brown — same split as the export)
    sh = compute_statistical_test(db, db.get(StatisticalTest, 9204))
    exp["sh_r"], exp["sh_sb"] = sh["split_half_r"], sh["spearman_brown"]
    # mean / sd (wt)
    mr = json.loads(compute_metric(db, db.get(MetricDefinition, 9103))[0].result_data)
    exp["wt_mean"], exp["wt_sd"] = mr["mean"], mr["std_dev"]
    # frequency (cyl)
    fr = json.loads(compute_metric(db, db.get(MetricDefinition, 9104))[0].result_data)
    exp["freq"] = {str(k): int(v) for k, v in fr["counts"].items()}
    # domain-aggregate scale score (mean of per-column means)
    dr = json.loads(compute_metric(db, db.get(MetricDefinition, 9105))[0].result_data)
    exp["domain_agg"] = dr["aggregate_value"]
    return exp


_RUNNER = r'''
# Source the ACTUAL exported script — if it errors (bad package, unparseable CSV,
# a stat call that blows up), Rscript exits non-zero and the test fails. This is
# the runtime-success check the parse-only test cannot make.
invisible(capture.output(suppressWarnings(suppressMessages(
  source("__SETUP__", echo = FALSE)
))))

emit <- function(k, v) cat("RT", k, format(v, digits = 12, scientific = TRUE), "\n")

# t-test: re-run the identical Welch call (auto-printed, no object to recover).
tt <- t.test(mpg ~ am, data = data, var.equal = FALSE)
emit("t_stat", unname(tt$statistic)); emit("t_df", unname(tt$parameter))

# ANOVA: reuse the `aov_result` object the exported script created.
asum <- summary(aov_result)[[1]]
emit("anova_F", asum[["F value"]][1]); emit("anova_df1", asum[["Df"]][1])

# Tukey HSD: reuse `aov_result`. Key by sorted group pair; abs(diff) is sign-
# and order-agnostic vs the tool's statsmodels convention.
tk <- TukeyHSD(aov_result)[[1]]
for (rn in rownames(tk)) {
  parts <- sort(strsplit(rn, "-")[[1]])
  key <- paste(parts[1], parts[2], sep = "_")
  emit(paste0("tukey_diff_", key), abs(tk[rn, "diff"]))
  emit(paste0("tukey_p_", key), tk[rn, "p adj"])
}

# Kruskal-Wallis: the export emits kruskal.test (auto-printed) — re-run identical.
kw <- kruskal.test(mpg ~ cyl, data = data)
emit("kw_H", unname(kw$statistic)); emit("kw_df", unname(kw$parameter))

# Mann-Whitney: the export emits wilcox.test for the 2-group comparison — re-run
# identical (defaults reproduce scipy.stats.mannwhitneyu).
mw <- suppressWarnings(wilcox.test(mpg ~ am, data = data))
emit("mw_stat", unname(mw$statistic)); emit("mw_p", mw$p.value)

# Pearson + Spearman: reuse the `cor_vars` the exported script created.
cmp <- cor(.mm_num(data[, cor_vars]), use = "pairwise.complete.obs", method = "pearson")
emit("cor_mpg_hp", cmp[1, 2]); emit("cor_mpg_wt", cmp[1, 3])
cms <- cor(.mm_num(data[, cor_vars]), use = "pairwise.complete.obs", method = "spearman")
emit("scor_mpg_hp", cms[1, 2]); emit("scor_mpg_wt", cms[1, 3])

# chi-square + Cramer's V: reuse the `cross_tab` the exported script created.
ct <- suppressWarnings(chisq.test(cross_tab))
emit("chisq", unname(ct$statistic)); emit("chisq_df", unname(ct$parameter))
emit("cramers_v", sqrt(unname(ct$statistic) / (nrow(data) * (min(dim(cross_tab)) - 1))))

# Cronbach: re-run psych::alpha on the scale items (source() proved it runs).
# Column vector lifted verbatim from the exported script (avoids coupling to the
# export's r_name lowercasing).
al <- suppressWarnings(psych::alpha(.mm_num(data[, c(__SCALE_COLS__)]),
                                    check.keys = FALSE))
emit("cronbach", al$total$raw_alpha)

# Split-half: reuse the `sh_r` / `sh_sb` objects the exported script created.
emit("sh_r", sh_r); emit("sh_sb", sh_sb)

# mean / sd (wt): re-run identical base-R calls.
emit("wt_mean", mean(.mm_num(data$wt), na.rm = TRUE))
emit("wt_sd", sd(.mm_num(data$wt), na.rm = TRUE))

# frequency (cyl): re-run table().
tb <- table(data$cyl)
for (nm in names(tb)) emit(paste0("freq_", nm), tb[[nm]])

# domain-aggregate scale score: reuse the `domain_means` object the script created.
emit("domain_agg", mean(domain_means))
'''


def _run_r(setup_path: Path, workdir: Path) -> dict:
    # Lift the scale-item column vector straight from the exported script so the
    # runner matches whatever r_names the export emitted.
    script_text = setup_path.read_text(encoding="utf-8")
    mobj = re.search(r"psych::alpha\(\.mm_num\(data\[, c\((.*?)\)\]\)", script_text)
    assert mobj, "exported script did not emit a psych::alpha (Cronbach) call"
    scale_cols = mobj.group(1)

    runner = workdir / "runner.R"
    runner.write_text(
        _RUNNER.replace("__SETUP__", setup_path.name).replace("__SCALE_COLS__", scale_cols),
        encoding="utf-8",
    )
    proc = subprocess.run(
        [shutil.which("Rscript"), runner.name],
        cwd=str(workdir), capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, (
        f"exported R script failed to run end-to-end:\n"
        f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    out = {}
    for line in proc.stdout.splitlines():
        mobj = re.match(r"^RT (\w+)\s+([-\d.eE+]+)\s*$", line.strip())
        if mobj:
            out[mobj.group(1)] = float(mobj.group(2))
    return out


@pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not available")
def test_exported_script_reproduces_tool_results(db_session):
    db = db_session
    user = _seed(db)
    expected = _tool_expected(db)

    raw = asyncio.run(_export_zip_bytes(PID, user, db))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            setup_name = next(n for n in zf.namelist() if n.endswith(".R"))
        # The export fix must branch by effective group count: Mann-Whitney
        # (wilcox.test) for the 2-group comparison, Kruskal-Wallis for the 3-group.
        script_text = (workdir / setup_name).read_text(encoding="utf-8")
        assert re.search(r"wilcox\.test\(mpg ~ am", script_text), \
            "2-group non-parametric comparison must emit wilcox.test (Mann-Whitney)"
        assert re.search(r"kruskal\.test\(mpg ~ cyl", script_text), \
            "3-group non-parametric comparison must emit kruskal.test"
        assert "kruskal.test(mpg ~ am" not in script_text, \
            "2-group comparison must NOT emit kruskal.test"
        actual = _run_r(workdir / setup_name, workdir)

    # --- scalar statistics: every one must have come back from R ---
    scalar_keys = ("t_stat", "t_df", "anova_F", "anova_df1", "kw_H", "kw_df",
                   "mw_stat", "mw_p", "cor_mpg_hp", "cor_mpg_wt", "scor_mpg_hp",
                   "scor_mpg_wt", "chisq", "chisq_df", "cramers_v", "cronbach",
                   "sh_r", "sh_sb", "wt_mean", "wt_sd", "domain_agg")
    for key in scalar_keys:
        assert key in actual, f"R did not emit {key}; got {sorted(actual)}"

    # R ≈ tool. Inferential statistics + df: abs 0.01; correlations/alpha/scores: abs 0.001.
    assert actual["t_stat"] == pytest.approx(expected["t_stat"], abs=0.01)
    assert actual["t_df"] == pytest.approx(expected["t_df"], abs=0.1)
    assert actual["anova_F"] == pytest.approx(expected["anova_F"], abs=0.01)
    assert actual["anova_df1"] == pytest.approx(expected["anova_df1"], abs=0.001)
    assert actual["kw_H"] == pytest.approx(expected["kw_H"], abs=0.01)
    assert actual["kw_df"] == pytest.approx(expected["kw_df"], abs=0.001)
    # Mann-Whitney: p is the inferential value (exact match); the W statistic
    # matches the tool's U directly or as its complement (n1*n2 - W), depending
    # on factor-level vs group-name ordering — both are the same test.
    assert actual["mw_p"] == pytest.approx(expected["mw_p"], abs=1e-4)
    n1n2 = 13 * 19  # am: 13 manual (1), 19 auto (0)
    assert (actual["mw_stat"] == pytest.approx(expected["mw_stat"], abs=0.5)
            or actual["mw_stat"] == pytest.approx(n1n2 - expected["mw_stat"], abs=0.5)), \
        f'R W={actual["mw_stat"]} matches neither tool U={expected["mw_stat"]} nor complement'
    assert actual["cor_mpg_hp"] == pytest.approx(expected["cor_mpg_hp"], abs=0.001)
    assert actual["cor_mpg_wt"] == pytest.approx(expected["cor_mpg_wt"], abs=0.001)
    assert actual["scor_mpg_hp"] == pytest.approx(expected["scor_mpg_hp"], abs=0.001)
    assert actual["scor_mpg_wt"] == pytest.approx(expected["scor_mpg_wt"], abs=0.001)
    assert actual["chisq"] == pytest.approx(expected["chisq"], abs=0.01)
    assert actual["chisq_df"] == pytest.approx(expected["chisq_df"], abs=0.001)
    assert actual["cramers_v"] == pytest.approx(expected["cramers_v"], abs=0.001)
    assert actual["cronbach"] == pytest.approx(expected["cronbach"], abs=0.001)
    assert actual["sh_r"] == pytest.approx(expected["sh_r"], abs=0.001)
    assert actual["sh_sb"] == pytest.approx(expected["sh_sb"], abs=0.001)
    assert actual["wt_mean"] == pytest.approx(expected["wt_mean"], abs=0.001)
    assert actual["wt_sd"] == pytest.approx(expected["wt_sd"], abs=0.001)
    assert actual["domain_agg"] == pytest.approx(expected["domain_agg"], abs=0.001)

    # --- Tukey HSD: per-pair |diff| and adjusted p (matched by sorted group pair) ---
    assert expected["tukey"], "tool produced no Tukey comparisons"
    for (ga, gb), exp in expected["tukey"].items():
        dkey, pkey = f"tukey_diff_{ga}_{gb}", f"tukey_p_{ga}_{gb}"
        assert dkey in actual and pkey in actual, f"R missing Tukey pair {ga}-{gb}: {sorted(actual)}"
        assert actual[dkey] == pytest.approx(exp["diff"], abs=0.01)
        assert actual[pkey] == pytest.approx(exp["p"], abs=0.005)

    # --- frequency distribution: every category count matches ---
    for label, count in expected["freq"].items():
        fkey = f"freq_{label}"
        assert fkey in actual, f"R missing frequency category {label}: {sorted(actual)}"
        assert actual[fkey] == pytest.approx(count, abs=0.5)
