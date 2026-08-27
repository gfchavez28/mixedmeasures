"""One vocabulary for "this statistic has no value", and the guard that enforces it (#689).

**The rule (design sitting, 2026-08-11).** An undefined statistic is ``None``,
never ``0.0`` — a correlation cell reading ``0.00`` is read as *no relationship*
when the truth is *not computable* — and it travels with a machine-readable
**reason**, so the screen, the tooltip, the CSV and the R export all give the
same explanation instead of four renderers each re-deriving it from the inputs.
That last part is the whole point: a value and the thing describing it, produced
in different places, is the defect that produced #732, #742, #679 and #746 inside
two sessions.

**A second, sharper problem this module exists for, found by executing the
degenerate cases rather than reading them.** The filed issue described wrong
*numbers*; three of the four inputs do not produce a number at all:

    two constant groups, different means  ->  Welch t = -inf,  ANOVA F = inf
    two constant groups, same mean        ->  t = nan, p = nan
    all values identical                  ->  ZeroDivisionError in the omega term

and starlette's ``JSONResponse`` renders with **``allow_nan=False``**, so an
``inf`` or ``nan`` that reaches the wire raises at *response* time — a 500 on a
request that computed fine, for the one researcher whose column happened to be
constant. Everything numeric that can come out of a degenerate computation must
pass ``finite_or_none`` before it is returned. The convention already existed in
this codebase (``data_quality.py`` guards ``isfinite``; ``missing_values.py``
names ``allow_nan=False`` in a comment) — the comparison services never got it.
"""
from __future__ import annotations

import math

# ── The reason vocabulary ────────────────────────────────────────────────────
#
# Four values, each mapping to a distinct sentence a researcher can act on.
# Keep it small: every new reason is a new sentence in `lib/stat-format.ts` and
# a new row in the CSV legend, so a vague fifth entry costs more than it says.

#: A group (or pair) has fewer usable values than the statistic requires — the
#: #566 case: n < 2 for a parametric test, n < 3 for a correlation.
INSUFFICIENT_N = "insufficient_n"

#: The group has no usable values at all after missing-data exclusion. Distinct
#: from INSUFFICIENT_N on purpose: "nobody in this group answered" and "only one
#: person did" are different facts about the data.
EMPTY_GROUP = "empty_group"

#: Every value is identical, so the statistic's denominator is zero — a constant
#: item, or a subgroup filter that removed the variation.
NO_VARIANCE = "no_variance"

#: The structure cannot support the statistic (a contingency table with an empty
#: margin, a regression with no spread).
DEGENERATE = "degenerate"

#: The VARIABLE holds no numbers at all — a nominal or open-text column asked to
#: behave like a measurement (#830b). Distinct from EMPTY_GROUP, which it used to
#: be reported as: *"No values in this group, after missing data was excluded"*
#: blames the grouping and the missing data for something neither did, and it
#: says it once per group, so a researcher reads a data problem into a type
#: mismatch. Nominal columns are legitimately offered as metric inputs (#371 —
#: a frequency chart on `School` is exactly right), so this is reachable from an
#: ordinary selection, not a misuse.
NOT_NUMERIC = "not_numeric"

UNDEFINED_REASONS = frozenset({
    INSUFFICIENT_N, EMPTY_GROUP, NO_VARIANCE, DEGENERATE, NOT_NUMERIC,
})


# ── Why a whole RESULT is empty ──────────────────────────────────────────────
#
# The vocabulary above answers "why has this NUMBER no value". This one answers
# "why has this ANALYSIS no rows", and it exists for the same reason one level
# up: **the surface was inventing the answer.**
#
# 🔴 Measured on real data (#823c · #827 · the 2026-08-25 review). A comparison
# that produced nothing rendered one hardcoded sentence — *"The selected
# demographic may have fewer than 2 groups"* — which was:
#   * wrong for a 5-group variable whose scale scores had never been computed
#     (the grouping column was never even consulted), and
#   * wrong for a 3-group variable in another dataset, where no row the analysis
#     looked at carries a value for it.
# It is right for exactly one of the four ways this can happen, and the server
# knows which one every time.
#
# ⚠️ **Do not read these as a ranking.** They are disjoint causes, diagnosed in
# the order the pipeline reaches them, and each has a different remedy — which is
# the whole point of separating them.

#: Nothing resolvable was selected (no columns, no domains, or ids that do not
#: belong to this project).
NO_VARIABLES = "no_variables"

#: A variable group was selected but has no ungrouped scale-score metric, so
#: there is no per-row number to compare. The remedy is to create one.
DOMAIN_SCORES_MISSING = "domain_scores_missing"

#: The scale-score metric EXISTS but has never been computed (or its rows were
#: cleared), so `RowScore` is empty. #823(c): the researcher's fix was to visit
#: an unrelated page and click a chip nothing pointed them at.
DOMAIN_SCORES_NOT_COMPUTED = "domain_scores_not_computed"

#: Rows were found, but not one of them carries a value for the grouping column.
#: 🔴 **The dominant real-world cause is a grouping column in a DIFFERENT dataset
#: (#827), and the reason it fails is not the one that entry proposed.**
#: `_load_grouping_map` reads the grouping column's values on the ROW IDS the
#: analysis is built from, so a column in another dataset contributes nothing.
#: **Participant links are irrelevant here — verified by execution: with 12 of 12
#: rows linked one-to-one, the comparison still returns no groups.** What DOES
#: work is a cross-dataset DOMAIN whose row scores span both datasets, grouped by
#: a column in either of them (also verified) — which is why the offer must be
#: gated on "does the grouping column's dataset appear among the analysed rows",
#: never on "are these two datasets linked".
NO_GROUP_VALUES = "no_group_values"

#: Fewer than two distinct groups survive the column's missing rules and the
#: researcher's excluded groups. **The only case the old hardcoded sentence
#: described.**
INSUFFICIENT_GROUPS = "insufficient_groups"

UNAVAILABLE_REASONS = frozenset({
    NO_VARIABLES,
    DOMAIN_SCORES_MISSING,
    DOMAIN_SCORES_NOT_COMPUTED,
    NO_GROUP_VALUES,
    INSUFFICIENT_GROUPS,
})


def finite_or_none(value: float | int | None, digits: int | None = None) -> float | None:
    """Return ``value`` rounded, or ``None`` if it is not a real number.

    ``None`` in, ``None`` out. ``nan`` and ``±inf`` become ``None`` — they are
    what a degenerate computation actually produces, and they cannot be
    serialized (``allow_nan=False``), so letting one through turns a wrong
    number into a 500.

    ⚠️ **A real measured zero passes through unchanged.** Do not "simplify" this
    to ``if not value`` — that blanks ``0.0``, which is the falsy-zero defect
    this project has already shipped twice.
    """
    if value is None:
        return None
    v = float(value)
    if not math.isfinite(v):
        return None
    return round(v, digits) if digits is not None else v
