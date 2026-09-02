"""Confidence intervals for the reliability coefficients (queue #43).

κ, Krippendorff's α and u-α all reported a bare point estimate. Reporting
α = 0.72 with no interval is exactly what a methods reviewer circles, and
"honest statistics" is the claim the release rests on — so this module adds the
interval **where one is defined**, and says why there is none where it is not.

## The two estimators, and why they are different in kind

* **Cohen's κ — an analytic interval.** The large-sample variance of κ̂ (Fleiss,
  Cohen & Everitt 1969) has a closed form, so no resampling is needed and the
  result is deterministic.

  🔴 **There are TWO standard SEs for κ and only one of them gives a confidence
  interval.** The other tests H₀: κ = 0 and is what ``irr::kappa2``'s z-statistic
  reports — it is computed under the null, so it is the wrong width for an
  interval around the OBSERVED κ. Using it would produce a plausible, wrong
  interval that nothing but an oracle would catch. `psych::cohen.kappa` reports
  the CI form, and `psych` is already in ``REQUIRED_R_PACKAGES``, so the choice
  is pinned by a real R oracle rather than by this comment.

* **Krippendorff's α — a nonparametric bootstrap over UNITS.** α has no usable
  closed-form variance, and the bootstrap is what the field does. The basis is
  the dangerous half and therefore rides the wire: **units are resampled, coders
  are not.** The interval answers "how much would α move if we had coded a
  different sample of this material?", never "…if a different pair of people had
  coded it".

  ⚠️ **This is a unit-level percentile bootstrap, NOT "Krippendorff's
  bootstrap".** Krippendorff (2004) describes a different procedure that
  resamples from the coincidence matrix. Both are defensible; they are not the
  same, and the codebase's positioning ledger exists because claims like this get
  checked. `ci_method` states which one this is.

## Why the pooled interval is a CLUSTER bootstrap

The headline α pools every code's matrix into one, so a unit appears once PER
CODE. Resampling those rows as if they were independent would report an interval
that is too narrow — the rows of one unit move together. The unit is the cluster,
so `pooled_unit_contributions` sums a unit's per-code contributions and the
resample draws whole units. This is safe because `build_irr_matrices` builds
every per-code matrix from the same ``units`` list in the same order.

## Cost — solved by dedup, not by a cap

A unit's contribution to the coincidence matrix depends only on how many coders
recorded each value, not on which coder held which (see
``irr.unit_coincidence``). So thousands of units collapse into a handful of
interchangeable TYPES, and a resample is a multinomial over types — exact, and
O(types) rather than O(units). A 75,699-unit column costs the same as a 60-unit
one.

## Determinism

🔴 **The seed is FIXED, and that is a correctness requirement, not tidiness.**
An unseeded bootstrap gives a different interval on every page load, so a
researcher who quotes one in a paper cannot reproduce it — and two people
reading the same panel would disagree about the number. It is a reported methods
parameter, like the 100 ms unitizing tick and the binned-κ bin width.
"""
from __future__ import annotations

import math
from collections import defaultdict

from .irr import alpha_from_coincidence, unit_coincidence
from .reliability_basis import ALPHA_METRIC_NOMINAL, ALPHA_METRICS
from .undefined_stats import finite_or_none

# ── The vocabulary (stated-basis family — mirrored in lib/ci-label.ts) ────────
#
# `ci_method` says HOW an interval was produced; the client DISPLAYS that and
# never infers it. Pinned across languages by `test_ci_method_contract.py`,
# which reads THIS module as well as `metrics.py` — a constant added here
# without a client descriptor falls through to a bare "95% CI", which is the
# exact false statement `ci-label.ts` exists to prevent.

#: Fleiss–Cohen–Everitt (1969) asymptotic variance → normal interval. NOT the
#: null-hypothesis SE that `irr::kappa2` reports.
CI_METHOD_KAPPA_ANALYTIC = "kappa_analytic_se"

#: Nonparametric percentile bootstrap resampling UNITS with replacement.
CI_METHOD_ALPHA_BOOTSTRAP_UNITS = "alpha_bootstrap_units"

