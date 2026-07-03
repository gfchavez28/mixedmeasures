from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, or_

from ..database import get_db
from ..models.user import User
from ..models.segment import Segment
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.speaker import Speaker
from ..schemas.coding import (
    ApplyCodeRequest,
    BulkCodeRequest,
    CodeApplicationResponse,
    BulkCodeResponse,
    CodingProgressResponse
)
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.coding_counts import (
    coded_segment_count,
    participant_segment_count,
)
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale
from .helpers import _get_project_or_404, _verify_segment_ownership, _verify_conversation_ownership

router = APIRouter(prefix="/api", tags=["coding"])


def _get_segment_project_id(db: Session, segment: Segment) -> int | None:
    """Get project_id for a segment via its parent (conversation or document)."""
    if segment.conversation_id:
        conv = db.query(Conversation).filter(Conversation.id == segment.conversation_id).first()
        return conv.project_id if conv else None
    elif segment.document_id:
        doc = db.query(Document).filter(Document.id == segment.document_id).first()
        return doc.project_id if doc else None
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

    if existing:
        return CodeApplicationResponse(
            segment_id=segment_id,
            code_id=code_id,
            applied=True,
            created_at=existing.created_at
        )

    # Apply code
    application = CodeApplication(
        segment_id=segment_id,
        code_id=code_id,
        user_id=user.id,
        attribution=data.attribution if data else None
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
                group_app = CodeApplication(
                    segment_id=group_seg.id,
                    code_id=code_id,
                    user_id=user.id,
                    attribution=data.attribution if data else None
                )
                db.add(group_app)

    # Flush to get the application.id without committing
    db.flush()

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
        created_at=application.created_at
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

    # Batch fetch all segments in one query, verify same project as code
    segments = db.query(Segment).outerjoin(
        Conversation, Segment.conversation_id == Conversation.id
    ).outerjoin(
        Document, Segment.document_id == Document.id
    ).filter(
        Segment.id.in_(data.segment_ids),
        or_(
            Conversation.project_id == code.project_id,
            Document.project_id == code.project_id,
        ),
    ).all()
    segment_map = {s.id: s for s in segments}

    # Batch check existing code applications by THIS coder (per-coder dedup;
    # #J2-1b — "have *I* applied this?", not "has anyone?").
    existing_apps = db.query(CodeApplication).filter(
        CodeApplication.segment_id.in_(data.segment_ids),
        CodeApplication.code_id == data.code_id,
        CodeApplication.user_id == user.id
    ).all()
    existing_set = {ca.segment_id for ca in existing_apps}

    results = []
    success_count = 0
    error_count = 0

    for segment_id in data.segment_ids:
        # Check if segment exists using pre-fetched map
        if segment_id not in segment_map:
            error_count += 1
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

    # Batch delete for remove action — scoped to THIS coder so a bulk-remove
    # never nukes another coder's applications (#J2-1b critical nuke site).
    if data.action == "remove":
        valid_segment_ids = [sid for sid in data.segment_ids if sid in segment_map]
        if valid_segment_ids:
            db.query(CodeApplication).filter(
                CodeApplication.segment_id.in_(valid_segment_ids),
                CodeApplication.code_id == data.code_id,
                CodeApplication.user_id == user.id
            ).delete(synchronize_session=False)

    if consensus_enabled(db):
        affected = [sid for sid in data.segment_ids if sid in segment_map]
        if affected:
            mark_consensus_stale(db, code.project_id, segment_ids=affected)

    db.commit()

    return BulkCodeResponse(
        results=results,
        success_count=success_count,
        error_count=error_count
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


@router.get("/conversations/{conversation_id}/next-uncoded")
async def get_next_uncoded_segment(
    conversation_id: int,
    current_segment_id: int = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get the next uncoded participant segment after the current position (excludes soft-deleted)."""
    _verify_conversation_ownership(db, conversation_id, user.id)

    # Get current segment's sequence order
    current_order = 0
    if current_segment_id:
        current = db.query(Segment).filter(Segment.id == current_segment_id).first()
        if current:
            current_order = current.sequence_order

    # Find next uncoded participant segment (exclude soft-deleted)
    # Uses LEFT JOIN instead of NOT IN subquery for efficiency
    next_segment = db.query(Segment).outerjoin(
        CodeApplication, CodeApplication.segment_id == Segment.id
    ).outerjoin(
        Speaker, Speaker.id == Segment.speaker_id
    ).filter(
        Segment.conversation_id == conversation_id,
        Segment.merged_into_id == None,  # Exclude soft-deleted
        Segment.split_into_id == None,
        Segment.sequence_order > current_order,
        (Speaker.is_facilitator == 0) | (Segment.speaker_id == None),
        CodeApplication.id == None  # No code applications = uncoded
    ).order_by(Segment.sequence_order).first()

    # If nothing found after current, wrap to beginning
    if not next_segment:
        next_segment = db.query(Segment).outerjoin(
            CodeApplication, CodeApplication.segment_id == Segment.id
        ).outerjoin(
            Speaker, Speaker.id == Segment.speaker_id
        ).filter(
            Segment.conversation_id == conversation_id,
            Segment.merged_into_id == None,  # Exclude soft-deleted
            Segment.split_into_id == None,
            (Speaker.is_facilitator == 0) | (Segment.speaker_id == None),
            CodeApplication.id == None  # No code applications = uncoded
        ).order_by(Segment.sequence_order).first()

    if not next_segment:
        return {"segment_id": None, "message": "All participant segments are coded"}

    return {"segment_id": next_segment.id, "sequence_order": next_segment.sequence_order}
