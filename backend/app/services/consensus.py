"""Materialize the derived consensus layer (Track J · J2-3, Slab 4).

The consensus layer is ordinary ``CodeApplication`` rows (``origin='consensus'``)
owned by the single global consensus coder (``get_or_create_consensus_user``). It
is auto-generated from the human/AI coder layers wherever they agree, so the
existing per-coder filters, counts, and exports treat it as just another coder
(D5). Nothing here ever touches a human coder's rows — it INSERT/DELETEs only the
consensus user's own layer (invariant J2-E).

**The rule (DEC-D · majority + flag).** Per target (a segment XOR a dataset
value): the *voters* are the roster coders (``coder_type NOT IN
SYSTEM_CODER_TYPES`` — human + AI, EXCLUDING the merged-legacy "Unattributed"
bucket, ADJ-2, AND EXCLUDING archived coders — DEC-F, so the stored layer's
voter roster matches ``consensus_enabled`` and the IRR gather) who applied ≥1
NON-universal code to that target. A target needs
≥2 voters — a solo-coded target has nothing to reconcile. Each code is resolved
to its *effective code* (the D3 equivalence-group seam) before counting, so
"Positive" and "POSITIVE" agree. For each effective code applied by ≥1 voter:

  - applied by ALL voters            → consensus row, no flag (rule="unanimous")
  - applied by a STRICT majority     → consensus row + flag (rule="majority")
  - tie / sub-majority               → no consensus row

The rule + counts are recorded in ``origin_context`` JSON so the reconciliation
UI can show "2 of 3 agreed" and surface the majority flag.

**Project scoping (ADJ-1, load-bearing).** The consensus coder is GLOBAL (one
row, no ``project_id`` on ``User``); its applications span every project. A
rebuild therefore DELETEs only consensus rows whose target belongs to THIS
project — never a bare ``user_id == consensus`` delete, which would wipe every
other project's consensus layer.

Flushes but does not commit — the caller owns the transaction (composes inside
the portability import and the future staleness sweep).
"""
from __future__ import annotations

import json

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..auth import SYSTEM_CODER_TYPES, get_or_create_consensus_user
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.document import Document
from ..models.segment import Segment
from ..models.user import User
from ..routers.helpers import visible_segment_filter
from .coding_layers import (
    CONSENSUS_ORIGIN,
    build_effective_code_map,
    non_consensus_filter,
    resolve_effective_code,
)


def consensus_enabled(db: Session) -> bool:
    """True when the roster has ≥2 selectable coders.

    Consensus can only form across multiple coders, so single-coder projects (the
    overwhelmingly common case) skip ALL consensus work — no marking, no
    recompute. Cheap: the users table is tiny.
    """
    return (
        db.query(User)
        .filter(
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            User.archived == False,  # noqa: E712
        )
        .count()
        >= 2
    )


def consensus_exists_for_project(db: Session, project_id: int) -> bool:
    """True if the project has any materialized consensus applications (Slab 7).

    Drives the frontend's "offer the consensus view only when it exists" (the
    selector itself is frontend — DEC-A). Project-scoped via the same target joins
    the materializer uses; short-circuits on the first hit.
    """
    seg_hit = (
        db.query(CodeApplication.id)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Document, Segment.document_id == Document.id)
        .filter(
            CodeApplication.origin == CONSENSUS_ORIGIN,
            or_(Conversation.project_id == project_id, Document.project_id == project_id),
        )
        .first()
    )
    if seg_hit is not None:
        return True
    val_hit = (
        db.query(CodeApplication.id)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            CodeApplication.origin == CONSENSUS_ORIGIN,
            Dataset.project_id == project_id,
        )
        .first()
    )
    return val_hit is not None


def _decide_consensus(per_coder: dict[int, set[int]]) -> list[tuple[int, str, int, int]]:
    """Apply the DEC-D rule to one target's per-coder effective-code sets.

    ``per_coder`` maps ``user_id`` → set of effective code ids that coder applied
    to the target. Returns ``(effective_code_id, rule, agree, voters)`` tuples for
    each code that reaches consensus, sorted by code id for deterministic output.
    Pure (no DB) — unit-testable and reused by the per-target staleness recompute
    (Slab 5).
    """
    n_voters = len(per_coder)
    if n_voters < 2:
        return []

    tally: dict[int, int] = {}
    for codes in per_coder.values():
        for eff in codes:
            tally[eff] = tally.get(eff, 0) + 1

    decisions: list[tuple[int, str, int, int]] = []
    for eff, agree in sorted(tally.items()):
        if agree == n_voters:
            decisions.append((eff, "unanimous", agree, n_voters))
        elif agree * 2 > n_voters:  # strict majority (ties excluded)
            decisions.append((eff, "majority", agree, n_voters))
    return decisions


def has_disagreement(per_engaged_coder: dict[int, set[int]]) -> bool:
    """True iff ≥2 SOURCE-engaged coders gave non-identical effective-code sets.

    The reconciliation flag — DELIBERATELY broader than "no consensus": a unit can
    have a majority consensus AND a dissenting minority (or a colleague who reviewed
    the source but left this unit blank). ``per_engaged_coder`` is the SOURCE-level
    projection — every coder engaged in the unit's source, with a blank set for one
    who left this unit uncoded (Option B explicit absence). This is a separate input
    from ``_decide_consensus``'s TARGET-level voters, so the two are NOT one shared
    tally. Pure (no DB); unit-tested.
    """
    if len(per_engaged_coder) < 2:
        return False
    return len({frozenset(s) for s in per_engaged_coder.values()}) > 1


