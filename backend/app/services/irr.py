"""Inter-rater reliability for code presence/absence (Track J · J2-4).

Measures how much the human coders agree, per effective code and overall:
percent agreement (always), Cohen's κ (exactly 2 coders), and Krippendorff's α
(any number). The display surfaces (agreement matrix, reconciliation UI) are J2-5;
this is the computation engine + an on-demand read.

**Unit = target × code, binary.** For a given code, each coder's value on a unit
(a segment XOR a dataset value) is 1 (applied) or 0 (did not apply) or MISSING.

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

Raters = the roster (``coder_type NOT IN SYSTEM_CODER_TYPES`` — human + future AI,
excluding the merged-legacy "Unattributed" bucket AND the derived consensus layer).
Universal codes are excluded. Codes are compared by *effective code* (the D3
equivalence-group seam), so "Positive" ≡ "POSITIVE". The gather mirrors
``consensus.py``'s roster-coder recipe; the math is pure (numpy-free, unit-testable)
and round-tripped against R's ``irr`` package.
"""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..auth import SYSTEM_CODER_TYPES
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
from .magnitude import read_scale
from .reliability_basis import (
    ALPHA_METRIC_NOMINAL,
    MAGNITUDE_ALPHA_METRIC,
    RELIABILITY_FACET_CODERS,
)
from .undefined_stats import INSUFFICIENT_N, NO_VARIANCE


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
    Reproduces ``irr::kripp.alpha(method=metric)`` for numeric data. Non-nominal
    metrics require numeric values; ratio additionally requires non-negative
    values.

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


# ── Option-B gather (mirrors consensus.py's roster-coder recipe) ───────────────


