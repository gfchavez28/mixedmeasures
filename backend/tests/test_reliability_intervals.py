"""Confidence intervals on the reliability coefficients (queue #43).

Four layers, and the FIRST one is the load-bearing one:

1. **The analytic κ variance against a numerically-derived delta method.** κ is a
   smooth function of the 2×2 cell proportions, so its asymptotic variance can be
   recomputed from a numerical gradient with no formula to mis-transcribe. This
   is what caught the real defect: the first implementation divided by (1−pe)²
   instead of (1−pe)⁴ and returned an interval roughly HALF the correct width —
   a confident, plausible, too-narrow interval, which is the worst failure this
   feature has. **No fixture-based assertion can see that by looking**, which is
   why the pin recomputes the quantity rather than comparing to a stored number.
2. **The R oracle** — `psych::cohen.kappa`, which reports the CI form.
   ⚠️ `irr::kappa2` CANNOT serve: its z uses the null-hypothesis SE.
3. **Discrimination** (`backend/tests/the internal design notes): a fixture on which the right
   and the plausible-wrong implementations agree proves nothing, so the oracle
   fixture is asserted to SEPARATE the CI variance from both the (1−pe)²
   shorthand and the null-hypothesis SE.
4. **Bootstrap properties** — determinism, the identity-resample invariant, and
   the cluster structure the pooled interval depends on.
"""
import math
import subprocess

import numpy as np
import pytest

from app.services.irr import _cohens_kappa, _krippendorff_alpha, unit_coincidence
from app.services.reliability_intervals import (
    BOOTSTRAP_RESAMPLES,
    CI_LEVEL,
    CI_METHOD_ALPHA_BOOTSTRAP_UNITS,
    CI_METHOD_KAPPA_ANALYTIC,
    _dedup_types,
    alpha_interval,
    kappa_interval,
    pooled_unit_contributions,
    unit_contributions,
)
from tests import r_support

# A deliberately ordinary two-coder fixture: 300 units, prevalence ≈ 0.36,
# κ ≈ 0.665. Big enough that the normal approximation is honest, unbalanced
# enough that the marginals are not symmetric (a symmetric table is degenerate
# on the axis these formulas differ along).
TABLE = {(0, 0): 159, (0, 1): 34, (1, 0): 14, (1, 1): 93}


def _units_from_table(table: dict[tuple, int]) -> list[list[int | None]]:
    rows: list[list[int | None]] = []
    for (a, b), count in table.items():
        rows.extend([[a, b]] * count)
    return rows


def _proportions(table: dict[tuple, int]) -> np.ndarray:
    n = sum(table.values())
    return np.array([table[(0, 0)], table[(0, 1)],
                     table[(1, 0)], table[(1, 1)]], dtype=float) / n


def _kappa_of(p: np.ndarray) -> float:
    p00, p01, p10, p11 = p
    po = p00 + p11
    pe = (p00 + p01) * (p00 + p10) + (p10 + p11) * (p01 + p11)
    return (po - pe) / (1 - pe)


def _delta_method_variance(p: np.ndarray, n: int) -> float:
    """var(κ̂) from a NUMERICAL gradient — no closed form to get wrong.

    var = (1/n)·gᵀ(diag(p) − ppᵀ)g for the multinomial cell proportions.
    """
    eps = 1e-7
    grad = np.array([
        (_kappa_of(p + eps * e) - _kappa_of(p - eps * e)) / (2 * eps)
        for e in np.eye(len(p))
    ])
    return float(grad @ (np.diag(p) - np.outer(p, p)) @ grad / n)


# ── 1. The structural pin ────────────────────────────────────────────────────


