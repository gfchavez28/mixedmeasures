"""Pydantic response models for code analysis endpoints."""

from typing import Literal
from pydantic import BaseModel


class CoderCoverageItem(BaseModel):
    """A coder who has real codings in scope (Track J · Group A — #1/#3/#13)."""
    user_id: int
    username: str
    display_color: str | None = None
    archived: bool = False


class CoderCoverageResponse(BaseModel):
    coders: list[CoderCoverageItem]
    count: int


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


class QuoteRange(BaseModel):
    """A sub-clip quote's span, in absolute timeline seconds (slab 5c/D29)."""
    start_time: float
    end_time: float


class CodedSegmentWithContext(BaseModel):
    id: int
    sequence_order: int
    speaker_name: str | None
    speaker_color_index: int
    is_facilitator: bool
    text: str
    start_time: float | None
    # Observation clips only (D25): the clip's end — with start_time it makes
    # the timecode RANGE. Declared here or Pydantic silently drops it (the
    # splat trap); conv/doc rows leave it None.
    end_time: float | None = None
    is_quoted: bool
    # Observation clips only (slab 5c): the SUB-CLIP time ranges quoted on this
    # clip, so a card can show which moment was quoted. A whole-clip quote is
    # deliberately absent — it has no range of its own, and `is_quoted` already
    # says so. Defaulted, or the splat drops it on conv/doc rows.
    quote_ranges: list[QuoteRange] = []
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


class ObservationSegmentGroup(BaseModel):
    observation_id: int
    observation_name: str
    # Occurrence-strip denominator (slab 5, D31). Declared or Pydantic drops
    # it (the splat trap); NULL for pre-#574 .mov/.webm — client degrades to
    # max clip end.
    media_duration_seconds: float | None = None
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
    observations: list[ObservationSegmentGroup] = []


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
    observation_ids: list[int] | None = None
    exclude_facilitator: bool = True
    participant_ids: list[int] | None = None
    group_by_subtype: str | None = None
    aggregation: Literal["code", "category"] = "code"
    # Track J · J1 item 4 — scope analysis output to selected coders (None/empty = all coders)
    coder_ids: list[int] | None = None
    layer_scope: str | None = None  # J2 Slab 7: "human" (default) | "consensus"


class CodeCountEntry(BaseModel):
    count: int
    word_count: int


class SourceGroupData(BaseModel):
    total_segments: int
    total_word_count: int
    coded_segments: int
    code_counts: dict[str, CodeCountEntry]


class SourceEntry(BaseModel):
    source_type: Literal["conversation", "text_column", "document", "observation"]
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
    total_observations: int = 0
    total_text_columns: int
    # #749 — `coded_segments` above pools transcript segments AND coded texts.
    # These two split it, so a "% of coded texts" is never divided by a number
    # that also counted segments.
    coded_transcript_segments: int = 0
    coded_texts: int = 0
    total_participants: int = 0
    total_records: int = 0
    unlinked_speaker_count: int = 0


class CodeInfo(BaseModel):
    id: int
    name: str
    color: str | None
    category_id: int | None
    category_name: str | None
    category_color: str | None = None
    is_universal: bool
    numeric_id: int
    # #749 — the two counts a client CANNOT derive from `sources`, because one
    # participant speaks across conversations and one record can be coded in
    # several text columns, so summing per-source counts double-counts them.
    # Under `aggregation="category"` these are per-CATEGORY (distinct people /
    # rows with any code in the category), not the sum over its codes.
    participant_count: int = 0
    record_count: int = 0


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
    # Track J · J1 item 4 — scope analysis output to selected coders (None/empty = all coders)
    coder_ids: list[int] | None = None
    layer_scope: str | None = None  # J2 Slab 7: "human" (default) | "consensus"


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
    source_type: str  # "conversation" | "document" | "observation"
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


# ── Inter-rater reliability (Track J · J2-4) ──────────────────────────────────


class IrrCoderInfo(BaseModel):
    id: int
    name: str


class IrrCodeResult(BaseModel):
    code_id: int
    code_name: str
    n_units: int
    percent_agreement: float | None = None
    prevalence: float | None = None
    cohens_kappa: float | None = None
    kappa_interpretation: str | None = None
    krippendorff_alpha: float | None = None
    alpha_interpretation: str | None = None
    #: #829 — why κ/α are None here. `no_variance` = nobody applied this code
    #: in scope (or everybody did), so there is nothing to agree about; reporting
    #: κ = 1 "almost perfect" was the defect (#689's rule, one surface over).
    undefined_reason: str | None = None


class IrrSourceInfo(BaseModel):
    """One selectable source for the reliability scope (#829).

    ``key`` is the wire form ``"kind:id"`` — it rides the query string AND the
    React Query key, so the two can never describe different scopes.
    """
    key: str
    kind: str
    label: str


class IrrResponse(BaseModel):
    available: bool
    reason: str | None = None
    #: Every source ≥2 coders engaged — the picker's options (#829).
    sources: list[IrrSourceInfo] = []
    #: The scope this payload was computed on; ``None`` = pooled across all.
    source: str | None = None
    n_coders: int
    coders: list[IrrCoderInfo] = []
    metric_label: str | None = None
    per_code: list[IrrCodeResult] = []
    overall_alpha: float | None = None
    overall_alpha_interpretation: str | None = None
    interpretation_thresholds: dict = {}


