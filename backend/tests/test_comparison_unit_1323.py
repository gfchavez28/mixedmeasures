"""#1323 + #1297 + #1298 — the code-by-group comparison counts PARTICIPANTS.

Decided 2026-10-31: "how many participants in each group used this code", tested
(Fisher for two groups, Freeman–Halton for more), the p-values corrected across the
codes tested (discrete Holm — D1 of the 1.5.9 pre-implementation review, which
replaced the plain Holm first accepted), the unit stated on the result; passage
counts ride along as a description, never tested; a group with no material leaves
the test and stays in the table (#591's rule, #1323's 2026-10-26 rider).

Every test here is written as the WANTED behaviour, so each fails on `9dd1cd1b`,
and each carries a control a mutant must also get past.
"""
import asyncio
import csv
import io
import itertools
import json
import math
import random
import subprocess
from pathlib import Path

import numpy as np
import pytest
from scipy.stats import fisher_exact

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.schemas import code_analysis as schemas  # attributes read in the tests (they FAIL on HEAD, not error)
from app.services import comparison_basis as cb
from app.services import multiplicity as mt
from app.services.code_analysis import get_demographic_comparison
from app.services.undefined_stats import NO_SEGMENTS
from tests import r_support

PID = 1323
CONV, DOC_COL, TEXT_COL = 13231, 13231, 13232
X, Y, Z, NOVAR, UNCLEAR = 13240, 13241, 13242, 13243, 13244


class _Builder:
    """A tiny project: one demographic column `Role`, one open-text column, one
    conversation. ``person`` adds a participant in a group with N turns."""

    def __init__(self, db):
        self.db, self._seg = db, 50_000
        db.add(Project(id=PID, name="P1323", user_id=1))
        db.flush()
        db.add(Dataset(id=PID, project_id=PID, name="Survey"))
        db.flush()
        db.add_all([
            DatasetColumn(id=DOC_COL, dataset_id=PID, column_code="Role", column_name="Role",
                          column_text="Role", column_type=ColumnType.DEMOGRAPHIC,
                          sequence_order=0, display_order=0),
            DatasetColumn(id=TEXT_COL, dataset_id=PID, column_code="Q", column_name="Q",
                          column_text="Q", column_type=ColumnType.OPEN_TEXT,
                          sequence_order=1, display_order=1),
        ])
        db.add(Conversation(id=CONV, project_id=PID, name="C"))
        db.flush()
        db.add_all([
            Code(id=X, project_id=PID, numeric_id=10, name="X", is_universal=False, is_active=True),
            Code(id=Y, project_id=PID, numeric_id=11, name="Y", is_universal=False, is_active=True),
            Code(id=Z, project_id=PID, numeric_id=12, name="Z", is_universal=False, is_active=True),
            Code(id=NOVAR, project_id=PID, numeric_id=13, name="Nobody", is_universal=False, is_active=True),
            Code(id=UNCLEAR, project_id=PID, numeric_id=1, name="Unclear", is_universal=True, is_active=True),
        ])
        db.flush()

    def person(self, pid, group, turns=0, codes=None, speaker=True):
        """``codes`` maps a code id to how many of the turns carry it."""
        db = self.db
        db.add(Participant(id=pid, project_id=PID, identifier=f"P{pid}"))
        db.flush()
        db.add(DatasetRow(id=pid, dataset_id=PID, row_identifier=f"P{pid}", participant_id=pid))
        db.flush()
        if group is not None:
            db.add(DatasetValue(row_id=pid, column_id=DOC_COL, value_text=group))
            db.flush()
        if turns and speaker:
            db.add(Speaker(id=pid, project_id=PID, name=f"S{pid}", is_facilitator=0,
                           color_index=0, participant_id=pid))
            db.flush()
        for i in range(turns):
            self._seg += 1
            db.add(Segment(id=self._seg, conversation_id=CONV, sequence_order=self._seg,
                           text="t", word_count=1, speaker_id=pid if speaker else None))
            db.flush()
            for cid, k in (codes or {}).items():
                if i < k:
                    db.add(CodeApplication(segment_id=self._seg, code_id=cid, user_id=1))
            db.flush()

    def answer(self, pid, text, code=None):
        v = DatasetValue(row_id=pid, column_id=TEXT_COL, value_text=text)
        self.db.add(v)
        self.db.flush()
        if code:
            self.db.add(CodeApplication(dataset_value_id=v.id, code_id=code, user_id=1))
            self.db.flush()

    def document(self, did, pid, code=None):
        self.db.add(Document(id=did, project_id=PID, name=f"D{did}", source_filename="d.txt",
                             source_format="txt", participant_id=pid))
        self.db.flush()
        self._seg += 1
        self.db.add(Segment(id=self._seg, document_id=did, sequence_order=0, text="para"))
        self.db.flush()
        if code:
            self.db.add(CodeApplication(segment_id=self._seg, code_id=code, user_id=1))
            self.db.flush()


@pytest.fixture
def b(db_session):
    return _Builder(db_session)


def _cmp(b, **kw):
    return get_demographic_comparison(b.db, PID, group_by_subtype="Role", **kw)


def _code(r, name):
    return next(e for e in r["codes"] if e["code_name"] == name)


# ── The unit ────────────────────────────────────────────────────────────────

