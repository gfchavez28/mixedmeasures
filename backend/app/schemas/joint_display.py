"""The joint display's compute request and its answer (`services/joint_display.py`)."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..schemas.code_analysis import CodeSegmentsWithContextResponse
from ..services.coding_layers import LAYER_SCOPE_PATTERN
from ..services.joint_display import IMPLICIT_CODES_KEY, IMPLICIT_VARIABLES_KEY
from ..services.joint_display_cases import MAX_CASE_PAGE, MAX_LISTED_CASES, MAX_RULE_CONDITIONS
from ..services.joint_display_pins import MAX_PIN_FACTS

#: Bounds on one request: a display is a researcher's table, not a dump. Both are far
#: above any display a person writes, and keep one request's work bounded.
MAX_DISPLAY_ROWS = 100
MAX_IDS_PER_STRAND = 50
#: Joint display slice 2 (r1-5): strands per display. Each codes strand is one participant
#: gather (the measured cost grows linearly with them), so the bound is the cost's, held
#: above any display a person lays out. R13: the builder's own, lower, cap is a DIFFERENT
#: constant with a different name (`MAX_STRANDS_IN_BUILDER`, 4) — this one bounds a request.
MAX_STRANDS_PER_REQUEST = 8
#: A strand's sources (conversations, documents, observations), per kind. #1644 (r3-1): NOT a
#: choice bound — a chosen list costs no more than "every one" (D12, 900 conversations: 900
#: chosen 5.2–5.5 s, 10,000 ids 5.4–5.8 s, every one 4.8–5.0 s; at 100–10,000 the plan seeks
#: each chosen conversation by key and never walks the project, `sql-id-sets.md` §6). It was
#: 500, which refused a 501st of D12's 900 while "every one" computed. What it bounds now is
#: SQL: one kind's list is bound one parameter per id in ONE statement beside the strand's codes
#: (≤ MAX_DISPLAY_ROWS × MAX_IDS_PER_STRAND = 5,000), under SQLite's compiled-in default of
#: 32,766 — so no build's own limit (250,000 in both measured, §1) decides. The builder has no
#: copy: a chosen list grows one tick at a time, and "every one" has no list.
MAX_SOURCES_PER_STRAND = 10_000

StrandKind = Literal["codes", "text_codes", "variables", "observation_codes"]

#: A row's binding to a strand the request does not carry — the compute and the case read
#: refuse it in the same words.
UNKNOWN_STRAND_BINDING = "a row binds a strand the display does not have"


def _strands_shape_error(strands, conversation_ids, document_ids) -> str | None:
    """What a request WITH strands may not also say — ONE list, read by the compute
    (`JointDisplayComputeRequest`) and the case read (`JointDisplayCasesRequest`) alike, so
    the case read never answers a request the compute refuses (it used to drop display-level
    sources beside strands without a word)."""
    keys = [s.key for s in strands]
    if len(set(keys)) != len(keys):
        return "two strands share a key"
    if conversation_ids is not None or document_ids is not None:
        return "with strands, each strand names its own sources"
    return None


class JointDisplayStrandRequest(BaseModel):
    """Slice 2 (r1-1): one strand, as stored minus its ``label``. Per kind, None = every
    source of that kind, a list = exactly those ([] = none) — #1297's rule."""

    key: str = Field(min_length=1, max_length=64)
    kind: StrandKind
    conversation_ids: list[int] | None = Field(None, max_length=MAX_SOURCES_PER_STRAND)
    document_ids: list[int] | None = Field(None, max_length=MAX_SOURCES_PER_STRAND)
    observation_ids: list[int] | None = Field(None, max_length=MAX_SOURCES_PER_STRAND)
    # text_codes (r4-1): the open-text columns; null or [] = NONE, never every column.
    text_column_ids: list[int] | None = Field(None, max_length=MAX_IDS_PER_STRAND)
    dataset_id: int | None = None


class JointDisplayBindingRequest(BaseModel):
    code_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)
    column_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)
    # D171, per strand — the researcher's own mark that this strand formed the groups.
    marked_formed: bool = False


class JointDisplayRowRequest(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    code_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)
    column_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)
    # D171 — the researcher's own mark that a strand formed the groups (a link the app
    # cannot see, e.g. teachers grouped by their school's student gains).
    codes_marked_formed: bool = False
    variables_marked_formed: bool = False
    # Slice 2: strand key → what the row binds from it (with ``strands`` on the request).
    bindings: dict[str, JointDisplayBindingRequest] | None = Field(None, max_length=MAX_STRANDS_PER_REQUEST)


