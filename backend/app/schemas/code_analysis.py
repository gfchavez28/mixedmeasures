"""Pydantic response models for code analysis endpoints."""

from typing import Literal
from pydantic import BaseModel, model_validator

from .common import CodeApplicationIdentity


class CoderCoverageItem(BaseModel):
    """A coder who has real codings in scope (Track J · Group A — #1/#3/#13)."""
    user_id: int
    username: str
    display_color: str | None = None
    archived: bool = False
    #: #1030 — `human` · `ai`. Lets a surface ask whether a MODEL coded this
    #: project/source without the install-wide roster, and names an archived
    #: machine as a machine (the roster excludes archived coders).
    coder_type: str = "human"


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
    # None for a universal code (#1526 D79 — `frontend/src/lib/universal-share.ts`).
    segment_percentage: float | None
    conversation_count: int
    conversation_percentage: float
    participant_count: int
    participant_percentage: float
    text_count: int = 0
    row_count: int = 0
    # text_percentage / row_percentage / total_rows were deleted by #1526 D81 (no reader since #749).


class CodeFrequencySummary(BaseModel):
    frequencies: list[CodeFrequencyItem]
    total_coded_segments: int
    total_conversations: int
    total_participants: int
    total_codes_active: int
    unlinked_speaker_count: int
    total_coded_texts: int = 0
    source: str = "conversations"


class ContextSegment(BaseModel):
    id: int
    sequence_order: int
    speaker_name: str | None
    speaker_color_index: int
    # The speaker's CUSTOM colour, when one is set. The service has always
    # emitted it; the schema never declared it, so Pydantic dropped it at the
    # wire and the analysis surfaces could only ever paint the index palette
    # (#855's class, found by the test-time `extra='forbid'` detector,
    # 2026-09-04). Defaulted, so an older payload still parses.
    speaker_color: str | None = None
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
    # See `ContextSegment.speaker_color` — emitted by the service, dropped by
    # the schema until 2026-09-04.
    speaker_color: str | None = None
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
    # #1592 — who applied each code (`services/code_analysis.py::_unit_chips`, the same
    # rows as `applied_code_ids`). REQUIRED: a builder that omits it fails validation.
    applied_code_details: list[CodeApplicationIdentity]
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
    #: #969 — each kind's own total, for its section's "Showing N of M". The three
    #: sum to `total_segments`; the sum alone cannot be split back apart.
    conversation_total: int = 0
    document_total: int = 0
    observation_total: int = 0
    #: True while ANY kind has rows past `offset + limit` (#969: it was the
    #: conversation kind's alone).
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
    # #1615: subtypes left out while blind (each holds a variable worked out from
    # participant scores). A count, never which — the Data view's #1608 shape.
    withheld_rating_filters: int = 0


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
    # #1527 D83: the units the matrix was counted over (the source level: sources) —
    # replaced `total_coded_segments` + `total_coded_texts`, which left documents and
    # clips out of the figure's N.
    n_units: int
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
    # #1592 — who applied each code, from the same rows (`_unit_chips`).
    applied_code_details: list[CodeApplicationIdentity]
    # #1640 — the project counts this answer as no response (`is_empty_text`): it stays
    # in the list, marked, and out of the Descriptives table's shares.
    counted_as_no_response: bool


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
    # #1615 — sent ONLY while blind mode withholds (D102's shape): `coder_ids` is then the
    # blind scope, and a grouping worked out from participant scores is refused.
    ratings_follow_coder_ids: bool = False
    # #1615 (D297's Canvas path) — a Canvas embed's `coder_ids` is the FIGURE's saved scope, not
    # the viewer, so it sends the viewer's own id here, ONLY while blind mode withholds. It is the
    # grouping gate's blind scope and nothing else: the coding the figure counts does not move.
    ratings_viewer_id: int | None = None


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
    # D166: the groups are named by a demographic SUBTYPE (what saved materials carry)
    # or by ONE categorical column's id — exactly one of the two.
    group_by_subtype: str | None = None
    group_by_column_id: int | None = None
    # Per source kind: None = every source of that kind; a list = exactly those
    # ([] = none of that kind) — #1297/#1298.
    conversation_ids: list[int] | None = None
    text_column_ids: list[int] | None = None
    document_ids: list[int] | None = None
    # Observations have no participant link; sent only so the result can say how
    # many were left out.
    observation_ids: list[int] | None = None
    exclude_facilitator: bool = True
    participant_ids: list[int] | None = None
    # Track J · J1 item 4 — scope analysis output to selected coders (None/empty = all coders)
    coder_ids: list[int] | None = None
    layer_scope: str | None = None  # J2 Slab 7: "human" (default) | "consensus"
    # #1615 — sent ONLY while blind mode withholds (D102's shape).
    ratings_follow_coder_ids: bool = False
    # #1615 (D297's Canvas path) — the viewer's id from a Canvas embed (see SourceFrequenciesRequest).
    ratings_viewer_id: int | None = None

    @model_validator(mode="after")
    def _one_grouping(self):
        if (self.group_by_subtype is None) == (self.group_by_column_id is None):
            raise ValueError("name the groups by group_by_subtype or group_by_column_id, exactly one")
        return self


