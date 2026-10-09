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

from sqlalchemy import exists, func, insert, literal, select, union
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, aliased

from ..auth import reliability_coder_clause
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.consensus_stale_target import ConsensusStaleTarget
from ..models.dataset import DatasetValue
from ..models.segment import Segment
from ..models.user import User
from .coding_layers import consensus_eligible_segment_clause, non_consensus_filter
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


def mark_consensus_stale_for_coder(
    db: Session, coder_id: int, *, except_project_id: int | None = None,
) -> int:
    """Mark consensus stale wherever ONE coder's vote could move it, in every
    project — for the doors that archive or unarchive a coder (#1074).

    🔴 **An archived coder does not vote (DEC-F), so archiving or unarchiving one
    changes who votes on every passage they coded — and none of the four doors
    that do it marked anything.** The stored layer then read as current while the
    live reconciliation disagreed with it: a passage Carol and Alice both coded,
    with Carol brought back by an import, had no consensus row and no marker.

    **Which passages:** every target this coder holds a VOTING application on
    (non-consensus, non-universal, and the coder is a kind that votes — a machine
    never does, so its doors mark nothing) **on which someone else also has an
    application.** A passage only this coder touched can hold no consensus row
    with them or without them, so marking it would queue a recompute that writes
    nothing — and a coder's bulk import, which nobody else coded, would queue
    every row of it. The "someone else" test counts any other row, a consensus
    row included, because that row is exactly what may now be wrong.

    ⚠️ **Not gated on `consensus_enabled`, deliberately.** That gate is right
    where one voter makes consensus meaningless; an archive can CREATE that
    state, and the recompute is what deletes the rows it makes wrong.

    ⚠️ ``except_project_id`` is for a caller that rebuilds one project's layer
    anyway (the `.mmproject` merge) — a marker there would only make a freshly
    rebuilt layer read as stale until the sweep reaches it.

    The project a marker belongs to is the CODE's (`Code.project_id`); a target's
    applications all use its own project's codes. Set-based, like
    `mark_consensus_stale`: no id list crosses into Python. Returns the number of
    NEW markers. Runs in the caller's transaction and does not commit.
    """
    markers = ConsensusStaleTarget.__table__
    other = aliased(CodeApplication)
    inserted = 0
    for target_col, other_col, marker_col in (
        (CodeApplication.segment_id, other.segment_id, markers.c.segment_id),
        (CodeApplication.dataset_value_id, other.dataset_value_id, markers.c.dataset_value_id),
    ):
        rows = (
            select(func.min(Code.project_id), target_col)
            .join(Code, CodeApplication.code_id == Code.id)
            .join(User, CodeApplication.user_id == User.id)
            .where(
                CodeApplication.user_id == coder_id,
                target_col.isnot(None),
                non_consensus_filter(),
                Code.is_universal == False,  # noqa: E712
                reliability_coder_clause(),
                exists().where(other_col == target_col, other.user_id != coder_id),
                ~exists().where(marker_col == target_col),
            )
        )
        if target_col is CodeApplication.segment_id:
            # The same eligibility `mark_consensus_stale` applies — never re-inlined.
            rows = rows.join(Segment, CodeApplication.segment_id == Segment.id).where(
                consensus_eligible_segment_clause(),
            )
        if except_project_id is not None:
            rows = rows.where(Code.project_id != except_project_id)
        # GROUP BY the target: a coder holding three codes on one passage must
        # write ONE marker, or the partial unique index raises mid-statement.
        rows = rows.group_by(target_col)
        inserted += db.execute(
            insert(markers).from_select(["project_id", marker_col.name], rows)
        ).rowcount
    return inserted


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
    #: Markers whose recompute RAISED, in the order the next call should RETRY
    #: them. They stay queued; the caller passes this back as ``known_failed`` so
    #: the next batch does not trip over them again. A TUPLE, not a set, since
    #: #1039 (g): its order is the rotation — the ones retried least recently come
    #: first — and a set has none.
    failed_marker_ids: tuple[int, ...]


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
    3. markers in ``known_failed`` are retried one at a time — a code fix, or
       an edit to that passage, can clear them.

    🔴 **AT MOST ``limit`` KNOWN FAILURES ARE RETRIED PER CALL, IN ROTATION
    (#1039 g).** Every known failure used to be retried on every call, so a
    SYSTEMATIC failure — a defect that raises for a whole class of targets, as
    #1017's did — grew the work by up to ``limit`` attempts each tick, without
    bound: one tick's batch fails into the known set, and the next tick retries
    all of it plus a new batch. Now the first ``limit`` of ``known_failed`` are
    retried and the rest wait their turn; the result lists the waiting ones
    first, so every stuck marker is still retried, and a call costs at most one
    batch, its isolation, and ``limit`` retries.

    ⚠️ **`OperationalError` is NOT isolated** — it is SQLite's "database is
    locked" from the other writer, a property of the moment rather than of a
    target, so it rolls back and propagates exactly as before (both callers
    treat it as "try again next tick").
    ⚠️ **Savepoints were considered and not used**: nothing in the app uses
    them, the pysqlite driver needs a workaround for them, and the packaged
    build runs SQLCipher — a first use belongs in its own change.
    """
    # Order kept, repeats dropped: the order IS the rotation.
    known = tuple(dict.fromkeys(known_failed))
    skip = frozenset(known)
    retry_now, waiting = known[:limit], known[limit:]
    newly_failed: list[int] = []
    still_failing: list[int] = []
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

    if retry_now:
        n, still_failing = _one_at_a_time(db, retry_now, already_failing=skip)
        recomputed += n

    # Least recently attempted first: the ones that waited, then this call's.
    return DrainResult(
        recomputed=recomputed,
        failed_marker_ids=waiting + tuple(newly_failed) + tuple(still_failing),
    )


def _one_at_a_time(db: Session, marker_ids, *, already_failing: frozenset[int]) -> tuple[int, list[int]]:
    recomputed = 0
    failed: list[int] = []
    for mid in marker_ids:
        try:
            recomputed += sweep_stale_consensus(db, marker_ids=[mid])
            db.commit()
        except OperationalError:
            db.rollback()
            raise
        except Exception:  # noqa: BLE001 — the point is to survive it
            db.rollback()
            failed.append(mid)
            if mid not in already_failing:
                # Logged ONCE per marker, not every 30 s: the caller carries it
                # forward as known-failed and a repeat is not news.
                logger.warning(
                    "Consensus recompute failed for stale marker %d; it stays queued "
                    "and the rest of the queue continues", mid, exc_info=True,
                )
    return recomputed, failed
