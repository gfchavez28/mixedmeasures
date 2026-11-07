"""The R script reproduces 1.5.9 session A's numbers, and none of its tests halts it.

#1326 (STAT-06, STAT-07, STAT-12), #1328 and #1329, decisions D49–D52, D57, D58
of the git-ignored the internal design notes.
Each fixture sits where the OLD script and the app DISAGREE (statistics.md §4),
and the runner reads the objects the EMITTED script built (#1039 h), never a
restatement of its calls. Each arm also prints what the old call would have
given, so a fixture on which old and new agree fails here:

* **Cross-tab (D49/D50):** a declared level nobody chose — the old
  `chisq.test(cross_tab)` printed NaN — on the review's [12 5; 6 11], where
  Yates (2.9514) and Pearson (4.25) differ.
* **One-value groups (D51/D52):** the comparison's ANOVA over A(6) B(5) C(1) —
  the old `aov` over all three gave F(2, 9) = 52.22 where the app shows
  F(1, 9) = 104.43 — and a two-group comparison A(6) C(1), whose old `t.test`
  RAISED and halted the script. The saved ANOVA too.
* **Mann–Whitney (D58):** tie-free 10 v 10, where R's exact .035463 and the
  app's old normal approximation .037635 differ.
* **Exclusions (D57):** a mean and a bar chart that leave out "Always" through a
  case variant ("ALWAYS"), which the old script ignored (mean) or matched
  exactly (chart).
"""

import asyncio
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.materials import Material, MaterialCollection
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.statistical_test import StatisticalTest
from app.models.user import User
from app.routers.export_r import export_r_data
from app.services.comparisons import compute_group_comparison
from app.services.cross_tabulation import compute_cross_tabulation
from app.services.metrics import compute_metric
from app.services.statistical_tests import compute_statistical_test
from tests import r_support

PID = 13261
Y, GRP, GRP2, MW, SIDE, ORD, XR, XC = (PID * 10 + k for k in range(1, 9))

A = [3.1, 3.4, 2.9, 3.6, 3.2, 3.0]
B = [4.5, 4.9, 4.7, 5.1, 4.6]
C = [3.9]
MW_X = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
MW_Y = [6, 10, 12, 14, 16, 18, 20, 21, 22, 23]
ORD_LABELS = ["Never", "Rarely", "Sometimes", "Often", "Always"]
ORD_CODES = [1, 1, 2, 2, 3, 3, 3, 4, 5, 5, 5, 5]            # four "Always"
XTAB = [("Yes", "Left")] * 12 + [("Yes", "Right")] * 5 + [("No", "Left")] * 6 \
    + [("No", "Right")] * 11


