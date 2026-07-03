"""Pydantic schemas for metric definition endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, Field, field_validator, model_validator


# ═══════════════════════════════════════════════════════════════════════════════
# Request schemas
# ═══════════════════════════════════════════════════════════════════════════════

VALID_METRIC_TYPES = {"frequency_distribution", "proportion", "mean", "domain_aggregate"}
VALID_SOURCE_TYPES = {"dataset_column", "dataset_domain"}
VALID_GROUPING_MODES = {None, "column", "dataset"}


def _check_grouping_mode(v: str | None) -> str | None:
    if v not in VALID_GROUPING_MODES:
        raise ValueError("grouping_mode must be one of: null, 'column', 'dataset'")
    return v


def _check_composite_grouping(v: int | None, info) -> int | None:
    if v is not None and info.data.get("grouping_column_id") is None:
        raise ValueError("grouping_column_id_2 requires grouping_column_id to also be set")
    return v


class MetricDefinitionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    metric_type: str
    config: dict
    input_source_type: str
    input_source_id: int
    grouping_column_id: int | None = None
    grouping_column_id_2: int | None = None
    grouping_mode: str | None = None
    exclude_values: list[str] | None = None
    sequence_order: int = 0

    @field_validator("metric_type")
    @classmethod
    def validate_metric_type(cls, v: str) -> str:
        if v not in VALID_METRIC_TYPES:
            raise ValueError(f"metric_type must be one of {sorted(VALID_METRIC_TYPES)}")
        return v

    @field_validator("input_source_type")
    @classmethod
    def validate_source_type(cls, v: str) -> str:
        if v not in VALID_SOURCE_TYPES:
            raise ValueError(f"input_source_type must be one of {sorted(VALID_SOURCE_TYPES)}")
        return v

    @field_validator("grouping_mode")
    @classmethod
    def validate_grouping_mode(cls, v: str | None) -> str | None:
        return _check_grouping_mode(v)

    @field_validator("grouping_column_id_2")
    @classmethod
    def validate_composite(cls, v: int | None, info) -> int | None:
        return _check_composite_grouping(v, info)

    @model_validator(mode="after")
    def default_grouping_mode(self):
        # Make grouping_mode self-describing: when a grouping column is set
        # without an explicit mode, persist it as 'column'. Avoids ambiguous
        # NULL state in the DB and keeps downstream consumers (UI filters,
        # exports) from having to coalesce NULL → 'column' themselves.
        if self.grouping_mode is None and self.grouping_column_id is not None:
            self.grouping_mode = "column"
        return self


class MetricDefinitionUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    metric_type: str | None = None
    config: dict | None = None
    input_source_type: str | None = None
    input_source_id: int | None = None
    grouping_column_id: int | None = None
    grouping_column_id_2: int | None = None
    grouping_mode: str | None = None
    exclude_values: list[str] | None = None
    sequence_order: int | None = None

    @field_validator("metric_type")
    @classmethod
    def validate_metric_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_METRIC_TYPES:
            raise ValueError(f"metric_type must be one of {sorted(VALID_METRIC_TYPES)}")
        return v

    @field_validator("input_source_type")
    @classmethod
    def validate_source_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_SOURCE_TYPES:
            raise ValueError(f"input_source_type must be one of {sorted(VALID_SOURCE_TYPES)}")
        return v

    @field_validator("grouping_mode")
    @classmethod
    def validate_grouping_mode(cls, v: str | None) -> str | None:
        return _check_grouping_mode(v)

    @field_validator("grouping_column_id_2")
    @classmethod
    def validate_composite(cls, v: int | None, info) -> int | None:
        return _check_composite_grouping(v, info)


class MetricBulkCreate(BaseModel):
    metrics: list[MetricDefinitionCreate] = Field(..., min_length=1)


class MetricReorderRequest(BaseModel):
    metric_ids: list[int] = Field(..., min_length=1)


class ComputeAllRequest(BaseModel):
    stale_only: bool = False


class ValidateConfigRequest(BaseModel):
    metric_type: str
    config: dict
    input_source_type: str
    input_source_id: int

    @field_validator("metric_type")
    @classmethod
    def validate_metric_type(cls, v: str) -> str:
        if v not in VALID_METRIC_TYPES:
            raise ValueError(f"metric_type must be one of {sorted(VALID_METRIC_TYPES)}")
        return v

    @field_validator("input_source_type")
    @classmethod
    def validate_source_type(cls, v: str) -> str:
        if v not in VALID_SOURCE_TYPES:
            raise ValueError(f"input_source_type must be one of {sorted(VALID_SOURCE_TYPES)}")
        return v


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class ComputedResultResponse(BaseModel):
    id: int
    group_value: str | None = None
    result_data: dict
    valid_n: int
    total_n: int
    computed_at: UTCTimestamp


class MetricDefinitionResponse(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None = None
    metric_type: str
    config: dict
    input_source_type: str
    input_source_id: int
    input_source_label: str | None = None
    grouping_column_id: int | None = None
    grouping_column_id_2: int | None = None
    grouping_mode: str | None = None
    exclude_values: list[str] | None = None
    sequence_order: int
    origin: str
    origin_context: str | None = None
    stale: bool
    result_type: str
    results: list[ComputedResultResponse] = []
    last_accessed_at: UTCTimestamp | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp


class MetricDefinitionSummaryResponse(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None = None
    metric_type: str
    config: dict
    input_source_type: str
    input_source_id: int
    input_source_label: str | None = None
    grouping_column_id: int | None = None
    grouping_column_id_2: int | None = None
    grouping_mode: str | None = None
    exclude_values: list[str] | None = None
    sequence_order: int
    origin: str
    origin_context: str | None = None
    stale: bool
    result_type: str
    latest_computed_at: UTCTimestamp | None = None
    total_valid_n: int | None = None
    result_count: int = 0
    # #506: results with a non-null group_value — excludes the None
    # listwise-deletion bucket. Group-count displays and the t-vs-ANOVA
    # picker must read this, never result_count.
    real_group_count: int = 0
    last_accessed_at: UTCTimestamp | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp


class MetricListResponse(BaseModel):
    metrics: list[MetricDefinitionSummaryResponse]
    total: int


class ComputeAllResponse(BaseModel):
    computed: int
    errors: list[dict] = []


class ValidateConfigResponse(BaseModel):
    valid: bool
    errors: list[str] = []


class BulkCreateResponse(BaseModel):
    created: int
    metrics: list[MetricDefinitionResponse]


# ═══════════════════════════════════════════════════════════════════════════════
# Quick-compute schemas
# ═══════════════════════════════════════════════════════════════════════════════


class QuickComputeSource(BaseModel):
    source_type: str  # "dataset_column" | "dataset_domain"
    source_id: int

    @field_validator("source_type")
    @classmethod
    def validate_source_type(cls, v: str) -> str:
        if v not in VALID_SOURCE_TYPES:
            raise ValueError(f"source_type must be one of {sorted(VALID_SOURCE_TYPES)}")
        return v


class QuickComputeRequest(BaseModel):
    sources: list[QuickComputeSource] = Field(..., min_length=1)
    metric_type: str = "frequency_distribution"
    config: dict = {}
    grouping_column_id: int | None = None
    grouping_column_id_2: int | None = None
    grouping_mode: str | None = None
    exclude_values: list[str] | None = None
    decompose: bool = False

    @field_validator("metric_type")
    @classmethod
    def validate_metric_type(cls, v: str) -> str:
        if v not in VALID_METRIC_TYPES:
            raise ValueError(f"metric_type must be one of {sorted(VALID_METRIC_TYPES)}")
        return v

    @field_validator("grouping_mode")
    @classmethod
    def validate_grouping_mode(cls, v: str | None) -> str | None:
        return _check_grouping_mode(v)

    @field_validator("grouping_column_id_2")
    @classmethod
    def validate_composite(cls, v: int | None, info) -> int | None:
        return _check_composite_grouping(v, info)

    @model_validator(mode="after")
    def default_grouping_mode(self):
        # Mirror MetricDefinitionCreate: a grouping column set without an
        # explicit mode is normalized to 'column' so persisted metrics are
        # self-describing.
        if self.grouping_mode is None and self.grouping_column_id is not None:
            self.grouping_mode = "column"
        return self


class QuickComputeResponse(BaseModel):
    metrics: list[MetricDefinitionResponse]
    computed_count: int
    reused_count: int


# ═══════════════════════════════════════════════════════════════════════════════
# Analysis columns schemas
# ═══════════════════════════════════════════════════════════════════════════════


class AnalysisColumnItem(BaseModel):
    id: int
    dataset_id: int
    dataset_name: str
    column_code: str | None = None
    column_name: str | None = None
    column_text: str
    column_type: str
    scale_labels: list[str] | None = None
    equivalence_group_id: int | None = None
    domain_ids: list[int] = []


class AnalysisDatasetGroup(BaseModel):
    id: int
    name: str
    columns: list[AnalysisColumnItem]


class AnalysisDomainItem(BaseModel):
    id: int
    name: str
    member_count: int
    datasets: list[str]


class AnalysisDemographicItem(BaseModel):
    id: int
    column_name: str | None = None
    column_text: str
    dataset_id: int
    dataset_name: str
    subtype: str | None = None


class AnalysisColumnsResponse(BaseModel):
    datasets: list[AnalysisDatasetGroup]
    domains: list[AnalysisDomainItem]
    demographics: list[AnalysisDemographicItem]


# ═══════════════════════════════════════════════════════════════════════════════
# Cross-tabulation schemas
# ═══════════════════════════════════════════════════════════════════════════════


class CrossTabRequest(BaseModel):
    row_column_id: int
    col_column_id: int
    include_chi_square: bool = True


class CrossTabCell(BaseModel):
    count: int
    row_pct: float
    col_pct: float
    total_pct: float


class ChiSquareResult(BaseModel):
    statistic: float
    p_value: float
    df: int
    cramers_v: float


class CrossTabResponse(BaseModel):
    row_values: list[str]
    col_values: list[str]
    matrix: list[list[CrossTabCell]]  # matrix[row_idx][col_idx]
    row_totals: list[int]
    col_totals: list[int]
    n_shared: int
    row_column_label: str
    col_column_label: str
    chi_square: ChiSquareResult | None = None


# ═══════════════════════════════════════════════════════════════════════════════
# Row score schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RowScoreItem(BaseModel):
    dataset_row_id: int
    row_identifier: str | None = None
    score: float | None = None


class RowScoresResponse(BaseModel):
    metric_id: int
    metric_name: str
    scores: list[RowScoreItem]


class MatrixColumnInfo(BaseModel):
    metric_id: int
    label: str
    metric_type: str


class MatrixRowItem(BaseModel):
    dataset_row_id: int
    row_identifier: str | None = None
    dataset_name: str | None = None
    scores: dict[str, float | None]  # metric_id (as string) -> score


class RowMatrixResponse(BaseModel):
    columns: list[MatrixColumnInfo]
    rows: list[MatrixRowItem]