class GroupTotal(BaseModel):
    # #1323: the denominator in the result's unit (`basis.unit`) — participants
    # with material in scope, or passages.
    n: int
    participants: int
    total_segments: int  # passages in scope (turns, document segments, answers)
    total_word_count: int
    # #1626 (D243): of `participants`, those with NO coding in scope under the request's
    # coder and layer scope — they count as "did not use" every code, and the page says so.
    without_coding: int


class GroupCodeStats(BaseModel):
    count: int  # in the result's unit
    # #1421: None when the group has no material in the sources compared —
    # `undefined_reason` (services/undefined_stats.py) says why.
    proportion: float | None
    undefined_reason: str | None = None
    passages: int  # #1323: always the passage count — a description, never tested


class StatTestResult(BaseModel):
    method: str
    statistic: float | None
    p_value: float
    # #1323: the p corrected across the codes tested in this result
    # (`basis.correction`); `significant` reads THIS one.
    p_adjusted: float | None
    significant: bool
    effect_size: float | None = None
    effect_size_label: str | None = None
    # #1549 (a): why `effect_size` is None while the test ran (`undefined_stats` —
    # today only `zero_cell`, an odds ratio of 0 or infinity). A real 0 is a value.
    effect_size_undefined_reason: str | None = None
    # #1323: the smallest p these margins can produce, and whether — under the
    # stated correction — this code could EVER reach significance at these sizes.
    min_attainable_p: float | None = None
    can_reach_significance: bool | None = None


class ComparisonInterval(BaseModel):
    """#1323, D3 — Δ's interval, with the method that made it (the stated-basis
    family's `ci_method`). The field names are `IrrInterval`'s; it carries no
    `unavailable_reason` because Δ's interval exists exactly when Δ does."""
    lower: float
    upper: float
    level: float
    #: `comparison_basis.CI_METHOD_NEWCOMBE_HYBRID` — mirrored in `lib/ci-label.ts`.
    method: str


class CodeComparisonEntry(BaseModel):
    code_id: int
    code_name: str
    category_name: str | None
    by_group: dict[str, GroupCodeStats]
    delta_proportion: float | None
    # Two groups, a tested unit and both shares defined; None otherwise.
    delta_ci: ComparisonInterval | None = None
    test: StatTestResult | None
    test_omitted_reason: str | None = None  # comparison_basis.TEST_OMITTED_REASONS


class ComparisonBasis(BaseModel):
    """#1323 — the stated basis (`services/comparison_basis.py` ↔ `lib/comparison-basis.ts`)."""
    unit: str
    correction: str
    family_size: int
    family_reachable: int
    tarone_family_size: int
    alpha: float
    tested_groups: list[str]
    test_omitted_reason: str | None


class ComparisonScope(BaseModel):
    """#1297/#1298 — what was counted, and what was left out, said by the server."""
    conversations: int
    documents: int
    text_columns: int
    observations_left_out: int
    unassigned_passages: int
    participants_without_group: int
    # #1626 (D244): whose coding "no coding" is about — `comparison_basis.NO_CODING_SCOPE_*`
    # (every coder · the coders shown · the consensus layer · the model). Stated, so the
    # client, the Canvas embed and the export never infer it from a request they lack.
    no_coding_scope: str


