from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.segment import Segment
from ..models.note import Note
from ..models.excerpt import Excerpt
from ..schemas.note import NoteCreate, NoteUpdate, NoteResponse, NoteListResponse
from ..auth import get_current_user
from ..services.audit import log_action
from .helpers import _get_project_or_404, _verify_conversation_ownership

router = APIRouter(tags=["notes"])


def _validate_note_parent(db: Session, note: Note) -> int:
    """Validate note's parent exists and return project_id."""
    if note.conversation_id:
        conv = db.query(Conversation).filter(Conversation.id == note.conversation_id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Note's parent conversation not found")
        return conv.project_id
    elif note.document_id:
        doc = db.query(Document).filter(Document.id == note.document_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="Note's parent document not found")
        return doc.project_id
    elif note.dataset_value_id:
        dataset = (
            db.query(Dataset)
            .join(DatasetColumn, DatasetColumn.dataset_id == Dataset.id)
            .join(DatasetValue, DatasetValue.column_id == DatasetColumn.id)
            .filter(DatasetValue.id == note.dataset_value_id)
            .first()
        )
        if not dataset:
            raise HTTPException(status_code=404, detail="Note's parent comment not found")
        return dataset.project_id
    raise HTTPException(status_code=404, detail="Note has no valid parent")


@router.get("/api/conversations/{conversation_id}/notes", response_model=NoteListResponse)
async def list_notes(
    conversation_id: int,
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all notes for a conversation."""
    _verify_conversation_ownership(db, conversation_id, user.id)

    query = db.query(Note).filter(Note.conversation_id == conversation_id)
    if not include_archived:
        query = query.filter(Note.is_archived == False)

    notes = query.order_by(Note.sequence_number).all()

    return NoteListResponse(
        notes=[NoteResponse.model_validate(n) for n in notes],
        total=len(notes)
    )


@router.post("/api/conversations/{conversation_id}/notes", response_model=NoteResponse)
async def create_note(
    conversation_id: int,
    data: NoteCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new note for a conversation."""
    conversation = _verify_conversation_ownership(db, conversation_id, user.id)

    # Validate segment if provided
    if data.segment_id:
        segment = db.query(Segment).filter(
            Segment.id == data.segment_id,
            Segment.conversation_id == conversation_id
        ).first()
        if not segment:
            raise HTTPException(status_code=400, detail="Segment not found in this conversation")

    # Validate excerpt if provided
    excerpt_id = None
    if data.excerpt_id:
        excerpt = db.query(Excerpt).filter(
            Excerpt.id == data.excerpt_id,
            Excerpt.project_id == conversation.project_id,
        ).first()
        if not excerpt:
            raise HTTPException(status_code=400, detail="Excerpt not found")
        # Check if excerpt already has a note
        existing_note = db.query(Note).filter(
            Note.excerpt_id == data.excerpt_id,
            Note.is_archived == False
        ).first()
        if existing_note:
            raise HTTPException(status_code=409, detail="Excerpt already has a note")
        excerpt_id = data.excerpt_id
        # Auto-set segment_id from excerpt so note appears in segment's attached_notes
        if not data.segment_id and excerpt.segment_id:
            data.segment_id = excerpt.segment_id

    # Get next sequence number
    max_seq = db.query(func.max(Note.sequence_number)).filter(
        Note.conversation_id == conversation_id
    ).scalar() or 0

    note = Note(
        conversation_id=conversation_id,
        segment_id=data.segment_id,
        excerpt_id=excerpt_id,
        content=data.content,
        sequence_number=max_seq + 1
    )
    db.add(note)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="note",
        entity_id=note.id,
        user_id=user.id,
        project_id=conversation.project_id,
        details={"conversation_id": conversation_id, "segment_id": data.segment_id}
    )
    db.commit()

    return NoteResponse.model_validate(note)


@router.get("/api/projects/{project_id}/notes/{note_id}", response_model=NoteResponse)
async def get_note(
    project_id: int,
    note_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a single note."""
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    actual_project_id = _validate_note_parent(db, note)
    if actual_project_id != project_id:
        raise HTTPException(status_code=404, detail="Note not found")

    return NoteResponse.model_validate(note)


@router.patch("/api/projects/{project_id}/notes/{note_id}", response_model=NoteResponse)
async def update_note(
    project_id: int,
    note_id: int,
    data: NoteUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a note's content or segment association."""
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    actual_project_id = _validate_note_parent(db, note)
    if actual_project_id != project_id:
        raise HTTPException(status_code=404, detail="Note not found")

    # Validate segment if being updated
    if data.segment_id is not None:
        if data.segment_id != 0:  # 0 means disassociate
            segment = db.query(Segment).filter(
                Segment.id == data.segment_id,
                Segment.conversation_id == note.conversation_id
            ).first()
            if not segment:
                raise HTTPException(status_code=400, detail="Segment not found in this conversation")
            note.segment_id = data.segment_id
        else:
            note.segment_id = None

    if data.content is not None:
        note.content = data.content

    log_action(
        db,
        action="updated",
        entity_type="note",
        entity_id=note.id,
        user_id=user.id,
        project_id=project_id,
        details=data.model_dump(exclude_unset=True)
    )
    db.commit()
    db.refresh(note)

    return NoteResponse.model_validate(note)


@router.delete("/api/projects/{project_id}/notes/{note_id}")
async def archive_note(
    project_id: int,
    note_id: int,
    permanent: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Archive or permanently delete a note."""
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    actual_project_id = _validate_note_parent(db, note)
    if actual_project_id != project_id:
        raise HTTPException(status_code=404, detail="Note not found")

    if permanent:
        db.delete(note)
        action = "deleted"
    else:
        note.is_archived = True
        action = "archived"

    log_action(
        db,
        action=action,
        entity_type="note",
        entity_id=note_id,
        user_id=user.id,
        project_id=project_id,
    )
    db.commit()

    return {"status": "ok", "action": action, "note_id": note_id}