@pytest.mark.parametrize("table", [
    TABLE,
    {(0, 0): 40, (0, 1): 10, (1, 0): 5, (1, 1): 45},     # near-balanced
    {(0, 0): 70, (0, 1): 5, (1, 0): 3, (1, 1): 22},      # skewed prevalence
    {(0, 0): 20, (0, 1): 30, (1, 0): 25, (1, 1): 25},    # poor agreement
    # Small n, chosen so NEITHER bound reaches the clamp — at n = 10 with high
    # agreement the upper bound exceeds 1 and is clamped, which legitimately
    # makes the reconstructed SE smaller than the delta method's. That case is
    # covered by `test_kappa_bounds_are_clamped_to_the_parameter_space` instead.
    {(0, 0): 8, (0, 1): 4, (1, 0): 3, (1, 1): 5},
])
def test_the_analytic_variance_equals_the_delta_method(table):
    """The one assertion that could catch a wrong exponent.

    Reconstructs the SE our interval implies and compares it against the
    delta-method variance recomputed from a numerical gradient. Under the
    original (1−pe)² the ratio was ~2.1 on the first table and ~2.6 on the
    third — not even a constant factor, so a single stored expected value would
    also have looked "close enough" on the wrong table.
    """
    units = _units_from_table(table)
    n = sum(table.values())
    p = _proportions(table)

    ci = kappa_interval(units)
    assert ci is not None
    # Reconstructing the SE from the bounds is only valid while neither bound is
    # clamped — otherwise this test would quietly measure the clamp instead.
    assert -1.0 < ci["lower"] and ci["upper"] < 1.0, (
        "fixture clamps, so the SE cannot be read back from its bounds"
    )
    implied_se = (ci["upper"] - ci["lower"]) / 2 / 1.959963984540054
    expected_se = math.sqrt(_delta_method_variance(p, n))

    # 1e-3 absolute, not exact: the interval's bounds are rounded to 4 dp.
    assert implied_se == pytest.approx(expected_se, abs=1e-3), (
        f"analytic SE {implied_se:.6f} disagrees with the delta method "
        f"{expected_se:.6f} — check the (1−pe)**4 exponent in kappa_interval."
    )


def test_the_fixture_could_have_disagreed():
    """DISCRIMINATION (`backend/tests/the internal design notes): this fixture separates the
    correct variance from BOTH plausible wrong ones.

    Without this, an oracle that happens to agree on a degenerate table would
    certify either mistake. Both wrong forms are computed here explicitly so the
    gap is a measured fact rather than a claim in a comment.
    """
    p = _proportions(TABLE)
    n = sum(TABLE.values())
    p00, p01, p10, p11 = p
    cells = {(0, 0): p00, (0, 1): p01, (1, 0): p10, (1, 1): p11}
    row = {0: p00 + p01, 1: p10 + p11}
    col = {0: p00 + p10, 1: p01 + p11}
    po = p00 + p11
    pe = row[0] * col[0] + row[1] * col[1]

    numerator = (
        sum(cells[(c, c)] * ((1 - pe) - (row[c] + col[c]) * (1 - po)) ** 2 for c in (0, 1))
        + (1 - po) ** 2 * sum(cells[(i, j)] * (col[i] + row[j]) ** 2
                              for i in (0, 1) for j in (0, 1) if i != j)
        - (po * pe - 2 * pe + po) ** 2
    )
    correct = math.sqrt(numerator / (n * (1 - pe) ** 4))
    shorthand = math.sqrt(numerator / (n * (1 - pe) ** 2))   # the exponent slip
    # The NULL-hypothesis SE — what `irr::kappa2`'s z reports.
    null_se = math.sqrt(
        (pe + pe ** 2 - sum(row[c] * col[c] * (row[c] + col[c]) for c in (0, 1)))
        / (n * (1 - pe) ** 2)
    )

    # The shorthand is the NARROWER of the two — that is exactly why it is
    # dangerous, and why the direction of this assertion matters.
    assert shorthand < correct
    assert shorthand / correct < 0.6, "fixture cannot separate the two exponents"
    assert abs(correct - null_se) / correct > 0.25, (
        "fixture cannot separate the CI variance from the null-hypothesis SE — "
        "an oracle written on it would pass with irr::kappa2's number"
    )


