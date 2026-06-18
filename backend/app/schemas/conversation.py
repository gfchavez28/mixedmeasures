from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp
from ..models.conversation import ConversationStatus


class ConversationCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    subject_id: str | None = None
    conversation_date: datetime | None = None


class ConversationUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    subject_id: str | None = None
    conversation_date: datetime | None = None
    status: ConversationStatus | None = None
    summary: str | None = None
    media_offset_seconds: float | None = None


class ConversationResponse(BaseModel):
    id: int
    project_id: int
    name: str
    subject_id: str | None
    conversation_date: datetime | None
    status: ConversationStatus
    summary: str | None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    segment_count: int = 0
    coded_segment_count: int = 0
    speaker_count: int = 0
    code_count: int = 0
    # Media fields
    media_filename: str | None = None
    media_format: str | None = None
    media_type: str | None = None
    media_duration_seconds: float | None = None
    media_offset_seconds: float = 0.0
    media_is_vbr: bool | None = None
    has_audio: bool = False

    model_config = ConfigDict(from_attributes=True)


class AudioOffsetUpdate(BaseModel):
    offset_seconds: float = Field(ge=-300.0, le=300.0)


class AudioUploadResponse(BaseModel):
    media_filename: str
    media_format: str
    media_type: str
    media_duration_seconds: float | None
    media_offset_seconds: float
    media_is_vbr: bool | None = None


class ConversationListResponse(BaseModel):
    conversations: list[ConversationResponse]
    total: int


class CSVPreviewRequest(BaseModel):
    encoding: str = "utf-8"


class CSVPreviewResponse(BaseModel):
    headers: list[str]
    sample_rows: list[dict]
    total_rows: int
    unique_speakers: list[str]
    detected_columns: dict
    unique_values_by_column: dict[str, list[str]] = {}


class SpeakerMapping(BaseModel):
    original_label: str
    normalized_name: str
    is_facilitator: bool = False
    color_index: int = 0
    color: str | None = None


class CSVImportRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    subject_id: str | None = None
    conversation_date: datetime | None = None
    column_mapping: dict  # Maps 'speaker', 'text', 'start_time', 'end_time' to headers
    speaker_mappings: list[SpeakerMapping]
    encoding: str = "utf-8"


class ConversationImportResponse(BaseModel):
    """#356: wraps the imported ConversationResponse with import-time
    warnings (e.g. backward timestamps). Only returned by the import
    endpoint — read endpoints continue to return bare ConversationResponse
    so `warnings` doesn't pollute caches with always-empty arrays.
    """
    conversation: ConversationResponse
    warnings: list[str] = []
