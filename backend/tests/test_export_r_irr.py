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
    # #1325 (D39) — irr through its missing-data branch, never the bare matrix.
    assert "kripp.alpha(cbind(t(m), NA)" in setup
    assert "kripp.alpha(t(m)" not in setup
    assert "kappa2(dc)" in setup and "agree(dc)" in setup
    assert '"irr"' in setup and "required_packages <- c(" in setup
    assert "Inter-rater reliability" in setup  # TOC + section header


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_exported_irr_reproduces_tool_numbers(db_session):
    """#402: run the EMITTED IRR section on the exported CSV; assert R ≈ the tool's
    own compute_irr per-code κ/α/% at abs=1e-6 (the test_irr.py tolerance).

    ⚠️ It ran a hand-written restatement of the block until #1325 — the shape
    #1039 (h) had already shown cannot see the block drift."""
    db = db_session
    user = _seed(db)
    expected = {c["code_id"]: c for c in compute_irr(db, PID)["per_code"]}
    assert expected, "fixture must produce per-code IRR"

    got = _emitted_results(db, user, IRR_SECTION, "IRR")
    assert set(got) == {str(c) for c in expected}, f"R codes {set(got)} != tool codes {set(expected)}"

    for cid, exp in expected.items():
        fields = got[str(cid)]
        assert fields["reason"] == "", "the app reports a coefficient, so the script does"
        assert float(fields["alpha"]) == pytest.approx(exp["krippendorff_alpha"], abs=1e-6)
        assert float(fields["irr_value"]) == pytest.approx(exp["krippendorff_alpha"], abs=1e-6)
        # 2-coder fixture → κ + % agreement also round-trip.
        assert float(fields["kappa"]) == pytest.approx(exp["cohens_kappa"], abs=1e-6)
        assert float(fields["agree"]) == pytest.approx(exp["percent_agreement"], abs=1e-6)


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
    assert 'kripp.alpha(cbind(t(m), NA), method = "interval")' in _section(setup, MAG_SECTION)
    assert "Rating agreement (magnitude coding)" in setup  # TOC + section header
    # The categorical block still scores nominally, in its own loop.
    assert 'kripp.alpha(cbind(t(m), NA), method = "nominal")' in _section(setup, IRR_SECTION)

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

    got = _emitted_results(db, user, MAG_SECTION, "IRR_MAGNITUDE")
    assert set(got) == {str(RATED_CODE)}
    assert got[str(RATED_CODE)]["reason"] == ""
    assert float(got[str(RATED_CODE)]["alpha"]) == pytest.approx(row["krippendorff_alpha"], abs=1e-6)


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

    got = _emitted_results(db, user, SET_SECTION, "IRR_CODE_SET")
    assert set(got) == {str(SET_ID)}, f"R printed no set result: {got}"
    fields = got[str(SET_ID)]
    assert fields["reason"] == ""
    assert float(fields["alpha"]) == pytest.approx(row["krippendorff_alpha"], abs=1e-6)
    assert float(fields["kappa"]) == pytest.approx(row["cohens_kappa"], abs=1e-6)
    assert float(fields["agree"]) == pytest.approx(row["percent_agreement"], abs=1e-6)


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


MAG_SECTION = "# ---- Rating agreement (magnitude coding) ----"


def _emitted_results(db, user, header: str, tag: str) -> dict[str, dict[str, str]]:
    """Export, then run the EMITTED section under ``header``; ``{id: fields}`` for
    every output line tagged ``tag`` (``IRR`` · ``IRR_MAGNITUDE`` · ``IRR_CODE_SET``)."""
    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            setup = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode("utf-8")
        out = _run_emitted_section(workdir, setup, header)
    results: dict[str, dict[str, str]] = {}
    for line in out.splitlines():
        if line.startswith(tag + "\t"):
            fields = dict(f.split("=", 1) for f in line.split("\t")[1:])
            results[fields.get("code") or fields["set"]] = fields
    return results


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


# ── #1333 / #1334 — the units the script reproduces are the app's units ──────


