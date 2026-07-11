from pydantic import BaseModel, ConfigDict, Field, field_validator
from datetime import datetime
from .common import UTCTimestamp


def _strip_identifier(v: str | None) -> str | None:
    """Trim a participant identifier; reject whitespace-only (#556a).

    `Participant.identifier` is the join key for the trim-then-exact linking
    seam (`services/participant_linking.py`) AND the field speaker names land
    in — so a padded value (`" P001 "`) written via API/script is permanently
    unreachable by every matcher and silently mints a duplicate participant.
    Trim at the schema so the value that gets uniqueness-checked is the value
    that gets stored (a padded `" P001 "` now correctly 409s against `P001`
    instead of creating a twin). Same move #534 made at the speaker seam.

    NOTE the ordering trap: `min_length=1` is a CONSTRAINT, checked on the raw
    input BEFORE this after-validator runs — so `" "` passes it and arrives
    here. The empty-after-strip check below is what actually rejects it.
    """
    if v is None:
        return None
    stripped = v.strip()
    if not stripped:
        raise ValueError("identifier cannot be blank or whitespace-only")
    return stripped


def _strip_optional_text(v: str | None) -> str | None:
    """Trim a nullable display field; blank-after-strip normalizes to None.

    `display_name` propagates to linked speaker names, so padding leaks into
    the transcript UI. An all-whitespace name already behaved as absent
    (`display_name or identifier`), so normalizing it to None is what the code
    downstream already assumed.
    """
    if v is None:
        return None
    stripped = v.strip()
    return stripped or None


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

    _trim_identifier = field_validator("identifier")(_strip_identifier)
    _trim_text = field_validator("display_name", "role")(_strip_optional_text)


class ParticipantUpdate(BaseModel):
    identifier: str | None = Field(None, min_length=1, max_length=100)
    display_name: str | None = Field(None, max_length=255)
    role: str | None = Field(None, max_length=100)
    demographics: str | None = None

    _trim_identifier = field_validator("identifier")(_strip_identifier)
    _trim_text = field_validator("display_name", "role")(_strip_optional_text)


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