# ── 2. The R oracle ──────────────────────────────────────────────────────────


@pytest.mark.skipif(not r_support.HAS_PSYCH, reason=r_support.SKIP_REASON_PSYCH)
def test_kappa_interval_matches_psych_cohen_kappa():
    """`psych::cohen.kappa` reports the CI form of the variance.

    ⚠️ The oracle applies OUR clamp to [−1, 1] before comparing, so the clamp is
    part of the contract rather than a display-only fudge that would let the two
    halves drift (this fixture is nowhere near the boundary, but the next one
    might be).
    """
    script = f"""
suppressMessages(library(psych))
m <- matrix(c({TABLE[(0, 0)]},{TABLE[(0, 1)]},{TABLE[(1, 0)]},{TABLE[(1, 1)]}),
            nrow = 2, byrow = TRUE)
k <- cohen.kappa(m)
cat("lower", max(-1, k$confid["unweighted kappa", "lower"]), "\\n")
cat("upper", min(1, k$confid["unweighted kappa", "upper"]), "\\n")
"""
    out = subprocess.run([r_support.RSCRIPT, "--vanilla", "-e", script],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    r_values = {}
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] in ("lower", "upper"):
            r_values[parts[0]] = float(parts[1])
    assert set(r_values) == {"lower", "upper"}, out.stdout

    ci = kappa_interval(_units_from_table(TABLE))
    assert ci is not None
    assert ci["lower"] == pytest.approx(r_values["lower"], abs=1e-4)
    assert ci["upper"] == pytest.approx(r_values["upper"], abs=1e-4)
    assert ci["method"] == CI_METHOD_KAPPA_ANALYTIC
    assert ci["level"] == CI_LEVEL


# ── 3. κ edges ───────────────────────────────────────────────────────────────


def test_kappa_interval_is_none_when_kappa_is():
    """No complete pairs, and no variance to agree about, both yield None.

    The cell then shows the STATISTIC's own `undefined_reason` (#829/#689); a
    second explanation for one blank cell is noise, not disclosure.
    """
    assert kappa_interval([]) is None
    assert kappa_interval([[1, None], [None, 0]]) is None
    assert kappa_interval([[1, 1], [1, 1], [1, 1]]) is None   # pe == 1


def test_kappa_bounds_are_clamped_to_the_parameter_space():
    """κ cannot leave [−1, 1]; the normal approximation can."""
    units = [[1, 1]] * 40 + [[0, 0]] * 39 + [[1, 0]]
    ci = kappa_interval(units)
    assert ci is not None
    assert ci["upper"] <= 1.0 and ci["lower"] >= -1.0
    # And the fixture is one where the unclamped bound really would escape,
    # or the clamp is untested.
    assert _cohens_kappa(units) > 0.95


def test_wider_rows_are_a_precondition_violation_not_a_silent_zero():
    """Same trap as `_cohens_kappa` (#828): rows must already be 2 wide.

    A 3-wide row is dropped by the `len(r) == 2` filter, so an unprojected
    matrix yields None rather than a number computed from a subset.
    """
    assert kappa_interval([[1, 1, 0], [0, 0, 1]]) is None


# ── 4. The α bootstrap ───────────────────────────────────────────────────────

M_BASIC = [[1, 1], [1, 0], [0, 0], [0, 0]]


def test_the_bootstrap_and_the_point_estimate_share_their_arithmetic():
    """IDENTITY RESAMPLE: drawing every unit exactly once must reproduce α.

    This is what proves the interval is built from the same formula as the
    estimate rather than from a second implementation of it (#733's class). It
    bypasses the RNG deliberately — the property is about the arithmetic.
    """
    from app.services.irr import alpha_from_coincidence

    contributions = unit_contributions(M_BASIC)
    pair_keys, vectors, counts = _dedup_types(contributions)
    totals = np.asarray(vectors, dtype=float).T @ np.asarray(counts, dtype=float)
    o = {pair: float(v) for pair, v in zip(pair_keys, totals) if v}

    assert alpha_from_coincidence(o) == pytest.approx(_krippendorff_alpha(M_BASIC))


