"""R correctness oracle for the Wilson proportion interval (#768).

`_ci_wilson` computes the **uncorrected** Wilson score interval, which is exactly
what R's `prop.test(x, n, correct = FALSE)$conf.int` returns — base R, no package,
so this oracle costs nothing beyond an Rscript call and needs none of the five
packages `r_support.REQUIRED_R_PACKAGES` provisions.

**Why this exists rather than a hand-anchored fixture.** The constant was written
`1.96`, the textbook rounding of `qnorm(0.975)`, and the difference is visible at
the 2 decimal places the app displays: at 0 of 50 the rounded constant reports an
upper bound of 7.14 where R reports 7.13. A unit test anchored to our own output
would have pinned 7.14 forever — it takes an independent implementation to say
which of the two is right. Same argument as the #402 round-trip: the oracle is the
point, the assertion is bookkeeping.

⚠️ **The p = 0 case is the load-bearing one, not an edge case.** Since #591 put
declared-but-unchosen scale levels back on the axis, a zero-count category is
ordinary — and it is precisely where the rounding showed. A fixture of only
mid-range proportions passes with either constant.
"""

import subprocess

import pytest

from app.services.metrics import PERCENTAGE_PRECISION, _ci_wilson
from tests import r_support

# Base R only — `prop.test` is in `stats`, so this oracle does NOT gate on
# `HAS_IRR` or any of the provisioned packages.
_RSCRIPT = r_support.RSCRIPT
_HAS_R = r_support.HAS_R

# (successes, trials). Chosen so the cases DISAGREE about the thing under test:
# a zero count (where the quantile rounding surfaced), a tiny n with a wide
# asymmetric interval, an ordinary survey proportion, a large-n proportion where
# the interval is narrow enough that a last-digit error is visible, and both
# saturation ends where the interval must clamp to [0, 100].
_CASES = [
    (0, 50),
    (1, 7),
    (37, 100),
    (500, 1000),
    (50, 50),
    (3, 4),
]


def _r_wilson(x: int, n: int) -> tuple[float, float]:
    """R's uncorrected Wilson interval for x of n, on the percentage scale."""
    expr = (
        f"ci <- prop.test({x}, {n}, correct = FALSE)$conf.int; "
        f"cat(sprintf('%.10f %.10f', ci[1] * 100, ci[2] * 100))"
    )
    out = subprocess.run(
        [_RSCRIPT, "--vanilla", "-e", expr],
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, f"Rscript failed: {out.stderr.strip()[:400]}"
    lo, hi = out.stdout.split()
    return float(lo), float(hi)


@pytest.mark.skipif(not _HAS_R, reason="Rscript not available")
@pytest.mark.parametrize("x,n", _CASES)
def test_wilson_interval_matches_r_prop_test(x, n):
    """Our Wilson bounds equal R's, at the precision the app actually shows.

    Rounded to `PERCENTAGE_PRECISION` and compared for EQUALITY rather than with
    a tolerance: a tolerance loose enough to absorb the 1.96 rounding would be
    loose enough to absorb the defect this pins.
    """
    ours = _ci_wilson(x / n, n)
    assert ours is not None
    r_lo, r_hi = _r_wilson(x, n)

    assert ours["ci_lower"] == round(r_lo, PERCENTAGE_PRECISION), (
        f"lower bound for {x}/{n}: ours {ours['ci_lower']}, R {r_lo:.6f}"
    )
    assert ours["ci_upper"] == round(r_hi, PERCENTAGE_PRECISION), (
        f"upper bound for {x}/{n}: ours {ours['ci_upper']}, R {r_hi:.6f}"
    )


@pytest.mark.skipif(not _HAS_R, reason="Rscript not available")
def test_the_rounded_textbook_constant_would_fail_this_oracle():
    """Pin the DEFECT, not just the fix — 1.96 must be observably wrong here.

    Without this, a future edit could revert `_Z_975` to 1.96 and the parametrized
    test above might still pass if its fixtures drifted to cases where the two
    constants agree (four of the six do). This asserts the fixture set retains at
    least one case that can TELL THEM APART, which is the property that makes the
    oracle worth running at all.
    """
    import math

    def wilson_with(z: float, p: float, n: int) -> float:
        z2 = z * z
        denom = 1 + z2 / n
        centre = (p + z2 / (2 * n)) / denom
        margin = z * math.sqrt(max(p * (1 - p) / n + z2 / (4 * n * n), 0.0)) / denom
        return round(min(1.0, centre + margin) * 100, PERCENTAGE_PRECISION)

    discriminating = [
        (x, n) for x, n in _CASES
        if wilson_with(1.96, x / n, n) != round(_r_wilson(x, n)[1], PERCENTAGE_PRECISION)
    ]
    assert discriminating, (
        "No fixture distinguishes z=1.96 from the exact quantile, so this oracle "
        "cannot detect a regression of #768. Add a low-count case (0 of 50 was the "
        "originally measured one)."
    )
