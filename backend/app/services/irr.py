"""Inter-rater reliability for code presence/absence (Track J · J2-4).

Measures how much the human coders agree, per effective code and overall:
percent agreement (always), Cohen's κ (exactly 2 coders), and Krippendorff's α
(any number). The display surfaces (agreement matrix, reconciliation UI) are J2-5;
this is the computation engine + an on-demand read.

**Unit = target × code, binary.** For a given code, each coder's value on a unit
(a segment, a segment GROUP, or a dataset value) is 1 (applied) or 0 (did not
apply) or MISSING. What one unit is — a facilitator's turn left out, a group of
turns counted once — is the stated `unit_basis` (#1333 / #1334,
`reliability_basis.UNIT_BASIS_*`), applied by `reliability_segment_rows` and
`_unit_of` below.

**Option B — source-level engagement (developer-confirmed 2026-06-23).** The data
only records codes that were *applied*; there is no "reviewed but declined" record.
So we operationalize "this coder judged this unit" at the SOURCE level: a coder who
applied ≥1 code anywhere in a source (a conversation/document for segments, a
column for dataset values) is treated as having reviewed that whole source — so a
blank unit inside it is a real 0 ("explicit absence"), a genuine disagreement if a
colleague applied the code. A source a coder never touched is MISSING for them
("implicit absence" — like a skipped survey question), excluded from the math.
Krippendorff's α absorbs the residual missingness. This matches NVivo / MAXQDA /
the Krippendorff implicit-vs-explicit-absence distinction; κ/α chance-correct the
shared-blank agreements so Option B isn't gamed by boilerplate.

Raters = the HUMAN roster coders (``auth.reliability_coder_clause()``), excluding
the merged-legacy "Unattributed" bucket, the derived consensus layer, and — since
#989 — MACHINE coders. A model's labels are never pooled into an agreement
coefficient: human-vs-machine agreement describes the MODEL and is not validation
of the coding, so it belongs in its own table, never in this one.
Universal codes are excluded. Codes are compared by *effective code* (the D3
equivalence-group seam), so "Positive" ≡ "POSITIVE". The gather mirrors
``consensus.py``'s roster-coder recipe; the math is pure (numpy-free, unit-testable)
and round-tripped against R's ``irr`` package.
"""
from __future__ import annotations

from collections import defaultdict
from typing import NamedTuple

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..auth import reliability_coder_clause
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.document import Document
from ..models.segment import Segment
from ..models.user import User
from ..routers.helpers import visible_segment_filter
from .coding_layers import (
    build_effective_code_map,
    consensus_eligible_segment_clause,
    consensus_scoped_segments,
    non_consensus_filter,
    resolve_effective_code,
)
from .code_sets import (
    SET_NONE,
    build_code_set_index,
    matrix_cell,
)
from .coding_counts import participant_turn_query
from .magnitude import read_scale
from .reliability_basis import (
    ALPHA_METRIC_NOMINAL,
    DEFAULT_RELIABILITY_UNIT_BASIS,
    MAGNITUDE_ALPHA_METRIC,
    MIN_COMPARABLE_UNITS,
    RELIABILITY_FACET_CODERS,
    VERDICT_MIN_UNITS,
    unit_basis_excludes_facilitator_turns,
    verdict_withheld_reason,
)
from .segment_groups import GROUP_RATING_CONFLICT, merge_unit_rating, unit_key
# #987 — which dataset cells are CODEABLE is decided in one place (#519/#840).
# Imported exactly as `code_analysis.py` does; no cycle (`text_analysis` reaches
# models, `coding_layers` and `id_set`, never this module).
from .text_analysis import substantive_text_clause, treat_as_empty_for_project
from .undefined_stats import DEGENERATE, INSUFFICIENT_N, NO_VARIANCE


# ── The source axis (#829) ────────────────────────────────────────────────────
#
# A source key is ``(kind, id)`` with kind ∈ conv | doc | obs | col — the same
# tuples `_segment_source_key` produces and `engaged` is keyed on. On the wire it
# travels as ``"kind:id"`` so it can ride a query string and a React Query key.

_SOURCE_KINDS = ("conv", "doc", "obs", "col")


def _source_token(source: tuple[str, int] | None) -> str | None:
    """The wire form of a source key, or None for the pooled view."""
    return f"{source[0]}:{source[1]}" if source else None


def parse_source_token(token: str | None) -> tuple[str, int] | None:
    """Wire form → source key. Returns None for absent/malformed input.

    ⚠️ **Malformed is None (= pooled), never an error.** A stale bookmark naming
    a deleted source must not 400 the whole panel; the scope simply falls back to
    the pooled view, and `build_irr_matrices` intersects against the selectable
    set anyway so an unknown-but-well-formed key yields an honest empty result.
    """
    if not token:
        return None
    kind, _, raw = token.partition(":")
    if kind not in _SOURCE_KINDS or not raw.isdigit():
        return None
    return (kind, int(raw))


def _describe_sources(db: Session, sources: set[tuple]) -> list[dict]:
    """Name every selectable source, so the picker can render one (#829).

    ⚠️ **Four kinds resolve from four different tables**, which is why this exists
    rather than the client joining names itself: the client would need four more
    queries and would have to re-derive which sources are even selectable.

    ⚠️ A source whose row has vanished is DROPPED rather than labelled with its
    id — an unnamed row in a picker is not a choice a researcher can make.
    """
    if not sources:
        return []
    from ..models.observation import Observation

    by_kind: dict[str, list[int]] = defaultdict(list)
    for kind, sid in sources:
        by_kind[kind].append(sid)

    names: dict[tuple, str] = {}
    # ⚠️ All three segment parents name themselves `name`, NOT `title` — the
    # first draft used `title` and every IRR test failed on the attribute, which
    # is the cheapest possible way to learn it.
    for kind, model in (("conv", Conversation), ("doc", Document), ("obs", Observation)):
        ids = by_kind.get(kind)
        if not ids:
            continue
        for sid, label in db.query(model.id, model.name).filter(model.id.in_(ids)).all():
            names[(kind, sid)] = label

    if by_kind.get("col"):
        # A text column's display name follows the #575 precedence rule.
        for sid, cname, ctext in (
            db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text)
            .filter(DatasetColumn.id.in_(by_kind["col"])).all()
        ):
            names[("col", sid)] = cname or ctext

    out = [
        {"key": _source_token(k), "kind": k[0], "label": names[k]}
        for k in sources if names.get(k)
    ]
    out.sort(key=lambda r: (r["kind"], (r["label"] or "").lower()))
    return out

# Segment parent FK -> source-key tag. A MAP, never a ternary: the two-arm form
# (`("conv", cid) if cid is not None else ("doc", did)`) silently produced
# ("doc", None) for any clip, which then UNIONED coder engagement across every
# observation in the project — a coder who touched observation A read as engaged
# on observation B's clips, manufacturing spurious real 0s. Same shape as the
# slab-4c prefix-map fix in code_analysis.py.
_SEGMENT_SOURCE_TAGS = (("conv", "conversation_id"), ("doc", "document_id"),
                        ("obs", "observation_id"))


def _segment_source_key(conv_id: int | None, doc_id: int | None,
                        obs_id: int | None) -> tuple[str, int]:
    """The (tag, id) source key for a segment, from its three parent FKs.

    Raises rather than guessing: exactly one parent is non-NULL by CHECK
    constraint, so a fall-through means the caller's SELECT is missing a column —
    a wiring bug that must fail loudly, not degrade into a phantom source.
    """
    for tag, value in (("conv", conv_id), ("doc", doc_id), ("obs", obs_id)):
        if value is not None:
            return (tag, value)
    raise ValueError("segment has no parent FK — SELECT is missing a parent column")

# Landis & Koch (1977) κ bands; Krippendorff (2004) α cutoffs. Echoed back in the
# result so the frontend renders the band without hardcoding thresholds.
KAPPA_THRESHOLDS = {"slight": 0.0, "fair": 0.20, "moderate": 0.40, "substantial": 0.60, "almost_perfect": 0.80}
ALPHA_THRESHOLDS = {"tentative": 0.667, "reliable": 0.80}


