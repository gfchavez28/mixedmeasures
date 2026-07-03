from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp


class LinkedConversationRef(BaseModel):
    id: int
    name: str


class LinkedSpeakerInfo(BaseModel):
    speaker_id: int
    speaker_name: str
    is_facilitator: bool
    # #422b: structured (id + name) so the participant detail panel can link
    # each conversation; was a bare list[str] of names.
    conversations: list[LinkedConversationRef]
    color_index: int = 0
    color: str | None = None


class DatasetRowInfo(BaseModel):
    id: int
    dataset_name: str
    dataset_id: int
    row_identifier: str | None = None
    submitted_at: UTCTimestamp | None = None


class ParticipantCreate(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=100)
    display_name: str | None = Field(None, max_length=255)
    role: str | None = Field(None, max_length=100)
    demographics: str | None = None  # JSON string


class ParticipantUpdate(BaseModel):
    identifier: str | None = Field(None, min_length=1, max_length=100)
    display_name: str | None = Field(None, max_length=255)
    role: str | None = Field(None, max_length=100)
    demographics: str | None = None


class ParticipantResponse(BaseModel):
    id: int
    project_id: int
    identifier: str
    display_name: str | None
    role: str | None
    demographics: str | None
    role_auto_filled_from: str | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    linked_speakers: list[LinkedSpeakerInfo]
    dataset_rows: list[DatasetRowInfo]

    model_config = ConfigDict(from_attributes=True)


class LinkedDemographicValue(BaseModel):
    column_id: int
    column_text: str
    demographic_subtype: str | None = None
    value: str | None = None
    dataset_name: str
    dataset_id: int
    # #353: original column type so the frontend can format by-type (numeric
    # right-aligned tabular-nums, multi-select as chips, ordinal/nominal as
    # labels, demographic preserved). Field name kept as `linked_demographics`
    # for backwards-compat — broadened to "any non-text linked column"
    # post-#353 but the API contract stays.
    column_type: str | None = None


class ParticipantDetailResponse(ParticipantResponse):
    linked_demographics: list[LinkedDemographicValue] = []


class LinkDatasetRowRequest(BaseModel):
    dataset_id: int
    row_id: int


class UnlinkDatasetRowRequest(BaseModel):
    row_id: int


class ParticipantListResponse(BaseModel):
    participants: list[ParticipantResponse]
    total: int