def test_a_talkative_participant_does_not_make_a_difference(b):
    """The checker's probe (#1323 *Seen*): Board 12 of 60 coded turns, all from ONE
    of its three members; Staff 3 of 60, one from each. Passages gave p = .0246, `*`."""
    b.person(1, "Board", 20, {X: 12}); b.person(2, "Board", 20); b.person(3, "Board", 20)
    for pid in (4, 5, 6):
        b.person(pid, "Staff", 20, {X: 1})
    r = _cmp(b)
    x = _code(r, "X")
    assert {g: x["by_group"][g]["count"] for g in r["groups"]} == {"Board": 1, "Staff": 3}
    assert x["test"]["significant"] is False          # HEAD: p .0246, `*`
    assert r["basis"]["unit"] == cb.COMPARISON_UNIT_PARTICIPANT
    assert {g: r["group_totals"][g]["n"] for g in r["groups"]} == {"Board": 3, "Staff": 3}
    assert x["test"]["method"] == cb.TEST_FISHER_EXACT
    assert x["test"]["p_value"] == pytest.approx(fisher_exact([[1, 2], [3, 0]]).pvalue, abs=1e-6)
    assert x["test"]["significant"] is False
    # The passages are still there — as a DESCRIPTION.
    assert {g: x["by_group"][g]["passages"] for g in r["groups"]} == {"Board": 12, "Staff": 3}


def test_a_real_participant_difference_is_still_found(b):
    """Control: eight of eight against none of eight survives the correction over the
    codes tested."""
    for pid in range(1, 9):
        b.person(pid, "Board", 2, {X: 1, Y: 1 if pid % 2 else 0})
    for pid in range(9, 17):
        b.person(pid, "Staff", 2, {Y: 1 if pid % 2 else 0})
    x = _code(_cmp(b), "X")
    # A CONTROL: true on HEAD as well (there, 8 of 16 passages against 0 of 16).
    assert x["test"]["p_value"] < 0.01 and bool(x["test"]["significant"]) is True


def test_passages_are_described_and_never_tested(b):
    b.person(1, "Board", 20, {X: 12}); b.person(4, "Staff", 20, {X: 1})
    r = _cmp(b, unit=cb.COMPARISON_UNIT_PASSAGE)
    assert r["basis"]["test_omitted_reason"] == cb.TEST_OMITTED_PASSAGE_UNIT
    assert all(e["test"] is None for e in r["codes"])
    assert _code(r, "X")["by_group"]["Board"]["count"] == 12  # the description stands


def test_the_passage_unit_is_never_a_tested_unit():
    """🔴 The defect, as a property: no build may test passages."""
    assert cb.COMPARISON_UNIT_PASSAGE not in cb.TESTED_UNITS
    assert cb.DEFAULT_COMPARISON_UNIT in cb.TESTED_UNITS


def test_an_unknown_unit_or_correction_fails_closed(b):
    """Including the early return (one group), which states the correction too."""
    b.person(1, "Board", 1, {X: 1})
    with pytest.raises(ValueError):
        _cmp(b, unit="household")
    with pytest.raises(ValueError):
        _cmp(b, correction="bonferonni")


# ── Who is in the denominator (exposure) ─────────────────────────────────────

def test_a_participant_with_no_material_is_not_a_non_user(b):
    """Surveyed but silent here: out of the denominator, not "did not use X"."""
    b.person(1, "Board", 2, {X: 1}); b.person(2, "Board", 0)  # 2 never speaks
    b.person(4, "Staff", 2)
    r = _cmp(b)
    assert _code(r, "X")["by_group"]["Board"]["proportion"] == 1.0   # HEAD: 1 of 2 turns
    assert r["group_totals"]["Board"]["n"] == 1


def test_a_passage_with_no_person_is_counted_and_in_no_group(b):
    b.person(1, "Board", 2, {X: 1}); b.person(4, "Staff", 2)
    b.person(9, "Board", 3, speaker=False)    # three turns with NO speaker
    b.document(77, None, code=X)              # a document with no subject
    r = _cmp(b)
    assert r["scope"]["unassigned_passages"] == 4
    assert r["group_totals"]["Board"]["total_segments"] == 2  # theirs only


# ── #1297 / #1298: every source kind reaches a person ───────────────────────

def test_a_text_only_selection_counts_the_answers_and_not_the_conversations(b):
    """#1297: the selection held only open-text answers and the server counted every
    conversation. Lists are explicit now: `[]` = none of that kind."""
    b.person(1, "Board", 4, {X: 4}); b.person(4, "Staff", 4)
    b.answer(1, "I think about X a lot", code=Y)
    b.answer(4, "N/A")                         # not substantive — not material
    r = _cmp(b, conversation_ids=[], text_column_ids=[TEXT_COL])
    assert _code(r, "X")["by_group"]["Board"]["count"] == 0      # HEAD: 4 — the turns
    assert _code(r, "Y")["by_group"]["Board"]["count"] == 1      # HEAD: 0 — the answer
    assert r["scope"]["conversations"] == 0 and r["scope"]["text_columns"] == 1
    assert {g: r["group_totals"][g]["n"] for g in r["groups"]} == {"Board": 1, "Staff": 0}
    # Control: the conversation, selected, counts its speakers again.
    r2 = _cmp(b, conversation_ids=[CONV], document_ids=[], text_column_ids=[])
    assert _code(r2, "X")["by_group"]["Board"]["count"] == 1
    assert r2["group_totals"]["Staff"]["n"] == 1


def test_a_linked_document_counts_its_subject(b):
    """#1298: documents link to participants since row 46; the comparison ignored them."""
    b.person(1, "Board", 2, {X: 1}); b.person(4, "Staff", 2)
    b.person(5, "Staff", 0)
    b.document(70, 5, code=X)
    r = _cmp(b)
    assert _code(r, "X")["by_group"]["Staff"]["count"] == 1     # HEAD: 0
    assert r["scope"]["documents"] == 1
    assert r["group_totals"]["Staff"]["n"] == 2
    # Control: the document NOT selected leaves its subject out.
    r2 = _cmp(b, document_ids=[])
    assert r2["group_totals"]["Staff"]["n"] == 1
    assert _code(r2, "X")["by_group"]["Staff"]["count"] == 0


