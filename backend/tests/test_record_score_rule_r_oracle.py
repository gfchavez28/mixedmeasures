"""#1313 — the exported score column reproduced in real R from the item columns beside it.

The R script computes no scale score: it reads the stored per-record scores from
the CSV (`<group>_score`). So "asserted against R" here means an oracle OVER THE
EXPORTED FILE: R rebuilds each record's score from the item columns in the same
CSV, by the rule the app states — the mean of the items the record's OWN dataset
carries, when it answered at least half of them — and the two must agree record by
record (within 1e-4, the CSV's rounding), NA for NA. Then `aov(score ~ dataset)`
over the rebuilt scores must give the app's saved ANOVA.

Degenerate-fixture rules this fixture answers:
- **A 0-based labelled scale** (codes 0..4, #537): the item columns arrive in R as
  factors, so the rebuild must go through `.mm_num`, which recovers the CODES; a
  positional coercion (1..5) would rebuild every score 1 too high.
- **A partial crosswalk** (W2 carries two of the three items): the own-dataset
  count differs between datasets, so a rule using the group's width — or any one
  dataset's count — disagrees with the CSV.
- **Records at exactly ½ and at ⅓ of their own items**, and one with no cells.
"""
from __future__ import annotations

import asyncio
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models import (
    AnalysisDomain,
    AnalysisDomainMember,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
    EquivalenceGroup,
    MetricDefinition,
    Project,
    StatisticalTest,
    User,
)
from app.models.dataset import ColumnType
from app.routers.export_r import _make_r_identifier, _slugify, export_r_data
from app.services.metrics import compute_metric
from app.services.statistical_tests import compute_statistical_test
from tests import r_support

LABELS = ["Never", "Rarely", "Sometimes", "Often", "Always"]  # codes 0..4

DATA = {
    "W1": {"items": ["i1", "i2", "i3"],
           "rows": [[4, 3, 4], [0, 1, None], [2, None, None], [3, 3, 2], [1, 0, 1]]},
    "W2": {"items": ["i1", "i2"],
           "rows": [[0, None], [2, 1], [1, 1], [None, None], [3, 4]]},
    "W3": {"items": ["i1", "i2", "i3"],
           "rows": [[4, 4, 3], [3, None, 4], [1, 2, None], [0, 0, 1], [2, 3, 3]]},
}


