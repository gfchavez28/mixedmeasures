from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.segment import Segment
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.observation import Observation
from ..schemas.coding import (
    ApplyCodeRequest,
    BulkCodeRequest,
    CodeApplicationResponse,
    BulkCodeResponse,
    CodingProgressResponse,
    MagnitudeValueUpdate,
)
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.coding_counts import (
    coded_segment_count,
    participant_segment_count,
)
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale
from ..services.coding_layers import project_scoped_segments
from ..services import magnitude
from .helpers import _get_project_or_404, _verify_segment_ownership, _verify_conversation_ownership

router = APIRouter(prefix="/api", tags=["coding"])


def _get_segment_project_id(db: Session, segment: Segment) -> int | None:
    """Get project_id for a segment via its parent (conversation, document, or
    observation).

    A missing parent arm here does NOT fail open — it returns None, and the callers
    turn that into a 400 "same project" refusal. But it is a helper that LIES about
    a perfectly valid segment, and it was masking the (now-fixed) fail-open in
    `_verify_segment_ownership`. Every Segment parent gets an arm.
    """
    if segment.conversation_id:
        conv = db.query(Conversation).filter(Conversation.id == segment.conversation_id).first()
        return conv.project_id if conv else None
    elif segment.document_id:
        doc = db.query(Document).filter(Document.id == segment.document_id).first()
        return doc.project_id if doc else None
    elif segment.observation_id:
        obs = db.query(Observation).filter(Observation.id == segment.observation_id).first()
        return obs.project_id if obs else None
    return None


def _mark_segment_consensus_stale(db: Session, project_id: int, segment: Segment) -> None:
    """Mark this segment (and its visible group siblings) for consensus recompute.

    A coded segment's consensus depends on every coder's layer, so an apply/remove
    by ANY coder invalidates it. Grouped coding fans out to the group's visible
    siblings, so they invalidate too. Gated on multi-coder (no-op for single-coder
    projects) and drained by the background sweep (Track J · J2-3, Slab 5b).
    """
    if not consensus_enabled(db):
        return
    ids = [segment.id]
    if segment.group_id:
        ids = [
            r[0] for r in db.query(Segment.id).filter(
                Segment.group_id == segment.group_id,
                Segment.merged_into_id == None,  # noqa: E711
                Segment.split_into_id == None,  # noqa: E711
            ).all()
        ]
        if segment.id not in ids:
            ids.append(segment.id)
    mark_consensus_stale(db, project_id, segment_ids=ids)


def _fan_out_rating(
    db: Session, segment: Segment, code_id: int, user_id: int, rating: float | None,
) -> None:
    """Write THIS coder's rating (and clear the merge flag) across a segment group.

    A group is coded as ONE unit — that is what it is for — so it is rated as one
    unit; rating its members differently would be a distinction the interface
    never offered. ⚠️ #869 (f): there are THREE doors that write a rating
    (`set_code_magnitude`, `apply_code`'s first apply, `apply_code`'s re-rate on
    an existing row) and two of them fanned out while the third updated one
    row. The rule lives HERE so a fourth door cannot forget it. No-op outside a
    group. Scoped to this coder's rows and to VISIBLE members, exactly like the
    apply path's sibling loop.
    """
    if not segment.group_id:
        return
    db.query(CodeApplication).filter(
        CodeApplication.code_id == code_id,
        CodeApplication.user_id == user_id,
        CodeApplication.segment_id.in_(
            db.query(Segment.id).filter(
                Segment.group_id == segment.group_id,
                Segment.merged_into_id == None,  # noqa: E711
                Segment.split_into_id == None,  # noqa: E711
            )
        ),
    ).update({"magnitude": rating, "magnitude_conflict": None}, synchronize_session=False)


