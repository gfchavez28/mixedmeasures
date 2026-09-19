"""Write-side consensus staleness + the drain sweep (Track J · J2-3, Slab 5).

The role ``staleness.py`` plays for metrics, this plays for the derived consensus
layer — but the trigger model differs by cost (DEC-C / ADJ-3):

  - Cheap single-target apply/remove recompute consensus INLINE
    (``recompute_consensus_for_target``) so it is fresh immediately.
  - Bulk / cascade mutations (segment merge/split/unmerge, code merge,
    equivalence-group edits) call ``mark_consensus_stale`` to record markers and
    let ``sweep_stale_consensus`` (a background lifespan task) drain them off the
    hot path. Consensus is NEVER recomputed on a read (the SQLite write-on-read
    lock hazard ADJ-3 rejected).

Both functions flush but do not commit — the caller owns the transaction.
"""
from __future__ import annotations

from sqlalchemy import exists, insert, literal, select, union
from sqlalchemy.orm import Session

from ..models.code_application import CodeApplication
from ..models.consensus_stale_target import ConsensusStaleTarget
from ..models.dataset import DatasetValue
from ..models.segment import Segment
from .coding_layers import consensus_eligible_segment_clause
from .consensus import recompute_consensus_for_target
from .id_set import in_id_set


def mark_consensus_stale(
    db: Session,
    project_id: int,
    *,
    segment_ids: list[int] | None = None,
    dataset_value_ids: list[int] | None = None,
    code_ids: list[int] | None = None,
) -> int:
    """Record consensus-recompute markers for the affected targets.

    Pass explicit ``segment_ids`` / ``dataset_value_ids`` and/or ``code_ids``
    whose every application's target should be marked (the merge_codes /
    equivalence-group cascade). Marking is idempotent — already-marked targets are
    skipped (the partial unique index would otherwise raise). Returns the number
    of NEW markers inserted.

    🔴 **SET-BASED, and #956 is why.** The ``code_ids`` cascade reaches EVERY
    target of those codes — merging two common codes on the BES corpus is
    368,717 of them. This used to gather the targets into Python sets, hand
    them to ``.in_()`` twice (SQLite refuses a statement past 250,000 bound
    parameters, so ``merge_codes`` raised before reassigning anything) and add
    one ORM marker per target. With the ceiling lifted, that last loop was
    27.3 s and 1,139 MB inside an ``async def`` endpoint. Each target set is now
    ONE ``INSERT … SELECT`` that the database resolves itself: no id list, no
    ORM instances, and the dedup against existing markers is a ``NOT EXISTS``.

    ⚠️ Direct ids arrive through ``in_id_set`` too. They are bounded by their
    callers today (the bulk text-coding bodies cap at 5,000), but that bound
    lives in a schema this function cannot see.
    """
    inserted = 0

    segment_sources = []
    value_sources = []
    if segment_ids:
        segment_sources.append(select(Segment.id.label("target")).where(in_id_set(Segment.id, segment_ids)))
    if dataset_value_ids:
        value_sources.append(
            select(DatasetValue.id.label("target")).where(in_id_set(DatasetValue.id, dataset_value_ids))
        )
    if code_ids:
        codes = list(code_ids)
        segment_sources.append(
            select(CodeApplication.segment_id.label("target"))
            .where(CodeApplication.code_id.in_(codes), CodeApplication.segment_id.isnot(None))
        )
        # An application has EXACTLY one target (`ck_code_application_exactly_one_target`),
        # so the two sources partition the applications with no further clause.
        value_sources.append(
            select(CodeApplication.dataset_value_id.label("target"))
            .where(CodeApplication.code_id.in_(codes), CodeApplication.dataset_value_id.isnot(None))
        )

    markers = ConsensusStaleTarget.__table__

    if segment_sources:
        targets = _union(segment_sources)
        # Observations track (D18 — supersedes D2's blanket exclusion): never
        # enqueue a consensus recompute for a clip whose Observation is UNFROZEN.
        # There, each coder marks their OWN time ranges, so a clip has one voter
        # and voting is meaningless (unitizing-alpha is the reliability statistic
        # instead). A FROZEN observation's clips ARE consensus-eligible — the team
        # agreed the cuts, so every coder codes the same clips, exactly like
        # transcript turns. Eligibility is the SHARED definition — never
        # re-inlined — so this can't drift from the recompute gate or the
        # rebuild's scope. It applies to BOTH the direct ids and the cascade.
        rows = select(literal(project_id), Segment.id).where(
            Segment.id.in_(select(targets.c.target)),
            consensus_eligible_segment_clause(),
            ~exists().where(markers.c.segment_id == Segment.id),
        )
        inserted += db.execute(insert(markers).from_select(["project_id", "segment_id"], rows)).rowcount

    if value_sources:
        targets = _union(value_sources)
        rows = select(literal(project_id), DatasetValue.id).where(
            DatasetValue.id.in_(select(targets.c.target)),
            ~exists().where(markers.c.dataset_value_id == DatasetValue.id),
        )
        inserted += db.execute(insert(markers).from_select(["project_id", "dataset_value_id"], rows)).rowcount

    return inserted


def _union(sources):
    """The distinct targets of one or more single-column selects, as a subquery."""
    return (sources[0] if len(sources) == 1 else union(*sources)).subquery()


def sweep_stale_consensus(
    db: Session,
    *,
    project_id: int | None = None,
    limit: int | None = None,
) -> int:
    """Drain consensus staleness markers, recomputing each target. Returns the
    number of targets recomputed.

    Optionally scope to one project and/or cap the batch (the background sweep
    caps per tick). Each marker is recomputed then deleted; a marker whose target
    was hard-deleted is gone already (FK CASCADE), so it is never seen.
    """
    query = db.query(ConsensusStaleTarget)
    if project_id is not None:
        query = query.filter(ConsensusStaleTarget.project_id == project_id)
    query = query.order_by(ConsensusStaleTarget.id)
    if limit is not None:
        query = query.limit(limit)

    markers = query.all()
    for marker in markers:
        recompute_consensus_for_target(
            db,
            marker.project_id,
            segment_id=marker.segment_id,
            dataset_value_id=marker.dataset_value_id,
        )
        db.delete(marker)
    if markers:
        db.flush()
    return len(markers)
