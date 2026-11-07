"""The code-by-group comparison's STATED BASIS and its presence test (#1323).

The thirteenth member of the stated-basis family (the internal design notes):
the server states what was counted, how it was tested and how the p-values were
corrected, and `frontend/src/lib/comparison-basis.ts` DISPLAYS that — it never
infers the unit from the screen it is on.

**Why the unit is part of the number.** The comparison used to count PASSAGES and
test them as independent draws, so one talkative participant could carry a code to
`**` (the 2026-10-21 external review, AGR-01; `#1323`). Decided 2026-10-31: the
UNIT is the participant — "how many participants in each group used this code" —
and passage counts ride along as a description only, never tested.

Every contestable choice is ONE constant here or in `services/multiplicity.py`:

* the unit that is tested — ``TESTED_UNITS`` (the default unit is ``DEFAULT_COMPARISON_UNIT``);
* the test for two groups and for three or more — ``presence_test``;
* the significance level — ``COMPARISON_ALPHA``;
* the multiplicity correction — ``multiplicity.DEFAULT_CORRECTION``;
* whether a universal code is in the family — ``UNIVERSAL_CODES_TESTED``.
"""
from __future__ import annotations

import math

from . import multiplicity as mt
from .undefined_stats import NO_VARIANCE, finite_or_none

# ── The unit ────────────────────────────────────────────────────────────────

#: A participant counts once: "used the code" = at least one of their passages in
#: the material compared carries it. The default, and the only unit that is TESTED.
COMPARISON_UNIT_PARTICIPANT = "participant"
#: A passage (a turn, a document segment, an open-text answer). DESCRIPTION ONLY:
#: passages from one person are not independent, so no test is run over them.
COMPARISON_UNIT_PASSAGE = "passage"

COMPARISON_UNITS = frozenset({COMPARISON_UNIT_PARTICIPANT, COMPARISON_UNIT_PASSAGE})
DEFAULT_COMPARISON_UNIT = COMPARISON_UNIT_PARTICIPANT
#: 🔴 A unit is tested only if listed here. The passage unit must never be — that
#: was the defect (#1323).
TESTED_UNITS = frozenset({COMPARISON_UNIT_PARTICIPANT})

#: The CSV's word for each unit (the screen's words live in `lib/comparison-basis.ts`).
UNIT_CSV_LABEL = {
    COMPARISON_UNIT_PARTICIPANT: "Participants",
    COMPARISON_UNIT_PASSAGE: "Passages",
}
assert set(UNIT_CSV_LABEL) == COMPARISON_UNITS

#: The CSV's name for each correction, in its adjusted-p column's heading (the
#: screen's words live in `lib/comparison-basis.ts`). ASCII on purpose: a CSV is
#: opened in tools that guess its encoding.
CORRECTION_CSV_LABEL = {
    mt.CORRECTION_DISCRETE_HOLM: "discrete Holm",
    mt.CORRECTION_HOLM: "Holm",
    mt.CORRECTION_BH: "Benjamini-Hochberg",
    mt.CORRECTION_NONE: "no correction",
}
assert set(CORRECTION_CSV_LABEL) == mt.CORRECTIONS

#: The level the stars and ``significant`` are read at — on the ADJUSTED p.
COMPARISON_ALPHA = 0.05

#: A universal code ("Unclear", "Unsubstantive/Artifact") is a transcription marker,
#: not a finding: its row stays, untested, and it does not widen the family.
UNIVERSAL_CODES_TESTED = False

# ── The test ────────────────────────────────────────────────────────────────

#: Two groups: Fisher's exact test on the 2×2 table of users / non-users.
TEST_FISHER_EXACT = "fisher_exact"
#: Three or more groups: the Freeman–Halton extension of Fisher's test to a k×2
#: table, computed EXACTLY by enumerating every table with the observed margins.
TEST_FREEMAN_HALTON = "freeman_halton"
#: The same test when the enumeration is too large: a SEEDED Monte Carlo estimate
#: (multivariate-hypergeometric draws under the fixed margins, ``(1 + hits) / (R + 1)``
#: — R's `fisher.test(simulate.p.value = TRUE)` estimator), so a quoted p is
#: reproducible. ⚠️ scipy 1.18's R×C `fisher_exact` defaults to an UNSEEDED Monte
#: Carlo — MEASURED: [[1,2],[3,0],[2,2]] gave .3976 then .4024 (R: .4) — and its
#: seeded form costs ~0.45 s a code at 10×300; never call it here.
TEST_FREEMAN_HALTON_MC = "freeman_halton_monte_carlo"
TEST_METHODS = frozenset({TEST_FISHER_EXACT, TEST_FREEMAN_HALTON, TEST_FREEMAN_HALTON_MC})

#: Above this many partial tables the exact enumeration hands over to Monte Carlo.
FREEMAN_HALTON_MAX_TABLES = 200_000
MONTE_CARLO_SEED = 1323
MONTE_CARLO_RESAMPLES = 9_999

