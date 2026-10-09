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
from tests import r_support

PID = 950
DSID = 950


# ── R irr gate — single-sourced in tests/r_support.py (#642) ──────────────────
_RSCRIPT = r_support.RSCRIPT
_HAS_IRR = r_support.HAS_IRR


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
    resp = export_r_data(project_id=PID, user=user, db=db)
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


# ── #35 — rating agreement (magnitude coding) ─────────────────────────────────

RATED_CODE = 9591


def _seed_with_ratings(db):
    """`_seed` plus a code that declares a −1…+1 scale, applied AND rated by both
    coders on every segment.

    ⚠️ Zero is INTERIOR on this scale and one rating IS zero (S2, coder 1): a
    truthiness slip anywhere between the row and the CSV would blank that cell,
    and the exported α would silently differ from the app's.
    """
    user = _seed(db)
    db.add(Code(id=RATED_CODE, project_id=PID, name="District support", numeric_id=3,
                is_active=True, is_universal=False,
                magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
    db.flush()
    ratings = {95000: (1.0, 1.0), 95001: (0.5, 0.0), 95002: (0.0, -0.5), 95003: (-1.0, -1.0)}
    for sid, (a, b) in ratings.items():
        db.add(CodeApplication(code_id=RATED_CODE, user_id=1, segment_id=sid, magnitude=a))
        db.add(CodeApplication(code_id=RATED_CODE, user_id=2, segment_id=sid, magnitude=b))
    db.flush()
    return user


def test_export_emits_a_rating_csv_and_its_own_r_block(db_session):
    """Always-on (no R): a rated code gets its OWN matrix file and loop — the
    cells are ratings on the code's scale, not 0/1, and the metric differs."""
    db = db_session
    user = _seed_with_ratings(db)
    raw = asyncio.run(_export_zip_bytes(db, user))

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        mag_name = next((n for n in names if n.endswith("_irr_magnitude.csv")), None)
        assert mag_name, f"export did not emit a rating CSV; got {names}"
        mag_csv = zf.read(mag_name).decode("utf-8-sig")
        setup = zf.read(next(n for n in names if n.endswith(".R"))).decode("utf-8")
        # The categorical file is untouched by the addition.
        irr_csv = zf.read(next(n for n in names if n.endswith("_irr.csv"))).decode("utf-8-sig")

    lines = mag_csv.splitlines()
    assert lines[0] == "code_id,code_name,scale_min,scale_max,coder_1,coder_2"
    body = [ln for ln in lines[1:] if ln.strip()]
    assert len(body) == 4, "one row per in-play unit of the rated code"
    assert all(ln.startswith(f"{RATED_CODE},District support,-1.0,1.0,") for ln in body)
    # The zero rating is a CELL, not a blank.
    assert f"{RATED_CODE},District support,-1.0,1.0,0.0,-0.5" in body

    assert "_irr_magnitude.csv" in setup
    assert 'kripp.alpha(t(m), method = "interval")' in setup
    assert "Rating agreement (magnitude coding)" in setup  # TOC + section header
    # The categorical block still scores nominally, in its own loop.
    assert 'kripp.alpha(t(m), method = "nominal")' in setup

    # `_irr.csv` carries BOTH codes' presence/absence rows now (the rated code
    # is also an applied code) — but no rating value leaks into it.
    assert "0.5" not in irr_csv and "-0.5" not in irr_csv


def test_export_omits_the_rating_csv_when_no_code_is_rated(db_session):
    """No scaled code → no file and no block that would `read_csv` it."""
    db = db_session
    user = _seed(db)
    raw = asyncio.run(_export_zip_bytes(db, user))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        setup = zf.read(next(n for n in names if n.endswith(".R"))).decode("utf-8")
    assert not any(n.endswith("_irr_magnitude.csv") for n in names)
    assert "_irr_magnitude.csv" not in setup
    assert "Rating agreement" not in setup


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_exported_rating_alpha_reproduces_tool_number(db_session):
    """#402 for ratings: R's interval-metric α over the exported matrix equals
    the app's rating α for that code."""
    db = db_session
    user = _seed_with_ratings(db)
    res = compute_irr(db, PID)
    row = next(r for r in res["magnitude_per_code"] if r["code_id"] == RATED_CODE)
    assert row["krippendorff_alpha"] is not None, "fixture must produce a defined rating α"

    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            mag_csv = next(p for p in workdir.iterdir() if p.name.endswith("_irr_magnitude.csv"))
        runner = workdir / "runner.R"
        runner.write_text(f"""
suppressMessages(library(irr)); suppressMessages(library(readr))
d <- read_csv("{mag_csv.name}", na = c("", "NA"), show_col_types = FALSE)
coder_cols <- grep("^coder_", names(d), value = TRUE)
for (cid in unique(d$code_id)) {{
  m <- as.matrix(d[d$code_id == cid, coder_cols, drop = FALSE]); storage.mode(m) <- "numeric"
  a <- kripp.alpha(t(m), method = "interval")$value
  cat(sprintf("RES %s %.8f\\n", cid, a))
}}
""", encoding="utf-8")
        proc = subprocess.run([_RSCRIPT, runner.name], cwd=str(workdir),
                              capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, f"R failed:\n{proc.stderr}"

    got = {int(m.group(1)): float(m.group(2))
           for m in re.finditer(r"^RES (\d+) ([-\d.eE+]+)\s*$", proc.stdout, re.MULTILINE)}
    assert set(got) == {RATED_CODE}
    assert got[RATED_CODE] == pytest.approx(row["krippendorff_alpha"], abs=1e-6)


# ── Row 48 / #995 — code-set agreement (one variable, k values) ───────────────

SET_ID = 9600
SET_MEMBERS = (9601, 9602, 9603)  # Supportive / Neutral / Critical

SET_SECTION = "# ---- Code-set agreement (one variable, k values) ----"


def _section(setup: str, header: str) -> str:
    """The emitted R between ``header`` and the next ``# ---- `` section header.

    🔴 **A SUBSTRING CHECK OVER THE WHOLE SCRIPT CANNOT TELL THESE BLOCKS APART,
    and a planted mutant proved it.** The per-code block and the set block both
    emit `kripp.alpha(t(m), method = "nominal")`, so `... in setup` stayed true
    with the SET block switched to the interval metric — a guard that could not
    fail for the thing it was written to catch. (The magnitude block escapes this
    only because "interval" happens to appear once.) Assert inside the section.
    """
    assert header in setup, f"section {header!r} was not emitted"
    after = setup.split(header, 1)[1]
    return after.split("# ---- ", 1)[0]


def _seed_with_code_set(db):
    """`_seed` plus a THREE-valued, non-exhaustive code set coded by both coders.

    ⚠️ **Three values, not two, and that is load-bearing.** On a two-value set the
    set matrix and a member's indicator matrix are the same matrix relabelled, so
    their alphas coincide and the fixture cannot tell a k-valued figure from the
    binary one it replaces. `test_the_fixture_could_have_disagreed` asserts the
    separation rather than trusting it (#707a's DISCRIMINATION rule).

    ⚠️ **Non-exhaustive**, so `SET_NONE` (-1) is a real value and reaches the CSV.
    On an exhaustive set it would be `None` and the sentinel would never be
    exercised by this fixture at all.
    """
    from app.models.code_set import CodeSet

    user = _seed(db)
    db.add(CodeSet(id=SET_ID, project_id=PID, label="Teacher stance", exhaustive=False))
    db.flush()
    for i, (cid, name) in enumerate(zip(SET_MEMBERS, ("Supportive", "Neutral", "Critical"))):
        db.add(Code(id=cid, project_id=PID, name=name, numeric_id=10 + i,
                    is_active=True, is_universal=False, code_set_id=SET_ID))
    db.flush()
    # Four more segments: eight units is enough for the set alpha and the three
    # member alphas to separate, which four is not.
    for i in range(4, 8):
        db.add(Segment(id=95000 + i, conversation_id=PID, sequence_order=i, text=f"s{i}"))
    db.flush()

    A, B, C = SET_MEMBERS
    # (coder 1, coder 2) per segment; None = chose no member → "none of these".
    choices = {
        95000: (A, A), 95001: (A, B), 95002: (B, B), 95003: (C, A),
        95004: (None, None), 95005: (B, C), 95006: (C, C), 95007: (A, None),
    }
    for sid, (a, b) in choices.items():
        if a is not None:
            db.add(CodeApplication(code_id=a, user_id=1, segment_id=sid))
        if b is not None:
            db.add(CodeApplication(code_id=b, user_id=2, segment_id=sid))
    db.flush()
    return user


def test_export_emits_a_code_set_csv_and_its_own_r_block(db_session):
    """Always-on (no R): a set gets its OWN matrix file and loop — the cells are
    member code ids and the -1 sentinel, and the BASIS rides every row."""
    db = db_session
    user = _seed_with_code_set(db)
    raw = asyncio.run(_export_zip_bytes(db, user))

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        set_name = next((n for n in names if n.endswith("_irr_code_sets.csv")), None)
        assert set_name, f"export did not emit a code-set CSV; got {names}"
        set_csv = zf.read(set_name).decode("utf-8-sig")
        setup = zf.read(next(n for n in names if n.endswith(".R"))).decode("utf-8")

    lines = set_csv.splitlines()
    assert lines[0] == "set_id,set_label,set_basis,coder_1,coder_2"
    body = [ln for ln in lines[1:] if ln.strip()]
    assert len(body) == 8, "one row per in-play unit of the set"
    # The BASIS is on every row and is the CONSTANT, never a restated literal —
    # it decides whether a blank is missing data or "none of these", i.e. the
    # number itself (the internal design notes).
    assert all(ln.startswith(f"{SET_ID},Teacher stance,inclusive_with_none,") for ln in body)
    # The sentinel reaches the CSV as a bare -1: `codes.id` is a positive
    # autoincrement, so it can never collide with a member.
    assert f"{SET_ID},Teacher stance,inclusive_with_none,-1,-1" in body

    assert "Code-set agreement (one variable, k values)" in setup  # TOC + header
    block = _section(setup, SET_SECTION)
    # The block reads ITS file, not one of the two beside it.
    assert "_irr_code_sets.csv" in block
    # 🔴 NOMINAL, asserted INSIDE the block (see `_section`): an ordered metric
    # would sort "none of these" below every code id as though ids meant size,
    # and the per-code block emits the same call with the same constant.
    # ⚠️ Matched on the CALL, never the bare word: the first draft asserted
    # `"interval" not in block` and failed against correct code, because the
    # block's own prose says "confidence intervals are not recomputed here".
    # #772's phantom class, in a guard written to catch a metric swap.
    metrics = re.findall(r'kripp\.alpha\([^\n]*method = "(\w+)"', block)
    assert metrics == ["nominal"], f"the set block scores nominally, once; got {metrics}"
    # 🔴 No `factor()`: `kripp.alpha` categorises by value IDENTITY, so the
    # numeric ids reproduce the app exactly — measured, against the filed
    # entry's assumption. A factor here would import #402's silent-NA hazard
    # for a number it does not change.
    assert "factor(" not in block


def test_export_omits_the_code_set_csv_when_no_set_has_two_values(db_session):
    """No set → no file and no block that would `read_csv` it. A ONE-value set is
    the same answer: `compute_irr` refuses it as `degenerate`, so a script that
    emitted a coefficient over it would be emitting a non-statistic."""
    from app.models.code_set import CodeSet

    db = db_session
    user = _seed(db)
    db.add(CodeSet(id=SET_ID, project_id=PID, label="Half-built", exhaustive=False))
    db.flush()
    db.add(Code(id=SET_MEMBERS[0], project_id=PID, name="Only value", numeric_id=10,
                is_active=True, is_universal=False, code_set_id=SET_ID))
    db.flush()
    db.add(CodeApplication(code_id=SET_MEMBERS[0], user_id=1, segment_id=95000))
    db.flush()

    raw = asyncio.run(_export_zip_bytes(db, user))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        setup = zf.read(next(n for n in names if n.endswith(".R"))).decode("utf-8")
    assert not any(n.endswith("_irr_code_sets.csv") for n in names)
    assert "_irr_code_sets.csv" not in setup
    assert "Code-set agreement" not in setup


def test_the_members_binary_matrices_are_still_exported(db_session):
    """#995's own boundary: the set block is an ADDITION, never a replacement.

    `compute_irr` drops set members from the DISPLAYED per-code table; `per_code`
    feeds this export too, so a narrowing there would silently stop exporting
    codes that have always been exported.
    """
    db = db_session
    user = _seed_with_code_set(db)
    raw = asyncio.run(_export_zip_bytes(db, user))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        irr_csv = zf.read(
            next(n for n in zf.namelist() if n.endswith("_irr.csv"))
        ).decode("utf-8-sig")
    exported = {int(ln.split(",")[0]) for ln in irr_csv.splitlines()[1:] if ln.strip()}
    for cid in SET_MEMBERS:
        assert cid in exported, f"member {cid} left the per-code export"


def test_the_fixture_could_have_disagreed(db_session):
    """#707a: assert the fixture can tell a k-valued alpha from a binary one.

    With two values a set's matrix IS a member's indicator matrix relabelled, so
    the alphas coincide and the round-trip below would pass against an
    implementation that scored the wrong thing.
    """
    db = db_session
    _seed_with_code_set(db)
    res = compute_irr(db, PID)
    row = next(r for r in res["set_agreement"] if r["set_id"] == SET_ID)
    assert row["krippendorff_alpha"] is not None, "fixture must produce a defined set alpha"
    assert row["n_values"] == 3
    member_alphas = [m["krippendorff_alpha"] for m in row["members"]]
    assert all(a is not None for a in member_alphas), "each value needs its own defined alpha"
    for a in member_alphas:
        assert abs(a - row["krippendorff_alpha"]) > 1e-6, (
            "the set alpha coincides with a member's — this fixture cannot tell "
            "the k-valued figure from the binary one it replaces"
        )


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_exported_code_set_alpha_reproduces_tool_numbers(db_session):
    """#402 for code sets: R's nominal alpha/kappa/% over the exported matrix
    equals the app's `set_agreement` figures for that set."""
    db = db_session
    user = _seed_with_code_set(db)
    row = next(r for r in compute_irr(db, PID)["set_agreement"] if r["set_id"] == SET_ID)

    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            set_csv = next(p for p in workdir.iterdir() if p.name.endswith("_irr_code_sets.csv"))
        runner = workdir / "runner.R"
        runner.write_text(f"""
suppressMessages(library(irr)); suppressMessages(library(readr))
d <- read_csv("{set_csv.name}", na = c("", "NA"), show_col_types = FALSE)
coder_cols <- grep("^coder_", names(d), value = TRUE)
for (sid in unique(d$set_id)) {{
  m <- as.matrix(d[d$set_id == sid, coder_cols, drop = FALSE]); storage.mode(m) <- "numeric"
  a <- kripp.alpha(t(m), method = "nominal")$value
  k <- NA; ag <- NA
  if (ncol(m) == 2) {{
    dc <- m[stats::complete.cases(m), , drop = FALSE]
    if (nrow(dc) > 0) {{ k <- kappa2(dc)$value; ag <- agree(dc)$value / 100 }}
  }}
  cat(sprintf("RES %s %.8f %s %s\\n", sid, a,
              ifelse(is.na(k), "NA", sprintf("%.8f", k)),
              ifelse(is.na(ag), "NA", sprintf("%.8f", ag))))
}}
""", encoding="utf-8")
        proc = subprocess.run([_RSCRIPT, runner.name], cwd=str(workdir),
                              capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, f"R failed:\n{proc.stderr}"

    m = re.search(r"^RES (\d+) ([-\d.eE+]+) (NA|[-\d.eE+]+) (NA|[-\d.eE+]+)\s*$",
                  proc.stdout, re.MULTILINE)
    assert m, f"R printed no set result:\n{proc.stdout}"
    assert int(m.group(1)) == SET_ID
    assert float(m.group(2)) == pytest.approx(row["krippendorff_alpha"], abs=1e-6)
    assert float(m.group(3)) == pytest.approx(row["cohens_kappa"], abs=1e-6)
    assert float(m.group(4)) == pytest.approx(row["percent_agreement"], abs=1e-6)


# ── #1039 (h) — the columns are the coders who WORKED the scope ───────────────

IRR_SECTION = "# ---- Inter-rater reliability (intercoder agreement) ----"


def _seed_with_a_bystander(db):
    """`_seed`'s two coders plus a THIRD person on the install who never opened
    this project — the roster is install-wide, so before #1039 (h) every matrix
    was three wide and the script's `ncol(m) == 2` κ gate was false."""
    user = _seed_with_code_set(db)
    db.add(User(id=3, username="Bystander", password_hash=None, coder_type="human"))
    db.flush()
    return user


def test_a_coder_who_never_engaged_the_project_gets_no_column(db_session):
    db = db_session
    user = _seed_with_a_bystander(db)
    raw = asyncio.run(_export_zip_bytes(db, user))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        irr_csv = zf.read(next(n for n in names if n.endswith("_irr.csv"))).decode("utf-8-sig")
        set_csv = zf.read(next(n for n in names if n.endswith("_irr_code_sets.csv"))).decode("utf-8-sig")
    assert irr_csv.splitlines()[0] == "code_id,code_name,coder_1,coder_2"
    assert set_csv.splitlines()[0] == "set_id,set_label,set_basis,coder_1,coder_2"


def test_the_dropped_column_was_BLANK_in_every_cell(db_session):
    """Why dropping it is lossless: Option B gives a coder who engaged no source in
    the scope a blank everywhere, so no α, κ or % agreement can change."""
    from app.services.irr import build_irr_matrices

    db = db_session
    _seed_with_a_bystander(db)
    roster, _names, per_code, _src, scope, _mag, sets = build_irr_matrices(db, PID)
    assert roster == [1, 2, 3] and scope == {1, 2}, "the precondition: a third, unengaged coder"
    idx = roster.index(3)
    for rows in [*per_code.values(), *(s["rows"] for s in sets.values())]:
        assert all(row[idx] is None for row in rows)


def _run_emitted_section(workdir: Path, setup: str, header: str) -> str:
    """Execute the section of the EMITTED script under ``header`` — not a copy.

    ⚠️ The other round-trip tests in this file run a hand-written R runner that
    re-states the block's calls, so the block itself could drift (or, as here,
    gate on the wrong thing) with every one of them green.
    """
    runner = workdir / "emitted.R"
    runner.write_text(
        "suppressMessages(library(irr)); suppressMessages(library(readr))\n"
        "options(readr.show_col_types = FALSE)\n"
        + _section(setup, header),
        encoding="utf-8",
    )
    proc = subprocess.run([_RSCRIPT, runner.name], cwd=str(workdir),
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, f"R failed:\n{proc.stderr}"
    return proc.stdout


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_the_EMITTED_script_prints_kappa_where_the_app_does(db_session):
    """With a bystander on the install the app still shows κ and % agreement (its
    gate is the two coders the SCOPE engaged); the emitted script printed NA."""
    db = db_session
    user = _seed_with_a_bystander(db)
    res = compute_irr(db, PID)
    per_code = {c["code_id"]: c for c in res["per_code"]}
    set_row = next(r for r in res["set_agreement"] if r["set_id"] == SET_ID)
    assert per_code[9590]["cohens_kappa"] is not None, "the app reports κ here"

    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            setup = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode("utf-8")
        per_code_out = _run_emitted_section(workdir, setup, IRR_SECTION)
        set_out = _run_emitted_section(workdir, setup, SET_SECTION)

    line = next(ln for ln in per_code_out.splitlines() if ln.startswith("IRR\tcode=9590\t"))
    fields = dict(f.split("=", 1) for f in line.split("\t")[1:])
    assert float(fields["kappa"]) == pytest.approx(per_code[9590]["cohens_kappa"], abs=1e-6)
    assert float(fields["agree"]) == pytest.approx(per_code[9590]["percent_agreement"], abs=1e-6)
    assert float(fields["alpha"]) == pytest.approx(per_code[9590]["krippendorff_alpha"], abs=1e-6)

    line = next(ln for ln in set_out.splitlines() if ln.startswith(f"IRR_CODE_SET\tset={SET_ID}\t"))
    fields = dict(f.split("=", 1) for f in line.split("\t")[1:])
    assert float(fields["kappa"]) == pytest.approx(set_row["cohens_kappa"], abs=1e-6)
    assert float(fields["agree"]) == pytest.approx(set_row["percent_agreement"], abs=1e-6)