def _seed_with_prompts_and_a_group(db):
    """`_seed`'s four participant turns, plus three interviewer prompts both
    coders left blank (#1333) and a three-turn GROUP both coded as a group, the
    apply fanned out to every member (#1334). Under the old reading those are
    six more units; under the stated basis, one."""
    from app.models.segment_group import SegmentGroup
    from app.models.speaker import Speaker

    user = _seed(db)
    interviewer = Speaker(project_id=PID, name="Interviewer", is_facilitator=1)
    db.add(interviewer)
    db.add(SegmentGroup(id=PID, conversation_id=PID))
    db.flush()
    for i, sid in enumerate((95004, 95005, 95006)):
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=4 + i,
                       text=f"prompt {i}", speaker_id=interviewer.id))
    for i, sid in enumerate((95007, 95008, 95009)):
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=7 + i,
                       text=f"grouped {i}", group_id=PID))
    db.flush()
    for sid in (95007, 95008, 95009):
        db.add(CodeApplication(code_id=9590, user_id=1, segment_id=sid))
        db.add(CodeApplication(code_id=9590, user_id=2, segment_id=sid))
    db.flush()
    return user


def test_the_unit_fixture_could_have_disagreed():
    """#707a — the old and the new unit sets give different α AND κ here."""
    from app.services.irr import _cohens_kappa, _krippendorff_alpha

    new = [[1, 1], [1, 0], [0, 1], [0, 0], [1, 1]]
    old = [[1, 1], [1, 0], [0, 1], [0, 0]] + [[0, 0]] * 3 + [[1, 1]] * 3
    assert _krippendorff_alpha(new) != pytest.approx(_krippendorff_alpha(old), abs=1e-3)
    assert _cohens_kappa(new) != pytest.approx(_cohens_kappa(old), abs=1e-3)


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_the_EMITTED_script_reproduces_the_stated_units(db_session):
    """Real R over the EMITTED block (#1039 h's rule): the script reproduces the
    app's α/κ/% on the stated-basis units, and says which units they are — and,
    D18, whose turns it left out as a facilitator's."""
    from app.services.irr import _krippendorff_alpha

    db = db_session
    user = _seed_with_prompts_and_a_group(db)
    res = compute_irr(db, PID)
    row = next(c for c in res["per_code"] if c["code_id"] == 9590)
    assert row["n_units"] == 5, "four participant turns and the group, once"
    assert row["krippendorff_alpha"] == pytest.approx(
        _krippendorff_alpha([[1, 1], [1, 0], [0, 1], [0, 0], [1, 1]])
    )

    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
            setup = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode("utf-8")
        section = _section(setup, IRR_SECTION)
        assert f"unit_basis = {res['unit_basis']}" in section
        assert "Turns left out as a facilitator's: Interviewer." in section
        out = _run_emitted_section(workdir, setup, IRR_SECTION)

    line = next(ln for ln in out.splitlines() if ln.startswith("IRR\tcode=9590\t"))
    fields = dict(f.split("=", 1) for f in line.split("\t")[1:])
    assert float(fields["alpha"]) == pytest.approx(row["krippendorff_alpha"], abs=1e-6)
    assert float(fields["kappa"]) == pytest.approx(row["cohens_kappa"], abs=1e-6)
    assert float(fields["agree"]) == pytest.approx(row["percent_agreement"], abs=1e-6)


# ── #1325 — complete data from three coders, and the app's reasons (D39–D41) ──
#
# irr's `kripp.alpha` weights every pair of values 1, not 1/(m−1), whenever the
# matrix has NO missing cell (its `mc <- rep(1, …)` branch, irr 0.84.1 and 0.85):
# exact for two coders, wrong for three or more. The script calls it through
# `cbind(t(m), NA)`, which forces the missing-data branch (Krippendorff's own
# computation). Where the app reports NO coefficient the script prints its
# reason beside irr's raw value (D40). Record:
# the internal design notes.

ALL_OF_IT = 9592      # applied by every coder on every passage → no_variance
ONE_PASSAGE = 9593    # rated by all three on ONE passage → insufficient_n (D42)
UNUSED_SET = 9610     # a non-exhaustive set nobody chose from: every cell is
UNUSED_MEMBERS = (9611, 9612)  # "none of these" → no_variance


