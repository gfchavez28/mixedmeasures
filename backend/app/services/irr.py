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
    non_consensus_filter,
    resolve_effective_code,
)

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


def _krippendorff_alpha(
    units: list[list[int | None]], metric: str = "nominal",
) -> float | None:
    """Krippendorff's α, n coders, missing-data tolerant.

    Builds the coincidence matrix the canonical way (each unit with m≥2 present
    values contributes 1/(m-1) per ordered value pair), then
    α = 1 − (n−1)·Σ_{c,k} o_ck·δ²_ck / Σ_{c,k} n_c·n_k·δ²_ck with the metric's
    difference function δ² (nominal: 1 for c≠k). Reproduces
    ``irr::kripp.alpha(method=metric)`` for numeric data. Non-nominal metrics
    require numeric values; ratio additionally requires non-negative values.

    The binary presence/absence IRR surfaces use the nominal default; the metric
    generalization is the designed extension point for ordinal/interval magnitude
    ratings (#35) and the v1.4 honest-ICR arc.
    """
    o: dict[tuple, float] = defaultdict(float)
    for row in units:
        present = [v for v in row if v is not None]
        m = len(present)
        if m < 2:
            continue
        inv = 1.0 / (m - 1)
        for i in range(m):
            for j in range(m):
                if i != j:
                    o[(present[i], present[j])] += inv
    if not o:
        return None  # no unit had ≥2 raters → α undefined

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


def _cohens_kappa(units: list[list[int | None]]) -> float | None:
    """Cohen's unweighted κ for exactly 2 coders, over units both judged.
    Reproduces ``irr::kappa2``."""
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


# ── Option-B gather (mirrors consensus.py's roster-coder recipe) ───────────────


def gather_coder_applications(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
) -> tuple[
    list[int],
    dict[tuple, dict[int, set[int]]],
    dict[tuple, tuple],
    dict[tuple, set[int]],
    set[tuple],
]:
    """Option-B coder-application gather shared by IRR and reconciliation.

    Returns ``(coder_id_list, applied, unit_source, engaged, multi_sources)``:

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

    ``ukey`` is ``("seg", id)`` / ``("val", id)``; source keys ``("conv"|"doc", id)``
    / ``("col", id)`` — tag-prefixed, so segment and dataset-value ids never collide.
    """
    coder_q = db.query(User).filter(
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
        User.archived == False,  # noqa: E712
    )
    if coder_ids:
        coder_q = coder_q.filter(User.id.in_(coder_ids))
    coder_id_list = sorted(c.id for c in coder_q.all())
    if len(coder_id_list) < 2:
        return coder_id_list, {}, {}, {}, set()
    eff = build_effective_code_map(db, project_id)

    # applied[unit_key][coder_id] = set of effective codes that coder put on the unit
    applied: dict[tuple, dict[int, set[int]]] = defaultdict(lambda: defaultdict(set))
    unit_source: dict[tuple, tuple] = {}
    engaged: dict[tuple, set[int]] = defaultdict(set)  # source_key -> coders who worked it

    base_filters = [
        non_consensus_filter(),
        Code.is_universal == False,  # noqa: E712
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
        CodeApplication.user_id.in_(coder_id_list),
    ]

    # Segment applications (conversations + documents).
    seg_app_rows = (
        db.query(Segment.id, Segment.conversation_id, Segment.document_id,
                 CodeApplication.user_id, CodeApplication.code_id)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Document, Segment.document_id == Document.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            or_(Conversation.project_id == project_id, Document.project_id == project_id),
            *visible_segment_filter(),
            *base_filters,
        )
        .all()
    )
    for seg_id, conv_id, doc_id, uid, code_id in seg_app_rows:
        src = ("conv", conv_id) if conv_id is not None else ("doc", doc_id)
        ukey = ("seg", seg_id)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(eff, code_id))

    # Dataset-value applications (open-ended text coding).
    val_app_rows = (
        db.query(DatasetValue.id, DatasetValue.column_id,
                 CodeApplication.user_id, CodeApplication.code_id)
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(Dataset.project_id == project_id, *base_filters)
        .all()
    )
    for val_id, col_id, uid, code_id in val_app_rows:
        src = ("col", col_id)
        ukey = ("val", val_id)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(eff, code_id))

    # Sources engaged by ≥2 coders are the only ones that can contribute.
    multi_sources = {s for s, cs in engaged.items() if len(cs) >= 2}
    if not multi_sources:
        return coder_id_list, applied, unit_source, engaged, set()

    # Pull EVERY in-play unit of those sources (incl. units no coder coded → real
    # 0s under Option B). Segments: all visible. Dataset values: non-empty only
    # (a blank survey response is not a codeable unit — asymmetry is deliberate).
    conv_ids = [sid for (t, sid) in multi_sources if t == "conv"]
    doc_ids = [sid for (t, sid) in multi_sources if t == "doc"]
    col_ids = [sid for (t, sid) in multi_sources if t == "col"]
    if conv_ids or doc_ids:
        for seg_id, conv_id, doc_id in (
            db.query(Segment.id, Segment.conversation_id, Segment.document_id)
            .filter(
                *visible_segment_filter(),
                or_(Segment.conversation_id.in_(conv_ids), Segment.document_id.in_(doc_ids)),
            ).all()
        ):
            src = ("conv", conv_id) if conv_id is not None else ("doc", doc_id)
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

    return coder_id_list, applied, unit_source, engaged, multi_sources


