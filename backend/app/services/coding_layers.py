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
from sqlalchemy import func, or_, select
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


# ── Consensus eligibility (D18: unit provenance, not parent type) ───────────


def consensus_eligible_segment_clause():
    """Which segments can carry a consensus layer — usable on ANY Segment-joined
    query, no extra join required.

    Eligibility is decided by **unit provenance**, NOT by parent type (D18 —
    supersedes D2, which excluded every Observation outright):

      * conversation + document segments — the MATERIAL dictates the units
        (turns, paragraphs), so every coder codes the same ones.
      * FROZEN observation clips — the TEAM agreed the units before coding, so
        again every coder codes the same ones. CONSENSUS works here unchanged:
        `_decide_consensus` is per-target and does not care whether a target is
        a transcript turn or a slice of video.
        NOTE (slab 6b-B, not yet built): reconciliation and ordinary kappa do
        NOT reach a frozen clip yet. `irr.py`'s gather still scopes to
        `or_(Conversation, Document)` with `("conv"|"doc")` source keys, and
        `reconciliation.py` consumes that same gather — so a clip is dropped
        before either sees it. The ENGINES are parent-indifferent; only their
        gather is not. Widening it is the work, and the source-key ternary must
        be fixed in the same change or a clip silently becomes `("doc", None)`.
      * UNFROZEN observation clips — each coder marks their OWN time ranges, so a
        clip has exactly one voter and `_decide_consensus` returns nothing anyway
        (`n_voters < 2`). Excluded explicitly: the reliability question there is
        "did we agree on the BOUNDARIES", which is unitizing-alpha's job, not a
        per-target majority vote's.

    Frozen-ness is read live rather than denormalized onto Segment, so freezing an
    observation cannot leave its clips carrying a stale eligibility flag.
    """
    from ..models.observation import Observation  # local: avoids an import cycle

    return or_(
        Segment.observation_id.is_(None),
        Segment.observation_id.in_(
            select(Observation.id).where(Observation.segmentation_frozen_at.isnot(None))
        ),
    )


def _join_all_segment_parents(query):
    """Outerjoin Segment's three parents. Every scope below builds on this."""
    from ..models.conversation import Conversation
    from ..models.document import Document
    from ..models.observation import Observation

    return (
        query
        .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Document, Segment.document_id == Document.id)
        .outerjoin(Observation, Segment.observation_id == Observation.id)
    )


def project_scoped_segments(query, project_id: int):
    """ALL of `project_id`'s segments, whatever their parent — the CLEANER's scope.

    ⚠️ This is deliberately BROADER than `consensus_scoped_segments`, and the
    asymmetry is load-bearing:

        the cleaner must see EVERYTHING the writer can ever have written.

    Consensus eligibility can be REVOKED (unfreezing an observation re-opens its
    clips). If the rebuild's DELETE were scoped to eligible-only segments, then the
    moment a team unfroze, the rebuild would stop producing that clip's consensus
    row AND lose the ability to SEE the existing one — stranding it forever as an
    invisible orphan no rebuild could ever reclaim. That is exactly the trap that
    made D2 exclude observations wholesale; it is closed by scoping the WRITER
    narrowly and the CLEANER widely, not by refusing to write at all.
    """
    from ..models.conversation import Conversation
    from ..models.document import Document
    from ..models.observation import Observation

    return _join_all_segment_parents(query).filter(
        or_(
            Conversation.project_id == project_id,
            Document.project_id == project_id,
            Observation.project_id == project_id,
        )
    )


def consensus_scoped_segments(query, project_id: int):
    """`project_id`'s CONSENSUS-ELIGIBLE segments — the WRITER's scope.

    Eligible = conversation/document segments (the material dictates the units) +
    FROZEN observation clips (the team agreed the units). See
    `consensus_eligible_segment_clause` for the reasoning.

    Pair with `project_scoped_segments` for any DELETE/cleanup — never scope a
    cleaner by this, or a revoked eligibility strands rows (see that docstring).

    Composed as project-scope AND the eligibility clause, deliberately: the rule
    for "which segments can carry consensus" then lives in exactly ONE place
    (`consensus_eligible_segment_clause`), so the per-target write gate, the
    staleness marker, and this gather can never drift apart.
    """
    return project_scoped_segments(query, project_id).filter(
        consensus_eligible_segment_clause()
    )
