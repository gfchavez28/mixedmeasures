"""How a family of p-values is corrected for multiplicity — ONE switch (#1323).

The code-by-group comparison runs one test per code, so on a 40-code codebook a
handful of codes reach p < .05 by chance alone. Which correction applies is a
METHOD decision, taken on 2026-10-31 with a literature review beside it (the
1.5.9 pre-implementation review, D1) — so the choice lives in exactly one
constant, ``DEFAULT_CORRECTION``, and every consumer reads the method the result
STATES (``basis.correction`` on the wire) rather than assuming one.

**Why discrete Holm, not plain Holm (D1).** Fisher's and Freeman–Halton's p-values
take only a few values for small groups: at 6 v 6 the smallest attainable two-sided
Fisher p is .0022, so plain Holm over 40 codes (first threshold .05/40 = .00125) can
never reject anything, whatever the data. ``CORRECTION_DISCRETE_HOLM`` uses each
test's ATTAINABLE p-values (its "support", computed from the margins alone): a code
that cannot reach a threshold adds nothing to it — Tarone's (1990) exclusion, built
into a step-down. It keeps Holm's family-wise guarantee under ANY dependence between
the codes, which matters here because a mutually exclusive code set is negatively
dependent (Benjamini–Hochberg's guarantee is proven only under independence or
positive dependence). Callers hand ``supports`` in; a test whose support is unknown
(a Monte Carlo p) is treated as continuous, which is valid and only less powerful.

⚠️ **Pure Python, no statsmodels import.** `statsmodels.stats.multitest.multipletests`
is the test ORACLE for Holm/BH, which only means something if the implementation is
not the same call. Discrete Holm's oracle is R's `DiscreteFWER` 1.0.0, FROZEN into
`tests/reference_data/discrete_fwer_oracle.json` (the package compiles C++, so CI does
not install it; `test_discrete_fwer_oracle.py`, 2026-10-31b). ⚠️ The package has two
arithmetic defects the generator corrects rather than inherits — an exact comparison
that drops a support point equal to ``t`` but rounded a hair above it (too SMALL a
sum: it errs toward significance), and no cap at 1 on the first step — so ``_floor``'s
tolerance and the cap below are both load-bearing, and both are mutation-pinned by that
oracle.

⚠️ **A ``None`` p (no test: no variance, too few groups) is NOT a member of the
family.** It is skipped and comes back ``None`` — a hypothesis that could not be
tested cannot be rejected, and counting it would inflate every other adjustment.
"""
from __future__ import annotations

from bisect import bisect_right
from typing import Sequence

#: Holm (1979): step-down, controls the family-wise error rate under any
#: dependence between the tests. Uniformly more powerful than Bonferroni.
CORRECTION_HOLM = "holm"
#: Benjamini & Hochberg (1995): step-up, controls the false discovery rate
#: (under independence or positive dependence).
CORRECTION_BH = "bh"
#: No correction — each p stands alone. Kept so "none" is a STATED basis rather
#: than an absent field a reader has to interpret.
CORRECTION_NONE = "none"
#: Discrete step-down Holm (Zhu & Guo 2019): the adjusted p of the k-th smallest is
#: ``max_{i<=k} min(1, sum_{j in R_i} F_j(p_(i)))``, where ``F_j(t)`` is the largest
#: attainable p of test j that is ``<= t`` (0 if none) and ``R_i`` the hypotheses not
#: yet rejected at step i. FWER under arbitrary dependence. The formula was checked
#: against `DiscreteFWER` 1.0.0's source (`kernel_DFWER_stepwise_fast` + `eval_pv`)
#: on 2026-10-31, and its OUTPUT matched on 256 tests in 17 families on 2026-10-31b
#: (`test_discrete_fwer_oracle.py`, after the generator corrected the package's two
#: arithmetic defects — see the module docstring).
CORRECTION_DISCRETE_HOLM = "discrete_holm"

CORRECTIONS = frozenset({CORRECTION_HOLM, CORRECTION_BH, CORRECTION_NONE, CORRECTION_DISCRETE_HOLM})

#: 🔴 THE contestable choice (#1323, D1, decided 2026-10-31: discrete Holm — plain Holm
#: was accepted first and could never star a code at the group sizes this app's users
#: have). Changing it changes every adjusted p and every star in the comparison, its
#: CSV and the Canvas — and nothing else needs to change, because each of them reads
#: ``basis.correction``.
DEFAULT_CORRECTION = CORRECTION_DISCRETE_HOLM


