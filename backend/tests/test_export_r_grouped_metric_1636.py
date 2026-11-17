"""#1636 — the R script computes a saved GROUPED metric per group, as the app shows it.

The supplementary loop over saved (human-origin) metrics read the grouping variables only
into its de-duplication key and wrote `mean(x)` / `sd(x)` — or `table(x)` — under the
metric's header, so a metric the app shows per team printed one pooled number, silently,
in the file a researcher uses to reproduce the analysis (`statistics.md` §4).

Now a metric over ONE column grouped by one or two variables is computed per group,
over the app's own groups in its order (`export_r._metric_group_values`, which asks
`metrics.resolve_dataset_column`); a record whose group is missing is in no group. A
variable-group metric keeps the pooled number and SAYS so (the materials path's #821b
rule), and a metric grouped by a variable the export does not carry is skipped with a
reason (D3: no number the app never showed).

Every arm is SOURCED in real R and compared, group by group, with `compute_metric`'s own
results — the oracle is the app, not a restatement of the emitted lines (#1039 h).
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

from app.models import Project
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.user import User
from app.routers.export_r import _metric_group_values
from app.services.grouping import order_value_labels
from app.services.metrics import STATS_PRECISION, compute_metric
from tests import r_support
from tests.test_export_r_score_names import _zip

PID = 16360
DSID = PID * 10
C_SCORE, C_SCORE2, C_TEAM, C_LEVEL, C_SITE, C_ANS, C_NOTE, C_WAVE, C_TAG = (
    PID * 100 + i for i in range(1, 10))
M_TEAM, M_LEVEL, M_PAIR, M_EXCL, M_FREQ, M_NOT_CARRIED, M_GROUP, M_WAVE, M_TAG = (
    PID + i for i in range(1, 10))
DOMAIN = PID + 50

LEVELS = ["Low", "Mid", "High"]
# A string sort reads "10", "12", "9"; the app's order is 9, 10, 12 (#406).
WAVES = ["9", "10", "12"]
# #1468: a group label is user text written into live code. Unescaped, it closes the
# string and runs the call (or the script fails to parse); escaped, it is just a label.
HOSTILE = 'x"); assign("INJECTED", TRUE, envir = globalenv()); # \\ \' end'
TAGS = ["plain", HOSTILE]
# (team, site, level, score, score2, ans). "Unknown" is the team column's DECLARED missing
# value: that record is in no team group, in the app and in R (the CSV blanks it).
ROWS = [
    ("North", "A", "Low", 1, 10, "Yes"),
    ("North", "B", "Mid", 2, 11, "No"),
    ("North", "A", "High", 4, 999, "Yes"),
    ("South", "B", "Low", 6, 20, "No"),
    ("South", "A", "Mid", 7, 21, "Yes"),
    ("South", "B", "High", 9, 22, "Yes"),
    ("East", "A", "Low", 12, 30, "No"),
    ("East", "B", "Mid", 15, 31, "No"),
    ("Unknown", "A", "High", 30, 40, "Yes"),
    ("North", "B", "Low", 3, 12, "Yes"),
    ("South", "A", "Low", 8, 23, "No"),
    ("East", "B", "High", 20, 999, "Yes"),
]


def _seed(db):
    db.add(Project(id=PID, name="Grouped metrics", user_id=1))
    db.flush()
    db.add(Dataset(id=DSID, project_id=PID, name="survey"))
    db.flush()
    cols = [
        (C_SCORE, "score", ColumnType.NUMERIC, {}),
        (C_SCORE2, "score2", ColumnType.NUMERIC, {}),
        (C_TEAM, "team", ColumnType.NOMINAL,
         {"missing_values": json.dumps([{"value": "Unknown"}])}),
        (C_LEVEL, "level", ColumnType.ORDINAL,
         {"scale_labels": json.dumps(LEVELS), "scale_values": json.dumps([1, 2, 3])}),
        (C_SITE, "site", ColumnType.NOMINAL, {}),
        (C_ANS, "ans", ColumnType.NOMINAL, {}),
        (C_NOTE, "note", ColumnType.OPEN_TEXT, {}),   # not a type the script carries
        (C_WAVE, "wave", ColumnType.NOMINAL, {}),     # numeric-looking labels (#406)
        (C_TAG, "tag", ColumnType.NOMINAL, {}),       # a hostile label (#1468)
    ]
    for order, (cid, name, ctype, extra) in enumerate(cols):
        db.add(DatasetColumn(id=cid, dataset_id=DSID, column_code=name, column_name=name,
                             column_text=name, column_type=ctype, sequence_order=order,
                             display_order=order, **extra))
    db.flush()
    vid = PID * 1000
    for r, (team, site, level, score, score2, ans) in enumerate(ROWS):
        rid = PID * 100 + 50 + r
        db.add(DatasetRow(id=rid, dataset_id=DSID, row_identifier=f"R{r}"))
        db.flush()
        cells = [
            (C_SCORE, f"{score}", float(score)),
            (C_SCORE2, f"{score2}", float(score2)),
            (C_TEAM, team, None),
            (C_LEVEL, level, float(LEVELS.index(level) + 1)),
            (C_SITE, site, None),
            (C_ANS, ans, None),
            (C_NOTE, f"note {r % 2}", None),
            (C_WAVE, WAVES[r % 3], None),
            (C_TAG, TAGS[r % 2], None),
        ]
        for cid, text, num in cells:
            vid += 1
            db.add(DatasetValue(id=vid, row_id=rid, column_id=cid, value_text=text,
                                value_numeric=num))
    db.flush()
    db.add(AnalysisDomain(id=DOMAIN, project_id=PID, name="Both scores", sequence_order=0))
    db.flush()
    for i, cid in enumerate((C_SCORE, C_SCORE2)):
        db.add(AnalysisDomainMember(domain_id=DOMAIN, member_type="column", member_id=cid,
                                    sequence_order=i))
    db.flush()

    def metric(mid, name, mtype, src, grp, *, grp2=None, excl=None, src_type="dataset_column"):
        db.add(MetricDefinition(
            id=mid, project_id=PID, name=name, metric_type=mtype,
            input_source_type=src_type, input_source_id=src,
            grouping_column_id=grp, grouping_column_id_2=grp2,
            exclude_values=json.dumps(excl) if excl else None,
            config="{}", origin="human", stale=False,
        ))

    metric(M_TEAM, "score by team", "mean", C_SCORE, C_TEAM)
    metric(M_LEVEL, "score by level", "mean", C_SCORE, C_LEVEL)
    metric(M_PAIR, "score by team and site", "mean", C_SCORE, C_TEAM, grp2=C_SITE)
    metric(M_EXCL, "score2 by team", "mean", C_SCORE2, C_TEAM, excl=["999"])
    # Its exclusion is lower-cased: the app folds case ("No" is left out).
    metric(M_FREQ, "ans by team", "frequency_distribution", C_ANS, C_TEAM, excl=["no"])
    metric(M_NOT_CARRIED, "score by note", "mean", C_SCORE, C_NOTE)
    metric(M_GROUP, "both scores by team", "mean", DOMAIN, C_TEAM, src_type="dataset_domain")
    metric(M_WAVE, "score by wave", "mean", C_SCORE, C_WAVE)
    metric(M_TAG, "score by tag", "mean", C_SCORE, C_TAG)
    db.flush()
    for mid in (M_TEAM, M_LEVEL, M_PAIR, M_EXCL, M_FREQ, M_GROUP, M_WAVE, M_TAG):
        compute_metric(db, db.get(MetricDefinition, mid))
    db.flush()


def _script_and_run(db, after: str):
    raw = asyncio.run(_zip(PID, db.get(User, 1), db))
    with tempfile.TemporaryDirectory() as d:
        work = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(work)
            setup = next(n for n in zf.namelist() if n.endswith(".R"))
        script = (work / setup).read_text(encoding="utf-8")
        (work / "run.R").write_text(
            "invisible(capture.output(suppressWarnings(suppressMessages("
            f'source("{setup}", echo = FALSE)))))\n' + after,
            encoding="utf-8",
        )
        proc = subprocess.run([r_support.RSCRIPT, "run.R"], cwd=str(work),
                              capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"the exported script did not run:\n{proc.stdout}\n{proc.stderr}"
    return script, proc.stdout


def _emitted_object(script: str, kind: str, metric_header_obj: str) -> str:
    m = re.search(rf"^({kind}_{metric_header_obj}) <- \.mm_group_", script, re.M)
    assert m, f"the export emitted no grouped object {kind}_{metric_header_obj}"
    return m.group(1)


_MEAN_DUMP = '''
o <- get("{obj}")
for (i in seq_len(nrow(o))) cat("MEAN", "{obj}", o$group[i], o$n[i],
    format(o$mean[i], digits = 15), format(o$sd[i], digits = 15), "\\n", sep = "\\t")
'''
_FREQ_DUMP = '''
d <- as.data.frame(get("{obj}"), stringsAsFactors = FALSE)
for (i in seq_len(nrow(d))) cat("FREQ", "{obj}", d$group[i], d$value[i], d$Freq[i], "\\n", sep = "\\t")
'''


def _rows(out: str, tag: str, obj: str) -> list[list[str]]:
    return [
        [f.strip() for f in line.rstrip("\t ").split("\t")][2:]   # cat's sep ends the line too
        for line in out.splitlines()
        if line.startswith(f"{tag}\t{obj}\t")
    ]


def _app_groups(db, mid) -> dict[str, dict]:
    metric = db.get(MetricDefinition, mid)
    return {
        r.group_value: {"n": r.valid_n, **json.loads(r.result_data)}
        for r in metric.results if r.group_value is not None
    }


MEAN_CASES = [
    (M_TEAM, "score_by_team"),
    (M_LEVEL, "score_by_level"),
    (M_PAIR, "score_by_team_site"),
    (M_EXCL, "score2_by_team"),
    (M_WAVE, "score_by_wave"),
    (M_TAG, "score_by_tag"),
]
# The cases whose every group's mean sits far from the pooled one (M_EXCL's input is
# another column; M_TAG is there for its label, not its numbers).
DISCRIMINATING = (M_TEAM, M_LEVEL, M_PAIR, M_WAVE)


def test_the_fixture_tells_a_grouped_mean_from_the_pooled_one(db_session):
    """#707a — every group's mean is far from the pooled one the old loop printed."""
    _seed(db_session)
    pooled = sum(r[3] for r in ROWS) / len(ROWS)
    for mid in DISCRIMINATING:
        groups = _app_groups(db_session, mid)
        assert len(groups) >= 3, mid
        for g, res in groups.items():
            assert abs(res["mean"] - pooled) > 1.0, (mid, g)
    assert set(_app_groups(db_session, M_TAG)) == set(TAGS)
    # The declared-missing team is in no group; a one-record pair has no SD.
    assert "Unknown" not in _app_groups(db_session, M_TEAM)
    assert _app_groups(db_session, M_PAIR)["East · A"]["std_dev"] is None
    # The order axis: the app's order and a string sort disagree on these labels.
    waves = set(_app_groups(db_session, M_WAVE))
    assert order_value_labels(waves) == ["9", "10", "12"] != sorted(waves)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_each_grouped_mean_is_the_apps_group_by_group(db_session):
    db = db_session
    _seed(db)
    raw_script = asyncio.run(_zip(PID, db.get(User, 1), db))
    with zipfile.ZipFile(io.BytesIO(raw_script)) as zf:
        script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
    objs = {mid: _emitted_object(script, "mean", stem) for mid, stem in MEAN_CASES}
    _script, out = _script_and_run(
        db, "".join(_MEAN_DUMP.format(obj=o) for o in objs.values())
        + 'cat("INJECTED_RAN", exists("INJECTED"), "\\n")\n')
    assert "INJECTED_RAN FALSE" in out, "a group label ran as code (#1468)"
    for mid, obj in objs.items():
        app = _app_groups(db, mid)
        rows = _rows(out, "MEAN", obj)
        # The app's groups, in the app's order (the chart's `compareValueLabels`).
        assert [r[0] for r in rows] == order_value_labels(set(app)), (obj, rows)
        assert [r[0] for r in rows] == _metric_group_values(db, db.get(MetricDefinition, mid))
        for group, n, mean, sd in rows:
            res = app[group]
            # The app stores each number rounded to STATS_PRECISION; R's, rounded the same.
            assert int(n) == res["n"], (obj, group)
            assert round(float(mean), STATS_PRECISION) == res["mean"], (obj, group)
            if res["std_dev"] is None:
                assert sd == "NA", (obj, group, sd)
            else:
                assert round(float(sd), STATS_PRECISION) == res["std_dev"], (obj, group)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_a_grouped_frequency_is_the_apps_counts_per_group(db_session):
    db = db_session
    _seed(db)
    raw_script = asyncio.run(_zip(PID, db.get(User, 1), db))
    with zipfile.ZipFile(io.BytesIO(raw_script)) as zf:
        script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
    obj = _emitted_object(script, "freq", "ans_by_team")
    _script, out = _script_and_run(db, _FREQ_DUMP.format(obj=obj))
    got: dict[str, dict[str, int]] = {}
    for group, value, freq in _rows(out, "FREQ", obj):
        if int(freq):
            got.setdefault(group, {})[value] = int(freq)
    app = {g: {k: v for k, v in res["counts"].items() if v} for g, res in
           _app_groups(db, M_FREQ).items()}
    assert got == app
    assert got["North"] == {"Yes": 3}                # the fixture's own literals: "No" excluded


def test_a_variable_group_metric_says_its_number_is_pooled(db_session):
    _seed(db_session)
    raw = asyncio.run(_zip(PID, db_session.get(User, 1), db_session))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
    block = script.split("# Metric: Both scores", 1)[1].split("# Metric:", 1)[0]
    assert ("# NOTE: this metric is grouped in Mixed Measures; the pooled (ungrouped)"
            " mean is emitted here.") in block
    assert "mean(unlist(" in block                    # the pooled number it names


def test_a_metric_grouped_by_a_variable_the_script_lacks_is_skipped_not_pooled(db_session):
    _seed(db_session)
    raw = asyncio.run(_zip(PID, db_session.get(User, 1), db_session))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
    skip = "# Skipped: grouped in Mixed Measures by a variable this export does not carry."
    assert script.count(skip) == 1
    after = script.split(skip, 1)[1].lstrip("\n")
    assert not after.startswith("mean("), "no pooled number stands in for the groups"
