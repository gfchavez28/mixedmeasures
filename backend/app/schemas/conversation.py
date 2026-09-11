from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp
from ..models.conversation import ConversationStatus
from ..services.media_duration import MAX_MEDIA_OFFSET_SECONDS


class ConversationCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    subject_id: str | None = None
    conversation_date: datetime | None = None


class ConversationUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    subject_id: str | None = None
    conversation_date: datetime | None = None
    status: ConversationStatus | None = None
    # ⚠️ NO `summary` — retired from the wire 2026-09-09 (#895), together with the
    # document half. The Summary panel shipped on both workbenches on 2026-03-22
    # and was removed 42 minutes later to cut the sidebar from four panels to
    # three, three months before v1.0.0 — so no released build ever wrote one and
    # no project can hold one. The COLUMN is kept, per that commit's own note.
    media_offset_seconds: float | None = None


class ConversationResponse(BaseModel):
    id: int
    project_id: int
    name: str
    subject_id: str | None
    conversation_date: datetime | None
    status: ConversationStatus
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
    # Derived: a media file (audio or video) is attached. The player gates on
    # media_type; this flag drives management affordances (badge, attach/remove).
    has_media: bool = False
    # On-disk size of the attached recording (slab 5 storage visibility);
    # None when no file is attached or the stat fails.
    media_size_bytes: int | None = None
    # Opaque cache token for the on-disk recording (#549): mtime_ns + size,
    # from the same stat as media_size_bytes. Changes on EVERY replace —
    # including a same-name re-export, which media_filename cannot detect —
    # so the client can cache-bust the stream URL and reload mounted media
    # elements. None when no file is attached or the file is missing.
    media_version: str | None = None

    model_config = ConfigDict(from_attributes=True)


class MediaOffsetUpdate(BaseModel):
    offset_seconds: float = Field(ge=-MAX_MEDIA_OFFSET_SECONDS, le=MAX_MEDIA_OFFSET_SECONDS)


class MediaUploadResponse(BaseModel):
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