class JointDisplayComputeRequest(BaseModel):
    group_by_column_id: int
    # The code strand's sources. Per kind: None = every source of that kind, a list =
    # exactly those ([] = none) — #1297's rule, the comparison's.
    conversation_ids: list[int] | None = None
    document_ids: list[int] | None = None
    # D175 — blind mode as the comparison does it: the coder scope and the layer.
    coder_ids: list[int] | None = None
    layer_scope: str | None = Field(None, pattern=LAYER_SCOPE_PATTERN)
    # D172 — the coded difference's Newcombe interval, off by default.
    newcombe: bool = False
    rows: list[JointDisplayRowRequest] = Field(default_factory=list, max_length=MAX_DISPLAY_ROWS)
    # Slice 2 (r1-1): the display's strands. None = slice 1's request — the display-level
    # sources and each row's ``code_ids`` / ``column_ids`` — read as the implicit pair.
    strands: list[JointDisplayStrandRequest] | None = Field(None, max_length=MAX_STRANDS_PER_REQUEST)

    @model_validator(mode="after")
    def _one_shape(self):
        if self.strands is None:
            if any(r.bindings is not None for r in self.rows):
                raise ValueError("a row's bindings need the display's strands")
            return self
        error = _strands_shape_error(self.strands, self.conversation_ids, self.document_ids)
        if error:
            raise ValueError(error)
        keys = [s.key for s in self.strands]
        for r in self.rows:
            if r.code_ids or r.column_ids or r.codes_marked_formed or r.variables_marked_formed:
                raise ValueError("with strands, a row binds through its bindings")
            unknown = set(r.bindings or {}) - set(keys)
            if unknown:
                raise ValueError(UNKNOWN_STRAND_BINDING)
        return self


class JointDisplayGroupBy(BaseModel):
    column_id: int
    name: str
    dataset_id: int
    dataset_name: str | None


class JointDisplayGroup(BaseModel):
    key: str
    participants: int
    # #1626 (D243): the code strand's denominator (participants with material in the
    # chosen sources) and how many of them have NO coding in scope. Both `None` when the
    # display has no code row — there is no code strand to describe.
    with_material: int | None
    without_coding: int | None


class JointDisplayScope(BaseModel):
    conversations: int
    documents: int
    unassigned_passages: int
    participants_without_group: int
    # #1626 (D244): whose coding "no coding" is about — `comparison_basis.NO_CODING_SCOPE_*`.
    no_coding_scope: str


class JointDisplayRatingBasis(BaseModel):
    basis: str
    score_basis: str
    scope: str
    excluded_ratings: dict[str, int]
    unavailable_reason: str | None


class JointDisplayRatingCell(BaseModel):
    mean: float | None
    n: int
    undefined_reason: str | None


class JointDisplayCodeCell(BaseModel):
    group: str
    count: int
    n: int
    share: float | None
    share_undefined_reason: str | None
    passages: int
    rating: JointDisplayRatingCell | None


class JointDisplayDifference(BaseModel):
    value: float | None
    ci_lower: float | None
    ci_upper: float | None
    ci_level: float | None
    ci_method: str | None
    unavailable_reason: str | None


class JointDisplayCodeStrand(BaseModel):
    code_id: int
    name: str
    unit: str
    rated: bool
    formed_groups: str | None
    cells: list[JointDisplayCodeCell]
    difference: JointDisplayDifference


class JointDisplayCategoryCount(BaseModel):
    label: str
    count: int
    share: float | None


class JointDisplayVariableCell(BaseModel):
    group: str
    n: int
    mean: float | None
    mean_undefined_reason: str | None
    sd: float | None
    sd_undefined_reason: str | None
    distribution: list[JointDisplayCategoryCount]


class JointDisplayEffect(BaseModel):
    d: float | None
    ci_lower: float | None
    ci_upper: float | None
    ci_level: float
    ci_method: str
    unavailable_reason: str | None


class JointDisplayVariableStrand(BaseModel):
    column_id: int
    name: str
    dataset_id: int
    unit: str
    formed_groups: str | None
    summary: str | None
    unavailable_reason: str | None
    categories: list[str]
    cells: list[JointDisplayVariableCell]
    effect: JointDisplayEffect | None


class JointDisplayStrandStatus(BaseModel):
    codes: str
    variables: str


