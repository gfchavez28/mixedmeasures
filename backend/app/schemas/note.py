from pydantic import BaseModel, ConfigDict
from datetime import datetime
from .common import UTCTimestamp


class NoteCreate(BaseModel):
    content: str
    segment_id: int | None = None
    excerpt_id: int | None = None


class NoteUpdate(BaseModel):
    content: str | None = None
    segment_id: int | None = None
    is_archived: bool | None = None


class NoteResponse(BaseModel):
    id: int
    conversation_id: int | None
    segment_id: int | None
    dataset_value_id: int | None = None
    excerpt_id: int | None = None
    content: str
    sequence_number: int
    is_archived: bool
    created_at: UTCTimestamp
    updated_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class NoteListResponse(BaseModel):
    notes: list[NoteResponse]
    total: int


# --- All-Notes hierarchy schemas ---

class AllNotesConversationNote(BaseModel):
    id: int
    content: str
    sequence_number: int
    segment_id: int | None
    segment_text: str | None = None
    created_at: UTCTimestamp


class AllNotesSpeaker(BaseModel):
    speaker_id: int | None
    speaker_name: str
    notes: list[AllNotesConversationNote]


class AllNotesConversation(BaseModel):
    conversation_id: int
    conversation_name: str
    general_notes: list[AllNotesConversationNote]
    speakers: list[AllNotesSpeaker]


class AllNotesCommentNote(BaseModel):
    id: int
    content: str
    sequence_number: int
    dataset_value_id: int
    source_text: str | None = None
    created_at: UTCTimestamp


class AllNotesRow(BaseModel):
    dataset_row_id: int
    row_label: str
    notes: list[AllNotesCommentNote]


class AllNotesColumn(BaseModel):
    column_id: int
    column_name: str | None
    column_text: str
    rows: list[AllNotesRow]


class AllNotesDocumentNote(BaseModel):
    id: int
    content: str
    sequence_number: int
    segment_id: int | None
    segment_text: str | None = None
    created_at: UTCTimestamp


class AllNotesDocument(BaseModel):
    document_id: int
    document_name: str
    notes: list[AllNotesDocumentNote]


class AllNotesObservationNote(BaseModel):
    id: int
    content: str
    sequence_number: int
    segment_id: int | None
    # The clip's LABEL, not transcript text — on an observation `Segment.text` is
    # the researcher's label for a time range and is frequently ''.
    segment_text: str | None = None
    created_at: UTCTimestamp


class AllNotesObservation(BaseModel):
    observation_id: int
    observation_name: str
    notes: list[AllNotesObservationNote]


class AllNotesResponse(BaseModel):
    """Every note in a project, grouped by the source it hangs off.

    ⚠️ **One group per Note PARENT — and `Note` has four.** A parent missing here
    is invisible on the Memos & Notes page even though the note exists and the
    workbench shows it (#515 for documents, #676 for observations: the reader was
    two parents behind the writer both times). `test_all_notes_arity.py` fails if
    a parent gains a `Note` FK without gaining a group here.
    """
    conversations: list[AllNotesConversation]
    texts: list[AllNotesColumn]
    documents: list[AllNotesDocument] = []
    observations: list[AllNotesObservation] = []
