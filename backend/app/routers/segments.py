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
    SegmentUpdateResponse,
    SegmentTextPreviewRequest,
    TextEditPlanResponse,
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
from ..schemas.common import AppliedCodeDetail
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.coding_layers import CONSENSUS_ORIGIN
from ..services.coding_counts import coded_segment_count
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale
from ..services.participant_scores import mark_participant_scores_stale
from ..services.segment_operations import apply_text_edit, preview_text_edit
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

    # Get applied codes (pre-loaded). The bare ID list stays for the optimistic
    # patch path; applied_code_details carries per-coder attribution (Track J · J1).
    # is_universal reads ca.code, so callers MUST joinedload(CodeApplication.code).
    # Exclude the derived consensus layer (J2-B / P-1): the workbench shows the
    # human/working layer only — the reconciliation view reads consensus separately.
    # Without this, a consensus row inflates the client coded gauge the instant the
    # Slab-5 sweep materializes it on a multi-coder project.
    human_apps = [ca for ca in segment.code_applications if ca.origin != CONSENSUS_ORIGIN]
    applied_codes = [ca.code_id for ca in human_apps]
    applied_code_details = [
        AppliedCodeDetail(
            code_id=ca.code_id,
            user_id=ca.user_id,
            attribution=ca.attribution,
            is_universal=bool(ca.code.is_universal) if ca.code else False,
            magnitude=ca.magnitude,
            magnitude_conflict=ca.magnitude_conflict,
        )
        for ca in human_apps
    ]

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
        applied_code_details=applied_code_details,
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

    # Calculate stats. "Coded" is `coding_counts`' J-A definition — visible,
    # ≥1 NON-universal application, by a PERSON.
    #
    # 🔴 Asked of the SERVICE, not re-derived over the loaded rows (#1029). This
    # was an in-memory copy of the predicate that tested `origin` only, so a
    # machine coder's labels made a segment "coded" here while the conversation
    # card beside it (`coded_segment_counts`) did not — the Content-by-source
    # reader read "40 coded" over a transcript no person had touched. A second
    # copy of a count is how the two drifted; there is one now.
    total = len(segments)
    participant_total = sum(
        1 for seg in segments if not (seg.speaker and seg.speaker.is_facilitator)
    )
    coded_count = coded_segment_count(
        db, Segment.conversation_id, conversation_id, participant_only=False,
    )
    participant_coded = coded_segment_count(
        db, Segment.conversation_id, conversation_id, participant_only=True,
    )

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
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")

    return segment_to_response(segment)


def _editable_segment_or_404(db: Session, conversation_id: int, segment_id: int) -> Segment:
    """The visible segment an edit (or its preview) acts on, with its quotes loaded.

    One lookup for the PATCH door and its preview, so the preview's plan is made
    on the same row the apply will write.
    """
    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        Segment.conversation_id == conversation_id,
        *_visible_segment_filter()
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()
    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")
    return segment


