from pydantic import BaseModel, ConfigDict, Field, field_validator
from datetime import datetime
from .common import UTCTimestamp, strip_optional_text, strip_required_text

# Trim a participant identifier; reject whitespace-only (#556a).
#
# `Participant.identifier` is the join key for the trim-then-exact linking seam
# (`services/participant_linking.py`) AND the field speaker names land in — so a
# padded value (`" P001 "`) written via API/script is permanently unreachable by
# every matcher and silently mints a duplicate participant. Trimming at the schema
# makes the value that gets uniqueness-checked the value that gets stored (a padded
# `" P001 "` now correctly 409s against `P001` instead of creating a twin). Same
# move #534 made at the speaker seam.
#
# 🔴 **The rule and its ordering trap moved to `common.py::strip_required_text`
# (#925)** — `DatasetCreate` and `DatasetUpdate` had the same hole, and a second
# copy of a trim rule is how the two drift. The message is unchanged.
_strip_identifier = strip_required_text("identifier")

# `display_name` propagates to linked speaker names, so padding leaks into the
# transcript UI. An all-whitespace name already behaved as absent
# (`display_name or identifier`), so normalizing it to None is what the code
# downstream already assumed.
_strip_optional_text = strip_optional_text


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


class LinkedDocumentInfo(BaseModel):
    """One document this participant is the subject of (row 46).

    Unlike `DatasetRowInfo`, this list is genuinely unbounded per participant —
    `Document.participant_id` carries no unique index, because the motivating
    case is several documents about one subject (successive workplans, an
    interview plus its artefacts).
    """
    id: int
    name: str
    source_format: str


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
    linked_documents: list[LinkedDocumentInfo] = []

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


# ── Withdrawal report (#702(2)) ──────────────────────────────────────────────


class WithdrawalConversationTouchpoint(BaseModel):
    conversation_id: int
    name: str
    segments: int = 0
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0


class WithdrawalDatasetTouchpoint(BaseModel):
    dataset_id: int
    name: str
    rows: int = 0
    #: #896 — cells this person ANSWERED, excluding the tool's own columns.
    responses: int = 0
    #: #896 — cells the TOOL maintains on this person's rows (the identifier it
    #: wrote, the rating scores it derived). Reported rather than dropped: the
    #: row traces back to the person and a withdrawal must account for it, but
    #: calling a derived score a "response" tells a researcher they answered a
    #: question that was never asked — on the one report where a wrong number is
    #: expensive. Zero on every ordinary dataset.
    tool_maintained_values: int = 0
    #: `Dataset.managed_kind`, or None for an ordinary dataset — what the record
    #: IS, so a row with zero responses reads as explained rather than empty.
    managed_kind: str | None = None
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0
    memos: int = 0
    row_scores: int = 0


class WithdrawalReportResponse(BaseModel):
    """Everything in the project that traces back to one participant.

    Counts and locations only — never the text. A report reproducing transcript
    lines or response values would be one more copy of the data a researcher is
    trying to remove.
    """

    participant_id: int
    identifier: str
    display_name: str | None = None
    role: str | None = None
    has_demographics: bool = False
    # Project-scoped, like `Speaker` itself — and the field that SURVIVES a
    # participant delete, which is why the report names it.
    speaker_names: list[str] = []
    conversations: list[WithdrawalConversationTouchpoint] = []
    datasets: list[WithdrawalDatasetTouchpoint] = []
    total_items: int = 0