def _interpret_kappa(k: float | None) -> str | None:
    if k is None:
        return None
    if k < KAPPA_THRESHOLDS["fair"]:
        return "slight" if k >= 0.0 else "poor"
    if k < KAPPA_THRESHOLDS["moderate"]:
        return "fair"
    if k < KAPPA_THRESHOLDS["substantial"]:
        return "moderate"
    if k < KAPPA_THRESHOLDS["almost_perfect"]:
        return "substantial"
    return "almost_perfect"


def _interpret_alpha(a: float | None) -> str | None:
    if a is None:
        return None
    if a >= ALPHA_THRESHOLDS["reliable"]:
        return "reliable"
    if a >= ALPHA_THRESHOLDS["tentative"]:
        return "tentative"
    return "unreliable"


# ── Pure math (numpy-free; unit-testable; round-tripped against R's irr) ───────
#
# Each function takes ``units``: a list of unit-rows, every row a list of length
# n_coders holding 0 / 1 / None (None = that coder did not judge the unit).


def _delta_squared_table(
    metric: str, values: list, n_c: dict,
) -> dict[tuple, float]:
    """δ²_ck lookup for the non-nominal metrics (Krippendorff 2011, "Computing
    Krippendorff's Alpha-Reliability"). ``values`` must be numerically sorted;
    ``n_c`` are the coincidence-matrix marginals (the ordinal metric needs them).

    - ordinal:  δ²_ck = (Σ_{g=c..k} n_g − (n_c+n_k)/2)²  — ranks by NUMERIC value
      (R's ``irr`` ranks by factor-level order, which for numeric matrices is also
      numeric; for character data it string-sorts — we deliberately never do).
    - interval: δ²_ck = (c−k)²
    - ratio:    δ²_ck = ((c−k)/(c+k))²  — values must be non-negative
    """
    d2: dict[tuple, float] = {}
    for i, c in enumerate(values):
        for j in range(i, len(values)):
            k = values[j]
            if i == j:
                d2[(c, k)] = 0.0
                continue
            if metric == "ordinal":
                span = sum(n_c[values[g]] for g in range(i, j + 1))
                val = (span - (n_c[c] + n_c[k]) / 2.0) ** 2
            elif metric == "interval":
                val = float(c - k) ** 2
            elif metric == "ratio":
                val = ((c - k) / (c + k)) ** 2 if (c + k) != 0 else 0.0
            else:  # pragma: no cover — guarded by the caller
                raise ValueError(f"unknown alpha metric: {metric}")
            d2[(c, k)] = d2[(k, c)] = val
    return d2


def unit_coincidence(row: list[int | None]) -> dict[tuple, float]:
    """ONE unit's contribution to the coincidence matrix.

    Each unit with m≥2 present values contributes 1/(m-1) per ordered value
    pair. Split out of ``_krippendorff_alpha`` for #43: the bootstrap resamples
    UNITS, and a resample's coincidence matrix is the weighted sum of these —
    so the interval and the point estimate are built from the same arithmetic
    rather than from a second implementation of it (the #733 class).

    ⚠️ **A unit's contribution depends only on its VALUE COUNTS**, not on which
    coder held which value. That is what lets `reliability_intervals` collapse
    thousands of units into a handful of interchangeable types.
    """
    o: dict[tuple, float] = defaultdict(float)
    present = [v for v in row if v is not None]
    m = len(present)
    if m < 2:
        return o
    inv = 1.0 / (m - 1)
    for i in range(m):
        for j in range(m):
            if i != j:
                o[(present[i], present[j])] += inv
    return o


def alpha_from_coincidence(
    o: dict[tuple, float], metric: str = "nominal",
) -> float | None:
    """α from an assembled coincidence matrix — the formula itself, once.

    α = 1 − (n−1)·Σ_{c,k} o_ck·δ²_ck / Σ_{c,k} n_c·n_k·δ²_ck with the metric's
    difference function δ² (nominal: 1 for c≠k).

    Returns None when ``o`` is empty (no unit had ≥2 raters → α undefined), and
    1.0 when only one value was observed anywhere (no possible disagreement).
    Both edges are reachable inside a BOOTSTRAP resample even when the full
    sample reaches neither, which is why they are documented here rather than
    left to the caller (#43).
    """
    if not o:
        return None

    n_c: dict = defaultdict(float)
    for (c, _k), val in o.items():
        n_c[c] += val
    n = sum(n_c.values())
    if metric == "nominal":
        do_num = sum(val for (c, k), val in o.items() if c != k)
        values = list(n_c)
        de_num = sum(n_c[c] * n_c[k] for c in values for k in values if c != k)
    else:
        values = sorted(n_c)
        d2 = _delta_squared_table(metric, values, n_c)
        do_num = sum(val * d2[(c, k)] for (c, k), val in o.items())
        de_num = sum(n_c[c] * n_c[k] * d2[(c, k)] for c in values for k in values)
    if de_num == 0:
        return 1.0  # only one value observed anywhere → no possible disagreement
    return 1.0 - (n - 1) * do_num / de_num


def _krippendorff_alpha(
    units: list[list[int | None]], metric: str = "nominal",
) -> float | None:
    """Krippendorff's α, n coders, missing-data tolerant.

    Builds the coincidence matrix the canonical way, then applies the α formula.
    Reproduces ``irr::kripp.alpha(method=metric)`` for numeric data THROUGH irr's
    missing-data branch only: with no missing cell, irr (0.84.1 and 0.85) weights
    every pair 1 instead of 1/(m−1), which is wrong for three or more coders —
    which is why the R export calls ``kripp.alpha(cbind(t(m), NA), …)`` (#1325,
    D39). Non-nominal metrics require numeric values; ratio additionally
    requires non-negative values.

    The binary presence/absence IRR surfaces use the nominal default; the metric
    generalization is the designed extension point for ordinal/interval magnitude
    ratings (#35) and the v1.4 honest-ICR arc.
    """
    o: dict[tuple, float] = defaultdict(float)
    for row in units:
        for pair, val in unit_coincidence(row).items():
            o[pair] += val
    return alpha_from_coincidence(o, metric)


def _project_to_pair(
    units: list[list[int | None]], idx_a: int, idx_b: int,
) -> list[list[int | None]]:
    """Narrow roster-wide rows to two coders' columns (#828).

    🔴 **This is what #828 actually needed, and the filed remedy did not say so.**
    `_cohens_kappa` drops any row where ``len(r) != 2``, and these rows are
    ``len(coder_id_list)`` wide — so on a roster of 8 EVERY row was discarded and
    κ came back ``None`` no matter what the gate said. Changing the gate alone
    would have produced exactly the same empty column.

    ⚠️ **Lossless by construction, not by luck.** Option-B engagement is recorded
    at the SOURCE, so a coder who never engaged this source has ``None`` in every
    one of its units. Dropping their column therefore discards only missing
    cells — which is why this may be done for a source with exactly two engaged
    coders and must NOT be done to pick an arbitrary pair out of three.
    """
    return [[row[idx_a], row[idx_b]] for row in units]


def _confusion_matrix(
    rows: list[list[int | None]], idx_a: int, idx_b: int, axis: list[int],
) -> list[list[int]]:
    """Counts of ``(coder A's value, coder B's value)`` over units both judged.

    The artifact the review is right to call out: today a researcher can see that
    α is low and NOT which pair of categories caused it. Square and in ``axis``
    order both ways, so the diagonal is agreement and an off-diagonal cell names
    exactly one confusion.

    ⚠️ **It is ``n_coders`` choose 2 matrices, not one** — with three coders a
    pooled "confusion matrix" is not defined, because a unit would have to
    contribute to several cells at once. Rendering per pair is the only honest
    shape. Bounded by construction: the axis is the SET's size, so unlike the
    frequency panel (#809) this cannot grow with the corpus.
    """
    pos = {v: i for i, v in enumerate(axis)}
    out = [[0] * len(axis) for _ in axis]
    for row in rows:
        a, b = row[idx_a], row[idx_b]
        if a is None or b is None:
            continue
        ia, ib = pos.get(a), pos.get(b)
        if ia is None or ib is None:
            continue
        out[ia][ib] += 1
    return out


