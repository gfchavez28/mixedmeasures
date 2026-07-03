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

from sqlalchemy.orm import Session

from ..models.code_application import CodeApplication
from ..models.consensus_stale_target import ConsensusStaleTarget
from .consensus import recompute_consensus_for_target


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
    """
    seg_ids: set[int] = set(segment_ids or [])
    val_ids: set[int] = set(dataset_value_ids or [])

    if code_ids:
        rows = (
            db.query(CodeApplication.segment_id, CodeApplication.dataset_value_id)
            .filter(CodeApplication.code_id.in_(list(code_ids)))
            .distinct()
            .all()
        )
        for seg, val in rows:
            if seg is not None:
                seg_ids.add(seg)
            elif val is not None:
                val_ids.add(val)

    if not seg_ids and not val_ids:
        return 0

    if seg_ids:
        already = {
            r[0]
            for r in db.query(ConsensusStaleTarget.segment_id)
            .filter(ConsensusStaleTarget.segment_id.in_(list(seg_ids)))
            .all()
        }
        seg_ids -= already
    if val_ids:
        already = {
            r[0]
            for r in db.query(ConsensusStaleTarget.dataset_value_id)
            .filter(ConsensusStaleTarget.dataset_value_id.in_(list(val_ids)))
            .all()
        }
        val_ids -= already

    inserted = 0
    for seg in seg_ids:
        db.add(ConsensusStaleTarget(project_id=project_id, segment_id=seg))
        inserted += 1
    for val in val_ids:
        db.add(ConsensusStaleTarget(project_id=project_id, dataset_value_id=val))
        inserted += 1
    if inserted:
        db.flush()
    return inserted


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