def gather_coder_applications(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
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

    ``ukey`` is ``("seg", id)`` / ``("val", id)``; source keys
    ``("conv"|"doc"|"obs", id)`` / ``("col", id)`` — tag-prefixed, so ids drawn from
    four independent sequences can never collide.
    """
    coder_q = db.query(User).filter(
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
        User.archived == False,  # noqa: E712
    )
    if coder_ids:
        coder_q = coder_q.filter(User.id.in_(coder_ids))
    coder_id_list = sorted(c.id for c in coder_q.all())
    if len(coder_id_list) < 2:
        return coder_id_list, {}, {}, {}, set(), {}
    eff = build_effective_code_map(db, project_id)

    # applied[unit_key][coder_id] = set of effective codes that coder put on the unit
    applied: dict[tuple, dict[int, set[int]]] = defaultdict(lambda: defaultdict(set))
    unit_source: dict[tuple, tuple] = {}
    engaged: dict[tuple, set[int]] = defaultdict(set)  # source_key -> coders who worked it
    # ratings[unit_key][coder_id][raw_code_id] = magnitude or None (#35)
    ratings: dict[tuple, dict[int, dict[int, float | None]]] = defaultdict(lambda: defaultdict(dict))

    base_filters = [
        non_consensus_filter(),
        Code.is_universal == False,  # noqa: E712
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
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
        consensus_scoped_segments(
            db.query(Segment.id, Segment.conversation_id, Segment.document_id,
                     Segment.observation_id,
                     CodeApplication.user_id, CodeApplication.code_id,
                     CodeApplication.magnitude)
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, CodeApplication.code_id == Code.id)
            .join(User, CodeApplication.user_id == User.id),
            project_id,
        )
        .filter(*visible_segment_filter(), *base_filters)
        .all()
    )
    for seg_id, conv_id, doc_id, obs_id, uid, code_id, magnitude in seg_app_rows:
        src = _segment_source_key(conv_id, doc_id, obs_id)
        ukey = ("seg", seg_id)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(eff, code_id))
        ratings[ukey][uid][code_id] = magnitude

    # Dataset-value applications (open-ended text coding).
    val_app_rows = (
        db.query(DatasetValue.id, DatasetValue.column_id,
                 CodeApplication.user_id, CodeApplication.code_id,
                 CodeApplication.magnitude)
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(Dataset.project_id == project_id, *base_filters)
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
        for seg_id, conv_id, doc_id, obs_id in (
            db.query(Segment.id, Segment.conversation_id, Segment.document_id,
                     Segment.observation_id)
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
            unit_source.setdefault(("seg", seg_id), src)
    if col_ids:
        for val_id, col_id in (
            db.query(DatasetValue.id, DatasetValue.column_id)
            .filter(
                DatasetValue.column_id.in_(col_ids),
                DatasetValue.value_text.isnot(None),
                DatasetValue.value_text != "",
            ).all()
        ):
            unit_source.setdefault(("val", val_id), ("col", col_id))

    return coder_id_list, applied, unit_source, engaged, multi_sources, ratings


def build_irr_matrices(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
    source: tuple[str, int] | None = None,
) -> tuple[
    list[int], dict[int, str], dict[int, list[list[int | None]]],
    set[tuple], set[int], dict[int, dict],
]:
    """Return ``(coder_ids_ordered, {code_id: name}, {effective_code_id: units},
    selectable_sources, scope_coders, magnitude)``.

    ``units`` is the per-code matrix (one row per in-play unit; each row a list of
    length n_coders with 0/1/None). Source-level engagement (Option B) governs
    which cells are None. Built on the shared ``gather_coder_applications`` so IRR
    and reconciliation see identical coder/unit data; the per-code matrix shaping
    below is IRR-specific.

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
    """
    coder_id_list, applied, unit_source, engaged, multi_sources, ratings = gather_coder_applications(
        db, project_id, coder_ids
    )
    if len(coder_id_list) < 2 or not multi_sources:
        return coder_id_list, {}, {}, set(), set(), {}

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
            return coder_id_list, {}, {}, selectable, set(), {}

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
    return coder_id_list, code_names, per_code, selectable, scope_coders, magnitude


def compute_irr(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
    source: tuple[str, int] | None = None,
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
    """
    coder_id_list, code_names, per_code, selectable, scope_coders, magnitude = build_irr_matrices(
        db, project_id, coder_ids, source
    )
    n = len(coder_id_list)
    coders = (
        [{"id": cid, "name": name}
         for cid, name in db.query(User.id, User.username)
         .filter(User.id.in_(coder_id_list)).all()]
        if coder_id_list else []
    )
    thresholds = {"kappa": dict(KAPPA_THRESHOLDS), "alpha": dict(ALPHA_THRESHOLDS)}

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
            "overall_alpha_ci": None,
            "interpretation_thresholds": thresholds,
            "reliability_facet": RELIABILITY_FACET_CODERS,
            "magnitude_per_code": [],
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

    per_code_results = []
    global_rows: list[list[int | None]] = []
    # The per-code matrices pooled into the headline, kept SEPARATE from
    # `global_rows` so the headline's interval can resample UNITS rather than
    # (unit × code) rows — see `pooled_unit_contributions`.
    pooled_matrices: list[list[list[int | None]]] = []
    for code_id, rows in per_code.items():
        n_units = _n_comparable_units(rows)
        if n_units == 0:
            continue
        prevalence = _prevalence(rows)

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
        no_variance = prevalence == 0.0 or prevalence == 1.0
        if no_variance:
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
                "alpha_metric": ALPHA_METRIC_NOMINAL,
                "undefined_reason": NO_VARIANCE,
                # #43 — an undefined statistic gets no interval, and no SECOND
                # reason: `undefined_reason` above already explains the blank.
                "kappa_ci": None,
                "alpha_ci": None,
            })
            continue

        alpha = _krippendorff_alpha(rows)
        pair_rows = _project_to_pair(rows, *pair_idx) if pair_idx else None
        kappa = _cohens_kappa(pair_rows) if pair_rows is not None else None
        per_code_results.append({
            "code_id": code_id,
            "code_name": code_names.get(code_id, str(code_id)),
            "n_units": n_units,
            "percent_agreement": _percent_agreement(rows),
            "prevalence": prevalence,
            "cohens_kappa": kappa,
            "kappa_interpretation": _interpret_kappa(kappa),
            "krippendorff_alpha": alpha,
            "alpha_interpretation": _interpret_alpha(alpha),
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
        })
        global_rows.extend(rows)
        pooled_matrices.append(rows)

    per_code_results.sort(key=lambda r: r["code_name"].lower())
    overall_alpha = _krippendorff_alpha(global_rows) if global_rows else None
    overall_alpha_ci = (
        alpha_interval(pooled_unit_contributions(pooled_matrices))
        if overall_alpha is not None else None
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
        if n_units_m == 0:
            # Every rating here is one coder's alone — coverage, not agreement.
            # The row still renders so the researcher sees HOW thin the ratings
            # are; that visibility is why variant C (optional rating) was
            # rejected in the design round.
            magnitude_results.append({
                **base,
                "krippendorff_alpha": None,
                "alpha_interpretation": None,
                "undefined_reason": INSUFFICIENT_N,
                "alpha_ci": None,
            })
            continue
        if len(_distinct_comparable_values(rows_m)) < 2:
            # #829's rule through ratings: identical values everywhere is not
            # "perfect agreement", it is no variance to agree about.
            magnitude_results.append({
                **base,
                "krippendorff_alpha": None,
                "alpha_interpretation": None,
                "undefined_reason": NO_VARIANCE,
                "alpha_ci": None,
            })
            continue
        alpha_m = _krippendorff_alpha(rows_m, MAGNITUDE_ALPHA_METRIC)
        magnitude_results.append({
            **base,
            "krippendorff_alpha": alpha_m,
            "alpha_interpretation": _interpret_alpha(alpha_m),
            "undefined_reason": None,
            # The SAME metric as the point estimate, by construction — the
            # interval brackets the number it sits beside, not a nominal cousin.
            "alpha_ci": (
                alpha_interval(unit_contributions(rows_m), metric=MAGNITUDE_ALPHA_METRIC)
                if alpha_m is not None else None
            ),
        })
    magnitude_results.sort(key=lambda r: r["code_name"].lower())

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
        "overall_alpha_interpretation": _interpret_alpha(overall_alpha),
        # ⚠️ A CLUSTER bootstrap over units, not over the pooled rows — a unit
        # contributes one row per code and those rows move together (#43).
        "overall_alpha_ci": overall_alpha_ci,
        "interpretation_thresholds": thresholds,
        # The stated basis (#35): every α on this payload is over CODERS. A
        # dataset scale score's α is over ITEMS and says so on its own payload;
        # the client displays each and never infers either from the screen.
        "reliability_facet": RELIABILITY_FACET_CODERS,
        "magnitude_per_code": magnitude_results,
    }
