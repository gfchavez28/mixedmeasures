from pydantic import BaseModel, ConfigDict
from datetime import datetime


# Lightweight result types for search display

class SegmentSearchResult(BaseModel):
    id: int
    # #569 RETIRED 2026-08-09 (beat ended at the cut after v1.3.0): `conversation_id`
    # — overloaded with the DOCUMENT id on doc hits — and `source_type` are GONE.
    # `source_kind` + `source_id` is the only source identity. ⚠️ Never re-introduce
    # an id field whose MEANING depends on another field; that overload silently
    # routed doc hits through a conversation-shaped id for two releases.
    conversation_name: str = ""  # the SOURCE display name (conv/doc/observation)
    speaker_name: str | None = None
    is_facilitator: bool = False
    start_time: float | None = None  # clip hits: the clip's start (timecode subtitle)
    text: str
    sequence_order: int
    is_quoted: bool = False
    source_kind: str = "conversation"  # "conversation" | "document" | "observation"
    source_id: int | None = None  # the id in source_kind's namespace — the honest pair

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
    # #569 RETIRED 2026-08-09 — see SegmentSearchResult. `conversation_id` and
    # `source_type` are gone; `source_kind` + `source_id` identify the source.
    conversation_name: str
    segment_id: int | None
    segment_text_preview: str | None  # First ~100 chars of attached segment
    content: str
    sequence_number: int
    source_kind: str = "conversation"  # "conversation" | "document" | "observation"
    source_id: int | None = None  # the id in source_kind's namespace — the honest pair

    model_config = ConfigDict(from_attributes=True)


class DocumentSearchResult(BaseModel):
    id: int
    name: str
    segment_count: int
    source_format: str | None = None

    model_config = ConfigDict(from_attributes=True)


class ObservationSearchResult(BaseModel):
    """Observation NAME hit (the 4th name block — conv/doc each had one)."""
    id: int
    name: str
    segment_count: int  # visible clip count
    has_media: bool = False

    model_config = ConfigDict(from_attributes=True)


class TextSearchResult(BaseModel):
    id: int  # dataset_value_id
    value_text: str
    column_name: str
    column_id: int
    row_identifier: str | None = None
    is_quoted: bool = False
    applied_code_count: int = 0
    # #834: the hit's RECORD and its dataset. Without these the click could only
    # reach the column — `id` is the dataset_value_id and `row_identifier` is a
    # human label, so the client knew *which text* matched and had no way to
    # address the row it belongs to, in a project that may hold several datasets
    # with identically-named open-text columns.
    dataset_id: int
    dataset_name: str
    row_id: int

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


class ObservationSearchResults(BaseModel):
    count: int
    items: list[ObservationSearchResult]


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
    observations: ObservationSearchResults | None = None
    text: TextSearchResults | None = None
    canvases: CanvasSearchResults | None = None
