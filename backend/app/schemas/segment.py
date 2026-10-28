from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from datetime import datetime
from .common import UTCTimestamp, AppliedCodeDetail

from .excerpt import SegmentExcerptInfo


class ExcerptOffsetsItem(BaseModel):
    """A char-range quote placed EXACTLY by a text edit (#1319), in the new text's
    code points — an undo's captured pre-edit offsets, or a flagged quote kept
    at the span the researcher was shown."""
    excerpt_id: int
    start_offset: int = Field(..., ge=0)
    end_offset: int

    @model_validator(mode='after')
    def end_after_start(self) -> 'ExcerptOffsetsItem':
        if self.end_offset <= self.start_offset:
            raise ValueError('end_offset must be greater than start_offset')
        return self


class TextEditQuoteFields(BaseModel):
    """What a text edit does with the quotes it cannot follow on its own (#1319).

    Shared by both edit doors — `services/segment_operations.py::apply_text_edit`
    reads them. ``remove_excerpt_ids`` must equal the flagged quotes that
    ``excerpt_offsets`` does not place, or the edit is a 409.
    """
    remove_excerpt_ids: list[int] = []
    excerpt_offsets: list[ExcerptOffsetsItem] = []


class SegmentUpdateRequest(TextEditQuoteFields):
    text: str | None = None
    speaker_id: int | None = None

    @field_validator('text')
    @classmethod
    def text_not_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError('text must not be empty')
        return v

    @model_validator(mode='after')
    def quote_fields_need_text(self) -> 'SegmentUpdateRequest':
        if self.text is None and (self.remove_excerpt_ids or self.excerpt_offsets):
            raise ValueError('remove_excerpt_ids and excerpt_offsets apply only to a text edit')
        return self


class SegmentTextPreviewRequest(BaseModel):
    """The text a researcher is about to save — read-only, nothing is written."""
    text: str

    @field_validator('text')
    @classmethod
    def text_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError('text must not be empty')
        return v


class TextEditQuoteItem(BaseModel):
    """One char-range quote in a text edit's plan or report (#1319).

    ``outcome`` is the planner's: ``silent`` (followed automatically), ``edge`` (a
    change touches its edge from inside), ``straddle`` (a change crosses an edge)
    or ``gone`` (none of its words survive). Offsets are CODE POINTS (#687); the
    texts are given so a client never slices.
    """
    excerpt_id: int
    outcome: Literal['silent', 'edge', 'straddle', 'gone']
    old_start: int
    old_end: int
    new_start: int | None = None
    new_end: int | None = None
    old_text: str
    new_text: str | None = None
    has_note: bool = False
    removed: bool = False
    explicit: bool = False


class TextEditPlanResponse(BaseModel):
    """A text edit's quote plan (the preview) or what it did (the apply's report).

    ``text`` is the text as it is or will be STORED (a document strips it), so a
    client's offsets are in the right string. ``collisions`` are excerpt-id groups
    that would share one span if every flagged quote were kept as proposed.
    ``capped`` says the changed stretch was too long to follow word by word, so
    every quote inside it is offered rather than followed.
    """
    text: str
    quotes: list[TextEditQuoteItem] = []
    needs_confirmation: bool = False
    collisions: list[list[int]] = []
    capped: bool = False


class SpeakerResponse(BaseModel):
    id: int
    name: str
    is_facilitator: bool
    color_index: int
    color: str | None = None

    model_config = ConfigDict(from_attributes=True)


class SegmentNoteInfo(BaseModel):
    id: int
    sequence_number: int


class SegmentResponse(BaseModel):
    id: int
    conversation_id: int
    speaker_id: int | None
    speaker_name: str | None = None
    is_facilitator: bool = False
    speaker_color_index: int = 0
    speaker_color: str | None = None
    sequence_order: int
    start_time: float | None
    end_time: float | None
    text: str
    group_id: int | None
    excerpts: list[SegmentExcerptInfo] = []
    applied_codes: list[int] = []  # List of code IDs
    applied_code_details: list[AppliedCodeDetail] = []  # Per-application coder attribution (Track J · J1)
    attached_notes: list[SegmentNoteInfo] = []  # Notes attached to this segment
    is_merged: bool = False  # True if this segment was created by merging others (can be unmerged)
    is_split: bool = False  # True if this segment was created by splitting another (can be rejoined)
    created_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class SegmentUpdateResponse(SegmentResponse):
    """The conversation edit door's answer: the segment, plus what a TEXT edit did
    to its quotes (#1319). ``quote_rebase`` is None for a speaker-only change."""
    quote_rebase: TextEditPlanResponse | None = None


class SegmentListResponse(BaseModel):
    segments: list[SegmentResponse]
    total: int
    coded_count: int
    participant_total: int
    participant_coded: int


class SpeakerUpdateRequest(BaseModel):
    is_facilitator: bool


class SpeakerColorUpdateRequest(BaseModel):
    color: str | None = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')


class SegmentGroupRequest(BaseModel):
    segment_ids: list[int]


class SegmentGroupResponse(BaseModel):
    id: int
    segment_ids: list[int]


class SegmentMergeRequest(BaseModel):
    segment_ids: list[int]


class SegmentMergeResponse(BaseModel):
    merged_segment: SegmentResponse
    deleted_count: int


class SegmentUnmergeResponse(BaseModel):
    restored_segments: list[SegmentResponse]
    restored_count: int


class SegmentSplitRange(BaseModel):
    segment_id: int
    start_offset: int
    end_offset: int


class SegmentSplitRequest(BaseModel):
    ranges: list[SegmentSplitRange]

    @field_validator('ranges')
    @classmethod
    def at_least_one_range(cls, v: list[SegmentSplitRange]) -> list[SegmentSplitRange]:
        if not v:
            raise ValueError('At least one range is required')
        return v


class SegmentSplitResponse(BaseModel):
    new_segments: list[SegmentResponse]
    deleted_segment_ids: list[int]
    quote_notes_stayed: int = 0
    """#712 — notes that stayed on the original segment. They are not lost: an
    unsplit restores them. Disclosed HERE because the link is unrecoverable
    afterwards."""


class SegmentUnsplitResponse(BaseModel):
    restored_segment: SegmentResponse
    deleted_count: int
