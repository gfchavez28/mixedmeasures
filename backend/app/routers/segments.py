from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload, selectinload

from ..database import get_db
from ..models.user import User
from ..models.conversation import Conversation
from ..models.segment import Segment
from ..models.segment_group import SegmentGroup
from ..models.speaker import Speaker
from ..models.excerpt import Excerpt
from ..models.code_application import CodeApplication
from ..schemas.segment import (
    SegmentResponse,
    SegmentListResponse,
    SegmentNoteInfo,
    SpeakerUpdateRequest,
    SegmentUpdateRequest,
    SegmentGroupRequest,
    SegmentGroupResponse,
    SegmentMergeRequest,
    SegmentMergeResponse,
    SegmentUnmergeResponse,
    SegmentSplitRequest,
    SegmentSplitResponse,
    SegmentUnsplitResponse,
)
from ..schemas.excerpt import SegmentExcerptInfo
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.staleness import mark_metrics_stale
from .helpers import visible_segment_filter as _visible_segment_filter, _verify_conversation_ownership

router = APIRouter(prefix="/api/conversations/{conversation_id}/segments", tags=["segments"])


def segment_to_response(segment: Segment) -> SegmentResponse:
    """Convert Segment model to response.

    Note: Assumes segment was loaded with eager loading for speaker,
    code_applications, and attached_notes relationships.
    """
    # Get speaker info
    speaker_name = None
    is_facilitator = False
    speaker_color_index = 0
    speaker_color = None
    if segment.speaker:
        speaker_name = segment.speaker.name
        is_facilitator = bool(segment.speaker.is_facilitator)
        speaker_color_index = segment.speaker.color_index or 0
        speaker_color = segment.speaker.color

    # Get applied codes (pre-loaded)
    applied_codes = [ca.code_id for ca in segment.code_applications]

    # Get attached notes (pre-loaded, filter archived in Python)
    active_notes = [n for n in segment.attached_notes if not n.is_archived]
    active_notes.sort(key=lambda n: n.sequence_number or 0)

    attached_note_infos = [
        SegmentNoteInfo(id=n.id, sequence_number=n.sequence_number)
        for n in active_notes
    ]

    # Get excerpts (pre-loaded)
    excerpt_infos = []
    for e in (segment.excerpts or []):
        has_note = e.note is not None and not e.note.is_archived
        excerpt_infos.append(SegmentExcerptInfo(
            id=e.id,
            start_offset=e.start_offset,
            end_offset=e.end_offset,
            has_note=has_note,
            note_id=e.note.id if has_note else None,
            note_preview=e.note.content[:100] if has_note else None,
        ))

    return SegmentResponse(
        id=segment.id,
        conversation_id=segment.conversation_id,
        speaker_id=segment.speaker_id,
        speaker_name=speaker_name,
        is_facilitator=is_facilitator,
        speaker_color_index=speaker_color_index,
        speaker_color=speaker_color,
        sequence_order=segment.sequence_order,
        start_time=segment.start_time,
        end_time=segment.end_time,
        text=segment.text,
        group_id=segment.group_id,
        excerpts=excerpt_infos,
        applied_codes=applied_codes,
        attached_notes=attached_note_infos,
        is_merged=bool(segment.is_merge_result),
        is_split=bool(segment.is_split_result),
        created_at=segment.created_at
    )