class DemographicComparisonResponse(BaseModel):
    groups: list[str]
    group_totals: dict[str, GroupTotal]
    codes: list[CodeComparisonEntry]
    basis: ComparisonBasis
    scope: ComparisonScope


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
    #: #708 (i) / #1148 — what the x-axis is ordered BY (`code_analysis.
    #: SATURATION_ORDERING_*`). The service emitted it from 2026-08-17 and this
    #: schema did not declare it, so `response_model=` dropped it and the chart's
    #: axis title and caveat never rendered. Optional because an older payload
    #: carries none, and the client then shows no ordering rather than guessing one.
    ordering: str | None = None


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


class IrrInterval(BaseModel):
    """A confidence interval, with the method that produced it (#43).

    Part of the stated-basis family: the server says HOW the interval was made
    and the client displays that, never inferring it from which coefficient it
    sits beside. κ's is analytic, α's is a bootstrap over units — different in
    kind, and a reader who cannot tell them apart cannot judge either.

    ``lower``/``upper`` are None only when ``unavailable_reason`` says why the
    resampling could not produce a usable interval; when the STATISTIC itself is
    undefined the whole object is None instead (its own `undefined_reason`
    already explains the blank cell).
    """
    lower: float | None = None
    upper: float | None = None
    level: float
    #: `reliability_intervals.CI_METHOD_*` — mirrored in `lib/ci-label.ts`.
    method: str
    #: Resamples that produced a defined α; None for the analytic κ interval.
    n_resamples: int | None = None
    #: `reliability_intervals.CI_UNAVAILABLE_*`.
    unavailable_reason: str | None = None


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
    #: #1505 (D43) — why κ and α carry NO band word although they have values:
    #: `reliability_basis.VERDICT_WITHHELD_*` (fewer comparable units than
    #: `IrrResponse.verdict_min_units`). ``None`` when the bands stand, when the
    #: coefficients are undefined (`undefined_reason` says why), and on payloads
    #: from before 1.5.9.
    verdict_withheld_reason: str | None = None
    #: #829 — why κ/α are None here. `no_variance` = nobody applied this code
    #: in scope (or everybody did), so there is nothing to agree about; reporting
    #: κ = 1 "almost perfect" was the defect (#689's rule, one surface over).
    #: `insufficient_n` = one comparable unit (#1505, D42): over one unit α is 0
    #: for any disagreement — an identity, not a measurement.
    undefined_reason: str | None = None
    #: #43 — each coefficient's own interval. Separate objects because the two
    #: are produced by different methods, so one shared `ci_method` would have
    #: to lie about one of them.
    kappa_ci: IrrInterval | None = None
    alpha_ci: IrrInterval | None = None
    #: #1333 — facilitator turns in scope carrying this code by any coder. They
    #: are NOT units (the stated `unit_basis`), so a non-zero count is the coding
    #: the exclusion left out, said rather than dropped. ``None`` when facilitator
    #: turns are units, and on payloads from before the field.
    facilitator_turns_coded: int | None = None
    #: #35 — how α scored a difference: `reliability_basis.ALPHA_METRIC_*`,
    #: mirrored in `lib/reliability-basis.ts`. Nominal here (presence/absence).
    alpha_metric: str | None = None


class IrrMagnitudeScale(BaseModel):
    """The declared instrument a rating row was scored on — `magnitude.read_scale`."""
    min: float
    max: float
    step: float
    anchors: list[dict] = []


class IrrMagnitudeResult(BaseModel):
    """Rating agreement for ONE code that declares a scale (#35).

    Never pooled into a headline: each code is its own instrument with its own
    range, so an α over "Joy 0–100" and "Anxiety −1…+1" together would average
    disagreement measured in different units.
    """
    code_id: int
    code_name: str
    scale: IrrMagnitudeScale
    #: Units two or more coders both applied AND rated — the α basis.
    n_units: int
    #: Applications of this code in scope, by roster coders (rated or not).
    n_applications: int
    #: …of which carry a rating. `n_rated / n_applications` is the coverage a
    #: coefficient over thin ratings would otherwise hide.
    n_rated: int
    #: Mean |a − b| over coder pairs on shared units, in the scale's own units.
    mean_abs_difference: float | None = None
    krippendorff_alpha: float | None = None
    alpha_interpretation: str | None = None
    #: #1505 (D43) — as `IrrCodeResult.verdict_withheld_reason`.
    verdict_withheld_reason: str | None = None
    #: `reliability_basis.ALPHA_METRIC_*` — interval, by the declaration.
    alpha_metric: str
    #: `insufficient_n` (fewer than two units rated by two coders — #1505 D42) ·
    #: `no_variance` (every compared rating identical) · None.
    undefined_reason: str | None = None
    alpha_ci: IrrInterval | None = None