def _cohens_kappa(units: list[list[int | None]]) -> float | None:
    """Cohen's unweighted κ for exactly 2 coders, over units both judged.
    Reproduces ``irr::kappa2``.

    ⚠️ Rows MUST already be 2 wide — see ``_project_to_pair``. The ``len(r) == 2``
    filter below is why: it silently yields ``None`` for wider input.
    """
    pairs = [(r[0], r[1]) for r in units if len(r) == 2 and r[0] is not None and r[1] is not None]
    n = len(pairs)
    if n == 0:
        return None
    po = sum(1 for a, b in pairs if a == b) / n
    cats = {a for a, _ in pairs} | {b for _, b in pairs}
    p1 = {c: sum(1 for a, _ in pairs if a == c) / n for c in cats}
    p2 = {c: sum(1 for _, b in pairs if b == c) / n for c in cats}
    pe = sum(p1[c] * p2[c] for c in cats)
    if pe >= 1.0:
        return 1.0 if po >= 1.0 else 0.0
    return (po - pe) / (1.0 - pe)


def _percent_agreement(units: list[list[int | None]]) -> float | None:
    """Pairwise percent agreement over all coder pairs that both judged a unit.
    For 2 coders this equals ``irr::agree`` on the complete-overlap units."""
    agree = total = 0
    for row in units:
        present = [v for v in row if v is not None]
        m = len(present)
        for i in range(m):
            for j in range(i + 1, m):
                total += 1
                if present[i] == present[j]:
                    agree += 1
    return agree / total if total else None


def _prevalence(units: list[list[int | None]]) -> float | None:
    """Base rate: fraction of present (non-missing) cells that are 1. Shown beside
    κ to defuse the prevalence paradox (high agreement + extreme base rate → low κ)."""
    ones = cells = 0
    for row in units:
        for v in row:
            if v is not None:
                cells += 1
                ones += v
    return ones / cells if cells else None


def _n_comparable_units(units: list[list[int | None]]) -> int:
    """Units with ≥2 coders present — the basis the κ/α/% actually rest on."""
    return sum(1 for row in units if sum(1 for v in row if v is not None) >= 2)


def _distinct_comparable_values(units: list[list]) -> set:
    """The distinct values among units ≥2 coders judged — the set α is scored over.

    ⚠️ Only COMPARABLE units count. A unit one coder rated contributes nothing
    to the coincidence matrix, so its value cannot create variance; if every
    compared value is identical the expected disagreement is zero and
    `alpha_from_coincidence` returns its 1.0 sentinel — which is #829's "almost
    perfect" reached through ratings. The caller refuses with `no_variance`.
    """
    out: set = set()
    for row in units:
        present = [v for v in row if v is not None]
        if len(present) >= 2:
            out.update(present)
    return out


def _mean_abs_difference(units: list[list[float | None]]) -> float | None:
    """Mean |a − b| over every coder pair on every unit both rated (#35).

    A plain-language companion to the interval-metric α: α says whether the
    coders agree beyond chance, this says HOW FAR APART they typically are, in
    the scale's own units — "about 1.3 points on a 0–10 scale" is the sentence
    a researcher can act on. Dedoose reports the same quantity beside its
    (weaker) Pearson r. None when no unit was rated by two coders.
    """
    total = 0.0
    pairs = 0
    for row in units:
        present = [v for v in row if v is not None]
        m = len(present)
        for i in range(m):
            for j in range(i + 1, m):
                total += abs(present[i] - present[j])
                pairs += 1
    return total / pairs if pairs else None


# ── When a matrix has NO coefficient (#829, #1505) — ONE decision, two callers ──
#
# `compute_irr` and the R export (`routers/export_r.py`, which writes the app's
# reason beside irr's raw value — D40) both ask these, so the script and the
# screen cannot disagree about which codes have a coefficient. The order is the
# order a researcher can act on: too little data first, then no variance.


def binary_undefined_reason(rows: list[list[int | None]]) -> str | None:
    """Why a 0/1 presence matrix has no κ/α, or ``None``.

    `insufficient_n` below `MIN_COMPARABLE_UNITS` (one unit is an identity, not a
    measurement — `reliability_basis`), then `no_variance` when nobody — or
    everybody — applied the code (#829's zero-prevalence rider). ``_prevalence``
    is legal here: the cells are 0/1."""
    if _n_comparable_units(rows) < MIN_COMPARABLE_UNITS:
        return INSUFFICIENT_N
    prevalence = _prevalence(rows)
    if prevalence == 0.0 or prevalence == 1.0:
        return NO_VARIANCE
    return None


def valued_undefined_reason(rows: list[list]) -> str | None:
    """Why a RATING or code-SET matrix has no α, or ``None``.

    The cells are ratings or member code ids, so variance is decided over the
    COMPARED values (`_distinct_comparable_values`) — never `_prevalence`, which
    would sum code ids."""
    if _n_comparable_units(rows) < MIN_COMPARABLE_UNITS:
        return INSUFFICIENT_N
    if len(_distinct_comparable_values(rows)) < 2:
        return NO_VARIANCE
    return None


def set_undefined_reason(rows: list[list], n_members: int) -> str | None:
    """`valued_undefined_reason` for a code set, after its own first question: a
    set of fewer than two values is a binary code wearing a costume (`degenerate`)."""
    if n_members < 2:
        return DEGENERATE
    return valued_undefined_reason(rows)


def _verdict(value: float | None, n_units: int, interpret) -> tuple[str | None, str | None]:
    """(band word, withheld reason) for a coefficient over ``n_units`` units (D43).

    An undefined coefficient gets neither — its `undefined_reason` already
    explains the blank, and two reasons for one cell is worse than one."""
    if value is None:
        return None, None
    withheld = verdict_withheld_reason(n_units)
    return (None if withheld else interpret(value)), withheld


# ── The unit rule (#1333 / #1334) — shared with `machine_agreement._gather` ────


def reliability_segment_rows(query, *, include_facilitator_turns: bool):
    """The #1333 half of what a reliability unit is, applied to a query already
    joined to `Segment`. ONE function for both gathers' both passes, because the
    human table and the Model comparison table must count the same units
    (`machine_agreement.py`: "the SAME rule the human table uses")."""
    if include_facilitator_turns:
        return query
    return participant_turn_query(query)


def _unit_of(seg_id: int, group_id: int | None, collapse_groups: bool) -> tuple[str, int]:
    """The #1334 half: a grouped turn's unit is its group (`segment_groups.unit_key`)."""
    return unit_key(seg_id, group_id if collapse_groups else None)


def _record_rating(ratings, ukey, uid, code_id, magnitude) -> None:
    """One application's rating into its unit — `merge_unit_rating` decides what
    a coder's two members' ratings make. An entry exists for EVERY (unit, coder,
    code) applied, so applied-but-unrated and never-applied stay distinct."""
    mine = ratings[ukey][uid]
    mine[code_id] = merge_unit_rating(mine[code_id], magnitude) if code_id in mine else magnitude


def _settle_rating_conflicts(ratings) -> None:
    """A coder's contradictory group rating is no rating (`None`), never a number."""
    for per_coder in ratings.values():
        for by_code in per_coder.values():
            for code_id, value in by_code.items():
                if value is GROUP_RATING_CONFLICT:
                    by_code[code_id] = None


class FacilitatorDisclosure(NamedTuple):
    """What the #1333 exclusion LEFT OUT, said rather than dropped."""

    #: Facilitator turns in scope (visible, in a conversation among the sources).
    turns: int
    #: ``{effective code: facilitator turns in scope carrying it, by any coder}``.
    coded_by_code: dict[int, int]
    #: D18 — the NAMES of the speakers whose turns were left out, sorted. The
    #: exclusion keys on a flag the import sets only for an "Interviewer" or
    #: "Facilitator" label, so a "Moderator" left as a participant is a unit
    #: invisibly unless the researcher can see who WAS treated as a facilitator.
    #: Transcript speakers, never coders, so blind mode has nothing to withhold.
    speakers: list[str]


