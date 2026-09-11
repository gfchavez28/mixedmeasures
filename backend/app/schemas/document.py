from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp
from .segment import SegmentNoteInfo


# --- Request schemas ---

class DocumentUpdateRequest(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    # ⚠️ NO `summary` — retired from the wire 2026-09-09 (#895). The COLUMN is
    # kept (`models/document.py`), so nothing is dropped from an existing
    # database or from a `.mmproject`, which serialises by reflection.
    # Row 46 — "this document is about…". `None` is a MEANINGFUL value here
    # (unlink), unlike the three fields above where it only ever means "not
    # supplied". That distinction survives because `update_document` applies
    # `model_dump(exclude_unset=True)`: an omitted key is absent from the dump,
    # an explicit `null` is present with value None. Do NOT rewrite that loop
    # to skip falsy values — unlinking would silently become a no-op.
    participant_id: int | None = None


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
    # Row 46. Both halves travel together on purpose: the id is what an edit
    # sends back, the label is the only half that can be rendered. A payload
    # carrying one of them makes every consumer fetch or guess the other.
    participant_id: int | None = None
    participant_label: str | None = None

    model_config = ConfigDict(from_attributes=True)


class SegmentCodeResponse(BaseModel):
    id: int
    name: str
    color: str | None = None
    is_universal: bool = False  # lets the coding workbench exclude universal-only segments from "coded" (#398 / invariant J-A)
    user_id: int | None = None  # coder who applied this code (Track J · J1)
    # #35 / #868 (a) — this coder's rating and the merge disagreement flag. The
    # document router is the FOURTH builder of a per-application code list, and it
    # carried neither field while the workbench fabricated details from it — so
    # every scaled-code chip on a document announced "not rated" over a rating it
    # could not see. null = UNRATED, never 0 (the falsy-zero class).
    magnitude: float | None = None
    magnitude_conflict: float | None = None


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
    # ⚠️ NO `summary` — see `DocumentUpdateRequest` (#895). This one was declared
    # and never populated: `get_document` builds the response explicitly and
    # never passed it, so it answered `null` on every request for five months.
    source_format: str
    segmentation_mode: str
    segment_count: int = 0
    coded_segment_count: int = 0
    page_count: int | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    # Row 46 — see `DocumentListItem`; the workbench needs both halves too.
    participant_id: int | None = None
    participant_label: str | None = None
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
    quote_notes_stayed: int = 0
    """#712 — notes that stayed on the original segment. They are not lost: an
    unsplit restores them. Disclosed HERE because the link is unrecoverable
    afterwards."""


class DocumentUnsplitResponse(BaseModel):
    restored_segment: DocumentSegmentResponse
    deleted_count: int


class RecentDocument(BaseModel):
    id: int
    name: str
    updated_at: UTCTimestamp
    segment_count: int = 0
    coded_segment_count: int = 0
