"""Pydantic schemas for the dataset import and read endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ═══════════════════════════════════════════════════════════════════════════════
# Preview schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DatasetColumnPreview(BaseModel):
    column_name: str
    column_index: int
    sample_values: list[str]
    unique_count: int
    empty_count: int
    empty_percent: float
    na_count: int
    all_numeric: bool
    avg_text_length: float
    suggested_type: str
    suggested_scale_name: str | None = None
    suggested_scale_labels: list[str] | None = None
    # #28: the codes an SPSS ordinal scale's labels actually carry (may be 0-based
    # or gapped), parallel to suggested_scale_labels. None for every other format —
    # the import then keeps the positional 1..N encoding.
    suggested_scale_values: list[float] | None = None
    suggested_scale_unmatched: list[str] | None = None  # #364: stray values not in the scale
    suggested_column_code: str | None = None
    suggested_group_code: str | None = None
    suggested_column_text: str
    suggested_column_name: str | None = None
    suggested_demographic_subtype: str | None = None
    numeric_format: str | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None


class DatasetPreviewResponse(BaseModel):
    total_rows: int
    columns: list[DatasetColumnPreview]
    # .xlsx uploads only (#523): workbook sheet names for the wizard's sheet picker.
    sheet_names: list[str] | None = None


# ═══════════════════════════════════════════════════════════════════════════════
# Import schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DatasetColumnConfig(BaseModel):
    column_index: int
    skip: bool = False
    column_type: str
    column_text: str
    column_code: str | None = None
    column_name: str | None = None
    group_code: str | None = None
    group_label: str | None = None
    scale_labels: list[str] | None = None
    # #28: parallel to scale_labels. Supplied by the .sav import path so an SPSS
    # scale's own codes survive; omitted elsewhere → positional 1..N.
    scale_values: list[float] | None = None
    demographic_subtype: str | None = None


class DatasetImportRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    source: str | None = Field(None, max_length=100)
    column_configs: list[DatasetColumnConfig]
    # .xlsx uploads only (#523): which worksheet to import (None = first sheet).
    sheet_name: str | None = None
    # #414: column_index of the identifier column to link rows to Participants
    # by (match-or-create on Participant.identifier). None = no linking.
    # Consumers MUST check `is not None` — index 0 is a valid column.
    participant_link_column_index: int | None = None


class ParticipantLinkReport(BaseModel):
    """#414: what import-time / retro participant linking did (scoping doc §3)."""
    linked: int
    created: int            # new Participants created (identifier=value)
    matched: int            # linked to pre-existing Participants
    skipped_missing: int    # blank / recognized-N/A / absent identifier values
    skipped_duplicate: int  # rows whose value appeared on >1 row (DEC-4: none link)
    skipped_conflict: int   # participant already linked to another row in dataset
    already_linked: int     # rows that had a link before this run (never touched)
    duplicate_values: list[str] = Field(default_factory=list)  # examples, capped


class DatasetImportResponse(BaseModel):
    dataset_id: int
    columns_created: int
    rows_created: int
    values_created: int
    # #415: how many stored values were recognized as missing (N/A / refusal
    # labels), i.e. treated as missing everywhere downstream per #381/#384.
    # Empty cells are not counted (they are skipped at import, never stored).
    recognized_missing_count: int = 0
    # Distinct recognized labels (e.g. "N/A", "Prefer not to say"), capped for
    # a bounded response; the frontend shows a few as examples.
    recognized_missing_labels: list[str] = Field(default_factory=list)
    # #414: present iff the request asked for participant linking.
    participant_link_report: ParticipantLinkReport | None = None


# ═══════════════════════════════════════════════════════════════════════════════
# Update schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DatasetUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    # User-customizable color (#RRGGBB hex). Null clears the override and
    # falls back to the auto-assigned palette color in `dataset-color.ts`.
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")


# ═══════════════════════════════════════════════════════════════════════════════
# Read schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DatasetResponse(BaseModel):
    id: int
    name: str
    description: str | None = None
    source: str | None = None
    color: str | None = None
    created_at: UTCTimestamp
    column_count: int
    row_count: int
    open_ended_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class DatasetListResponse(BaseModel):
    datasets: list[DatasetResponse]
    total: int


class DatasetColumnResponse(BaseModel):
    id: int
    column_code: str | None = None
    column_name: str | None = None
    group_code: str | None = None
    group_label: str | None = None
    column_text: str
    column_type: str
    sequence_order: int
    display_order: int | None = None
    scale_labels: list[str] | None = None
    scale_points: int | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None
    numeric_format: str | None = None
    source: str = "imported"
    expression: str | None = None
    depends_on_column_ids: list[int] | None = None
    stale: bool | None = None
    demographic_subtype: str | None = None
    equivalence_group_id: int | None = None
    equivalence_group_label: str | None = None
    # #353: opt-out flag for the participant detail panel. Default True;
    # researchers uncheck per-column for sensitive data in DatasetView.
    show_in_participant_profile: bool = True

    model_config = ConfigDict(from_attributes=True)


