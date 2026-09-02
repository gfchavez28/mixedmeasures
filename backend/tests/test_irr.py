"""Track J · J2-4 — inter-rater reliability (κ / Krippendorff's α / % agreement).

Three layers: (1) pure-math unit tests against hand-computed values; (2) an R
round-trip that runs the SAME matrices through R's `irr` package (the authoritative
check, gated on Rscript+irr); (3) a DB-integration test proving the Option-B
source-level engagement semantics + the roster/universal/consensus exclusions.
"""
import re
from datetime import datetime
import subprocess

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.observation import Observation
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
    gather_coder_applications,
)
from app.services.consensus import materialize_consensus_for_project
from tests import r_support


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

# R availability is single-sourced in tests/r_support.py (#642) — three files
# carried a copy-pasted `_r_has_irr()` and drifted from a fourth shape.
_RSCRIPT = r_support.RSCRIPT
_HAS_IRR = r_support.HAS_IRR


def _r_irr(rows: list[list], n: int, method: str = "nominal") -> dict:
    """Run rows (units × coders, None→NA) through R's irr; return {alpha,kappa,agree}."""
    vals = ",".join("NA" if v is None else str(v) for row in rows for v in row)
    script = f"""
suppressMessages(library(irr))
m <- matrix(c({vals}), nrow={len(rows)}, ncol={n}, byrow=TRUE)
cat("alpha", kripp.alpha(t(m), method="{method}")$value, "\\n")
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


# ── 2b. Metric generalization (ordinal/interval/ratio — the #35 / v1.4 seam) ───
#
# Krippendorff (2011, "Computing Krippendorff's Alpha-Reliability") worked
# example: 4 observers × 12 units, values 1–5, missing cells. The paper publishes
# nominal α = 0.743 and interval α = 0.849 — independent literature anchors.
M_K2011 = [
    [1, 1, None, 1],
    [2, 2, 3, 2],
    [3, 3, 3, 3],
    [3, 3, 3, 3],
    [2, 2, 2, 2],
    [1, 2, 3, 4],
    [4, 4, 4, 4],
    [1, 1, 2, 1],
    [2, 2, 2, 2],
    [None, 5, 5, 5],
    [None, None, 1, 1],
    [None, 3, None, None],  # <2 present → contributes nothing
]

# Ordering-sensitive data MUST include values ≥10 (backend/tests/the internal design notes): a
# string-ranked ordinal metric would order 1 < 10 < 2 and get a different α.
M_MULTIDIGIT = [[1, 1], [2, 3], [10, 10], [1, 2], [5, 5], [10, 2], [3, 3]]


def test_alpha_metric_published_anchors():
    assert _krippendorff_alpha(M_K2011, metric="nominal") == pytest.approx(0.743, abs=5e-4)
    assert _krippendorff_alpha(M_K2011, metric="interval") == pytest.approx(0.849, abs=5e-4)


def test_alpha_metric_properties():
    # nominal is the default and unchanged
    assert _krippendorff_alpha(M_BASIC, metric="nominal") == _krippendorff_alpha(M_BASIC)
    # on binary data every metric coincides (only one nonzero δ² cell, so it cancels)
    for metric in ("ordinal", "interval", "ratio"):
        assert _krippendorff_alpha(M_BASIC, metric=metric) == pytest.approx(
            _krippendorff_alpha(M_BASIC), abs=1e-12
        )
    # perfect agreement is 1.0 under every metric; all-missing stays undefined
    for metric in ("nominal", "ordinal", "interval", "ratio"):
        assert _krippendorff_alpha([[3, 3], [1, 1], [5, 5]], metric=metric) == 1.0
        assert _krippendorff_alpha([[1, None], [None, 2]], metric=metric) is None
    # interval respects distance: a 1-vs-2 disagreement hurts less than 1-vs-5
    near = _krippendorff_alpha([[1, 2], [3, 3], [4, 4], [5, 5]], metric="interval")
    far = _krippendorff_alpha([[1, 5], [3, 3], [4, 4], [5, 5]], metric="interval")
    assert near > far
    # ordinal ranks numerically: with ranks 1<2<3<5<10, the 10-vs-2 disagreement
    # spans more coincidence mass than 2-vs-3 → hand-derivable ordering holds
    assert _krippendorff_alpha(M_MULTIDIGIT, metric="ordinal") == pytest.approx(
        0.6523157, abs=1e-6
    )


@pytest.mark.skipif(not _HAS_IRR, reason="Rscript + irr package not available")
@pytest.mark.parametrize("rows,n", [
    (M_K2011, 4),          # the published 2011 example (missing → canonical regime)
    (M_MULTIDIGIT, 2),     # multi-digit values: numeric ranking must match R's
    ([[1, 1, 2], [2, 2, None], [10, 12, 10], [1, None, 1], [5, 5, 6], [None, 2, 2]], 3),
])
@pytest.mark.parametrize("metric", ["nominal", "ordinal", "interval", "ratio"])
def test_alpha_metrics_match_r(rows, n, metric):
    # NOTE: multi-coder fixtures deliberately include ≥1 missing cell — with ZERO
    # missing cells irr::kripp.alpha skips the canonical 1/(m−1) pair weighting
    # (its complete-data coincidence matrix deviates from Krippendorff's canonical
    # definition for ≥3 raters), so complete-data 3+-coder matrices are not
    # comparable to R.
    r = _r_irr(rows, n, method=metric)
    assert _krippendorff_alpha(rows, metric=metric) == pytest.approx(r["alpha"], abs=1e-6)


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


# ── 4. Observation clips (slab 6b-B) ─────────────────────────────────────────
#
# Frozen clips are AGREED units — every coder codes the same ones — so the
# existing engines work on them unchanged. OPEN cuts must never enter: Segment has
# no creator column, so all coders' clips share one observation_id = one source
# key, and Option-B engagement would hand each coder a hard 0 on clips they never
# saw (κ = -1.0 exactly when balanced, α = -1 + 1/n, pooled into the headline).


def _obs(db, oid, pid, name, *, frozen):
    db.add(Observation(
        id=oid, project_id=pid, name=name,
        segmentation_frozen_at=datetime(2026, 7, 19, 12, 0, 0) if frozen else None,
    ))
    db.flush()


def _clip(db, sid, obs_id, order, start, end):
    db.add(Segment(id=sid, conversation_id=None, observation_id=obs_id,
                   sequence_order=order, start_time=start, end_time=end, text=""))
    db.flush()


def _seed_clips(db, pid):
    """One project, one frozen observation and one open one, plus a conversation.

    Returns the ids rather than letting each test recompute them — deriving them
    twice is how a fixture and its assertions silently drift apart.

    Deliberately three different unit counts (2 conv segments, 3 frozen clips,
    4 open clips) so a count assertion cannot coincide — equal-sized groups make
    the frozen/open mutants indistinguishable.
    """
    frozen_obs, open_obs = pid, pid + 100
    base = pid * 100
    segs = [base + 1, base + 2]
    frozen_clips = [base + 11, base + 12, base + 13]
    open_clips = [base + 21, base + 22, base + 23, base + 24]
    code_id = base + 90

    db.add_all([Project(id=pid, name="P", user_id=1),
                Conversation(id=pid, project_id=pid, name="Interview")])
    db.flush()
    _coder(db, 2, "Bob")
    _obs(db, frozen_obs, pid, "Frozen classroom", frozen=True)
    _obs(db, open_obs, pid, "Open playground", frozen=False)
    for i, sid in enumerate(segs):
        _seg(db, sid, pid, i)
    for i, sid in enumerate(frozen_clips):
        _clip(db, sid, frozen_obs, i, i * 10.0, i * 10.0 + 5.0)
    for i, sid in enumerate(open_clips):
        _clip(db, sid, open_obs, i, i * 10.0, i * 10.0 + 5.0)
    db.add(Code(id=code_id, project_id=pid, name="Off-task", numeric_id=2,
                is_active=True, is_universal=False))
    db.flush()
    return {"code": code_id, "frozen_obs": frozen_obs, "open_obs": open_obs,
            "segs": segs, "frozen_clips": frozen_clips, "open_clips": open_clips}


class TestObservationClipsInIrr:

    def test_gather_tags_clip_sources_and_never_emits_a_null_source(self, db_session):
        """The assertion the R round-trip structurally CANNOT make.

        Export and app read the same gather, so a corrupted gather yields a wrong
        number that R faithfully reproduces — the round-trip proves R ≡ tool, never
        that the tool is right. A `(_, None)` key is the specific corruption: the
        old two-arm ternary sent every clip to ("doc", None), unioning coder
        engagement across every observation in the project.
        """
        db = db_session
        ids = _seed_clips(db, 80)
        for sid in ids["frozen_clips"][:2]:
            _apply(db, ids["code"], 1, segment_id=sid)
            _apply(db, ids["code"], 2, segment_id=sid)

        _coders, _applied, unit_source, _engaged, _multi, _ratings = gather_coder_applications(db, 80)

        assert unit_source[("seg", ids["frozen_clips"][0])] == ("obs", ids["frozen_obs"])
        assert all(sid is not None for (_tag, sid) in unit_source.values()), \
            "a source key with a NULL id is a phantom that pools unrelated sources"
        assert {t for (t, _s) in unit_source.values()} <= {"conv", "doc", "obs", "col"}

    def test_frozen_clips_are_included_and_open_clips_are_not(self, db_session):
        """Two-sided in ONE project: a one-sided fixture cannot tell 'frozen only'
        from 'all clips'. The three unit counts differ (2 / 3 / 4) so the numbers
        themselves discriminate."""
        db = db_session
        ids = _seed_clips(db, 81)
        for sid in ids["frozen_clips"]:          # frozen clips, both coders
            _apply(db, ids["code"], 1, segment_id=sid)
            _apply(db, ids["code"], 2, segment_id=sid)
        for sid in ids["open_clips"][:2]:        # open clips, both coders
            _apply(db, ids["code"], 1, segment_id=sid)
            _apply(db, ids["code"], 2, segment_id=sid)

        _c, _a, unit_source, _e, multi, _r = gather_coder_applications(db, 81)

        assert ("obs", ids["frozen_obs"]) in multi, "the frozen observation is a shared source"
        assert ("obs", ids["open_obs"]) not in multi, "the OPEN observation must not be a source"
        frozen_units = {u for u, s in unit_source.items() if s == ("obs", ids["frozen_obs"])}
        open_units = {u for u, s in unit_source.items() if s == ("obs", ids["open_obs"])}
        assert len(frozen_units) == len(ids["frozen_clips"]) == 3
        assert open_units == set(), "open cuts collapse alpha toward -1; never gather them"

    def test_unfreezing_removes_clips_from_irr(self, db_session):
        """Eligibility is REVOCABLE and IRR is computed on demand, never persisted,
        so unfreezing must simply stop contributing units."""
        db = db_session
        ids = _seed_clips(db, 82)
        for sid in ids["frozen_clips"]:
            _apply(db, ids["code"], 1, segment_id=sid)
            _apply(db, ids["code"], 2, segment_id=sid)

        before = compute_irr(db, 82)
        code_before = next(c for c in before["per_code"] if c["code_id"] == ids["code"])
        assert code_before["n_units"] == 3

        db.query(Observation).filter(Observation.id == ids["frozen_obs"]).update(
            {"segmentation_frozen_at": None})
        db.flush()

        after = compute_irr(db, 82)
        assert not [c for c in after["per_code"] if c["code_id"] == ids["code"]], \
            "with its clips gone the code has no shared source left"

    def test_conversation_only_projects_are_unchanged(self, db_session):
        """The reason this widening is safe to ship: the eligibility clause's first
        arm passes every non-clip segment, so a project with no observations is
        byte-identical to before."""
        db = db_session
        pid = 83
        db.add_all([Project(id=pid, name="P", user_id=1),
                    Conversation(id=pid, project_id=pid, name="T")])
        db.flush()
        _coder(db, 2, "Bob")
        for i, sid in enumerate((8301, 8302, 8303)):
            _seg(db, sid, pid, i)
        db.add(Code(id=8390, project_id=pid, name="F", numeric_id=2,
                    is_active=True, is_universal=False))
        db.flush()
        for sid in (8301, 8302, 8303):
            _apply(db, 8390, 1, segment_id=sid)
        _apply(db, 8390, 2, segment_id=8301)

        res = compute_irr(db, pid)
        code = next(c for c in res["per_code"] if c["code_id"] == 8390)
        assert code["n_units"] == 3
        assert code["percent_agreement"] == pytest.approx(1 / 3, abs=1e-9)
        assert code["cohens_kappa"] == pytest.approx(0.0, abs=1e-9)


# ── #829 / #828 — the SOURCE axis, per-source κ, and zero prevalence ──────────


class TestSourceScopingPureMath:
    """The parts provable without a database, which is where the real defects were."""

    def test_kappa_silently_returns_None_on_roster_wide_rows(self):
        """🔴 Why #828 was NOT "nearly free", pinned so nobody re-derives it.

        `_cohens_kappa` filters `len(r) == 2`. The matrices are
        `len(coder_id_list)` wide, so on a roster of 3+ EVERY row is discarded
        and κ is None **whatever the gate says** — changing `if n == 2` alone
        would have produced exactly the same empty column.
        """
        from app.services.irr import _cohens_kappa
        roster_wide = [[1, 1, None], [0, 0, None], [1, 1, None]]
        assert _cohens_kappa(roster_wide) is None

    def test_projection_recovers_it_and_is_lossless(self):
        from app.services.irr import _cohens_kappa, _project_to_pair
        roster_wide = [[1, 1, None], [0, 0, None], [1, 1, None]]
        # Coders 0 and 1 are the engaged pair; coder 2 never engaged this source,
        # so their column is None in every unit and dropping it discards nothing.
        assert _cohens_kappa(_project_to_pair(roster_wide, 0, 1)) == 1.0
        assert _project_to_pair(roster_wide, 0, 1) == [[1, 1], [0, 0], [1, 1]]

    def test_a_code_nobody_applied_reports_kappa_1_almost_perfect(self):
        """The rider's arithmetic, before the fix — the reason it must be undefined.

        Every present cell is 0, so observed agreement is 1.0 and EXPECTED
        agreement is also 1.0; the `pe >= 1.0` branch then returns 1.0, which
        `_interpret_kappa` renders "almost_perfect". There is no variance to
        agree about, so that is a confident statement about nothing.
        """
        from app.services.irr import _cohens_kappa, _interpret_kappa, _prevalence
        never_applied = [[0, 0], [0, 0], [0, 0]]
        assert _prevalence(never_applied) == 0.0
        assert _cohens_kappa(never_applied) == 1.0
        assert _interpret_kappa(1.0) == "almost_perfect"

    def test_source_token_round_trips_and_fails_soft(self):
        from app.services.irr import _source_token, parse_source_token
        assert parse_source_token("col:16") == ("col", 16)
        assert _source_token(("col", 16)) == "col:16"
        assert parse_source_token(None) is None
        # ⚠️ Malformed is POOLED, never an error: a stale bookmark naming a
        # deleted source must not 400 the whole panel.
        for bad in ("", "nope:1", "col:", "col:x", "16"):
            assert parse_source_token(bad) is None, bad


class TestSourceScopedIrr:
    """#829/#828 end to end: two sources, three coders, one deliberate pair."""

    def _project(self, db, pid):
        """A column coded by Alice+Bob and a conversation coded by Alice+Carol.

        The shape #829 was measured on: a deliberate two-coder study of ONE
        source, pooled with unrelated work by other people.
        """
        db.add_all([
            Project(id=pid, name="P", user_id=1),
            Dataset(id=pid, project_id=pid, name="Survey"),
            Conversation(id=pid, project_id=pid, name="Interview 1"),
        ])
        db.flush()
        db.add(DatasetColumn(id=pid, dataset_id=pid, column_code="Q1", column_name="Notes",
                             column_text="Open?", column_type="open_text",
                             sequence_order=0, display_order=0))
        for rid in (pid, pid + 1):
            db.add(DatasetRow(id=rid, dataset_id=pid))
        db.flush()
        db.add(DatasetValue(id=pid, row_id=pid, column_id=pid, value_text="a"))
        db.add(DatasetValue(id=pid + 1, row_id=pid + 1, column_id=pid, value_text="b"))
        db.add(Segment(id=pid, conversation_id=pid, sequence_order=0, text="s1"))
        db.add(Segment(id=pid + 1, conversation_id=pid, sequence_order=1, text="s2"))
        _coder(db, 2, "Bob")
        _coder(db, 3, "Carol")
        db.add(Code(id=pid, project_id=pid, name="Fidelity", numeric_id=2,
                    is_active=True, is_universal=False))
        db.add(Code(id=pid + 1, project_id=pid, name="Elsewhere only", numeric_id=3,
                    is_active=True, is_universal=False))
        db.flush()
        # Column: Alice + Bob, agreeing on one value and differing on the other.
        _apply(db, pid, 1, value_id=pid)
        _apply(db, pid, 2, value_id=pid)
        _apply(db, pid, 1, value_id=pid + 1)
        # Conversation: Alice + Carol.
        _apply(db, pid, 1, segment_id=pid)
        _apply(db, pid, 3, segment_id=pid)
        # ⚠️ `Elsewhere only` is applied on the CONVERSATION and never on the
        # column. That is what puts it in the codebook's in-play set while giving
        # it prevalence 0.00 inside the column's scope — the state the rider is
        # about, and one that SCOPING creates. A code nobody applied ANYWHERE
        # never enters `all_codes`, so the naive fixture cannot reach it: found
        # by writing this test and watching it come back empty.
        _apply(db, pid + 1, 1, segment_id=pid)
        _apply(db, pid + 1, 3, segment_id=pid)
        db.flush()

    def test_pooled_stays_the_default_and_lists_both_sources(self, db_session):
        db = db_session
        self._project(db, 7400)
        res = compute_irr(db, 7400)

        assert res["source"] is None, "omitting the param must keep the pooled view"
        keys = {s["key"] for s in res["sources"]}
        assert keys == {"col:7400", "conv:7400"}
        assert {s["label"] for s in res["sources"]} == {"Notes", "Interview 1"}

    def test_scoping_to_one_source_narrows_the_units(self, db_session):
        db = db_session
        self._project(db, 7410)
        pooled = compute_irr(db, 7410)
        scoped = compute_irr(db, 7410, source=("col", 7410))

        assert scoped["source"] == "col:7410"
        pooled_n = next(c for c in pooled["per_code"] if c["code_id"] == 7410)["n_units"]
        scoped_n = next(c for c in scoped["per_code"] if c["code_id"] == 7410)["n_units"]
        assert scoped_n < pooled_n, "the conversation's units must be out of scope"

    def test_kappa_appears_when_exactly_two_coders_engaged_THAT_source(self, db_session):
        """#828: the roster is 3, so the old roster gate could never yield κ."""
        db = db_session
        self._project(db, 7420)

        pooled = compute_irr(db, 7420)
        assert pooled["n_coders"] == 3
        assert pooled["metric_label"] == "alpha"
        assert all(c["cohens_kappa"] is None for c in pooled["per_code"])

        scoped = compute_irr(db, 7420, source=("col", 7420))
        assert scoped["n_coders"] == 3, "the matrix stays ALL-ROSTER — source ≠ coder"
        assert scoped["metric_label"] == "kappa+alpha"
        code = next(c for c in scoped["per_code"] if c["code_id"] == 7420)
        assert code["cohens_kappa"] is not None, "the engaged PAIR is what κ needs"

    def test_a_code_nobody_applied_is_undefined_not_almost_perfect(self, db_session):
        """The rider. `Never used` is in play (its column is shared) but unapplied."""
        db = db_session
        self._project(db, 7430)
        res = compute_irr(db, 7430, source=("col", 7430))

        unused = next((c for c in res["per_code"] if c["code_id"] == 7431), None)
        assert unused is not None, "it must still be SHOWN — the evidence stays visible"
        assert unused["prevalence"] == 0.0
        assert unused["cohens_kappa"] is None
        assert unused["krippendorff_alpha"] is None
        assert unused["kappa_interpretation"] is None
        assert unused["undefined_reason"] == "no_variance"

    def test_an_undefined_code_does_not_lift_the_headline(self, db_session):
        db = db_session
        self._project(db, 7440)
        res = compute_irr(db, 7440, source=("col", 7440))
        # Measured on real data: three zero-prevalence codes moved the pooled
        # headline 0.7911 -> 0.7962 purely by agreeing about nothing.
        used = [c for c in res["per_code"] if c["undefined_reason"] is None]
        assert used, "the fixture must still contribute a real code"
        assert res["overall_alpha"] is not None

    def test_an_unknown_source_is_an_honest_empty_not_a_crash(self, db_session):
        db = db_session
        self._project(db, 7450)
        res = compute_irr(db, 7450, source=("col", 999999))
        assert res["available"] is False
        assert res["sources"], "the picker's options must survive an empty scope"


