from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from ..database import get_db
from ..models.user import User
from ..models.note import Note
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.participant import Participant
from ..models.speaker import Speaker
from ..schemas.note import (
    AllNotesConversationNote,
    AllNotesSpeaker,
    AllNotesConversation,
    AllNotesCommentNote,
    AllNotesRow,
    AllNotesColumn,
    AllNotesDocumentNote,
    AllNotesDocument,
    AllNotesResponse,
)
from ..auth import get_current_user
from .helpers import _get_project_or_404

router = APIRouter(prefix="/api/projects", tags=["all-notes"])


@router.get("/{project_id}/all-notes", response_model=AllNotesResponse)
async def get_all_notes(
    project_id: int,
    search: str | None = Query(None, min_length=1),
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all notes for a project, grouped hierarchically."""
    _get_project_or_404(db, project_id, user.id)

    # --- Query 1: Conversation notes ---
    conv_notes_q = (
        db.query(Note)
        .join(Conversation, Note.conversation_id == Conversation.id)
        .outerjoin(Segment, Note.segment_id == Segment.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .options(
            joinedload(Note.segment).joinedload(Segment.speaker),
            joinedload(Note.conversation),
        )
        .filter(
            Conversation.project_id == project_id,
            Note.conversation_id.isnot(None),
        )
    )
    if not include_archived:
        conv_notes_q = conv_notes_q.filter(Note.is_archived == False)  # noqa: E712
    escaped_search = None
    if search:
        escaped_search = search.replace("%", r"\%").replace("_", r"\_")
        conv_notes_q = conv_notes_q.filter(Note.content.ilike(f"%{escaped_search}%", escape="\\"))

    conv_notes = conv_notes_q.order_by(Conversation.name, Note.sequence_number).all()

    # Group by conversation, then by speaker
    conv_map: dict[int, dict] = {}
    for note in conv_notes:
        conv = note.conversation
        cid = conv.id
        if cid not in conv_map:
            conv_map[cid] = {
                "conversation_id": cid,
                "conversation_name": conv.name,
                "general_notes": [],
                "speakers": {},
            }

        # Truncate segment text to 200 chars for context preview
        segment_text = None
        if note.segment and note.segment.text:
            raw = note.segment.text
            segment_text = raw[:200] + ("..." if len(raw) > 200 else "")

        note_data = AllNotesConversationNote(
            id=note.id,
            content=note.content,
            sequence_number=note.sequence_number,
            segment_id=note.segment_id,
            segment_text=segment_text,
            created_at=note.created_at,
        )

        if note.segment_id is None:
            # Floating note (not attached to a segment)
            conv_map[cid]["general_notes"].append(note_data)
        else:
            speaker = note.segment.speaker if note.segment else None
            speaker_id = speaker.id if speaker else None
            speaker_name = speaker.name if speaker else "Unknown Speaker"

            if speaker_id not in conv_map[cid]["speakers"]:
                conv_map[cid]["speakers"][speaker_id] = {
                    "speaker_id": speaker_id,
                    "speaker_name": speaker_name,
                    "notes": [],
                }
            conv_map[cid]["speakers"][speaker_id]["notes"].append(note_data)

    conversations_result = []
    for cdata in conv_map.values():
        speakers_list = [
            AllNotesSpeaker(**s) for s in cdata["speakers"].values()
        ]
        conversations_result.append(
            AllNotesConversation(
                conversation_id=cdata["conversation_id"],
                conversation_name=cdata["conversation_name"],
                general_notes=cdata["general_notes"],
                speakers=speakers_list,
            )
        )

    # --- Query 2: Comment notes ---
    comment_notes_q = (
        db.query(Note, DatasetValue, DatasetColumn, DatasetRow, Participant)
        .join(DatasetValue, Note.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
        .filter(
            Dataset.project_id == project_id,
            Note.dataset_value_id.isnot(None),
        )
    )
    if not include_archived:
        comment_notes_q = comment_notes_q.filter(Note.is_archived == False)  # noqa: E712
    if search:
        comment_notes_q = comment_notes_q.filter(Note.content.ilike(f"%{escaped_search}%", escape="\\"))

    comment_notes = comment_notes_q.order_by(
        DatasetColumn.column_name, DatasetRow.id
    ).all()

    # Group by column, then by row
    col_map: dict[int, dict] = {}
    for note, dv, col, row, participant in comment_notes:
        cid = col.id
        if cid not in col_map:
            col_map[cid] = {
                "column_id": cid,
                "column_name": col.column_name,
                "column_text": col.column_text,
                "rows": {},
            }

        # Truncate source text to 200 chars for context preview
        source_text = None
        if dv.value_text:
            raw = dv.value_text
            source_text = raw[:200] + ("..." if len(raw) > 200 else "")

        note_data = AllNotesCommentNote(
            id=note.id,
            content=note.content,
            sequence_number=note.sequence_number,
            dataset_value_id=dv.id,
            source_text=source_text,
            created_at=note.created_at,
        )

        rid = row.id
        if rid not in col_map[cid]["rows"]:
            label = (
                (participant.display_name if participant and participant.display_name else None)
                or row.row_identifier
                or f"Row {rid}"
            )
            col_map[cid]["rows"][rid] = {
                "dataset_row_id": rid,
                "row_label": label,
                "notes": [],
            }
        col_map[cid]["rows"][rid]["notes"].append(note_data)

    texts_result = []
    for cdata in col_map.values():
        rows_list = [
            AllNotesRow(**r) for r in cdata["rows"].values()
        ]
        texts_result.append(
            AllNotesColumn(
                column_id=cdata["column_id"],
                column_name=cdata["column_name"],
                column_text=cdata["column_text"],
                rows=rows_list,
            )
        )

    # --- Query 3: Document notes ---
    doc_notes_q = (
        db.query(Note)
        .join(Document, Note.document_id == Document.id)
        .outerjoin(Segment, Note.segment_id == Segment.id)
        .options(
            joinedload(Note.segment),
            joinedload(Note.document),
        )
        .filter(
            Document.project_id == project_id,
            Note.document_id.isnot(None),
        )
    )
    if not include_archived:
        doc_notes_q = doc_notes_q.filter(Note.is_archived == False)  # noqa: E712
    if search:
        doc_notes_q = doc_notes_q.filter(Note.content.ilike(f"%{escaped_search}%", escape="\\"))

    doc_notes = doc_notes_q.order_by(Document.name, Note.id).all()

    doc_map: dict[int, dict] = {}
    for note in doc_notes:
        doc = note.document
        did = doc.id
        if did not in doc_map:
            doc_map[did] = {
                "document_id": did,
                "document_name": doc.name,
                "notes": [],
            }

        segment_text = None
        if note.segment and note.segment.text:
            raw = note.segment.text
            segment_text = raw[:200] + ("..." if len(raw) > 200 else "")

        doc_map[did]["notes"].append(AllNotesDocumentNote(
            id=note.id,
            content=note.content,
            sequence_number=note.sequence_number,
            segment_id=note.segment_id,
            segment_text=segment_text,
            created_at=note.created_at,
        ))

    documents_result = [AllNotesDocument(**d) for d in doc_map.values()]

    return AllNotesResponse(
        conversations=conversations_result,
        texts=texts_result,
        documents=documents_result,
    )
