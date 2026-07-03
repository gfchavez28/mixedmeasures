"""Track J · J2-4 — inter-rater reliability (κ / Krippendorff's α / % agreement).

Three layers: (1) pure-math unit tests against hand-computed values; (2) an R
round-trip that runs the SAME matrices through R's `irr` package (the authoritative
check, gated on Rscript+irr); (3) a DB-integration test proving the Option-B
source-level engagement semantics + the roster/universal/consensus exclusions.
"""
import re
import shutil
import subprocess

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.irr import (
    _cohens_kappa,
    _krippendorff_alpha,
    _percent_agreement,
    _prevalence,
    _interpret_kappa,
    _interpret_alpha,
    build_irr_matrices,
    compute_irr,
)
from app.services.consensus import materialize_consensus_for_project


# ── 1. Pure math (hand-computed) ──────────────────────────────────────────────

M_BASIC = [[1, 1], [1, 0], [0, 0], [0, 0]]  # α=0.5333, κ=0.5, %=0.75, prev=0.375


def test_pure_math_hand_values():
    assert _krippendorff_alpha(M_BASIC) == pytest.approx(0.53333, abs=1e-4)
    assert _cohens_kappa(M_BASIC) == pytest.approx(0.5, abs=1e-9)
    assert _percent_agreement(M_BASIC) == pytest.approx(0.75, abs=1e-9)
    assert _prevalence(M_BASIC) == pytest.approx(0.375, abs=1e-9)


def test_pure_math_perfect_and_missing():
    assert _krippendorff_alpha([[1, 1], [0, 0], [1, 1]]) == 1.0
    assert _cohens_kappa([[1, 1], [0, 0], [1, 1]]) == 1.0
    # missing tolerated: only the present pairs are compared (all agree here)
    assert _krippendorff_alpha([[1, 1, None], [0, None, 0], [1, 1, 1]]) == 1.0
    # a unit with <2 present contributes nothing
    assert _krippendorff_alpha([[1, None], [0, 0], [1, 1]]) == 1.0


def test_interpretation_bands():
    assert _interpret_kappa(0.85) == "almost_perfect"
    assert _interpret_kappa(0.5) == "moderate"
    assert _interpret_kappa(-0.1) == "poor"
    assert _interpret_kappa(None) is None
    assert _interpret_alpha(0.85) == "reliable"
    assert _interpret_alpha(0.70) == "tentative"
    assert _interpret_alpha(0.40) == "unreliable"


# ── 2. R round-trip (authoritative — irr::kripp.alpha / kappa2 / agree) ────────

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


def _r_irr(rows: list[list], n: int) -> dict:
    """Run rows (units × coders, None→NA) through R's irr; return {alpha,kappa,agree}."""
    vals = ",".join("NA" if v is None else str(v) for row in rows for v in row)
    script = f"""
suppressMessages(library(irr))
m <- matrix(c({vals}), nrow={len(rows)}, ncol={n}, byrow=TRUE)
cat("alpha", kripp.alpha(t(m), method="nominal")$value, "\\n")
if (ncol(m) == 2) {{
  dc <- m[stats::complete.cases(m), , drop=FALSE]
  if (nrow(dc) > 0) {{
    cat("kappa", kappa2(dc)$value, "\\n")
    cat("agree", agree(dc)$value/100, "\\n")
  }}
}}
"""
    out = subprocess.run([_RSCRIPT, "-e", script], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    result = {}
    for m in re.finditer(r"^(alpha|kappa|agree)\s+([-\d.eE+]+)\s*$", out.stdout, re.MULTILINE):
        result[m.group(1)] = float(m.group(2))
    return result


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
@pytest.mark.parametrize("rows,n", [
    (M_BASIC, 2),
    ([[1, 1], [1, 0], [1, 0]], 2),                       # Option-B decisive: κ=0
    ([[1, 1, 1], [1, 0, None], [0, 0, 0], [1, None, 1], [0, 0, 1]], 3),  # missing, α only
])
def test_irr_matches_r(rows, n):
    r = _r_irr(rows, n)
    assert _krippendorff_alpha(rows) == pytest.approx(r["alpha"], abs=1e-6)
    if n == 2:
        assert _cohens_kappa(rows) == pytest.approx(r["kappa"], abs=1e-6)
        assert _percent_agreement(rows) == pytest.approx(r["agree"], abs=1e-6)


# ── 3. DB integration — Option-B semantics + exclusions ───────────────────────


def _coder(db, uid, name):
    db.add(User(id=uid, username=name, password_hash=None, coder_type="human"))
    db.flush()


def _seg(db, sid, conv_id, order):
    db.add(Segment(id=sid, conversation_id=conv_id, sequence_order=order, text="x"))
    db.flush()


def _apply(db, code_id, uid, *, segment_id=None, value_id=None):
    db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=segment_id, dataset_value_id=value_id))
    db.flush()