def _floor(support: Sequence[float] | None, t: float) -> float:
    """``F(t)``: the largest attainable p ``<= t`` (0 if none); ``t`` when unknown.

    ⚠️ The ``1e-9`` relative tolerance is load-bearing: two tests' tables can have the
    same p in exact arithmetic and differ in the last bit, and an exact ``<=`` then
    drops a whole step of the sum whenever the other test's copy lands a hair above
    ``t`` — R's `DiscreteFWER` 1.0.0 does exactly that. Removing it fails 13 cases of
    `test_discrete_fwer_oracle.py` (MEASURED 2026-10-31b)."""
    if support is None:
        return t
    i = bisect_right(support, t * (1 + 1e-9))
    return support[i - 1] if i else 0.0


def adjust_p_values(
    p_values: list[float | None],
    method: str = DEFAULT_CORRECTION,
    supports: list[Sequence[float] | None] | None = None,
) -> list[float | None]:
    """Adjusted p-values in the input's order; ``None`` stays ``None`` and is not counted.

    Holm: sort ascending, ``p_(i) * (m - i)`` (0-based i), running MAXIMUM so the
    adjusted values never decrease, capped at 1. BH: sort descending,
    ``p_(i) * m / rank``, running MINIMUM, capped at 1. Discrete Holm: as Holm, with
    each remaining test contributing ``F_j(p_(i))`` instead of ``p_(i)``;
    ``supports[k]`` is test k's sorted attainable p-values (``None`` = continuous).

    Raises ``ValueError`` on an unknown method — fail closed, never a silent
    "none" (the stated basis would then claim a correction nobody applied).
    """
    if method not in CORRECTIONS:
        raise ValueError(f"unknown multiplicity correction: {method!r}")
    idx = [i for i, p in enumerate(p_values) if p is not None]
    out: list[float | None] = [None] * len(p_values)
    m = len(idx)
    if m == 0:
        return out
    if method == CORRECTION_NONE:
        for i in idx:
            out[i] = float(p_values[i])
        return out
    order = sorted(idx, key=lambda i: p_values[i])
    if method in (CORRECTION_HOLM, CORRECTION_DISCRETE_HOLM):
        sup = supports if method == CORRECTION_DISCRETE_HOLM and supports is not None else [None] * len(p_values)
        running = 0.0
        for rank, i in enumerate(order):
            t = float(p_values[i])
            total = sum(_floor(sup[j], t) for j in order[rank:])
            running = max(running, min(1.0, total))
            out[i] = running
        return out
    # Benjamini–Hochberg
    running = 1.0
    for rank in range(m - 1, -1, -1):
        i = order[rank]
        running = min(running, min(1.0, float(p_values[i]) * m / (rank + 1)))
        out[i] = running
    return out


def tarone_family_size(min_attainable: list[float | None], alpha: float) -> int:
    """Tarone's (1990) effective family: the smallest K with at most K tests whose
    smallest attainable p is ``<= alpha / K``. A DISCLOSURE (how many codes the data
    could ever speak to), not an adjustment — discrete Holm already drops the rest."""
    mins = [p for p in min_attainable if p is not None]
    for k in range(1, len(mins) + 1):
        testable = sum(1 for p in mins if p <= alpha / k)
        if testable <= k:
            return testable
    return len(mins)


def best_case_adjusted(
    min_attainable: list[float | None],
    method: str = DEFAULT_CORRECTION,
    supports: list[Sequence[float] | None] | None = None,
) -> list[float | None]:
    """Per test, the SMALLEST adjusted p it could ever get with these margins.
    ``>= alpha`` means "cannot reach significance with these group sizes", whatever
    the data: the marker's source.

    It is the correction applied to the vector of every test's SMALLEST attainable p.
    A test's best case is not "ranked first": a step-down correction lowers a test's
    threshold for every test rejected ahead of it, so the best case is the realisation
    in which every test that CAN come before it does, at its own minimum — and that is
    the all-minima vector (for Holm, discrete Holm and BH alike). ⚠️ The ranked-first
    form (``m × min`` for Holm) overstates it: it told the researcher a code could not
    be starred when, with stronger codes rejected first, it could. Pinned against a
    brute force over every joint realisation (`test_comparison_unit_1323.py`).

    A test whose minimum is unknown (``None``: a Monte Carlo p, continuous) could take
    a p arbitrarily close to 0, so it is left out — exactly as if it were rejected
    first at no cost, which is its best case for everyone else.

    Computed from the margins alone (before looking at which code differs), so a
    marker built on it is not a data-dependent selection.
    """
    if method not in CORRECTIONS:
        raise ValueError(f"unknown multiplicity correction: {method!r}")
    return adjust_p_values(min_attainable, method, supports)
