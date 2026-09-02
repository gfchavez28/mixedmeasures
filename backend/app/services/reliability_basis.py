"""The stated basis of a reliability coefficient — WHAT it generalises over, and
HOW disagreement was measured (#35, the TENTH member of the stated-basis family).

Two vocabularies, both hand-mirrored in ``frontend/src/lib/reliability-basis.ts``
and pinned by ``tests/test_reliability_basis.py``.

## The facet — items or coders

A dataset scale score's Cronbach's α and a coded corpus's Krippendorff's α are the
SAME quantity with a different facet designated as the object of measurement
(Generalizability Theory: α is algebraically an intraclass correlation). For the
scale score the coefficient is over ITEMS — it asks whether the questions hang
together. For coding it is over CODERS — it asks whether the people agree. A bare
"α = 0.82" is ambiguous between the two, and the ambiguity is CROSS-SURFACE: within
one table there is no confusion, but a researcher reading the Reliability tab and
the Analysis view in the same afternoon sees the same letter for two different
claims. So the server states the facet on every payload that carries an α, and the
client displays it rather than inferring it from which screen it is on.

## The metric — how far apart two values are

Krippendorff's α takes a difference function. For presence/absence coding the
values are categories, so the metric is NOMINAL (a value is either the same or it
is not). For a magnitude RATING the values are numbers on a declared scale, so the
metric is INTERVAL: a 3 and a 4 disagree less than a 3 and a 9. **The declared
instrument is what licenses the interval metric** — a scale with equal steps and
labelled anchors is a measurement, and ranking it (the ordinal metric) would throw
away exactly the distances the declaration asserts. Ratio is refused for ratings
because a declared scale may have a negative bound, where ratios are undefined.

⚠️ The metric strings are the ones ``irr._krippendorff_alpha(metric=)`` and R's
``irr::kripp.alpha(method=)`` both accept, so the R export can emit the constant
verbatim rather than translating it.
"""
from __future__ import annotations

# ── The facet ────────────────────────────────────────────────────────────────

#: Agreement between the PEOPLE who coded (inter-rater reliability).
RELIABILITY_FACET_CODERS = "coders"

#: Consistency among the ITEMS of a scale (internal-consistency reliability).
RELIABILITY_FACET_ITEMS = "items"

RELIABILITY_FACETS = frozenset({RELIABILITY_FACET_CODERS, RELIABILITY_FACET_ITEMS})

# ── The α metric ─────────────────────────────────────────────────────────────

ALPHA_METRIC_NOMINAL = "nominal"
ALPHA_METRIC_ORDINAL = "ordinal"
ALPHA_METRIC_INTERVAL = "interval"
ALPHA_METRIC_RATIO = "ratio"

ALPHA_METRICS = frozenset({
    ALPHA_METRIC_NOMINAL, ALPHA_METRIC_ORDINAL, ALPHA_METRIC_INTERVAL, ALPHA_METRIC_RATIO,
})

#: The metric a magnitude rating is scored on. A declared scale is an interval
#: instrument (see the module docstring); this is the one place that decision is
#: written down, and the R export reads it rather than restating it.
MAGNITUDE_ALPHA_METRIC = ALPHA_METRIC_INTERVAL