def test_dedup_keeps_every_unit_including_the_ones_that_contribute_nothing():
    """A unit fewer than two coders judged still belongs to the sample.

    Dropping it would shrink the population the interval is about, which
    narrows the interval for a reason that has nothing to do with agreement.
    """
    units = M_BASIC + [[1, None], [None, None]]
    _keys, _vectors, counts = _dedup_types(unit_contributions(units))
    assert sum(counts) == len(units)


def test_the_interval_is_deterministic():
    """An unseeded bootstrap gives a different interval on every page load, so a
    quoted one is unreproducible and two readers disagree about the number."""
    first = alpha_interval(unit_contributions(M_BASIC))
    second = alpha_interval(unit_contributions(M_BASIC))
    assert first == second
    assert first["method"] == CI_METHOD_ALPHA_BOOTSTRAP_UNITS
    assert first["n_resamples"] <= BOOTSTRAP_RESAMPLES


def test_the_interval_brackets_the_point_estimate_and_reflects_sample_size():
    """More units on the same process ⇒ a narrower interval."""
    small = [[1, 1], [1, 0], [0, 0], [0, 1], [1, 1], [0, 0]]
    large = small * 40
    ci_small = alpha_interval(unit_contributions(small))
    ci_large = alpha_interval(unit_contributions(large))
    alpha_large = _krippendorff_alpha(large)

    assert ci_small["lower"] <= _krippendorff_alpha(small) <= ci_small["upper"]
    assert ci_large["lower"] <= alpha_large <= ci_large["upper"]
    assert (ci_large["upper"] - ci_large["lower"]) < (ci_small["upper"] - ci_small["lower"]) / 3


def test_an_empty_sample_has_no_interval():
    assert alpha_interval([]) is None
    # Not one unit had two coders — α is undefined for the sample itself.
    assert alpha_interval(unit_contributions([[1, None], [None, 0]])) is None


# ── 5. The pooled interval is a CLUSTER bootstrap ────────────────────────────


def test_pooled_contributions_sum_each_units_rows_across_codes():
    """One contribution per UNIT, not one per (unit × code) row."""
    code_a = [[1, 1], [0, 0], [1, 0]]
    code_b = [[0, 0], [1, 1], [0, 0]]
    pooled = pooled_unit_contributions([code_a, code_b])

    assert len(pooled) == 3, "one entry per unit, not per row"
    for i in range(3):
        expected: dict[tuple, float] = {}
        for pair, val in unit_coincidence(code_a[i]).items():
            expected[pair] = expected.get(pair, 0.0) + val
        for pair, val in unit_coincidence(code_b[i]).items():
            expected[pair] = expected.get(pair, 0.0) + val
        assert pooled[i] == expected


def test_the_cluster_bootstrap_is_wider_than_treating_rows_as_independent():
    """The reason the pooled interval must cluster.

    A unit contributes one row per code and those rows move together, so
    resampling the concatenated rows independently reports an interval that is
    too NARROW. Measured here rather than asserted in a comment — if the two ever
    coincide, the clustering has stopped doing anything.
    """
    unit_rows = [[1, 1], [1, 0], [0, 0], [0, 1], [1, 1], [0, 0], [1, 1], [0, 0]]
    # Five codes that agree with each other unit-by-unit: maximal clustering.
    per_code = [list(unit_rows) for _ in range(5)]

    clustered = alpha_interval(pooled_unit_contributions(per_code))
    naive = alpha_interval(unit_contributions([r for rows in per_code for r in rows]))

    assert (clustered["upper"] - clustered["lower"]) > (naive["upper"] - naive["lower"])