@router.get("", response_model=SegmentListResponse)
async def list_segments(
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get all segments for a conversation."""
    _verify_conversation_ownership(db, conversation_id, user.id)

    # Eager load relationships to avoid N+1 queries
    # Exclude soft-deleted segments (merged or split)
    segments = db.query(Segment).filter(
        Segment.conversation_id == conversation_id,
        *_visible_segment_filter()
    ).options(
        joinedload(Segment.speaker),
        # joinedload the code so the coded-count predicate below can exclude
        # universal codes without an N+1 (invariant J-A — same "coded" definition
        # as services/coding_counts.py: a segment is coded iff it has ≥1
        # NON-universal application).
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).order_by(Segment.sequence_order).all()

    # Calculate stats (relationships are pre-loaded). "Coded" excludes
    # universal-only segments (#398 / J-A) to match the gauge + every other
    # surface; computed in-memory here since segments are already loaded.
    total = len(segments)
    coded_count = 0
    participant_total = 0
    participant_coded = 0

    for seg in segments:
        has_code = any(
            ca.code is not None and not ca.code.is_universal
            for ca in seg.code_applications
        )
        if has_code:
            coded_count += 1

        is_facilitator = seg.speaker and seg.speaker.is_facilitator
        if not is_facilitator:
            participant_total += 1
            if has_code:
                participant_coded += 1

    return SegmentListResponse(
        segments=[segment_to_response(s) for s in segments],
        total=total,
        coded_count=coded_count,
        participant_total=participant_total,
        participant_coded=participant_coded
    )


@router.get("/{segment_id}", response_model=SegmentResponse)
async def get_segment(
    conversation_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a single segment (excludes soft-deleted segments)."""
    _verify_conversation_ownership(db, conversation_id, user.id)
    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        Segment.conversation_id == conversation_id,
        *_visible_segment_filter()
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")

    return segment_to_response(segment)


@router.patch("/{segment_id}", response_model=SegmentResponse)
async def update_segment(
    conversation_id: int,
    segment_id: int,
    data: SegmentUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a segment's text and/or speaker."""
    conversation = _verify_conversation_ownership(db, conversation_id, user.id)
    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        Segment.conversation_id == conversation_id,
        *_visible_segment_filter()
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")
    details = {}

    if data.text is not None:
        details["old_text"] = segment.text
        details["new_text"] = data.text
        segment.text = data.text
        segment.word_count = len(data.text.split()) if data.text.strip() else 0

    if data.speaker_id is not None:
        # Validate speaker belongs to the same project
        speaker = db.query(Speaker).filter(
            Speaker.id == data.speaker_id,
            Speaker.project_id == conversation.project_id
        ).first()
        if not speaker:
            raise HTTPException(status_code=400, detail="Speaker not found in this project")

        details["old_speaker_id"] = segment.speaker_id
        details["new_speaker_id"] = data.speaker_id
        segment.speaker_id = data.speaker_id

    log_action(
        db,
        action="segment_updated",
        entity_type="segment",
        entity_id=segment.id,
        user_id=user.id,
        project_id=conversation.project_id if conversation else None,
        details=details
    )

    # Mark metrics stale if text or speaker changed (affects qualitative analysis)
    if data.text is not None or data.speaker_id is not None:
        mark_metrics_stale(db, conversation.project_id)
    db.commit()

    # Reload with eager loading for response
    segment = db.query(Segment).filter(
        Segment.id == segment_id
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    return segment_to_response(segment)


@router.patch("/{segment_id}/speaker", response_model=SegmentResponse)
async def update_segment_speaker_role(
    conversation_id: int,
    segment_id: int,
    data: SpeakerUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update the speaker role for a segment's speaker."""
    conversation = _verify_conversation_ownership(db, conversation_id, user.id)
    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        Segment.conversation_id == conversation_id
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")

    if not segment.speaker:
        raise HTTPException(status_code=400, detail="Segment has no speaker")

    segment.speaker.is_facilitator = 1 if data.is_facilitator else 0

    log_action(
        db,
        action="speaker_role_updated",
        entity_type="speaker",
        entity_id=segment.speaker.id,
        user_id=user.id,
        project_id=conversation.project_id if conversation else None,
        details={
            "speaker_name": segment.speaker.name,
            "is_facilitator": data.is_facilitator
        }
    )
    db.commit()

    return segment_to_response(segment)


@router.post("/group", response_model=SegmentGroupResponse)
async def create_segment_group(
    conversation_id: int,
    data: SegmentGroupRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Group adjacent segments together."""
    conversation = _verify_conversation_ownership(db, conversation_id, user.id)

    if len(data.segment_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 segments required for grouping")

    # Verify all segments exist and belong to this conversation
    segments = db.query(Segment).filter(
        Segment.id.in_(data.segment_ids),
        Segment.conversation_id == conversation_id
    ).order_by(Segment.sequence_order).all()

    if len(segments) != len(data.segment_ids):
        raise HTTPException(status_code=400, detail="Some segments not found")

    # Verify segments are adjacent
    orders = [s.sequence_order for s in segments]
    for i in range(len(orders) - 1):
        if orders[i + 1] != orders[i] + 1:
            raise HTTPException(status_code=400, detail="Segments must be adjacent")

    # Remove from existing groups
    for seg in segments:
        seg.group_id = None

    # Create new group
    group = SegmentGroup(conversation_id=conversation_id)
    db.add(group)
    db.flush()

    # Assign segments to group
    for seg in segments:
        seg.group_id = group.id

    log_action(
        db,
        action="grouped",
        entity_type="segment_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=conversation.project_id,
        details={"segment_ids": data.segment_ids}
    )
    db.commit()

    return SegmentGroupResponse(
        id=group.id,
        segment_ids=[s.id for s in segments]
    )


@router.delete("/group/{group_id}")
async def ungroup_segments(
    conversation_id: int,
    group_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Ungroup segments."""
    conversation = _verify_conversation_ownership(db, conversation_id, user.id)
    group = db.query(SegmentGroup).filter(
        SegmentGroup.id == group_id,
        SegmentGroup.conversation_id == conversation_id
    ).first()

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Remove group assignment from segments
    for seg in group.segments:
        seg.group_id = None

    log_action(
        db,
        action="ungrouped",
        entity_type="segment_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=conversation.project_id if conversation else None
    )

    db.delete(group)
    db.commit()

    return {"status": "ok", "deleted_id": group_id}


@router.post("/merge", response_model=SegmentMergeResponse)
async def merge_segments_endpoint(
    conversation_id: int,
    data: SegmentMergeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Merge adjacent segments into one with soft-delete for undo support."""
    from ..services.segment_operations import merge_segments as do_merge

    conversation = _verify_conversation_ownership(db, conversation_id, user.id)

    merged_segment, deleted_count = do_merge(
        db, data.segment_ids, 'conversation', conversation_id,
        conversation.project_id, user.id,
    )

    return SegmentMergeResponse(
        merged_segment=segment_to_response(merged_segment),
        deleted_count=deleted_count,
    )


@router.post("/{segment_id}/unmerge", response_model=SegmentUnmergeResponse)
async def unmerge_segments_endpoint(
    conversation_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Unmerge a previously merged segment, restoring the originals."""
    from ..services.segment_operations import unmerge_segment as do_unmerge

    conversation = _verify_conversation_ownership(db, conversation_id, user.id)

    restored, restored_count = do_unmerge(
        db, segment_id, 'conversation', conversation_id,
        conversation.project_id, user.id,
    )

    return SegmentUnmergeResponse(
        restored_segments=[segment_to_response(s) for s in restored],
        restored_count=restored_count,
    )


@router.post("/split", response_model=SegmentSplitResponse)
async def split_segments_endpoint(
    conversation_id: int,
    data: SegmentSplitRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Split segment(s) by text selection."""
    from ..services.segment_operations import split_segment as do_split

    conversation = _verify_conversation_ownership(db, conversation_id, user.id)

    new_segments, deleted_ids = do_split(
        db, data.ranges, 'conversation', conversation_id,
        conversation.project_id, user.id,
    )

    return SegmentSplitResponse(
        new_segments=[segment_to_response(s) for s in new_segments],
        deleted_segment_ids=deleted_ids,
    )


@router.post("/{segment_id}/unsplit", response_model=SegmentUnsplitResponse)
async def unsplit_segment_endpoint(
    conversation_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Unsplit/rejoin a previously split segment, restoring the original."""
    from ..services.segment_operations import unsplit_segment as do_unsplit

    conversation = _verify_conversation_ownership(db, conversation_id, user.id)

    restored, deleted_count = do_unsplit(
        db, segment_id, 'conversation', conversation_id,
        conversation.project_id, user.id,
    )

    return SegmentUnsplitResponse(
        restored_segment=segment_to_response(restored),
        deleted_count=deleted_count,
    )
