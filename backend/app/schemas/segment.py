from pydantic import BaseModel, ConfigDict, Field, field_validator
from datetime import datetime
from .common import UTCTimestamp, AppliedCodeDetail

from .excerpt import SegmentExcerptInfo


class SegmentUpdateRequest(BaseModel):
    text: str | None = None
    speaker_id: int | None = None

    @field_validator('text')
    @classmethod
    def text_not_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError('text must not be empty')
        return v


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


class SegmentUnsplitResponse(BaseModel):
    restored_segment: SegmentResponse
    deleted_count: int
