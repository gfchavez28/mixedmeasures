from pydantic import BaseModel, ConfigDict
from datetime import datetime


# Lightweight result types for search display

class SegmentSearchResult(BaseModel):
    id: int
    conversation_id: int | None = None
    conversation_name: str = ""
    speaker_name: str | None = None
    is_facilitator: bool = False
    start_time: float | None = None
    text: str
    sequence_order: int
    is_quoted: bool = False
    source_type: str = "conversation"  # "conversation" or "document"

    model_config = ConfigDict(from_attributes=True)


class CodeSearchResult(BaseModel):
    id: int
    numeric_id: int
    name: str
    description: str | None
    usage_count: int
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class ConversationSearchResult(BaseModel):
    id: int
    name: str
    subject_id: str | None
    conversation_date: datetime | None
    status: str  # ConversationStatus value (imported/in_progress/completed)
    summary: str | None
    segment_count: int

    model_config = ConfigDict(from_attributes=True)


class NoteSearchResult(BaseModel):
    id: int
    conversation_id: int
    conversation_name: str
    segment_id: int | None
    segment_text_preview: str | None  # First ~100 chars of attached segment
    content: str
    sequence_number: int
    source_type: str = "conversation"  # "conversation" or "document"

    model_config = ConfigDict(from_attributes=True)


class DocumentSearchResult(BaseModel):
    id: int
    name: str
    segment_count: int
    source_format: str | None = None

    model_config = ConfigDict(from_attributes=True)


class TextSearchResult(BaseModel):
    id: int  # dataset_value_id
    value_text: str
    column_name: str
    column_id: int
    row_identifier: str | None = None
    is_quoted: bool = False
    applied_code_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class MemoSearchResult(BaseModel):
    id: int
    numeric_id: int
    entity_type: str
    entity_id: int
    entity_name: str | None  # Resolved name (code name, conversation name, or None for project)
    title: str | None
    content: str

    model_config = ConfigDict(from_attributes=True)


# Typed result containers with counts

class SegmentSearchResults(BaseModel):
    count: int
    items: list[SegmentSearchResult]


class CodeSearchResults(BaseModel):
    count: int
    items: list[CodeSearchResult]


class ConversationSearchResults(BaseModel):
    count: int
    items: list[ConversationSearchResult]


class NoteSearchResults(BaseModel):
    count: int
    items: list[NoteSearchResult]


class MemoSearchResults(BaseModel):
    count: int
    items: list[MemoSearchResult]


class DocumentSearchResults(BaseModel):
    count: int
    items: list[DocumentSearchResult]


class TextSearchResults(BaseModel):
    count: int
    items: list[TextSearchResult]


class CanvasSearchResult(BaseModel):
    id: int  # synthetic: canvas_id * 100000 + theme_id
    canvas_id: int
    canvas_name: str
    match_type: str  # "theme" (name/desc) or "theme_content" (searchable_text)
    match_text: str
    theme_id: int | None = None
    theme_name: str | None = None

    model_config = ConfigDict(from_attributes=True)


class CanvasSearchResults(BaseModel):
    count: int
    items: list[CanvasSearchResult]


# Unified search response

class SearchResponse(BaseModel):
    query: str
    segments: SegmentSearchResults | None = None
    codes: CodeSearchResults | None = None
    conversations: ConversationSearchResults | None = None
    notes: NoteSearchResults | None = None
    memos: MemoSearchResults | None = None
    documents: DocumentSearchResults | None = None
    text: TextSearchResults | None = None
    canvases: CanvasSearchResults | None = None