# ── Why an interval is ABSENT ────────────────────────────────────────────────
#
# ⚠️ These describe a statistic that HAS a value but no interval. When the
# statistic itself is undefined the interval is simply `None` and the
# statistic's own `undefined_reason` (services/undefined_stats.py) explains it —
# two reasons for one blank cell is worse than one.

#: u-α is measured over ONE continuum, and its "units" are the marked stretches
#: whose boundaries are the very thing being measured — resampling them changes
#: the continuum and the expected disagreement. Neither Krippendorff (1995,
#: 2004) nor the DKPro reference implementation defines a bootstrap for it.
CI_UNAVAILABLE_SINGLE_CONTINUUM = "single_continuum"

#: Time bins are not independent — a 5 s mark occupies five 1 s bins — so a
#: naive bin bootstrap understates the interval. The correct method is a block
#: bootstrap whose block length is itself a research decision.
CI_UNAVAILABLE_AUTOCORRELATED_BINS = "autocorrelated_bins"

#: Too many resamples drew no unit that two coders both judged, so α was
#: undefined for them. The remedy is more double-coding.
CI_UNAVAILABLE_INSUFFICIENT_UNITS = "insufficient_units"

#: 🔴 Too many resamples had NO VARIANCE — the code is rare (or near-universal)
#: enough here that a resample often contains no instance of it at all.
#:
#: **This is #829's rider one level down, and it was found by running the
#: feature on a real project rather than by reasoning.** A no-variance resample
#: makes every present cell equal, so the α formula's `de_num` is 0 and the
#: documented convention returns 1.0 — "perfect agreement". Counting those as
#: ordinary draws pushed a code's upper bound to exactly 1.00 (measured: α =
#: 0.85 reported as [0.00, 1.00]) — manufactured by precisely the arithmetic
#: #829 removed from the POINT estimate, where a zero-variance code is `None`
#: with a reason rather than κ = 1 "almost perfect". A distinct reason from
#: `insufficient_units` because the remedy differs: no amount of extra coding
#: makes a rare code common.
CI_UNAVAILABLE_NO_VARIANCE_IN_RESAMPLES = "no_variance_in_resamples"

CI_UNAVAILABLE_REASONS = frozenset({
    CI_UNAVAILABLE_SINGLE_CONTINUUM,
    CI_UNAVAILABLE_AUTOCORRELATED_BINS,
    CI_UNAVAILABLE_INSUFFICIENT_UNITS,
    CI_UNAVAILABLE_NO_VARIANCE_IN_RESAMPLES,
})

# ── Reported methods parameters ──────────────────────────────────────────────

#: Two-tailed 95%. Single-sourced from `metrics.py` so the app has ONE confidence
#: level — B9 makes it configurable in one place because of imports like this.
CI_LEVEL = 0.95

#: Resamples for the α bootstrap. Rides the payload as `n_resamples`.
BOOTSTRAP_RESAMPLES = 2000

#: Fixed so the panel is reproducible (see the module docstring).
BOOTSTRAP_SEED = 20260901

#: A resample can legitimately produce an UNDEFINED α (it drew only units with
#: fewer than two coders). Those are dropped, and if too many drop out the
#: interval is refused rather than computed from a biased remainder.
MIN_VALID_FRACTION = 0.9

_STATS_PRECISION = 4


def _z_critical() -> float:
    """The two-tailed normal quantile for `CI_LEVEL`.

    Imported from `metrics.py` rather than re-inlined: a second `1.96` in the
    same app is the #733 class, and `metrics._Z_975` is already the exact
    `qnorm(0.975)` rather than the textbook rounding (#768).
    """
    from .metrics import _Z_975
    return _Z_975


def _interval(lower: float | None, upper: float | None, method: str,
              *, n_resamples: int | None = None,
              unavailable_reason: str | None = None) -> dict:
    return {
        "lower": lower,
        "upper": upper,
        "level": CI_LEVEL,
        "method": method,
        "n_resamples": n_resamples,
        "unavailable_reason": unavailable_reason,
    }


