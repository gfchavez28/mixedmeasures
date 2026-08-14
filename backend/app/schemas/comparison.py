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
    # #689: `None`, not `0.0`, when the group is empty — a mean of zero with a
    # zero-width CI is a measurement claim about people who are not there.
    # `median` was ALREADY nullable in the same object, which is how the
    # inconsistency stayed invisible.
    mean: float | None = None
    sd: float | None = None
    median: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None
    #: Why the values above are absent. One of `services/undefined_stats.py`'s
    #: reasons; `None` when they are present.
    undefined_reason: str | None = None


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
    # Classified from omega_squared, not from effect_size — a display that shows
    # omega must not borrow eta's word for it (#742).
    omega_squared_label: str | None = None
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
    #: #566 — why no test was run. A bare `None` test rendered blank delta/p/d
    #: cells that a researcher could not tell from a broken tool; this names the
    #: refusal. `None` when a test IS present.
    test_omitted_reason: str | None = None


class GroupComparisonResponse(BaseModel):
    groups: list[str]
    group_column_label: str
    rows: list[ComparisonRow]
    bonferroni_warning: bool = False
    bonferroni_threshold: float | None = None