def test_one_person_across_kinds_counts_once(b):
    """A turn, a document and an answer by ONE person, each coded X: one user."""
    b.person(1, "Board", 1, {X: 1}); b.person(4, "Staff", 1)
    b.document(71, 1, code=X); b.answer(1, "about X", code=X)
    x = _code(_cmp(b), "X")
    assert x["by_group"]["Board"]["count"] == 1
    assert x["by_group"]["Board"]["passages"] == 3


# ── The rider: an empty group leaves the TEST and stays in the TABLE ─────────

def test_an_empty_group_leaves_the_test_and_stays_in_the_table(b):
    """#1323's 2026-10-26 rider: one empty third group switched the test off for
    EVERY code; it must leave the test, stay a column, and be named."""
    for pid in range(1, 6):
        b.person(pid, "Board", 1, {X: 1})
    for pid in range(6, 11):
        b.person(pid, "Staff", 1)
    b.person(20, "Volunteer", 0)
    r = _cmp(b)
    assert r["groups"] == ["Board", "Staff", "Volunteer"]
    x = _code(r, "X")
    assert x["test"] is not None, "HEAD: one empty group switched the test off"
    assert x["test"]["method"] == cb.TEST_FISHER_EXACT
    assert r["basis"]["tested_groups"] == ["Board", "Staff"]
    assert x["test"]["p_value"] == pytest.approx(fisher_exact([[5, 0], [0, 5]]).pvalue, abs=1e-6)
    assert x["by_group"]["Volunteer"]["proportion"] is None
    assert x["by_group"]["Volunteer"]["undefined_reason"] == NO_SEGMENTS


def test_three_groups_take_freeman_halton(b):
    for pid in range(1, 5):
        b.person(pid, "Board", 1, {X: 1 if pid <= 3 else 0})
    for pid in range(5, 9):
        b.person(pid, "Staff", 1, {X: 1 if pid <= 5 else 0})
    for pid in range(9, 13):
        b.person(pid, "Volunteer", 1)
    x = _code(_cmp(b), "X")
    assert x["test"]["method"] == cb.TEST_FREEMAN_HALTON
    assert x["test"]["p_value"] == pytest.approx(_brute_force_fh([3, 1, 0], [4, 4, 4]), abs=1e-6)
    assert x["test"]["effect_size_label"] == "cramers_v"


# ── Multiplicity ──────────────────────────────────────────────────────────

#: Hand-derived, not computed by the code under test: at 8 v 8 with 8 users the
#: hypergeometric masses of 8/0 and 7/1 are 1/12870 and 64/12870, so a code that
#: split 4/4 can attain p = 2 × 65/12870 as its second-smallest value — the largest
#: attainable p under Y's raw .0406, i.e. F_Z(.0406) in discrete Holm's sum.
F_Z_AT_Y = 130 / 12870


@pytest.fixture
def four_codes(b):
    """X strongly, Y moderately different; Z split evenly; Nobody used by no one;
    Unclear (universal) used unevenly. Built so the correction MATTERS under BOTH Holm
    forms: Y's raw p is under .05 and its adjusted p is not (asserted, so the fixture
    cannot quietly stop discriminating). Z's 8 users are what keep discrete Holm from
    starring Y: alone, Y's step would be its own p."""
    for pid in range(1, 9):
        b.person(pid, "Board", 1, {X: 1, Y: 1 if pid <= 6 else 0, Z: 1 if pid <= 4 else 0,
                                   UNCLEAR: 1})
    for pid in range(9, 17):
        b.person(pid, "Staff", 1, {Y: 1 if pid <= 9 else 0, Z: 1 if pid <= 12 else 0})
    return b  # X 8/8 v 0/8 (p .0002) · Y 6/8 v 1/8 (p .0406; Holm .0811; discrete .0507) · Z 4/8 v 4/8


def test_the_default_correction_is_discrete_holm(four_codes):
    """D1 (2026-10-31): the default is discrete Holm. Both adjusted p-values are pinned
    to HAND-DERIVED sums — not to the implementation. X (8/8 v 0/8, p = 2/12870): Z
    has the same eight users, so its smallest attainable p IS p_X and it adds p_X to
    X's threshold, while Y (seven users, smallest attainable 16/11440) adds nothing —
    2 × p_X, where plain Holm would charge 3 × p_X. Y: X is rejected ahead of it, so
    its threshold is p_Y + F_Z(p_Y)."""
    assert mt.DEFAULT_CORRECTION == mt.CORRECTION_DISCRETE_HOLM
    r = _cmp(four_codes)
    assert r["basis"]["correction"] == mt.CORRECTION_DISCRETE_HOLM
    y, x = _code(r, "Y")["test"], _code(r, "X")["test"]
    assert y["p_adjusted"] == pytest.approx(y["p_value"] + F_Z_AT_Y, abs=5e-6)
    assert y["p_value"] < 0.05 <= y["p_adjusted"] and y["significant"] is False
    assert x["p_value"] == pytest.approx(2 / 12870, abs=5e-7)
    assert x["p_adjusted"] == pytest.approx(2 * x["p_value"], abs=5e-6) and x["significant"] is True