# ── Cohen's κ — analytic ─────────────────────────────────────────────────────


def kappa_interval(units: list[list[int | None]]) -> dict | None:
    """Analytic 95% CI for Cohen's unweighted κ over 2-wide unit rows.

    ``units`` must ALREADY be narrowed to the two engaged coders' columns — the
    same precondition `_cohens_kappa` carries, and for the same reason: a wider
    row is silently dropped by the ``len(r) == 2`` filter (#828).

    Returns ``None`` when κ itself is undefined (no complete pairs, or expected
    agreement of exactly 1), because then the cell shows the statistic's own
    reason and a second explanation is noise.

    The variance is Fleiss, Cohen & Everitt (1969):

        var(κ) = 1/(N(1−pe)⁴) · [ Σᵢ pᵢᵢ((1−pe) − (pᵢ·+p·ᵢ)(1−po))²
                                + (1−po)² Σᵢ Σⱼ≠ᵢ pᵢⱼ(p·ᵢ+pⱼ·)²
                                − (po·pe − 2pe + po)² ]

    🔴 **THE EXPONENT IS 4, AND THE FIRST DRAFT OF THIS FUNCTION USED 2** — the
    shorthand several sources print, in which the bracket terms are already
    divided through. It produced an interval roughly HALF the correct width
    (measured: [0.624, 0.706] where the truth is [0.579, 0.751]), which is the
    worst possible failure for this feature: a confident, plausible, too-narrow
    interval on the number the release's honest-statistics claim rests on. It is
    derivable rather than memorable — κ = (po−pe)/(1−pe), so

        ∂κ/∂p_ab = ( [a=b](1−pe) − (p·ₐ+p_b·)(1−po) ) / (1−pe)²

    and the delta-method variance squares that denominator. The bracketed terms
    above ARE that gradient's diagonal, off-diagonal and mean parts. **Pinned by
    `test_reliability_intervals.py::test_the_analytic_variance_equals_the_delta_method`,
    which recomputes the gradient numerically** — the assertion that actually
    caught this, because a fixture cannot tell a half-width interval from a
    right one by looking.

    ⚠️ **Bounds are clamped to [−1, 1].** κ cannot leave that range, and the
    normal approximation can — an upper bound of 1.04 beside "almost perfect" is
    a number no researcher can use. The R oracle applies the same clamp to
    `psych::cohen.kappa`'s output rather than comparing unclamped, so the clamp
    is part of the contract instead of a display-only fudge that would let the
    two halves drift.
    """
    pairs = [(r[0], r[1]) for r in units
             if len(r) == 2 and r[0] is not None and r[1] is not None]
    n = len(pairs)
    if n == 0:
        return None

    cats = sorted({a for a, _ in pairs} | {b for _, b in pairs})
    p: dict[tuple, float] = defaultdict(float)
    for a, b in pairs:
        p[(a, b)] += 1.0 / n
    # Marginals: `row[i]` is rater 1's share of category i, `col[i]` rater 2's.
    row = {c: sum(p[(c, k)] for k in cats) for c in cats}
    col = {c: sum(p[(k, c)] for k in cats) for c in cats}

    po = sum(p[(c, c)] for c in cats)
    pe = sum(row[c] * col[c] for c in cats)
    if pe >= 1.0:
        # No variance to agree about — `_cohens_kappa` returns 1.0 or 0.0 here
        # and `compute_irr` declines the whole row (#829's zero-prevalence
        # rider). An interval around a degenerate point estimate would dress it
        # up as a measurement.
        return None

    term_a = sum(
        p[(c, c)] * ((1.0 - pe) - (row[c] + col[c]) * (1.0 - po)) ** 2
        for c in cats
    )
    term_b = (1.0 - po) ** 2 * sum(
        p[(i, j)] * (col[i] + row[j]) ** 2
        for i in cats for j in cats if i != j
    )
    term_c = (po * pe - 2.0 * pe + po) ** 2
    # ⚠️ (1−pe)**4 — see the docstring. Not a typo for **2.
    variance = (term_a + term_b - term_c) / (n * (1.0 - pe) ** 4)
    # Algebraically non-negative; float cancellation can leave a tiny negative
    # when po == 1 (where the true variance is 0).
    if variance < 0.0:
        if variance < -1e-9:
            return None
        variance = 0.0

    kappa = (po - pe) / (1.0 - pe)
    margin = _z_critical() * math.sqrt(variance)
    lower = finite_or_none(max(-1.0, kappa - margin), _STATS_PRECISION)
    upper = finite_or_none(min(1.0, kappa + margin), _STATS_PRECISION)
    if lower is None or upper is None:
        return None
    return _interval(lower, upper, CI_METHOD_KAPPA_ANALYTIC)