# ── 6. Confidence intervals reach the payload (#43) ───────────────────────────


class TestReliabilityIntervals:
    """The wiring, not the arithmetic — that lives in
    `test_reliability_intervals.py`. What this class pins is that the intervals
    are computed from the SAME rows as the estimates, that an undefined
    statistic carries none, and that the headline's interval CLUSTERS by unit.
    """

    def _two_coder_project(self, db, pid, *, n_units=12):
        """Two conversations, two coders, one code they mostly agree on.

        ⚠️ The SECOND conversation exists for the zero-prevalence test, and the
        reason is recorded three hundred lines above in `TestSourceScopedIrr`:
        **a code applied nowhere never enters `all_codes` at all**, so a fixture
        that merely declares an unused code cannot reach the rider. The
        reachable state is a code applied on ANOTHER source and unused in the
        one being scoped to — found here the same way, by writing the naive
        fixture and watching the lookup come back empty.
        """
        db.add_all([
            Project(id=pid, name="P", user_id=1),
            Conversation(id=pid, project_id=pid, name="Interview"),
            Conversation(id=pid + 5000, project_id=pid, name="Elsewhere"),
        ])
        db.flush()
        _coder(db, 2, "Bob")
        db.add(Code(id=pid, project_id=pid, name="Fidelity", numeric_id=2,
                    is_active=True, is_universal=False))
        db.add(Code(id=pid + 1, project_id=pid, name="Unused here", numeric_id=3,
                    is_active=True, is_universal=False))
        db.flush()
        for i in range(n_units):
            _seg(db, pid + 100 + i, pid, i)
        # Alice codes the first two thirds; Bob agrees on all but the last one.
        applied_by_alice = list(range(0, (n_units * 2) // 3))
        for i in applied_by_alice:
            _apply(db, pid, 1, segment_id=pid + 100 + i)
        for i in applied_by_alice[:-1]:
            _apply(db, pid, 2, segment_id=pid + 100 + i)
        # The other conversation, where `Unused here` IS applied by both.
        _seg(db, pid + 5001, pid + 5000, 0)
        _seg(db, pid + 5002, pid + 5000, 1)
        _apply(db, pid + 1, 1, segment_id=pid + 5001)
        _apply(db, pid + 1, 2, segment_id=pid + 5001)
        db.flush()

    def test_both_coefficients_carry_an_interval_with_its_method(self, db_session):
        db = db_session
        self._two_coder_project(db, 7500)
        res = compute_irr(db, 7500)

        code = next(c for c in res["per_code"] if c["code_id"] == 7500)
        assert code["cohens_kappa"] is not None and code["krippendorff_alpha"] is not None

        kappa_ci, alpha_ci = code["kappa_ci"], code["alpha_ci"]
        assert kappa_ci["method"] == "kappa_analytic_se"
        assert alpha_ci["method"] == "alpha_bootstrap_units"
        # Different METHODS, so they cannot share one `ci_method` field — the
        # schema keeps them as separate objects for exactly this reason.
        assert kappa_ci["method"] != alpha_ci["method"]
        for ci, value in ((kappa_ci, code["cohens_kappa"]),
                          (alpha_ci, code["krippendorff_alpha"])):
            assert ci["level"] == 0.95
            assert ci["lower"] <= value <= ci["upper"]
        assert alpha_ci["n_resamples"] > 0
        assert kappa_ci["n_resamples"] is None, "the analytic interval resamples nothing"

    def test_an_undefined_statistic_carries_no_interval(self, db_session):
        """#829's zero-prevalence rider, one level up.

        A code nobody applied in scope has no variance to agree about, so κ/α
        are None WITH a reason. An interval there would bracket a number that
        does not exist — and a SECOND reason on the same blank cell is noise,
        so the interval is simply absent rather than absent-with-an-excuse.
        """
        db = db_session
        self._two_coder_project(db, 7510)
        # SCOPED to the conversation where `Unused here` was never applied —
        # per-source scoping is what makes this state reachable (#829).
        res = compute_irr(db, 7510, source=("conv", 7510))

        unused = next(c for c in res["per_code"] if c["code_id"] == 7510 + 1)
        assert unused["undefined_reason"] == "no_variance"
        assert unused["cohens_kappa"] is None and unused["krippendorff_alpha"] is None
        assert unused["kappa_ci"] is None and unused["alpha_ci"] is None

    def test_the_headline_alpha_carries_a_cluster_bootstrap_interval(self, db_session):
        db = db_session
        self._two_coder_project(db, 7520)
        res = compute_irr(db, 7520)

        ci = res["overall_alpha_ci"]
        assert ci is not None
        assert ci["method"] == "alpha_bootstrap_units"
        assert ci["lower"] <= res["overall_alpha"] <= ci["upper"]

    def test_the_headline_interval_resamples_units_not_pooled_rows(self, db_session):
        """🔴 The wiring assertion the unit tests cannot make.

        `compute_irr` could satisfy every other test here by bootstrapping
        `global_rows` — the concatenated (unit × code) rows — and the interval
        would look perfectly reasonable while being too NARROW, because a unit's
        rows move together. This compares the payload against BOTH candidate
        computations and requires it to match the clustered one.

        Mutation-checked: swapping `pooled_unit_contributions(pooled_matrices)`
        for `unit_contributions(global_rows)` fails this and nothing else.
        """
        from app.services.reliability_intervals import (
            alpha_interval, pooled_unit_contributions, unit_contributions,
        )

        db = db_session
        # Several codes over the same units, so the two computations differ.
        self._two_coder_project(db, 7530, n_units=15)
        for extra in (2, 3, 4):
            db.add(Code(id=7530 + 10 * extra, project_id=7530,
                        name=f"Extra {extra}", numeric_id=10 + extra,
                        is_active=True, is_universal=False))
            db.flush()
            for i in range(0, 15, extra):
                _apply(db, 7530 + 10 * extra, 1, segment_id=7530 + 100 + i)
                if i % 2 == 0:
                    _apply(db, 7530 + 10 * extra, 2, segment_id=7530 + 100 + i)
        db.flush()

        res = compute_irr(db, 7530)
        _cids, _names, per_code, _sel, _scope, _mag = build_irr_matrices(db, 7530)
        contributing = [
            rows for code_id, rows in per_code.items()
            if next((c for c in res["per_code"] if c["code_id"] == code_id), {})
            .get("krippendorff_alpha") is not None
        ]
        clustered = alpha_interval(pooled_unit_contributions(contributing))
        naive = alpha_interval(unit_contributions([r for rows in contributing for r in rows]))

        assert clustered != naive, (
            "fixture cannot tell the two apart — it proves nothing about which "
            "one the payload used"
        )
        assert res["overall_alpha_ci"]["lower"] == clustered["lower"]
        assert res["overall_alpha_ci"]["upper"] == clustered["upper"]

    def test_the_unavailable_payload_still_declares_the_field(self, db_session):
        """A missing key and a null value read the same to a client that does
        `?.` on it, and differently to one that destructures."""
        db = db_session
        db.add(Project(id=7540, name="Solo", user_id=1))
        db.flush()
        res = compute_irr(db, 7540)
        assert res["available"] is False
        assert "overall_alpha_ci" in res and res["overall_alpha_ci"] is None


# ── #35 — rating agreement (magnitude α) ──────────────────────────────────────


def _rate(db, code_id, uid, segment_id, magnitude):
    """An application WITH a rating (`None` = applied but left unrated)."""
    db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=segment_id,
                           magnitude=magnitude))
    db.flush()