class JointDisplayObservationCode(BaseModel):
    """Slice 2 (r1-4): one code on an observation strand — clips, beside the groups."""

    code_id: int
    name: str
    unit: str
    # r1-4 (L2): in the strand's OWN unit — sessions, then time, then clips where agreed.
    observations: int
    of_observations: int
    seconds: float
    observed_seconds: float | None
    time_share: float | None
    time_share_undefined_reason: str | None
    clips: int | None
    of_clips: int | None
    clips_undefined_reason: str | None
    rating_unavailable_reason: str | None


class JointDisplayRowStrand(BaseModel):
    """Slice 2: what one row draws from one strand — only its kind's list is filled."""

    kind: str
    status: str
    codes: list[JointDisplayCodeStrand]
    variables: list[JointDisplayVariableStrand]
    observation_codes: list[JointDisplayObservationCode]
    missing_code_ids: list[int]
    missing_column_ids: list[int]
    #: #1665 (D336) — bound variables of another dataset than the strand reads (D205): left
    #: out and said as such, never counted in `missing_column_ids` ("no longer in this project").
    other_dataset_column_ids: list[int] = []
    #: #1659 — why `status` is "not_measured" (`STRAND_NOT_MEASURED_*`); None when it covers.
    not_measured_reason: str | None = None


class JointDisplayInactiveCode(BaseModel):
    """#1639 follow-up (r1-8): a bound code that is inactive in the codebook — out of the
    numbers, as in every analysis view — and the code a merge moved its coding into, when
    the audit trail names one still in the project."""

    strand_key: str
    code_id: int
    name: str
    merged_into_id: int | None
    merged_into_name: str | None


class JointDisplayRow(BaseModel):
    key: str
    # Slice 1's fields: every per-group strand's results of the kind, in display order
    # (exactly slice 1's for an implicit pair; r1-3 — dropped once `by_strand` is read).
    codes: list[JointDisplayCodeStrand]
    variables: list[JointDisplayVariableStrand]
    missing_code_ids: list[int]
    missing_column_ids: list[int]
    other_dataset_column_ids: list[int] = []  # #1665 (D336): every strand's, as the two above
    inactive_codes: list[JointDisplayInactiveCode] = []
    strands: JointDisplayStrandStatus
    by_strand: dict[str, JointDisplayRowStrand]


class JointDisplayStrandObservations(BaseModel):
    chosen: int
    with_coding: int
    agreed: int
    observed_seconds: float | None
    segmentation: str | None


class JointDisplayStrandGroup(BaseModel):
    key: str
    with_material: int | None
    without_coding: int | None
    # text_codes only (r4-1): the group's people with a survey record — "answered (surveyed)".
    surveyed: int | None


class JointDisplayStrandResult(BaseModel):
    """Slice 2: one strand's display-level facts — a codes strand's denominators and scope
    (its OWN sources), an observation strand's clips and their provenance (D18)."""

    key: str
    kind: str
    unit: str
    dataset_id: int | None
    groups: list[JointDisplayStrandGroup] | None
    scope: JointDisplayScope | None
    observations: JointDisplayStrandObservations | None


class JointDisplayComputeResponse(BaseModel):
    unit: str
    group_by: JointDisplayGroupBy
    # Slice 1's: the FIRST codes strand's denominators (r1-3).
    groups: list[JointDisplayGroup]
    unavailable_reason: str | None
    scope: JointDisplayScope
    rating: JointDisplayRatingBasis | None
    strands: list[JointDisplayStrandResult]
    rows: list[JointDisplayRow]


# ── The pins (session B, `services/joint_display_pins.py`) ────────────────────────────


class JointDisplayPassagesRequest(BaseModel):
    """D209 — one group's passages coded with one code: the pin picker's suggestions.

    The display's own grouping, sources and coder scope, so a suggestion is one of the
    passages its numbers count. Answered with the Content tab's passage shape
    (`CodeSegmentsWithContextResponse`).
    """

    group_by_column_id: int
    group: str = Field(min_length=1, max_length=500)
    code_id: int
    conversation_ids: list[int] | None = None
    document_ids: list[int] | None = None
    # Joint display slice 2 (r4-1, R9): the open-text columns of the PIN'S STRAND — a
    # `text_codes` strand's questions, the SAME list its count reads
    # (`code_strand_answer_columns`). ``[]`` = none, never every.
    text_column_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)
    coder_ids: list[int] | None = None
    layer_scope: str | None = Field(None, pattern=LAYER_SCOPE_PATTERN)
    # D102 — sent ONLY while blind mode withholds: each passage's chips follow `coder_ids`.
    chips_follow_coder_ids: bool = False
    limit: int = Field(50, ge=1, le=200)
    offset: int = Field(0, ge=0)


