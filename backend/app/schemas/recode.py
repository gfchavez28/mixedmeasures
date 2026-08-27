"""Pydantic schemas for recode definitions."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, ConfigDict, Field, field_validator

VALID_RECODE_TYPES = {"scale_map", "category_group", "reverse"}
VALID_OUTPUT_TYPES = {"numeric", "categorical"}


# ═══════════════════════════════════════════════════════════════════════════════
# Request schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RecodeDefinitionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    recode_type: str
    output_type: str
    mapping: dict  # {"label": value, ...}
    exclude_values: list[str] | None = None
    source_definition_id: int | None = None

    @field_validator("recode_type")
    @classmethod
    def validate_recode_type(cls, v: str) -> str:
        if v not in VALID_RECODE_TYPES:
            raise ValueError(f"recode_type must be one of: {', '.join(sorted(VALID_RECODE_TYPES))}")
        return v

    @field_validator("output_type")
    @classmethod
    def validate_output_type(cls, v: str) -> str:
        if v not in VALID_OUTPUT_TYPES:
            raise ValueError(f"output_type must be one of: {', '.join(sorted(VALID_OUTPUT_TYPES))}")
        return v


class RecodeDefinitionUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    recode_type: str | None = None
    output_type: str | None = None

    @field_validator("recode_type")
    @classmethod
    def validate_recode_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_RECODE_TYPES:
            raise ValueError(f"recode_type must be one of: {', '.join(sorted(VALID_RECODE_TYPES))}")
        return v

    @field_validator("output_type")
    @classmethod
    def validate_output_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_OUTPUT_TYPES:
            raise ValueError(f"output_type must be one of: {', '.join(sorted(VALID_OUTPUT_TYPES))}")
        return v
    mapping: dict | None = None
    exclude_values: list[str] | None = None
    source_definition_id: int | None = None
    is_primary: bool | None = None


class CopyToRequest(BaseModel):
    target_column_ids: list[int]


class BulkTypeUpdateRequest(BaseModel):
    column_ids: list[int]
    column_type: str


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class RecodeDefinitionResponse(BaseModel):
    id: int
    column_id: int
    name: str
    recode_type: str
    output_type: str
    mapping: dict
    exclude_values: list[str] | None = None
    is_primary: bool
    is_auto_detected: bool
    source_definition_id: int | None = None
    sequence_order: int
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    unmapped_values: list[str] = []
    # #602: the authoritative reflection offset for this mapping on this column,
    # from `services/recode.py::definition_reflection_offset` — the SAME field
    # (and the same population rule) `/data`'s summary carries. The Recode
    # Workbench's reverse editor previews a draft copied from a `scale_map`
    # source, so this is populated for EVERY definition type, not only reverse:
    # the draft's number comes from its source's row. Without it the editor
    # re-derived a raw `min + max` and previewed "Never → 99" on a mapping the
    # save (correctly) scored 5 — the null set is invisible to the client, which
    # is the #578 display-vs-storage drift class.
    reverse_offset: float | None = None

    model_config = ConfigDict(from_attributes=True)


# ⚠️ The compact summary that rides `/data` is `schemas/dataset.py::RecodeDefinitionSummary`.
# A second class of that name lived HERE, imported by nothing, until 2026-08-16
# (#602) — a field added to it would have compiled, passed every test, and never
# reached the wire. Deleted rather than kept "for symmetry"; if a summary is ever
# needed in this module, import the live one.


class CopyToResponse(BaseModel):
    created: int
    skipped: int
    skipped_columns: list[int] = []


class ValueFrequency(BaseModel):
    value_text: str
    count: int
    is_na: bool


class ColumnFrequenciesResponse(BaseModel):
    column_id: int
    frequencies: list[ValueFrequency]
    total: int


# ═══════════════════════════════════════════════════════════════════════════════
# Value labels (#576/#577) — declare a code→label dictionary for a numbers-only column
# ═══════════════════════════════════════════════════════════════════════════════


VALUE_LABEL_TYPES = {"ordinal", "nominal"}


class ValueLabelPair(BaseModel):
    value: float          # the numeric code as it appears in the data (e.g. 1)
    label: str = Field(..., min_length=1, max_length=255)


class ApplyValueLabelsRequest(BaseModel):
    labels: list[ValueLabelPair] = Field(..., min_length=1)
    # Target column type: 'ordinal' (a scale) or 'nominal' (unordered categories);
    # None keeps the current type. Labels apply to both.
    column_type: str | None = None

    @field_validator("labels")
    @classmethod
    def _unique_codes_and_labels(cls, v: list[ValueLabelPair]) -> list[ValueLabelPair]:
        # #588: the ceiling is single-sourced with the three other write paths
        # that reach `scale_labels` (the import config and both manual-column
        # schemas) — a cap added to one schema leaves the others open, and the
        # import config is exactly the door that bypassed this endpoint.
        from ..services.value_labels import validate_value_label_count
        validate_value_label_count(v, field="value labels")
        codes = [p.value for p in v]
        if len(set(codes)) != len(codes):
            raise ValueError("Duplicate codes — each value may appear only once.")
        labels = [p.label.strip().lower() for p in v]
        if any(not lab for lab in labels):
            raise ValueError("Labels cannot be blank.")
        if len(set(labels)) != len(labels):
            raise ValueError("Duplicate labels — each label must be distinct.")
        return v

    @field_validator("column_type")
    @classmethod
    def _valid_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALUE_LABEL_TYPES:
            raise ValueError(f"column_type must be one of: {', '.join(sorted(VALUE_LABEL_TYPES))}")
        return v


class RecodeDependentInfo(BaseModel):
    """A definition affected by a change to something it depends on (#584).

    `reason` says WHICH relationship put it here, because the two are not
    interchangeable: `provenance` = it names the edited definition as its source
    and has DRIFTED from it (it still maps every cell); `unmapped` = the
    column was re-keyed under it and its mapping now matches NOTHING.
    """

    id: int
    name: str
    recode_type: str
    column_id: int
    is_primary: bool
    reason: str


class RederivePlanItem(BaseModel):
    """What re-deriving one dependent from its source would do (#584 step 2).

    `status` is `ready` / `no_change` / `blocked`. **`blocked` is not a soft
    warning** — a blocked dependent shares no mapping values with the source
    (the label-remapped crosswalk copy), so copying would write keys no cell
    carries and silently NULL the column on the next apply. The apply endpoint
    refuses the whole batch rather than skipping it.
    """

    definition_id: int
    name: str
    column_id: int
    is_primary: bool
    status: str
    changed_keys: list[str]
    detail: str


class RederiveRequest(BaseModel):
    """The confirm. IDs are re-checked against a freshly computed plan."""

    definition_ids: list[int]


class RederiveResponse(BaseModel):
    updated: list[int]
    skipped: list[int]
    changed_values: int


class RekeyRename(BaseModel):
    """One mapping key the re-key would rewrite, old → new."""

    old: str
    new: str


class RekeyPlanItem(BaseModel):
    """What re-keying one relabel-killed definition would do (#584's death arm).

    `status` is `ready` / `blocked` — there is no `no_change` arm, because the
    population is definitions that already match NOTHING. **`blocked` means the
    correspondence could not be recovered**, not that it is inadvisable:
    `unresolved_keys` names the keys with no code to translate through, so the
    researcher can fix that entry by hand and re-run.
    """

    definition_id: int
    name: str
    recode_type: str
    is_primary: bool
    status: str
    renames: list[RekeyRename]
    unresolved_keys: list[str]
    detail: str


class RekeyRequest(BaseModel):
    """The confirm. IDs are re-checked against a freshly computed plan."""

    definition_ids: list[int]


class RekeyResponse(BaseModel):
    updated: list[int]
    renamed_keys: int


class ApplyValueLabelsResponse(BaseModel):
    column_id: int
    updated: int
    unlabeled_codes: list[float] = []
    # #592 (C4): label pairs whose code/label the column DECLARES missing are
    # never applied (a missing code is not a scale point) — reported here.
    missing_skipped: list[float] = []
    # #584: substituting labels into `value_text` re-keys the column, so any
    # definition still keyed on the old cell text now maps nothing. Reported so
    # the researcher can decide — never silently re-derived.
    staled_definitions: list[RecodeDependentInfo] = []


class MissingValuesUpdate(BaseModel):
    """#592: set (rules list — `[]` = nothing missing) or clear (null = the
    recognized-N/A defaults) a column's missing declaration."""
    rules: list[dict] | None = None

    @field_validator("rules")
    @classmethod
    def _normalize_rules(cls, v: list[dict] | None) -> list[dict] | None:
        if v is None:
            return None
        # Single-sourced with the predicate module (#612/#614): shape rules,
        # degenerate-range normalization, exact-dup drop, same-value /
        # dup-label / label-equals-value refusals, and the rule cap — shared
        # with DatasetColumnConfig so the import config cannot accept a
        # payload this endpoint would refuse.
        from ..services.missing_values import normalize_missing_rules_payload
        return normalize_missing_rules_payload(v)


class MissingValuesResponse(BaseModel):
    column_id: int
    missing_values: list[dict] | None = None
    # Rules that matched NO value in this column (#823a). A declaration is
    # validated for shape and never for whether it hits anything, so a rule that
    # can never match is accepted with the same "Column updated." as one that
    # reclassified 30,000 cells. Server-side because the motivating case is
    # invisible on screen: HTML collapses interior whitespace, so a sentinel
    # stored with two spaces reads — and types — as one.
    unmatched_rules: list[str] = []
    nulled_rows: int
    # Cells whose value_text was substituted to a rule's label ("99" ->
    # "Refused"), the .sav shape — a subset of nulled_rows.
    labelled_rows: int = 0
    # Scale points removed from scale_labels/scale_values because the
    # declaration marks their code missing (C4: a missing code is never a
    # scale point, or frequency charts zero-fill a phantom bar for it).
    stripped_scale_points: int = 0
    recovered_rows: int
    recovered_values: list[str] = []
    # Recovered texts whose code the column's compute could not produce (e.g.
    # absent from a scale_map primary's mapping) — cells stay text-only, like
    # any unmapped value, for the researcher to map or label.
    recovered_unmapped: list[str] = []


class BulkMissingValuesUpdate(BaseModel):
    """#798: one missing-value vocabulary, applied to many columns at once.

    The #592 machinery assumes a column-at-a-time decision, and its flagship
    case genuinely is one (a `-99 THRU -1` range on a single continuous `age`).
    **A real survey is the opposite:** GSS marks missing with five sentinels
    — `.i: Inapplicable`, `.n: No answer`, `.d: Do not Know/Cannot Choose`,
    `.r: Refused`, `.s: Skipped on Web` — none of which MM's English-prefix
    defaults recognise, across all 41 columns. That is 138,806 cells in the
    first 8,000 rows alone, ~42% of them, each otherwise becoming a REAL
    category: a phantom group in every cross-tab, an extra bar in every
    frequency chart, and an inflated `real_group_count`, which per #506 can
    flip the auto-picked test.

    ⚠️ `rules` normalizes through the SAME validator as `MissingValuesUpdate`
    (#612/#614): a bulk path that validates more loosely than the single path is
    exactly the door those two issues came through. The DB-dependent guards
    (#606's label collisions, the scale-metadata pairing) cannot run here — they
    need the column — and stay inside `apply_missing_declaration`, per column.
    """
    column_ids: list[int]
    rules: list[dict] | None = None

    @field_validator("rules")
    @classmethod
    def _normalize_rules(cls, v: list[dict] | None) -> list[dict] | None:
        if v is None:
            return None
        from ..services.missing_values import normalize_missing_rules_payload
        return normalize_missing_rules_payload(v)


class BulkMissingValuesSkip(BaseModel):
    """A column the bulk apply did NOT touch, and why."""
    column_id: int
    column_label: str
    reason: str


class BulkMissingValuesResponse(BaseModel):
    """Per-column outcomes — deliberately NOT all-or-nothing.

    #606 refuses a rule whose label collides with text that means something else
    ON THAT COLUMN. That is a judgement about one column's own data, so one
    column's refusal must not discard the other forty: the researcher would be
    left with no way to apply a vocabulary that is correct nearly everywhere.
    Applied columns are committed; skipped ones are named with their reason.
    """
    applied: list[MissingValuesResponse]
    skipped: list[BulkMissingValuesSkip]
    nulled_rows_total: int = 0
    # Rules that matched nothing on EVERY applied column (#823a).
    # ⚠️ Deliberately the INTERSECTION, not the union: one vocabulary across 41
    # variables legitimately misses on most of them (GSS's ".n:  No answer"
    # occurs in some columns and not others), so a per-column report here would
    # be noise on a correct declaration. A rule that hit nothing ANYWHERE is the
    # one that is almost certainly mistyped.
    unmatched_everywhere: list[str] = []


# ═══════════════════════════════════════════════════════════════════════════════
# Decision B — derive a NEW variable from a rule (2026-08-24)
# ═══════════════════════════════════════════════════════════════════════════════


class DeriveLabelCarryPlan(BaseModel):
    """Whether the source's dictionary can come across, re-paired to new codes.

    ⚠️ `reason` is populated whenever `available` is False and the UI MUST render
    it. §8 of the design note blocked Decision B on "should a derived column
    inherit the source's value labels?", and the four unavailable states are not
    interchangeable — "there are no labels to carry" sends the researcher
    somewhere completely different from "this rule merges responses, so the
    merged categories need names you choose". A disabled checkbox with no reason
    is the shape that makes a researcher think the tool is broken.
    """
    available: bool
    reason: str | None = None
    pairs: list[tuple[float, str]] = []


class DerivePlanResponse(BaseModel):
    """What deriving WOULD do, computed read-only.

    Served by the same function the create endpoint uses (`plan_derived_column`),
    deliberately: a preview computed by different code from the operation is a
    preview that can be wrong, which is the class #795 landed in.
    """
    output_type: str
    column_type: str
    mapped: list[tuple[str, str]]
    unmapped_values: list[str]
    missing_values_carried: list[str]
    labels: DeriveLabelCarryPlan
    suggested_name: str


class DeriveColumnRequest(BaseModel):
    column_text: str = Field(..., min_length=1, max_length=255)
    carry_labels: bool = False


class DeriveColumnResponse(BaseModel):
    """The report a derive returns.

    `unmapped_values` and `missing_values_carried` ride the RESULT as well as the
    plan on purpose: the plan is what the researcher agreed to, and the result is
    what happened. #794's rule is that a partial match is disclosed rather than
    prevented, and a disclosure only in the pre-flight is one the researcher can
    click past without ever seeing the outcome.
    """
    created_column_id: int
    values_written: int
    unmapped_values: list[str]
    missing_values_carried: list[str]
    labels_carried: bool
