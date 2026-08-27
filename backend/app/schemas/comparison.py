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
    #: #525b — OPT-IN, unlike every other diagnostic in this payload. The box
    #: summary and the normality check are ~10 numbers per group; a QQ plot is
    #: O(n) points, so it is built only for the panel that draws it.
    include_qq: bool = False


# ── Response schemas ───────────────────────────────────────────────────────────


class BoxSummary(BaseModel):
    """The five-number summary behind a box plot (#522b).

    ⚠️ `quartile_method` and `whisker_rule` ride the payload deliberately — the
    stated-basis family. Several quartile definitions exist and they disagree on
    small samples, so a box plot is only interpretable if the reader is told
    which one drew it. The client DISPLAYS these; it must never assume them.
    """

    min: float | None = None
    q1: float | None = None
    median: float | None = None
    q3: float | None = None
    max: float | None = None
    #: Tukey whiskers — the most extreme observation still within 1.5 x IQR.
    whisker_low: float | None = None
    whisker_high: float | None = None
    #: Points beyond the fences, capped; `outliers_omitted` counts the rest so a
    #: pathological group reports honestly instead of silently truncating.
    outliers: list[float] = []
    outliers_omitted: int = 0
    quartile_method: str
    whisker_rule: str


class AssumptionCheck(BaseModel):
    """A normality or equal-variance check (#525).

    ⚠️ `statistic`/`p` are `None` WITH a reason rather than absent — the #566/#689
    convention: a blank cell is indistinguishable from a broken tool. `center` is
    present on Levene only, and is STATED because centring on the mean gives a
    different number from the same data (median = Brown–Forsythe).
    """

    test: str
    statistic: float | None = None
    p: float | None = None
    center: str | None = None
    undefined_reason: str | None = None
    #: #525b — Levene only. Groups that are in the COMPARISON but not in the
    #: test: empty ones are dropped outright, and a singleton contributes a
    #: structural zero deviation that reads as perfect homogeneity. Named rather
    #: than refused, the way normality already names what it could not test.
    excluded_groups: list[str] = []
    singleton_groups: list[str] = []


class QQPoint(BaseModel):
    """One plotted pair. `theoretical` is the normal quantile at this position."""

    theoretical: float
    sample: float


class QQSummary(BaseModel):
    """The normal QQ diagnostic for a comparison row (#525b).

    ⚠️ `plotting_position` and `reference_line` ride the payload — the
    stated-basis family. R's `ppoints()` switches convention at n > 10 (Blom
    below, Hazen above), so "which position" is sample-size-dependent in the
    reference implementation itself and cannot be assumed by a reader.
    """

    #: Thinned to `MAX_QQ_POINTS` by evenly-spaced order statistics, ALWAYS
    #: keeping both extremes — the tails are what the reader is judging.
    points: list[QQPoint] = []
    #: Points not drawn, so a truncation is never silent (`outliers_omitted`).
    points_omitted: int = 0
    #: Residuals behind the plot — NOT `len(points)`, which is post-thinning.
    n: int = 0
    #: Probability-plot correlation: how straight the line is. Computed on ALL
    #: the residuals, never the thinned set — it describes the data, not the
    #: drawing. This is the accessible equivalent of the picture.
    ppcc: float | None = None
    #: R's `qqline()` — through the first and third quartile pairs.
    line_slope: float | None = None
    line_intercept: float | None = None
    #: Groups of one, whose residual is exactly 0 by construction rather than by
    #: evidence. Reported so the caption can say so.
    singleton_group_count: int = 0
    plotting_position: str
    reference_line: str
    undefined_reason: str | None = None


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
    #: #522b — absent for an empty group, exactly like `mean`/`median` above.
    box: BoxSummary | None = None
    #: #525 — Shapiro-Wilk for THIS group.
    normality: AssumptionCheck | None = None


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
    #: #525 — Levene across the row's groups; a property of the comparison.
    variance_homogeneity: AssumptionCheck | None = None
    #: #525b — the QQ diagnostic, per ROW because normality is a property of the
    #: model's residuals. `None` unless the request asked for it.
    qq: QQSummary | None = None


class GroupComparisonResponse(BaseModel):
    groups: list[str]
    group_column_label: str
    rows: list[ComparisonRow]
    bonferroni_warning: bool = False
    bonferroni_threshold: float | None = None
    #: Why `rows` is empty — one of `services/undefined_stats.py`'s
    #: `UNAVAILABLE_REASONS`; `None` when rows were produced.
    #:
    #: 🔴 **The client used to invent this.** It printed *"The selected
    #: demographic may have fewer than 2 groups"* for every empty result, which
    #: is right for one of four causes and actively misleading for the rest — a
    #: 5-group variable whose scale scores had never been computed (#823c) and a
    #: 3-group variable in another dataset (#827) both got it. The server knows
    #: which cause applies at each early return; the client renders the sentence
    #: and never derives one, the same contract as the stated-basis family.
    unavailable_reason: str | None = None
