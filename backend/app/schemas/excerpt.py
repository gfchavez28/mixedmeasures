from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from datetime import datetime
from .common import UTCTimestamp


class ExcerptCreate(BaseModel):
    segment_id: int | None = None
    dataset_value_id: int | None = None
    start_offset: int | None = None
    end_offset: int | None = None

    @model_validator(mode='after')
    def exactly_one_target(self):
        has_seg = self.segment_id is not None
        has_dv = self.dataset_value_id is not None
        if has_seg == has_dv:
            raise ValueError('Exactly one of segment_id or dataset_value_id must be provided')
        if has_dv and (self.start_offset is not None or self.end_offset is not None):
            raise ValueError('Offsets are not supported for comment excerpts')
        if has_seg:
            start, end = self.start_offset, self.end_offset
            if (start is None) != (end is None):
                raise ValueError('start_offset and end_offset must both be set or both be null')
            if start is not None and end is not None:
                if start < 0:
                    raise ValueError('start_offset must be >= 0')
                if end <= start:
                    raise ValueError('end_offset must be greater than start_offset')
        return self


class ExcerptBulkCreate(BaseModel):
    items: list[ExcerptCreate]

    @field_validator('items')
    @classmethod
    def at_least_one(cls, v: list[ExcerptCreate]) -> list[ExcerptCreate]:
        if not v:
            raise ValueError('At least one excerpt is required')
        if len(v) > 500:
            raise ValueError('Maximum 500 excerpts per bulk request')
        return v


class SegmentExcerptInfo(BaseModel):
    """Lightweight excerpt info included in segment responses."""
    id: int
    start_offset: int | None
    end_offset: int | None
    has_note: bool
    note_id: int | None = None
    note_preview: str | None = None

    model_config = ConfigDict(from_attributes=True)


class ExcerptNoteInfo(BaseModel):
    """Note info included in excerpt responses."""
    id: int
    content: str
    created_at: UTCTimestamp


class ExcerptResponse(BaseModel):
    id: int
    segment_id: int | None
    dataset_value_id: int | None = None
    start_offset: int | None
    end_offset: int | None
    excerpt_text: str
    conversation_id: int | None = None
    conversation_name: str | None = None
    speaker_name: str | None = None
    segment_timestamp: float | None = None
    note: ExcerptNoteInfo | None = None
    has_note: bool
    created_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class ExcerptDetailResponse(ExcerptResponse):
    """Extended response with surrounding context segments."""
    context_before: str | None = None
    context_after: str | None = None
    segment_text: str | None = None


class ExcerptListResponse(BaseModel):
    excerpts: list[ExcerptResponse]
    total: int


# ── Quoted Excerpts ────────────────────────────────────────────────────────

class QuotedExcerptCode(BaseModel):
    id: int
    name: str
    color: str | None = None
    category_id: int | None = None
    category_name: str | None = None
    category_color: str | None = None


class QuotedExcerptItem(BaseModel):
    excerpt_id: int
    source_type: str  # "segment" or "comment"
    segment_id: int | None = None
    dataset_value_id: int | None = None
    text: str
    full_segment_text: str
    is_sub_segment: bool
    start_offset: int | None = None
    end_offset: int | None = None
    speaker_name: str | None = None
    speaker_is_facilitator: bool = False
    participant_id: int | None = None
    participant_name: str | None = None
    source_name: str
    sequence_order: int | None = None
    conversation_id: int | None = None
    conversation_date: datetime | None = None
    conversation_sort_key: int | None = None
    document_id: int | None = None
    document_name: str | None = None
    dataset_id: int | None = None
    dataset_name: str | None = None
    column_id: int | None = None
    column_name: str | None = None
    applied_code_ids: list[int]
    applied_codes: list[QuotedExcerptCode]
    excerpt_note: str | None = None
    context_before: str | None = None
    context_before_speaker: str | None = None
    created_at: UTCTimestamp


class QuotedExcerptsResponse(BaseModel):
    excerpts: list[QuotedExcerptItem]
    total_excerpts: int
    total_conversation_excerpts: int
    total_comment_excerpts: int
    total_document_excerpts: int = 0