def test_the_p_values_are_holm_adjusted_across_the_codes_tested(four_codes):
    from statsmodels.stats.multitest import multipletests

    r = _cmp(four_codes, correction=mt.CORRECTION_HOLM)
    tested = [e for e in r["codes"] if e["test"] is not None]
    assert {e["code_name"] for e in tested} == {"X", "Y", "Z"}
    assert r["basis"]["family_size"] == 3
    assert r["basis"]["correction"] == mt.CORRECTION_HOLM
    raw = [e["test"]["p_value"] for e in tested]
    expected = multipletests(raw, method="holm")[1]
    for e, want in zip(tested, expected):
        # 5e-6: the service adjusts the UNROUNDED p, the oracle the 6-dp one.
        assert e["test"]["p_adjusted"] == pytest.approx(want, abs=5e-6)
        assert e["test"]["significant"] is bool(want < 0.05)
    y = _code(r, "Y")["test"]
    assert y["p_value"] < 0.05 <= y["p_adjusted"], "the fixture must make the correction matter"
    assert _code(r, "Nobody")["test_omitted_reason"] == cb.TEST_OMITTED_NO_VARIANCE
    assert _code(r, "Unclear")["test_omitted_reason"] == cb.TEST_OMITTED_UNIVERSAL


@pytest.mark.parametrize("method,sm", [(mt.CORRECTION_BH, "fdr_bh"), (mt.CORRECTION_NONE, None)])
def test_the_correction_is_one_switch(four_codes, method, sm):
    from statsmodels.stats.multitest import multipletests

    r = _cmp(four_codes, correction=method)
    tested = [e for e in r["codes"] if e["test"] is not None]
    raw = [e["test"]["p_value"] for e in tested]
    expected = multipletests(raw, method=sm)[1] if sm else raw
    assert r["basis"]["correction"] == method
    for e, want in zip(tested, expected):
        assert e["test"]["p_adjusted"] == pytest.approx(want, abs=5e-6)


def test_an_unknown_correction_fails_closed():
    with pytest.raises(ValueError):
        mt.adjust_p_values([0.01, 0.2], "bonferonni")
    with pytest.raises(ValueError):
        mt.best_case_adjusted([0.01, 0.2], "bonferonni")


@pytest.mark.parametrize("seed", range(5))
def test_holm_and_bh_match_statsmodels_on_random_families(seed):
    from statsmodels.stats.multitest import multipletests

    rng = np.random.default_rng(seed)
    ps = list(rng.random(17) ** 3)
    ps[3] = None  # an untested code is skipped, not counted
    real = [p for p in ps if p is not None]
    for method, sm in ((mt.CORRECTION_HOLM, "holm"), (mt.CORRECTION_BH, "fdr_bh")):
        got = [p for p in mt.adjust_p_values(ps, method) if p is not None]
        assert got == pytest.approx(list(multipletests(real, method=sm)[1]), abs=1e-12)
    assert mt.adjust_p_values(ps, mt.CORRECTION_HOLM)[3] is None


# ── The Freeman–Halton test ───────────────────────────────────────────────

def _brute_force_fh(successes, sizes):
    """An INDEPENDENT oracle: itertools over every table, `math.comb` probabilities."""
    x_total, n_total = sum(successes), sum(sizes)
    def prob(xs):
        return math.prod(math.comb(n, x) for n, x in zip(sizes, xs)) / math.comb(n_total, x_total)
    p_obs = prob(successes)
    return sum(prob(xs) for xs in itertools.product(*(range(n + 1) for n in sizes))
               if sum(xs) == x_total and prob(xs) <= p_obs * (1 + 1e-7))


@pytest.mark.parametrize("successes,sizes", [
    ([1, 3, 2], [3, 3, 4]), ([0, 2, 5, 1], [4, 5, 6, 3]), ([2, 2, 2], [5, 5, 5]),
    ([4, 0, 1, 3, 2], [4, 3, 5, 4, 6]),
])
def test_freeman_halton_matches_brute_force(successes, sizes):
    p, method = cb.freeman_halton_kx2(successes, sizes)
    assert method == cb.TEST_FREEMAN_HALTON
    assert p == pytest.approx(_brute_force_fh(successes, sizes), rel=1e-9)


@pytest.mark.parametrize("a,n1,c,n2", [(1, 3, 3, 3), (0, 6, 6, 6), (2, 7, 5, 8), (3, 10, 9, 12)])
def test_freeman_halton_on_two_groups_is_fishers_test(a, n1, c, n2):
    p, _ = cb.freeman_halton_kx2([a, c], [n1, n2])
    assert p == pytest.approx(fisher_exact([[a, n1 - a], [c, n2 - c]]).pvalue, rel=1e-9)


def test_the_monte_carlo_fallback_is_seeded_and_close(monkeypatch):
    succ, sizes = [2, 5, 1, 4], [8, 9, 7, 8]
    exact, _ = cb.freeman_halton_kx2(succ, sizes)
    monkeypatch.setattr(cb, "FREEMAN_HALTON_MAX_TABLES", 1)
    p1, m1 = cb.freeman_halton_kx2(succ, sizes)
    p2, _ = cb.freeman_halton_kx2(succ, sizes)
    assert m1 == cb.TEST_FREEMAN_HALTON_MC
    assert p1 == p2, "an unseeded estimate is a different p on every page load"
    assert abs(p1 - exact) < 0.02


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
@pytest.mark.parametrize("successes,sizes", [([1, 3, 2], [3, 3, 4]), ([0, 2, 5, 1], [4, 5, 6, 3]),
                                             ([7, 1, 3], [9, 8, 10])])
def test_freeman_halton_matches_r_fisher_test(successes, sizes):
    rows = ",".join(f"{x},{n - x}" for x, n in zip(successes, sizes))
    expr = f"m <- matrix(c({rows}), ncol = 2, byrow = TRUE); cat(sprintf('%.12f', fisher.test(m)$p.value))"
    out = subprocess.run([r_support.RSCRIPT, "--vanilla", "-e", expr],
                         capture_output=True, text=True, timeout=60, check=True)
    p, _ = cb.freeman_halton_kx2(successes, sizes)
    assert p == pytest.approx(float(out.stdout.strip()), abs=1e-9)


