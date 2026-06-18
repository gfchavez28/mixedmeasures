"""Pydantic schemas for data quality / missing data diagnostics."""

from pydantic import BaseModel, Field


# ── Request schemas ────────────────────────────────────────────────────────────


class DataQualityRequest(BaseModel):
    column_ids: list[int]
    include_na_as_missing: bool = True
    include_empty_as_missing: bool = True


class MissingPatternsRequest(DataQualityRequest):
    max_patterns: int = Field(default=50, ge=1, le=200)


# ── Response schemas ───────────────────────────────────────────────────────────


class VariableMissingSummary(BaseModel):
    column_id: int
    variable_name: str
    full_label: str
    dataset_id: int
    dataset_name: str
    column_type: str
    n_total: int
    n_valid: int
    n_missing: int
    pct_missing: float
    n_empty: int
    n_na: int


class MissingSummaryResponse(BaseModel):
    variables: list[VariableMissingSummary]
    total_rows: int
    total_cells: int
    total_missing: int
    overall_pct_missing: float


class PatternRow(BaseModel):
    pattern: list[bool]
    count: int
    pct: float


class MissingPatternsResponse(BaseModel):
    column_ids: list[int]
    column_labels: list[str]
    patterns: list[PatternRow]
    total_rows: int
    n_unique_patterns: int
    truncated: bool


class McarEligibility(BaseModel):
    eligible: bool
    reason: str | None = None
    warning: str | None = None


class McarTestResult(BaseModel):
    chi2: float
    df: int
    p: float
    n: int
    n_patterns: int
    n_variables: int
    apa_string: str
    interpretation: str


class McarTestResponse(BaseModel):
    eligibility: McarEligibility
    result: McarTestResult | None = None
