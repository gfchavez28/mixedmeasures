from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp
from .segment import SegmentNoteInfo


# --- Request schemas ---

class DocumentUpdateRequest(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    summary: str | None = None


class DocumentNoteCreateRequest(BaseModel):
    segment_id: int
    content: str = Field(..., min_length=1)


# --- Response schemas ---

class DocumentListItem(BaseModel):
    id: int
    name: str
    description: str | None = None
    source_format: str
    segmentation_mode: str
    segment_count: int = 0
    coded_segment_count: int = 0
    page_count: int | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class SegmentCodeResponse(BaseModel):
    id: int
    name: str
    color: str | None = None
    is_universal: bool = False  # lets the coding workbench exclude universal-only segments from "coded" (#398 / invariant J-A)
    user_id: int | None = None  # coder who applied this code (Track J · J1)


class ExcerptInfo(BaseModel):
    has_whole_segment: bool = False
    sub_segment_count: int = 0


class DocumentSegmentResponse(BaseModel):
    id: int
    sequence_order: int
    text: str
    word_count: int | None = None
    page_number: int | None = None
    heading_level: int | None = None
    codes: list[SegmentCodeResponse] = []
    has_note: bool = False
    attached_notes: list[SegmentNoteInfo] = []
    excerpt_info: ExcerptInfo | None = None

    # Merge/split tracking
    merged_into_id: int | None = None
    is_merge_result: int = 0
    split_into_id: int | None = None
    is_split_result: int = 0


class DocumentImagePosition(BaseModel):
    index: int
    after_sequence_order: int


class ImagePositionUpdateRequest(BaseModel):
    after_sequence_order: int = Field(..., ge=0)


class DocumentSegmentUpdateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=100_000)


class DocumentDetailResponse(BaseModel):
    id: int
    name: str
    description: str | None = None
    summary: str | None = None
    source_format: str
    segmentation_mode: str
    segment_count: int = 0
    coded_segment_count: int = 0
    page_count: int | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    segments: list[DocumentSegmentResponse] = []
    image_positions: list[DocumentImagePosition] = []

    model_config = ConfigDict(from_attributes=True)


class DocumentImportResultItem(BaseModel):
    document_id: int | None = None
    name: str
    segment_count: int = 0
    warnings: list[str] = []
    error: str | None = None


class SegmentationPreviewSegment(BaseModel):
    sequence_order: int
    text: str
    page_number: int | None = None
    heading_level: int | None = None
    word_count: int = 0


class SegmentationPreviewResponse(BaseModel):
    total_segments: int = 0
    segments: list[SegmentationPreviewSegment] = []
    warnings: list[str] = []


class DocumentMergeRequest(BaseModel):
    segment_ids: list[int]


class DocumentMergeResponse(BaseModel):
    merged_segment: DocumentSegmentResponse
    deleted_count: int


class DocumentUnmergeResponse(BaseModel):
    restored_segments: list[DocumentSegmentResponse]
    restored_count: int


class DocumentSplitRange(BaseModel):
    segment_id: int
    start_offset: int
    end_offset: int


class DocumentSplitRequest(BaseModel):
    ranges: list[DocumentSplitRange]


class DocumentSplitResponse(BaseModel):
    new_segments: list[DocumentSegmentResponse]
    deleted_segment_ids: list[int]


class DocumentUnsplitResponse(BaseModel):
    restored_segment: DocumentSegmentResponse
    deleted_count: int


class RecentDocument(BaseModel):
    id: int
    name: str
    updated_at: UTCTimestamp
    segment_count: int = 0
    coded_segment_count: int = 0
