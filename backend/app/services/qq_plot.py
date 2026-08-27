"""Normal quantile-quantile diagnostics for the group-comparison panel (#525b).

#525(a) shipped the *numbers* — Shapiro-Wilk per group, Levene across groups.
This is the other half, and the entry calls it *"the more valuable half
long-term"* for a specific reason: **a QQ plot has no significance threshold to
misread.** Shapiro-Wilk misleads in both directions (over-sensitive above
n ≈ 200, powerless below n ≈ 10); a picture of where the data leaves the line
does not.

## What is plotted, and why it is the RESIDUALS

The normality assumption of a t-test / ANOVA is a property of the model's
residuals, not of any single group, so this emits ONE diagnostic per comparison
row — the same grain as `variance_homogeneity_check`, which is already per-row
for the same reason. Per-group QQ panels would also multiply without bound: the
dev corpus's nine schools across five variables is 45 panels for one screen.

⚠️ This answers a slightly DIFFERENT question from the per-group Shapiro-Wilk
beside it, and the client says so in as many words. "Shapiro flags group B but
the QQ looks straight" is a real, explainable state, not a contradiction.

## 🔴 The plotting position is sample-size-dependent in R, and that is the trap

MEASURED against R 4.3.3 rather than recalled — `ppoints` switches convention at
**n > 10**::

    ppoints(5)  -> 0.1190476 ...  == (i - 3/8) / (n + 1/4)   Blom,  a = 3/8
    ppoints(11) -> 0.04545455 ... == (i - 1/2) / n           Hazen, a = 1/2

So "which plotting position" is not one choice; it is two, selected by n. This
is the `boxplot()` / `fivenum()` trap recorded in `comparisons.box_summary` one
layer over, and it is worse in one specific way: **a fixture with n > 10 cannot
reveal a Blom/Hazen mix-up at small n.** The guards therefore carry an n <= 10
group AND an n > 10 group; on a single well-sized fixture the two conventions
produce visibly different numbers and a wrong implementation still looks fine.

We follow R exactly, because a researcher checking this figure will reach for
`qqnorm()` and the tool must not disagree with its own reference implementation.

## The accessible equivalent is a SUMMARY, not the points

A box plot's `sr-only` table works because a box plot's content IS five numbers.
A QQ plot's content is hundreds of points, and a 500-row table is an obstacle
rather than an equivalent. `ppcc` — the correlation between the ordered
residuals and their theoretical quantiles, i.e. the statistic behind the
Filliben probability-plot-correlation test — is the honest numeric reading of
"how straight is this line", and it is more useful than the point list to
sighted readers too.
"""

from __future__ import annotations

import math
import statistics

from .undefined_stats import (
    DEGENERATE,
    EMPTY_GROUP,
    INSUFFICIENT_N,
    NO_VARIANCE,
    finite_or_none,
)

#: Below this a normal QQ plot says nothing a reader can act on, and `ppcc`
#: is degenerate: any two points are exactly collinear, so the correlation is
#: 1.0 by construction and would advertise perfect normality for n = 2.
MIN_QQ_N = 3

#: R's `ppoints()`: a = 3/8 at or below this n, a = 1/2 above it. The switch is
#: the whole reason this constant is named rather than inlined.
PPOINTS_SMALL_N = 10
PPOINTS_A_SMALL = 3.0 / 8.0
PPOINTS_A_LARGE = 1.0 / 2.0

#: The plotting-position convention, STATED on the wire (the stated-basis
#: family). Several conventions exist, they disagree at small n, and a reader
#: meeting the figure in a paper has no other way to find out which drew it.
PLOTTING_POSITION_PPOINTS = "r_ppoints_blom_hazen"

#: The reference line: through the first and third quartile pairs, which is
#: exactly what R's `qqline()` draws. Quartiles use the same type-7 definition
#: `comparisons.box_summary` states, so the two figures cannot disagree about
#: what a quartile is.
REFERENCE_LINE_QUARTILE = "qqline_quartiles_type7"

#: A 2800-row dataset must not put 2800 pairs per row on the wire. Past this the
#: points are thinned by evenly-spaced ORDER STATISTICS, which preserves the
#: shape at the drawn resolution, and the remainder is REPORTED (the no-silent-
#: caps rule that `outliers_omitted` already follows).
MAX_QQ_POINTS = 500


def plotting_positions(n: int) -> list[float]:
    """R's `ppoints(n)` — the probabilities the order statistics are plotted at.

    ⚠️ The `a` switch at n = 10 is R's, not ours, and it is why this is a
    function of n rather than a constant.
    """
    a = PPOINTS_A_SMALL if n <= PPOINTS_SMALL_N else PPOINTS_A_LARGE
    return [(i - a) / (n + 1 - 2 * a) for i in range(1, n + 1)]


def _thin_indices(n: int, cap: int) -> list[int]:
    """Evenly-spaced indices over ``range(n)``, ALWAYS including both extremes.

    ⚠️ The extremes are the point of a QQ plot — the tails are where a
    distribution departs — so a naive stride that happens to drop the maximum
    removes exactly the evidence the reader came for.
    """
    if n <= cap:
        return list(range(n))
    if cap <= 1:
        return [0]
    step = (n - 1) / (cap - 1)
    seen = sorted({min(n - 1, round(i * step)) for i in range(cap)})
    return seen


