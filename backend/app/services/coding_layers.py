"""Single policy point for scoping code-application aggregates to a coder layer.

Track J · J2 (invariant J2-B/J2-C). Per-coder layers (J2-1) plus a derived
"consensus" layer (J2-3) mean every all-coder aggregate must decide which
``CodeApplication`` rows to count. This module is the ONE place that decision
lives — the J2-B analog of #406's single-sourced label ordering. Route every
count / frequency / usage-count surface through here; never hand-roll an
``origin == ...`` filter at a call site.

**The consensus inflation seam (J2-B — the highest-risk J2 invariant).**
Consensus applications are real ``CodeApplication`` rows (``origin='consensus'``,
owned by the dedicated consensus coder) auto-generated from the human layers
wherever coders agree. The instant such rows exist, any all-coder aggregate that
does NOT exclude them DOUBLE-counts (a segment coded by two humans AND by the
derived consensus shows three times). So every human-layer aggregate excludes
``origin='consensus'`` by DEFAULT; consensus is counted only when it is the
explicitly-selected layer.

This guard is a **no-op until J2-3** creates the first consensus row (``origin``
is ``NOT NULL DEFAULT 'human'``, so every existing application is non-consensus),
but it must be in place across the count surfaces BEFORE consensus can exist —
landing it after would mean every surface silently inflates in the gap.

``non_consensus_filter()`` returns a clause, mirroring ``visible_segment_filter()``
so it splats into an existing ``.filter(...)``; it keeps every real coder layer
(human AND ai-as-coder) and drops only the derived consensus layer.
"""
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.code_equivalence_group import CodeEquivalenceGroup
from ..models.segment import Segment

# Provenance value marking the derived consensus layer (see CodeApplication.origin).
CONSENSUS_ORIGIN = "consensus"

# Layer-selection values (Track J · J2-3, Slab 7 — the J2-C single policy point).
# Only two are needed at the FILTER level: the all-human default vs the derived
# consensus layer. Per-coder ("show just Alice") and union ("everyone combined")
# selection ride on the existing J1 `coder_ids`, not on this axis.
LAYER_HUMAN = "human"
LAYER_CONSENSUS = "consensus"
VALID_LAYER_SCOPES = (LAYER_HUMAN, LAYER_CONSENSUS)


def build_effective_code_map(db: Session, project_id: int) -> dict[int, int]:
    """code_id → effective_code_id for one project (Track J · J2-D, the D3 seam).

    The SINGLE place agreement, consensus materialization, and IRR read the
    "effective code": v1 is identity for ungrouped codes; for a grouped code it
    is the group's canonical code — `canonical_code_id` when that is still a live
    member, else the lowest member `code_id` (deterministic, robust to a stale
    canonical). Build ONCE per analysis pass; look up O(1) via
    `resolve_effective_code` (a per-row DB hit would N+1). Codes not in the map
    resolve to themselves, so callers never special-case ungrouped codes.
    """
    rows = (
        db.query(Code.id, Code.code_equivalence_group_id)
        .filter(
            Code.project_id == project_id,
            Code.code_equivalence_group_id.isnot(None),
        )
        .all()
    )
    if not rows:
        return {}

    members: dict[int, list[int]] = {}
    for code_id, gid in rows:
        members.setdefault(gid, []).append(code_id)

    canonical_by_group = dict(
        db.query(CodeEquivalenceGroup.id, CodeEquivalenceGroup.canonical_code_id)
        .filter(CodeEquivalenceGroup.id.in_(members.keys()))
        .all()
    )

    effective: dict[int, int] = {}
    for gid, member_ids in members.items():
        canonical = canonical_by_group.get(gid)
        if canonical not in set(member_ids):  # null or stale → lowest member id
            canonical = min(member_ids)
        for code_id in member_ids:
            effective[code_id] = canonical
    return effective


def resolve_effective_code(effective_map: dict[int, int], code_id: int) -> int:
    """O(1) effective-code lookup against a prebuilt map; identity by default."""
    return effective_map.get(code_id, code_id)


def code_usage_count_expr():
    """A code's usage count = distinct TARGETS it is applied to, not raw rows.

    Track J · J2: under per-coder layers (J2-1) two coders applying one code to
    one segment/value are two `CodeApplication` rows, so a raw `COUNT(*)` would
    multiply by the number of coders. A `CodeApplication` targets exactly one of
    `segment_id` / `dataset_value_id`, so the sum of the two distinct-counts is
    the true number of coded targets (DISTINCT skips NULLs). Single-coder data is
    unchanged (one row per (target, code) → sum == COUNT). Returns a fresh
    expression per call so it composes in any query. The single source for every
    "N uses" surface (codes list, codebook exports). Pair with
    `non_consensus_filter()` in the query to keep consensus out of the count.
    """
    return (
        func.count(func.distinct(CodeApplication.segment_id))
        + func.count(func.distinct(CodeApplication.dataset_value_id))
    )


def visible_target_filter():
    """Clause: keep applications whose TARGET is visible (#500).

    Dataset-value targets always pass; segment targets pass only when the
    segment is not merged/split-away (`visible_segment_filter()` semantics).
    A hidden original's codings are unreachable anywhere in the UI, so they
    must not count toward "N uses" — pre-#500 the deactivate dialog warned
    about applications the coder could never find.

    REQUIRES the query to ``outerjoin(Segment, CodeApplication.segment_id ==
    Segment.id)`` — the NULL-safe first arm keeps dataset-value applications
    (whose joined Segment row is all-NULL) from being dropped.
    """
    return CodeApplication.segment_id.is_(None) | (
        Segment.merged_into_id.is_(None) & Segment.split_into_id.is_(None)
    )


def non_consensus_filter():
    """Clause: keep only non-consensus applications (the J2-B default guard).

    AND/splat into any ``CodeApplication`` aggregate's ``.filter(...)`` so the
    derived consensus layer never inflates an all-coder count. Keeps real coder
    layers (human + ai); drops only ``origin='consensus'``. No-op until J2-3.
    """
    return CodeApplication.origin != CONSENSUS_ORIGIN


def layer_origin_filter(layer_scope: str | None = None):
    """Origin clause for a ``layer_scope`` (Track J · J2-3 Slab 7 — the J2-C policy
    point). ``'consensus'`` → ONLY the derived consensus layer; anything else (the
    ``'human'`` default, or ``None``) → exclude consensus (every real coder layer,
    the J2-B guard). Per-coder / union selection rides on the existing ``coder_ids``,
    not on this clause — so the only genuinely new view this enables is consensus.

    Single-source this everywhere a count/frequency/usage surface needs to honor
    the selected layer; pair with a ``coder_ids`` restriction for the human case.
    """
    if layer_scope == LAYER_CONSENSUS:
        return CodeApplication.origin == CONSENSUS_ORIGIN
    return non_consensus_filter()
