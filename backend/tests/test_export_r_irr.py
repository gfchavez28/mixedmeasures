"""Track J · J2-5 (M-4) — IRR emission in the .mmproject R export round-trips.

The `.R` export now emits the project's inter-rater reliability: a per-code
coder×unit matrix CSV (`<slug>_irr.csv`) + an R block that re-derives Krippendorff's
α (all n) / Cohen's κ + % agreement (2 coders) via the `irr` package. This asserts
the emitted artifact is well-formed (always) AND that running the emitted R calls on
the exported CSV reproduces the tool's own `compute_irr` numbers (gated on Rscript +
the `irr` package, mirroring test_irr.py).
"""
import asyncio
import io
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.routers.export_r import export_r_data
from app.services.irr import compute_irr

PID = 950
DSID = 950


# ── R irr gate (ported from test_irr.py) ──────────────────────────────────────
_RSCRIPT = shutil.which("Rscript")


def _r_has_irr() -> bool:
    if not _RSCRIPT:
        return False
    try:
        out = subprocess.run(
            [_RSCRIPT, "-e", 'cat(requireNamespace("irr", quietly=TRUE))'],
            capture_output=True, text=True, timeout=60,
        )
        return "TRUE" in out.stdout
    except Exception:
        return False


_HAS_IRR = _r_has_irr()


def _seed(db):
    """A minimal qualifying dataset (so the export succeeds) + a 2-coder coded
    conversation with agreement + Option-B blank disagreement."""
    db.add(Project(id=PID, name="IRR Export", user_id=1))
    db.flush()
    # Minimal qualifying dataset: one numeric column + two rows.
    db.add(Dataset(id=DSID, project_id=PID, name="ds"))
    db.flush()
    db.add(DatasetColumn(id=9501, dataset_id=DSID, column_code="x", column_name="x",
                         column_text="x", column_type="numeric", sequence_order=0, display_order=0))
    db.flush()
    for i in range(2):
        db.add(DatasetRow(id=95100 + i, dataset_id=DSID))
    db.flush()
    db.add_all([
        DatasetValue(id=95200, row_id=95100, column_id=9501, value_text="1", value_numeric=1),
        DatasetValue(id=95201, row_id=95101, column_id=9501, value_text="2", value_numeric=2),
    ])
    db.flush()

    # Coder 1 (testuser) exists; add coder 2.
    db.add(User(id=2, username="Reviewer B", password_hash=None, coder_type="human"))
    db.flush()
    db.add(Conversation(id=PID, project_id=PID, name="Interview"))
    db.flush()
    for i in range(4):
        db.add(Segment(id=95000 + i, conversation_id=PID, sequence_order=i, text=f"s{i}"))
    db.flush()
    db.add(Code(id=9590, project_id=PID, name="Theme A", numeric_id=2, is_active=True, is_universal=False))
    db.flush()

    def ap(uid, sid):
        db.add(CodeApplication(code_id=9590, user_id=uid, segment_id=sid))

    # Theme A matrix (coders 1,2): S0=[1,1] agree, S1=[1,0], S2=[0,1], S3=[0,0].
    ap(1, 95000); ap(2, 95000)   # both
    ap(1, 95001)                 # A only (B engaged via S0 → blank=0)
    ap(2, 95002)                 # B only (A engaged → blank=0)
    # S3: neither (both engaged the conversation → [0,0])
    db.flush()
    return db.get(User, 1)


async def _export_zip_bytes(db, user):
    resp = await export_r_data(project_id=PID, user=user, db=db)
    chunks = [c async for c in resp.body_iterator]
    return b"".join(chunks if isinstance(chunks[0], bytes) else [c.encode() for c in chunks])


