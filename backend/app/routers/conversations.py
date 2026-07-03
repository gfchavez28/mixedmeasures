import csv
import logging
import shutil

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session
from sqlalchemy import func
import json

from ..config import get_media_dir
from ..database import get_db
from ..models.user import User
from ..models.conversation import Conversation
from ..models.segment import Segment
from ..models.speaker import Speaker
from ..models.code import Code, UNIVERSAL_CODES
from ..models.code_application import CodeApplication
from ..models.participant import Participant
from ..schemas.conversation import (
    ConversationUpdate,
    ConversationResponse,
    ConversationListResponse,
    CSVPreviewResponse,
    CSVImportRequest,
    ConversationImportResponse
)
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.csv_import import preview_csv, import_csv_to_segments
from ..services.subtitle_import import (
    SubtitleImportError,
    is_subtitle_upload,
    subtitles_to_csv_bytes,
)
from ..services.coding_layers import non_consensus_filter
from ..services.coding_counts import (
    coded_segment_count as coded_segment_count_fn,
    coded_segment_counts,
    participant_segment_count,
    participant_segment_counts,
)
from .helpers import _get_project_or_404, read_upload_with_limit, validate_encoding

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects/{project_id}/conversations", tags=["conversations"])


def ensure_participant_for_speaker(
    db: Session, project_id: int, speaker: Speaker, name: str
) -> None:
    """Auto-create or link Participant for non-facilitator speakers."""
    if speaker.is_facilitator or speaker.participant_id is not None:
        return
    existing = db.query(Participant).filter(
        Participant.project_id == project_id,
        Participant.identifier == name,
    ).first()
    if existing:
        speaker.participant_id = existing.id
    else:
        participant = Participant(
            project_id=project_id,
            identifier=name,
            display_name=name,
        )
        db.add(participant)
        db.flush()
        speaker.participant_id = participant.id


def conversation_to_response(
    conversation: Conversation,
    db: Session,
    segment_count: int | None = None,
    coded_segment_count: int | None = None,
    speaker_count: int | None = None,
    code_count: int | None = None,
) -> ConversationResponse:
    """Convert Conversation model to response with counts.

    If segment_count and coded_segment_count are provided, use them directly.
    Otherwise, query the database (for single-conversation endpoints).
    Excludes soft-deleted segments (merged_into_id IS NOT NULL).
    """
    # #351/#352: counts exclude facilitator segments so the "X of Y coded"
    # gauges across all surfaces (overview, conversations list, TopRail) match
    # the CodingWorkbench's participant-only gauge. Both numerator and
    # denominator route through the shared source of truth (invariant J-A).
    if segment_count is None:
        segment_count = participant_segment_count(
            db, Segment.conversation_id, conversation.id
        )

    if coded_segment_count is None:
        coded_segment_count = coded_segment_count_fn(
            db, Segment.conversation_id, conversation.id, participant_only=True
        )

    if speaker_count is None:
        speaker_count = db.query(func.count(func.distinct(Segment.speaker_id))).filter(
            Segment.conversation_id == conversation.id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Segment.speaker_id.isnot(None),
        ).scalar() or 0

    if code_count is None:
        code_count = db.query(func.count(func.distinct(CodeApplication.code_id))).join(
            Segment, Segment.id == CodeApplication.segment_id
        ).filter(
            Segment.conversation_id == conversation.id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            non_consensus_filter(),  # J2-B: the derived consensus layer must not inflate the card count
        ).scalar() or 0

    return ConversationResponse(
        id=conversation.id,
        project_id=conversation.project_id,
        name=conversation.name,
        subject_id=conversation.subject_id,
        conversation_date=conversation.conversation_date,
        status=conversation.status,
        summary=conversation.summary,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        segment_count=segment_count,
        coded_segment_count=coded_segment_count,
        speaker_count=speaker_count,
        code_count=code_count,
        media_filename=conversation.media_filename,
        media_format=conversation.media_format,
        media_type=conversation.media_type,
        media_duration_seconds=conversation.media_duration_seconds,
        media_offset_seconds=conversation.media_offset_seconds,
        media_is_vbr=conversation.media_is_vbr,
        has_audio=conversation.media_type == "audio",
    )


def ensure_universal_codes(db: Session, project_id: int) -> None:
    """Ensure universal codes exist for the project."""
    for code_data in UNIVERSAL_CODES:
        existing = db.query(Code).filter(
            Code.project_id == project_id,
            Code.numeric_id == code_data["numeric_id"]
        ).first()

        if not existing:
            code = Code(
                project_id=project_id,
                **code_data
            )
            db.add(code)

    db.commit()