def build_irr_matrices(
    db: Session, project_id: int, coder_ids: list[int] | None = None,
) -> tuple[list[int], dict[int, str], dict[int, list[list[int | None]]]]:
    """Return ``(coder_ids_ordered, {code_id: name}, {effective_code_id: units})``.

    ``units`` is the per-code matrix (one row per in-play unit; each row a list of
    length n_coders with 0/1/None). Source-level engagement (Option B) governs
    which cells are None. Built on the shared ``gather_coder_applications`` so IRR
    and reconciliation see identical coder/unit data; the per-code matrix shaping
    below is IRR-specific.
    """
    coder_id_list, applied, unit_source, engaged, multi_sources = gather_coder_applications(
        db, project_id, coder_ids
    )
    if len(coder_id_list) < 2 or not multi_sources:
        return coder_id_list, {}, {}
    n = len(coder_id_list)
    coder_idx = {cid: i for i, cid in enumerate(coder_id_list)}

    units = [u for u, src in unit_source.items() if src in multi_sources]
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
    return coder_id_list, code_names, per_code


def compute_irr(db: Session, project_id: int, coder_ids: list[int] | None = None) -> dict:
    """Compute per-code + overall IRR for a project. Returns a result dict; when
    fewer than 2 roster coders (or no shared coding) exist, ``available`` is False."""
    coder_id_list, code_names, per_code = build_irr_matrices(db, project_id, coder_ids)
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
            "reason": "Inter-rater reliability needs at least 2 coders with coding on a shared source.",
            "n_coders": n,
            "coders": coders,
            "per_code": [],
            "overall_alpha": None,
            "overall_alpha_interpretation": None,
            "interpretation_thresholds": thresholds,
        }

    per_code_results = []
    global_rows: list[list[int | None]] = []
    for code_id, rows in per_code.items():
        n_units = _n_comparable_units(rows)
        if n_units == 0:
            continue
        alpha = _krippendorff_alpha(rows)
        kappa = _cohens_kappa(rows) if n == 2 else None
        per_code_results.append({
            "code_id": code_id,
            "code_name": code_names.get(code_id, str(code_id)),
            "n_units": n_units,
            "percent_agreement": _percent_agreement(rows),
            "prevalence": _prevalence(rows),
            "cohens_kappa": kappa,
            "kappa_interpretation": _interpret_kappa(kappa),
            "krippendorff_alpha": alpha,
            "alpha_interpretation": _interpret_alpha(alpha),
        })
        global_rows.extend(rows)

    per_code_results.sort(key=lambda r: r["code_name"].lower())
    overall_alpha = _krippendorff_alpha(global_rows) if global_rows else None

    return {
        "available": True,
        "n_coders": n,
        "coders": coders,
        "metric_label": "kappa+alpha" if n == 2 else "alpha",
        "per_code": per_code_results,
        "overall_alpha": overall_alpha,
        "overall_alpha_interpretation": _interpret_alpha(overall_alpha),
        "interpretation_thresholds": thresholds,
    }