class JointDisplayAnswerPassage(BaseModel):
    """Joint display slice 2 (r4-1/r4-2): one coded open-text ANSWER a pin may quote — WHOLE.

    A quote of an answer is always the whole answer (`excerpt_text_from` ignores offsets on
    a dataset value; the canvas scrub matches it by EQUALITY, #1473), so there is no span.
    No chips: the picker shows none, so none is read (and none can leak a colleague, #964).
    """

    dataset_value_id: int
    text: str
    column_id: int
    #: "Dataset › Column" — `models/excerpt.py::answer_source_name`, the quote's own name.
    source_name: str
    participant_id: int
    participant_name: str | None
    is_quoted: bool


class JointDisplayPassagesResponse(CodeSegmentsWithContextResponse):
    """D209's answer, plus (slice 2, r4-1) the group's coded answers in the strand's columns.

    `total_segments` counts the answers too (`answer_total`), as `CodeSegmentsWithContext
    Response`'s own comment says a passage can be an answer; the Content tab's shape is
    untouched (this is a subclass, and only the display reads it).
    """

    answer_total: int = 0
    answers: list[JointDisplayAnswerPassage] = []
    # #1704 (b) (D384): each listed passage's WHOLE quote id (segment id / dataset value id →
    # excerpt id), so the picker can say "pinned here" (a pin IS that quote) apart from
    # "already a quote". A passage with no whole quote is absent.
    segment_quote_ids: dict[int, int] = {}
    answer_quote_ids: dict[int, int] = {}


class JointDisplayPinFactsRequest(BaseModel):
    """D210 — the live facts each pin's attribution is derived from (D163.4: never stored)."""

    excerpt_ids: list[int] = Field(default_factory=list, max_length=MAX_PIN_FACTS)
    # An optional participant-linked categorical column (e.g. School).
    column_id: int | None = None
    # #1615 (C2) — the viewer's id, sent ONLY while blind mode withholds (the display's
    # scope, D175). A rating-derived column's value is then left out of every pin.
    coder_ids: list[int] | None = None


class JointDisplayPinFact(BaseModel):
    excerpt_id: int
    participant_id: int | None
    participant_identifier: str | None
    speaker_label: str | None
    source_name: str
    # Joint display slice 2 (R8, r4-4): `joint_display_pins.PIN_SOURCE_*` — "answer" makes the
    # attribution say "Survey answer (…)". None only for a quote of no known source.
    source_kind: str | None = None
    column_value: str | None


class JointDisplayPinFactsResponse(BaseModel):
    pins: list[JointDisplayPinFact]
    # #1615: the attribution column comes from participant scores and the scope is blind,
    # so every pin's `column_value` is null — said, never read as "no value".
    column_withheld: bool = False
    # #1615 D286: that column's name, when `column_withheld` — the display's note names it
    # ("{column} is left out of the quotes' attribution while blind: …"), and no other read the
    # display makes names a column. #1653 (D346): also when `column_unusable` is "ineligible".
    column_name: str | None = None
    # #1653 (D346): why the attribution column could not be read — "gone" (not in this project)
    # or "ineligible" (it can no longer form groups) — so every pin keeps who said it and where
    # (`column_value` null) and the display says why. Null when it was read, absent or withheld.
    column_unusable: Literal["gone", "ineligible"] | None = None


# ── The case-ordered view (joint display slice 2, D173; `services/joint_display_cases.py`) ──
#
# C3 of the slice-2 review. `strands` is the compute's own strand (R10: r1's model): absent,
# the row reads as slice 1's implicit pair — a code strand "codes" over the display-level
# sources and a variable strand "variables" (`services/joint_display.py::IMPLICIT_*_KEY`).


class JointDisplayCaseBinding(BaseModel):
    code_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)
    column_ids: list[int] = Field(default_factory=list, max_length=MAX_IDS_PER_STRAND)


class JointDisplayCondition(BaseModel):
    """C4's Condition. Every member optional here: the service decides a malformed one
    (`condition_invalid`) so a stored rule an older or hand-edited file carries reads as
    "not evaluated", never as a 422 that blanks the view."""

    kind: str = Field(max_length=16)
    group: str | None = Field(None, max_length=500)
    column_id: int | None = None
    op: str | None = Field(None, max_length=16)
    value: str | float | None = None
    strand_key: str | None = Field(None, max_length=64)
    code_id: int | None = None
    present: bool | None = None


class JointDisplayRule(BaseModel):
    conditions: list[JointDisplayCondition] = Field(default_factory=list,
                                                    max_length=MAX_RULE_CONDITIONS)


