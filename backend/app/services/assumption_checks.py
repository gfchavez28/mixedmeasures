"""Assumption checks for the group-comparison tests (#525).

The Comparisons panel offers *"Use non-parametric test — for non-normal or
ordinal data"* and never told the researcher whether their data IS non-normal.
jamovi and JASP put these beside every test; this is the minimum honest tier.

⚠️ **Every degenerate case here was MEASURED against scipy 1.18.0, not reasoned**
(the #689 rule — and `requirements.txt` exact-pins the numbers stack precisely so
these behaviours cannot shift under us):

    shapiro([1, 2])          -> nan, nan   (does NOT raise)
    shapiro([4] * 5)         -> nan, nan   (does NOT raise)
    shapiro([1, 2, 3])       -> 1.0, 1.0   (the minimum n)
    levene(one_group)        -> RAISES ValueError
    levene([5]*10, [7]*10)   -> nan, nan   (all groups constant)
    levene([], [...])        -> nan, nan   (an empty group)

A `nan` reaching the wire is a 500 at RESPONSE time, not a wrong number — so
every value passes `finite_or_none` and a refusal names its own reason.
"""

from __future__ import annotations

from .undefined_stats import (
    DEGENERATE,
    EMPTY_GROUP,
    INSUFFICIENT_N,
    NO_VARIANCE,
    finite_or_none,
)

#: Shapiro-Wilk needs three observations; scipy returns `nan` below that rather
#: than raising, which is the quiet failure this constant exists to prevent.
MIN_SHAPIRO_N = 3

#: Levene centred on the MEDIAN is Brown–Forsythe — the robust variant, and the
#: right default when normality is exactly what is in question. STATED on the
#: wire because centring on the mean gives a different number from the same data.
LEVENE_CENTER_MEDIAN = "median"

NORMALITY_TEST_SHAPIRO = "shapiro_wilk"
VARIANCE_TEST_LEVENE = "levene"


def normality_check(values: list[float]) -> dict:
    """Shapiro-Wilk for one group.

    Returns a dict that always carries either (statistic, p) or a reason —
    never a bare absence, which a researcher cannot tell from a broken tool.
    """
    n = len(values)
    if n == 0:
        return _refused(NORMALITY_TEST_SHAPIRO, EMPTY_GROUP)
    if n < MIN_SHAPIRO_N:
        return _refused(NORMALITY_TEST_SHAPIRO, INSUFFICIENT_N)
    if len(set(values)) == 1:
        # Measured: scipy returns nan here. "No variance" is also the honest
        # answer — a constant is not a distribution to test.
        return _refused(NORMALITY_TEST_SHAPIRO, NO_VARIANCE)

    from scipy.stats import shapiro

    try:
        res = shapiro(values)
    except Exception:
        return _refused(NORMALITY_TEST_SHAPIRO, DEGENERATE)
    stat = finite_or_none(float(res.statistic), 4)
    p = finite_or_none(float(res.pvalue), 4)
    if stat is None or p is None:
        return _refused(NORMALITY_TEST_SHAPIRO, DEGENERATE)
    return {"test": NORMALITY_TEST_SHAPIRO, "statistic": stat, "p": p, "undefined_reason": None}


def variance_homogeneity_check(
    groups: list[list[float]], names: list[str] | None = None
) -> dict:
    """Levene's test across groups, centred on the median (Brown–Forsythe).

    ⚠️ **Two groups can be in the comparison and not in the test, and until
    #525b neither was reported.** An EMPTY group is dropped outright, and a
    SINGLETON contributes ``|x − median| = 0`` by construction — a structural
    zero that reads as perfect homogeneity rather than as an absence of
    evidence. Measured: ``levene([1.0], [1,2,3,4], center="median")`` returns
    ``stat=2.4, p=0.219``, a confident-looking number resting on one such point.

    Neither is a reason to refuse — dropping a group would test a DIFFERENT
    model from the one the panel ran — so both are NAMED instead, exactly as
    `AssumptionNote` already names the groups Shapiro-Wilk could not test. A
    count that quietly shrinks reads as a complete one.

    ``names`` is optional so the function stays usable as pure statistics; the
    production caller passes it, and `test_assumption_checks.py` pins that.
    """
    labelled = list(zip(names, groups)) if names is not None else [(None, g) for g in groups]
    excluded = [n for n, g in labelled if n is not None and len(g) == 0]
    singletons = [n for n, g in labelled if n is not None and len(g) == 1]

    # ONE place the two group lists are attached, so a return added later cannot
    # forget them — the arity lesson (#515 → #676) applied at function scale.
    def _out(d: dict) -> dict:
        d["excluded_groups"] = excluded
        d["singleton_groups"] = singletons
        return d

    non_empty = [g for g in groups if len(g) > 0]
    if len(non_empty) < 2:
        # Measured: scipy RAISES here rather than returning nan.
        return _out(_refused(VARIANCE_TEST_LEVENE, INSUFFICIENT_N, center=LEVENE_CENTER_MEDIAN))
    if all(len(set(g)) == 1 for g in non_empty):
        # Measured: nan. Every group constant means there is no within-group
        # spread to compare.
        return _out(_refused(VARIANCE_TEST_LEVENE, NO_VARIANCE, center=LEVENE_CENTER_MEDIAN))

    from scipy.stats import levene

    try:
        res = levene(*non_empty, center=LEVENE_CENTER_MEDIAN)
    except Exception:
        return _out(_refused(VARIANCE_TEST_LEVENE, DEGENERATE, center=LEVENE_CENTER_MEDIAN))
    stat = finite_or_none(float(res.statistic), 4)
    p = finite_or_none(float(res.pvalue), 4)
    if stat is None or p is None:
        return _out(_refused(VARIANCE_TEST_LEVENE, DEGENERATE, center=LEVENE_CENTER_MEDIAN))
    return _out({
        "test": VARIANCE_TEST_LEVENE,
        "statistic": stat,
        "p": p,
        "center": LEVENE_CENTER_MEDIAN,
        "undefined_reason": None,
    })


def _refused(test: str, reason: str, center: str | None = None) -> dict:
    out = {"test": test, "statistic": None, "p": None, "undefined_reason": reason}
    if center is not None:
        out["center"] = center
    return out