def facilitator_turn_disclosure(
    db: Session, project_id: int, coder_ids: list[int], sources: set[tuple],
) -> FacilitatorDisclosure:
    """What the #1333 exclusion LEFT OUT (`FacilitatorDisclosure`).

    A facilitator turn is excluded by SPEAKER ROLE, never because nobody coded
    it — so when a coder did code one, the researcher must be able to see that
    the figure does not include it. Scope = the conversations among ``sources``
    (documents, clips and answers have no speaker). Counted in TURNS: this is a
    statement about material, not a unit count.
    """
    from ..models.speaker import Speaker

    nothing = FacilitatorDisclosure(0, {}, [])
    conv_ids = sorted(sid for (tag, sid) in sources if tag == "conv")
    if not conv_ids or not coder_ids:
        return nothing
    facilitator_turn = (
        Speaker.is_facilitator == 1,
        Segment.conversation_id.in_(conv_ids),
        *visible_segment_filter(),
    )
    per_speaker = (
        db.query(Speaker.name, func.count(Segment.id))
        .join(Segment, Segment.speaker_id == Speaker.id)
        .filter(*facilitator_turn)
        .group_by(Speaker.id, Speaker.name)
        .all()
    )
    n_turns = sum(n for _name, n in per_speaker)
    if not n_turns:
        return nothing
    eff = build_effective_code_map(db, project_id)
    coded: dict[int, set[int]] = defaultdict(set)
    for seg_id, code_id in (
        db.query(Segment.id, CodeApplication.code_id)
        .join(Speaker, Speaker.id == Segment.speaker_id)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            *facilitator_turn,
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            reliability_coder_clause(),
            CodeApplication.user_id.in_(coder_ids),
        ).all()
    ):
        coded[resolve_effective_code(eff, code_id)].add(seg_id)
    return FacilitatorDisclosure(
        n_turns,
        {code: len(segs) for code, segs in coded.items()},
        sorted({name for name, _n in per_speaker}, key=str.casefold),
    )


# ── Option-B gather (mirrors consensus.py's roster-coder recipe) ───────────────


def gather_coder_applications(
    db: Session, project_id: int, coder_ids: list[int] | None = None, *,
    include_facilitator_turns: bool, collapse_groups: bool,
) -> tuple[
    list[int],
    dict[tuple, dict[int, set[int]]],
    dict[tuple, tuple],
    dict[tuple, set[int]],
    set[tuple],
    dict[tuple, dict[int, dict[int, float | None]]],
]:
    """Option-B coder-application gather shared by IRR and reconciliation.

    Returns ``(coder_id_list, applied, unit_source, engaged, multi_sources,
    ratings)``:

    - ``coder_id_list`` — sorted non-archived roster coder ids (the DEC-F roster,
      optionally filtered to ``coder_ids``). Single-sourced HERE so IRR,
      reconciliation, and the consensus materializer agree on who counts.
    - ``applied[ukey][coder_id]`` — set of EFFECTIVE codes that coder applied to the
      unit (D3 resolution already applied — do NOT re-resolve downstream).
    - ``unit_source[ukey]`` — the unit's source key; includes EVERY in-play unit of a
      multi-coder source, even ones no coder coded (→ real 0s under Option B).
      ⚠️ **"In play" for a dataset value means CODEABLE, not merely non-blank
      (#987)** — `substantive_text_clause` decides it, the same predicate the Text
      Coding view lists by, so the reliability unit count and what a coder was
      actually shown can never disagree. A cell the project treats as a
      non-response is not a unit here even if somebody coded it.
    - ``engaged[source_key]`` — coders who applied ≥1 code anywhere in that source.
    - ``multi_sources`` — sources engaged by ≥2 coders (the only contributors);
      empty set when none.
    - ``ratings[ukey][coder_id][raw_code_id]`` — that coder's magnitude on that
      application, ``None`` when unrated (#35). ⚠️ Keyed by the RAW code, never
      the effective one: a rating lives on its code's OWN declared scale, and two
      codes in an equivalence group may declare different instruments, so ratings
      are never pooled across a group. An entry exists for EVERY application, so
      "applied but unrated" (``None``) and "never applied" (absent) stay distinct
      — the coverage figures need both.

    ``ukey`` is ``("seg", id)`` / ``("val", id)`` — or ``("grp", id)`` for a
    segment GROUP when ``collapse_groups``; source keys
    ``("conv"|"doc"|"obs", id)`` / ``("col", id)`` — tag-prefixed, so ids drawn from
    four independent sequences can never collide.

    🔴 **The two unit-rule arguments have NO DEFAULT (#1333 / #1334)** — the
    `gather_target_votes(segment_scope=)` precedent: the signature is what makes
    each consumer decide. The agreement figures pass the stated basis's reading
    (`compute_irr`); the reconciliation grid passes ``True, True``, because it
    adjudicates the CONSENSUS LAYER, which covers facilitator turns (the analysis
    view can include them — a facilitator turn somebody coded is still coding a
    colleague may need to see) and decides a segment group once since 1.5.9's
    unit 3 (D35; the writer's `consensus.TARGET_GROUP` ballots).

    - ``include_facilitator_turns=False`` — a facilitator's turn is not a unit,
      and a coding on one does not make its coder ENGAGED with the source (the
      participant gauge, J-A, shows them nothing coded there either).
    - ``collapse_groups=True`` — a group's members are ONE unit: a coder applied
      a code to it if they applied it to ANY member (the apply fans out, so a
      member coded alone came from a door that does not — `bulk_code`, a coding
      made before the group existed, a merged copy), and a rating is
      `segment_groups.merge_unit_rating`'s answer.
    """
    coder_q = db.query(User).filter(
        reliability_coder_clause(),
        User.archived == False,  # noqa: E712
    )
    if coder_ids:
        coder_q = coder_q.filter(User.id.in_(coder_ids))
    coder_id_list = sorted(c.id for c in coder_q.all())
    if len(coder_id_list) < 2:
        return coder_id_list, {}, {}, {}, set(), {}
    eff = build_effective_code_map(db, project_id)
    # #987 — one scalar read, AFTER the early return so a single-coder project
    # pays nothing. NEVER cached at module scope: `treat_as_empty` is per project
    # and editable, and a stale list would silently change a reported unit set.
    treat_as_empty = treat_as_empty_for_project(db, project_id)

    # applied[unit_key][coder_id] = set of effective codes that coder put on the unit
    applied: dict[tuple, dict[int, set[int]]] = defaultdict(lambda: defaultdict(set))
    unit_source: dict[tuple, tuple] = {}
    engaged: dict[tuple, set[int]] = defaultdict(set)  # source_key -> coders who worked it
    # ratings[unit_key][coder_id][raw_code_id] = magnitude or None (#35)
    ratings: dict[tuple, dict[int, dict[int, float | None]]] = defaultdict(lambda: defaultdict(dict))

    base_filters = [
        non_consensus_filter(),
        Code.is_universal == False,  # noqa: E712
        reliability_coder_clause(),
        CodeApplication.user_id.in_(coder_id_list),
    ]

    # Segment applications — all THREE parents, but observation clips only when
    # their segmentation is FROZEN (D18 / D43). `consensus_scoped_segments` is that
    # rule: the shipped three-parent project scope composed with
    # `consensus_eligible_segment_clause()`. Never hand-roll the scope here — D18
    # single-sourced it precisely so a fourth copy can't drift.
    #
    # ⚠️ Open cuts must NEVER enter this gather. Option-B engagement is recorded at
    # the SOURCE (`engaged[src]` below), and `Segment` has no creator column, so
    # every coder's clips share one observation_id = one source key. The backfill
    # then hands each coder a hard 0 on clips they never saw: Alice's clip reads
    # [1,0], Bob's [0,1]. That is κ = -1.0 exactly when balanced, and α = -1 + 1/n
    # — and `compute_irr` pools every code into one headline alpha, so a single
    # open observation would corrupt a project whose transcripts agree perfectly.
    seg_app_rows = (
        reliability_segment_rows(
            consensus_scoped_segments(
                db.query(Segment.id, Segment.conversation_id, Segment.document_id,
                         Segment.observation_id, Segment.group_id,
                         CodeApplication.user_id, CodeApplication.code_id,
                         CodeApplication.magnitude)
                .join(CodeApplication, CodeApplication.segment_id == Segment.id)
                .join(Code, CodeApplication.code_id == Code.id)
                .join(User, CodeApplication.user_id == User.id),
                project_id,
            ),
            include_facilitator_turns=include_facilitator_turns,
        )
        .filter(*visible_segment_filter(), *base_filters)
        .all()
    )
    for seg_id, conv_id, doc_id, obs_id, group_id, uid, code_id, magnitude in seg_app_rows:
        src = _segment_source_key(conv_id, doc_id, obs_id)
        ukey = _unit_of(seg_id, group_id, collapse_groups)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(eff, code_id))
        _record_rating(ratings, ukey, uid, code_id, magnitude)
    _settle_rating_conflicts(ratings)

    # Dataset-value applications (open-ended text coding).
    #
    # 🔴 #987 — the CODEABLE predicate rides here too, and it is not belt-and-braces.
    # An application can sit on a cell the Text Coding view will not list: coded
    # before the project's `treat_as_empty` was edited, or applied through the API.
    # That coding is UI-UNREACHABLE — no chip, no row, no way to remove it — so
    # letting it move a reliability statistic is the #500 rule reached from a
    # second direction (`visible_target_filter` exists because a hidden original's
    # codings must not count). ⚠️ It also governs `engaged` below: a coder whose
    # ONLY coding in a column sits on such a cell has no reachable judgement there
    # and must not make the column look multi-coder.
    val_app_rows = (
        db.query(DatasetValue.id, DatasetValue.column_id,
                 CodeApplication.user_id, CodeApplication.code_id,
                 CodeApplication.magnitude)
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            Dataset.project_id == project_id,
            substantive_text_clause(treat_as_empty),
            *base_filters,
        )
        .all()
    )
    for val_id, col_id, uid, code_id, magnitude in val_app_rows:
        src = ("col", col_id)
        ukey = ("val", val_id)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(eff, code_id))
        ratings[ukey][uid][code_id] = magnitude

    # Sources engaged by ≥2 coders are the only ones that can contribute.
    multi_sources = {s for s, cs in engaged.items() if len(cs) >= 2}
    if not multi_sources:
        return coder_id_list, applied, unit_source, engaged, set(), ratings

    # Pull EVERY in-play unit of those sources (incl. units no coder coded → real
    # 0s under Option B). Segments: all visible. Dataset values: non-empty only
    # (a blank survey response is not a codeable unit — asymmetry is deliberate).
    conv_ids = [sid for (t, sid) in multi_sources if t == "conv"]
    doc_ids = [sid for (t, sid) in multi_sources if t == "doc"]
    obs_ids = [sid for (t, sid) in multi_sources if t == "obs"]
    col_ids = [sid for (t, sid) in multi_sources if t == "col"]
    if conv_ids or doc_ids or obs_ids:
        # The eligibility clause rides here too. `multi_sources` can only contain a
        # frozen observation (pass 1 filtered it), so this is belt-and-braces — but
        # the two passes must agree on WHICH units exist, and an unfrozen clip
        # entering only here would be a unit with no applications, i.e. an all-zero
        # row of pure fabricated disagreement.
        # #1333 / #1334 — the SAME unit rule as pass 1, or a prompt nobody coded
        # would re-enter here as a row of fabricated agreement, and a group's
        # uncoded members as units of their own.
        for seg_id, conv_id, doc_id, obs_id, group_id in (
            reliability_segment_rows(
                db.query(Segment.id, Segment.conversation_id, Segment.document_id,
                         Segment.observation_id, Segment.group_id),
                include_facilitator_turns=include_facilitator_turns,
            )
            .filter(
                *visible_segment_filter(),
                consensus_eligible_segment_clause(),
                or_(
                    Segment.conversation_id.in_(conv_ids),
                    Segment.document_id.in_(doc_ids),
                    Segment.observation_id.in_(obs_ids),
                ),
            ).all()
        ):
            src = _segment_source_key(conv_id, doc_id, obs_id)
            unit_source.setdefault(_unit_of(seg_id, group_id, collapse_groups), src)
    if col_ids:
        # 🔴 #987 — `substantive_text_clause`, NEVER a hand-rolled emptiness test.
        # This was `value_text != ""`, which differs from the codeable set TWICE:
        # it does not STRIP (`is_empty_text` does, so "   " read as a unit) and it
        # knows nothing of `treat_as_empty` — whose NULL state is the DEFAULTS,
        # `["N/A", "n/a", "NA", "No response", "None", "-", "."]`, not the empty
        # list. So a project that never touched the setting still hid those cells
        # from its coders while counting them here, each contributing a row of
        # fabricated agreement under Option B.
        #
        # MEASURED 2026-09-20 on the developer's own `dev.db`: the one multi-coder
        # text column had 40 units here against 36 a coder could reach — 10%.
        # ⚠️ The error has no constant direction, which is why it survived: those
        # rows RAISE percent agreement and DEPRESS α for a low-prevalence code, and
        # both numbers sit in the same table.
        for val_id, col_id in (
            db.query(DatasetValue.id, DatasetValue.column_id)
            .filter(
                DatasetValue.column_id.in_(col_ids),
                substantive_text_clause(treat_as_empty),
            ).all()
        ):
            unit_source.setdefault(("val", val_id), ("col", col_id))

    return coder_id_list, applied, unit_source, engaged, multi_sources, ratings