class JointDisplayCasesRequest(BaseModel):
    group_by_column_id: int
    conversation_ids: list[int] | None = None
    document_ids: list[int] | None = None
    strands: list[JointDisplayStrandRequest] | None = Field(None, max_length=MAX_STRANDS_PER_REQUEST)
    coder_ids: list[int] | None = None
    layer_scope: str | None = Field(None, pattern=LAYER_SCOPE_PATTERN)
    row_key: str = Field(min_length=1, max_length=64)
    bindings: dict[str, JointDisplayCaseBinding] = Field(default_factory=dict,
                                                         max_length=MAX_STRANDS_PER_REQUEST)
    rule: JointDisplayRule | None = None
    # Which cases to list: all of them, or the misfit list (r3-12: the rule's, less the
    # removed, plus the added).
    only: Literal["all", "list"] = "all"
    added_participant_ids: list[int] = Field(default_factory=list, max_length=MAX_LISTED_CASES)
    removed_participant_ids: list[int] = Field(default_factory=list, max_length=MAX_LISTED_CASES)
    offset: int = Field(0, ge=0)
    # Joint display slice 2, round 2 (r5-7): 0 = the count alone (the open construct's line,
    # the Report view and the export's note), with no person's facts in the answer.
    limit: int = Field(50, ge=0, le=MAX_CASE_PAGE)

    @model_validator(mode="after")
    def _one_shape(self):
        """The compute's refusals, in its words (`_strands_shape_error`): the case read
        ignored display-level sources beside strands and a binding to a strand it does not
        carry, so it could answer for a display the compute refuses to draw. Without strands
        it reads slice 1's implicit pair, whose two keys are the only ones a row can bind."""
        if self.strands is None:
            keys = {IMPLICIT_CODES_KEY, IMPLICIT_VARIABLES_KEY}
        else:
            error = _strands_shape_error(self.strands, self.conversation_ids, self.document_ids)
            if error:
                raise ValueError(error)
            keys = {s.key for s in self.strands}
        if set(self.bindings) - keys:
            raise ValueError(UNKNOWN_STRAND_BINDING)
        return self


class JointDisplayCaseCodeFact(BaseModel):
    code_id: int
    passages: int
    # None = no material in this strand's sources: "used it?" has no answer.
    used: bool | None


class JointDisplayCaseValue(BaseModel):
    column_id: int
    value: float | None
    label: str | None
    # CASE_VALUE_MISSING · CASE_NO_ROW · VARIABLE_NOT_SUMMARISABLE · VARIABLE_RATING_WITHHELD
    reason: str | None


class JointDisplayCaseFacts(BaseModel):
    has_material: bool | None
    coded: bool | None
    codes: list[JointDisplayCaseCodeFact]
    values: list[JointDisplayCaseValue]


class JointDisplayCase(BaseModel):
    participant_id: int
    # r3-7: the participant's identifier, never their display name.
    label: str
    group: str
    facts: dict[str, JointDisplayCaseFacts]
    matches: bool | None
    # r3-12: MISFIT_LISTED_BY_RULE · MISFIT_LISTED_BY_ADDED · None (not on the list).
    listed_by: str | None
    removed: bool


class JointDisplayCaseCode(BaseModel):
    code_id: int
    name: str


class JointDisplayCaseVariable(BaseModel):
    column_id: int
    name: str
    dataset_id: int
    withheld: bool
    operators: list[str]


class JointDisplayNamedCase(BaseModel):
    participant_id: int
    label: str
    # None: the participant is no longer in the display's groups.
    group: str | None


class JointDisplayCasesResponse(BaseModel):
    groups: list[str]
    total: int
    listed: int
    matched: int | None
    unknown: int | None
    rule_unavailable_reason: str | None
    rule_withheld_columns: list[str]
    # #1671 (D351): with `group_missing`, the groups a condition names that the display lacks now.
    rule_missing_groups: list[str] = []
    list_size: int
    added_outside: int
    codes: list[JointDisplayCaseCode]
    # #1664 (D332): the row's bound codes the codebook made inactive — out of `codes` and every
    # case fact, named here (the compute's shape) so the view says which and where coding went.
    inactive_codes: list[JointDisplayInactiveCode] = []
    variables: list[JointDisplayCaseVariable]
    cases: list[JointDisplayCase]
    # r5-6: the added and removed cases' identifiers and groups (never a rule-selected one's).
    named_cases: list[JointDisplayNamedCase]
    unavailable_reason: str | None