# ── Krippendorff's α — unit bootstrap ────────────────────────────────────────


def unit_contributions(units: list[list[int | None]]) -> list[dict[tuple, float]]:
    """Each unit's coincidence contribution — the bootstrap's sample."""
    return [unit_coincidence(row) for row in units]


def pooled_unit_contributions(
    per_code_rows: list[list[list[int | None]]],
) -> list[dict[tuple, float]]:
    """One contribution per UNIT, summed across the codes pooled into the headline.

    🔴 **This is what makes the pooled interval a cluster bootstrap.** The
    headline α is computed over every code's rows concatenated, so a unit appears
    once per code; resampling those rows independently would report an interval
    that is too narrow, because one unit's rows move together.

    ⚠️ **Every matrix must be the same length and in the same unit order.**
    `build_irr_matrices` guarantees both — it iterates the SAME ``units`` list
    for every code — and this function asserts it rather than trusting it,
    because a future change that reorders one code's rows would silently pair
    unit *i*'s row with unit *j*'s cluster and nothing else would notice.
    """
    if not per_code_rows:
        return []
    length = len(per_code_rows[0])
    for rows in per_code_rows:
        if len(rows) != length:
            raise ValueError(
                "pooled bootstrap needs one row per unit per code, in a shared "
                f"unit order — got matrices of length {length} and {len(rows)}"
            )
    out: list[dict[tuple, float]] = []
    for i in range(length):
        merged: dict[tuple, float] = defaultdict(float)
        for rows in per_code_rows:
            for pair, val in unit_coincidence(rows[i]).items():
                merged[pair] += val
        out.append(merged)
    return out


def _dedup_types(
    contributions: list[dict[tuple, float]],
) -> tuple[list[tuple], list[tuple[float, ...]], list[int]]:
    """Collapse units into interchangeable TYPES.

    Returns ``(pair_keys, type_vectors, type_counts)``. A unit that contributes
    nothing (fewer than two coders judged it) becomes the all-zero type and is
    KEPT — it is still a unit that a resample can draw, and dropping it would
    shrink the sample the interval is about.
    """
    pair_keys = sorted({pair for c in contributions for pair in c}, key=repr)
    counts: dict[tuple[float, ...], int] = defaultdict(int)
    for c in contributions:
        counts[tuple(c.get(pair, 0.0) for pair in pair_keys)] += 1
    vectors = list(counts.keys())
    return pair_keys, vectors, [counts[v] for v in vectors]