class IrrSetMemberResult(BaseModel):
    """One VALUE of a code set, scored as the binary indicator it used to be.

    The breakdown inside a set's row, and the answer to *which value is
    destroying my α*: a set's single coefficient says the coders disagreed and
    not about what. These are the rows the per-code table no longer shows,
    reported here under the definition that makes them a part of the set rather
    than a rival account of the same coding.
    """
    code_id: int
    code_name: str
    n_units: int
    prevalence: float | None = None
    percent_agreement: float | None = None
    krippendorff_alpha: float | None = None
    alpha_interpretation: str | None = None
    #: #1505 (D43) — as `IrrCodeResult.verdict_withheld_reason`.
    verdict_withheld_reason: str | None = None
    undefined_reason: str | None = None


class IrrSetConfusion(BaseModel):
    """One coder PAIR's k×k confusion counts, in `axis` order both ways.

    ⚠️ Per pair, never pooled: with three coders a single confusion matrix is
    not defined, because one unit would have to contribute to several cells.
    """
    coder_a_id: int
    coder_b_id: int
    counts: list[list[int]]


class IrrSetResult(BaseModel):
    """Agreement on ONE code set — a k-valued nominal variable (row 48).

    🔴 **Never pooled into `overall_alpha`.** A binary presence/absence α and a
    k-valued nominal α are different instruments, so one coefficient over both
    averages disagreements measured on different scales — the same rule, and the
    same reason, as `IrrMagnitudeResult`.
    """
    set_id: int
    label: str
    exhaustive: bool
    #: 🔴 The TWELFTH stated-basis member — `code_sets.SET_BASIS_*`, mirrored in
    #: `lib/code-set-basis.ts`. The same coders on the same data produce
    #: DIFFERENT numbers under the two, and nothing in the figure says which.
    set_basis: str
    #: `reliability_basis.ALPHA_METRIC_*` — nominal, always: the values are
    #: category identifiers and a reserved sentinel, which no ordered metric can
    #: interpret.
    alpha_metric: str
    n_units: int
    #: How many values the variable has — the set's member count.
    n_values: int
    #: 🔴 Occasions where a coder held TWO members of this set on one unit. A
    #: CONTRADICTION, not a value: the cell is dropped and counted rather than
    #: resolved, because picking one (lowest id, most recent) fabricates a
    #: judgement nobody made. Reachable from legacy data, a merge, a set built
    #: over existing coding, or a direct API call.
    n_multiple_selection: int = 0
    #: The confusion matrix's axis: member code ids, then `code_sets.SET_NONE`
    #: (−1) when a blank is the value "none of these" rather than missing data.
    axis: list[int] = []
    #: Axis id (as a string key) → the words for it.
    value_names: dict[str, str] = {}
    percent_agreement: float | None = None
    cohens_kappa: float | None = None
    kappa_interpretation: str | None = None
    krippendorff_alpha: float | None = None
    alpha_interpretation: str | None = None
    #: #1505 (D43) — as `IrrCodeResult.verdict_withheld_reason`.
    verdict_withheld_reason: str | None = None
    #: `degenerate` (fewer than two values — a binary code wearing a costume) ·
    #: `insufficient_n` (fewer than two comparable units — #1505 D42) ·
    #: `no_variance` · None.
    undefined_reason: str | None = None
    kappa_ci: IrrInterval | None = None
    alpha_ci: IrrInterval | None = None
    members: list[IrrSetMemberResult] = []
    confusion: list[IrrSetConfusion] = []


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
    #: #1505 (D43) — the headline's band withheld: its units (passages, not
    #: passage × code rows) are fewer than `verdict_min_units`.
    overall_verdict_withheld_reason: str | None = None
    #: #43 — a CLUSTER bootstrap over units. The headline pools every code, so a
    #: unit contributes one row per code and those rows move together; treating
    #: them as independent would report an interval that is too narrow.
    overall_alpha_ci: IrrInterval | None = None
    interpretation_thresholds: dict = {}
    #: #1505 (D43) — `reliability_basis.VERDICT_MIN_UNITS`: below this many
    #: comparable units no row carries a band word. ``None`` on payloads from
    #: before 1.5.9 (every row carried one).
    verdict_min_units: int | None = None
    #: #35 — the stated basis: every α here is over CODERS
    #: (`reliability_basis.RELIABILITY_FACET_*`). ⚠️ Declared on the schema or
    #: the endpoint's `response_model` drops it silently — the half-landed-wire
    #: class `test_reliability_basis.py` pins.
    reliability_facet: str | None = None
    #: #1333 / #1334 — what one UNIT is (`reliability_basis.UNIT_BASIS_*`): whether
    #: a facilitator's turns count, with a group of turns counted once either way.
    #: The client says it beside "Units" and never infers it. ``None`` = a payload
    #: from before 1.5.9, which counted every turn of a group separately.
    unit_basis: str | None = None
    #: #1333 — facilitator turns in scope that the basis left out of the units
    #: (``None`` when it keeps them). Beside each code's `facilitator_turns_coded`.
    facilitator_turns_excluded: int | None = None
    #: D18 — the names of the speakers whose turns were left out as a facilitator's,
    #: sorted (``None`` when facilitator turns are units). The exclusion keys on a
    #: flag the import sets only for an "Interviewer"/"Facilitator" label, so the
    #: researcher must be able to see who it caught. Transcript speakers, not coders.
    facilitator_speakers: list[str] | None = None
    #: #35 — rating agreement per scaled code. Empty when no code declares a
    #: scale, or none was applied in scope.
    magnitude_per_code: list[IrrMagnitudeResult] = []
    #: Row 48 — the THIRD table: one α per code set, never pooled into the
    #: headline. Empty when the project declares no sets.
    set_agreement: list[IrrSetResult] = []


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
    #: #35 — the declared rating scale (`magnitude.read_scale`), or None. A cell's
    #: rating renders only against this; a bare number is not a rating.
    scale: dict | None = None


