"""Pydantic schemas for correlation endpoints."""

from pydantic import BaseModel, Field


# ── Request schemas ────────────────────────────────────────────────────────────


class CorrelationMatrixRequest(BaseModel):
    column_ids: list[int] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    correlation_type: str = Field(default="pearson", pattern="^(pearson|spearman)$")
    bonferroni: bool = False


class ScatterDataRequest(BaseModel):
    x_id: int
    y_id: int
    id_type: str = Field(default="column", pattern="^(column|domain)$")
    group_column_id: int | None = None


class ScatterMatrixRequest(BaseModel):
    column_ids: list[int] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    id_type: str = Field(default="column", pattern="^(column|domain)$")
    group_column_id: int | None = None
    max_variables: int = Field(default=10, ge=2, le=20)


# ── Response schemas ───────────────────────────────────────────────────────────


class CorrelationCell(BaseModel):
    r: float
    p: float
    n: int


class CorrelationMatrixResponse(BaseModel):
    labels: list[str]
    full_labels: list[str]
    matrix: list[list[CorrelationCell]]
    adjusted_alpha: float | None = None
    num_comparisons: int


class RegressionResult(BaseModel):
    slope: float
    intercept: float
    r_squared: float
    r: float
    p: float


class ScatterDataResponse(BaseModel):
    x_label: str
    y_label: str
    x: list[float]
    y: list[float]
    record_ids: list[int]
    groups: list[str] | None = None
    n: int
    regression: RegressionResult
    group_regressions: dict[str, RegressionResult] | None = None


class ScatterPair(BaseModel):
    x_index: int
    y_index: int
    x_label: str
    y_label: str
    x: list[float]
    y: list[float]
    record_ids: list[int]
    groups: list[str] | None = None
    n: int
    regression: RegressionResult


class ScatterMatrixResponse(BaseModel):
    labels: list[str]
    full_labels: list[str]
    pairs: list[ScatterPair]
    truncated: bool = False