# ── The issue's Direction: a null simulation ─────────────────────────────────

def _simulate(rng, n_codes, per_group, turns, a=0.3, b_=2.0):
    """Per participant, per code, a propensity drawn with NO group effect; each turn
    carries the code with that propensity. Returns per-code (users, passages) per group."""
    out = []
    for _ in range(n_codes):
        cells = []
        for _g in range(2):
            prop = rng.beta(a, b_, size=per_group)
            hits = rng.random((per_group, turns)) < prop[:, None]
            cells.append((int(hits.any(axis=1).sum()), int(hits.sum())))
        out.append(cells)
    return out


def test_null_simulation_false_positive_rate_stays_near_nominal():
    """Seeded, ~2 s. Under the null with heterogeneous talkativeness, the participant
    test's per-code rejection rate stays at or below α and Holm keeps the family-wise
    rate near α. TWO discrimination arms, so this fixture COULD have failed: the
    PASSAGE test on the very same data (the old behaviour) rejects far more often, and
    without the correction some code is "significant" in a large share of studies.
    MEASURED at this seed: participants 2.5% per code, Holm family-wise 1.7%,
    uncorrected family-wise 38%, passages 36% per code."""
    rng = np.random.default_rng(1323)
    reps, n_codes, per_group, turns = 60, 20, 8, 15
    per_code_hits = family_hits = raw_family_hits = passage_hits = 0
    for _ in range(reps):
        sim = _simulate(rng, n_codes, per_group, turns)
        ps = []
        for (u1, p1), (u2, p2) in sim:
            t = cb.presence_test([u1, u2], [per_group, per_group])
            ps.append(t["p_value"] if t else None)
            if fisher_exact([[p1, per_group * turns - p1], [p2, per_group * turns - p2]]).pvalue < 0.05:
                passage_hits += 1
        per_code_hits += sum(1 for p in ps if p is not None and p < 0.05)
        raw_family_hits += any(p is not None and p < 0.05 for p in ps)
        adj = mt.adjust_p_values(ps, mt.CORRECTION_HOLM)
        family_hits += any(p is not None and p < 0.05 for p in adj)
    n = reps * n_codes
    se = math.sqrt(0.05 * 0.95 / n)
    assert per_code_hits / n <= 0.05 + 3 * se
    assert family_hits / reps <= 0.05 + 3 * math.sqrt(0.05 * 0.95 / reps)
    assert passage_hits / n > 0.25, "the fixture must expose the passage test's inflation"
    assert raw_family_hits / reps > 0.25, "the fixture must make the correction matter"


def test_null_simulation_through_the_service(b):
    """The pipeline's MOUTH (backend/tests/the internal design notes): one replicate of the same null,
    built as rows and read by `get_demographic_comparison` — no code is significant.
    (Wiring, not a rate: the rate is the pure test above.)"""
    rng = np.random.default_rng(7)
    codes = [X, Y, Z]
    pid = 100
    for g in ("Board", "Staff"):
        for _ in range(6):
            pid += 1
            props = rng.beta(0.3, 2.0, size=len(codes))
            turns = 15
            b.person(pid, g, turns, {c: int((rng.random(turns) < p).sum()) for c, p in zip(codes, props)})
    r = _cmp(b)
    assert all(not e["test"]["significant"] for e in r["codes"] if e["test"])
    assert r["basis"]["family_size"] >= 1


# ── The wire ──────────────────────────────────────────────────────────────

def test_the_basis_and_scope_ride_the_wire(four_codes):
    r = _cmp(four_codes)
    model = schemas.DemographicComparisonResponse.model_validate(r)
    wire = json.loads(json.dumps(model.model_dump(mode="json"), allow_nan=False))
    assert wire["basis"]["unit"] == cb.COMPARISON_UNIT_PARTICIPANT
    assert set(wire["basis"]) == set(schemas.ComparisonBasis.model_fields)
    assert set(wire["scope"]) == set(schemas.ComparisonScope.model_fields)
    assert "p_adjusted" in schemas.StatTestResult.model_fields


def test_every_response_shape_carries_the_basis(b):
    """Including the early return with fewer than two groups."""
    b.person(1, "Board", 1, {X: 1})
    r = _cmp(b)
    schemas.DemographicComparisonResponse.model_validate(r)
    assert r["basis"]["test_omitted_reason"] == cb.TEST_OMITTED_INSUFFICIENT_GROUPS


# ── The CSV ───────────────────────────────────────────────────────────────

def _csv(db, **params):
    from app.routers.code_analysis import demographic_comparison_csv

    async def go():
        # A plain `def` endpoint since D11; only the streamed body is read async.
        resp = demographic_comparison_csv(
            project_id=PID, group_by_subtype="Role", code_ids=None,
            conversation_ids=params.get("conversation_ids"),
            text_column_ids=params.get("text_column_ids"),
            exclude_facilitator=True, participant_ids=None, coder_ids=None,
            layer_scope=None, document_ids=params.get("document_ids"),
            user=db.get(User, 1), db=db,
        )
        chunks = [c async for c in resp.body_iterator]
        return "".join(c if isinstance(c, str) else c.decode() for c in chunks)
    rows = list(csv.reader(io.StringIO(asyncio.run(go()))))
    # #1626 (D244): a note can sit above the header (participants with no coding — this
    # fixture's Staff have material nobody coded); the table these tests read starts at
    # its "Code" row. The note itself is `test_without_coding_1626.py`'s.
    start = next(i for i, r in enumerate(rows) if r and r[0] == "Code")
    return rows[start:]