class ReconciliationUnit(BaseModel):
    """One coding unit (a segment, a segment GROUP or a dataset value) pivoted
    across coders.

    ``by_coder`` / ``consensus`` hold EFFECTIVE code ids (D3 equivalence-resolved);
    map them to names via the response's ``codes`` legend. ``by_coder`` and
    ``engaged`` are SOURCE-level (Option B — an engaged coder who left this unit
    blank appears with an empty list, a real disagreement). ``consensus`` is
    TARGET-level (the coders who coded THIS unit) so it matches the materialized
    layer. A unit can have a consensus AND ``has_disagreement`` (a dissenting
    minority/blank worth reviewing)."""
    #: "segment" | "group" | "dataset_value" — `reconciliation._UNIT_TYPE`'s values,
    #: mirrored by the client's union (held equal by `test_reconciliation_groups.py`;
    #: a plain `str` here, so an unknown kind would fail silently in the browser).
    unit_type: str
    #: The segment's, the GROUP's or the value's own id — for a group, never a turn.
    unit_id: int
    #: #1334 unit 3 (D35) — the turn the row's link and own-cell actions address:
    #: the segment itself, a group's FIRST visible turn (remove and rate find the
    #: coder's code on any member, D36; an apply fans out), None for a value.
    anchor_segment_id: int | None = None
    #: A group's visible turns in transcript order (its `text` is theirs, one per
    #: line); empty for any other unit.
    member_segment_ids: list[int] = []
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
    #: #35 — str(coder_id) → {str(code_id): rating}. Only RATED applications on a
    #: code with a scale, keyed by the canonical code id (the id the chips use).
    #: An unrated application is absent, never 0. Declared here or the
    #: `response_model` drops it silently.
    ratings_by_coder: dict[str, dict[str, float]] = {}
    #: #35 — str(coder_id) → {str(code_id): the rating a MERGED copy of that
    #: same application carried when it differed}. The target's rating was kept
    #: (`ratings_by_coder`); this is the other number. Cleared by re-rating.
    rating_conflicts_by_coder: dict[str, dict[str, float]] = {}
    engaged: list[int]  # source-engaged coder ids (reviewed the source)
    consensus: list[int]  # effective code ids in the derived consensus
    #: str(effective_code_id) → {rule, agree, voters[, magnitude: {rule, median,
    #: n_rated, spread, step, flag}]} — the `magnitude` key only when the code
    #: carries a rating consensus (#35).
    consensus_context: dict[str, dict]
    has_disagreement: bool
    #: #35 — a SECOND fact: two coders' ratings on some scaled code differ by more
    #: than one declared step. Codes can agree while ratings do not.
    has_rating_disagreement: bool = False
    #: #35 — a THIRD: some coder's own two copies disagreed at a merge and the
    #: coder has not re-rated since. In the review set until adjudicated.
    has_merge_conflict: bool = False
    #: Row 48 — str(set_id) → {str(coder_id): chosen member id, or
    #: `code_sets.SET_NONE` (−1) for "none of these", or None}. None means the
    #: coder has NOT decided: either missing data on an exhaustive set, or the
    #: contradictory state of holding two members at once.
    #: ⚠️ A set's cell renders a SINGLE-CHOICE control, not chips — chips say
    #: "these applied", a set says "this one was chosen from these", and the
    #: rejected alternatives are the content of the judgement being adjudicated.
    set_selection_by_coder: dict[str, dict[str, int | None]] = {}
    #: Row 48 — a FOURTH fact, never folded into the other three: the engaged
    #: coders chose different values of one set. *Needs review* and `j`/`k` mean
    #: ANY of the four; the badge says which.
    has_set_disagreement: bool = False
    #: #1334 unit 3 (D37) — str(coder_id) → {str(code_id): [the two or more
    #: ratings that coder gave the code on different turns of this GROUP],
    #: ascending}. Such a coder has NO rating on the group (D22), so the code is
    #: absent from their `ratings_by_coder` and from the median; this says why.
    group_rating_conflicts_by_coder: dict[str, dict[str, list[float]]] = {}
    #: …and a FIFTH review fact (groups only), never folded into the merge one:
    #: its words would name a merged copy, a false cause. Rating again settles it.
    has_group_rating_conflict: bool = False


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
    #: #43 — `reliability_intervals.CI_UNAVAILABLE_*`: why this coefficient
    #: carries no interval when the Reliability tab's κ and α do.
    ci_unavailable_reason: str | None = None


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