def _seed_three_coders(db, *, gap: bool = False):
    """`_seed` widened to THREE coders who each coded every passage of the
    conversation — so no cell of the per-code, rating or set matrix is blank,
    which is the only shape irr's complete-data branch is taken on.

    With ``gap`` a second conversation is coded by coders 1 and 2 only, so every
    matrix has missing cells: there the workaround must change nothing.
    """
    from app.models.code_set import CodeSet

    user = _seed(db)  # coders 1, 2; Theme A on S0–S3
    db.add(User(id=3, username="Reviewer C", password_hash=None, coder_type="human"))
    for i in range(4, 8):
        db.add(Segment(id=95000 + i, conversation_id=PID, sequence_order=i, text=f"s{i}"))
    db.add(Code(id=ALL_OF_IT, project_id=PID, name="Everywhere", numeric_id=4,
                is_active=True, is_universal=False))
    db.add(Code(id=RATED_CODE, project_id=PID, name="District support", numeric_id=3,
                is_active=True, is_universal=False,
                magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0))
    db.add(Code(id=ONE_PASSAGE, project_id=PID, name="Once", numeric_id=5,
                is_active=True, is_universal=False,
                magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0))
    db.add(CodeSet(id=SET_ID, project_id=PID, label="Teacher stance", exhaustive=False))
    db.add(CodeSet(id=UNUSED_SET, project_id=PID, label="Unused", exhaustive=False))
    db.flush()
    for i, (cid, name) in enumerate(zip(SET_MEMBERS, ("Supportive", "Neutral", "Critical"))):
        db.add(Code(id=cid, project_id=PID, name=name, numeric_id=10 + i,
                    is_active=True, is_universal=False, code_set_id=SET_ID))
    for i, cid in enumerate(UNUSED_MEMBERS):
        db.add(Code(id=cid, project_id=PID, name=f"Unused {i}", numeric_id=20 + i,
                    is_active=True, is_universal=False, code_set_id=UNUSED_SET))
    db.flush()

    segs = [95000 + i for i in range(8)]
    # Theme A for coder 3 (and more for 1 and 2 on the new passages).
    for uid, sids in ((3, (95000, 95002, 95004, 95007)), (1, (95005,)), (2, (95005, 95006))):
        for sid in sids:
            db.add(CodeApplication(code_id=9590, user_id=uid, segment_id=sid))
    for uid in (1, 2, 3):
        for sid in segs:
            db.add(CodeApplication(code_id=ALL_OF_IT, user_id=uid, segment_id=sid))
    ratings = {  # (coder 1, coder 2, coder 3) on the 1–5 scale
        95000: (1, 1, 2), 95001: (2, 3, 2), 95002: (3, 3, 3), 95003: (4, 5, 4),
        95004: (5, 5, 4), 95005: (2, 1, 1), 95006: (3, 4, 5), 95007: (1, 2, 1),
    }
    for sid, values in ratings.items():
        for uid, value in zip((1, 2, 3), values):
            db.add(CodeApplication(code_id=RATED_CODE, user_id=uid, segment_id=sid, magnitude=value))
    for uid, value in zip((1, 2, 3), (2, 3, 4)):
        db.add(CodeApplication(code_id=ONE_PASSAGE, user_id=uid, segment_id=95000, magnitude=value))
    A, B, C = SET_MEMBERS
    choices = {  # None = chose no member → "none of these", a VALUE on this set
        95000: (A, A, A), 95001: (A, B, A), 95002: (B, B, B), 95003: (C, A, C),
        95004: (None, None, B), 95005: (B, C, B), 95006: (C, C, C), 95007: (A, None, A),
    }
    for sid, picks in choices.items():
        for uid, member in zip((1, 2, 3), picks):
            if member is not None:
                db.add(CodeApplication(code_id=member, user_id=uid, segment_id=sid))

    if gap:
        db.add(Conversation(id=PID + 1, project_id=PID, name="Second interview"))
        db.flush()
        for i in range(3):
            db.add(Segment(id=95100 + i, conversation_id=PID + 1, sequence_order=i, text=f"t{i}"))
        db.flush()
        for uid, sid in ((1, 95100), (2, 95100), (1, 95101), (2, 95102)):
            db.add(CodeApplication(code_id=9590, user_id=uid, segment_id=sid))
        for uid, sid, value in ((1, 95100, 2), (2, 95100, 3), (1, 95101, 5), (2, 95101, 4)):
            db.add(CodeApplication(code_id=RATED_CODE, user_id=uid, segment_id=sid, magnitude=value))
        for uid, sid, member in ((1, 95100, A), (2, 95100, B), (1, 95101, C), (2, 95101, C)):
            db.add(CodeApplication(code_id=member, user_id=uid, segment_id=sid))
    db.flush()
    return user


