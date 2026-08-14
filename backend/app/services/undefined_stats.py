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

UNDEFINED_REASONS = frozenset({INSUFFICIENT_N, EMPTY_GROUP, NO_VARIANCE, DEGENERATE})


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