def test_pooled_contributions_refuse_matrices_that_disagree_about_the_units():
    """The shared unit order is a precondition, and it is checked rather than
    trusted — a reordered matrix would pair unit i's row with unit j's cluster
    and nothing downstream would notice."""
    with pytest.raises(ValueError, match="shared unit order"):
        pooled_unit_contributions([[[1, 1], [0, 0]], [[1, 1]]])


# ── 6. A rare code, and the bound the old convention manufactured ────────────


def _rare_code_units() -> list[list[int | None]]:
    """A code present on 2 of 200 units, one of them a disagreement.

    ⚠️ **The instance count is solved for, not chosen.** A bootstrap resample of
    *n* units misses any given unit with probability (1−1/n)ⁿ ≈ e⁻¹, so it
    misses all *k* instances with probability ≈ e⁻ᵏ — and the refusal needs that
    to exceed `MIN_VALID_FRACTION`'s 10%, i.e. **k ≤ 2**. The first draft used 3
    perfectly-agreeing instances and reported a cheerful [1.0, 1.0]: ~95% of
    resamples still contained one, so it never reached the branch it was written
    for. The disagreement matters too — without it every defined resample gives
    α = 1.0 and the fixture cannot tell a refusal from a degenerate estimate.
    """
    return [[1, 1], [1, 0]] + [[0, 0]] * 198


def _common_code_units() -> list[list[int | None]]:
    """The same code, common enough that resamples reliably contain it AND its
    disagreements — the positive control for the refusal above."""
    return ([[1, 1]] * 60 + [[1, 0]] * 20 + [[0, 1]] * 20 + [[0, 0]] * 100)


def test_a_rare_code_refuses_its_interval_instead_of_reporting_a_perfect_upper_bound():
    """🔴 FOUND ON REAL DATA, not by a fixture — the live panel reported a code
    with α = 0.85 as **[0.00, 1.00]**.

    Most resamples of a rare code contain no instance of it, so every present
    cell is equal, `de_num` is 0, and `alpha_from_coincidence` returns its
    documented 1.0 ("no possible disagreement"). Counting those as ordinary
    draws pushes the upper bound to exactly 1 — which is #829's defect reached
    from underneath, since the POINT estimate refuses to report a zero-variance
    code at all rather than calling it "almost perfect".
    """
    ci = alpha_interval(unit_contributions(_rare_code_units()))
    assert ci is not None
    assert ci["lower"] is None and ci["upper"] is None
    assert ci["unavailable_reason"] == "no_variance_in_resamples"


def test_the_fixture_would_have_produced_the_manufactured_bound():
    """DISCRIMINATION: the fixture above can tell the two conventions apart.

    Recomputes the interval the OLD behaviour would have given — counting
    no-variance resamples as α = 1.0 — and requires that it (a) succeeds and
    (b) reports exactly the perfect upper bound the fix exists to remove. Without
    this, the test above would pass against an implementation that refused every
    interval for some unrelated reason.
    """
    import numpy as np
    from app.services.irr import alpha_from_coincidence

    contributions = unit_contributions(_rare_code_units())
    pair_keys, vectors, counts = _dedup_types(contributions)
    rng = np.random.default_rng(20260901)
    draws = rng.multinomial(len(contributions),
                            np.asarray(counts, dtype=float) / len(contributions),
                            size=2000)
    sums = draws @ np.asarray(vectors, dtype=float)
    old = [a for a in (alpha_from_coincidence(
        {p: float(v) for p, v in zip(pair_keys, totals) if v}) for totals in sums)
        if a is not None]

    assert len(old) > 1900, "the old convention kept nearly every resample"
    assert float(np.percentile(old, 97.5)) == 1.0, (
        "fixture does not reach the manufactured upper bound, so it cannot show "
        "the fix changed anything"
    )