class ConsensusStatusResponse(BaseModel):
    """Consensus-layer status for the J2-5 layer selector + the "consensus may be
    out of date" affordance (Track J · J2-5, M-2).

    - ``enabled`` — the instance roster can form consensus at all (≥2 selectable
      coders; GLOBAL, mirrors ``consensus_enabled``). Single-coder instances skip
      all consensus work.
    - ``exists`` — THIS project has materialized consensus applications. Drives
      "offer the consensus view only when it exists" (DEC-A).
    - ``stale_count`` — pending ``ConsensusStaleTarget`` markers for this project;
      >0 means the consensus layer may be behind the human layers (the background
      sweep drains them). Drives the "recompute" affordance (UX-1)."""
    enabled: bool
    exists: bool
    stale_count: int


# ── Reconciliation grid (Track J · J2-5, M-1) ────────────────────────────────


class ReconciliationCodeInfo(BaseModel):
    """Legend entry for a code referenced on the page (effective/canonical code)."""
    id: int
    name: str
    color: str | None = None


class ReconciliationUnit(BaseModel):
    """One coding unit (a segment XOR a dataset value) pivoted across coders.

    ``by_coder`` / ``consensus`` hold EFFECTIVE code ids (D3 equivalence-resolved);
    map them to names via the response's ``codes`` legend. ``by_coder`` and
    ``engaged`` are SOURCE-level (Option B — an engaged coder who left this unit
    blank appears with an empty list, a real disagreement). ``consensus`` is
    TARGET-level (the coders who coded THIS unit) so it matches the materialized
    layer. A unit can have a consensus AND ``has_disagreement`` (a dissenting
    minority/blank worth reviewing)."""
    unit_type: str  # "segment" | "dataset_value"
    unit_id: int
    source_type: str  # "conversation" | "document" | "observation" | "column"
    source_id: int
    source_label: str
    text: str
    # An observation clip's identity is its time range — `text` holds only its
    # label and is routinely empty, so the grid renders the range instead. NULL for
    # dataset values and for transcript segments without timestamps. These MUST be
    # declared here: the service returns a plain dict validated against the
    # response_model, so an undeclared field is dropped silently (the #586 class).
    start_time: float | None = None
    end_time: float | None = None
    by_coder: dict[str, list[int]]  # str(coder_id) → effective code ids applied here
    engaged: list[int]  # source-engaged coder ids (reviewed the source)
    consensus: list[int]  # effective code ids in the derived consensus
    consensus_context: dict[str, dict]  # str(effective_code_id) → {rule, agree, voters}
    has_disagreement: bool


class ReconciliationResponse(BaseModel):
    available: bool
    reason: str | None = None
    n_coders: int
    coders: list[IrrCoderInfo] = []
    codes: list[ReconciliationCodeInfo] = []
    units: list[ReconciliationUnit] = []
    total: int = 0
    has_more: bool = False


class RecomputeConsensusResponse(BaseModel):
    """Result of an explicit consensus recompute (Track J · J2-5, M-3).

    - ``recomputed`` — consensus targets re-derived this call.
    - ``remaining`` — staleness markers still pending for the project (best-effort
      count; the background sweep + other recomputes may change it concurrently)."""
    recomputed: int
    remaining: int


class RevealRequest(BaseModel):
    """Body for the blind-mode reveal log (Track J · J2-5, DEC-G). ``surface`` =
    where the reveal happened ('workbench' | 'reconciliation' | 'irr')."""
    surface: str | None = None


class RevealResponse(BaseModel):
    logged: bool


# ── Open-cut reliability (Observations slab 6b-A) ────────────────────────────


class OpenCutDisclosureResponse(BaseModel):
    """What the computation did to the data before measuring it.

    Not diagnostics — REPRODUCIBILITY. Each field is a modelling decision that
    moves the result, so a reader who cannot see them cannot check the number.
    """
    tick_ms: int
    continuum_seconds: float
    # "recording" | "marked_extent" — #622's lesson: a fallback denominator must
    # never be presented as if it were the recording's true length.
    extent_source: str
    n_merged_overlaps: int
    n_zero_length_dropped: int
    n_clips_without_times: int
    engaged_coder_ids: list[int]
    excluded_coder_ids: list[int]


class UnitizingCategoryResult(BaseModel):
    code_id: int
    code_name: str
    n_units: int
    alpha: float | None
    interpretation: str | None
    """Share of the continuum marked with this code — α_U's own prevalence
    figure. Deliberately NOT the same denominator as binned κ's `prevalence`."""
    coverage_fraction: float | None


class UnitizingOverall(BaseModel):
    alpha: float | None
    interpretation: str | None


class UnitizingAlphaResponse(BaseModel):
    available: bool
    reason: str | None = None
    n_coders: int
    coders: list[int]
    overall: UnitizingOverall | None = None
    per_category: list[UnitizingCategoryResult] = []
    disclosure: OpenCutDisclosureResponse
    interpretation_thresholds: dict = {}


class BinnedKappaCodeResult(BaseModel):
    code_id: int
    code_name: str
    n_bins: int
    percent_agreement: float | None
    cohens_kappa: float | None
    krippendorff_alpha: float | None
    """The base rate. Always displayed beside the coefficient: on a long
    recording most bins are empty for everyone, so percent agreement can read
    ~99% while κ collapses — the prevalence is what tells them apart."""
    prevalence: float | None
    interpretation: str | None


class BinnedKappaResponse(BaseModel):
    available: bool
    reason: str | None = None
    n_coders: int
    coders: list[int]
    bin_seconds: float = 0.0
    n_bins: int = 0
    per_code: list[BinnedKappaCodeResult] = []
    disclosure: OpenCutDisclosureResponse
    interpretation_thresholds: dict = {}