def build_irr_matrices(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
    source: tuple[str, int] | None = None, *,
    unit_basis: str = DEFAULT_RELIABILITY_UNIT_BASIS,
) -> tuple[
    list[int], dict[int, str], dict[int, list[list[int | None]]],
    set[tuple], set[int], dict[int, dict], dict[int, dict],
]:
    """Return ``(coder_ids_ordered, {code_id: name}, {effective_code_id: units},
    selectable_sources, scope_coders, magnitude, code_sets)``.

    ``units`` is the per-code matrix (one row per in-play unit; each row a list of
    length n_coders with 0/1/None). Source-level engagement (Option B) governs
    which cells are None. Built on the shared ``gather_coder_applications`` so IRR
    and reconciliation see the same CODERS and codings — but not the same UNITS
    (#1333 / #1334): this passes the stated ``unit_basis``'s reading (facilitator
    turns out, a group once) while the grid keeps facilitator turns (it counts a
    group once too, since unit 3, D35). The per-code matrix shaping below is
    IRR-specific.

    ``magnitude`` (#35) is ``{raw_code_id: {"code_name", "scale", "rows",
    "n_applications", "n_rated"}}`` for every code that DECLARES a scale and was
    applied at least once in scope. Its ``rows`` are the same shape and in the
    same unit order as ``units``, holding the coder's RATING or ``None``.

    🔴 **A cell is ``None`` both when the coder never applied the code and when
    they applied it unrated.** Neither is a judgement about the magnitude — the
    first is Option B's "no opinion recorded", the second is an explicit skip —
    so magnitude α is over the units two or more coders both applied AND rated.
    It is conditional on agreeing to apply, and the payload says so. Do not
    read an unrated application as a rating of the scale's minimum, or of zero:
    that is MAXQDA's default-stamping mistake, arriving through the statistic.

    ``code_sets`` (row 48) is ``{set_id: {"label", "exhaustive", "basis",
    "members", "member_names", "rows", "member_rows", "n_multiple_selection"}}``
    — one MULTI-VALUED matrix per set, in the same unit order as ``units``,
    whose cells are member code ids, the ``SET_NONE`` sentinel, or ``None``.

    ⚠️ **A set's members stay in ``units``**, and their exclusion from the
    displayed per-code table is `compute_irr`'s decision, not this function's.
    Reporting the same coding twice under two definitions — once as k binary
    indicators, once as one k-valued variable — is two answers to "how much did
    they agree?" on one screen; but `per_code` also feeds the R export, so
    dropping them HERE would stop exporting codes that have always been
    exported. Each member's matrix is additionally offered under
    ``member_rows``, which is the breakdown that answers *which value is
    destroying my α*.
    """
    # #1333 / #1334 — what a unit IS comes from the stated basis, never from a
    # second flag: the payload and the R script say the value that produced the
    # number. Every basis collapses groups; the two differ on facilitator turns.
    coder_id_list, applied, unit_source, engaged, multi_sources, ratings = gather_coder_applications(
        db, project_id, coder_ids,
        include_facilitator_turns=not unit_basis_excludes_facilitator_turns(unit_basis),
        collapse_groups=True,
    )
    if len(coder_id_list) < 2 or not multi_sources:
        return coder_id_list, {}, {}, set(), set(), {}, {}

    # #829 — the SOURCE axis. `multi_sources` is the selectable set (every source
    # ≥2 coders engaged); narrowing it to one is the whole scoping mechanism,
    # because `units` below is already filtered by it.
    #
    # ⚠️ **Scoping by SOURCE is not scoping by CODER.** `coder_ids` stays exactly
    # as passed — the matrix is ALWAYS all-roster (J2-5), because a visibility
    # filter must never change a reliability statistic. Only the unit set moves.
    selectable = set(multi_sources)
    if source is not None:
        multi_sources = {source} & multi_sources
        if not multi_sources:
            return coder_id_list, {}, {}, selectable, set(), {}, {}

    n = len(coder_id_list)
    coder_idx = {cid: i for i, cid in enumerate(coder_id_list)}

    units = [u for u, src in unit_source.items() if src in multi_sources]
    # The coders actually engaged in the SCOPE being reported — the fact #828's
    # gate needs, and which the roster size cannot answer.
    scope_coders = {c for src in multi_sources for c in engaged[src]} & set(coder_id_list)
    all_codes = sorted({c for ud in applied.values() for cs in ud.values() for c in cs})
    code_names = dict(
        db.query(Code.id, Code.name).filter(Code.id.in_(all_codes)).all()
    ) if all_codes else {}

    empty: set[int] = set()
    per_code: dict[int, list[list[int | None]]] = {}
    for code_id in all_codes:
        rows: list[list[int | None]] = []
        for u in units:
            src_coders = engaged[unit_source[u]]
            row: list[int | None] = [None] * n
            applied_here = applied.get(u, {})
            for cid in src_coders:
                row[coder_idx[cid]] = 1 if code_id in applied_here.get(cid, empty) else 0
            rows.append(row)
        per_code[code_id] = rows

    # ── Row 48 — the code-set matrices, and the members leaving `per_code` ────
    #
    # One MULTI-VALUED row per unit per set, fed to the same `_krippendorff_alpha`
    # the binary tables use. The arithmetic needed nothing: `unit_coincidence`
    # keys its coincidence matrix on the VALUES, so k categories cost what two do.
    code_sets: dict[int, dict] = {}
    set_index = build_code_set_index(db, project_id, build_effective_code_map(db, project_id))
    for resolved in set_index.sets:
        if not resolved.member_ids:
            continue
        rows_s: list[list[int | None]] = []
        n_multiple = 0
        for u in units:
            src_coders = engaged[unit_source[u]]
            row_s: list[int | None] = [None] * n
            applied_here = applied.get(u, {})
            for cid in src_coders:
                cell, is_multiple = matrix_cell(applied_here.get(cid, empty), resolved)
                row_s[coder_idx[cid]] = cell
                if is_multiple:
                    n_multiple += 1
            rows_s.append(row_s)
        # The breakdown: each member's own binary matrix, READ from the per-code
        # table rather than recomputed, so the two can never disagree about which
        # units a member was applied on.
        #
        # 🔴 **READ, NOT POPPED, AND THAT IS THE DIFFERENCE BETWEEN A DISPLAY RULE
        # AND DATA LOSS.** Excluding members from the per-code TABLE is a
        # decision about one screen (the same coding reported twice under two
        # definitions is worse than once); `per_code` has a second consumer —
        # `export_r.py` emits a coder × unit matrix per code for the researcher's
        # reproducibility script — and removing them here would silently stop
        # exporting codes that have always been exported. `compute_irr` skips
        # them when it builds the table; this function keeps reporting them.
        member_rows = {
            cid: per_code[cid] for cid in resolved.ordered_members if cid in per_code
        }
        code_sets[resolved.id] = {
            "label": resolved.label,
            "exhaustive": resolved.exhaustive,
            "basis": resolved.basis,
            "members": list(resolved.ordered_members),
            "member_names": dict(resolved.member_names),
            "rows": rows_s,
            "member_rows": member_rows,
            "n_multiple_selection": n_multiple,
        }

    # #35 — the RATING matrices, one per code that declares a scale. Keyed by
    # the RAW code (see `gather_coder_applications`): the instrument is the
    # code's own. A code whose scale was cleared keeps its stored ratings but
    # gets no row here — a number with no declared range is not interpretable,
    # which is the same rule the chip renders by (`lib/magnitude.ts`).
    magnitude: dict[int, dict] = {}
    scaled_codes = (
        db.query(Code)
        .filter(
            Code.project_id == project_id,
            Code.magnitude_min.isnot(None),
            Code.magnitude_max.isnot(None),
        )
        .all()
    )
    for code in scaled_codes:
        scale = read_scale(code)
        if scale is None:
            continue
        rows_m: list[list[float | None]] = []
        n_applications = n_rated = 0
        for u in units:
            src_coders = engaged[unit_source[u]]
            row_m: list[float | None] = [None] * n
            per_coder = ratings.get(u, {})
            for cid in src_coders:
                by_code = per_coder.get(cid)
                if by_code is None or code.id not in by_code:
                    continue
                n_applications += 1
                value = by_code[code.id]
                # `is not None`, never truthiness: 0 is a rating (#35 §2).
                if value is not None:
                    n_rated += 1
                    row_m[coder_idx[cid]] = value
            rows_m.append(row_m)
        if n_applications == 0:
            continue
        magnitude[code.id] = {
            "code_name": code.name,
            "scale": scale,
            "rows": rows_m,
            "n_applications": n_applications,
            "n_rated": n_rated,
        }
    return coder_id_list, code_names, per_code, selectable, scope_coders, magnitude, code_sets


