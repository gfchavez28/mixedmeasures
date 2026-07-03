from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import select

from ..database import get_db
from ..models.user import User
from ..models.participant import Participant
from ..models.speaker import Speaker
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.dataset import (
    DatasetRow as DatasetRowModel,
    DatasetColumn,
    DatasetValue,
    Dataset,
    ColumnType,
)
from ..schemas.participant import (
    ParticipantCreate,
    ParticipantUpdate,
    ParticipantResponse,
    ParticipantDetailResponse,
    ParticipantListResponse,
    LinkedSpeakerInfo,
    LinkedConversationRef,
    DatasetRowInfo,
    LinkedDemographicValue,
    LinkDatasetRowRequest,
    UnlinkDatasetRowRequest,
)
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.participant_linking import auto_fill_role_from_linked_row
from .helpers import _get_project_or_404

router = APIRouter(tags=["participants"])


def participant_to_response(
    participant: Participant, db: Session
) -> ParticipantResponse:
    """Convert Participant model to response with linked speaker/conversation info."""
    # Build linked speakers
    linked_speakers = []
    speaker_ids = [s.id for s in participant.speakers]

    # Batch query: conversations (id + name) per speaker (avoids N+1).
    # #422b: carry the id so the frontend can link each conversation; dedup by
    # conversation id (a speaker spans a conversation via many segments).
    convs_by_speaker: dict[int, list[LinkedConversationRef]] = {sid: [] for sid in speaker_ids}
    if speaker_ids:
        rows = db.execute(
            select(Segment.speaker_id, Conversation.id, Conversation.name)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .where(Segment.speaker_id.in_(speaker_ids))
            .where(Segment.merged_into_id.is_(None))
            .where(Segment.split_into_id.is_(None))
            .distinct()
        ).all()
        seen_conv_ids: dict[int, set[int]] = {sid: set() for sid in speaker_ids}
        for speaker_id, conv_id, conv_name in rows:
            if conv_id not in seen_conv_ids[speaker_id]:
                seen_conv_ids[speaker_id].add(conv_id)
                convs_by_speaker[speaker_id].append(
                    LinkedConversationRef(id=conv_id, name=conv_name)
                )

    for speaker in participant.speakers:
        linked_speakers.append(
            LinkedSpeakerInfo(
                speaker_id=speaker.id,
                speaker_name=speaker.name,
                is_facilitator=bool(speaker.is_facilitator),
                conversations=convs_by_speaker.get(speaker.id, []),
                color_index=speaker.color_index or 0,
                color=speaker.color,
            )
        )

    # Build dataset rows
    dataset_rows = []
    for dr in participant.dataset_rows:
        dataset_rows.append(
            DatasetRowInfo(
                id=dr.id,
                dataset_name=dr.dataset.name if dr.dataset else "Unknown",
                dataset_id=dr.dataset_id,
                row_identifier=dr.row_identifier,
                submitted_at=dr.submitted_at,
            )
        )

    return ParticipantResponse(
        id=participant.id,
        project_id=participant.project_id,
        identifier=participant.identifier,
        display_name=participant.display_name,
        role=participant.role,
        demographics=participant.demographics,
        role_auto_filled_from=participant.role_auto_filled_from,
        created_at=participant.created_at,
        updated_at=participant.updated_at,
        linked_speakers=linked_speakers,
        dataset_rows=dataset_rows,
    )


def _build_linked_demographics(
    participant: Participant, db: Session
) -> list[LinkedDemographicValue]:
    """Query linked-row column values across all of the participant's linked
    rows.

    #353: widened from "DEMOGRAPHIC type only" to "any non-text column
    unless opted out via `show_in_participant_profile`". The participant→
    row link is an explicit user action; the expected next behavior is
    "show me what's in that row" rather than "show me only the columns
    you happened to type as demographic" (which auto-detect almost never
    picks for non-survey datasets like School Profiles).

    Field name `linked_demographics` retained for backwards-compat —
    the schema contract stays valid; just the included set is broader.
    """
    linked_row_ids = [dr.id for dr in participant.dataset_rows]
    if not linked_row_ids:
        return []

    # #353: include any non-text column the researcher hasn't opted out of.
    # OPEN_TEXT (verbatim comments) and SKIP (ignored at import) are still
    # excluded — they'd clutter the panel.
    NON_TEXT_INCLUDED_TYPES = [
        ColumnType.ORDINAL,
        ColumnType.NOMINAL,
        ColumnType.BINARY,
        ColumnType.MULTI_SELECT,
        ColumnType.NUMERIC,
        ColumnType.PERCENTAGE,
        ColumnType.DEMOGRAPHIC,
    ]
    surfaced_cols = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id.in_(
                [dr.dataset_id for dr in participant.dataset_rows]
            ),
            DatasetColumn.column_type.in_(NON_TEXT_INCLUDED_TYPES),
            DatasetColumn.show_in_participant_profile == True,  # noqa: E712 -- SQLAlchemy column comparison
        )
        .all()
    )
    if not surfaced_cols:
        return []

    surfaced_col_ids = [c.id for c in surfaced_cols]
    values = (
        db.query(DatasetValue)
        .filter(
            DatasetValue.row_id.in_(linked_row_ids),
            DatasetValue.column_id.in_(surfaced_col_ids),
        )
        .all()
    )

    val_map = {(v.row_id, v.column_id): v.value_text for v in values}

    ds_map = {
        dr.dataset_id: (dr.dataset.name if dr.dataset else "Unknown")
        for dr in participant.dataset_rows
    }
    row_dataset_map = {dr.id: dr.dataset_id for dr in participant.dataset_rows}

    linked_demographics = []
    for col in surfaced_cols:
        for row_id in linked_row_ids:
            if row_dataset_map.get(row_id) != col.dataset_id:
                continue
            val = val_map.get((row_id, col.id))
            linked_demographics.append(
                LinkedDemographicValue(
                    column_id=col.id,
                    column_text=col.column_text,
                    demographic_subtype=col.demographic_subtype,
                    value=val,
                    dataset_name=ds_map.get(col.dataset_id, "Unknown"),
                    dataset_id=col.dataset_id,
                    column_type=col.column_type.value,  # #353 — frontend formats by type
                )
            )

    return linked_demographics