def test_the_csv_names_the_unit_and_carries_both_p_values(four_codes):
    rows = _csv(four_codes.db)
    header, body = rows[0], {r[0]: dict(zip(rows[0], r)) for r in rows[1:]}
    assert "Board (Participants who used it)" in header
    # The correction is NAMED, from the result's basis — never the wire key.
    assert "p-value (adjusted, discrete Holm)" in header
    y = body["Y"]
    assert float(y["p-value"]) < 0.05 <= float(y["p-value (adjusted, discrete Holm)"])
    assert y["Sig"] == ""                       # the star reads the ADJUSTED p
    assert body["X"]["Sig"] == "*"              # control: a code that survives keeps it
    assert body["Nobody"]["No test because"] == cb.TEST_OMITTED_NO_VARIANCE


def test_every_correction_has_a_csv_name():
    assert set(cb.CORRECTION_CSV_LABEL) == mt.CORRECTIONS
    assert all(label.isascii() for label in cb.CORRECTION_CSV_LABEL.values())


def test_an_empty_source_list_in_the_csv_means_none_of_that_kind(b):
    """`?conversation_ids=` (present, empty) is NONE — `parse_int_list` alone would
    have read it as ALL and brought #1297 back through the export."""
    b.person(1, "Board", 4, {X: 4}); b.person(4, "Staff", 4)
    b.answer(1, "about Y", code=Y); b.answer(4, "something else")
    rows = _csv(b.db, conversation_ids="", document_ids="", text_column_ids=str(TEXT_COL))
    body = {r[0]: dict(zip(rows[0], r)) for r in rows[1:]}
    assert body["X"]["Board (Participants who used it)"] == "0"
    assert body["Y"]["Board (Participants who used it)"] == "1"


CI_LO = "Delta 95% CI lower (Newcombe, unadjusted)"
CI_HI = "Delta 95% CI upper (Newcombe, unadjusted)"
REACH = "Can reach significance at these group sizes"


def test_the_csv_carries_deltas_interval_beside_delta(four_codes):
    """D3 in the export: the interval beside Δ, named as UNADJUSTED."""
    rows = _csv(four_codes.db)
    header, body = rows[0], {r[0]: dict(zip(rows[0], r)) for r in rows[1:]}
    at = header.index("Delta")
    assert header[at + 1:at + 3] == [CI_LO, CI_HI]
    lo, hi = cb.newcombe_wilson_ci(6, 8, 1, 8)     # Y: 6/8 v 1/8
    assert (body["Y"][CI_LO], body["Y"][CI_HI]) == (f"{round(lo, 4):.4f}", f"{round(hi, 4):.4f}")
    assert float(body["Y"][CI_LO]) < float(body["Y"]["Delta"]) < float(body["Y"][CI_HI])


def test_the_csv_says_whether_a_code_could_ever_be_starred(b):
    """D2 in the export: "no" means no data with these group sizes could star the
    code, so its empty Sig is not "no difference"; an untested code claims nothing."""
    for pid in range(1, 5):
        b.person(pid, "Board", 1, {X: 1, Y: 1 if pid == 1 else 0})
    for pid in range(5, 9):
        b.person(pid, "Staff", 1)
    rows = _csv(b.db)
    body = {r[0]: dict(zip(rows[0], r)) for r in rows[1:]}
    # X, 4 of 4 v 0 of 4: smallest attainable p .0286, and Y (one user, support {1})
    # adds nothing to it under discrete Holm — X CAN be starred.
    assert body["X"][REACH] == "yes"
    assert body["Y"][REACH] == "no"        # one user in all: p can only be 1
    assert body["Nobody"][REACH] == ""     # untested: no claim either way


# ── The cross-language contract (stated-basis property (a)) ────────────────

TS_MIRROR = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "comparison-basis.ts"


class TestCrossLanguageContract:
    def _ts(self):
        assert TS_MIRROR.exists(), f"the TS mirror moved: {TS_MIRROR}"
        return TS_MIRROR.read_text(encoding="utf-8")

    def test_every_constant_is_mirrored(self):
        ts = self._ts()
        for value in (*cb.COMPARISON_UNITS, *mt.CORRECTIONS, *cb.TEST_METHODS,
                      *cb.TEST_OMITTED_REASONS):
            assert f"'{value}'" in ts, value

    def test_the_client_keeps_its_exhaustiveness_guards(self):
        ts = self._ts()
        for guard in ("satisfies Record<ComparisonUnit,", "satisfies Record<ComparisonCorrection,",
                      "satisfies Record<ComparisonTestMethod,", "satisfies Record<ComparisonTestOmitted,"):
            assert guard in ts, guard


# ── Discrete-aware correction (the lead's 2026-10-31 rider) ──────────────────

@pytest.mark.parametrize("n,expected", [(3, 0.10), (4, 0.0286), (5, 0.0079), (6, 0.0022), (8, 0.00016)])
def test_the_smallest_attainable_fisher_p_at_n_v_n(n, expected):
    """The lead's EXECUTED table, reproduced from the support (X = n, a full split)."""
    support = cb._support_2x2(n, n, n)
    assert support[0] == pytest.approx(expected, rel=0.03)
    assert support[0] == pytest.approx(fisher_exact([[n, 0], [0, n]]).pvalue, rel=1e-9)


@pytest.mark.parametrize("successes,sizes", [([1, 3], [3, 3]), ([2, 5], [7, 8]), ([1, 3, 2], [3, 3, 4]),
                                             ([0, 2, 5, 1], [4, 5, 6, 3])])
def test_the_support_holds_the_observed_p(successes, sizes):
    t = cb.presence_test(successes, sizes)
    assert t["support"] == sorted(t["support"])
    assert any(abs(s - t["p_value"]) < 1e-9 for s in t["support"])
    assert t["min_attainable_p"] == t["support"][0]


