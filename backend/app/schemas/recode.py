"""Pydantic schemas for recode definitions."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, ConfigDict, Field, field_validator

VALID_RECODE_TYPES = {"scale_map", "category_group", "reverse"}
VALID_OUTPUT_TYPES = {"numeric", "categorical"}


# ═══════════════════════════════════════════════════════════════════════════════
# Request schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RecodeDefinitionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    recode_type: str
    output_type: str
    mapping: dict  # {"label": value, ...}
    exclude_values: list[str] | None = None
    source_definition_id: int | None = None

    @field_validator("recode_type")
    @classmethod
    def validate_recode_type(cls, v: str) -> str:
        if v not in VALID_RECODE_TYPES:
            raise ValueError(f"recode_type must be one of: {', '.join(sorted(VALID_RECODE_TYPES))}")
        return v

    @field_validator("output_type")
    @classmethod
    def validate_output_type(cls, v: str) -> str:
        if v not in VALID_OUTPUT_TYPES:
            raise ValueError(f"output_type must be one of: {', '.join(sorted(VALID_OUTPUT_TYPES))}")
        return v


class RecodeDefinitionUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    recode_type: str | None = None
    output_type: str | None = None

    @field_validator("recode_type")
    @classmethod
    def validate_recode_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_RECODE_TYPES:
            raise ValueError(f"recode_type must be one of: {', '.join(sorted(VALID_RECODE_TYPES))}")
        return v

    @field_validator("output_type")
    @classmethod
    def validate_output_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_OUTPUT_TYPES:
            raise ValueError(f"output_type must be one of: {', '.join(sorted(VALID_OUTPUT_TYPES))}")
        return v
    mapping: dict | None = None
    exclude_values: list[str] | None = None
    source_definition_id: int | None = None
    is_primary: bool | None = None


class CopyToRequest(BaseModel):
    target_column_ids: list[int]


class BulkTypeUpdateRequest(BaseModel):
    column_ids: list[int]
    column_type: str


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RecodeDefinitionResponse(BaseModel):
    id: int
    column_id: int
    name: str
    recode_type: str
    output_type: str
    mapping: dict
    exclude_values: list[str] | None = None
    is_primary: bool
    is_auto_detected: bool
    source_definition_id: int | None = None
    sequence_order: int
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    unmapped_values: list[str] = []

    model_config = ConfigDict(from_attributes=True)


class RecodeDefinitionSummary(BaseModel):
    """Compact summary for embedding in data endpoint responses."""
    id: int
    name: str
    recode_type: str
    output_type: str
    mapping: dict
    exclude_values: list[str] | None = None
    is_primary: bool
    is_auto_detected: bool
    source_definition_id: int | None = None


class CopyToResponse(BaseModel):
    created: int
    skipped: int
    skipped_columns: list[int] = []


class ValueFrequency(BaseModel):
    value_text: str
    count: int
    is_na: bool


class ColumnFrequenciesResponse(BaseModel):
    column_id: int
    frequencies: list[ValueFrequency]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# Value labels (#576/#577) — declare a code→label dictionary for a numbers-only column
# ═══════════════════════════════════════════════════════════════════════════════


VALUE_LABEL_TYPES = {"ordinal", "nominal"}


class ValueLabelPair(BaseModel):
    value: float          # the numeric code as it appears in the data (e.g. 1)
    label: str = Field(..., min_length=1, max_length=255)


class ApplyValueLabelsRequest(BaseModel):
    labels: list[ValueLabelPair] = Field(..., min_length=1)
    # Target column type: 'ordinal' (a scale) or 'nominal' (unordered categories);
    # None keeps the current type. Labels apply to both.
    column_type: str | None = None

    @field_validator("labels")
    @classmethod
    def _unique_codes_and_labels(cls, v: list[ValueLabelPair]) -> list[ValueLabelPair]:
        codes = [p.value for p in v]
        if len(set(codes)) != len(codes):
            raise ValueError("Duplicate codes — each value may appear only once.")
        labels = [p.label.strip().lower() for p in v]
        if any(not lab for lab in labels):
            raise ValueError("Labels cannot be blank.")
        if len(set(labels)) != len(labels):
            raise ValueError("Duplicate labels — each label must be distinct.")
        return v

    @field_validator("column_type")
    @classmethod
    def _valid_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALUE_LABEL_TYPES:
            raise ValueError(f"column_type must be one of: {', '.join(sorted(VALUE_LABEL_TYPES))}")
        return v


class ApplyValueLabelsResponse(BaseModel):
    column_id: int
    updated: int
    unlabeled_codes: list[float] = []
    # #592 (C4): label pairs whose code/label the column DECLARES missing are
    # never applied (a missing code is not a scale point) — reported here.
    missing_skipped: list[float] = []


class MissingValuesUpdate(BaseModel):
    """#592: set (rules list — `[]` = nothing missing) or clear (null = the
    recognized-N/A defaults) a column's missing declaration."""
    rules: list[dict] | None = None

    @field_validator("rules")
    @classmethod
    def _normalize_rules(cls, v: list[dict] | None) -> list[dict] | None:
        if v is None:
            return None
        # Single-sourced with the predicate module (#612/#614): shape rules,
        # degenerate-range normalization, exact-dup drop, same-value /
        # dup-label / label-equals-value refusals, and the rule cap — shared
        # with DatasetColumnConfig so the import config cannot accept a
        # payload this endpoint would refuse.
        from ..services.missing_values import normalize_missing_rules_payload
        return normalize_missing_rules_payload(v)


class MissingValuesResponse(BaseModel):
    column_id: int
    missing_values: list[dict] | None = None
    nulled_rows: int
    # Cells whose value_text was substituted to a rule's label ("99" ->
    # "Refused"), the .sav shape — a subset of nulled_rows.
    labelled_rows: int = 0
    # Scale points removed from scale_labels/scale_values because the
    # declaration marks their code missing (C4: a missing code is never a
    # scale point, or frequency charts zero-fill a phantom bar for it).
    stripped_scale_points: int = 0
    recovered_rows: int
    recovered_values: list[str] = []
    # Recovered texts whose code the column's compute could not produce (e.g.
    # absent from a scale_map primary's mapping) — cells stay text-only, like
    # any unmapped value, for the researcher to map or label.
    recovered_unmapped: list[str] = []