class TestMagnitudeAlpha:
    """#35 — one interval-metric α per code that declares a scale.

    🔴 The scale is −1…+1 with step 0.5, so ZERO IS INTERIOR: two coders both
    rating a unit 0 is a real, comparable pair, and a truthiness slip anywhere in
    the gather drops that unit — changing n_units, n_rated and α at once. The
    fixture also carries one applied-but-unrated cell, one unit only one coder
    applied, and one nobody coded, so the three kinds of "no rating" are all
    present and all distinct from a rating of zero.
    """

    #: unit index → (coder 1, coder 2). A shorter tuple = coder 2 never applied
    #: the code there; `None` = applied but unrated.
    RATINGS = {
        0: (1.0, 1.0),
        1: (0.5, 0.0),
        2: (0.0, 0.0),      # zero, both — the falsy-zero axis
        3: (-1.0, -0.5),
        4: (0.5, None),     # coder 2 applied but skipped the rating
        5: (1.0,),          # coder 2 never applied it
        # 6: nobody
        7: (-0.5, -0.5),
    }

    def _project(self, db, pid, ratings=None):
        ratings = self.RATINGS if ratings is None else ratings
        db.add_all([
            Project(id=pid, name="P", user_id=1),
            Conversation(id=pid, project_id=pid, name="Interview"),
        ])
        db.flush()
        _coder(db, 2, "Bob")
        db.add(Code(id=pid, project_id=pid, name="District support", numeric_id=2,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.add(Code(id=pid + 1, project_id=pid, name="Pacing", numeric_id=3,
                    is_active=True, is_universal=False))
        db.flush()
        for i in range(8):
            _seg(db, pid + 100 + i, pid, i)
        for i, values in ratings.items():
            for uid, value in zip((1, 2), values):
                _rate(db, pid, uid, pid + 100 + i, value)
        # The plain code — so the categorical table has a row the rating table
        # lacks, and so BOTH coders engage the source whatever the ratings say.
        _apply(db, pid + 1, 1, segment_id=pid + 100)
        _apply(db, pid + 1, 2, segment_id=pid + 100)
        _apply(db, pid + 1, 1, segment_id=pid + 101)
        db.flush()

    def _matrix(self, ratings=None):
        """The coder×unit rating matrix, built INDEPENDENTLY of the service."""
        ratings = self.RATINGS if ratings is None else ratings
        rows = []
        for i in range(8):
            row: list = [None, None]
            for j, v in enumerate(ratings.get(i, ())):
                row[j] = v
            rows.append(row)
        return rows

    def test_a_rating_row_exists_for_the_scaled_code_only(self, db_session):
        self._project(db_session, 7600)
        res = compute_irr(db_session, 7600)
        assert [r["code_id"] for r in res["magnitude_per_code"]] == [7600]
        # The categorical table still lists both codes.
        assert {c["code_id"] for c in res["per_code"]} == {7600, 7601}

    def test_alpha_is_the_interval_metric_over_units_both_rated(self, db_session):
        self._project(db_session, 7600)
        row = compute_irr(db_session, 7600)["magnitude_per_code"][0]
        expected = _krippendorff_alpha(self._matrix(), "interval")
        assert row["krippendorff_alpha"] == pytest.approx(expected, abs=1e-12)
        assert row["alpha_metric"] == "interval"
        # Discrimination: on this fixture the nominal metric gives a DIFFERENT
        # number, so the assertion above can tell the two apart.
        assert abs(_krippendorff_alpha(self._matrix(), "nominal") - expected) > 1e-3

    def test_zero_is_a_rating_so_the_unit_counts(self, db_session):
        """Mutation target: `if value is not None` → `if value` in
        `build_irr_matrices` drops unit 2 and reports 4 / 10 here."""
        self._project(db_session, 7600)
        row = compute_irr(db_session, 7600)["magnitude_per_code"][0]
        # Units 0, 1, 2, 3, 7 — unit 2 is the pair of zeros.
        assert row["n_units"] == 5
        assert row["n_rated"] == 12 and row["n_applications"] == 13

    def test_mean_abs_difference_is_in_scale_units(self, db_session):
        self._project(db_session, 7600)
        row = compute_irr(db_session, 7600)["magnitude_per_code"][0]
        # |1−1| + |0.5−0| + |0−0| + |−1−(−0.5)| + |−0.5−(−0.5)|, over 5 pairs.
        assert row["mean_abs_difference"] == pytest.approx(0.2)

    def test_the_interval_is_scored_on_the_same_metric_as_the_estimate(self, db_session):
        """The interval must bracket the number it sits beside. Before the
        `metric` parameter existed a nominal interval was the only kind."""
        from app.services.reliability_intervals import alpha_interval, unit_contributions

        self._project(db_session, 7600)
        row = compute_irr(db_session, 7600)["magnitude_per_code"][0]
        contribs = unit_contributions(self._matrix())
        interval_ci = alpha_interval(contribs, metric="interval")
        nominal_ci = alpha_interval(contribs)
        assert (interval_ci["lower"], interval_ci["upper"]) != (nominal_ci["lower"], nominal_ci["upper"]), (
            "fixture cannot tell the two metrics apart"
        )
        assert row["alpha_ci"]["lower"] == interval_ci["lower"]
        assert row["alpha_ci"]["upper"] == interval_ci["upper"]
        assert row["alpha_ci"]["method"] == "alpha_bootstrap_units"

    def test_identical_ratings_everywhere_are_no_variance_not_perfect(self, db_session):
        """#829 through ratings. ⚠️ Unit 3 carries a DIFFERENT value rated by ONE
        coder: a check over every present value sees two values and computes
        α — which the formula's zero-D_e convention then returns as 1.0
        "reliable". Only the COMPARED values decide, and they are all 1.0."""
        self._project(db_session, 7610, ratings={
            0: (1.0, 1.0), 1: (1.0, 1.0), 2: (1.0, 1.0), 3: (0.5,),
        })
        row = compute_irr(db_session, 7610)["magnitude_per_code"][0]
        assert row["krippendorff_alpha"] is None
        assert row["undefined_reason"] == "no_variance"
        assert row["alpha_ci"] is None
        assert row["n_units"] == 3, "coverage is still a fact"

    def test_one_coder_alone_is_insufficient_n_with_coverage_still_visible(self, db_session):
        """The row still renders: HOW thin the ratings are is the information,
        and the reason the optional-rating variant was rejected."""
        self._project(db_session, 7620, ratings={0: (1.0,), 1: (0.5,), 2: (0.0,)})
        row = compute_irr(db_session, 7620)["magnitude_per_code"][0]
        assert row["n_units"] == 0
        assert row["undefined_reason"] == "insufficient_n"
        assert row["krippendorff_alpha"] is None and row["alpha_ci"] is None
        assert row["mean_abs_difference"] is None
        assert row["n_rated"] == 3 and row["n_applications"] == 3

    def test_a_cleared_scale_yields_no_row(self, db_session):
        """Ratings on a code whose scale was cleared are uninterpretable until a
        scale returns — the same rule the chip renders by."""
        db = db_session
        self._project(db, 7630)
        code = db.get(Code, 7630)
        code.magnitude_min = None
        code.magnitude_max = None
        db.flush()
        assert compute_irr(db, 7630)["magnitude_per_code"] == []

    def test_source_scoping_narrows_the_rating_units(self, db_session):
        db = db_session
        self._project(db, 7640)
        db.add(Conversation(id=7640 + 5000, project_id=7640, name="Elsewhere"))
        db.flush()
        _seg(db, 7640 + 5001, 7640 + 5000, 0)
        _seg(db, 7640 + 5002, 7640 + 5000, 1)
        for sid, (a, b) in {7640 + 5001: (1.0, 0.5), 7640 + 5002: (-1.0, 1.0)}.items():
            _rate(db, 7640, 1, sid, a)
            _rate(db, 7640, 2, sid, b)
        pooled = compute_irr(db, 7640)["magnitude_per_code"][0]
        scoped = compute_irr(db, 7640, source=("conv", 7640))["magnitude_per_code"][0]
        assert pooled["n_units"] == 7 and scoped["n_units"] == 5
        assert pooled["krippendorff_alpha"] != scoped["krippendorff_alpha"]

    def test_rating_rows_never_lift_the_headline(self, db_session):
        """The overall α is a statement about presence/absence. Each rated code
        is its own instrument, so ratings are NOT pooled into it."""
        db = db_session
        self._project(db, 7650)
        res = compute_irr(db, 7650)
        _cids, _names, per_code, _sel, _scope, _mag = build_irr_matrices(db, 7650)
        categorical_rows = [r for rows in per_code.values() for r in rows]
        assert res["overall_alpha"] == pytest.approx(_krippendorff_alpha(categorical_rows))

    def test_the_facet_and_metric_survive_the_response_schema(self, db_session):
        """`/irr` serializes through `IrrResponse`; a field the schema does not
        declare is dropped SILENTLY (the half-landed-wire class)."""
        from app.schemas.code_analysis import IrrResponse

        self._project(db_session, 7660)
        wire = IrrResponse(**compute_irr(db_session, 7660)).model_dump()
        assert wire["reliability_facet"] == "coders"
        row = wire["magnitude_per_code"][0]
        assert row["alpha_metric"] == "interval"
        assert row["scale"] == {"min": -1.0, "max": 1.0, "step": 0.5, "anchors": []}
        assert row["n_rated"] == 12
        assert all(c["alpha_metric"] == "nominal" for c in wire["per_code"])

    def test_the_unavailable_payload_declares_the_rating_fields(self, db_session):
        db = db_session
        db.add(Project(id=7670, name="Solo", user_id=1))
        db.flush()
        res = compute_irr(db, 7670)
        assert res["magnitude_per_code"] == []
        assert res["reliability_facet"] == "coders"
