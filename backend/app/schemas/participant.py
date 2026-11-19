from pydantic import BaseModel, ConfigDict, Field, field_validator
from datetime import datetime
from typing import Literal
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
    #: #1157 — the sentence refusing a change to this link, or None when the link
    #: is the researcher's to change. Set for a row of a table the TOOL keeps in step
    #: with the participants (`participant_dataset.managed_dataset_refusal`), where
    #: an unlink only made the next refresh delete the row and every value typed
    #: into it. The client shows the sentence and offers no *Unlink*; it never
    #: re-derives the rule.
    link_refusal: str | None = None


class ParticipantCreate(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=100)
    display_name: str | None = Field(None, max_length=255)
    role: str | None = Field(None, max_length=100)
    demographics: str | None = None  # JSON string
    # #1190 D12 — an identifier a withdrawal tombstoned is refused (409,
    # `{"error": "withdrawn_identifier", "message"}`) unless the researcher confirms
    # it now names someone who agreed to take part.
    confirm_withdrawn: bool = False

    _trim_identifier = field_validator("identifier")(_strip_identifier)
    _trim_text = field_validator("display_name", "role")(_strip_optional_text)


class ParticipantUpdate(BaseModel):
    identifier: str | None = Field(None, min_length=1, max_length=100)
    display_name: str | None = Field(None, max_length=255)
    role: str | None = Field(None, max_length=100)
    demographics: str | None = None
    # #1190 D12 — the create's contract, for a rename TO a withdrawn identifier.
    confirm_withdrawn: bool = False

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
    #: #1320 — turns their words reached through a merge or a split (a combined
    #: or absent speaker). REQUIRED, like `documents` (#1123): a count the client
    #: can be missing is a count a sentence can forget.
    combined_turns: int
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


class WithdrawalDocumentTouchpoint(BaseModel):
    """A document this participant is the SUBJECT of (row 46).

    🔴 #1123 — the service has reported these since row 46, and this schema did
    not declare them, so FastAPI's response model dropped the list on the way out:
    the Participants page told a researcher that "nothing else in this project is
    linked" to someone a document is about, on the one report where an
    under-count is the failure that matters. `TestTheReportReachesTheWire` holds
    the service's fields and these to the same set.
    """

    document_id: int
    name: str
    segments: int = 0
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0
    #: #1702 (D382) — canvas quotes showing this document's passages; they stay with it.
    canvas_quotes: int = 0


class WithdrawalCanvasPlace(BaseModel):
    """#1546 D158 — one canvas section or snapshot holding quotes a withdrawal cannot
    place. The researcher's own names only, never the words."""

    canvas_id: int
    canvas_name: str
    #: The section's id, or the snapshot's.
    id: int
    name: str
    quotes: int


class WithdrawalUnplacedCanvasQuotes(BaseModel):
    """#1546 D158 — canvas quotes whose source is gone, so nothing says whose words they
    hold: the withdrawal LEAVES them, and a person reads them. `quotes` counts every
    embed, a snapshot's copy included."""

    quotes: int
    sections: list[WithdrawalCanvasPlace]
    snapshots: list[WithdrawalCanvasPlace]


class WithdrawalOtherProject(BaseModel):
    """#1606 D234 — another project here holding a participant with the same ID. The
    researcher's project name only, never what it holds."""

    project_id: int
    name: str
    #: "copy" — duplicated FROM this project; "source" — this project was duplicated
    #: from it; null — no Duplicate links them.
    copy_relation: Literal["copy", "source"] | None


class WithdrawalOtherProjects(BaseModel):
    """#1606 D234 — copies first, then by name, capped; `total` counts every one."""

    projects: list[WithdrawalOtherProject]
    total: int


class WithdrawalPreUpdateCopies(BaseModel):
    """#1606 D235 — the install's copies of the whole database taken before updates.
    `count` is null when the folder could not be read (never 0, which says none).
    `folder` is this computer's path: returned to the page, never stored."""

    count: int | None
    folder: str


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
    documents: list[WithdrawalDocumentTouchpoint] = []
    total_items: int = 0
    # #1190 D14 — records LINKED TO NOBODY whose identifier column carries this
    # participant's identifier (linking's own match: trim, then exact). Possibly hers,
    # not provably: the withdrawal never deletes them, and the count is NOT part of
    # `total_items`. A count only — never which records.
    unlinked_records_with_identifier: int = 0
    # #1546 D158 — REQUIRED (#1123's rule): a disclosure the wire can drop is one the
    # confirm can lose. Not part of `total_items`; the withdrawal leaves these.
    canvas_quotes_unplaced: WithdrawalUnplacedCanvasQuotes
    # Joint display slice 2 (r3-6) — REQUIRED (#1123's rule), NOT part of `total_items`:
    # picked "cases that don't fit" naming them, which the withdrawal removes with their
    # reasons (`canvas_embed_scrub.count_misfit_cases`).
    canvas_misfit_cases: int
    # #1674 D357 — REQUIRED (#1123's rule), NOT part of `total_items`: the drift stamps the
    # withdrawal clears (`canvas_embed_scrub.count_drift_stamps`).
    canvas_drift_stamps: int
    # #1606 D234/D235 — REQUIRED (#1123's rule), NOT part of `total_items`: where their
    # data still is that this withdrawal does not reach.
    other_projects_with_identifier: WithdrawalOtherProjects
    pre_update_copies: WithdrawalPreUpdateCopies