def test_a_common_code_still_gets_its_interval():
    """The refusal must be keyed on the code being RARE, not on the guard being
    trigger-happy — otherwise the feature quietly stops shipping intervals."""
    ci = alpha_interval(unit_contributions(_common_code_units()))
    assert ci is not None
    assert ci["unavailable_reason"] is None
    assert ci["lower"] is not None and ci["upper"] is not None
    assert ci["upper"] < 1.0, "a code with real disagreements should not bound at 1"
    assert ci["lower"] <= _krippendorff_alpha(_common_code_units()) <= ci["upper"]


def test_too_few_double_coded_units_is_a_DIFFERENT_reason_from_rarity():
    """Disjoint causes with different remedies — 'code more units' does not help
    a rare code, and 'find more instances' does not help an uncoded corpus."""
    # Every unit judged by ONE coder: no resample has anything comparable.
    ci = alpha_interval(unit_contributions([[1, None]] * 40 + [[None, 0]] * 40))
    assert ci is None, "not one unit was double-coded, so there is no α to bracket"


# ── 5. #35 — the metric rides into the interval ──────────────────────────────


def _rating_units() -> list[list[float | None]]:
    """Two coders' ratings on a −1…+1 scale. Agreement is mostly NEAR and rarely
    exact — the regime where the nominal metric (match or not) and the interval
    metric (how far apart) disagree most, so the fixture can tell them apart."""
    return [
        [1.0, 0.5], [0.5, 0.5], [0.0, 0.5], [-0.5, -1.0], [-1.0, -1.0],
        [0.0, 0.0], [1.0, 1.0], [0.5, 0.0], [-0.5, 0.0], [1.0, 0.5],
    ] * 3


def test_the_interval_takes_the_metric_the_estimate_used():
    """🔴 Before #35's α slab `alpha_interval` had no `metric` parameter: every
    resample was scored NOMINALLY whatever the point estimate used, so an
    interval-metric α would have been bracketed by a nominal interval —
    plausible bounds, wrong width, no error. The close-out notes had called the
    machinery "metric-agnostic"; this is the test that would have refuted it."""
    rows = _rating_units()
    contribs = unit_contributions(rows)
    a_interval = _krippendorff_alpha(rows, "interval")
    a_nominal = _krippendorff_alpha(rows, "nominal")
    # Discrimination: the fixture makes the two metrics produce different numbers.
    assert abs(a_interval - a_nominal) > 0.1, (a_interval, a_nominal)

    interval_ci = alpha_interval(contribs, metric="interval")
    nominal_ci = alpha_interval(contribs, metric="nominal")
    assert interval_ci["lower"] <= a_interval <= interval_ci["upper"]
    assert nominal_ci["lower"] <= a_nominal <= nominal_ci["upper"]
    # A `metric` that is accepted and ignored reproduces the nominal interval.
    assert (interval_ci["lower"], interval_ci["upper"]) != (nominal_ci["lower"], nominal_ci["upper"])


def test_the_default_metric_is_nominal_so_existing_callers_are_unchanged():
    contribs = unit_contributions(_units_from_table(TABLE))
    assert alpha_interval(contribs) == alpha_interval(contribs, metric="nominal")


def test_an_unknown_metric_is_refused_not_silently_nominal():
    with pytest.raises(ValueError, match="metric"):
        alpha_interval(unit_contributions(_rating_units()), metric="euclidean")


def test_identical_ratings_in_a_resample_are_dropped_on_the_interval_metric_too():
    """#829's rider is metric-independent: a resample whose compared values are
    all one number has no variance, and must not enter the tail as α = 1."""
    rows = [[0.5, 0.5]] * 30 + [[0.5, 1.0]] * 2
    ci = alpha_interval(unit_contributions(rows), metric="interval")
    assert ci is not None
    # Either refused with the rarity reason, or bounded strictly below 1 — never
    # a manufactured upper bound of exactly 1.0.
    assert ci["upper"] is None or ci["upper"] < 1.0
