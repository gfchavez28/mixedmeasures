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

# ── The unit — what "Units" counts (#1333 / #1334) ──────────────────────────
#
# The same coders on the same coding give a different α depending on what one
# UNIT is, and nothing in the figure says which — so the payload states it and
# the R export prints it. Both values share the #1334 rule (a group of turns is
# ONE unit — `services/segment_groups.py::unit_key`); they differ only on
# whether an interviewer's turn is a unit.
#
# ⚠️ Facilitator turns are almost always left uncoded by every coder, so
# counting them adds agreement on ABSENCE, and α moves with how many prompts a
# transcript holds rather than with how well the coders agree
# (`tests/test_reliability_units.py` pins a fixture where it does).

#: Passages from participants: conversation turns by a non-facilitator speaker
#: (or by no tagged speaker), document segments, agreed clips and answers. A
#: facilitator's turn is not a unit. The rule every other count in the app
#: already follows (J-A's `coding_counts._participant_predicate`).
UNIT_BASIS_PARTICIPANT_PASSAGES = "participant_passages"

#: Every passage, a facilitator's turns included. The pre-1.5.9 reading (less
#: the #1334 group rule), kept as a value so the choice stays ONE argument.
UNIT_BASIS_ALL_PASSAGES = "all_passages"

RELIABILITY_UNIT_BASES = frozenset({UNIT_BASIS_PARTICIPANT_PASSAGES, UNIT_BASIS_ALL_PASSAGES})

#: 🔴 THE CONTESTABLE CHOICE (#1333, decided 2026-10-31): what the Reliability
#: tab, the Model comparison tab and the R export count by default. Switching it
#: is this one line — every reader takes the constant, and the payload and the
#: script state whichever value produced the number.
DEFAULT_RELIABILITY_UNIT_BASIS = UNIT_BASIS_PARTICIPANT_PASSAGES

#: The sentence the R script prints beside its coefficients. The client has its
#: own words in `lib/reliability-basis.ts`; these are for a reader of the file.
UNIT_BASIS_SENTENCE = {
    UNIT_BASIS_PARTICIPANT_PASSAGES: (
        "Units are passages from participants: a facilitator's (interviewer's) "
        "turns are left out, and a group of turns counts once."
    ),
    UNIT_BASIS_ALL_PASSAGES: (
        "Units are every passage, a facilitator's (interviewer's) turns "
        "included; a group of turns counts once."
    ),
}


def unit_basis_excludes_facilitator_turns(basis: str) -> bool:
    """Whether ``basis`` leaves facilitator turns out. Fails CLOSED: an unknown
    value raises rather than silently picking a unit set."""
    if basis not in RELIABILITY_UNIT_BASES:
        raise ValueError(
            f"unknown reliability unit basis {basis!r}; expected one of "
            f"{sorted(RELIABILITY_UNIT_BASES)}"
        )
    return basis == UNIT_BASIS_PARTICIPANT_PASSAGES


# ── How little data a coefficient may rest on (#1505, 1.5.9 — D42/D43) ──────
#
# Two rules, and they answer different questions (record:
# the internal design notes).
#
# 1. **Is it a measurement at all?** Over ONE comparable unit, Krippendorff's α
#    is identically 0 whenever the coders differ — for every metric and any
#    number of coders the expected disagreement IS that unit's own spread
#    (o_ck = n_c·n_k/(m−1), n = m, so the two sums cancel) — and Cohen's κ is 0
#    beside it. That is arithmetic, not evidence, so below
#    `MIN_COMPARABLE_UNITS` κ and α are undefined (`insufficient_n`).
#
# 2. **May it carry a VERDICT?** Krippendorff is explicit that α itself needs
#    "no minimum" (2011 working paper, p. 1) — but his acceptance bands (.667,
#    .800) are a decision about the DATA, and his sample-size table says how
#    much data that decision needs. Below `VERDICT_MIN_UNITS` the coefficient,
#    its n and its interval are still reported, and the band word ("reliable",
#    "unreliable", Landis & Koch's κ words) is WITHHELD with a stated reason.
#    Above it, #43's rider still withdraws the band's colour when the interval
#    spans a cutoff.
#
#: Fewer comparable units than this and κ/α are `insufficient_n`.
MIN_COMPARABLE_UNITS = 2

#: 🔴 THE CONTESTABLE CHOICE (D43, decided 2026-11-01e). Krippendorff's
#: minimum sample size at his MOST LENIENT decision cell — α_min .667, p .10,
#: an evenly split binary variable: N = 2z²[(1+α)(3−α)/(4(1−α)·p(1−p)) − α]
#: = 36 (z = 1.2816), counted in pairable VALUES, i.e. 18 units for two coders
#: (the reading under which the table's "multiply z² by the number of coders"
#: leaves the units constant). ⚠️ Whether the book's table counts values or
#: units is UNVERIFIED (it was seen as ATLAS.ti's reproduction); if units, this
#: is 36. A per-row floor from the same formula was TESTED and REJECTED: it
#: withheld a well-supported "unreliable" from a rare code, because the table
#: sizes a test for CONCLUDING α ≥ α_min, not the converse. Pinned against the
#: formula by `test_reliability_verdict.py`.
VERDICT_MIN_UNITS = 18

#: Why a row carries a coefficient and no band word. One value today; the
#: client's words live in `lib/reliability-basis.ts` (1.5.9 session B).
VERDICT_WITHHELD_TOO_FEW_UNITS = "too_few_units"
VERDICT_WITHHELD_REASONS = frozenset({VERDICT_WITHHELD_TOO_FEW_UNITS})


def verdict_withheld_reason(n_units: int) -> str | None:
    """The reason a coefficient over ``n_units`` comparable units gets no band
    word, or ``None`` when it may carry one. Asked only of a DEFINED coefficient:
    an undefined one already says why through its `undefined_reason`."""
    return VERDICT_WITHHELD_TOO_FEW_UNITS if n_units < VERDICT_MIN_UNITS else None