def test_export_emits_irr_csv_and_r_block(db_session):
    """Always-on (no R): the export carries a well-formed IRR CSV + matching R."""
    db = db_session
    user = _seed(db)
    raw = asyncio.run(_export_zip_bytes(db, user))

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        irr_name = next((n for n in names if n.endswith("_irr.csv")), None)
        setup_name = next(n for n in names if n.endswith(".R"))
        assert irr_name, f"export did not emit an IRR CSV; got {names}"
        irr_csv = zf.read(irr_name).decode("utf-8-sig")
        setup = zf.read(setup_name).decode("utf-8")

    # CSV shape: header + per-(code,unit) rows; coder columns for both coders.
    header = irr_csv.splitlines()[0]
    assert header == "code_id,code_name,coder_1,coder_2"
    body = [ln for ln in irr_csv.splitlines()[1:] if ln.strip()]
    assert all(ln.startswith("9590,") for ln in body), "all rows are Theme A's units"
    assert len(body) == 4, "4 in-play units"

    # The R block reads the CSV, pulls in `irr`, and runs the three calls.
    assert 'read_csv("IRR_Export_irr.csv"' in setup or "_irr.csv" in setup
    assert "kripp.alpha(t(m)" in setup
    assert "kappa2(dc)" in setup and "agree(dc)" in setup
    assert '"irr"' in setup and "required_packages <- c(" in setup
    assert "Inter-rater reliability" in setup  # TOC + section header


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_exported_irr_reproduces_tool_numbers(db_session):
    """#402: run the emitted IRR R calls on the exported CSV; assert R ≈ the tool's
    own compute_irr per-code κ/α/% at abs=1e-6 (the test_irr.py tolerance)."""
    db = db_session
    user = _seed(db)
    expected = {c["code_id"]: c for c in compute_irr(db, PID)["per_code"]}
    assert expected, "fixture must produce per-code IRR"

    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            irr_csv = next(p for p in workdir.iterdir() if p.name.endswith("_irr.csv"))
        # Run the SAME irr calls the emitted block uses, against the exported CSV.
        runner = workdir / "runner.R"
        runner.write_text(f"""
suppressMessages(library(irr)); suppressMessages(library(readr))
d <- read_csv("{irr_csv.name}", na = c("", "NA"), show_col_types = FALSE)
coder_cols <- grep("^coder_", names(d), value = TRUE)
for (cid in unique(d$code_id)) {{
  m <- as.matrix(d[d$code_id == cid, coder_cols, drop = FALSE]); storage.mode(m) <- "numeric"
  a <- kripp.alpha(t(m), method = "nominal")$value
  k <- NA; ag <- NA
  if (ncol(m) == 2) {{
    dc <- m[stats::complete.cases(m), , drop = FALSE]
    if (nrow(dc) > 0) {{ k <- kappa2(dc)$value; ag <- agree(dc)$value / 100 }}
  }}
  cat(sprintf("RES %s %.8f %s %s\\n", cid, a,
              ifelse(is.na(k), "NA", sprintf("%.8f", k)),
              ifelse(is.na(ag), "NA", sprintf("%.8f", ag))))
}}
""", encoding="utf-8")
        proc = subprocess.run([_RSCRIPT, runner.name], cwd=str(workdir),
                              capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, f"R failed:\n{proc.stderr}"

    got = {}
    for m in re.finditer(r"^RES (\d+) ([-\d.eE+]+) (NA|[-\d.eE+]+) (NA|[-\d.eE+]+)\s*$",
                         proc.stdout, re.MULTILINE):
        got[int(m.group(1))] = (float(m.group(2)),
                                None if m.group(3) == "NA" else float(m.group(3)),
                                None if m.group(4) == "NA" else float(m.group(4)))
    assert set(got) == set(expected), f"R codes {set(got)} != tool codes {set(expected)}"

    for cid, exp in expected.items():
        r_alpha, r_kappa, r_agree = got[cid]
        assert r_alpha == pytest.approx(exp["krippendorff_alpha"], abs=1e-6)
        # 2-coder fixture → κ + % agreement also round-trip.
        assert r_kappa == pytest.approx(exp["cohens_kappa"], abs=1e-6)
        assert r_agree == pytest.approx(exp["percent_agreement"], abs=1e-6)