# ── Human-vs-machine agreement (queue row 49) ────────────────────────────────
#
# 🔴 A SEPARATE table, never pooled into the headline. These numbers describe a
# MODEL; they are not reliability and they are not validation of the coding.
# The copy that says so is single-sourced in `lib/machine-agreement-copy.ts`.


class MachineCodeAgreement(BaseModel):
    code_id: int
    code_name: str
    n_units: int
    #: 🔴 BOTH coverage counts ride every row, and they are the disclosure.
    #: `3` against `480` is a figure about a corpus one side barely touched, and
    #: no coefficient can say so on its own.
    human_applied: int
    machine_applied: int
    both_applied: int
    percent_agreement: float | None = None
    kappa: float | None = None
    kappa_interpretation: str | None = None
    #: The base rate, beside the coefficient — the prevalence paradox teaching
    #: the IRR table already carries (a rare code reads as a failure without it).
    prevalence: float | None = None
    #: `no_variance` / `insufficient_n` from `services/undefined_stats.py` — an
    #: undefined statistic is None WITH a reason, never 0.0 (#689).
    #: `insufficient_n` covers ONE comparable unit too (#1505, D42).
    undefined_reason: str | None = None
    #: #1505 (D43) — as `IrrCodeResult.verdict_withheld_reason`.
    verdict_withheld_reason: str | None = None


class MachinePairAgreementResponse(BaseModel):
    human_id: int
    human_name: str
    machine_id: int
    machine_name: str
    #: The configuration that produced these labels. Stated even when absent, so
    #: "we did not record it" is visible rather than indistinguishable from a
    #: table that never had the field.
    machine_provenance: dict | None = None
    n_units: int
    per_code: list[MachineCodeAgreement] = []


class MachineAgreementResponse(BaseModel):
    available: bool
    #: `no_machine_coder` / `no_human_coder` / `no_shared_source`. Distinct
    #: sentences, distinct remedies — a silence here reads as "still thinking".
    unavailable_reason: str | None = None
    pairs: list[MachinePairAgreementResponse] = []
    #: #1333 / #1334 — the unit basis this table shares with the human one
    #: (`IrrResponse.unit_basis`). Same vocabulary, same constant.
    unit_basis: str | None = None
    #: #1505 (D43) — as `IrrResponse.verdict_min_units`.
    verdict_min_units: int | None = None
