"""#1323, D1 — discrete Holm checked against the R package that defines it.

`reference_data/discrete_fwer_oracle.json` holds families of code-by-group presence
tests and what R computed for them: each test's exact two-sided p and its SUPPORT
(DiscreteTests::fisher_test_pv for two groups; every table listed and run through
stats::fisher.test for three or more), the adjusted p-values of discrete Holm
(DiscreteFWER::DHolm — Zhu & Guo 2019), plain Holm and Benjamini–Hochberg
(stats::p.adjust), and the same three applied to the vector of each test's smallest
attainable p (the "can't reach significance" marker, D2).

It is a FROZEN oracle (decided 2026-10-31b): DiscreteFWER compiles C++ and needs a
newer Rcpp than Ubuntu packages, so CI does not install it; the generator
(`reference_data/discrete_fwer_oracle.R`) was run once with the package installed
locally, and reads no Mixed Measures code. These tests need no R.

⚠️ **The package's raw output is NOT the oracle, deliberately.** Its first run here
disagreed with the app in 8 of 17 families, and both causes were the package's
arithmetic, not the method: an exact comparison that drops a support point equal to
the current p but rounded a hair above it (its sum comes out too small — it errs
toward significance), and no cap at 1 on the first step (an adjusted p of 1.6). The
generator gives every mathematically equal value one double and caps at 1; its
⚠️ block says how each was established. Never "fix" this file back to DHolm's raw
output, and read a regeneration's printed count of raw disagreements before
committing one.

Every number here is recomputed from the family's COUNTS by `comparison_basis` and
`multiplicity` — the p, the support, the correction and the marker — so the chain the
comparison runs is what is checked, not the correction alone.
"""
import json
from pathlib import Path

import pytest

from app.services import comparison_basis as cb
from app.services import multiplicity as mt

ORACLE = json.loads(
    (Path(__file__).parent / "reference_data" / "discrete_fwer_oracle.json").read_text())
FAMILIES = ORACLE["families"]
BY_NAME = {f["name"]: f for f in FAMILIES}

#: The file stores 15 significant digits.
TOL = 1e-12


def _ours(family):
    """Each test of the family run through the comparison's own presence test."""
    tests = [cb.presence_test(list(x), list(family["sizes"])) for x in family["successes"]]
    assert all(t is not None for t in tests), "a no-variance code is not in a family"
    return tests


def _close(a, b, rel=1e-9):
    return len(a) == len(b) and all(x == pytest.approx(y, rel=rel, abs=TOL) for x, y in zip(a, b))


# ── The file is whole (a population check: an empty oracle passes everything) ──

def test_the_oracle_file_is_whole():
    meta = ORACLE["meta"]
    assert meta["packages"]["DiscreteFWER"] == "1.0.0"
    assert meta["alpha"] == cb.COMPARISON_ALPHA
    assert len(FAMILIES) >= 17
    assert sum(len(f["raw_p"]) for f in FAMILIES) >= 250
    assert sum(len(f["sizes"]) == 2 for f in FAMILIES) >= 10
    assert sum(len(f["sizes"]) >= 3 for f in FAMILIES) >= 4
    assert any(len(f["sizes"]) == 4 for f in FAMILIES)
    for f in FAMILIES:
        m = len(f["successes"])
        for key in ("raw_p", "supports", "discrete_holm", "holm", "bh"):
            assert len(f[key]) == m, (f["name"], key)
        for key in ("discrete_holm", "holm", "bh"):
            assert len(f["best_case"][key]) == m, (f["name"], key)


# ── The chain, family by family ──────────────────────────────────────────────

@pytest.mark.parametrize("name", list(BY_NAME))
def test_p_values_and_supports_match_r(name):
    f = BY_NAME[name]
    for x, t, p, support in zip(f["successes"], _ours(f), f["raw_p"], f["supports"]):
        assert t["method"] in (cb.TEST_FISHER_EXACT, cb.TEST_FREEMAN_HALTON), x
        assert t["p_value"] == pytest.approx(p, rel=1e-9, abs=TOL), x
        assert _close(t["support"], support), (x, t["support"], support)
        assert t["min_attainable_p"] == pytest.approx(support[0], rel=1e-9, abs=TOL), x


@pytest.mark.parametrize("name", list(BY_NAME))
def test_discrete_holm_matches_discretefwer(name):
    f = BY_NAME[name]
    tests = _ours(f)
    got = mt.adjust_p_values([t["p_value"] for t in tests], mt.CORRECTION_DISCRETE_HOLM,
                             [t["support"] for t in tests])
    assert _close(got, f["discrete_holm"]), (got, f["discrete_holm"])