@router.get("", response_model=ConversationListResponse)
async def list_conversations(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all conversations in a project."""
    _get_project_or_404(db, project_id, user.id)

    conversations = db.query(Conversation).filter(
        Conversation.project_id == project_id
    ).order_by(Conversation.created_at.desc()).all()

    if not conversations:
        return ConversationListResponse(conversations=[], total=0)

    conversation_ids = [c.id for c in conversations]

    # Batch participant-segment + coded-segment counts via the shared source of
    # truth (invariant J-A; #351/#352 facilitator exclusion + universal exclusion).
    segment_counts = participant_segment_counts(
        db, Segment.conversation_id, conversation_ids
    )
    coded_counts = coded_segment_counts(
        db, Segment.conversation_id, conversation_ids, participant_only=True
    )

    # Batch query: speaker counts per conversation
    speaker_counts = dict(
        db.query(Segment.conversation_id, func.count(func.distinct(Segment.speaker_id)))
        .filter(
            Segment.conversation_id.in_(conversation_ids),
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Segment.speaker_id.isnot(None),
        )
        .group_by(Segment.conversation_id)
        .all()
    )

    # Batch query: distinct code counts per conversation
    code_counts = dict(
        db.query(Segment.conversation_id, func.count(func.distinct(CodeApplication.code_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .filter(
            Segment.conversation_id.in_(conversation_ids),
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            non_consensus_filter(),  # J2-B: the derived consensus layer must not inflate the card count
        )
        .group_by(Segment.conversation_id)
        .all()
    )

    return ConversationListResponse(
        conversations=[
            conversation_to_response(
                c, db,
                segment_count=segment_counts.get(c.id, 0),
                coded_segment_count=coded_counts.get(c.id, 0),
                speaker_count=speaker_counts.get(c.id, 0),
                code_count=code_counts.get(c.id, 0),
            )
            for c in conversations
        ],
        total=len(conversations)
    )


@router.post("/preview", response_model=CSVPreviewResponse)
async def preview_csv_upload(
    project_id: int,
    file: UploadFile = File(...),
    encoding: str = Form("utf-8"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Preview a CSV file before importing."""
    _get_project_or_404(db, project_id, user.id)

    validate_encoding(encoding)
    content = await read_upload_with_limit(file)
    # VTT/SRT transcripts (#524) convert to conversation-CSV at the boundary; the
    # converter emits UTF-8 regardless of the upload's encoding.
    if is_subtitle_upload(file.filename):
        try:
            content = await run_in_threadpool(subtitles_to_csv_bytes, content, encoding)
        except SubtitleImportError as e:
            logger.warning("Subtitle parse failed: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
        encoding = "utf-8"

    try:
        result = preview_csv(content, encoding)
    except (ValueError, csv.Error, UnicodeDecodeError) as e:
        logger.warning("CSV parse failed: %s", e)
        raise HTTPException(status_code=400, detail="Unable to parse CSV file. Check the file format and try again.")

    return CSVPreviewResponse(
        headers=result.headers,
        sample_rows=result.sample_rows,
        total_rows=result.total_rows,
        unique_speakers=result.unique_speakers,
        detected_columns=result.detected_columns,
        unique_values_by_column=result.unique_values_by_column
    )


@router.post("/import", response_model=ConversationImportResponse)
async def import_csv(
    project_id: int,
    file: UploadFile = File(...),
    import_config: str = Form(...),  # JSON string of CSVImportRequest
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Import a CSV file as a conversation."""
    _get_project_or_404(db, project_id, user.id)

    # Parse import config
    try:
        config = CSVImportRequest.model_validate(json.loads(import_config))
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("Invalid import config: %s", e)
        raise HTTPException(status_code=400, detail="Invalid import configuration.")

    validate_encoding(config.encoding)
    content = await read_upload_with_limit(file)
    # VTT/SRT transcripts (#524): same boundary conversion as the preview; the
    # converted bytes are UTF-8, so override the configured encoding downstream.
    subtitle_encoding_override = False
    if is_subtitle_upload(file.filename):
        try:
            content = await run_in_threadpool(subtitles_to_csv_bytes, content, config.encoding)
        except SubtitleImportError as e:
            logger.warning("Subtitle parse failed: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
        subtitle_encoding_override = True

    # Build speaker mapping dict
    speaker_mapping = {
        sm.original_label: sm.normalized_name
        for sm in config.speaker_mappings
    }

    # Build facilitator lookup
    facilitator_flags = {
        sm.original_label: sm.is_facilitator
        for sm in config.speaker_mappings
    }

    # Parse CSV. import_csv_to_segments returns (segments, warnings) — #356
    # surfaces import-time validation issues (backward timestamps) so the
    # researcher can fix them in the source CSV + re-import if they care.
    try:
        segments, warnings = import_csv_to_segments(
            content,
            config.column_mapping,
            speaker_mapping,
            "utf-8" if subtitle_encoding_override else config.encoding
        )
    except (ValueError, csv.Error, UnicodeDecodeError, KeyError) as e:
        logger.warning("CSV parse failed: %s", e)
        raise HTTPException(status_code=400, detail="Unable to parse CSV file. Check the file format and try again.")

    if not segments:
        raise HTTPException(status_code=400, detail="No segments found in CSV")

    # Ensure universal codes exist
    ensure_universal_codes(db, project_id)

    # Create conversation
    conversation = Conversation(
        project_id=project_id,
        name=config.name,
        subject_id=config.subject_id,
        conversation_date=config.conversation_date
    )
    db.add(conversation)
    db.flush()

    # Create or get speakers
    # Assign color indices based on speaker order in config
    speaker_cache = {}
    for i, sm in enumerate(config.speaker_mappings):
        # Check if speaker exists
        existing = db.query(Speaker).filter(
            Speaker.project_id == project_id,
            Speaker.name == sm.normalized_name
        ).first()

        if existing:
            # Update color_index if provided
            existing.color_index = sm.color_index if sm.color_index else i
            if sm.color is not None:
                existing.color = sm.color
            speaker_cache[sm.normalized_name] = existing
            ensure_participant_for_speaker(db, project_id, existing, sm.normalized_name)
        else:
            speaker = Speaker(
                project_id=project_id,
                name=sm.normalized_name,
                original_label=sm.original_label,
                is_facilitator=1 if sm.is_facilitator else 0,
                color_index=sm.color_index if sm.color_index else i,
                color=sm.color,
            )
            db.add(speaker)
            db.flush()
            speaker_cache[sm.normalized_name] = speaker
            ensure_participant_for_speaker(db, project_id, speaker, sm.normalized_name)

    # Create segments
    for seg in segments:
        speaker = speaker_cache.get(seg.speaker_label)

        segment = Segment(
            conversation_id=conversation.id,
            speaker_id=speaker.id if speaker else None,
            sequence_order=seg.sequence_order,
            start_time=seg.start_time,
            end_time=seg.end_time,
            text=seg.text,
            word_count=len(seg.text.split()) if seg.text and seg.text.strip() else 0,
            original_speaker_label=seg.speaker_label
        )
        db.add(segment)

    log_action(
        db,
        action="imported",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "name": conversation.name,
            "segment_count": len(segments)
        }
    )
    db.commit()
    db.refresh(conversation)

    # #356: wrap response so import-time warnings reach the UI without
    # polluting bare ConversationResponse (which is also returned by
    # GET /conversations/{id} where warnings would always be empty).
    return ConversationImportResponse(
        conversation=conversation_to_response(conversation, db),
        warnings=warnings,
    )


@router.get("/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a conversation by ID."""
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.project_id == project_id
    ).first()

    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    return conversation_to_response(conversation, db)


@router.patch("/{conversation_id}", response_model=ConversationResponse)
async def update_conversation(
    project_id: int,
    conversation_id: int,
    data: ConversationUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a conversation."""
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.project_id == project_id
    ).first()

    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(conversation, field, value)

    log_action(
        db,
        action="updated",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details=update_data
    )
    db.commit()
    db.refresh(conversation)

    return conversation_to_response(conversation, db)


@router.delete("/{conversation_id}")
async def delete_conversation(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete a conversation and all associated data."""
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.project_id == project_id
    ).first()

    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation_name = conversation.name

    log_action(
        db,
        action="deleted",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": conversation_name}
    )

    db.delete(conversation)
    db.commit()

    # Clean up media files on disk (populated when audio/video is attached)
    media_dir = get_media_dir() / str(project_id) / str(conversation_id)
    try:
        if media_dir.is_dir():
            shutil.rmtree(media_dir)
    except Exception:
        logger.warning("Failed to clean up media files at %s", media_dir)

    return {"status": "ok", "deleted_id": conversation_id}