def _seed(db):
    db.add(Project(id=PID, name="Quant five A", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    cols = [
        (Y, "y", ColumnType.NUMERIC, None), (GRP, "grp", ColumnType.NOMINAL, None),
        (GRP2, "grp2", ColumnType.NOMINAL, None), (MW, "mw", ColumnType.NUMERIC, None),
        (SIDE, "side", ColumnType.NOMINAL, None),
        (ORD, "ord", ColumnType.ORDINAL, ORD_LABELS),
        # "Unsure" is declared and never chosen: a row of the TABLE, not the test.
        (XR, "xr", ColumnType.NOMINAL, ["Yes", "No", "Unsure"]),
        (XC, "xc", ColumnType.NOMINAL, ["Left", "Right"]),
    ]
    for i, (cid, name, ctype, labels) in enumerate(cols):
        db.add(DatasetColumn(id=cid, dataset_id=PID, column_code=name, column_name=name,
                             column_text=name, column_type=ctype,
                             scale_labels=json.dumps(labels) if labels else None,
                             sequence_order=i, display_order=i))
    db.flush()

    abc = A + B + C
    labels = ["A"] * 6 + ["B"] * 5 + ["C"]
    vid = PID * 1000
    for r in range(len(XTAB)):
        db.add(DatasetRow(id=PID * 100 + r, dataset_id=PID))
        db.flush()
        cells: dict[int, tuple[str, float | None]] = {}
        if r < len(abc):
            cells[Y] = (str(abc[r]), abc[r])
            cells[GRP] = (labels[r], None)
            if labels[r] in ("A", "C"):
                cells[GRP2] = (labels[r], None)
            code = ORD_CODES[r]
            cells[ORD] = (ORD_LABELS[code - 1], float(code))
        if r < 20:
            v = (MW_X + MW_Y)[r]
            cells[MW] = (str(v), float(v))
            cells[SIDE] = ("x" if r < 10 else "y", None)
        cells[XR] = (XTAB[r][0], None)
        cells[XC] = (XTAB[r][1], None)
        for cid, (text, num) in cells.items():
            vid += 1
            db.add(DatasetValue(id=vid, row_id=PID * 100 + r, column_id=cid,
                                value_text=text, value_numeric=num))
    db.flush()

    db.add(MetricDefinition(id=PID, project_id=PID, name="y by grp", metric_type="mean",
                            input_source_type="dataset_column", input_source_id=Y,
                            grouping_column_id=GRP, config="{}", origin="human", stale=False))
    db.add(MetricDefinition(id=PID + 1, project_id=PID, name="ord mean", metric_type="mean",
                            input_source_type="dataset_column", input_source_id=ORD,
                            exclude_values=json.dumps(["ALWAYS"]),
                            config="{}", origin="auto", stale=False))
    db.add(MetricDefinition(id=PID + 2, project_id=PID, name="ord freq",
                            metric_type="frequency_distribution",
                            input_source_type="dataset_column", input_source_id=ORD,
                            exclude_values=json.dumps(["ALWAYS"]),
                            config="{}", origin="auto", stale=False))
    db.flush()
    db.add(StatisticalTest(id=PID, project_id=PID, test_type="one_way_anova",
                           target_type="metric_definition", target_id=PID,
                           config="{}", result_data="{}"))
    db.add(MaterialCollection(id=PID, project_id=PID, name="Materials"))
    db.flush()
    materials = [
        ("comparison", "comparisons", {"column_ids": [Y], "compare_by": GRP}),
        ("comparison", "comparisons", {"column_ids": [Y], "compare_by": GRP2}),
        ("comparison", "comparisons", {"column_ids": [MW], "compare_by": SIDE,
                                       "nonparametric": True}),
        ("cross_tabulation", "cross_tabulation", {"column_ids": [XR],
                                                  "cross_tab_column_id": XC}),
        ("summary_table", "descriptives", {"metric_type": "mean", "column_ids": [ORD],
                                           "exclude_values": ["ALWAYS"]}),
        ("vertical_bar", "descriptives", {"metric_type": "frequency_distribution",
                                          "column_ids": [ORD],
                                          "exclude_values": ["ALWAYS"]}),
    ]
    for i, (mtype, tab, cfg) in enumerate(materials):
        db.add(Material(id=PID + i, collection_id=PID, material_type=mtype,
                        config=json.dumps(cfg), auto_name=f"m{i}", source_tab=tab,
                        display_order=i))
    db.flush()
    return db.get(User, 1)


def _app(db) -> dict:
    exp = {}
    anova = compute_group_comparison(db, project_id=PID, column_ids=[Y], domain_ids=[],
                                     grouping_column_id=GRP, grouping_column_id_2=None,
                                     test_type="auto", include_effect_size_ci=False)["rows"][0]
    exp["cmp_F"] = anova["test"]["statistic"]
    exp["tukey"] = {(c["group_a"], c["group_b"]): c for c in anova["test"]["post_hoc"]["comparisons"]}
    two = compute_group_comparison(db, project_id=PID, column_ids=[Y], domain_ids=[],
                                   grouping_column_id=GRP2, grouping_column_id_2=None,
                                   test_type="auto", include_effect_size_ci=False)["rows"][0]
    assert two["test"] is None
    mw = compute_group_comparison(db, project_id=PID, column_ids=[MW], domain_ids=[],
                                  grouping_column_id=SIDE, grouping_column_id_2=None,
                                  test_type="auto", include_effect_size_ci=False,
                                  nonparametric=True)["rows"][0]["test"]
    exp["mw_p"], exp["mw_method"] = mw["p"], mw["p_method"]
    x = compute_cross_tabulation(db, PID, XR, XC)["chi_square"]
    exp["chisq"], exp["v"], exp["fisher"] = x["statistic"], x["cramers_v"], x["fisher_exact_p"]
    exp["omitted_levels"] = x["omitted_levels"]
    mean = json.loads(compute_metric(db, db.get(MetricDefinition, PID + 1))[0].result_data)
    exp["ord_mean"] = mean["mean"]
    freq = json.loads(compute_metric(db, db.get(MetricDefinition, PID + 2))[0].result_data)
    exp["never_pct"] = freq["percentages"]["Never"]
    saved = compute_statistical_test(db, db.get(StatisticalTest, PID))
    exp["saved_F"] = saved["f_statistic"]
    return exp


_RUNNER = r'''
printed <- capture.output(suppressWarnings(suppressMessages(
  source("__SETUP__", echo = FALSE)
)))
emit <- function(k, v) cat("RT", k, format(v, digits = 12, scientific = TRUE), "\n")

# Cross-tab: the objects the script built.
emit("chisq", unname(xt_chisq$statistic)); emit("v", xt_v)
emit("fisher", xt_fisher_p)
emit("full_table_rows", nrow(cross_tab))
emit("old_chisq_is_nan", as.numeric(is.nan(unname(suppressWarnings(chisq.test(cross_tab))$statistic))))
emit("old_yates", unname(suppressWarnings(chisq.test(cross_tab_obs))$statistic))

# One-value groups: the comparison's ANOVA object and its Tukey.
emit("cmp_F", summary(aov_y_by_grp)[[1]][["F value"]][1])
tk <- TukeyHSD(aov_y_by_grp)[[1]]
emit("tukey_rows", nrow(tk)); emit("tukey_lwr", abs(tk[1, "lwr"]))
emit("old_F", summary(aov(.mm_num(data$y, "y") ~ data$grp))[[1]][["F value"]][1])
emit("left_out_printed", as.numeric(any(grepl("Left out of this test", printed))))
# The two-group comparison with a one-person group: no frame, a printed reason.
emit("t_frame_is_null", as.numeric(is.null(cmp_t_y_by_grp2)))
emit("not_computed_printed", as.numeric(any(grepl("Not computed", printed))))
emit("old_t_raised", as.numeric(inherits(try(t.test(.mm_num(data$y, "y") ~ data$grp2),
                                              silent = TRUE), "try-error")))
# The saved ANOVA.
emit("saved_F", summary(aov_result)[[1]][["F value"]][1])

# Mann-Whitney on the script's frame — its default IS the app's rule now.
emit("mw_p", suppressWarnings(wilcox.test(y ~ g, data = cmp_rank_mw_by_side))$p.value)
emit("mw_old_app_p", wilcox.test(y ~ g, data = cmp_rank_mw_by_side, exact = FALSE)$p.value)

# Exclusions: the mean line the script emitted, and the chart's data object.
emit("ord_mean", __ORD_MEAN__)
emit("ord_mean_old", mean(.mm_num(data$ord, "ord"), na.rm = TRUE))
emit("chart_always_count", sum(ch_ord$count[ch_ord$value == "Always"]))
emit("chart_never_pct", ch_ord$pct[ch_ord$value == "Never"])
# The emitted helper's own fold — trimmed AND lower-cased, as the app's
# `value_text.strip().lower()` (a factor cell cannot carry the spaces).
emit("helper_folds", as.numeric(.mm_is_excluded(c(" Always ", "always", "Often"), c("ALWAYS"))))

emit("reached_the_end", 1)
'''


def _run(workdir: Path, setup: Path) -> dict:
    script = setup.read_text(encoding="utf-8")
    mean_line = re.search(r"^mean\(\.mm_drop_excluded\(\.mm_num\(data\$ord, \"ord\"\),"
                          r" c\(\"ALWAYS\"\), by = data\$ord\), na\.rm = TRUE\)$",
                          script, re.M)
    assert mean_line, "the descriptives mean must drop the excluded answers"
    runner = workdir / "runner.R"
    runner.write_text(_RUNNER.replace("__SETUP__", setup.name)
                      .replace("__ORD_MEAN__", mean_line.group(0)), encoding="utf-8")
    proc = subprocess.run([r_support.RSCRIPT, runner.name], cwd=str(workdir),
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    out = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"^RT (\w+)\s+([-\d.eE+ ]+?)\s*$", line.strip())
        if m:
            vals = [float(v) for v in m.group(2).split()]
            out[m.group(1)] = vals[0] if len(vals) == 1 else vals
    return out


@pytest.fixture
def run(db_session):
    user = _seed(db_session)
    expected = _app(db_session)
    resp = export_r_data(project_id=PID, user=user, db=db_session)

    async def body():
        return b"".join([c if isinstance(c, bytes) else c.encode()
                         async for c in resp.body_iterator])

    raw = asyncio.run(body())
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            setup = workdir / next(n for n in zf.namelist() if n.endswith(".R"))
        actual = _run(workdir, setup)
    assert actual.get("reached_the_end") == 1
    return expected, actual


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestTheScriptReproducesSessionA:
    def test_the_cross_tab(self, run):
        exp, act = run
        assert exp["omitted_levels"] == 1
        assert act["full_table_rows"] == 3, "the declared level stays a row of the TABLE"
        assert act["chisq"] == pytest.approx(exp["chisq"], abs=1e-3)
        assert act["chisq"] == pytest.approx(4.25, abs=1e-3)
        assert act["v"] == pytest.approx(exp["v"], abs=1e-3)
        assert act["fisher"] == pytest.approx(exp["fisher"], abs=1e-4)
        # Discrimination: the old full-table call, and Yates on the submatrix.
        assert act["old_chisq_is_nan"] == 1
        assert act["old_yates"] == pytest.approx(2.9514, abs=1e-3)

    def test_the_one_value_group(self, run):
        exp, act = run
        assert act["cmp_F"] == pytest.approx(exp["cmp_F"], abs=1e-3)
        assert act["tukey_rows"] == len(exp["tukey"]) == 1
        assert act["tukey_lwr"] == pytest.approx(abs(exp["tukey"][("A", "B")]["ci_lower"]),
                                                 abs=1e-3)
        assert act["left_out_printed"] == 1
        assert act["old_F"] == pytest.approx(52.22, abs=0.01)

    def test_a_one_person_group_never_halts_the_script(self, run):
        _exp, act = run
        assert act["t_frame_is_null"] == 1 and act["not_computed_printed"] == 1
        assert act["old_t_raised"] == 1

    def test_the_saved_anova(self, run):
        exp, act = run
        assert act["saved_F"] == pytest.approx(exp["saved_F"], abs=1e-3)
        assert act["saved_F"] != pytest.approx(act["old_F"], abs=0.01)

    def test_mann_whitney(self, run):
        exp, act = run
        assert exp["mw_method"] == "exact"
        assert act["mw_p"] == pytest.approx(exp["mw_p"], abs=1e-6)
        assert act["mw_old_app_p"] == pytest.approx(0.037635, abs=1e-6)

    def test_exclusions(self, run):
        exp, act = run
        assert act["ord_mean"] == pytest.approx(exp["ord_mean"], abs=1e-6)
        assert act["ord_mean"] != pytest.approx(act["ord_mean_old"], abs=1e-3)
        assert act["chart_always_count"] == 0
        assert act["chart_never_pct"] == pytest.approx(exp["never_pct"], abs=0.1)
        assert act["helper_folds"] == [1.0, 1.0, 0.0]
