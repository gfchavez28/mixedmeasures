"""Pydantic response models for code analysis endpoints."""

from typing import Literal
from pydantic import BaseModel


class CodeFrequencyItem(BaseModel):
    code_id: int
    code_name: str
    code_color: str | None
    is_universal: bool
    category_id: int | None
    category_name: str | None
    category_color: str | None
    segment_count: int
    segment_percentage: float
    conversation_count: int
    conversation_percentage: float
    participant_count: int
    participant_percentage: float
    text_count: int = 0
    text_percentage: float = 0.0
    row_count: int = 0
    row_percentage: float = 0.0


class CodeFrequencySummary(BaseModel):
    frequencies: list[CodeFrequencyItem]
    total_coded_segments: int
    total_conversations: int
    total_participants: int
    total_codes_active: int
    unlinked_speaker_count: int
    total_coded_texts: int = 0
    total_rows: int = 0
    source: str = "conversations"


class ContextSegment(BaseModel):
    id: int
    sequence_order: int
    speaker_name: str | None
    speaker_color_index: int
    is_facilitator: bool
    text: str
    start_time: float | None


class CodedSegmentWithContext(BaseModel):
    id: int
    sequence_order: int
    speaker_name: str | None
    speaker_color_index: int
    is_facilitator: bool
    text: str
    start_time: float | None
    is_quoted: bool
    applied_code_ids: list[int]
    preceding_context: list[ContextSegment]
    following_context: list[ContextSegment]
    participant_id: int | None
    participant_name: str | None


class ConversationSegmentGroup(BaseModel):
    conversation_id: int
    conversation_name: str
    segment_count: int
    segments: list[CodedSegmentWithContext]


class DocumentSegmentGroup(BaseModel):
    document_id: int
    document_name: str
    segment_count: int
    segments: list[CodedSegmentWithContext]


class CodeSegmentsWithContextResponse(BaseModel):
    code_id: int
    code_name: str
    code_color: str | None
    category_name: str | None
    total_segments: int
    has_more: bool
    conversations: list[ConversationSegmentGroup]
    documents: list[DocumentSegmentGroup] = []


class DemographicFilterValue(BaseModel):
    value: str
    participant_ids: list[int]
    count: int


class DemographicFilter(BaseModel):
    subtype: str
    label: str
    values: list[DemographicFilterValue]


class ConversationOption(BaseModel):
    id: int
    name: str


class DemographicFilterOptionsResponse(BaseModel):
    filters: list[DemographicFilter]
    conversations: list[ConversationOption]


class CooccurrenceCodeInfo(BaseModel):
    id: int
    name: str
    color: str | None
    category_name: str | None
    category_color: str | None = None
    is_universal: bool


class CooccurrenceMatrixResponse(BaseModel):
    codes: list[CooccurrenceCodeInfo]
    matrix: list[list[int]]
    max_cooccurrence: int
    total_coded_segments: int
    total_coded_texts: int = 0
    source: str = "conversations"


# ── Coded texts (for QualitativeAnalysisView Examples tab) ────────────

class CodedTextInfo(BaseModel):
    dataset_value_id: int
    value_text: str
    word_count: int
    row_identifier: str | None
    dataset_name: str
    column_name: str
    applied_code_ids: list[int]


class DatasetTextGroup(BaseModel):
    dataset_id: int
    dataset_name: str
    text_count: int
    texts: list[CodedTextInfo]


class CodeTextsResponse(BaseModel):
    code_id: int
    code_name: str
    code_color: str | None
    category_name: str | None
    total_texts: int
    has_more: bool
    datasets: list[DatasetTextGroup]


# ── Source Frequencies ────────────────────────────────────────────────────

class SourceFrequenciesRequest(BaseModel):
    code_ids: list[int] | None = None
    conversation_ids: list[int] | None = None
    text_column_ids: list[int] | None = None
    document_ids: list[int] | None = None
    exclude_facilitator: bool = True
    participant_ids: list[int] | None = None
    group_by_subtype: str | None = None
    aggregation: Literal["code", "category"] = "code"


class CodeCountEntry(BaseModel):
    count: int
    word_count: int


class SourceGroupData(BaseModel):
    total_segments: int
    total_word_count: int
    coded_segments: int
    code_counts: dict[str, CodeCountEntry]


class SourceEntry(BaseModel):
    source_type: Literal["conversation", "text_column", "document"]
    source_id: int
    source_label: str
    dataset_id: int | None = None
    dataset_name: str | None = None
    total_segments: int
    total_word_count: int
    coded_segments: int
    import_order: int | None = None
    code_counts: dict[str, CodeCountEntry] | None = None
    groups: dict[str, SourceGroupData] | None = None


class SourceFrequenciesTotals(BaseModel):
    total_segments: int
    total_word_count: int
    coded_segments: int
    total_sources: int
    total_conversations: int
    total_documents: int = 0
    total_text_columns: int


class CodeInfo(BaseModel):
    id: int
    name: str
    color: str | None
    category_id: int | None
    category_name: str | None
    category_color: str | None = None
    is_universal: bool
    numeric_id: int


class SourceFrequenciesResponse(BaseModel):
    codes: list[CodeInfo]
    sources: list[SourceEntry]
    totals: SourceFrequenciesTotals
    group_by: str | None


# ── Demographic Comparison ────────────────────────────────────────────────

class DemographicComparisonRequest(BaseModel):
    code_ids: list[int] | None = None
    group_by_subtype: str
    conversation_ids: list[int] | None = None
    text_column_ids: list[int] | None = None
    exclude_facilitator: bool = True
    participant_ids: list[int] | None = None


class GroupTotal(BaseModel):
    total_segments: int
    total_word_count: int


class GroupCodeStats(BaseModel):
    count: int
    proportion: float


class StatTestResult(BaseModel):
    method: str
    statistic: float | None
    p_value: float
    significant: bool
    effect_size: float | None = None
    effect_size_label: str | None = None


class CodeComparisonEntry(BaseModel):
    code_id: int
    code_name: str
    category_name: str | None
    by_group: dict[str, GroupCodeStats]
    delta_proportion: float | None
    test: StatTestResult | None


class DemographicComparisonResponse(BaseModel):
    groups: list[str]
    group_totals: dict[str, GroupTotal]
    codes: list[CodeComparisonEntry]


# ── Saturation ────────────────────────────────────────────────────────────

class SaturationPoint(BaseModel):
    source_index: int
    source_label: str
    source_type: str  # "conversation" or "document"
    cumulative_unique_codes: int
    new_codes_this_source: int
    new_code_names: list[str]


class SaturationResponse(BaseModel):
    points: list[SaturationPoint]
    total_unique_codes: int
    total_sources: int
    category_level: bool


# ── Text columns ──────────────────────────────────────────────────────────

class TextColumnInfo(BaseModel):
    column_id: int
    column_name: str | None
    column_text: str
    dataset_id: int
    dataset_name: str
    coded_count: int