def test_compute_irr_option_b_catches_disagreement(db_session):
    """The decisive example: Alice tags S1/S2/S3, Bob tags only S1 but ENGAGED the
    conversation (coded S1) → under Option B, S2/S3 are real Bob=0 disagreements,
    NOT dropped. So this is NOT 'perfect agreement'."""
    db = db_session
    pid = 70
    db.add_all([Project(id=pid, name="P", user_id=1), Conversation(id=pid, project_id=pid, name="T")])
    db.flush()
    _coder(db, 2, "Bob")
    for sid in (7001, 7002, 7003):
        _seg(db, sid, pid, sid)
    db.add(Code(id=7090, project_id=pid, name="Frustration", numeric_id=2, is_active=True, is_universal=False))
    db.flush()
    for sid in (7001, 7002, 7003):
        _apply(db, 7090, 1, segment_id=sid)   # Alice: all three
    _apply(db, 7090, 2, segment_id=7001)      # Bob: only S1 (but engaged T)

    res = compute_irr(db, pid)
    assert res["available"] is True and res["n_coders"] == 2
    code = next(c for c in res["per_code"] if c["code_id"] == 7090)
    assert code["n_units"] == 3, "all 3 segments are in play (Option B)"
    assert code["percent_agreement"] == pytest.approx(1 / 3, abs=1e-9)
    assert code["cohens_kappa"] == pytest.approx(0.0, abs=1e-9), "chance-level, not perfect"


def test_compute_irr_excludes_single_coder_sources(db_session):
    """A conversation only one coder engaged contributes no units (Option B:
    'implicit absence' = excluded, like a skipped survey)."""
    db = db_session
    pid = 71
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Conversation(id=pid, project_id=pid, name="T1"),
        Conversation(id=pid + 500, project_id=pid, name="T2"),
    ])
    db.flush()
    _coder(db, 2, "Bob")
    _seg(db, 7101, pid, 0)        # T1
    _seg(db, 7102, pid + 500, 0)  # T2 — only Alice will engage
    db.add(Code(id=7190, project_id=pid, name="X", numeric_id=2, is_active=True, is_universal=False))
    db.flush()
    _apply(db, 7190, 1, segment_id=7101)  # both engage T1
    _apply(db, 7190, 2, segment_id=7101)
    _apply(db, 7190, 1, segment_id=7102)  # only Alice engages T2

    res = compute_irr(db, pid)
    code = next(c for c in res["per_code"] if c["code_id"] == 7190)
    assert code["n_units"] == 1, "only the shared conversation T1 contributes"