class DatasetRowSummary(BaseModel):
    id: int
    participant_id: int | None = None
    row_identifier: str | None = None
    submitted_at: UTCTimestamp | None = None
    value_count: int

    model_config = ConfigDict(from_attributes=True)


class DatasetValueResponse(BaseModel):
    id: int
    column_id: int
    value_text: str | None = None
    value_numeric: float | None = None

    model_config = ConfigDict(from_attributes=True)


class DatasetRowDetail(BaseModel):
    id: int
    participant_id: int | None = None
    row_identifier: str | None = None
    submitted_at: UTCTimestamp | None = None
    values: list[DatasetValueResponse]

    model_config = ConfigDict(from_attributes=True)


# ═══════════════════════════════════════════════════════════════════════════════
# Data view schemas (spreadsheet-like grid)
# ═══════════════════════════════════════════════════════════════════════════════


class RecodeDefinitionSummary(BaseModel):
    """Compact recode definition for embedding in data endpoint responses."""
    id: int
    name: str
    recode_type: str
    output_type: str
    mapping: dict
    exclude_values: list[str] | None = None
    is_primary: bool
    is_auto_detected: bool
    source_definition_id: int | None = None


class DatasetDataColumnResponse(BaseModel):
    """Column with recode definitions for the data view."""
    id: int
    column_code: str | None = None
    column_name: str | None = None
    group_code: str | None = None
    group_label: str | None = None
    column_text: str
    column_type: str
    sequence_order: int
    scale_labels: list[str] | None = None
    scale_points: int | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None
    numeric_format: str | None = None
    source: str = "imported"
    expression: str | None = None
    depends_on_column_ids: list[int] | None = None
    stale: bool | None = None
    demographic_subtype: str | None = None
    recode_definitions: list[RecodeDefinitionSummary] = []
    equivalence_group_id: int | None = None
    equivalence_group_label: str | None = None

    model_config = ConfigDict(from_attributes=True)


class DatasetValueCell(BaseModel):
    id: int
    value_text: str | None = None
    value_numeric: float | None = None


class DatasetDataRow(BaseModel):
    id: int
    participant_id: int | None = None
    participant_display_name: str | None = None
    row_identifier: str | None = None
    submitted_at: UTCTimestamp | None = None
    values: dict[str, DatasetValueCell]


class DatasetDataResponse(BaseModel):
    dataset: DatasetResponse
    columns: list[DatasetDataColumnResponse]
    rows: list[DatasetDataRow]


# ═══════════════════════════════════════════════════════════════════════════════
# Participant linking schemas
# ═══════════════════════════════════════════════════════════════════════════════


class LinkParticipantRequest(BaseModel):
    participant_id: int | None = None


class LinkParticipantResponse(BaseModel):
    row_id: int
    participant_id: int | None
    participant_display_name: str | None
    row_identifier: str | None


class BulkLinkItem(BaseModel):
    row_id: int
    participant_id: int | None = None


class BulkLinkRequest(BaseModel):
    links: list[BulkLinkItem]


class BulkLinkResultItem(BaseModel):
    row_id: int
    participant_id: int | None = None
    participant_display_name: str | None = None


class BulkLinkSkippedItem(BaseModel):
    row_id: int
    reason: str


class BulkLinkResponse(BaseModel):
    linked: list[BulkLinkResultItem]
    unlinked: list[BulkLinkResultItem]
    skipped: list[BulkLinkSkippedItem]


# ═══════════════════════════════════════════════════════════════════════════════
# Manual column schemas
# ═══════════════════════════════════════════════════════════════════════════════

ALLOWED_MANUAL_TYPES = {
    "ordinal", "nominal", "binary", "numeric", "percentage",
    "open_text", "multi_select", "demographic", "identifier",
}


class ManualColumnCreate(BaseModel):
    column_text: str = Field(..., min_length=1, max_length=500)
    column_type: str
    column_code: str | None = Field(None, max_length=50)
    group_code: str | None = Field(None, max_length=50)
    group_label: str | None = Field(None, max_length=255)
    scale_labels: list[str] | None = None
    scale_values: list[int] | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None
    numeric_format: str | None = None
    demographic_subtype: str | None = Field(None, max_length=40)

    @model_validator(mode="after")
    def validate_type(self) -> "ManualColumnCreate":
        if self.column_type not in ALLOWED_MANUAL_TYPES:
            raise ValueError(f"column_type must be one of: {', '.join(sorted(ALLOWED_MANUAL_TYPES))}")
        if self.column_type == "ordinal" and (not self.scale_labels or len(self.scale_labels) < 2):
            raise ValueError("Ordinal columns must have at least 2 scale labels")
        return self