@pytest.mark.parametrize("seed", range(5))
def test_discrete_holm_is_holm_on_continuous_supports_and_never_worse(seed):
    rng = np.random.default_rng(seed)
    ps = list(rng.random(12) ** 2)
    holm = mt.adjust_p_values(ps, mt.CORRECTION_HOLM)
    assert mt.adjust_p_values(ps, mt.CORRECTION_DISCRETE_HOLM, [None] * 12) == pytest.approx(holm)
    sups = []
    for p in ps:  # a support that holds p, coarser elsewhere
        sups.append(sorted({p, *[min(1.0, p * k) for k in (1.7, 3.1, 9.0)], 1.0}))
    disc = mt.adjust_p_values(ps, mt.CORRECTION_DISCRETE_HOLM, sups)
    assert all(d <= h + 1e-12 for d, h in zip(disc, holm))


SIX_V_SIX = [(6, 0, 3), (5, 0, 3), (5, 1, 4), (3, 3, 10), (1, 0, 10), (2, 0, 10)]


def _six_v_six_family():
    tests = [cb.presence_test([a, b], [6, 6]) for a, b, k in SIX_V_SIX for _ in range(k)]
    return ([t["p_value"] for t in tests], [t["support"] for t in tests],
            [t["min_attainable_p"] for t in tests])


def test_six_v_six_plain_holm_can_never_star_and_discrete_holm_can():
    """The literature rider, measured: 40 codes at 6 v 6. Plain Holm's first step is
    40 × .0022 = .087 whatever the data, so nothing can be starred; discrete Holm drops
    the codes these margins cannot speak to and stars the three 6/6-v-0/6 codes
    (17 × .0022 = .037 — the 17 codes with six users are the ones that can reach .0022).

    The marker counts 20 that COULD reach under discrete Holm, not Tarone's 17: the
    three 5/6-v-0/6 codes (smallest attainable .0152) reach 3 × .0152 = .045 once the
    17 are rejected ahead of them — a step-down threshold falls with every rejection."""
    ps, sups, mins = _six_v_six_family()
    holm = mt.adjust_p_values(ps, mt.CORRECTION_HOLM)
    disc = mt.adjust_p_values(ps, mt.CORRECTION_DISCRETE_HOLM, sups)
    assert sum(p < 0.05 for p in holm) == 0
    assert sum(p < 0.05 for p in disc) == 3
    assert min(disc) == pytest.approx(17 * fisher_exact([[6, 0], [0, 6]]).pvalue, rel=1e-6)
    best_holm = mt.best_case_adjusted(mins, mt.CORRECTION_HOLM)
    assert all(b >= 0.05 for b in best_holm), "plain Holm: no code can reach .05 at 6 v 6"
    best_disc = mt.best_case_adjusted(mins, mt.CORRECTION_DISCRETE_HOLM, sups)
    assert sum(b < 0.05 for b in best_disc) == 20
    assert mt.tarone_family_size(mins, 0.05) == 17


def test_discrete_holm_holds_the_family_wise_rate_under_the_null():
    """Seeded: 6 v 6, 20 codes, heterogeneous prevalence, no group effect. MEASURED at
    this seed: 3.3% (plain Holm 0%, uncorrected 4%) — discrete p's at 6 v 6 rarely fall
    under .05 at all, which is the rider's point."""
    rng = np.random.default_rng(31)
    reps, hits = 150, 0
    for _ in range(reps):
        ps, sups = [], []
        for _c in range(20):
            prev = rng.beta(0.6, 1.2)
            u = rng.random(12) < prev
            t = cb.presence_test([int(u[:6].sum()), int(u[6:].sum())], [6, 6])
            ps.append(t["p_value"] if t else None)
            sups.append(t["support"] if t else None)
        adj = mt.adjust_p_values(ps, mt.CORRECTION_DISCRETE_HOLM, sups)
        hits += any(p is not None and p < 0.05 for p in adj)
    assert hits / reps <= 0.05 + 3 * math.sqrt(0.05 * 0.95 / reps)


# ── The "can't reach significance" marker (D2) ──────────────────────────────

def _brute_force_best(sups, method):
    """An INDEPENDENT oracle for the marker: the smallest adjusted p each test gets
    over EVERY joint realisation of the family's attainable p-values. Codes' tables
    vary independently with the margins fixed, so the product of the supports is
    exactly the set of studies these margins allow."""
    best = [1.0] * len(sups)
    for combo in itertools.product(*sups):
        adj = mt.adjust_p_values(list(combo), method, sups)
        best = [min(b, a) for b, a in zip(best, adj)]
    return best


#: 6 v 6: three codes with six users (smallest attainable .0022) and one with five
#: (.0152). Ranked first, the five-user code's Holm threshold is 4 × .0152 = .061 —
#: but with the three rejected ahead of it, it is 1 × .0152.
DISCRIMINATING = [(6, 6, 6), (6, 6, 6), (6, 6, 6), (6, 6, 5)]


@pytest.mark.parametrize("method", [mt.CORRECTION_HOLM, mt.CORRECTION_DISCRETE_HOLM, mt.CORRECTION_BH])
def test_the_marker_is_the_true_best_case_over_every_study(method):
    sups = [cb._support_2x2(n1, n2, u) for n1, n2, u in DISCRIMINATING]
    mins = [s[0] for s in sups]
    want = _brute_force_best(sups, method)
    assert mt.best_case_adjusted(mins, method, sups) == pytest.approx(want, abs=1e-12)
    rng = random.Random(1323)
    for _ in range(60):
        n1, n2 = rng.randint(2, 6), rng.randint(2, 6)
        fam = [(n1, n2, rng.randint(1, n1 + n2 - 1)) for _ in range(rng.randint(2, 4))]
        sups = [cb._support_2x2(*f) for f in fam]
        mins = [s[0] for s in sups]
        assert mt.best_case_adjusted(mins, method, sups) == pytest.approx(
            _brute_force_best(sups, method), abs=1e-12), fam


