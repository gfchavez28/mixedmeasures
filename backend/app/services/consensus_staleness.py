"""Write-side consensus staleness + the drain sweep (Track J · J2-3, Slab 5).

The role ``staleness.py`` plays for metrics, this plays for the derived consensus
layer. EVERY code-application mutation — single apply/remove included — calls
``mark_consensus_stale`` to record markers, and the background lifespan task
drains them off the request path through ``drain_stale_consensus``. Consensus is
NEVER recomputed on a read (the SQLite write-on-read lock hazard ADJ-3 rejected).

⚠️ **Corrected 2026-09-23 (#1017):** this said single apply/remove recompute
INLINE. None does — `routers/coding.py::_mark_segment_consensus_stale` marks, and
``recompute_consensus_for_target`` has no router caller; the sweep is its only
production caller.

``mark_consensus_stale`` and ``sweep_stale_consensus`` flush but do not commit —
the caller owns the transaction. ``drain_stale_consensus`` COMMITS, per attempt,
because that is what isolating one failing target requires.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import exists, insert, literal, select, union
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from ..models.code_application import CodeApplication
from ..models.consensus_stale_target import ConsensusStaleTarget
from ..models.dataset import DatasetValue
from ..models.segment import Segment
from .coding_layers import consensus_eligible_segment_clause
from .consensus import recompute_consensus_for_target
from .id_set import in_id_set

logger = logging.getLogger(__name__)


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


def _marker_query(db: Session, *, project_id, marker_ids, skip_ids):
    query = db.query(ConsensusStaleTarget)
    if project_id is not None:
        query = query.filter(ConsensusStaleTarget.project_id == project_id)
    if marker_ids is not None:
        query = query.filter(in_id_set(ConsensusStaleTarget.id, list(marker_ids)))
    if skip_ids:
        query = query.filter(~in_id_set(ConsensusStaleTarget.id, list(skip_ids)))
    return query.order_by(ConsensusStaleTarget.id)


def sweep_stale_consensus(
    db: Session,
    *,
    project_id: int | None = None,
    limit: int | None = None,
    marker_ids: Iterable[int] | None = None,
    skip_ids: Iterable[int] | None = None,
) -> int:
    """Drain consensus staleness markers, recomputing each target. Returns the
    number of targets recomputed.

    Optionally scope to one project and/or cap the batch (the background sweep
    caps per tick), or name the markers (``marker_ids``) or leave some out
    (``skip_ids``) — the two `drain_stale_consensus` needs to isolate a failure.
    Each marker is recomputed then deleted; a marker whose target was
    hard-deleted is gone already (FK CASCADE), so it is never seen.

    ⚠️ Flush-only and ALL-OR-NOTHING: one target that raises fails the whole
    batch. A caller that commits per batch should go through
    `drain_stale_consensus`, which is what keeps one bad target from blocking
    every other (#1017).
    """
    query = _marker_query(db, project_id=project_id, marker_ids=marker_ids, skip_ids=skip_ids)
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


@dataclass(frozen=True)
class DrainResult:
    """What one `drain_stale_consensus` call committed, and what it could not."""

    recomputed: int
    #: Markers whose recompute RAISED. They stay queued; the caller passes them
    #: back as ``known_failed`` so the next batch does not trip over them again.
    failed_marker_ids: frozenset[int]


def drain_stale_consensus(
    db: Session,
    *,
    limit: int,
    project_id: int | None = None,
    known_failed: Iterable[int] = (),
) -> DrainResult:
    """Drain one batch of markers and COMMIT — the only function in this module
    that commits, because isolating a failure needs a transaction per attempt.

    🔴 **ONE TARGET THAT RAISES MUST NOT BLOCK EVERY OTHER (#1017).** The batch
    is one transaction, and the markers are taken in id order ACROSS PROJECTS,
    so before this a single failing target was retried at the head of every
    batch and nothing behind it ever drained — measured: a healthy project's
    consensus never written after three sweeps. Now:

    1. the batch runs as before, leaving out markers already known to fail;
    2. if it raises, it is rolled back and re-run ONE MARKER PER TRANSACTION,
       so everything that can commit does, and the ones that raise are
       returned (and logged, once) in ``failed_marker_ids``;
    3. markers in ``known_failed`` are retried one at a time every call — a
       code fix, or an edit to that passage, can clear them.

    ⚠️ **`OperationalError` is NOT isolated** — it is SQLite's "database is
    locked" from the other writer, a property of the moment rather than of a
    target, so it rolls back and propagates exactly as before (both callers
    treat it as "try again next tick").
    ⚠️ **Savepoints were considered and not used**: nothing in the app uses
    them, the pysqlite driver needs a workaround for them, and the packaged
    build runs SQLCipher — a first use belongs in its own change.
    """
    skip = frozenset(known_failed)
    failed: set[int] = set()
    recomputed = 0

    try:
        recomputed = sweep_stale_consensus(db, project_id=project_id, limit=limit, skip_ids=skip)
        db.commit()
    except OperationalError:
        db.rollback()
        raise
    except Exception:  # noqa: BLE001 — isolated per marker below
        db.rollback()
        batch_ids = [
            mid for (mid,) in _marker_query(
                db, project_id=project_id, marker_ids=None, skip_ids=skip,
            ).with_entities(ConsensusStaleTarget.id).limit(limit).all()
        ]
        n, newly_failed = _one_at_a_time(db, batch_ids, already_failing=frozenset())
        recomputed += n
        failed |= newly_failed

    if skip:
        n, still_failing = _one_at_a_time(db, sorted(skip), already_failing=skip)
        recomputed += n
        failed |= still_failing

    return DrainResult(recomputed=recomputed, failed_marker_ids=frozenset(failed))


def _one_at_a_time(db: Session, marker_ids, *, already_failing: frozenset[int]) -> tuple[int, set[int]]:
    recomputed = 0
    failed: set[int] = set()
    for mid in marker_ids:
        try:
            recomputed += sweep_stale_consensus(db, marker_ids=[mid])
            db.commit()
        except OperationalError:
            db.rollback()
            raise
        except Exception:  # noqa: BLE001 — the point is to survive it
            db.rollback()
            failed.add(mid)
            if mid not in already_failing:
                # Logged ONCE per marker, not every 30 s: the caller carries it
                # forward as known-failed and a repeat is not news.
                logger.warning(
                    "Consensus recompute failed for stale marker %d; it stays queued "
                    "and the rest of the queue continues", mid, exc_info=True,
                )
    return recomputed, failed
