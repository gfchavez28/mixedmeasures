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