def recompute_consensus_for_target(
    db: Session,
    project_id: int,
    *,
    segment_id: int | None = None,
    dataset_value_id: int | None = None,
) -> int:
    """Recompute the consensus layer for ONE target (write-side, synchronous).

    The cheap path: used inline by single apply/remove and by the staleness sweep
    (Slab 5). DELETE this target's consensus rows + re-derive from its voters via
    ``_decide_consensus``. A single target can't span projects, so ADJ-1's
    project-scoping is automatic; ``project_id`` is needed only for the
    effective-code map (equivalence resolution — a no-op query when the project
    has no groups). Returns the number of consensus rows written. Flush-only.
    """
    if (segment_id is None) == (dataset_value_id is None):
        raise ValueError("exactly one of segment_id / dataset_value_id is required")

    consensus_user = get_or_create_consensus_user(db)
    effective_map = build_effective_code_map(db, project_id)
    target_filter = (
        CodeApplication.segment_id == segment_id
        if segment_id is not None
        else CodeApplication.dataset_value_id == dataset_value_id
    )

    voters = (
        db.query(CodeApplication.user_id, CodeApplication.code_id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            target_filter,
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
        )
    )
    if segment_id is not None:
        # A soft-deleted (merged/split) segment is no longer codable — recomputing
        # it yields zero voters, which clears any stale consensus on it. This keeps
        # per-target recompute consistent with the project materializer (both
        # honor visibility) so the sweep tidies up consensus after segment ops.
        voters = voters.join(Segment, CodeApplication.segment_id == Segment.id).filter(
            *visible_segment_filter()
        )
    rows = voters.all()
    per_coder: dict[int, set[int]] = {}
    for user_id, code_id in rows:
        per_coder.setdefault(user_id, set()).add(resolve_effective_code(effective_map, code_id))

    db.query(CodeApplication).filter(
        CodeApplication.origin == CONSENSUS_ORIGIN,
        target_filter,
    ).delete(synchronize_session="fetch")
    db.flush()

    decisions = _decide_consensus(per_coder)
    for eff, rule, agree, voters in decisions:
        db.add(
            CodeApplication(
                code_id=eff,
                user_id=consensus_user.id,
                origin=CONSENSUS_ORIGIN,
                origin_context=json.dumps({"rule": rule, "agree": agree, "voters": voters}),
                segment_id=segment_id,
                dataset_value_id=dataset_value_id,
            )
        )
    db.flush()
    return len(decisions)


def materialize_consensus_for_project(db: Session, project_id: int) -> dict:
    """Rebuild the consensus layer for one project. Returns a summary dict.

    DELETE (project-scoped) + recompute. Idempotent: re-running yields the same
    consensus set. See module docstring for the rule and the project-scoping
    invariant. Flush-only; caller commits.
    """
    consensus_user = get_or_create_consensus_user(db)
    effective_map = build_effective_code_map(db, project_id)

    # Voter applications (roster coders only, non-universal codes, non-consensus,
    # visible segments) — bucketed per target → per coder → effective-code set.
    seg_rows = (
        db.query(CodeApplication.segment_id, CodeApplication.user_id, CodeApplication.code_id)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Document, Segment.document_id == Document.id)
        .filter(
            or_(Conversation.project_id == project_id, Document.project_id == project_id),
            *visible_segment_filter(),
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
        )
        .all()
    )
    val_rows = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.user_id, CodeApplication.code_id)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            Dataset.project_id == project_id,
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
        )
        .all()
    )

    seg_buckets: dict[int, dict[int, set[int]]] = {}
    for seg_id, user_id, code_id in seg_rows:
        eff = resolve_effective_code(effective_map, code_id)
        seg_buckets.setdefault(seg_id, {}).setdefault(user_id, set()).add(eff)
    val_buckets: dict[int, dict[int, set[int]]] = {}
    for val_id, user_id, code_id in val_rows:
        eff = resolve_effective_code(effective_map, code_id)
        val_buckets.setdefault(val_id, {}).setdefault(user_id, set()).add(eff)

    # Project-scoped DELETE of the prior consensus layer (ADJ-1).
    project_segment_ids = (
        db.query(Segment.id)
        .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Document, Segment.document_id == Document.id)
        .filter(or_(Conversation.project_id == project_id, Document.project_id == project_id))
    )
    project_value_ids = (
        db.query(DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(Dataset.project_id == project_id)
    )
    db.query(CodeApplication).filter(
        CodeApplication.origin == CONSENSUS_ORIGIN,
        or_(
            CodeApplication.segment_id.in_(project_segment_ids),
            CodeApplication.dataset_value_id.in_(project_value_ids),
        ),
    ).delete(synchronize_session="fetch")
    db.flush()

    created = unanimous = majority = 0

    def _emit(decisions, *, segment_id=None, dataset_value_id=None):
        nonlocal created, unanimous, majority
        for eff, rule, agree, voters in decisions:
            db.add(
                CodeApplication(
                    code_id=eff,
                    user_id=consensus_user.id,
                    origin=CONSENSUS_ORIGIN,
                    origin_context=json.dumps({"rule": rule, "agree": agree, "voters": voters}),
                    segment_id=segment_id,
                    dataset_value_id=dataset_value_id,
                )
            )
            created += 1
            if rule == "unanimous":
                unanimous += 1
            else:
                majority += 1

    for seg_id, per_coder in seg_buckets.items():
        _emit(_decide_consensus(per_coder), segment_id=seg_id)
    for val_id, per_coder in val_buckets.items():
        _emit(_decide_consensus(per_coder), dataset_value_id=val_id)

    db.flush()
    return {
        "consensus_user_id": consensus_user.id,
        "created": created,
        "unanimous": unanimous,
        "majority": majority,
        "targets": len(seg_buckets) + len(val_buckets),
    }