# ── Why a code or a whole result has no test ───────────────────────────────

#: Per result: the unit is passages, which are not independent.
TEST_OMITTED_PASSAGE_UNIT = "passage_unit"
#: Per result: fewer than two groups have anyone with material in the sources compared.
TEST_OMITTED_INSUFFICIENT_GROUPS = "insufficient_groups"
#: Per code: a universal code (``UNIVERSAL_CODES_TESTED``).
TEST_OMITTED_UNIVERSAL = "universal_code"
#: Per code: nobody, or everybody, in the tested groups used it — `undefined_stats`'
#: existing member, so `lib/stat-format.ts` already has its sentence.
TEST_OMITTED_NO_VARIANCE = NO_VARIANCE

TEST_OMITTED_REASONS = frozenset({
    TEST_OMITTED_PASSAGE_UNIT, TEST_OMITTED_INSUFFICIENT_GROUPS,
    TEST_OMITTED_UNIVERSAL, TEST_OMITTED_NO_VARIANCE,
})


def _log_comb(n: int, k: int) -> float:
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def freeman_halton_kx2(successes: list[int], sizes: list[int]) -> tuple[float, str]:
    """Exact Freeman–Halton p for a k×2 table (users / non-users per group).

    Under independence with both margins fixed, a table's probability is
    ``prod C(n_i, x_i) / C(N, X)``; the p-value sums every table no more probable
    than the observed one (R's `fisher.test` rule, with its 1e-7 relative
    tolerance). The enumeration is a running convolution over groups, pruned to the
    partial sums that can still reach ``X`` — so a 2×2 table reproduces Fisher's
    two-sided p exactly (pinned in the tests).

    Returns ``(p, method)``: ``TEST_FREEMAN_HALTON``, or ``TEST_FREEMAN_HALTON_MC``
    past ``FREEMAN_HALTON_MAX_TABLES``.
    """
    p, method, _support = _freeman_halton(successes, sizes)
    return p, method


def _freeman_halton(successes: list[int], sizes: list[int]):
    """``(p, method, support)`` — ``support`` is every p-value a table with these
    margins can produce, sorted (the discrete corrections' input); ``None`` past the
    enumeration cap, where only a Monte Carlo p is known."""
    import numpy as np

    total = int(sum(sizes))
    x_total = int(sum(successes))
    log_obs = sum(_log_comb(n, x) for n, x in zip(sizes, successes))
    remaining = [sum(sizes[i + 1:]) for i in range(len(sizes))]

    sums = np.zeros(1, dtype=np.int64)
    logw = np.zeros(1, dtype=np.float64)
    for i, n in enumerate(sizes):
        # Checked BEFORE the outer product is built: 10 groups of 300 would otherwise
        # allocate a 27-million-element array before noticing (MEASURED: 0.7 s a code).
        if sums.size * (n + 1) > FREEMAN_HALTON_MAX_TABLES:
            return _freeman_halton_monte_carlo(successes, sizes), TEST_FREEMAN_HALTON_MC, None
        xs = np.arange(n + 1, dtype=np.int64)
        lc = np.array([_log_comb(n, int(x)) for x in xs])
        sums = (sums[:, None] + xs[None, :]).ravel()
        logw = (logw[:, None] + lc[None, :]).ravel()
        keep = (sums <= x_total) & (sums + remaining[i] >= x_total)
        sums, logw = sums[keep], logw[keep]
    logw = logw[sums == x_total]
    log_norm = _log_comb(total, x_total)
    tol = math.log1p(1e-7)
    p = float(np.exp(logw[logw <= log_obs + tol] - log_norm).sum())
    # The support: each table's p is the mass of every table no more probable.
    probs = np.sort(np.exp(logw - log_norm))
    upto = np.searchsorted(probs, probs * (1 + 1e-7), side="right")
    support = np.unique(np.minimum(np.cumsum(probs)[upto - 1], 1.0))
    return min(1.0, p), TEST_FREEMAN_HALTON, support.tolist()


def _freeman_halton_monte_carlo(successes: list[int], sizes: list[int]) -> float:
    import numpy as np
    from scipy.special import gammaln

    rng = np.random.default_rng(MONTE_CARLO_SEED)
    n = np.asarray(sizes, dtype=np.int64)
    sims = rng.multivariate_hypergeometric(n, int(sum(successes)), size=MONTE_CARLO_RESAMPLES)

    def log_weight(x):
        return (gammaln(n + 1) - gammaln(x + 1) - gammaln(n - x + 1)).sum(axis=-1)

    obs = log_weight(np.asarray(successes, dtype=np.int64))
    hits = int((log_weight(sims) <= obs + math.log1p(1e-7)).sum())
    return (hits + 1) / (MONTE_CARLO_RESAMPLES + 1)