def alpha_interval(
    contributions: list[dict[tuple, float]],
    *,
    metric: str = ALPHA_METRIC_NOMINAL,
    resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int = BOOTSTRAP_SEED,
) -> dict | None:
    """Percentile bootstrap 95% CI for Krippendorff's α, resampling UNITS.

    ``contributions`` is one coincidence contribution per unit (see
    `unit_contributions` / `pooled_unit_contributions`). Returns ``None`` when
    there is nothing to resample; returns an interval carrying
    ``unavailable_reason`` when the resampling ran but could not produce a
    usable distribution.

    ``metric`` is the α difference function — the SAME argument
    `irr._krippendorff_alpha` takes, so the interval and the point estimate it
    brackets are always scored the same way. ⚠️ **This parameter did not exist
    until #35's α slab, and the close-out notes before it said the machinery
    was "metric-agnostic with no retrofit".** It was not: the resampling loop
    called the α formula with its nominal default, so an interval requested
    for interval-scored ratings would have been a nominal interval around an
    interval-metric estimate — plausible numbers, wrong width, no error.

    ⚠️ **A resample can legitimately produce an undefined α** — it may draw only
    units that fewer than two coders judged. Those are dropped and counted; the
    surviving count rides the payload as ``n_resamples`` so the interval states
    the sample it was actually taken over, and if too few survive the interval is
    refused rather than computed from a biased remainder.

    🔴 **A resample in which only ONE value appears is DROPPED, not counted as
    α = 1.0.** `alpha_from_coincidence` returns 1.0 there by its documented
    convention (no possible disagreement), and treating that as an ordinary draw
    is #829's defect reached from underneath: the point estimate refuses to
    report a zero-variance code — `None` with `no_variance`, because reporting
    κ = 1 "almost perfect" was the bug — while the interval would quietly put
    that same 1.0 into its upper tail. Measured on a real project: a code with
    α = 0.85 reported an interval of **[0.00, 1.00]**, its upper bound
    manufactured entirely by resamples that contained no instance of the code.
    The interval is over the distribution of α *where α is defined*, and when
    too much of the distribution is undefined it is refused rather than
    reported from the remainder.
    """
    if metric not in ALPHA_METRICS:
        raise ValueError(f"unknown alpha metric: {metric!r}")
    n_units = len(contributions)
    if n_units == 0 or resamples <= 0:
        return None

    # numpy is a direct dependency but imported HERE, not at module scope: the
    # point estimators in `irr.py` are deliberately numpy-free and unit-testable,
    # and importing it up top would quietly make that untrue for every caller.
    import numpy as np

    pair_keys, vectors, type_counts = _dedup_types(contributions)
    if not pair_keys:
        # Not one unit had two coders on it — α is undefined for the sample
        # itself, so there is no point estimate to bracket.
        return None

    matrix = np.asarray(vectors, dtype=np.float64)          # (T, P)
    probabilities = np.asarray(type_counts, dtype=np.float64) / n_units
    rng = np.random.default_rng(seed)
    draws = rng.multinomial(n_units, probabilities, size=resamples)   # (B, T)
    sums = draws @ matrix                                             # (B, P)

    values: list[float] = []
    no_comparable_units = 0
    no_variance = 0
    for totals in sums:
        # Zero entries are dropped so an all-zero resample stays an EMPTY
        # coincidence matrix — `alpha_from_coincidence` reads emptiness as
        # "undefined", and a dict of zeros would read as defined instead.
        o = {pair: float(v) for pair, v in zip(pair_keys, totals) if v}
        if not o:
            no_comparable_units += 1
            continue
        if len({value for pair in o for value in pair}) < 2:
            # Only one value anywhere in the resample: no variance to agree
            # about, so α is undefined here for the same reason #829 declines
            # it for the whole code. See the docstring.
            no_variance += 1
            continue
        alpha = alpha_from_coincidence(o, metric)
        if alpha is not None and math.isfinite(alpha):
            values.append(alpha)

    if len(values) < MIN_VALID_FRACTION * resamples:
        # Name the DOMINANT cause: "code more units" and "this code is too rare
        # here" are different pieces of advice, and only one of them is
        # actionable for any given code.
        return _interval(
            None, None, CI_METHOD_ALPHA_BOOTSTRAP_UNITS,
            n_resamples=len(values),
            unavailable_reason=(
                CI_UNAVAILABLE_NO_VARIANCE_IN_RESAMPLES
                if no_variance >= no_comparable_units
                else CI_UNAVAILABLE_INSUFFICIENT_UNITS
            ),
        )

    tail = (1.0 - CI_LEVEL) / 2.0 * 100.0
    lower, upper = np.percentile(values, [tail, 100.0 - tail])
    return _interval(
        finite_or_none(float(lower), _STATS_PRECISION),
        finite_or_none(float(upper), _STATS_PRECISION),
        CI_METHOD_ALPHA_BOOTSTRAP_UNITS,
        n_resamples=len(values),
    )