@pytest.mark.parametrize("name", list(BY_NAME))
@pytest.mark.parametrize("method,key", [(mt.CORRECTION_HOLM, "holm"), (mt.CORRECTION_BH, "bh")])
def test_holm_and_bh_match_p_adjust(name, method, key):
    f = BY_NAME[name]
    got = mt.adjust_p_values([t["p_value"] for t in _ours(f)], method)
    assert _close(got, f[key]), (got, f[key])


@pytest.mark.parametrize("name", list(BY_NAME))
@pytest.mark.parametrize("method,key", [(mt.CORRECTION_DISCRETE_HOLM, "discrete_holm"),
                                        (mt.CORRECTION_HOLM, "holm"), (mt.CORRECTION_BH, "bh")])
def test_the_marker_matches_r(name, method, key):
    """D2: the best adjusted p each code could ever get is the correction applied to
    the vector of every code's smallest attainable p."""
    f = BY_NAME[name]
    tests = _ours(f)
    got = mt.best_case_adjusted([t["min_attainable_p"] for t in tests], method,
                                [t["support"] for t in tests])
    assert _close(got, f["best_case"][key]), (got, f["best_case"][key])


def test_the_reviews_six_v_six_counts_come_from_the_package():
    """The record's numbers, now the package's: 40 codes at 6 v 6 — plain Holm stars
    nothing, discrete Holm stars three, and 20 codes could reach .05 under discrete
    Holm (not the 17 a ranked-first marker said)."""
    f = BY_NAME["review_6v6_40_codes"]
    a = cb.COMPARISON_ALPHA
    assert sum(p < a for p in f["holm"]) == 0
    assert sum(p < a for p in f["discrete_holm"]) == 3
    assert sum(p < a for p in f["best_case"]["discrete_holm"]) == 20
    assert all(p >= a for p in f["best_case"]["holm"])


# ── The fixture could have disagreed (backend/tests/the internal design notes's DISCRIMINATION rule) ──
# Each function below is a plausible WRONG reading of Zhu & Guo's step-down. If the
# oracle could not tell one from the real thing, matching it would prove nothing.

def _floor_strict(support, t):
    """F(t) read as the largest attainable p STRICTLY below t."""
    below = [s for s in support if s < t * (1 - 1e-9)]
    return below[-1] if below else 0.0


def _discrete_holm_variant(ps, sups, *, all_tests=False, running_max=True, floor=mt._floor):
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    out, running = [None] * len(ps), 0.0
    for rank, i in enumerate(order):
        pool = order if all_tests else order[rank:]
        total = min(1.0, sum(floor(sups[j], ps[i]) for j in pool))
        running = max(running, total) if running_max else total
        out[i] = running
    return out


def _ranked_first_marker(mins, sups):
    """The marker as first prototyped: each code's minimum as if it were ranked first."""
    return [min(1.0, sum(mt._floor(s, m) for s in sups)) for m in mins]


def _disagrees_somewhere(compute, key="discrete_holm"):
    for f in FAMILIES:
        tests = _ours(f)
        ps, sups = [t["p_value"] for t in tests], [t["support"] for t in tests]
        if not _close(compute(ps, sups), f[key], rel=1e-6):
            return f["name"]
    return None


@pytest.mark.parametrize("label,wrong", [
    ("plain Holm (supports ignored)", lambda ps, sups: mt.adjust_p_values(ps, mt.CORRECTION_HOLM)),
    ("summed over every test, not those not yet rejected",
     lambda ps, sups: _discrete_holm_variant(ps, sups, all_tests=True)),
    ("no running maximum", lambda ps, sups: _discrete_holm_variant(ps, sups, running_max=False)),
    ("F(t) strictly below t", lambda ps, sups: _discrete_holm_variant(ps, sups, floor=_floor_strict)),
])
def test_the_oracle_can_tell_discrete_holm_from_a_wrong_form(label, wrong):
    assert _disagrees_somewhere(wrong) is not None, f"no family separates {label!r} from DiscreteFWER"


def test_the_oracle_can_tell_the_marker_from_its_ranked_first_form():
    f = BY_NAME["discriminating_6v6"]
    tests = _ours(f)
    mins, sups = [t["min_attainable_p"] for t in tests], [t["support"] for t in tests]
    assert not _close(_ranked_first_marker(mins, sups), f["best_case"]["discrete_holm"], rel=1e-6)