class ManualColumnUpdate(BaseModel):
    column_text: str | None = Field(None, min_length=1, max_length=500)
    column_type: str | None = None
    column_code: str | None = Field(None, max_length=50)
    group_code: str | None = Field(None, max_length=50)
    group_label: str | None = Field(None, max_length=255)
    scale_labels: list[str] | None = None
    scale_values: list[int] | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None
    numeric_format: str | None = None
    demographic_subtype: str | None = Field(None, max_length=40)


ALLOWED_COMPUTED_TYPES = {"numeric", "percentage", "nominal", "ordinal", "binary"}


class ComputedColumnCreate(BaseModel):
    column_text: str = Field(..., min_length=1, max_length=500)
    column_code: str | None = Field(None, max_length=50)
    expression: str = Field(..., min_length=1)
    column_type: str = "numeric"

    @model_validator(mode="after")
    def validate_type(self) -> "ComputedColumnCreate":
        if self.column_type not in ALLOWED_COMPUTED_TYPES:
            raise ValueError(f"column_type must be one of: {', '.join(sorted(ALLOWED_COMPUTED_TYPES))}")
        return self


class ComputedColumnUpdate(BaseModel):
    expression: str = Field(..., min_length=1)
    column_type: str | None = None


class ColumnHeaderUpdate(BaseModel):
    column_name: str | None = Field(None, max_length=255)
    column_text: str | None = Field(None, min_length=1, max_length=500)
    # #353: per-column opt-out for the participant detail panel. Optional —
    # null means "no change", true/false means update.
    show_in_participant_profile: bool | None = None


class ValueUpdate(BaseModel):
    value_text: str | None = None


class ValueCellResponse(BaseModel):
    id: int
    row_id: int
    column_id: int
    value_text: str | None = None
    value_numeric: float | None = None


# ═══════════════════════════════════════════════════════════════════════════════
# Append import schemas
# ═══════════════════════════════════════════════════════════════════════════════


class AppendMatchedColumn(BaseModel):
    csv_column_name: str
    csv_column_index: int
    column_id: int
    column_code: str | None = None
    column_text: str
    column_type: str
    match_method: str  # "code" or "text"


class AppendUnmatchedCsvColumn(BaseModel):
    csv_column_name: str
    csv_column_index: int


class AppendUnmatchedColumn(BaseModel):
    column_id: int
    column_code: str | None = None
    column_text: str


class AppendPreviewRow(BaseModel):
    csv_row_index: int
    values: dict[str, str]  # column_id (str) -> cell value
    is_duplicate: bool = False


class AppendLinkColumnOffer(BaseModel):
    """#414 (DEC-7): the identifier column append-linking can run against —
    offered when the dataset has exactly ONE identifier column and the
    uploaded file matched it (else new rows would carry no identifier values)."""
    column_id: int
    column_text: str


class DatasetAppendPreviewResponse(BaseModel):
    matched_columns: list[AppendMatchedColumn]
    unmatched_csv_columns: list[AppendUnmatchedCsvColumn]
    unmatched_columns: list[AppendUnmatchedColumn]
    total_rows: int
    duplicate_count: int
    preview_rows: list[AppendPreviewRow]
    next_row_id: str
    row_pad_width: int
    # .xlsx uploads only (#523): workbook sheet names for the append sheet picker.
    sheet_names: list[str] | None = None
    # #414: present when append-linking is offerable (see AppendLinkColumnOffer).
    participant_link_column: AppendLinkColumnOffer | None = None


class DatasetAppendRequest(BaseModel):
    column_mapping: list[dict]  # [{csv_column_index, column_id}]
    skip_duplicates: bool = True
    row_start_id: str | None = None
    # .xlsx uploads only (#523): which worksheet to append from (None = first sheet).
    sheet_name: str | None = None
    # #414 (DEC-7): identifier column id to link the NEW rows by (append's
    # vocabulary is column ids, unlike the initial import's column_index).
    participant_link_column_id: int | None = None


class DatasetAppendResponse(BaseModel):
    rows_created: int
    values_created: int
    duplicates_skipped: int
    batch_id: str
    next_row_id: str
    # #414: present iff the request asked for participant linking.
    participant_link_report: ParticipantLinkReport | None = None


class LinkByColumnRequest(BaseModel):
    """#414 (DEC-8): retro bulk-link request for an existing dataset."""
    column_id: int


# ═══════════════════════════════════════════════════════════════════════════════
# Column reorder schemas
# ═══════════════════════════════════════════════════════════════════════════════


class ColumnReorderRequest(BaseModel):
    ordered_column_ids: list[int]