def residuals_by_group(grouped: dict[str, list[float]]) -> tuple[list[float], int]:
    """Model residuals (value − its own group's mean) pooled across groups.

    Returns ``(residuals, singleton_group_count)``.

    ⚠️ **A group of one contributes a residual of exactly 0**, because its mean
    IS its single value. That is a property of estimating a mean from one point,
    not evidence about normality, and a pile of exact zeros bends the middle of
    the plot toward the line. We still include them — dropping a group would
    quietly diagnose a DIFFERENT model from the one the panel actually ran — and
    report the count instead, so the caption can say it out loud.
    """
    residuals: list[float] = []
    singletons = 0
    for values in grouped.values():
        if not values:
            continue
        if len(values) == 1:
            singletons += 1
        m = statistics.mean(values)
        residuals.extend(v - m for v in values)
    return residuals, singletons


def qq_summary(grouped: dict[str, list[float]]) -> dict | None:
    """The normal QQ diagnostic for one comparison row.

    ``None`` only when there is nothing at all to describe; every other refusal
    carries a machine-readable reason, because a blank figure is
    indistinguishable from a broken tool (#566/#689).
    """
    residuals, singletons = residuals_by_group(grouped)
    n = len(residuals)

    if n == 0:
        return _refused(EMPTY_GROUP, singletons)
    if n < MIN_QQ_N:
        return _refused(INSUFFICIENT_N, singletons)
    if len({round(r, 12) for r in residuals}) == 1:
        # Every residual identical — with residuals that means every group is
        # constant. There is no distribution to plot against.
        return _refused(NO_VARIANCE, singletons)

    from scipy.stats import norm

    ordered = sorted(residuals)
    # Not `metrics._Z_975`: that is the exact 95% constant #768 single-sourced,
    # and this needs the inverse normal CDF at arbitrary probabilities.
    theoretical = [float(norm.ppf(p)) for p in plotting_positions(n)]

    ppcc = _ppcc(theoretical, ordered)
    line = _reference_line(ordered, norm)
    if line is None:
        return _refused(DEGENERATE, singletons)

    keep = _thin_indices(n, MAX_QQ_POINTS)
    points = []
    for i in keep:
        t = finite_or_none(theoretical[i], 6)
        s = finite_or_none(ordered[i], 6)
        if t is None or s is None:
            # A non-finite pair cannot be drawn and must never reach the wire;
            # dropping it changes the omitted count, which is reported below.
            continue
        points.append({"theoretical": t, "sample": s})

    if not points:
        return _refused(DEGENERATE, singletons)

    return {
        "points": points,
        "points_omitted": max(0, n - len(points)),
        "n": n,
        "ppcc": ppcc,
        "line_slope": line[0],
        "line_intercept": line[1],
        "singleton_group_count": singletons,
        "plotting_position": PLOTTING_POSITION_PPOINTS,
        "reference_line": REFERENCE_LINE_QUARTILE,
        "undefined_reason": None,
    }


def _ppcc(theoretical: list[float], ordered: list[float]) -> float | None:
    """Probability-plot correlation coefficient — how straight the line is.

    ⚠️ Computed on ALL the points, never the thinned set: it is a statistic
    about the data, not about the drawing. Thinning it would make the number
    depend on the cap.
    """
    n = len(ordered)
    if n < MIN_QQ_N:
        return None
    mt = statistics.mean(theoretical)
    ms = statistics.mean(ordered)
    dt = [t - mt for t in theoretical]
    ds = [s - ms for s in ordered]

    # ⚠️ RESCALE BEFORE SQUARING. A dataset value near the float ceiling makes
    # `(s - ms) ** 2` raise **OverflowError** — not `inf`, an exception — so the
    # request 500s after computing fine, which is the #689 failure mode exactly.
    # Correlation is scale-invariant, so dividing each deviation by its own
    # series' largest magnitude changes nothing and removes the hazard. Found by
    # the serializability fixture, not by reading.
    st = max((abs(v) for v in dt), default=0.0)
    ss = max((abs(v) for v in ds), default=0.0)
    if st <= 0 or ss <= 0 or not math.isfinite(st) or not math.isfinite(ss):
        return None
    dt = [v / st for v in dt]
    ds = [v / ss for v in ds]

    try:
        num = sum(a * b for a, b in zip(dt, ds))
        den_t = sum(v * v for v in dt)
        den_s = sum(v * v for v in ds)
    except OverflowError:
        # Belt-and-braces: the rescale above makes every term <= 1, so this is
        # unreachable for finite input. It stays because the alternative to a
        # named refusal here is a 500.
        return None
    if den_t <= 0 or den_s <= 0:
        return None
    return finite_or_none(num / ((den_t * den_s) ** 0.5), 4)


def _reference_line(ordered: list[float], norm) -> tuple[float, float] | None:
    """R's `qqline()`: the line through the first and third quartile pairs.

    Robust to the tails by construction — which is the point, since the tails
    are what the reader is judging AGAINST this line.
    """
    if len(ordered) < 2:
        return None
    # Type 7, matching `comparisons.box_summary`'s stated quartile definition.
    q1, _med, q3 = statistics.quantiles(ordered, n=4, method="inclusive")
    x1 = float(norm.ppf(0.25))
    x2 = float(norm.ppf(0.75))
    if x2 == x1:
        return None
    slope = (q3 - q1) / (x2 - x1)
    intercept = q1 - slope * x1
    s = finite_or_none(slope, 6)
    i = finite_or_none(intercept, 6)
    if s is None or i is None or s == 0:
        # A zero slope means q1 == q3: the middle half is constant, so the line
        # carries no information even though individual points might.
        return None
    return s, i


def _refused(reason: str, singletons: int) -> dict:
    return {
        "points": [],
        "points_omitted": 0,
        "n": 0,
        "ppcc": None,
        "line_slope": None,
        "line_intercept": None,
        "singleton_group_count": singletons,
        "plotting_position": PLOTTING_POSITION_PPOINTS,
        "reference_line": REFERENCE_LINE_QUARTILE,
        "undefined_reason": reason,
    }
