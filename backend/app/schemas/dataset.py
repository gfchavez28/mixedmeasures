"""Pydantic schemas for the dataset import and read endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    suggested_scale_unmatched: list[str] | None = None
    # #596: SPSS's own user-missing declaration for this variable, translated to
    # the `missing_values` rule shape. The IMPORT does not depend on this — it
    # injects the same rules server-side (§K.5) — but the wizard needs it to SHOW
    # what SPSS declared. Must be declared here or Pydantic's extra='ignore'
    # drops the key `apply_sav_metadata` sets, silently (the #586 shape).
    suggested_missing_values: list[dict] | None = None  # #364: stray values not in the scale
    # #575: the sorted distinct numeric values observed (populated only for an
    # all-numeric column with bounded cardinality — a scale, not a continuous
    # measure), so the wizard's value-labels editor can seed the COMPLETE code set
    # (sample_values is capped at 5). None otherwise.
    distinct_numeric_values: list[float] | None = None
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
    # #575: the cells are numeric CODES (not labels), and scale_labels/scale_values
    # declare a code→label dictionary to substitute at import — the wizard-authored
    # analog of a .sav import. When set, the importer stores the label in value_text
    # and the code in value_numeric (via apply_value_labels), making the column
    # byte-identical to a labelled .sav column. Import-config only; not persisted.
    cells_are_codes: bool = False
    demographic_subtype: str | None = None
    # #592: declared missing-value rules for THIS column — persisted on the
    # created column and honored by the import cell loop, numeric metadata,
    # and exclude seeding. Same shape (and the same single-sourced validation)
    # as the missing-values endpoint; None = the recognized-N/A defaults,
    # [] = nothing is missing. Filled by the wizard (slab 4) / .sav (slab 5).
    missing_values: list[dict] | None = None

    @field_validator("scale_labels", "scale_values")
    @classmethod
    def _cap_scale_metadata(cls, v):
        # #588: same ceiling as the value-labels endpoint. This path is the one
        # that mattered — `.sav` import and the wizard both write configs here,
        # and neither passes through that endpoint's validator.
        from ..services.value_labels import validate_value_label_count
        return validate_value_label_count(v, field="scale labels")

    @model_validator(mode="after")
    def _codes_need_a_labellable_type(self) -> "DatasetColumnConfig":
        """#589: `cells_are_codes` drives `apply_value_labels`, so the type it
        asks for must be one that can carry labels.

        Reproduced before the fix: a config of `{"column_type": "open_text",
        "cells_are_codes": true, "scale_labels": [...]}` imported cleanly —
        labels substituted into free-form responses, scale metadata written and
        a primary scale_map minted — which is the exact state
        `POST …/columns/{id}/value-labels` answers 400 for. Only the wizard
        prevented it, i.e. the invariant lived in one client.

        This arm gives that a clean 422 at the edge; the load-bearing half is
        the guard inside `apply_value_labels`, because the import calls the
        service directly and a schema is not on that path either.
        """
        if self.cells_are_codes and not self.skip:
            from ..models.dataset import VALUE_LABEL_INELIGIBLE_TYPES
            if self.column_type in VALUE_LABEL_INELIGIBLE_TYPES:
                raise ValueError(
                    f"cells_are_codes cannot be used with a {self.column_type} "
                    "column — value labels would overwrite the cell's own "
                    "meaning. Use ordinal or nominal for a column of codes."
                )
        return self

    @field_validator("missing_values")
    @classmethod
    def _normalize_missing_rules(cls, v: list[dict] | None) -> list[dict] | None:
        if v is None:
            return None
        # #614: the import config is a SECOND write path to the same persisted
        # field — it must run the same payload-internal checks as the PUT
        # endpoint (dup labels / label-equals-value were bypassable here, and
        # a config rule whose label matches real response text classifies
        # those cells missing AT IMPORT). The DB-dependent #606 arms cannot
        # run at config time (no column exists yet) and stay in
        # missing_declaration._assert_no_label_collisions.
        from ..services.missing_values import normalize_missing_rules_payload
        return normalize_missing_rules_payload(v)


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
    # #575: for each cells-are-codes column authored in the wizard, the codes
    # observed in the data that the user did NOT give a label (kept numeric, never
    # nulled) — keyed by column_index, so the results screen can prompt to label
    # them. Empty when no value labels were authored.
    value_label_unlabeled: dict[int, list[float]] = Field(default_factory=dict)


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


class PrimaryRecodeSummary(BaseModel):
    """The rule currently driving a column's ``value_numeric``, or nothing.

    The Variables view states this per variable, because "which rule is in
    effect" is the fact that makes labels and recodes read as two layers rather
    than one — and it was previously answerable only by selecting a column and
    waiting for a second request.

    ⚠️ **Deliberately compact: no mapping.** A mapping can carry
    ``MAX_VALUE_LABELS`` (500) entries, and a 500-column dataset would put
    250,000 pairs on a list response nothing on that screen renders. The detail
    panel fetches the full definition for the ONE selected column.
    """
    id: int
    name: str
    recode_type: str
    #: True when the mapping sends a NUMERIC key somewhere other than itself —
    #: a flip or a collapse, i.e. `value_numeric` is not the response's own code.
    #:
    #: ⚠️ **A SHAPE test, and NOT the #793 guard.** It is blind to a hand-flip
    #: keyed on LABELS, which has no numeric key to judge. The authority is
    #: `value_labels.code_identity_violation`, which reads the column's stored
    #: cells and cannot run per column across a list response. Present this as a
    #: description of the RULE, never as a safety verdict.
    remaps_codes: bool = False


class RecodeDefinitionSummary(BaseModel):
    """Compact recode definition, embedded in every column response.

    ⚠️ **MOVED above `DatasetColumnResponse` (2026-08-31, #830f) because that
    class now declares it.** Until then this rode `/data` alone, which made the
    Data view the only surface that could offer "new variable from a rule" —
    `Add ▾`'s third kind was unbuildable on the Variables view, the very screen
    where rules are authored. `_column_to_response` builds these now, so the two
    payloads cannot disagree about a definition (the #602 lesson: a field
    populated on one payload and not the other is how a reader ends up believing
    the wrong one).
    """
    id: int
    name: str
    recode_type: str
    output_type: str
    mapping: dict
    #: #823(d) — the rule's RANGE bands, ordered, first match wins. Rides this
    #: summary because the Data view's display lens resolves a cell through the
    #: active definition client-side: without the bands it would render a banded
    #: cell as unmapped text while `value_numeric` holds the band's code, which
    #: is the #578 display-vs-storage drift on the one grid a researcher checks
    #: a recode against.
    ranges: list[dict] = []
    exclude_values: list[str] | None = None
    is_primary: bool
    is_auto_detected: bool
    source_definition_id: int | None = None
    # #600: THE reflection offset for a REVERSE recode, computed server-side by
    # services/recode.py::effective_reverse_offset over the mapping's NON-null-set
    # values (a missing/excluded key is not a scale point and must not set the
    # endpoint). The client MUST display `offset - code` using this, never
    # re-derive it from `mapping`: the null set needs the recognized-N/A rule and
    # the column's missing declaration, so a client mirror would drift from
    # storage (#578). None for non-reverse definitions.
    reverse_offset: float | None = None


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
    # #576: parallel to scale_labels — the numeric code each label carries. Lets
    # the value-labels editor pre-fill code↔label pairs when editing.
    scale_values: list[float] | None = None
    scale_points: int | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None
    numeric_format: str | None = None
    # #592: declared missing-value rules, parsed from the column's JSON (see
    # services/missing_values.py for the rule shapes). None = no declaration
    # (the recognized-N/A defaults). Declared on BOTH column schemas — the
    # /data sibling is splat-constructed and silently drops undeclared
    # fields (#586).
    missing_values: list[dict] | None = None
    source: str = "imported"
    expression: str | None = None
    depends_on_column_ids: list[int] | None = None
    stale: bool | None = None
    demographic_subtype: str | None = None
    equivalence_group_id: int | None = None
    equivalence_group_label: str | None = None
    # The rule driving this column's value_numeric. `None` means no primary
    # recode — which for a labelled column means the labels dictionary alone is
    # in effect. Populated on EVERY payload built by `_column_to_response`, so
    # `None` always means "no primary", never "not loaded" (the stated-basis
    # ambiguity this codebase keeps meeting).
    primary_recode: PrimaryRecodeSummary | None = None
    # #830f — every saved rule on this column, not just the primary one.
    #
    # ⚠️ **`primary_recode` above is NOT redundant with this and must stay.** It
    # carries `remaps_codes`, a computed shape test no client can derive from a
    # summary without re-implementing it — and it is the field whose `None` means
    # "no primary" rather than "not loaded".
    #
    # ⚠️ Costs no extra query: `list_columns` already `selectinload`s this
    # relationship to compute `primary_recode`, and the single-column callers
    # already pay one lazy load for it. Measured on the largest local corpus
    # (GSS, 48 columns): 7 definitions totalling 1,838 bytes of mapping JSON.
    recode_definitions: list[RecodeDefinitionSummary] = []
    # Decision B (2026-08-24) — where a derived variable came from. The ID, not
    # a label: `columnDisplayLabel` is the single source for naming a column
    # (#575) and the Variables view already holds every column of the dataset,
    # so resolving server-side would be a second naming rule AND a lazy load per
    # column. ⚠️ The two fields degrade INDEPENDENTLY and both readings are
    # meaningful: deleting the source column nulls the FK (ON DELETE SET NULL)
    # while `derived_via` survives, so "derived by <rule>, source deleted" stays
    # sayable. A UI that renders the pair only when BOTH are present loses that.
    derived_from_column_id: int | None = None
    derived_via: str | None = None
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


class DatasetRowPosition(BaseModel):
    """Where a row sits in the grid's ordering, and which page holds it (#834).

    ``index`` is 0-based over the WHOLE dataset (not the page), so a caller can
    display "record N of M" as ``index + 1``. ``offset`` is the page start for
    ``limit`` — the value the grid puts in its React Query key.
    """
    row_id: int
    index: int
    offset: int
    limit: int
    total_rows: int


# ═══════════════════════════════════════════════════════════════════════════════
# Data view schemas (spreadsheet-like grid)
# ═══════════════════════════════════════════════════════════════════════════════


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
    # #576: parallel to scale_labels — the code each label carries. Declared on
    # DatasetColumnResponse, but this schema is built by splatting that one's
    # model_dump(), and Pydantic's default extra='ignore' silently DROPS any
    # field this class doesn't declare. Omitting it stripped scale_values from
    # /data — the only payload the value-labels editor reads — so its edit-mode
    # pre-fill always missed and it re-seeded from the OBSERVED codes, silently
    # dropping any declared zero-response level (#577's whole point).
    scale_values: list[float] | None = None
    scale_points: int | None = None
    numeric_min: float | None = None
    numeric_max: float | None = None
    numeric_format: str | None = None
    # #592: declared missing-value rules — same #586 rule as scale_values
    # above: this splat-constructed sibling must re-declare the field or /data
    # (the only payload the column editors read) silently drops it.
    missing_values: list[dict] | None = None
    source: str = "imported"
    expression: str | None = None
    depends_on_column_ids: list[int] | None = None
    stale: bool | None = None
    demographic_subtype: str | None = None
    # Decision B provenance — the THIRD instance of the #586 rule on this class,
    # and it was caught by DRIVING rather than by any test. The Data view's grid
    # marks a `source="manual"` column with a pencil and the words "manual
    # column"; a derived variable is manual (it must be — a computed column is
    # refused value labels, missing rules and recode definitions, #806), so
    # without these fields the grid calls a derived variable hand-typed, which is
    # the opposite of what it is. This schema is built by splatting
    # `DatasetColumnResponse.model_dump()`, and Pydantic's `extra='ignore'` drops
    # anything it does not declare — silently, with no type error.
    derived_from_column_id: int | None = None
    derived_via: str | None = None
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
    """One PAGE of a dataset's grid (#800).

    ⚠️ ``rows`` is the page; ``total_rows`` is the dataset. Anything showing a
    record count must read ``total_rows`` — the two were the same number until
    this endpoint was paginated, so every `rows.length` consumer was silently a
    total-count consumer too.
    """
    dataset: DatasetResponse
    columns: list[DatasetDataColumnResponse]
    rows: list[DatasetDataRow]
    total_rows: int
    offset: int
    limit: int
    # participant_id (as a string key, JSON-object friendly) -> row_identifier.
    # DATASET-scoped, not page-scoped — see the endpoint docstring.
    linked_participants: dict[str, str] = {}


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

    # #588: the two manual-column schemas were the other half of the uncapped
    # population — the filed entry named only the endpoint and the import
    # config. Same shared ceiling.
    @field_validator("scale_labels", "scale_values")
    @classmethod
    def _cap_scale_metadata(cls, v):
        from ..services.value_labels import validate_value_label_count
        return validate_value_label_count(v, field="scale labels")

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

    @field_validator("scale_labels", "scale_values")
    @classmethod
    def _cap_scale_metadata(cls, v):
        from ..services.value_labels import validate_value_label_count
        return validate_value_label_count(v, field="scale labels")


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
    # #575: appended values (on a value-labelled/scale column) that did NOT map to
    # a numeric code — unknown labels/typos or codes with no declared label. They
    # store as text with value_numeric NULL; surfaced so the append isn't silent.
    unmapped_values: list[str] = Field(default_factory=list)


class LinkByColumnRequest(BaseModel):
    """#414 (DEC-8): retro bulk-link request for an existing dataset."""
    column_id: int


# ═══════════════════════════════════════════════════════════════════════════════
# Column reorder schemas
# ═══════════════════════════════════════════════════════════════════════════════


class ColumnReorderRequest(BaseModel):
    ordered_column_ids: list[int]