@router.post("/{segment_id}/edit-preview", response_model=TextEditPlanResponse)
async def preview_segment_text_edit(
    conversation_id: int,
    segment_id: int,
    data: SegmentTextPreviewRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """What saving this text would do to the turn's quotes (#1319). Writes nothing.

    The client asks before it saves, shows the quotes an edit touches, straddles
    or deletes (D5), and only then sends the PATCH with its answer.
    """
    _verify_conversation_ownership(db, conversation_id, user.id)
    segment = _editable_segment_or_404(db, conversation_id, segment_id)
    return preview_text_edit(segment, data.text)


@router.patch("/{segment_id}", response_model=SegmentUpdateResponse)
async def update_segment(
    conversation_id: int,
    segment_id: int,
    data: SegmentUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a segment's text and/or speaker.

    A text edit is a segment operation (#1319): `apply_text_edit` carries every
    char-range quote with the words it marked, and refuses (409) an edit whose
    flagged quotes the request did not answer for.
    """
    conversation = _verify_conversation_ownership(db, conversation_id, user.id)
    segment = _editable_segment_or_404(db, conversation_id, segment_id)
    details = {}
    quote_rebase = None

    speaker = None
    if data.speaker_id is not None:
        # Validate speaker belongs to the same project — before any write.
        speaker = db.query(Speaker).filter(
            Speaker.id == data.speaker_id,
            Speaker.project_id == conversation.project_id
        ).first()
        if not speaker:
            raise HTTPException(status_code=400, detail="Speaker not found in this project")

    if data.text is not None:
        details["old_text"] = segment.text
        details["new_text"] = data.text
        quote_rebase, rebase_audit = apply_text_edit(
            db, segment, data.text,
            remove_excerpt_ids=data.remove_excerpt_ids,
            excerpt_offsets=[
                (o.excerpt_id, o.start_offset, o.end_offset) for o in data.excerpt_offsets
            ],
        )
        details["quote_rebase"] = rebase_audit["quote_rebase"]

    if speaker is not None:
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

    db.commit()

    # Reload with eager loading for response
    segment = db.query(Segment).filter(
        Segment.id == segment_id
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    return SegmentUpdateResponse(
        **segment_to_response(segment).model_dump(),
        quote_rebase=quote_rebase,
    )


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
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note)
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")

    if not segment.speaker:
        raise HTTPException(status_code=400, detail="Segment has no speaker")

    segment.speaker.is_facilitator = 1 if data.is_facilitator else 0
    # #1333 — a speaker's role decides which turns are reliability units and
    # which ratings reach a participant's score (`facilitator_turn`), so the role
    # is an input to both. Ungated, like every score marker.
    mark_participant_scores_stale(db, conversation.project_id)

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


def _mark_regrouped_consensus_stale(db: Session, project_id: int, segment_ids) -> None:
    """#1334 unit 3 (D34) — a group's consensus is ONE decision over its members
    (`services/consensus.py`), so a change to WHO is in a group moves every
    member's consensus, coded or not. Gated on `consensus_enabled`, which is
    right for consensus (one voter decides nothing); the participant-score
    marker beside each call is the ungated one."""
    ids = sorted(set(segment_ids))
    if ids and consensus_enabled(db):
        mark_consensus_stale(db, project_id, segment_ids=ids)


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

    # Remove from existing groups — remembering which, because each one LOSES
    # members here and its consensus was decided over them (D34).
    old_group_ids = sorted({seg.group_id for seg in segments if seg.group_id})
    for seg in segments:
        seg.group_id = None

    # Create new group
    group = SegmentGroup(conversation_id=conversation_id)
    db.add(group)
    db.flush()

    # Assign segments to group
    for seg in segments:
        seg.group_id = group.id
    # #1334 — a group is ONE passage of a participant's score, so grouping moves
    # the score. (Reliability is computed on read; the client re-reads it.)
    mark_participant_scores_stale(db, conversation.project_id)
    # #1334 unit 3 (D34) — and one consensus decision: the new group's members,
    # and the turns left behind in any group they came from. (No flush needed:
    # whether the read sees the moved turns in their old group or not, they are
    # marked anyway as new members.)
    left_behind = [
        sid for (sid,) in db.query(Segment.id).filter(Segment.group_id.in_(old_group_ids))
    ] if old_group_ids else []
    _mark_regrouped_consensus_stale(
        db, conversation.project_id, [s.id for s in segments] + left_behind,
    )

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
    former_members = [seg.id for seg in group.segments]
    for seg in group.segments:
        seg.group_id = None
    # #1334 — the members become passages of their own again.
    mark_participant_scores_stale(db, conversation.project_id)
    # #1334 unit 3 (D34) — and units of their own for consensus: each member's
    # rows were the group's decision. Hidden members too (a merge leaves its
    # originals in the group), so the recompute can clear what was written there.
    _mark_regrouped_consensus_stale(db, conversation.project_id, former_members)

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

    report: dict = {}
    new_segments, deleted_ids = do_split(
        db, data.ranges, 'conversation', conversation_id,
        conversation.project_id, user.id, report=report,
    )

    return SegmentSplitResponse(
        new_segments=[segment_to_response(s) for s in new_segments],
        deleted_segment_ids=deleted_ids,
        quote_notes_stayed=report.get("quote_notes_stayed", 0),
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