def _old_call_values(db, user) -> dict[str, float]:
    """kripp.alpha over each exported matrix the way the script called it BEFORE
    #1325 — `kripp.alpha(t(m))` — for the discrimination assertion only (this is
    a check on the FIXTURE, not a restatement of the block under test)."""
    raw = asyncio.run(_export_zip_bytes(db, user))
    with tempfile.TemporaryDirectory() as d:
        workdir = Path(d)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            zf.extractall(workdir)
        files = {p.name: p for p in workdir.iterdir()}
        per_code = next(n for n in files if n.endswith("_irr.csv"))
        mag = next(n for n in files if n.endswith("_irr_magnitude.csv"))
        sets = next(n for n in files if n.endswith("_irr_code_sets.csv"))
        runner = workdir / "old.R"
        runner.write_text(f"""
suppressMessages(library(irr)); suppressMessages(library(readr))
one <- function(file, key, method, tag) {{
  d <- read_csv(file, na = "", show_col_types = FALSE)
  cols <- grep("^coder_", names(d), value = TRUE)
  for (k in unique(d[[key]])) {{
    m <- as.matrix(d[d[[key]] == k, cols, drop = FALSE]); storage.mode(m) <- "numeric"
    cat(sprintf("%s %.0f %.8f\\n", tag, k, kripp.alpha(t(m), method = method)$value))
  }}
}}
one("{per_code}", "code_id", "nominal", "code")
one("{mag}", "code_id", "interval", "rating")
one("{sets}", "set_id", "nominal", "set")
""", encoding="utf-8")
        proc = subprocess.run([_RSCRIPT, runner.name], cwd=str(workdir),
                              capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, f"R failed:\n{proc.stderr}"
    out = {}
    for line in proc.stdout.splitlines():
        tag, key, value = line.split()
        out[f"{tag}:{key}"] = float(value)
    return out


def _app_figures(db):
    res = compute_irr(db, PID)
    return (
        {c["code_id"]: c for c in res["per_code"]},
        {c["code_id"]: c for c in res["magnitude_per_code"]},
        {c["set_id"]: c for c in res["set_agreement"]},
    )


def test_the_three_coder_fixture_is_complete(db_session):
    """Always-on: the matrices the script reads really have no blank cell — the
    shape irr's complete-data branch needs. (Not the one-passage rating, which is
    blank wherever nobody rated it, and is there for its reason, not its α.)"""
    import csv as _csv

    user = _seed_three_coders(db_session)
    raw = asyncio.run(_export_zip_bytes(db_session, user))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        texts = {n: zf.read(n).decode("utf-8-sig") for n in zf.namelist() if n.endswith(".csv")}
    for suffix, key, wanted in (("_irr.csv", "code_id", "9590"),
                                ("_irr_magnitude.csv", "code_id", str(RATED_CODE)),
                                ("_irr_code_sets.csv", "set_id", str(SET_ID))):
        text = next(t for n, t in texts.items() if n.endswith(suffix))
        rows = [r for r in _csv.DictReader(io.StringIO(text)) if r[key] == wanted]
        assert len(rows) == 8, f"{suffix}: eight passages"
        coder_cols = [c for c in rows[0] if c.startswith("coder_")]
        assert coder_cols == ["coder_1", "coder_2", "coder_3"]
        assert all(r[c] != "" for r in rows for c in coder_cols), f"{suffix} has a blank cell"


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_the_fixture_could_have_disagreed_with_the_old_call(db_session):
    """#707a's DISCRIMINATION rule: on this fixture the pre-#1325 call prints a
    DIFFERENT α from the app for the code, the rating and the set — so the
    round trip below can tell the fixed call from the broken one."""
    user = _seed_three_coders(db_session)
    per_code, mag, sets = _app_figures(db_session)
    old = _old_call_values(db_session, user)
    for key, app_alpha in (("code:9590", per_code[9590]["krippendorff_alpha"]),
                           (f"rating:{RATED_CODE}", mag[RATED_CODE]["krippendorff_alpha"]),
                           (f"set:{SET_ID}", sets[SET_ID]["krippendorff_alpha"])):
        assert app_alpha is not None
        assert abs(old[key] - app_alpha) > 1e-3, (
            f"{key}: the old call agrees with the app here ({old[key]} vs {app_alpha}), "
            "so this fixture cannot show the workaround matters"
        )


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
@pytest.mark.parametrize("gap", [False, True], ids=["complete", "with-a-gap"])
def test_the_EMITTED_script_reproduces_three_coders(db_session, gap):
    """#1325: the emitted per-code, rating and set sections reproduce the app's α
    on complete three-coder data — and, with a gap (missing cells), still do."""
    user = _seed_three_coders(db_session, gap=gap)
    per_code, mag, sets = _app_figures(db_session)

    got = _emitted_results(db_session, user, IRR_SECTION, "IRR")
    for cid in (9590, *SET_MEMBERS):
        assert got[str(cid)]["reason"] == ""
        assert float(got[str(cid)]["alpha"]) == pytest.approx(per_code.get(cid, {}).get(
            "krippendorff_alpha") or _member_alpha(sets, cid), abs=1e-6)

    got_m = _emitted_results(db_session, user, MAG_SECTION, "IRR_MAGNITUDE")
    assert float(got_m[str(RATED_CODE)]["alpha"]) == pytest.approx(
        mag[RATED_CODE]["krippendorff_alpha"], abs=1e-6)

    got_s = _emitted_results(db_session, user, SET_SECTION, "IRR_CODE_SET")
    assert float(got_s[str(SET_ID)]["alpha"]) == pytest.approx(
        sets[SET_ID]["krippendorff_alpha"], abs=1e-6)


def _member_alpha(sets, code_id):
    """A set member's binary α lives in its set's breakdown, not the per-code table."""
    for s in sets.values():
        for m in s["members"]:
            if m["code_id"] == code_id:
                return m["krippendorff_alpha"]
    raise KeyError(code_id)


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_the_EMITTED_script_says_why_where_the_app_reports_nothing(db_session):
    """D40: a code everybody applied everywhere (`no_variance`) and a rating over
    ONE passage (`insufficient_n`, D42) print alpha=NA with the APP's reason, and
    irr's own value beside it — 1 for no variance, 0 for the one passage."""
    user = _seed_three_coders(db_session)
    per_code, mag, sets = _app_figures(db_session)
    assert per_code[ALL_OF_IT]["undefined_reason"] == "no_variance"
    assert mag[ONE_PASSAGE]["undefined_reason"] == "insufficient_n"
    assert sets[UNUSED_SET]["undefined_reason"] == "no_variance"

    unused = _emitted_results(db_session, user, SET_SECTION, "IRR_CODE_SET")[str(UNUSED_SET)]
    assert unused["alpha"] == "NA" and unused["reason"] == "no_variance"
    assert float(unused["irr_value"]) == pytest.approx(1.0)

    everywhere = _emitted_results(db_session, user, IRR_SECTION, "IRR")[str(ALL_OF_IT)]
    assert everywhere["alpha"] == "NA" and everywhere["kappa"] == "NA"
    assert everywhere["reason"] == "no_variance"
    assert float(everywhere["irr_value"]) == pytest.approx(1.0)

    once = _emitted_results(db_session, user, MAG_SECTION, "IRR_MAGNITUDE")[str(ONE_PASSAGE)]
    assert once["alpha"] == "NA"
    assert once["reason"] == "insufficient_n"
    assert float(once["irr_value"]) == pytest.approx(0.0)


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_two_coders_get_no_kappa_where_the_app_reports_none(db_session):
    """D40 with TWO coders, where the script also prints κ: a code both applied on
    every passage has no κ in the app (`no_variance`), so none in the script —
    while % agreement, which the app keeps, is still printed."""
    user = _seed(db_session)
    db_session.add(Code(id=ALL_OF_IT, project_id=PID, name="Everywhere", numeric_id=4,
                        is_active=True, is_universal=False))
    db_session.flush()
    for uid in (1, 2):
        for sid in range(95000, 95004):
            db_session.add(CodeApplication(code_id=ALL_OF_IT, user_id=uid, segment_id=sid))
    db_session.flush()
    app_row = next(c for c in compute_irr(db_session, PID)["per_code"] if c["code_id"] == ALL_OF_IT)
    assert app_row["cohens_kappa"] is None and app_row["undefined_reason"] == "no_variance"

    fields = _emitted_results(db_session, user, IRR_SECTION, "IRR")[str(ALL_OF_IT)]
    assert fields["kappa"] == "NA"
    assert fields["alpha"] == "NA" and fields["reason"] == "no_variance"
    assert float(fields["agree"]) == pytest.approx(app_row["percent_agreement"], abs=1e-6)


def _seed_one_passage(db):
    """Two coders, ONE passage, disagreeing on a code and on a set's value — the
    case where irr's `kappa2` returns a NUMBER (0) while the app reports no κ
    (`insufficient_n`, #1505 D42). On a no-variance code `kappa2` is NaN, which the
    script prints as NA anyway, so only this shape can show the guard matters (a
    surviving mutant said so)."""
    from app.models.code_set import CodeSet

    db.add(Project(id=PID, name="IRR Export", user_id=1))
    db.flush()
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
    db.add(User(id=2, username="Reviewer B", password_hash=None, coder_type="human"))
    db.add(Conversation(id=PID, project_id=PID, name="Interview"))
    db.add(CodeSet(id=SET_ID, project_id=PID, label="Teacher stance", exhaustive=True))
    db.flush()
    db.add(Segment(id=95000, conversation_id=PID, sequence_order=0, text="s0"))
    db.add(Code(id=9590, project_id=PID, name="Theme A", numeric_id=2, is_active=True, is_universal=False))
    for i, (cid, name) in enumerate(zip(SET_MEMBERS, ("Supportive", "Neutral", "Critical"))):
        db.add(Code(id=cid, project_id=PID, name=name, numeric_id=10 + i,
                    is_active=True, is_universal=False, code_set_id=SET_ID))
    db.flush()
    db.add(CodeApplication(code_id=9590, user_id=1, segment_id=95000))
    db.add(CodeApplication(code_id=SET_MEMBERS[0], user_id=1, segment_id=95000))
    db.add(CodeApplication(code_id=SET_MEMBERS[1], user_id=2, segment_id=95000))
    db.flush()
    return db.get(User, 1)


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
def test_one_passage_prints_no_kappa_although_kappa2_would_give_one(db_session):
    """D40 + D42: over one passage the app has no κ or α (`insufficient_n`) and the
    script prints none — while `kappa2` there returns 0, so the guard is what
    stops a number the app declines. irr_value is the identity (0)."""
    user = _seed_one_passage(db_session)
    res = compute_irr(db_session, PID)
    code = next(c for c in res["per_code"] if c["code_id"] == 9590)
    the_set = next(s for s in res["set_agreement"] if s["set_id"] == SET_ID)
    assert code["undefined_reason"] == "insufficient_n" and code["cohens_kappa"] is None
    assert the_set["undefined_reason"] == "insufficient_n" and the_set["cohens_kappa"] is None

    fields = _emitted_results(db_session, user, IRR_SECTION, "IRR")["9590"]
    assert (fields["alpha"], fields["kappa"], fields["reason"]) == ("NA", "NA", "insufficient_n")
    assert float(fields["irr_value"]) == pytest.approx(0.0)
    assert float(fields["agree"]) == pytest.approx(code["percent_agreement"], abs=1e-6)

    set_fields = _emitted_results(db_session, user, SET_SECTION, "IRR_CODE_SET")[str(SET_ID)]
    assert (set_fields["alpha"], set_fields["kappa"], set_fields["reason"]) == ("NA", "NA", "insufficient_n")


def test_the_reason_vector_takes_only_ids_and_the_vocabulary():
    """#1468's census rule for the one new interpolation: an int key and a known
    reason, each refused otherwise; empty is R's `character(0)`."""
    from app.routers.export_r import _r_reason_vector

    assert _r_reason_vector({}) == "character(0)"
    assert _r_reason_vector({12: "no_variance", 3: "insufficient_n"}) == (
        'c("3" = "insufficient_n", "12" = "no_variance")'
    )
    with pytest.raises(ValueError):
        _r_reason_vector({"12": "no_variance"})
    with pytest.raises(ValueError):
        _r_reason_vector({True: "no_variance"})
    with pytest.raises(ValueError):
        _r_reason_vector({12: 'x"); system("echo'})