def test_compute_irr_excludes_universal_and_consensus(db_session):
    db = db_session
    pid = 72
    db.add_all([Project(id=pid, name="P", user_id=1), Conversation(id=pid, project_id=pid, name="T")])
    db.flush()
    _coder(db, 2, "Bob")
    _seg(db, 7201, pid, 0)
    db.add_all([
        Code(id=7290, project_id=pid, name="Theme", numeric_id=2, is_active=True, is_universal=False),
        Code(id=7299, project_id=pid, name="Unclear", numeric_id=1, is_active=True, is_universal=True),
    ])
    db.flush()
    _apply(db, 7290, 1, segment_id=7201)
    _apply(db, 7290, 2, segment_id=7201)
    _apply(db, 7299, 1, segment_id=7201)  # universal — must not appear
    _apply(db, 7299, 2, segment_id=7201)
    materialize_consensus_for_project(db, pid)  # creates an origin='consensus' row

    res = compute_irr(db, pid)
    code_ids = {c["code_id"] for c in res["per_code"]}
    assert 7290 in code_ids and 7299 not in code_ids, "universal excluded"
    assert res["n_coders"] == 2, "consensus user is NOT counted as a rater"


def test_compute_irr_text_coding_units(db_session):
    """Dataset-value (open-ended) coding contributes too (Decision 3)."""
    db = db_session
    pid = 73
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Dataset(id=pid, project_id=pid, name="Survey"),
    ])
    db.flush()
    db.add(DatasetColumn(id=7300, dataset_id=pid, column_code="Q1", column_name="Q1",
                         column_text="Open?", column_type="open_text", sequence_order=0, display_order=0))
    db.add(DatasetRow(id=7300, dataset_id=pid))
    db.add(DatasetRow(id=7301, dataset_id=pid))
    db.flush()
    db.add(DatasetValue(id=7300, row_id=7300, column_id=7300, value_text="great"))
    db.add(DatasetValue(id=7301, row_id=7301, column_id=7300, value_text="bad"))
    db.flush()
    _coder(db, 2, "Bob")
    db.add(Code(id=7390, project_id=pid, name="Sentiment", numeric_id=2, is_active=True, is_universal=False))
    db.flush()
    _apply(db, 7390, 1, value_id=7300)  # both code value 7300
    _apply(db, 7390, 2, value_id=7300)
    _apply(db, 7390, 1, value_id=7301)  # only Alice codes 7301 (but both engaged the column)

    res = compute_irr(db, pid)
    assert res["available"] is True
    code = next(c for c in res["per_code"] if c["code_id"] == 7390)
    assert code["n_units"] == 2, "both non-empty values in the shared column are in play"


def test_compute_irr_single_coder_unavailable(db_session):
    db = db_session
    pid = 74
    db.add_all([Project(id=pid, name="P", user_id=1), Conversation(id=pid, project_id=pid, name="T")])
    db.flush()
    _seg(db, 7401, pid, 0)
    db.add(Code(id=7490, project_id=pid, name="X", numeric_id=2, is_active=True, is_universal=False))
    db.flush()
    _apply(db, 7490, 1, segment_id=7401)  # only the default coder

    res = compute_irr(db, pid)
    assert res["available"] is False and res["n_coders"] == 1


def test_equivalence_group_codes_agree(db_session):
    """Effective-code resolution: two coders applying grouped synonyms agree."""
    db = db_session
    pid = 75
    db.add_all([Project(id=pid, name="P", user_id=1), Conversation(id=pid, project_id=pid, name="T")])
    db.flush()
    _coder(db, 2, "Bob")
    _seg(db, 7501, pid, 0)
    db.add(CodeEquivalenceGroup(id=750, project_id=pid, label="pos", canonical_code_id=7590))
    db.flush()
    db.add_all([
        Code(id=7590, project_id=pid, name="Positive", numeric_id=2, is_active=True, is_universal=False, code_equivalence_group_id=750),
        Code(id=7591, project_id=pid, name="POSITIVE", numeric_id=3, is_active=True, is_universal=False, code_equivalence_group_id=750),
    ])
    db.flush()
    _apply(db, 7590, 1, segment_id=7501)  # Alice: Positive
    _apply(db, 7591, 2, segment_id=7501)  # Bob: POSITIVE (≡ via group)

    res = compute_irr(db, pid)
    # Both resolve to canonical 7590 → one code, perfect agreement on the one unit.
    assert {c["code_id"] for c in res["per_code"]} == {7590}
    code = res["per_code"][0]
    assert code["percent_agreement"] == 1.0