def _support_2x2(n1: int, n2: int, users: int) -> list[float]:
    """Every two-sided Fisher p a 2×2 table with these margins can produce (sorted):
    the hypergeometric over the first group's users, each table's p the mass of every
    table no more probable (scipy's and R's rule)."""
    import numpy as np
    from scipy.stats import hypergeom

    lo, hi = max(0, users - n2), min(n1, users)
    probs = np.sort(hypergeom.pmf(np.arange(lo, hi + 1), n1 + n2, n1, users))
    upto = np.searchsorted(probs, probs * (1 + 1e-7), side="right")
    return np.unique(np.minimum(np.cumsum(probs)[upto - 1], 1.0)).tolist()


# ── The difference and its interval (D3) ────────────────────────────────────

#: Two groups only: the difference in the share of participants who used the code,
#: with Newcombe's (1998) hybrid score interval (his method 10). UNADJUSTED — it is
#: not corrected for the number of codes compared, and the client says so
#: (`lib/ci-label.ts`). ⚠️ A fourth module minting a `CI_METHOD_*`, so it is on
#: `test_ci_method_contract.py::_VOCABULARY_MODULES`.
CI_METHOD_NEWCOMBE_HYBRID = "newcombe_hybrid_score"
#: The level of that interval — ``newcombe_wilson_ci``'s default ``z``.
DELTA_CI_LEVEL = 0.95


def newcombe_wilson_ci(a: int, n1: int, c: int, n2: int, z: float = 1.959963984540054):
    """Newcombe's (1998) hybrid Wilson-score interval for p1 − p2 (his method 10).

    The interval for the two-group Δ that D3 shows UNADJUSTED (``delta_interval``).
    It agrees with an independent R implementation of method 10 (the 2026-10-31
    review: 56/70 − 48/80 → (0.0524, 0.3339), 9/10 − 3/10 → (0.1705, 0.8090)); the
    first is Newcombe's published example as recalled, not re-opened.
    """
    def wilson(x, n):
        p = x / n
        centre = (p + z * z / (2 * n)) / (1 + z * z / n)
        half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
        return p, centre - half, centre + half
    p1, l1, u1 = wilson(a, n1)
    p2, l2, u2 = wilson(c, n2)
    d = p1 - p2
    return (d - math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2),
            d + math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2))


def delta_interval(a: int, n1: int, c: int, n2: int) -> dict:
    """The wire shape of Δ's interval — ``schemas.code_analysis.ComparisonInterval``,
    the field names of ``IrrInterval`` so a reader of one reads the other. Both
    groups must have units (Δ is undefined otherwise, #1421)."""
    if n1 <= 0 or n2 <= 0:
        raise ValueError("delta_interval needs units in both groups")
    lo, hi = newcombe_wilson_ci(a, n1, c, n2)
    return {"lower": finite_or_none(lo, 4), "upper": finite_or_none(hi, 4),
            "level": DELTA_CI_LEVEL, "method": CI_METHOD_NEWCOMBE_HYBRID}


def presence_test(successes: list[int], sizes: list[int]) -> dict | None:
    """Test whether the share of units that used a code differs across groups.

    ``successes[i]`` units of ``sizes[i]`` in group i used the code. Every size must
    be > 0 — a group with no units leaves the TEST before this is called (#591's
    rule: it stays in the table). Returns ``None`` when there is no variance (nobody
    or everybody used it): such a code is not a member of the correction family.
    """
    if len(sizes) < 2 or any(n <= 0 for n in sizes):
        raise ValueError("presence_test needs two or more groups, each with units")
    users, n_total = sum(successes), sum(sizes)
    if users == 0 or users == n_total:
        return None
    result: dict = {"statistic": None, "effect_size": None, "effect_size_label": None}
    # The support (every attainable p, from the margins alone) feeds the discrete
    # corrections and the "cannot reach significance" marker; it never rides the wire.
    if len(sizes) == 2:
        p, method, support = None, TEST_FISHER_EXACT, _support_2x2(sizes[0], sizes[1], users)
    else:
        p, method, support = _freeman_halton(successes, sizes)
    result["support"] = support
    result["min_attainable_p"] = support[0] if support else None
    if len(sizes) == 2:
        from scipy.stats import fisher_exact

        a, c = successes
        b, d = sizes[0] - a, sizes[1] - c
        result["method"] = TEST_FISHER_EXACT
        result["p_value"] = float(fisher_exact([[a, b], [c, d]]).pvalue)
        if b * c > 0:
            result["effect_size"] = round((a * d) / (b * c), 4)
            result["effect_size_label"] = "odds_ratio"
        return result
    result["method"] = method
    result["p_value"] = p
    # Cramér's V from the UNCORRECTED Pearson χ² on the tested table (k×2: min dim 2).
    from scipy.stats import chi2_contingency

    table = [[x, n - x] for x, n in zip(successes, sizes)]
    chi2 = float(chi2_contingency(table, correction=False)[0])
    result["effect_size"] = round(math.sqrt(chi2 / n_total), 4)
    result["effect_size_label"] = "cramers_v"
    return result