def _participant_to_detail(
    participant: Participant, db: Session
) -> ParticipantDetailResponse:
    """Build full detail response with demographics."""
    base = participant_to_response(participant, db)
    linked_demographics = _build_linked_demographics(participant, db)
    return ParticipantDetailResponse(
        **base.model_dump(),
        linked_demographics=linked_demographics,
    )


def _load_participant_with_relations(
    db: Session, participant_id: int
) -> Participant | None:
    """Load participant with eager-loaded speakers and dataset rows."""
    return (
        db.query(Participant)
        .options(
            joinedload(Participant.speakers),
            joinedload(Participant.dataset_rows).joinedload(
                DatasetRowModel.dataset
            ),
        )
        .filter(Participant.id == participant_id)
        .first()
    )


@router.get(
    "/api/projects/{project_id}/participants",
    response_model=ParticipantListResponse,
)
async def list_participants(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all participants for a project with linked speaker info."""
    _get_project_or_404(db, project_id, user.id)

    participants = (
        db.query(Participant)
        .options(
            joinedload(Participant.speakers),
            joinedload(Participant.dataset_rows).joinedload(
                DatasetRowModel.dataset
            ),
        )
        .filter(Participant.project_id == project_id)
        .order_by(Participant.identifier)
        .all()
    )

    return ParticipantListResponse(
        participants=[participant_to_response(p, db) for p in participants],
        total=len(participants),
    )


@router.post(
    "/api/projects/{project_id}/participants",
    response_model=ParticipantResponse,
)
async def create_participant(
    project_id: int,
    data: ParticipantCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new participant."""
    _get_project_or_404(db, project_id, user.id)

    # Check for duplicate identifier
    existing = (
        db.query(Participant)
        .filter(
            Participant.project_id == project_id,
            Participant.identifier == data.identifier,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Participant with identifier '{data.identifier}' already exists in this project",
        )

    participant = Participant(
        project_id=project_id,
        identifier=data.identifier,
        display_name=data.display_name,
        role=data.role,
        demographics=data.demographics,
    )
    db.add(participant)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="participant",
        entity_id=participant.id,
        user_id=user.id,
        project_id=project_id,
        details={"identifier": participant.identifier},
    )
    db.commit()
    db.refresh(participant)

    return participant_to_response(participant, db)


@router.get(
    "/api/projects/{project_id}/participants/{participant_id}",
    response_model=ParticipantDetailResponse,
)
async def get_participant(
    project_id: int,
    participant_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a single participant with full details including linked demographics."""
    _get_project_or_404(db, project_id, user.id)
    participant = _load_participant_with_relations(db, participant_id)
    if not participant or participant.project_id != project_id:
        raise HTTPException(status_code=404, detail="Participant not found")

    return _participant_to_detail(participant, db)


@router.patch(
    "/api/projects/{project_id}/participants/{participant_id}",
    response_model=ParticipantResponse,
)
async def update_participant(
    project_id: int,
    participant_id: int,
    data: ParticipantUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a participant."""
    _get_project_or_404(db, project_id, user.id)
    participant = (
        db.query(Participant)
        .filter(Participant.id == participant_id, Participant.project_id == project_id)
        .first()
    )
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found")

    update_data = data.model_dump(exclude_unset=True)

    # Check identifier uniqueness if changing
    if "identifier" in update_data and update_data["identifier"] != participant.identifier:
        existing = (
            db.query(Participant)
            .filter(
                Participant.project_id == participant.project_id,
                Participant.identifier == update_data["identifier"],
                Participant.id != participant.id,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Participant with identifier '{update_data['identifier']}' already exists",
            )

    # Track if role is being manually changed (clear auto-fill provenance)
    role_changed = "role" in update_data and update_data["role"] != participant.role

    for field, value in update_data.items():
        setattr(participant, field, value)

    if role_changed:
        participant.role_auto_filled_from = None

    # Propagate name changes to linked speakers
    if "display_name" in update_data or "identifier" in update_data:
        new_speaker_name = participant.display_name or participant.identifier
        linked_speakers = (
            db.query(Speaker)
            .filter(Speaker.participant_id == participant.id)
            .all()
        )
        for speaker in linked_speakers:
            speaker.name = new_speaker_name

    log_action(
        db,
        action="updated",
        entity_type="participant",
        entity_id=participant.id,
        user_id=user.id,
        project_id=participant.project_id,
        details=update_data,
    )
    db.commit()
    db.refresh(participant)

    return participant_to_response(participant, db)


@router.post(
    "/api/projects/{project_id}/participants/{participant_id}/link-dataset-row",
    response_model=ParticipantDetailResponse,
)
async def link_dataset_row(
    project_id: int,
    participant_id: int,
    req: LinkDatasetRowRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Link a participant to a dataset row."""
    _get_project_or_404(db, project_id, user.id)
    participant = (
        db.query(Participant)
        .filter(Participant.id == participant_id, Participant.project_id == project_id)
        .first()
    )
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found")

    # Verify row exists and belongs to specified dataset
    row = (
        db.query(DatasetRowModel)
        .filter(
            DatasetRowModel.id == req.row_id,
            DatasetRowModel.dataset_id == req.dataset_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Dataset row not found")

    # Verify dataset belongs to same project
    dataset = (
        db.query(Dataset)
        .filter(
            Dataset.id == req.dataset_id,
            Dataset.project_id == participant.project_id,
        )
        .first()
    )
    if not dataset:
        raise HTTPException(
            status_code=404,
            detail="Dataset not found in this project",
        )

    # Check participant not already linked to another row in this dataset
    existing_link = (
        db.query(DatasetRowModel)
        .filter(
            DatasetRowModel.dataset_id == req.dataset_id,
            DatasetRowModel.participant_id == participant_id,
        )
        .first()
    )
    if existing_link:
        raise HTTPException(
            status_code=409,
            detail=f"Participant already linked to {existing_link.row_identifier or 'a row'} in this dataset",
        )

    # Check row not already linked to another participant
    if row.participant_id is not None and row.participant_id != participant_id:
        other = db.query(Participant).filter(Participant.id == row.participant_id).first()
        other_name = (other.display_name or other.identifier) if other else "another participant"
        raise HTTPException(
            status_code=409,
            detail=f"Row already linked to {other_name}",
        )

    row.participant_id = participant_id
    auto_fill_role_from_linked_row(db, participant, row)

    log_action(
        db,
        action="linked_participant",
        entity_type="dataset_row",
        entity_id=row.id,
        user_id=user.id,
        project_id=participant.project_id,
        details={
            "dataset_id": req.dataset_id,
            "participant_id": participant_id,
        },
    )
    db.commit()

    # Reload with relations for full detail response
    participant = _load_participant_with_relations(db, participant_id)
    return _participant_to_detail(participant, db)


@router.post(
    "/api/projects/{project_id}/participants/{participant_id}/unlink-dataset-row",
    response_model=ParticipantDetailResponse,
)
async def unlink_dataset_row(
    project_id: int,
    participant_id: int,
    req: UnlinkDatasetRowRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Unlink a dataset row from a participant."""
    _get_project_or_404(db, project_id, user.id)
    participant = (
        db.query(Participant)
        .filter(Participant.id == participant_id, Participant.project_id == project_id)
        .first()
    )
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found")

    row = (
        db.query(DatasetRowModel)
        .filter(DatasetRowModel.id == req.row_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Dataset row not found")

    if row.participant_id != participant_id:
        raise HTTPException(
            status_code=409,
            detail="Row is not linked to this participant",
        )

    row.participant_id = None

    log_action(
        db,
        action="unlinked_participant",
        entity_type="dataset_row",
        entity_id=row.id,
        user_id=user.id,
        project_id=participant.project_id,
        details={
            "dataset_id": row.dataset_id,
            "participant_id": participant_id,
        },
    )
    db.commit()

    # Reload with relations for full detail response
    participant = _load_participant_with_relations(db, participant_id)
    return _participant_to_detail(participant, db)


@router.delete("/api/projects/{project_id}/participants/{participant_id}")
async def delete_participant(
    project_id: int,
    participant_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a participant. Speaker.participant_id will be set to NULL via ondelete='SET NULL'."""
    _get_project_or_404(db, project_id, user.id)
    participant = (
        db.query(Participant)
        .filter(Participant.id == participant_id, Participant.project_id == project_id)
        .first()
    )
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found")

    project_id = participant.project_id
    participant_identifier = participant.identifier

    log_action(
        db,
        action="deleted",
        entity_type="participant",
        entity_id=participant.id,
        user_id=user.id,
        project_id=project_id,
        details={"identifier": participant_identifier},
    )
    db.delete(participant)
    db.commit()

    return {"status": "ok", "deleted_id": participant_id}