@router.post("/segments/{segment_id}/codes/{code_id}", response_model=CodeApplicationResponse)
async def apply_code(
    segment_id: int,
    code_id: int,
    data: ApplyCodeRequest = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Apply a code to a segment. Target: <50ms response time."""
    # Verify ownership and that segment exists
    segment = _verify_segment_ownership(db, segment_id, user.id)

    code = db.query(Code).filter(Code.id == code_id).first()
    if not code:
        raise HTTPException(status_code=404, detail="Code not found")

    if not code.is_active:
        raise HTTPException(status_code=400, detail="Code is inactive")

    # Verify segment and code belong to the same project
    project_id = _get_segment_project_id(db, segment)
    if not project_id or project_id != code.project_id:
        raise HTTPException(status_code=400, detail="Segment and code must belong to the same project")

    # Check if already applied by THIS coder (per-coder layer; #J2-1b).
    # Scoped to user.id so a second coder applying the same code creates their
    # own layer row instead of silently no-op'ing on the first coder's row.
    existing = db.query(CodeApplication).filter(
        CodeApplication.segment_id == segment_id,
        CodeApplication.code_id == code_id,
        CodeApplication.user_id == user.id
    ).first()

    # #35 — a rating supplied here is validated against the code's declared scale
    # BEFORE anything is written, so a bad value cannot half-apply a code. Omitted
    # and explicit-null are different instructions (see `ApplyCodeRequest`).
    rating_supplied = bool(data and "magnitude" in data.model_fields_set)
    rating = None
    if rating_supplied:
        try:
            rating = magnitude.validate_value(code, data.magnitude)
        except magnitude.MagnitudeError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    if existing:
        # Already applied by this coder. Re-applying is a no-op EXCEPT for a
        # rating: variant A's flow can arrive here when a coder re-rates, and
        # silently discarding the value would make the strip appear to save.
        # ⚠️ #869 (f): the group fan-out runs here too — this was the one rating
        # door that updated a single row. It runs whenever the segment is grouped,
        # not only when THIS row changed, because a sibling may carry a stale
        # value or a merge flag this row does not.
        if rating_supplied and (
            existing.magnitude != rating
            or existing.magnitude_conflict is not None
            or segment.group_id
        ):
            existing.magnitude = rating
            # #35 — rating it again IS the adjudication of a merge conflict.
            existing.magnitude_conflict = None
            _fan_out_rating(db, segment, code_id, user.id, rating)
            _mark_segment_consensus_stale(db, project_id, segment)
            db.commit()
        return CodeApplicationResponse(
            segment_id=segment_id,
            code_id=code_id,
            applied=True,
            created_at=existing.created_at,
            magnitude=existing.magnitude,
        )

    # Apply code
    application = CodeApplication(
        segment_id=segment_id,
        code_id=code_id,
        user_id=user.id,
        attribution=data.attribution if data else None,
        magnitude=rating,
    )
    db.add(application)

    # If segment is in a group, apply to all visible segments in group
    if segment.group_id:
        group_segments = db.query(Segment).filter(
            Segment.group_id == segment.group_id,
            Segment.id != segment_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        ).all()

        for group_seg in group_segments:
            existing_group = db.query(CodeApplication).filter(
                CodeApplication.segment_id == group_seg.id,
                CodeApplication.code_id == code_id,
                CodeApplication.user_id == user.id
            ).first()

            if not existing_group:
                # #35 — the rating fans out with the code. A segment group is
                # coded as ONE unit (that is what the group is for), so rating
                # the group's segments differently would be a distinction the UI
                # never offered the coder a way to make.
                group_app = CodeApplication(
                    segment_id=group_seg.id,
                    code_id=code_id,
                    user_id=user.id,
                    attribution=data.attribution if data else None,
                    magnitude=rating,
                )
                db.add(group_app)

    # Flush to get the application.id without committing
    db.flush()

    # A sibling that was ALREADY coded (before it joined the group, or by an
    # earlier apply) was skipped above and still carries its old rating; the
    # group is rated as one unit, so a rating given now reaches it too (#869 f).
    if rating_supplied:
        _fan_out_rating(db, segment, code_id, user.id, rating)

    log_action(
        db,
        action="code_applied",
        entity_type="code_application",
        entity_id=application.id,
        user_id=user.id,
        project_id=project_id,
        details={"segment_id": segment_id, "code_id": code_id}
    )
    _mark_segment_consensus_stale(db, project_id, segment)
    db.commit()

    return CodeApplicationResponse(
        segment_id=segment_id,
        code_id=code_id,
        applied=True,
        created_at=application.created_at,
        magnitude=application.magnitude,
    )


@router.patch("/segments/{segment_id}/codes/{code_id}/magnitude", response_model=CodeApplicationResponse)
def set_code_magnitude(
    segment_id: int,
    code_id: int,
    data: MagnitudeValueUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set or clear THIS coder's rating on an already-applied code (#35).

    Separate from `apply_code` on purpose. That endpoint returns early when the
    application already exists, so it is structurally unable to edit one — and
    "edit the rating afterwards" is a requirement, not a nicety: it is the only
    way to correct a mis-keyed value, and the one affordance Dedoose's own
    interface provides (weights are editable in its Selection Info panel).

    ⚠️ Rates the CALLER's application only, never a colleague's — the per-coder
    layer rule. A rating is that coder's judgement; overwriting someone else's
    would fabricate agreement, which is the one thing a reliability statistic
    must never be handed.

    ⚠️ `magnitude: null` UNRATES. It does not write 0.
    """
    segment = _verify_segment_ownership(db, segment_id, user.id)

    code = db.query(Code).filter(Code.id == code_id).first()
    if not code:
        raise HTTPException(status_code=404, detail="Code not found")

    project_id = _get_segment_project_id(db, segment)
    if not project_id or project_id != code.project_id:
        raise HTTPException(status_code=400, detail="Segment and code must belong to the same project")

    application = db.query(CodeApplication).filter(
        CodeApplication.segment_id == segment_id,
        CodeApplication.code_id == code_id,
        CodeApplication.user_id == user.id,
    ).first()
    if not application:
        raise HTTPException(
            status_code=404,
            detail="You have not applied this code to this segment, so there is nothing to rate.",
        )

    try:
        rating = magnitude.validate_value(code, data.magnitude)
    except magnitude.MagnitudeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    application.magnitude = rating
    # #35 — re-rating (or unrating) IS the adjudication of a merge conflict: the
    # coder has looked at this application and decided. The flag goes with it.
    application.magnitude_conflict = None

    # A group is coded as one unit, so it is rated as one unit — the same rule the
    # apply path follows, through the same helper (#869 f).
    _fan_out_rating(db, segment, code_id, user.id, rating)

    log_action(
        db,
        action="code_magnitude_set" if rating is not None else "code_magnitude_cleared",
        entity_type="code_application",
        entity_id=application.id,
        user_id=user.id,
        project_id=project_id,
        details={"segment_id": segment_id, "code_id": code_id, "magnitude": rating},
    )
    # A rating change moves what a consensus over this target would say, so it
    # staleizes exactly like an apply/remove does (the every-mutation-site rule).
    _mark_segment_consensus_stale(db, project_id, segment)
    db.commit()

    return CodeApplicationResponse(
        segment_id=segment_id,
        code_id=code_id,
        applied=True,
        created_at=application.created_at,
        magnitude=rating,
    )


@router.delete("/segments/{segment_id}/codes/{code_id}", response_model=CodeApplicationResponse)
async def remove_code(
    segment_id: int,
    code_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Remove a code from a segment."""
    segment = _verify_segment_ownership(db, segment_id, user.id)

    # Verify segment and code belong to the same project
    code = db.query(Code).filter(Code.id == code_id).first()
    if not code:
        raise HTTPException(status_code=404, detail="Code not found")
    project_id = _get_segment_project_id(db, segment)
    if not project_id or project_id != code.project_id:
        raise HTTPException(status_code=400, detail="Segment and code must belong to the same project")

    # Find and delete THIS coder's application only (per-coder layer; #J2-1b).
    application = db.query(CodeApplication).filter(
        CodeApplication.segment_id == segment_id,
        CodeApplication.code_id == code_id,
        CodeApplication.user_id == user.id
    ).first()

    if not application:
        return CodeApplicationResponse(
            segment_id=segment_id,
            code_id=code_id,
            applied=False
        )

    # If segment is in a group, remove from all visible segments in group.
    # Scoped to user.id so removing a grouped code deletes only THIS coder's
    # applications across the group — never another coder's (#J2-1b nuke site).
    if segment.group_id:
        db.query(CodeApplication).filter(
            CodeApplication.segment_id.in_(
                db.query(Segment.id).filter(
                    Segment.group_id == segment.group_id,
                    Segment.merged_into_id == None,
                    Segment.split_into_id == None,
                )
            ),
            CodeApplication.code_id == code_id,
            CodeApplication.user_id == user.id
        ).delete(synchronize_session=False)
    else:
        db.delete(application)

    log_action(
        db,
        action="code_removed",
        entity_type="code_application",
        user_id=user.id,
        project_id=project_id,
        details={"segment_id": segment_id, "code_id": code_id}
    )

    _mark_segment_consensus_stale(db, project_id, segment)
    db.commit()

    return CodeApplicationResponse(
        segment_id=segment_id,
        code_id=code_id,
        applied=False
    )


@router.post("/segments/bulk-code", response_model=BulkCodeResponse)
async def bulk_code(
    data: BulkCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Apply or remove a code from multiple segments."""
    code = db.query(Code).filter(Code.id == data.code_id).first()
    if not code:
        raise HTTPException(status_code=404, detail="Code not found")

    # Verify user owns the project this code belongs to
    _get_project_or_404(db, code.project_id, user.id)

    if data.action == "apply" and not code.is_active:
        raise HTTPException(status_code=400, detail="Code is inactive")

    # Batch fetch all segments in one query, verify same project as code.
    # project_scoped_segments spans all THREE parents (conversation/document/
    # observation) — the old two-parent outerjoin silently dropped clips from the
    # map, so every multi-clip chord commit came back applied=False inside a 200
    # (D23; the first thing the coding surface does on a clip selection).
    # De-duplicate while preserving order. A repeated id would otherwise be
    # processed twice, and the second pass still sees the stale `existing_set`
    # (it is not updated in the loop) — so it adds a SECOND CodeApplication for
    # the same (segment, code, coder), which the per-coder unique index rejects
    # with an IntegrityError at commit. That is a 500 on a request the client
    # believes is ordinary, so dedup here rather than trusting every caller.
    requested_ids = list(dict.fromkeys(data.segment_ids))

    segments = project_scoped_segments(
        db.query(Segment), code.project_id
    ).filter(Segment.id.in_(requested_ids)).all()
    segment_map = {s.id: s for s in segments}

    # Batch check existing code applications by THIS coder (per-coder dedup;
    # #J2-1b — "have *I* applied this?", not "has anyone?").
    existing_apps = db.query(CodeApplication).filter(
        CodeApplication.segment_id.in_(requested_ids),
        CodeApplication.code_id == data.code_id,
        CodeApplication.user_id == user.id
    ).all()
    existing_set = {ca.segment_id for ca in existing_apps}

    results = []
    success_count = 0
    error_count = 0
    failed_segment_ids: list[int] = []

    for segment_id in requested_ids:
        # Check if segment exists using pre-fetched map
        if segment_id not in segment_map:
            error_count += 1
            failed_segment_ids.append(segment_id)
            results.append(CodeApplicationResponse(
                segment_id=segment_id,
                code_id=data.code_id,
                applied=False
            ))
            continue

        if data.action == "apply":
            # Check existence using pre-fetched set
            if segment_id not in existing_set:
                application = CodeApplication(
                    segment_id=segment_id,
                    code_id=data.code_id,
                    user_id=user.id,
                    attribution=data.attribution
                )
                db.add(application)

            success_count += 1
            results.append(CodeApplicationResponse(
                segment_id=segment_id,
                code_id=data.code_id,
                applied=True
            ))
        else:  # remove
            # For remove, we still need to delete but can do it in batch after the loop
            success_count += 1
            results.append(CodeApplicationResponse(
                segment_id=segment_id,
                code_id=data.code_id,
                applied=False
            ))

    # The ids the server actually acted on. Computed once and reused by the
    # bulk-remove delete, the consensus marker and the audit row — they were
    # three copies of one comprehension, which is three chances to drift.
    affected_ids = [sid for sid in requested_ids if sid in segment_map]

    # Batch delete for remove action — scoped to THIS coder so a bulk-remove
    # never nukes another coder's applications (#J2-1b critical nuke site).
    if data.action == "remove" and affected_ids:
        db.query(CodeApplication).filter(
            CodeApplication.segment_id.in_(affected_ids),
            CodeApplication.code_id == data.code_id,
            CodeApplication.user_id == user.id
        ).delete(synchronize_session=False)

    if consensus_enabled(db) and affected_ids:
        mark_consensus_stale(db, code.project_id, segment_ids=affected_ids)

    # Audit the bulk operation. The single apply/remove paths each log_action; the
    # bulk path never did — a coding-provenance gap (conv/doc too) closed here. One
    # row per operation; entity_id is N/A for a batch.
    if affected_ids:
        log_action(
            db,
            action="code_applied" if data.action == "apply" else "code_removed",
            entity_type="code_application",
            user_id=user.id,
            project_id=code.project_id,
            details={"code_id": data.code_id, "segment_ids": affected_ids, "bulk": True},
        )

    db.commit()

    return BulkCodeResponse(
        results=results,
        success_count=success_count,
        error_count=error_count,
        failed_segment_ids=failed_segment_ids,
    )


@router.get("/conversations/{conversation_id}/coding-progress", response_model=CodingProgressResponse)
async def get_coding_progress(
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get coding progress for a conversation (excludes soft-deleted segments)."""
    _verify_conversation_ownership(db, conversation_id, user.id)

    # Total segments (exclude soft-deleted)
    total_segments = db.query(func.count(Segment.id)).filter(
        Segment.conversation_id == conversation_id,
        Segment.merged_into_id == None,
        Segment.split_into_id == None
    ).scalar() or 0

    # Coded counts via the shared source of truth (invariant J-A). The
    # non-participant `coded_segments` and participant-only `participant_coded`
    # differ only in the Speaker dimension. Both exclude universal-only segments
    # (#351/#352) — the gauge reads `participant_coded`.
    coded_segments = coded_segment_count(
        db, Segment.conversation_id, conversation_id, participant_only=False
    )

    # Participant segments (not facilitator, exclude soft-deleted) — denominator.
    participant_segments = participant_segment_count(
        db, Segment.conversation_id, conversation_id
    )

    participant_coded = coded_segment_count(
        db, Segment.conversation_id, conversation_id, participant_only=True
    )

    progress = (participant_coded / participant_segments * 100) if participant_segments > 0 else 0

    return CodingProgressResponse(
        conversation_id=conversation_id,
        total_segments=total_segments,
        coded_segments=coded_segments,
        participant_segments=participant_segments,
        participant_coded=participant_coded,
        progress_percent=round(progress, 1)
    )