def _seed(db):
    project = Project(name="Record score oracle", user_id=1)
    db.add(project)
    db.flush()
    groups = {i: EquivalenceGroup(project_id=project.id, label=i) for i in ("i1", "i2", "i3")}
    db.add_all(groups.values())
    domain = AnalysisDomain(project_id=project.id, name="Wellbeing")
    db.add(domain)
    db.flush()
    item_r_names: dict[str, list[str]] = {}
    seq = 0
    for ds_name, spec in DATA.items():
        ds = Dataset(project_id=project.id, name=ds_name)
        db.add(ds)
        db.flush()
        cols = []
        for i, item in enumerate(spec["items"]):
            code = f"{ds_name}_{item}"
            col = DatasetColumn(
                dataset_id=ds.id, column_code=code, column_name=code, column_text=item,
                column_type=ColumnType.ORDINAL, scale_labels=json.dumps(LABELS),
                scale_values=json.dumps(list(range(5))), sequence_order=i, display_order=i,
                equivalence_group_id=groups[item].id,
            )
            db.add(col)
            cols.append(col)
        db.flush()
        # The export's own naming for a multi-dataset project (export_r.py Step 3).
        item_r_names[ds_name] = [
            f"{_slugify(ds_name, max_len=20)}__{_make_r_identifier(c.column_code)}" for c in cols
        ]
        for col in cols:
            db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                        member_id=col.id, sequence_order=seq))
            seq += 1
        for r, values in enumerate(spec["rows"]):
            row = DatasetRow(dataset_id=ds.id, row_identifier=f"{ds_name}-{r}")
            db.add(row)
            db.flush()
            for col, v in zip(cols, values):
                if v is not None:
                    db.add(DatasetValue(row_id=row.id, column_id=col.id,
                                        value_text=LABELS[v], value_numeric=float(v)))
        db.flush()

    score = MetricDefinition(
        project_id=project.id, name="Wellbeing score", metric_type="domain_aggregate",
        input_source_type="dataset_domain", input_source_id=domain.id,
        config=json.dumps({"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}),
        origin="human", origin_context="crosswalk_auto",
    )
    by_wave = MetricDefinition(
        project_id=project.id, name="Wellbeing by wave", metric_type="mean",
        input_source_type="dataset_domain", input_source_id=domain.id, config="{}",
        grouping_mode="dataset", origin="human",
    )
    db.add_all([score, by_wave])
    db.flush()
    compute_metric(db, score)
    compute_metric(db, by_wave)
    anova = StatisticalTest(project_id=project.id, test_type="one_way_anova",
                            target_type="metric_definition", target_id=by_wave.id,
                            origin="human")
    db.add(anova)
    db.flush()
    result = compute_statistical_test(db, anova)
    return project.id, item_r_names, result


async def _export_zip_bytes(pid, user, db) -> bytes:
    resp = export_r_data(project_id=pid, user=user, db=db)
    chunks = [c async for c in resp.body_iterator]
    return b"".join(chunks if isinstance(chunks[0], bytes) else [c.encode() for c in chunks])


_RUNNER = r'''
invisible(capture.output(suppressWarnings(suppressMessages(
  source("__SETUP__", echo = FALSE)
))))
emit <- function(k, v) cat("RT", k, format(v, digits = 12, scientific = TRUE), "\n")
items <- list(__ITEMS__)
app <- data[["__SCORE__"]]
rebuilt <- rep(NA_real_, nrow(data))
for (d in names(items)) {
  rows <- which(data$dataset == d)
  m <- as.matrix(.mm_num(data[rows, items[[d]], drop = FALSE]))
  answered <- rowSums(!is.na(m))
  means <- rowMeans(m, na.rm = TRUE)
  rebuilt[rows] <- ifelse(answered / ncol(m) >= 0.5, means, NA)
}
emit("n_rows", nrow(data))
emit("n_scored_app", sum(!is.na(app)))
emit("n_scored_rebuilt", sum(!is.na(rebuilt)))
emit("na_mismatch", sum(is.na(app) != is.na(rebuilt)))
emit("max_abs_diff", max(abs(app - rebuilt), na.rm = TRUE))
emit("positional_diff", max(abs(
  rowMeans(as.matrix(data.frame(lapply(data[which(data$dataset == "W1"), items[["W1"]], drop = FALSE],
                                       as.numeric))), na.rm = TRUE) - rebuilt[which(data$dataset == "W1")]
), na.rm = TRUE))
fit <- summary(aov(score ~ g, data = data.frame(score = rebuilt, g = factor(data$dataset))))[[1]]
emit("F", fit[["F value"]][1])
emit("p", fit[["Pr(>F)"]][1])
fit_csv <- summary(aov(score ~ g, data = data.frame(score = app, g = factor(data$dataset))))[[1]]
emit("F_csv", fit_csv[["F value"]][1])
'''


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_the_exported_score_column_is_rebuilt_in_r_from_its_own_items(db_session):
    db = db_session
    pid, item_r_names, app_anova = _seed(db)

    raw = asyncio.run(_export_zip_bytes(pid, db.get(User, 1), db))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
        setup_name = next(p.name for p in workdir.iterdir() if p.suffix == ".R")
        csv_name = next(p.name for p in workdir.iterdir() if p.suffix == ".csv")
        header = (workdir / csv_name).read_text(encoding="utf-8").splitlines()[0].split(",")
        score_cols = [h.strip('"') for h in header if h.strip('"').endswith("_score")]
        assert score_cols == ["wellbeing_score"], header
        for names in item_r_names.values():
            for n in names:
                assert n in [h.strip('"') for h in header], (n, header)

        items_r = ", ".join(
            f'{ds} = c({", ".join(chr(34) + n + chr(34) for n in names)})'
            for ds, names in item_r_names.items()
        )
        (workdir / "runner.R").write_text(
            _RUNNER.replace("__SETUP__", setup_name)
                   .replace("__ITEMS__", items_r)
                   .replace("__SCORE__", score_cols[0]),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [r_support.RSCRIPT, "runner.R"],
            cwd=str(workdir), capture_output=True, text=True, timeout=300,
        )
    assert proc.returncode == 0, f"R failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    out = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"^RT (\w+)\s+(\S+)\s*$", line.strip())
        if m:
            out[m.group(1)] = float(m.group(2))

    assert out["n_rows"] == 15
    # W1: [2,–,–] answered ⅓ → NA; W2: [0,–] at exactly ½ → scored, [–,–] → NA.
    assert out["n_scored_app"] == 13
    assert out["na_mismatch"] == 0
    assert out["n_scored_rebuilt"] == out["n_scored_app"]
    assert out["max_abs_diff"] < 1e-4
    # The fixture can tell codes from positions: a 1..5 coercion is off by one.
    assert out["positional_diff"] == pytest.approx(1.0, abs=1e-9)
    # The app's saved ANOVA by dataset is R's aov over the rebuilt scores.
    assert app_anova["f_statistic"] == pytest.approx(out["F"], abs=2e-4)
    assert app_anova["p_value"] == pytest.approx(out["p"], abs=2e-4)
    # …and over the CSV's own (4-decimal) column, the round trip proper.
    assert app_anova["f_statistic"] == pytest.approx(out["F_csv"], abs=1e-3)
    assert [g["n"] for g in app_anova["groups"]] == [4, 4, 5]