def compute_irr(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
    source: tuple[str, int] | None = None, *,
    unit_basis: str = DEFAULT_RELIABILITY_UNIT_BASIS,
) -> dict:
    """Compute per-code + overall IRR for a project, optionally scoped to ONE source.

    ``source`` is a ``(kind, id)`` key — ``("conv"|"doc"|"obs"|"col", id)``.
    ⚠️ **It defaults to None = POOLED, and that default is load-bearing**: the
    `.mmproject` R export calls this and must keep emitting the pooled figures
    it has always emitted (#402, `test_export_r_irr.py`).

    #829: the pooled table averaged every multi-coder source in the project into
    one headline — measured, a deliberate two-coder study of one column pooled
    with seven other people's transcript work, *Curriculum fidelity* reading
    α 0.06 pooled against 0.0023 on the notes alone, under *"Overall α 0.62 ·
    unreliable"* as the largest text on screen.

    ⚠️ **That 0.0023 was re-measured after #987 and is now −0.0183** (same corpus,
    same column, 40 units → 36 once the four `N/A` cells stopped being units). The
    illustration stands; the NUMBER is kept here only as the figure #829 was filed
    against. **Do not quote either from this docstring** — re-measure.
    """
    coder_id_list, code_names, per_code, selectable, scope_coders, magnitude, code_sets = (
        build_irr_matrices(db, project_id, coder_ids, source, unit_basis=unit_basis)
    )
    n = len(coder_id_list)
    coders = (
        [{"id": cid, "name": name}
         for cid, name in db.query(User.id, User.username)
         .filter(User.id.in_(coder_id_list)).all()]
        if coder_id_list else []
    )
    thresholds = {"kappa": dict(KAPPA_THRESHOLDS), "alpha": dict(ALPHA_THRESHOLDS)}

    # ⚠️ **A project whose only multi-coder codes are set MEMBERS is available,
    # and `per_code` alone answers that — because the members stay in it.** This
    # guard was briefly widened to `(not per_code and not code_sets)`; a planted
    # mutant reverting the widening SURVIVED, which said the added clause never
    # runs: `build_irr_matrices` returns an empty `per_code` only from its two
    # early returns, and both return an empty `code_sets` with it. The clause was
    # removed rather than kept as belt-and-braces, and the test that pins the
    # behaviour (`test_a_project_of_ONLY_set_members_is_still_AVAILABLE`) now
    # guards the mechanism that actually delivers it.
    if n < 2 or not per_code:
        return {
            "available": False,
            "sources": _describe_sources(db, selectable),
            "source": _source_token(source),
            "reason": "Inter-rater reliability needs at least 2 coders with coding on a shared source.",
            "n_coders": n,
            "coders": coders,
            "per_code": [],
            "overall_alpha": None,
            "overall_alpha_interpretation": None,
            "overall_verdict_withheld_reason": None,
            "overall_alpha_ci": None,
            "interpretation_thresholds": thresholds,
            "verdict_min_units": VERDICT_MIN_UNITS,
            "reliability_facet": RELIABILITY_FACET_CODERS,
            "unit_basis": unit_basis,
            "magnitude_per_code": [],
            "set_agreement": [],
        }

    # #828 — κ belongs to a SOURCE, not to the install. The engaged pair is the
    # honest basis, and the panel's own explainer already promised it: *"Cohen's
    # κ only when exactly two coders coded a shared source."*
    pair_idx: tuple[int, int] | None = None
    if len(scope_coders) == 2:
        a, b = sorted(scope_coders, key=coder_id_list.index)
        pair_idx = (coder_id_list.index(a), coder_id_list.index(b))

    # #43 — the interval machinery. Imported at CALL time because
    # `reliability_intervals` imports this module's α formula: a top-level
    # import here would make the pair circular and fail at load.
    from .reliability_intervals import (
        alpha_interval,
        kappa_interval,
        pooled_unit_contributions,
        unit_contributions,
    )

    # Row 48 — the codes a set speaks for. They are reported as ONE k-valued
    # variable in `set_agreement` below, so they do not also get a binary row
    # here: two definitions of the same coding on one screen, with nothing
    # saying which is which, is worse than one. They keep their matrices in
    # `per_code` for the R export, and their binary α in each set's breakdown.
    set_member_ids = {cid for e in code_sets.values() for cid in e["members"]}

    # #1333 — what the exclusion left out (all None when facilitator turns are units).
    scope_sources = ({source} & selectable) if source is not None else selectable
    if unit_basis_excludes_facilitator_turns(unit_basis):
        fac = facilitator_turn_disclosure(db, project_id, coder_id_list, scope_sources)
        fac_excluded, fac_coded, fac_speakers = fac.turns, fac.coded_by_code, fac.speakers
    else:
        fac_excluded, fac_coded, fac_speakers = None, {}, None

    per_code_results = []
    global_rows: list[list[int | None]] = []
    # The per-code matrices pooled into the headline, kept SEPARATE from
    # `global_rows` so the headline's interval can resample UNITS rather than
    # (unit × code) rows — see `pooled_unit_contributions`.
    pooled_matrices: list[list[list[int | None]]] = []
    for code_id, rows in per_code.items():
        if code_id in set_member_ids:
            continue
        n_units = _n_comparable_units(rows)
        if n_units == 0:
            continue
        prevalence = _prevalence(rows)
        reason = binary_undefined_reason(rows)

        # 🔴 #1505 (D42) — ONE comparable unit is not a measurement: α is 0 for any
        # disagreement over a single unit, and κ with it. `insufficient_n`, decided
        # before variance (it is the one the researcher can act on).
        #
        # 🔴 THE ZERO-PREVALENCE RIDER (#829). A code NOBODY applied in scope has
        # no variance to agree about, and the arithmetic says so loudly in the
        # wrong direction: every present cell is 0, so po = 1.0, the expected
        # agreement pe is also 1.0, and the `pe >= 1.0` branch returns κ = 1.0 —
        # rendered "almost perfect". Measured on real data: three codes reporting
        # n=40, prevalence 0.00, agreement 100%, κ = 1, and LIFTING the headline
        # (α 0.7962 with them, 0.7911 without).
        #
        # This is #689's rule, not a new one: an undefined statistic is None WITH
        # a reason, never a number. The reason is the existing `no_variance`
        # member of `undefined_stats.UNDEFINED_REASONS`. Reporting it as
        # undefined also answers the pooling question for free — an undefined
        # statistic contributes no rows to the headline.
        #
        # ⚠️ Per-source scoping makes this MORE visible, not less: a source where
        # a code was never used becomes its own κ = 1 row. The two ship together
        # or the fix makes the panel noisier than it found it.
        if reason is not None:
            per_code_results.append({
                "code_id": code_id,
                "code_name": code_names.get(code_id, str(code_id)),
                "n_units": n_units,
                "percent_agreement": _percent_agreement(rows),
                "prevalence": prevalence,
                "cohens_kappa": None,
                "kappa_interpretation": None,
                "krippendorff_alpha": None,
                "alpha_interpretation": None,
                "verdict_withheld_reason": None,
                "alpha_metric": ALPHA_METRIC_NOMINAL,
                "undefined_reason": reason,
                # #43 — an undefined statistic gets no interval, and no SECOND
                # reason: `undefined_reason` above already explains the blank.
                "kappa_ci": None,
                "alpha_ci": None,
                "facilitator_turns_coded": (
                    fac_coded.get(code_id, 0) if fac_excluded is not None else None
                ),
            })
            continue

        alpha = _krippendorff_alpha(rows)
        pair_rows = _project_to_pair(rows, *pair_idx) if pair_idx else None
        kappa = _cohens_kappa(pair_rows) if pair_rows is not None else None
        # D43 — below the verdict floor the numbers stay and the band words go;
        # one reason per ROW, because κ and α rest on the same units.
        kappa_band, _ = _verdict(kappa, n_units, _interpret_kappa)
        alpha_band, withheld = _verdict(alpha, n_units, _interpret_alpha)
        per_code_results.append({
            "code_id": code_id,
            "code_name": code_names.get(code_id, str(code_id)),
            "n_units": n_units,
            "percent_agreement": _percent_agreement(rows),
            "prevalence": prevalence,
            "cohens_kappa": kappa,
            "kappa_interpretation": kappa_band,
            "krippendorff_alpha": alpha,
            "alpha_interpretation": alpha_band,
            "verdict_withheld_reason": withheld,
            # Presence/absence is categorical, so its α is scored NOMINALLY.
            # Stated on the row rather than assumed: the rating table below
            # scores its α on the INTERVAL metric, and the two must never be
            # read as the same number.
            "alpha_metric": ALPHA_METRIC_NOMINAL,
            "undefined_reason": None,
            # The interval is computed from the SAME rows the estimate came
            # from — `pair_rows` for κ, the full matrix for α — so a scope
            # change can never move one without the other.
            "kappa_ci": kappa_interval(pair_rows) if kappa is not None else None,
            "alpha_ci": alpha_interval(unit_contributions(rows)) if alpha is not None else None,
            "facilitator_turns_coded": (
                fac_coded.get(code_id, 0) if fac_excluded is not None else None
            ),
        })
        global_rows.extend(rows)
        pooled_matrices.append(rows)

    per_code_results.sort(key=lambda r: r["code_name"].lower())
    overall_alpha = _krippendorff_alpha(global_rows) if global_rows else None
    overall_alpha_ci = (
        alpha_interval(pooled_unit_contributions(pooled_matrices))
        if overall_alpha is not None else None
    )
    # D43 — the headline's UNITS are passages, not (passage × code) rows: every
    # pooled matrix iterates the same unit list (`pooled_unit_contributions`
    # asserts it), so any one of them counts them. A pooled set of ONE unit never
    # reaches here — each of its codes is `insufficient_n` and adds no rows (D42).
    overall_band, overall_withheld = _verdict(
        overall_alpha,
        _n_comparable_units(pooled_matrices[0]) if pooled_matrices else 0,
        _interpret_alpha,
    )

    # ── #35 — rating agreement, one α PER scaled code, never pooled ───────────
    #
    # "Joy 0–100" and "Anxiety −1…+1" are different instruments; one coefficient
    # over both would average disagreement measured in different units. So there
    # is no rating headline, and these rows are deliberately NOT added to
    # `global_rows` — the overall α above stays a statement about presence/absence.
    magnitude_results: list[dict] = []
    for code_id, entry in magnitude.items():
        rows_m = entry["rows"]
        n_units_m = _n_comparable_units(rows_m)
        base = {
            "code_id": code_id,
            "code_name": entry["code_name"],
            "scale": entry["scale"],
            "n_units": n_units_m,
            "n_applications": entry["n_applications"],
            "n_rated": entry["n_rated"],
            "mean_abs_difference": _mean_abs_difference(rows_m),
            "alpha_metric": MAGNITUDE_ALPHA_METRIC,
        }
        # `insufficient_n` — no unit rated by two coders (every rating one coder's
        # alone: coverage, not agreement), or ONE such unit (D42: an identity).
        # The row still renders so the researcher sees HOW thin the ratings are;
        # that visibility is why variant C (optional rating) was rejected in the
        # design round. `no_variance` — #829's rule through ratings: identical
        # compared values are no variance to agree about, not perfect agreement.
        reason_m = valued_undefined_reason(rows_m)
        if reason_m is not None:
            magnitude_results.append({
                **base,
                "krippendorff_alpha": None,
                "alpha_interpretation": None,
                "verdict_withheld_reason": None,
                "undefined_reason": reason_m,
                "alpha_ci": None,
            })
            continue
        alpha_m = _krippendorff_alpha(rows_m, MAGNITUDE_ALPHA_METRIC)
        band_m, withheld_m = _verdict(alpha_m, n_units_m, _interpret_alpha)
        magnitude_results.append({
            **base,
            "krippendorff_alpha": alpha_m,
            "alpha_interpretation": band_m,
            "verdict_withheld_reason": withheld_m,
            "undefined_reason": None,
            # The SAME metric as the point estimate, by construction — the
            # interval brackets the number it sits beside, not a nominal cousin.
            "alpha_ci": (
                alpha_interval(unit_contributions(rows_m), metric=MAGNITUDE_ALPHA_METRIC)
                if alpha_m is not None else None
            ),
        })
    magnitude_results.sort(key=lambda r: r["code_name"].lower())

    # ── Row 48 — set agreement, one α PER set, never pooled ───────────────────
    #
    # A binary presence/absence α and a k-valued nominal α are different
    # instruments, so one coefficient over both would average disagreements
    # measured on different scales — the same rule, and the same reason, as the
    # rating table above. These rows are deliberately NOT added to `global_rows`:
    # the headline α stays a statement about presence/absence coding.
    #
    # 🔴 **`_prevalence` IS NOT USED HERE AND MUST NOT BE.** It computes
    # `ones += v` over the cells, which is the base rate of a 0/1 indicator; on a
    # set matrix the cells are CODE IDS, so it would sum identifiers and print
    # the mean of a primary key. The per-member breakdown carries the real base
    # rates, one per value, which is the honest generalisation of that column.
    set_results: list[dict] = []
    pair_list = sorted(scope_coders, key=coder_id_list.index)
    for set_id, entry in code_sets.items():
        rows_s = entry["rows"]
        members: list[int] = entry["members"]
        member_names: dict[int, str] = entry["member_names"]
        n_units_s = _n_comparable_units(rows_s)

        # The axis carries "none of these" only when it is a VALUE. On an
        # exhaustive set a blank is missing data and has no column.
        axis = list(members) + ([] if entry["exhaustive"] else [SET_NONE])

        # Each member's own binary α — the breakdown that answers "which value
        # is destroying my α", and the rows the per-code table no longer shows.
        member_results = []
        for code_id in members:
            m_rows = entry["member_rows"].get(code_id)
            if m_rows is None:
                continue
            m_reason = binary_undefined_reason(m_rows)
            m_alpha = None if m_reason else _krippendorff_alpha(m_rows)
            m_n = _n_comparable_units(m_rows)
            m_band, m_withheld = _verdict(m_alpha, m_n, _interpret_alpha)
            member_results.append({
                "code_id": code_id,
                "code_name": member_names.get(code_id, str(code_id)),
                "n_units": m_n,
                "prevalence": _prevalence(m_rows),
                "percent_agreement": _percent_agreement(m_rows),
                "krippendorff_alpha": m_alpha,
                "alpha_interpretation": m_band,
                "verdict_withheld_reason": m_withheld,
                "undefined_reason": m_reason,
            })

        confusion = [
            {
                "coder_a_id": a,
                "coder_b_id": b,
                "counts": _confusion_matrix(
                    rows_s, coder_id_list.index(a), coder_id_list.index(b), axis,
                ),
            }
            for i, a in enumerate(pair_list)
            for b in pair_list[i + 1:]
        ]
        confusion = [c for c in confusion if any(any(r) for r in c["counts"])]

        base = {
            "set_id": set_id,
            "label": entry["label"],
            "exhaustive": entry["exhaustive"],
            # The TWELFTH stated-basis member: the same coders on the same data
            # produce different numbers under the two, and the reader cannot see
            # which from the figure.
            "set_basis": entry["basis"],
            "alpha_metric": ALPHA_METRIC_NOMINAL,
            "n_units": n_units_s,
            "n_values": len(members),
            "n_multiple_selection": entry["n_multiple_selection"],
            "axis": axis,
            "value_names": {
                **{str(cid): member_names.get(cid, str(cid)) for cid in members},
                str(SET_NONE): "None of these",
            },
            "members": member_results,
            "confusion": confusion,
            "percent_agreement": _percent_agreement(rows_s),
        }

        # `degenerate` — one member is a binary code wearing a costume, and α over
        # a single-valued variable answers a question nobody asked (the MODEL
        # permits a half-built set — a researcher adds members one at a time — so
        # the refusal belongs to the statistic, and it says why) · `insufficient_n`
        # — no comparable unit, or one (D42) · `no_variance` — #829's rule through
        # sets: every comparable unit taking one value is no variance to agree
        # about, not perfect agreement.
        reason_s = set_undefined_reason(rows_s, len(members))
        if reason_s is not None:
            set_results.append({
                **base, "cohens_kappa": None, "kappa_interpretation": None,
                "krippendorff_alpha": None, "alpha_interpretation": None,
                "verdict_withheld_reason": None,
                "undefined_reason": reason_s, "kappa_ci": None, "alpha_ci": None,
            })
            continue

        alpha_s = _krippendorff_alpha(rows_s)
        # κ is k-valued by construction — `_cohens_kappa` derives its categories
        # from the values it is given — so a set gets one on the same terms the
        # per-code table does: exactly two engaged coders in scope.
        pair_rows_s = _project_to_pair(rows_s, *pair_idx) if pair_idx else None
        kappa_s = _cohens_kappa(pair_rows_s) if pair_rows_s is not None else None
        kappa_band_s, _ = _verdict(kappa_s, n_units_s, _interpret_kappa)
        alpha_band_s, withheld_s = _verdict(alpha_s, n_units_s, _interpret_alpha)
        set_results.append({
            **base,
            "cohens_kappa": kappa_s,
            "kappa_interpretation": kappa_band_s,
            "krippendorff_alpha": alpha_s,
            "alpha_interpretation": alpha_band_s,
            "verdict_withheld_reason": withheld_s,
            "undefined_reason": None,
            "kappa_ci": kappa_interval(pair_rows_s) if kappa_s is not None else None,
            # The interval is built from the SET's rows, never a member's — the
            # #35 lesson exactly: for one slab the bootstrap scored every
            # resample nominally whatever the estimate used.
            "alpha_ci": (
                alpha_interval(unit_contributions(rows_s)) if alpha_s is not None else None
            ),
        })
    set_results.sort(key=lambda r: r["label"].lower())

    return {
        "available": True,
        "sources": _describe_sources(db, selectable),
        "source": _source_token(source),
        "n_coders": n,
        "coders": coders,
        # ⚠️ Reads the SCOPE's engaged pair, not the roster — a per-source κ under
        # a roster-derived label would say "alpha" beside a populated κ column.
        "metric_label": "kappa+alpha" if pair_idx else "alpha",
        "per_code": per_code_results,
        "overall_alpha": overall_alpha,
        "overall_alpha_interpretation": overall_band,
        "overall_verdict_withheld_reason": overall_withheld,
        # ⚠️ A CLUSTER bootstrap over units, not over the pooled rows — a unit
        # contributes one row per code and those rows move together (#43).
        "overall_alpha_ci": overall_alpha_ci,
        "interpretation_thresholds": thresholds,
        # #1505 (D43) — the floor below which no row carries a band word. Rides
        # the payload so the client's sentence says the server's number.
        "verdict_min_units": VERDICT_MIN_UNITS,
        # The stated basis (#35): every α on this payload is over CODERS. A
        # dataset scale score's α is over ITEMS and says so on its own payload;
        # the client displays each and never infers either from the screen.
        "reliability_facet": RELIABILITY_FACET_CODERS,
        # #1333 / #1334 — the FOURTEENTH stated-basis member: what "Units" counts.
        # The same coding gives a different α under each value.
        "unit_basis": unit_basis,
        "facilitator_turns_excluded": fac_excluded,
        # D18 — who was treated as a facilitator (None when nobody was left out).
        "facilitator_speakers": fac_speakers,
        "magnitude_per_code": magnitude_results,
        # Row 48 — the THIRD table. Never pooled into `overall_alpha`.
        "set_agreement": set_results,
    }