def test_the_discriminating_family_could_have_fooled_a_ranked_first_marker():
    """The fixture's worth (backend/tests/the internal design notes's DISCRIMINATION rule): ranked
    first, the five-user code CANNOT reach .05 under Holm; over every study it CAN.
    A marker computed the first way would say "can't reach" about a code that can
    be starred."""
    sups = [cb._support_2x2(n1, n2, u) for n1, n2, u in DISCRIMINATING]
    five_user_min = sups[3][0]
    assert len(sups) * five_user_min >= 0.05
    assert _brute_force_best(sups, mt.CORRECTION_HOLM)[3] < 0.05


def test_the_marker_and_the_disclosure_ride_the_wire(b):
    for pid in range(1, 4):
        b.person(pid, "Board", 1, {X: 1, Y: 1 if pid == 1 else 0})
    for pid in range(4, 7):
        b.person(pid, "Staff", 1)
    r = _cmp(b)
    y = _code(r, "Y")["test"]      # 1 of 3 v 0 of 3: one user — p can only be 1
    assert y["min_attainable_p"] == 1.0 and y["can_reach_significance"] is False
    assert r["basis"]["family_reachable"] == 0 and r["basis"]["tarone_family_size"] == 0
    schemas.DemographicComparisonResponse.model_validate(r)


@pytest.mark.parametrize("a,n1,c,n2,lo,hi", [(56, 70, 48, 80, 0.0524, 0.3339),
                                            (9, 10, 3, 10, 0.1705, 0.8090)])
def test_the_newcombe_interval_matches_the_published_examples(a, n1, c, n2, lo, hi):
    """Newcombe (1998) method 10; both pairs agree with an independent R
    implementation of the method (the 2026-10-31 review). Wired by D3, below."""
    got = cb.newcombe_wilson_ci(a, n1, c, n2)
    assert got == pytest.approx((lo, hi), abs=6e-5)


# ── Δ's interval (D3) ────────────────────────────────────────────────────────

def test_delta_carries_newcombes_interval_over_participants(four_codes):
    r = _cmp(four_codes)
    y = _code(r, "Y")                                  # 6/8 v 1/8
    lo, hi = cb.newcombe_wilson_ci(6, 8, 1, 8)
    assert y["delta_ci"] == {"lower": round(lo, 4), "upper": round(hi, 4),
                             "level": cb.DELTA_CI_LEVEL, "method": cb.CI_METHOD_NEWCOMBE_HYBRID}
    assert y["delta_ci"]["lower"] < y["delta_proportion"] < y["delta_ci"]["upper"]
    # Every Δ over participants has one — untested codes too (no variance,
    # universal): the interval describes a difference, which exists without a test.
    assert all(e["delta_ci"] is not None for e in r["codes"])
    schemas.DemographicComparisonResponse.model_validate(r)


def test_passages_get_a_delta_and_no_interval(b):
    """Passages from one person are not independent: an interval over them would
    claim a precision the data do not have."""
    b.person(1, "Board", 3, {X: 2}); b.person(2, "Staff", 3, {X: 1})
    x = _code(_cmp(b, unit=cb.COMPARISON_UNIT_PASSAGE), "X")
    assert x["delta_proportion"] is not None and x["delta_ci"] is None
    assert _code(_cmp(b), "X")["delta_ci"] is not None     # control: participants do


def test_no_interval_without_a_single_difference(b):
    """Three groups have no single Δ; a group with no material has no share (#1421)."""
    b.person(1, "Board", 1, {X: 1}); b.person(2, "Staff", 1); b.person(3, "Volunteer", 1)
    x = _code(_cmp(b), "X")
    assert x["delta_proportion"] is None and x["delta_ci"] is None
    b.db.query(DatasetValue).filter(DatasetValue.row_id == 3).delete()
    b.person(4, "Volunteer")                               # a group with nobody's material...
    b.db.query(DatasetValue).filter(DatasetValue.row_id == 2).delete()   # ...and Staff gone
    b.db.flush()
    r = _cmp(b)
    assert r["groups"] == ["Board", "Volunteer"]
    x = _code(r, "X")
    assert x["by_group"]["Volunteer"]["proportion"] is None
    assert x["delta_proportion"] is None and x["delta_ci"] is None


def test_the_marker_is_about_the_ADJUSTED_best_case(b):
    """4 v 4, two codes tested: X's smallest attainable p is .0286 — under .05 raw.
    Under PLAIN Holm its best case is 2 × .0286 = .057 (Y, a 3-user code, can never
    reach .0286, but plain Holm counts it anyway), so X can NEVER be starred — a
    marker read off the raw minimum would say it can. Under DISCRETE Holm, Y adds
    nothing to X's threshold, so X can be starred and is."""
    for pid in range(1, 5):
        b.person(pid, "Board", 1, {X: 1, Y: 1 if pid <= 2 else 0})
    for pid in range(5, 9):
        b.person(pid, "Staff", 1, {Y: 1 if pid == 5 else 0})
    r = _cmp(b, correction=mt.CORRECTION_HOLM)
    x = _code(r, "X")["test"]
    assert x["min_attainable_p"] < 0.05
    assert x["can_reach_significance"] is False
    assert x["significant"] is False and x["p_value"] < 0.05     # 4/4 v 0/4: raw .029
    r2 = _cmp(b, correction=mt.CORRECTION_NONE)
    assert _code(r2, "X")["test"]["can_reach_significance"] is True   # control
    # The default — discrete Holm — is what the review chose this for.
    x3 = _code(_cmp(b), "X")["test"]
    assert x3["can_reach_significance"] is True and x3["significant"] is True
