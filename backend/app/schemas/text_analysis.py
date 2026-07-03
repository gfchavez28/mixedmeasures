"""Pydantic schemas for comment cross-analysis endpoints."""

from pydantic import BaseModel


# ── Request schemas ──────────────────────────────────────────────────────────

class SubgroupFilter(BaseModel):
    """A single filter criterion for subgroup analysis."""
    column_id: int
    operator: str  # "equals", "in", "gte", "lte", "above_mean", "below_mean"
    values: list[str] | None = None  # for equals/in
    value: float | None = None  # for gte/lte


class FilteredFrequenciesRequest(BaseModel):
    column_ids: list[int]
    filters: list[SubgroupFilter] = []
    include_overall: bool = True
    # Track J · J1 item 4 — scope analysis output to selected coders (None/empty = all coders)
    coder_ids: list[int] | None = None
    # Track J · J2 slab 3b — coder layer: None/'human' (default) or 'consensus'
    layer_scope: str | None = None


class CrossTabulationRequest(BaseModel):
    text_column_ids: list[int]
    cross_column_id: int
    code_ids: list[int] | None = None
    # Track J · J1 item 4 — scope analysis output to selected coders (None/empty = all coders)
    coder_ids: list[int] | None = None
    # Track J · J2 slab 3b — coder layer: None/'human' (default) or 'consensus'
    layer_scope: str | None = None


# ── Response schemas ─────────────────────────────────────────────────────────

class CodeFrequencyBrief(BaseModel):
    code_id: int
    code_name: str
    code_color: str | None
    count: int
    percentage: float


class FrequencySet(BaseModel):
    row_count: int
    text_count: int
    frequencies: list[CodeFrequencyBrief]


class FilteredFrequenciesResponse(BaseModel):
    filtered: FrequencySet
    overall: FrequencySet | None = None
    filter_description: str
    filter_scope: dict  # {filtered_datasets: [...], unfiltered_datasets: [...]}


class CrossTabRow(BaseModel):
    code_id: int
    code_name: str
    code_color: str | None
    counts: dict[str, int]  # response_value -> count
    percentages: dict[str, float]  # response_value -> percentage
    row_total: int


class CrossTabulationResponse(BaseModel):
    cross_column_name: str
    response_values: list[str]
    matrix: list[CrossTabRow]
    column_totals: dict[str, int]
    total_coded_texts: int


class CodeDensityGroup(BaseModel):
    group_value: str
    avg_codes_per_text: float
    text_count: int


class CodeDensityResponse(BaseModel):
    groups: list[CodeDensityGroup]
    overall: CodeDensityGroup


class ResponseLengthCode(BaseModel):
    code_id: int
    code_name: str
    code_color: str | None
    avg_words: float
    text_count: int


class ResponseLengthUncoded(BaseModel):
    avg_words: float
    text_count: int


class ResponseLengthResponse(BaseModel):
    codes: list[ResponseLengthCode]
    uncoded: ResponseLengthUncoded
