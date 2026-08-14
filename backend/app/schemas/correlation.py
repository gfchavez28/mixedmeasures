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
    # #689: `None`, not `0.0`/`1.0`. A cell reading `r = 0.00 (p = 1.00)` is
    # read as a measured absence of relationship; the truth in these cells is
    # "not computable" — too few shared rows, or a column that does not vary.
    r: float | None = None
    p: float | None = None
    n: int
    undefined_reason: str | None = None


class CorrelationMatrixResponse(BaseModel):
    labels: list[str]
    full_labels: list[str]
    matrix: list[list[CorrelationCell]]
    adjusted_alpha: float | None = None
    num_comparisons: int


class RegressionResult(BaseModel):
    # #689: all-zeros drew a flat line through the origin and reported
    # `r = 0.00` — a fitted model where nothing was fitted.
    slope: float | None = None
    intercept: float | None = None
    r_squared: float | None = None
    r: float | None = None
    p: float | None = None
    undefined_reason: str | None = None


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
