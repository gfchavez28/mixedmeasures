from pydantic import BaseModel, Field
from datetime import datetime
from .common import UTCTimestamp


# ── Request schemas ─────────────────────────────────────────────────────────

class TextCodeRequest(BaseModel):
    dataset_value_id: int
    code_id: int
    attribution: str | None = None


class BulkCodeRequest(BaseModel):
    dataset_value_ids: list[int] = Field(..., min_length=1, max_length=5000)
    code_id: int


class BulkRemoveCodeRequest(BaseModel):
    dataset_value_ids: list[int] = Field(..., min_length=1, max_length=5000)
    code_id: int


class TextNoteCreate(BaseModel):
    dataset_value_id: int
    content: str


class TextNoteUpdate(BaseModel):
    content: str | None = None


class TextCodingConfigUpdate(BaseModel):
    view_mode: str | None = None
    focal_column_ids: list[int] | None = None
    dataset_filter_ids: list[int] | None = None
    random_seed: int | None = None
    context_visibility: dict | None = None
    hide_empty: bool | None = None
    starred_value_ids: list[int] | None = None
    treat_as_empty: list[str] | None = None


# ── Response schemas ────────────────────────────────────────────────────────

class TextResponse(BaseModel):
    dataset_value_id: int
    dataset_id: int
    dataset_name: str
    dataset_row_id: int
    row_identifier: str | None
    participant_id: int | None
    participant_name: str | None
    column_id: int
    column_name: str | None
    column_text: str
    column_sequence_order: int
    value_text: str | None
    word_count: int
    is_quoted: bool
    excerpt_id: int | None = None
    applied_code_ids: list[int]
    note_count: int


class TextsListResponse(BaseModel):
    texts: list[TextResponse]
    total_texts: int
    non_empty_texts: int
    coded_texts: int
    total_rows: int
    coded_rows: int


class RecordResponse(BaseModel):
    dataset_row_id: int
    row_identifier: str | None
    participant_id: int | None
    participant_name: str | None
    dataset_id: int
    dataset_name: str
    text_count: int
    coded_text_count: int
    linked_conversation_ids: list[int]


class RecordsListResponse(BaseModel):
    records: list[RecordResponse]
    total: int


class ColumnValueResponse(BaseModel):
    column_id: int
    column_name: str | None
    value: str | None


class NonTextValueResponse(BaseModel):
    column_id: int
    column_name: str | None
    value: str | None
    column_type: str
    sequence_order: int


class TextValueResponse(BaseModel):
    column_id: int
    column_name: str | None
    value: str | None
    sequence_order: int


class LinkedConversationResponse(BaseModel):
    id: int
    name: str


class ColumnPositionResponse(BaseModel):
    column_id: int
    column_name: str | None
    sequence_order: int
    column_type: str


class RecordContextResponse(BaseModel):
    row_identifier: str | None
    participant_id: int | None
    dataset_id: int
    dataset_name: str
    linked_conversations: list[LinkedConversationResponse]
    demographics: list[ColumnValueResponse]
    texts: list[TextValueResponse]
    other_columns: list[NonTextValueResponse]
    column_positions: list[ColumnPositionResponse]


class TextColumnResponse(BaseModel):
    column_id: int
    dataset_id: int
    dataset_name: str
    column_name: str | None
    column_text: str
    column_type: str
    sequence_order: int
    total_rows: int
    non_empty_rows: int
    coded_rows: int


class TextColumnsListResponse(BaseModel):
    columns: list[TextColumnResponse]


class ColumnProgressResponse(BaseModel):
    column_id: int
    column_name: str | None
    coded: int
    total: int


class CodingProgressResponse(BaseModel):
    by_column: list[ColumnProgressResponse]
    overall_texts: dict
    overall_records: dict


class TextCodingConfigResponse(BaseModel):
    view_mode: str
    focal_column_ids: list[int]
    dataset_filter_ids: list[int] | None
    random_seed: int | None
    context_visibility: dict
    hide_empty: bool
    starred_value_ids: list[int]
    treat_as_empty: list[str]


class TextCodeResponse(BaseModel):
    dataset_value_id: int
    code_id: int
    applied: bool
    created_at: UTCTimestamp | None = None


class BulkCodeResponse(BaseModel):
    results: list[TextCodeResponse]
    success_count: int
    error_count: int


class BulkRemoveCodeResponse(BaseModel):
    deleted_count: int
    code_id: int
