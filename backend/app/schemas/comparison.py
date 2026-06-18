"""Pydantic schemas for group comparison endpoints."""

from pydantic import BaseModel, Field


# ── Request schemas ────────────────────────────────────────────────────────────


class GroupComparisonRequest(BaseModel):
    column_ids: list[int] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    grouping_column_id: int
    grouping_column_id_2: int | None = None
    test_type: str = Field(default="auto", pattern="^(auto|t_test|anova)$")
    include_effect_size_ci: bool = True
    exclude_groups: list[str] = Field(default_factory=list)
    nonparametric: bool = False


# ── Response schemas ───────────────────────────────────────────────────────────


class GroupStat(BaseModel):
    group: str
    n: int
    mean: float
    sd: float
    median: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None


class TestResult(BaseModel):
    test_type: str
    statistic: float
    df: float
    df2: float | None = None
    p: float
    effect_size: float
    effect_size_type: str
    effect_size_label: str | None = None
    omega_squared: float | None = None
    post_hoc: dict | None = None
    effect_size_ci_lower: float | None = None
    effect_size_ci_upper: float | None = None


class ComparisonRow(BaseModel):
    label: str
    full_label: str
    source_id: int
    source_type: str
    group_stats: list[GroupStat]
    test: TestResult | None = None


class GroupComparisonResponse(BaseModel):
    groups: list[str]
    group_column_label: str
    rows: list[ComparisonRow]
    bonferroni_warning: bool = False
    bonferroni_threshold: float | None = None
