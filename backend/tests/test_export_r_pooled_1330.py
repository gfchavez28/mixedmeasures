"""The R script prints the intervals the app shows over a variable group's POOLED
answers (#1330, D55), and counts a case variant under its label (#1332, D56).

Decisions D55/D56 of the git-ignored
the internal design notes. The pooled
`prop.test` and `.mm_freq` printed the interval that treats every answer as a
different person; the app now counts each RECORD once (a Wilson interval on a
Korn–Graubard effective n), and so does the script — in base R, over the items
frame whose rows are the records. The runner evaluates the lines the script
EMITTED (#1039 h), never a restatement, and each arm also computes the old
interval from the same counts, so a fixture on which old and new agree fails.

The fixture's 13 records give t on 12 df, a value the app's t table holds exactly,
so the app and R's `qt` agree to the displayed precision.
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

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.materials import Material, MaterialCollection
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.user import User
from app.routers.export_r import export_r_data
from app.services.metrics import ResolvedRow, compute_metric, compute_proportion
from tests import r_support

PID = 13301
Q1, Q2, Q3, NOM = (PID * 10 + k for k in range(1, 5))
V, W = PID, PID + 1
LABELS = ["Never", "Rarely", "Sometimes", "Often", "Always"]
# Thirteen records, answers alike within a record; three skip an item.
ITEMS = [(5, 5, 4), (5, 4, 5), (4, 4, 4), (1, 1, 2), (2, 1, 1), (1, 2, None), (3, 3, 3),
         (3, 2, 3), (5, 5, 5), (4, 5, None), (2, 2, 1), (1, None, 1), (3, 4, 3)]
NOMS = ["Yes", "yes", "YES", "No", "no", "Yes", "No", "Yes", "yes", "No", "No", "Yes", "Yes"]


def _seed(db):
    db.add(Project(id=PID, name="Pooled R", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    for i, (cid, name, ctype, labels) in enumerate([
            (Q1, "q1", ColumnType.ORDINAL, LABELS), (Q2, "q2", ColumnType.ORDINAL, LABELS),
            (Q3, "q3", ColumnType.ORDINAL, LABELS), (NOM, "nom", ColumnType.NOMINAL, ["Yes", "No"])]):
        db.add(DatasetColumn(id=cid, dataset_id=PID, column_code=name, column_name=name,
                             column_text=name, column_type=ctype,
                             scale_labels=json.dumps(labels),
                             scale_values=json.dumps(list(range(1, len(labels) + 1))),
                             sequence_order=i, display_order=i))
    db.flush()
    vid = PID * 1000
    for r, (codes, nom) in enumerate(zip(ITEMS, NOMS)):
        db.add(DatasetRow(id=PID * 100 + r, dataset_id=PID))
        db.flush()
        for cid, code in zip((Q1, Q2, Q3), codes):
            if code is None:
                continue
            # One answer typed in another case: still the "Always" its code says.
            text = "always" if (r, cid) == (8, Q3) else LABELS[code - 1]
            vid += 1
            db.add(DatasetValue(id=vid, row_id=PID * 100 + r, column_id=cid,
                                value_text=text, value_numeric=float(code)))
        vid += 1
        db.add(DatasetValue(id=vid, row_id=PID * 100 + r, column_id=NOM, value_text=nom,
                            value_numeric=1.0 if nom.lower() == "yes" else 2.0))
    for did, name, members in ((V, "Scale", (Q1, Q2, Q3)), (W, "Pair", (Q1, Q2))):
        db.add(AnalysisDomain(id=did, project_id=PID, name=name))
        db.flush()
        for i, cid in enumerate(members):
            db.add(AnalysisDomainMember(domain_id=did, member_type="column", member_id=cid,
                                        sequence_order=i))
    db.flush()

    text_cfg = {"mode": "values", "threshold_values": ["often", "ALWAYS"]}
    num_cfg = {"mode": "numeric", "operator": ">=", "threshold_numeric": 4}
    metrics = [
        (PID, "frequency_distribution", "dataset_domain", V, {}, ["SOMETIMES"]),
        (PID + 1, "proportion", "dataset_domain", V, text_cfg, ["Sometimes"]),
        (PID + 2, "proportion", "dataset_domain", W, num_cfg, None),
        (PID + 3, "frequency_distribution", "dataset_column", NOM, {}, None),
    ]
    for mid, mtype, st, sid, cfg, excl in metrics:
        db.add(MetricDefinition(id=mid, project_id=PID, name=f"m{mid}", metric_type=mtype,
                                input_source_type=st, input_source_id=sid,
                                config=json.dumps(cfg),
                                exclude_values=json.dumps(excl) if excl else None,
                                origin="auto", stale=False))
    db.add(MaterialCollection(id=PID, project_id=PID, name="Materials"))
    db.flush()
    materials = [
        {"metric_type": "frequency_distribution", "domain_ids": [V],
         "exclude_values": ["SOMETIMES"]},
        {"metric_type": "proportion", "domain_ids": [V], "proportion_config": text_cfg,
         "exclude_values": ["Sometimes"]},
        {"metric_type": "proportion", "domain_ids": [W], "proportion_config": num_cfg},
        {"metric_type": "frequency_distribution", "column_ids": [NOM]},
    ]
    for i, cfg in enumerate(materials):
        db.add(Material(id=PID + i, collection_id=PID, material_type="summary_table",
                        config=json.dumps(cfg), auto_name=f"m{i}", source_tab="descriptives",
                        display_order=i))
    db.flush()
    return db.get(User, 1)


#: Answers that pull APART within a record (one yes, one no), so the design effect
#: is below 1 and the effective n reaches its cap — no ordinary fixture does.
CAP_RECORDS = [(1, 0)] * 20 + [(1, 1)] * 2


def _app(db) -> dict:
    def rd(mid):
        return json.loads(compute_metric(db, db.get(MetricDefinition, mid))[0].result_data)
    rows = [ResolvedRow(row_id=g, value_numeric=float(v), value_text=str(v))
            for g, rec in enumerate(CAP_RECORDS) for v in rec]
    cap, _, _ = compute_proportion(
        rows, {"mode": "numeric", "operator": ">=", "threshold_numeric": 1}, by_record=True)
    return {"freq": rd(PID), "prop_text": rd(PID + 1), "prop_num": rd(PID + 2),
            "nom": rd(PID + 3), "cap": cap}


_RUNNER = r'''
printed <- capture.output(suppressWarnings(suppressMessages(
  source("__SETUP__", echo = FALSE)
)))
emit <- function(k, v) cat("RT", k, format(v, digits = 12, scientific = TRUE), "\n")
old <- function(k, n) prop.test(k, n, correct = FALSE)$conf.int * 100

fr <- __FREQ__
for (i in seq_len(nrow(fr))) {
  emit(paste0("freq_", fr$level[i]), c(fr$count[i], fr$ci_lower[i], fr$ci_upper[i],
                                       old(fr$count[i], fr$n[i])))
}
pt <- __PROP_TEXT__
emit("prop_text", c(pt$count, pt$n, pt$records, pt$pct, pt$ci_lower, pt$ci_upper,
                    old(pt$count, pt$n)))
pn <- __PROP_NUM__
emit("prop_num", c(pn$count, pn$n, pn$records, pn$pct, pn$ci_lower, pn$ci_upper,
                   old(pn$count, pn$n)))
nf <- __NOM__
for (i in seq_len(nrow(nf))) emit(paste0("nom_", nf$level[i]), nf$count[i])
emit("nom_levels", nrow(nf))
# The emitted helper itself, where the effective n reaches its cap.
cap_hit <- matrix(c(rep(c(TRUE, FALSE), 20), rep(c(TRUE, TRUE), 2)), ncol = 2, byrow = TRUE)
cp <- .mm_record_prop(cap_hit, matrix(TRUE, nrow = 22, ncol = 2))
emit("cap", c(cp$ci_lower, cp$ci_upper, old(cp$count, cp$n)))
emit("reached_the_end", 1)
'''


def _line(script: str, pattern: str) -> str:
    found = re.findall(pattern, script, re.M)
    assert len(found) == 1, (pattern, found)
    return found[0]


def _run(workdir: Path, setup: Path) -> dict:
    script = setup.read_text(encoding="utf-8")
    freq = _line(script, r'^\.mm_record_freq\(data\[, domains\$\w+, drop = FALSE\],'
                         r' c\("SOMETIMES"\)\)$')
    props = re.findall(r"^\.mm_record_prop\(.*\)$", script, re.M)
    assert len(props) == 2, props
    prop_text = next(p for p in props if "tolower(" in p)
    prop_num = next(p for p in props if ">=" in p)
    nom = _line(script, r"^\.mm_freq\(data\$nom\)$")
    assert "prop.test(count_meeting" not in script, "no pooled naive interval is printed"
    runner = workdir / "runner.R"
    runner.write_text(_RUNNER.replace("__SETUP__", setup.name).replace("__FREQ__", freq)
                      .replace("__PROP_TEXT__", prop_text).replace("__PROP_NUM__", prop_num)
                      .replace("__NOM__", nom), encoding="utf-8")
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


def _differs(new_lo, new_hi, old_lo, old_hi, by=1.0):
    return (new_hi - new_lo) - (old_hi - old_lo) > by


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestTheScriptReproducesSessionB:
    def test_the_pooled_frequency(self, run):
        exp, act = run
        rd = exp["freq"]
        # Record 6 answered "Sometimes" three times; excluded, it is no record of this.
        assert rd["record_count"] == 12
        kept = [lb for lb in LABELS if lb != "Sometimes"]
        for label in kept:
            count, lo, hi, old_lo, old_hi = act[f"freq_{label}"]
            assert count == rd["counts"][label], label
            assert lo == pytest.approx(rd["ci_lower_by_label"][label], abs=0.01), label
            assert hi == pytest.approx(rd["ci_upper_by_label"][label], abs=0.01), label
        # The excluded answers ("SOMETIMES", by the app's fold) left the base.
        assert rd["counts"]["Sometimes"] == 0 and "freq_Sometimes" not in act
        widened = [lb for lb in kept if _differs(*act[f"freq_{lb}"][1:])]
        assert len(widened) >= 3, "the fixture must separate the old interval from the new"

    def test_the_emitted_helper_caps_the_effective_n(self, run):
        """Where answers pull apart within a record the effective n would exceed n;
        the app caps it (D54) and the emitted helper must too — the round trips
        above never reach the cap."""
        exp, act = run
        lo, hi, old_lo, old_hi = act["cap"]
        assert (lo, hi) == pytest.approx((exp["cap"]["ci_lower"], exp["cap"]["ci_upper"]),
                                         abs=0.01)
        # Capped at n, the interval IS the naive Wilson one.
        assert (lo, hi) == pytest.approx((old_lo, old_hi), abs=0.01)

    def test_the_pooled_proportion_text_mode_with_exclusions(self, run):
        exp, act = run
        rd = exp["prop_text"]
        count, n, records, pct, lo, hi, old_lo, old_hi = act["prop_text"]
        assert count == rd["count_meeting"] and pct == pytest.approx(rd["percentage"], abs=0.01)
        assert records == rd["record_count"]
        assert (lo, hi) == pytest.approx((rd["ci_lower"], rd["ci_upper"]), abs=0.01)
        assert _differs(lo, hi, old_lo, old_hi)
        assert n < 34, "the excluded 'Sometimes' answers left the base"

    def test_the_pooled_proportion_numeric_mode(self, run):
        exp, act = run
        rd = exp["prop_num"]
        count, n, records, pct, lo, hi, old_lo, old_hi = act["prop_num"]
        assert count == rd["count_meeting"] and records == rd["record_count"] == 13
        assert (lo, hi) == pytest.approx((rd["ci_lower"], rd["ci_upper"]), abs=0.01)
        assert _differs(lo, hi, old_lo, old_hi)

    def test_a_case_variant_is_its_labels_level_in_r_too(self, run):
        """#1332 (D56): the app counts "yes"/"YES" under "Yes" — and R's factor now
        has no level of their own (its cells carry the label)."""
        exp, act = run
        assert act["nom_levels"] == 2
        assert act["nom_Yes"] == exp["nom"]["counts"]["Yes"] == 8
        assert act["nom_No"] == exp["nom"]["counts"]["No"] == 5
