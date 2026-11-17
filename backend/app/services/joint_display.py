"""The joint display's numbers — each construct's strands side by side, per group.

ROADMAP row 56, STRATEGY question 5 (*what do the qualitative and quantitative strands say
to each other*). The display is a canvas node (`joint_display_node.py`, D162); this module
computes what it DRAWS, live, from the bindings the node carries. The decisions are
D165–D172 of the internal design notes
(git-ignored); what each one asks of this code:

- **The groups (D166)** are the values of ONE categorical, participant-linked column, named
  by id — `code_analysis.grouping_column` and `_build_participant_group_map(column_id=)`,
  the code-by-group comparison's own path, so the two cannot disagree about who is in which
  group. A group's SIZE is its participants with a (non-missing) value.
- **The unit is DERIVED, never typed (D165):** the per-group strands this module computes count
  PARTICIPANTS — a code strand through the speakers and documents linked to them, a survey
  strand through `DatasetRow.participant_id`, a survey comments strand (`text_codes`, D305)
  through its answers' rows. An observation strand (D304) counts in its OWN unit —
  observations and coded time, never participants — and stands beside the groups. A saved
  result at another unit is drawn by its own renderer, beside the row, never split by these
  groups.
- **The code strand (D168.1)** is the comparison's unit and rule exactly — the share of a
  group's participants WITH material in the chosen conversations and documents who used the
  code, interviewer turns out by role — read through `code_analysis.gather_participant_codes`,
  the comparison's own steps 1–2 (`test_joint_display.py` holds the two equal). Open-text
  answers count only where the display NAMES their questions (slice 2, r4-1 —
  `code_strand_answer_columns`; none named = none, so a slice-1 display keeps its n).
- **The survey strand (D167)** joins through the identity spine: each linked participant's
  value from their ONE row of the column's dataset (`uq_dataset_rows_dataset_participant`),
  so the survey and the grouping variable may sit in DIFFERENT datasets — the case the
  row-grouped comparison cannot do (#827). Missing through the column's rules, a category
  named by `answer_label_resolver`, categories ordered by `order_value_labels`.
- **Rated codes (D168.2)** read the LIVE rollup (`compute_magnitude_rollup`), never the
  participant table's snapshot, with the SAME ``coder_ids`` as the counts (D197): a cell is
  the mean of the group's participant scores. ⚠️ A participant's score is over every rated
  passage of theirs in the project — the rollup is a property of the person, not of the
  source selection — and the wire says so (`rating.scope`). The rollup is NARROWED to the
  display's rated codes (D168 (a), `code_ids=`): their scores are exactly the whole
  rollup's, read from their own passages only — and so `rating.excluded_ratings` counts
  the left-out ratings of THESE codes, not of every code in the project.
- **Descriptive only (D172):** no test, no p. A code strand's difference in shares carries
  Newcombe's interval only when asked (``newcombe``), labelled unadjusted; a survey strand's
  d carries Hedges & Olkin's interval (`CI_METHOD_HEDGES_OLKIN_D`). Both only between TWO
  groups. **A strand that formed the groups (D171)** — the grouping variable itself, one
  derived from it or it from the strand (computed or recoded, followed both ways), or one
  the researcher marked — gets no between-group statistic at all: its difference holds by
  construction. Its per-group descriptives stay, and the row says why the rest is absent.
- **An undefined number is None with a reason** (`undefined_stats`), and so is an omitted
  one (`EFFECT_*` below). Every cell states its own n.

The endpoint is plain `def` (`routers/joint_display.py`; `test_endpoint_event_loop.py::
MUST_BE_SYNC`): the gather alone is the comparison's.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from statistics import fmean, stdev

from sqlalchemy.orm import Session

from ..models.audit import AuditEntry
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.dataset import (
    CATEGORICAL_GROUPING_TYPES,
    SCALE_SCORE_ELIGIBLE_TYPES,
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from ..models.observation import Observation
from ..models.segment import Segment
from ..routers.helpers import visible_segment_filter
from . import comparison_basis as cmp_basis
from . import undefined_stats as _undefined  # #1615 — imported as a module: the D207 census reads names
from .code_analysis import (
    _build_participant_group_map,
    _coder_filter,
    gather_participant_codes,
    grouping_column,
)
from .coding_layers import LAYER_MACHINE, build_effective_code_map
from .comparisons import CI_METHOD_HEDGES_OLKIN_D, _cohens_d_ci
from .grouping import order_value_labels
from .magnitude import has_scale
from .magnitude_rollup import MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS, compute_magnitude_rollup
from .missing_values import column_missing_rules, is_missing
from .participant_scores import withheld_rating_columns_in_project
from .statistical_tests import pooled_cohens_d
from .testable_groups import MIN_VALUES_PER_GROUP_PARAMETRIC
from .undefined_stats import (
    EMPTY_GROUP,
    INSUFFICIENT_N,
    NO_GROUP_VALUES,
    NO_SEGMENTS,
    NO_VARIANCE,
    finite_or_none,
)
from .value_labels import answer_label_resolver

# ── The display's own stated vocabulary (its client mirror is session B's) ──────────

#: Every strand this module computes counts participants (D165).
UNIT_PARTICIPANTS = "participants"

#: How a survey strand is summarised: a numeric or ordinal variable by its mean (the
#: types a mean is meaningful over — `SCALE_SCORE_ELIGIBLE_TYPES`), a categorical one by
#: its distribution (`CATEGORICAL_GROUPING_TYPES`), anything else not at all.
SUMMARY_MEAN = "mean"
SUMMARY_DISTRIBUTION = "distribution"
#: The variable's type has no summary here (open text, an identifier, a multi-select).
VARIABLE_NOT_SUMMARISABLE = "not_summarisable"
#: #1615: the variable comes from participant scores and the display reads under a blind
#: scope that leaves out a coder whose ratings the snapshot holds — left out, said. The
#: SAME value as `undefined_stats.RATING_WITHHELD_BLIND` (one spelling across surfaces).
VARIABLE_RATING_WITHHELD = _undefined.RATING_WITHHELD_BLIND

#: Why a between-group number (a difference, a d) is not given — beside the
#: `undefined_stats` reasons, which say why a number given cannot be computed.
#: D172: a difference or an effect is stated between TWO groups.
EFFECT_NOT_TWO_GROUPS = "not_two_groups"
#: D171/D172: the strand formed the groups, so its difference holds by construction.
EFFECT_FORMED_GROUPS = "formed_groups"

#: How a strand came to have formed the groups (D171).
FORMED_BY_GROUPING_VARIABLE = "grouping_variable"
FORMED_BY_DERIVATION = "derived"
FORMED_BY_MARK = "marked"

#: A rated cell: the mean of the group's participant scores, each score itself
#: `MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS` (D168.2).
RATING_CELL_BASIS_MEAN_OF_PARTICIPANT_SCORES = "mean_of_participant_scores"
#: Where a participant's score comes from — every rated passage of theirs.
RATING_SCOPE_PROJECT = "every_rated_passage_in_the_project"
#: No participant in the group has a score on this code.
RATING_NO_SCORES = "no_scores"
#: The rollup is people's ratings (consensus where two or more rated); a machine
#: coder's layer has no score to put beside its counts.
RATING_NOT_ON_MACHINE_LAYER = "machine_layer"
#: #1639 (r1-5) — the compute's 404 for a grouping variable not in this project, as a stable
#: code the display renders as its own sentence (`lib/joint-display-vocabulary.ts`).
GROUPING_GONE = "grouping_gone"

#: Strand status the APP derives (D169): a row that draws nothing from a strand.
STRAND_COVERS = "covers"
STRAND_NOT_MEASURED = "not_measured"
#: #1659 — WHY a strand is not measured on a row, decided here (#823c: the client never
#: guesses). The view printed "no code bound" for every case, above a line naming the bound
#: code that was deleted or merged away. `_not_measured_reason` picks one.
STRAND_NOT_MEASURED_NOTHING_BOUND = "nothing_bound"
#: A survey comments strand none of whose questions is an open-text column of this project
#: (deleted, retyped, or unresolved on import) — it reads nothing (R12), whatever it binds.
STRAND_NOT_MEASURED_NO_QUESTIONS = "no_questions"
STRAND_NOT_MEASURED_BOUND_GONE = "bound_gone"
#: Every bound code inactive in the codebook (a Merge deactivates its source, D325).
STRAND_NOT_MEASURED_BOUND_INACTIVE = "bound_inactive"
#: Every bound variable is in this project but in another dataset than the strand reads (D205)
#: — the builder keeps a row's variables when a strand's dataset is changed.
STRAND_NOT_MEASURED_BOUND_OTHER_DATASET = "bound_other_dataset"
#: More than one of the three above at once: the lines under the row say which is which.
STRAND_NOT_MEASURED_BOUND_UNAVAILABLE = "bound_unavailable"

#: Joint display slice 2 (r1-1): a strand's KIND — what it counts and where it stands. The
#: placement is DERIVED from the kind, never stored: codes and variables count participants
#: and are split by the groups; observation codes count clips, which name no participant by
#: design, so that strand stands BESIDE the groups (D165), like a result at another unit.
STRAND_KIND_CODES = "codes"
STRAND_KIND_VARIABLES = "variables"
STRAND_KIND_OBSERVATION_CODES = "observation_codes"
#: r4-1 after L3: open-text answers are their OWN codes strand, with their own denominator (the
#: people who answered), never pooled into an interview strand's material.
STRAND_KIND_TEXT_CODES = "text_codes"
#: The kinds split by the groups.
PER_GROUP_KINDS = frozenset({STRAND_KIND_CODES, STRAND_KIND_TEXT_CODES, STRAND_KIND_VARIABLES})
#: The kinds whose rows bind codes counted per participant.
PARTICIPANT_CODE_KINDS = frozenset({STRAND_KIND_CODES, STRAND_KIND_TEXT_CODES})

#: r1-4 (after the literature, L2): an observation strand is reported in its OWN unit, never
#: folded into a participant denominator — the OBSERVATIONS (sessions) with a clip coded with
#: the code, of the chosen observations; the coded TIME (a union of intervals) as a share of
#: the observed time; and a clip count only where the clips were agreed (`_clips_countable`).
UNIT_OBSERVATIONS = "observations"
#: r1-4: how an observation strand's clips were cut (D18's unit provenance) — every
#: observation's clips agreed by the team (frozen), every one open (each coder cut their
#: own), or some of each. Clips are counted in the agreed ones only.
STRAND_SEGMENTATION_AGREED = "agreed"
STRAND_SEGMENTATION_OPEN = "open"
STRAND_SEGMENTATION_MIXED = "mixed"
#: r1-4: a rating on a clip has no participant to belong to (the rollup is per person), so
#: an observation strand draws no rating — said, never a blank.
RATING_NOT_ON_CLIPS = "clips_name_no_participant"
#: r1-4: a chosen observation has no recorded duration, so no share of observed time is given.
STRAND_DURATION_UNKNOWN = "duration_unknown"
#: r1-4 (L2): no chosen observation's clips were agreed, so no clip count is given — while
#: coders cut their own clips, one stretch cut in two doubles a count and leaves time unchanged.
STRAND_CLIPS_OPEN_CUTS = "clips_open_cuts"


def _clips_countable(segmentation_frozen_at) -> bool:
    """r1-4's ONE switch (L2: Sandelowski 2009, Krippendorff 1995): a clip is a countable unit
    only when the team agreed the clips (D18, frozen). Return True to count open cuts too."""
    return segmentation_frozen_at is not None


def _union_seconds(intervals: list[tuple[float, float]]) -> float:
    """The length of a union of intervals — overlapping clips (one coder's, or two coders'
    of one moment) are counted once, never summed."""
    total, end = 0.0, None
    start = None
    for a, b in sorted(intervals):
        if end is None or a > end:
            if end is not None:
                total += end - start
            start, end = a, b
        else:
            end = max(end, b)
    if end is not None:
        total += end - start
    return total

#: The strands of a display with no ``strands`` key — slice 1's implicit pair (r1-2).
IMPLICIT_CODES_KEY = "codes"
IMPLICIT_VARIABLES_KEY = "variables"


# ── A code strand's open-text answers (joint display slice 2, r4-1) ───────────────────

def code_strand_answer_columns(
    db: Session, project_id: int, text_column_ids: list[int] | None,
) -> tuple[list[int], list[int]]:
    """Joint display slice 2 (r4-1): the open-text columns a CODE strand counts as material.

    Returns ``(columns, missing)`` — the asked ids that are open-text columns of this
    project, and those that are not (deleted, another project's, another type), so a row
    can say a source went missing rather than silently counting less.

    🔴 **No list and an empty list are both NONE** — the opposite of the gather's own
    ``None`` (= every open-text column, #1297's rule for a SOURCE KIND). A display that
    never named an answer column (every slice-1 display) must keep its n; an answer column
    is a survey QUESTION, chosen by name, never "all of them" (a new import would otherwise
    join every strand that said nothing). So this function is the one door from a display's
    stored list to `gather_participant_codes(text_column_ids=…)` and to the pin
    suggestions (`joint_display_pins.group_passages`) — the counts and the suggestions read
    the SAME columns (D209: a suggestion is one of the passages its numbers count).
    """
    asked = [i for i in (text_column_ids or [])
             if isinstance(i, int) and not isinstance(i, bool)]
    if not asked:
        return [], []
    found = {cid for (cid,) in db.query(DatasetColumn.id)
             .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
             .filter(Dataset.project_id == project_id,
                     DatasetColumn.column_type == ColumnType.OPEN_TEXT,
                     DatasetColumn.id.in_(sorted(set(asked))))}
    return sorted(found), [i for i in asked if i not in found]


@dataclass(frozen=True)
class AnswerStrandGather:
    """What a SEPARATE open-text strand (`text_codes`, r4-1 as revised after L3) is made of."""

    columns: list[int]
    missing_columns: list[int]
    #: Participants with a SUBSTANTIVE answer in the columns — the strand's own denominator.
    answered: set[int]
    #: Participants with a RECORD in the columns' datasets (#830d: records, not cells) — the
    #: survey's n beside it, so who answered can be weighed (O'Cathain & Thomas 2004).
    surveyed: set[int]
    #: (participant | None, code, answers carrying it), under the coder scope.
    person_codes: list
    coded_people: set[int]


def answer_strand_gather(
    db: Session, project_id: int, *, text_column_ids: list[int] | None,
    code_ids: list[int], coder_ids: list[int] | None, layer_scope: str | None,
) -> AnswerStrandGather:
    """Joint display slice 2 (r4-1, revised after the literature's L3): open-text answers as
    their OWN code strand, never pooled into an interview strand's material.

    The comparison's gather with ONLY the answer arm (``conversation_ids=[]``,
    ``document_ids=[]``), so the strand's n is the people who answered these questions —
    substantive answers only (#519) — and an interviewee with no answer is not in it. r1's
    compute calls this once per ``text_codes`` strand and draws, per group, *count of
    answered* with *answered of surveyed* beside it.
    """
    columns, missing = code_strand_answer_columns(db, project_id, text_column_ids)
    if not columns:
        return AnswerStrandGather([], missing, set(), set(), [], set())
    gathered = gather_participant_codes(
        db, project_id, conversation_ids=[], document_ids=[], text_column_ids=columns,
        exclude_facilitator=True, participant_ids=None, code_ids=code_ids,
        coder_ids=coder_ids, layer_scope=layer_scope)
    surveyed = {pid for (pid,) in db.query(DatasetRow.participant_id)
                .join(DatasetColumn, DatasetColumn.dataset_id == DatasetRow.dataset_id)
                .filter(DatasetColumn.id.in_(columns), DatasetRow.participant_id.isnot(None))
                .distinct()}
    return AnswerStrandGather(columns, missing, set(gathered.person_passages), surveyed,
                              list(gathered.person_codes), set(gathered.coded_people))


@dataclass(frozen=True)
class StrandRequest:
    """One strand of the display (joint display slice 2, r1-1). Sources per kind: ``None`` =
    every source of that kind, a tuple = exactly those (``()`` = none, #1297)."""
    key: str
    kind: str
    conversation_ids: tuple[int, ...] | None = None
    document_ids: tuple[int, ...] | None = None
    observation_ids: tuple[int, ...] | None = None
    #: text_codes (r4-1): the open-text columns — None or () = NONE, never every column.
    text_column_ids: tuple[int, ...] | None = None
    #: D205 — a variables strand reads ONE dataset; None = any (slice 1's implicit strand).
    dataset_id: int | None = None


@dataclass(frozen=True)
class BindingRequest:
    code_ids: tuple[int, ...] = ()
    column_ids: tuple[int, ...] = ()
    marked_formed: bool = False


@dataclass(frozen=True)
class RowRequest:
    key: str
    code_ids: tuple[int, ...] = ()
    column_ids: tuple[int, ...] = ()
    codes_marked_formed: bool = False
    variables_marked_formed: bool = False
    #: Slice 2: strand key → what the row binds from it. None = slice 1's fields above,
    #: read as the implicit pair (`implicit_strands`).
    bindings: dict[str, BindingRequest] | None = None


def implicit_strands(conversation_ids: list[int] | None, document_ids: list[int] | None,
                     rows: list[RowRequest]) -> tuple[list[StrandRequest], list[RowRequest]]:
    """Slice 1's request as slice 2's (r1-2): ONE codes strand over the display's sources and
    ONE variables strand over any dataset, each row's ids and marks bound to them."""
    strands = [
        StrandRequest(IMPLICIT_CODES_KEY, STRAND_KIND_CODES,
                      conversation_ids=None if conversation_ids is None else tuple(conversation_ids),
                      document_ids=None if document_ids is None else tuple(document_ids)),
        StrandRequest(IMPLICIT_VARIABLES_KEY, STRAND_KIND_VARIABLES),
    ]
    out = [RowRequest(key=r.key, bindings={
        IMPLICIT_CODES_KEY: BindingRequest(code_ids=r.code_ids, marked_formed=r.codes_marked_formed),
        IMPLICIT_VARIABLES_KEY: BindingRequest(column_ids=r.column_ids,
                                               marked_formed=r.variables_marked_formed),
    }) for r in rows]
    return strands, out


def _round(value, digits: int = 4):
    return finite_or_none(value, digits)


def _parse_id_list(raw) -> list[int]:
    if not raw:
        return []
    try:
        ids = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    return [i for i in ids if isinstance(i, int) and not isinstance(i, bool)] if isinstance(ids, list) else []


def related_by_derivation(db: Session, project_id: int, column_id: int) -> set[int]:
    """Every column derived FROM ``column_id`` or that it was derived FROM, transitively.

    D171's "derived": a computed column through `depends_on_column_ids`, a recoded one
    through `derived_from_column_id` — followed both ways, never sideways (two columns
    derived from one source are not derived from each other).
    """
    parents: dict[int, set[int]] = defaultdict(set)
    children: dict[int, set[int]] = defaultdict(set)
    rows = (
        db.query(DatasetColumn.id, DatasetColumn.derived_from_column_id,
                 DatasetColumn.depends_on_column_ids)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(Dataset.project_id == project_id)
    )
    for cid, derived_from, depends_on in rows:
        sources = set(_parse_id_list(depends_on))
        if derived_from is not None:
            sources.add(derived_from)
        for src in sources:
            parents[cid].add(src)
            children[src].add(cid)

    def _walk(start: int, edges: dict[int, set[int]]) -> set[int]:
        seen: set[int] = set()
        todo = [start]
        while todo:
            for nxt in edges.get(todo.pop(), ()):
                if nxt not in seen and nxt != start:
                    seen.add(nxt)
                    todo.append(nxt)
        return seen

    return _walk(column_id, children) | _walk(column_id, parents)


def _between(values_by_group: dict[str, list[float]], groups: list[str]) -> dict:
    """Cohen's d of the first group against the second, with its interval — or why not."""
    if len(groups) != 2:
        return {"d": None, "ci_lower": None, "ci_upper": None, "ci_level": 0.95,
                "ci_method": CI_METHOD_HEDGES_OLKIN_D, "unavailable_reason": EFFECT_NOT_TWO_GROUPS}
    g1, g2 = groups
    a, b = values_by_group[g1], values_by_group[g2]
    if min(len(a), len(b)) < MIN_VALUES_PER_GROUP_PARAMETRIC:
        reason = INSUFFICIENT_N
        d = None
    else:
        d = pooled_cohens_d(fmean(a), stdev(a), len(a), fmean(b), stdev(b), len(b))
        reason = None if d is not None else NO_VARIANCE
    if d is None:
        return {"d": None, "ci_lower": None, "ci_upper": None, "ci_level": 0.95,
                "ci_method": CI_METHOD_HEDGES_OLKIN_D, "unavailable_reason": reason}
    lo, hi = _cohens_d_ci(d, len(a), len(b))
    return {"d": _round(d), "ci_lower": _round(lo), "ci_upper": _round(hi), "ci_level": 0.95,
            "ci_method": CI_METHOD_HEDGES_OLKIN_D, "unavailable_reason": None}


def _omitted_effect(reason: str) -> dict:
    return {"d": None, "ci_lower": None, "ci_upper": None, "ci_level": 0.95,
            "ci_method": CI_METHOD_HEDGES_OLKIN_D, "unavailable_reason": reason}


def _variable_strand(db: Session, column: DatasetColumn, groups: list[str],
                     part_group: dict[int, str], formed_by: str | None,
                     *, withheld: bool) -> dict:
    """One survey variable's cells per group (D167).

    #1615: ``withheld`` — a score, or a variable worked out from one, under a blind scope —
    gives no cells: a group's mean of every-coder scores reads a colleague's rating back
    out (one person's group: 2 × 3.5 − 2). The row's RATED codes are the blind coder's
    way to her own ratings (D168.2, scoped live).
    """
    name = column.column_name or column.column_text
    base = {"column_id": column.id, "name": name, "dataset_id": column.dataset_id,
            "unit": UNIT_PARTICIPANTS, "formed_groups": formed_by}
    if withheld:
        return {**base, "summary": None, "unavailable_reason": VARIABLE_RATING_WITHHELD,
                "categories": [], "cells": [], "effect": None}
    if column.column_type in SCALE_SCORE_ELIGIBLE_TYPES:
        kind = SUMMARY_MEAN
    elif column.column_type in CATEGORICAL_GROUPING_TYPES:
        kind = SUMMARY_DISTRIBUTION
    else:
        return {**base, "summary": None, "unavailable_reason": VARIABLE_NOT_SUMMARISABLE,
                "categories": [], "cells": [], "effect": None}

    rules = column_missing_rules(column)
    as_label = answer_label_resolver(column)
    numbers: dict[str, list[float]] = {g: [] for g in groups}
    labels: dict[str, list[str]] = {g: [] for g in groups}
    cells_q = (
        db.query(DatasetValue.value_text, DatasetValue.value_numeric, DatasetRow.participant_id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .filter(DatasetValue.column_id == column.id,
                DatasetRow.dataset_id == column.dataset_id,
                DatasetRow.participant_id != None)
    )
    for value_text, value_numeric, participant_id in cells_q:
        g = part_group.get(participant_id)
        if g is None:
            continue  # no group — never a member of a cell
        if value_text is None or not value_text.strip() or is_missing(value_text, rules):
            continue
        if kind == SUMMARY_MEAN:
            number = finite_or_none(value_numeric)
            if number is not None:
                numbers[g].append(number)
        else:
            labels[g].append(as_label(value_text).strip())

    if kind == SUMMARY_MEAN:
        cells = []
        for g in groups:
            vals = numbers[g]
            n = len(vals)
            sd = stdev(vals) if n >= MIN_VALUES_PER_GROUP_PARAMETRIC else None
            cells.append({
                "group": g, "n": n,
                "mean": _round(fmean(vals)) if n else None,
                "mean_undefined_reason": None if n else EMPTY_GROUP,
                "sd": _round(sd),
                "sd_undefined_reason": None if sd is not None else (INSUFFICIENT_N if n else EMPTY_GROUP),
                "distribution": [],
            })
        effect = _omitted_effect(EFFECT_FORMED_GROUPS) if formed_by else _between(numbers, groups)
        return {**base, "summary": kind, "unavailable_reason": None, "categories": [],
                "cells": cells, "effect": effect}

    categories = order_value_labels({label for g in groups for label in labels[g]})
    cells = []
    for g in groups:
        counts = defaultdict(int)
        for label in labels[g]:
            counts[label] += 1
        n = len(labels[g])
        cells.append({
            "group": g, "n": n, "mean": None, "mean_undefined_reason": None,
            "sd": None, "sd_undefined_reason": None,
            "distribution": [
                {"label": c, "count": counts[c],
                 "share": round(counts[c] / n, 4) if n else None}
                for c in categories
            ],
        })
    return {**base, "summary": kind, "unavailable_reason": None, "categories": categories,
            "cells": cells, "effect": None}


def _observation_gather(db: Session, project_id: int, observation_ids: tuple[int, ...] | None,
                        code_ids: list[int], coder_ids: list[int] | None,
                        layer_scope: str | None) -> dict:
    """An observation strand's measures (joint display slice 2, r1-4) — never people (L2).

    Per code: the observations with a visible clip carrying it, of the chosen; the seconds those
    clips cover (a union per observation, so overlaps count once) against the chosen
    observations' recorded duration; and the clips carrying it of the clips carrying any
    non-universal coding (J-A's "coded") — in AGREED observations only (`_clips_countable`).
    Every count is under the SAME coder + layer scope (`_coder_filter`), so a blind coder's
    numbers are over what SHE coded: a base over every clip would tell her how far her
    colleagues have cut and coded (#964; `Segment` records no cutter). Scoped through the
    parent (`visible_segment_filter(from_parent=True)`, #1463).
    """
    obs_q = db.query(Observation.id, Observation.segmentation_frozen_at,
                     Observation.media_duration_seconds).filter(Observation.project_id == project_id)
    if observation_ids is not None:
        obs_q = obs_q.filter(Observation.id.in_(list(observation_ids)))  # bounded by the schema
    observations = obs_q.all()
    agreed = {oid for oid, at, _d in observations if _clips_countable(at)}
    frozen = sum(1 for _oid, at, _d in observations if at is not None)
    segmentation = (None if not observations else STRAND_SEGMENTATION_AGREED
                    if frozen == len(observations) else STRAND_SEGMENTATION_OPEN
                    if frozen == 0 else STRAND_SEGMENTATION_MIXED)
    known = [d for _oid, _at, d in observations if d is not None and d > 0]
    observed = sum(known) if observations and len(known) == len(observations) else None
    out = {"chosen": len(observations), "with_coding": 0, "agreed": len(agreed),
           "observed_seconds": observed, "segmentation": segmentation,
           "coded_clips_agreed": 0, "per_code": {}}
    if not observations:
        return out
    chosen = [oid for oid, _at, _d in observations]

    def _clips(q):
        q = (q.select_from(CodeApplication)
              .join(Segment, CodeApplication.segment_id == Segment.id)
              .join(Observation, Segment.observation_id == Observation.id)
              .filter(Observation.project_id == project_id,
                      Segment.observation_id.in_(chosen),
                      *visible_segment_filter(from_parent=True)))
        return _coder_filter(q, coder_ids, layer_scope)

    universal = [cid for (cid,) in db.query(Code.id).filter(
        Code.project_id == project_id, Code.is_universal == True)]  # noqa: E712
    coded = _clips(db.query(Segment.observation_id, CodeApplication.segment_id)).distinct()
    if universal:
        coded = coded.filter(CodeApplication.code_id.notin_(universal))
    coded = coded.all()
    out["with_coding"] = len({oid for oid, _sid in coded})
    out["coded_clips_agreed"] = len({sid for oid, sid in coded if oid in agreed})
    if not code_ids:
        return out
    marks = _clips(db.query(CodeApplication.code_id, Segment.observation_id, Segment.id,
                            Segment.start_time, Segment.end_time)).distinct()
    marks = marks.filter(CodeApplication.code_id.in_(code_ids))
    per: dict[int, dict] = {cid: {"obs": set(), "spans": defaultdict(list), "clips": set()}
                            for cid in code_ids}
    for cid, oid, sid, start, end in marks:
        p = per[cid]
        p["obs"].add(oid)
        if start is not None and end is not None and end > start:
            p["spans"][oid].append((start, end))
        if oid in agreed:
            p["clips"].add(sid)
    out["per_code"] = {
        cid: {"observations": len(p["obs"]),
              "seconds": round(sum(_union_seconds(v) for v in p["spans"].values()), 3),
              "clips": len(p["clips"])}
        for cid, p in per.items()}
    return out


class _CodeStrandState:
    """One codes strand's gather, folded per group — slice 1's code strand, per strand."""

    def __init__(self, groups: list[str], coder_ids, layer_scope):
        self.bound = False
        self.group_people: dict[str, set[int]] = {g: set() for g in groups}
        self.code_people: dict[str, dict[int, set[int]]] = {g: defaultdict(set) for g in groups}
        self.code_passages: dict[str, dict[int, int]] = {g: defaultdict(int) for g in groups}
        self.coded_people: set[int] = set()
        #: text_codes only: per group, the people with a survey record (r4-1's "surveyed").
        self.surveyed: dict[str, int] | None = None
        #: text_codes only: the open-text columns the strand reads — none means the strand
        #: measures nothing (R12), never "covers" over 0 of 0.
        self.answer_columns: list[int] | None = None
        self.scope = {"conversations": 0, "documents": 0, "unassigned_passages": 0,
                      "participants_without_group": 0,
                      # #1626 (D244): whose coding `groups[i].without_coding` is about.
                      "no_coding_scope": cmp_basis.no_coding_scope(coder_ids, layer_scope)}

    def groups_out(self, groups: list[str]) -> list[dict]:
        return [{"key": g,
                 "with_material": len(self.group_people[g]) if self.bound else None,
                 "without_coding": (len(self.group_people[g] - self.coded_people)
                                    if self.bound else None),
                 "surveyed": self.surveyed.get(g, 0) if self.surveyed is not None else None}
                for g in groups]


def _not_measured_reason(*, bound, reads_nothing: bool, gone: list[int], inactive: list[int],
                         other_dataset: list[int]) -> str:
    """#1659 — why a strand draws nothing on a row (its status is `STRAND_NOT_MEASURED`).

    Nothing bound first; then a survey comments strand with no question to read (it draws
    nothing whatever it binds, R12); then what became of the bound items — one cause, or
    `BOUND_UNAVAILABLE` when they differ (the row's own lines name each: the missing count and
    `inactive_codes`). Called only when nothing was drawn, so every bound item is in one of
    the three lists."""
    if not bound:
        return STRAND_NOT_MEASURED_NOTHING_BOUND
    if reads_nothing:
        return STRAND_NOT_MEASURED_NO_QUESTIONS
    causes = [reason for reason, ids in ((STRAND_NOT_MEASURED_BOUND_GONE, gone),
                                         (STRAND_NOT_MEASURED_BOUND_INACTIVE, inactive),
                                         (STRAND_NOT_MEASURED_BOUND_OTHER_DATASET, other_dataset))
              if ids]
    return causes[0] if len(causes) == 1 else STRAND_NOT_MEASURED_BOUND_UNAVAILABLE


def merged_into(db: Session, project_id: int, code_ids) -> dict[int, Code]:
    """The code each of ``code_ids`` was last MERGED into, where the audit trail says so and
    that code is still this project's (#1639 follow-up, r1-8).

    The codebook's merge leaves the source inactive with its codings moved
    (`routers/codes.py::merge_codes`); nothing on the code row says where they went — the
    merge's audit entry does (``details.source_code_id`` under ``entity_id`` = the target).
    A code with no such entry (deactivated by hand, or an audit trail that did not travel
    with an import) is absent, and the display says only that it is inactive.
    """
    wanted = set(code_ids)
    if not wanted:
        return {}
    target_of: dict[int, int] = {}
    for entity_id, details in (
        db.query(AuditEntry.entity_id, AuditEntry.details)
        .filter(AuditEntry.project_id == project_id, AuditEntry.action == "merged",
                AuditEntry.entity_type == "code")
        .order_by(AuditEntry.id)
    ):
        try:
            source = json.loads(details or "{}").get("source_code_id")
        except (TypeError, ValueError, AttributeError):
            continue
        if source in wanted and isinstance(entity_id, int):
            target_of[source] = entity_id  # the LAST merge of it wins (ordered by id)
    targets = {c.id: c for c in db.query(Code).filter(
        Code.project_id == project_id, Code.id.in_(set(target_of.values())))} if target_of else {}
    return {s: targets.get(t) for s, t in target_of.items()}  # None: the target is gone


def compute_joint_display(
    db: Session,
    project_id: int,
    *,
    group_by_column_id: int,
    rows: list[RowRequest],
    conversation_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None,
    layer_scope: str | None,
    newcombe: bool,
    strands: list[StrandRequest] | None = None,
) -> dict:
    """Every row's strands per group — see the module docstring for the rules.

    Joint display slice 2 (r1-1): ``strands`` names the display's strands — several codes
    strands, each over ITS OWN sources (one gather each); several variables strands, each
    over its own dataset (D205); observation strands beside the groups. ``None`` = slice 1's
    request (``conversation_ids`` / ``document_ids`` + each row's ``code_ids`` /
    ``column_ids``), read as the implicit pair (`implicit_strands`, r1-2) — so a slice 1
    display computes exactly as before.

    Raises `code_analysis.GroupingColumnError` for a grouping variable outside the
    project (404) or of a type that cannot form groups (400). Ids a row names that are not
    this project's are returned as missing, never an error: a display may outlive what it
    bound (a deleted code), and it says so rather than failing whole.
    """
    if strands is None:
        strands, rows = implicit_strands(conversation_ids, document_ids, rows)
    by_key = {s.key: s for s in strands}

    def _binding(r: RowRequest, key: str) -> BindingRequest:
        return (r.bindings or {}).get(key) or BindingRequest()

    # #1615: the display sends `coder_ids` ONLY while blind mode withholds (D175 — it has no
    # coder filter), so its coder scope IS the blind scope. The grouping gate is asked ONCE,
    # here, before anything is read: it refuses a rating-derived grouping column (409). The
    # group map below re-validates the column it is handed (`grouping_column` again) with no
    # scope, because this ask has already answered the rating question — asking it twice made
    # either ask unobservable (the review's mutant M9 survived), so only this one is load-bearing.
    grouping = grouping_column(db, project_id, group_by_column_id, blind_scope=coder_ids)
    part_group = _build_participant_group_map(db, project_id, column_id=grouping.id,
                                              blind_scope=None)
    withheld_columns = withheld_rating_columns_in_project(db, project_id, coder_ids)
    groups = order_value_labels(set(part_group.values()))
    group_size: dict[str, int] = defaultdict(int)
    for g in part_group.values():
        group_size[g] += 1
    dataset = db.get(Dataset, grouping.dataset_id)

    # ── What the rows name, resolved against THIS project ────────────────────────
    def _bound_ids(kinds, attr: str) -> list[int]:
        return sorted({cid for r in rows for k, b in (r.bindings or {}).items()
                       if k in by_key and by_key[k].kind in kinds for cid in getattr(b, attr)})

    wanted_codes = _bound_ids({*PARTICIPANT_CODE_KINDS, STRAND_KIND_OBSERVATION_CODES}, "code_ids")
    codes = {
        c.id: c for c in db.query(Code).filter(
            Code.project_id == project_id, Code.id.in_(wanted_codes))
    } if wanted_codes else {}
    # #1639 follow-up (r1-8): an INACTIVE code leaves the analysis, as it does from the
    # comparison, the frequencies and the canvas charts (`Code.is_active == True` there) —
    # and the display SAYS so (`inactive_codes`), where those surfaces drop it silently. The
    # codebook's merge makes its source inactive with every coding moved to the target, so
    # drawing it showed 0 in every group, with nothing said.
    inactive = {cid: c for cid, c in codes.items() if not c.is_active}
    codes = {cid: c for cid, c in codes.items() if c.is_active}
    into = merged_into(db, project_id, inactive)
    wanted_columns = _bound_ids({STRAND_KIND_VARIABLES}, "column_ids")
    columns = {
        c.id: c for c in db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(Dataset.project_id == project_id, DatasetColumn.id.in_(wanted_columns))
    } if wanted_columns else {}
    derived = related_by_derivation(db, project_id, grouping.id) if columns else set()

    # ── Each codes strand: the comparison's gather, once per strand, over ITS sources ─
    code_states: dict[str, _CodeStrandState] = {}
    for s in strands:
        if s.kind != STRAND_KIND_CODES:
            continue
        state = code_states[s.key] = _CodeStrandState(groups, coder_ids, layer_scope)
        strand_codes = sorted({cid for r in rows for cid in _binding(r, s.key).code_ids
                               if cid in codes})
        if not strand_codes:
            continue
        state.bound = True
        gathered = gather_participant_codes(
            db, project_id,
            conversation_ids=None if s.conversation_ids is None else list(s.conversation_ids),
            document_ids=None if s.document_ids is None else list(s.document_ids),
            text_column_ids=[],  # D165: answers are not a code strand source (r4's C5 decides)
            exclude_facilitator=True,  # interviewer turns out by role, as the comparison
            participant_ids=None, code_ids=strand_codes,
            coder_ids=coder_ids, layer_scope=layer_scope,
        )
        for pid in gathered.person_passages:
            g = part_group.get(pid)
            if g is None:
                state.scope["participants_without_group"] += 1
            else:
                state.group_people[g].add(pid)
        for pid, cid, n in gathered.person_codes:
            g = part_group.get(pid) if pid is not None else None
            if g is not None:
                state.code_people[g][cid].add(pid)
                state.code_passages[g][cid] += n
        state.coded_people = gathered.coded_people  # #1626 (D243), the comparison's own rule
        state.scope.update(conversations=len(gathered.sources["conv"]),
                           documents=len(gathered.sources["doc"]),
                           unassigned_passages=gathered.unassigned)

    # ── Each text_codes strand: r4's answer gather, once per strand, over ITS columns ─
    for s in strands:
        if s.kind != STRAND_KIND_TEXT_CODES:
            continue
        state = code_states[s.key] = _CodeStrandState(groups, coder_ids, layer_scope)
        strand_codes = sorted({cid for r in rows for cid in _binding(r, s.key).code_ids
                               if cid in codes})
        ans = answer_strand_gather(db, project_id, text_column_ids=list(s.text_column_ids or ()),
                                   code_ids=strand_codes, coder_ids=coder_ids,
                                   layer_scope=layer_scope)
        state.surveyed = defaultdict(int)
        state.answer_columns = ans.columns
        for pid in ans.surveyed:
            g = part_group.get(pid)
            if g is not None:
                state.surveyed[g] += 1
        # R12: a strand reading no question binds nothing it could count — its row status is
        # derived "not measured" below, and its denominators stay None (no strand to describe).
        if not strand_codes or not ans.columns:
            continue
        state.bound = True
        for pid in ans.answered:
            g = part_group.get(pid)
            if g is None:
                state.scope["participants_without_group"] += 1
            else:
                state.group_people[g].add(pid)
        for pid, cid, n in ans.person_codes:
            g = part_group.get(pid) if pid is not None else None
            if g is not None:
                state.code_people[g][cid].add(pid)
                state.code_passages[g][cid] += n
        state.coded_people = ans.coded_people

    # ── Each observation strand: clips, beside the groups (r1-4) ─────────────────
    obs_states: dict[str, dict] = {}
    for s in strands:
        if s.kind == STRAND_KIND_OBSERVATION_CODES:
            strand_codes = sorted({cid for r in rows for cid in _binding(r, s.key).code_ids
                                   if cid in codes})
            obs_states[s.key] = _observation_gather(db, project_id, s.observation_ids,
                                                    strand_codes, coder_ids, layer_scope)

    # ── Rated codes: the live rollup, under the same coder scope (D168.2, D197) ───
    # ONE rollup for every codes strand: a score is the PERSON's, over every rated passage
    # of theirs in the project (D204), whatever a strand's sources — so a second code strand
    # costs a gather, never a second rollup.
    rated = {cid for cid in _bound_ids(PARTICIPANT_CODE_KINDS, "code_ids")
             if cid in codes and has_scale(codes[cid])}
    scores: dict[tuple[int, int], float] = {}
    rating_block = None
    effective: dict[int, int] = {}
    if rated:
        if layer_scope == LAYER_MACHINE:
            rating_block = {"basis": RATING_CELL_BASIS_MEAN_OF_PARTICIPANT_SCORES,
                            "score_basis": MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
                            "scope": RATING_SCOPE_PROJECT, "excluded_ratings": {},
                            "unavailable_reason": RATING_NOT_ON_MACHINE_LAYER}
        else:
            effective = build_effective_code_map(db, project_id)
            # D168 (a): the rollup narrowed to this display's rated codes — their scores
            # exactly, at the cost of their passages rather than the project's codings.
            rollup = compute_magnitude_rollup(db, project_id, coder_ids=coder_ids,
                                              code_ids=sorted(rated))
            scores = {(s.participant_id, s.code_id): s.mean for s in rollup.scores}
            rating_block = {"basis": RATING_CELL_BASIS_MEAN_OF_PARTICIPANT_SCORES,
                            "score_basis": MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
                            "scope": RATING_SCOPE_PROJECT,
                            "excluded_ratings": dict(rollup.excluded_ratings),
                            "unavailable_reason": None}
    members: dict[str, list[int]] = defaultdict(list)
    for pid, g in part_group.items():
        members[g].append(pid)

    def _rating(cid: int, g: str) -> dict | None:
        if cid not in rated:
            return None
        if rating_block is None or rating_block["unavailable_reason"]:
            return {"mean": None, "n": 0, "undefined_reason": RATING_NOT_ON_MACHINE_LAYER}
        eff = effective.get(cid, cid)
        vals = [scores[(pid, eff)] for pid in members[g] if (pid, eff) in scores]
        return {"mean": _round(fmean(vals)) if vals else None, "n": len(vals),
                "undefined_reason": None if vals else RATING_NO_SCORES}

    def _code_strand(state: _CodeStrandState, cid: int, formed_by: str | None) -> dict:
        code = codes[cid]
        cells = []
        for g in groups:
            n = len(state.group_people[g])
            count = len(state.code_people[g].get(cid, ()))
            cells.append({
                "group": g, "count": count, "n": n,
                "share": round(count / n, 4) if n > 0 else None,
                "share_undefined_reason": None if n > 0 else NO_SEGMENTS,
                "passages": state.code_passages[g].get(cid, 0),
                "rating": _rating(cid, g),
            })
        difference = {"value": None, "ci_lower": None, "ci_upper": None, "ci_level": None,
                      "ci_method": None, "unavailable_reason": None}
        if formed_by:
            difference["unavailable_reason"] = EFFECT_FORMED_GROUPS
        elif len(groups) != 2:
            difference["unavailable_reason"] = EFFECT_NOT_TWO_GROUPS
        else:
            (c1, c2) = cells
            if c1["share"] is None or c2["share"] is None:
                difference["unavailable_reason"] = NO_SEGMENTS
            else:
                difference["value"] = round(c1["share"] - c2["share"], 4)
                if newcombe:
                    ci = cmp_basis.delta_interval(c1["count"], c1["n"], c2["count"], c2["n"])
                    difference.update(ci_lower=ci["lower"], ci_upper=ci["upper"],
                                      ci_level=ci["level"], ci_method=ci["method"])
        return {"code_id": cid, "name": code.name, "unit": UNIT_PARTICIPANTS,
                "rated": cid in rated, "formed_groups": formed_by,
                "cells": cells, "difference": difference}

    def _observation_code(state: dict, cid: int) -> dict:
        got = state["per_code"].get(cid, {"observations": 0, "seconds": 0.0, "clips": 0})
        observed = state["observed_seconds"]
        countable = state["agreed"] > 0
        return {"code_id": cid, "name": codes[cid].name, "unit": UNIT_OBSERVATIONS,
                "observations": got["observations"], "of_observations": state["chosen"],
                "seconds": got["seconds"], "observed_seconds": observed,
                "time_share": round(got["seconds"] / observed, 4) if observed else None,
                "time_share_undefined_reason": None if observed else STRAND_DURATION_UNKNOWN,
                "clips": got["clips"] if countable else None,
                "of_clips": state["coded_clips_agreed"] if countable else None,
                "clips_undefined_reason": None if countable else STRAND_CLIPS_OPEN_CUTS,
                # r1-4: a rating belongs to a participant; a clip names none.
                "rating_unavailable_reason": RATING_NOT_ON_CLIPS if has_scale(codes[cid]) else None}

    def _variable_formed(cid: int, b: BindingRequest) -> str | None:
        if cid == grouping.id:
            return FORMED_BY_GROUPING_VARIABLE
        if cid in derived:
            return FORMED_BY_DERIVATION
        return FORMED_BY_MARK if b.marked_formed else None

    out_rows = []
    for r in rows:
        by_strand: dict[str, dict] = {}
        row_inactive: list[dict] = []
        for s in strands:
            b = _binding(r, s.key)
            # #1665 (D336): a variable of another dataset than the strand reads is in the project,
            # so it is never counted with the gone ones — it rides `other_dataset_column_ids`.
            other_dataset: list[int] = []
            entry = {"kind": s.kind, "codes": [], "variables": [], "observation_codes": [],
                     "missing_code_ids": [], "missing_column_ids": [],
                     "other_dataset_column_ids": other_dataset}
            reads_nothing = False
            if s.kind in PARTICIPANT_CODE_KINDS:
                formed = FORMED_BY_MARK if b.marked_formed else None
                reads_nothing = (s.kind == STRAND_KIND_TEXT_CODES
                                 and not code_states[s.key].answer_columns)
                # R12: a text_codes strand with no question draws no cell (0 of 0 is not
                # evidence), so the row's status for it is derived "not measured".
                entry["codes"] = [] if reads_nothing else [
                    _code_strand(code_states[s.key], cid, formed)
                    for cid in b.code_ids if cid in codes]
                entry["missing_code_ids"] = [cid for cid in b.code_ids
                                             if cid not in codes and cid not in inactive]
            elif s.kind == STRAND_KIND_OBSERVATION_CODES:
                entry["observation_codes"] = [_observation_code(obs_states[s.key], cid)
                                              for cid in b.code_ids if cid in codes]
                entry["missing_code_ids"] = [cid for cid in b.code_ids
                                             if cid not in codes and cid not in inactive]
            else:
                for cid in b.column_ids:
                    column = columns.get(cid)
                    # D205: a variables strand reads ONE dataset — a column of another is
                    # not this strand's, and is left out rather than drawn under it; it is
                    # still in the project, so it is never "missing" (#1665, D336).
                    if column is None:
                        entry["missing_column_ids"].append(cid)
                        continue
                    if s.dataset_id is not None and column.dataset_id != s.dataset_id:
                        other_dataset.append(cid)
                        continue
                    entry["variables"].append(_variable_strand(
                        db, column, groups, part_group, _variable_formed(cid, b),
                        withheld=cid in withheld_columns))
            # D325: below the kinds' if/elif/else, never between them — there Python read the
            # `else` as this loop's `for … else`, and every strand ran the variables branch.
            for cid in b.code_ids:
                if cid in inactive and s.kind in (*PARTICIPANT_CODE_KINDS,
                                                  STRAND_KIND_OBSERVATION_CODES):
                    target = into.get(cid)  # None: no merge named, or its target is gone
                    row_inactive.append({
                        "strand_key": s.key, "code_id": cid, "name": inactive[cid].name,
                        "merged_into_id": target.id if target else None,
                        "merged_into_name": target.name if target else None})
            measured = entry["codes"] or entry["variables"] or entry["observation_codes"]
            entry["status"] = STRAND_COVERS if measured else STRAND_NOT_MEASURED
            entry["not_measured_reason"] = None if measured else _not_measured_reason(
                bound=b.column_ids if s.kind == STRAND_KIND_VARIABLES else b.code_ids,
                reads_nothing=reads_nothing,
                gone=entry["missing_code_ids"] + entry["missing_column_ids"],
                inactive=[c for c in b.code_ids if c in inactive],
                other_dataset=other_dataset)
            by_strand[s.key] = entry
        per_group = [by_strand[s.key] for s in strands if s.kind in PER_GROUP_KINDS]
        code_strands = [c for e in per_group for c in e["codes"]]
        variable_strands = [v for e in per_group for v in e["variables"]]
        out_rows.append({
            "key": r.key,
            # Slice 1's fields — every per-group strand's results of the kind, in display
            # order; exactly slice 1's answer for an implicit pair (r1-3: the build drops
            # them once every reader reads `by_strand`).
            "codes": code_strands,
            "variables": variable_strands,
            "missing_code_ids": [c for e in by_strand.values() for c in e["missing_code_ids"]],
            "missing_column_ids": [c for e in by_strand.values() for c in e["missing_column_ids"]],
            "other_dataset_column_ids": [c for e in by_strand.values()
                                         for c in e["other_dataset_column_ids"]],  # #1665 (D336)
            "inactive_codes": row_inactive,  # #1639 follow-up (r1-8)
            "strands": {
                "codes": STRAND_COVERS if code_strands else STRAND_NOT_MEASURED,
                "variables": STRAND_COVERS if variable_strands else STRAND_NOT_MEASURED,
            },
            "by_strand": by_strand,
        })

    strands_out = []
    for s in strands:
        item = {"key": s.key, "kind": s.kind,
                "unit": UNIT_OBSERVATIONS if s.kind == STRAND_KIND_OBSERVATION_CODES else UNIT_PARTICIPANTS,
                "dataset_id": s.dataset_id, "groups": None, "scope": None, "observations": None}
        if s.kind in PARTICIPANT_CODE_KINDS:
            item.update(groups=code_states[s.key].groups_out(groups),
                        scope=dict(code_states[s.key].scope))
        elif s.kind == STRAND_KIND_OBSERVATION_CODES:
            o = obs_states[s.key]
            item["observations"] = {k: o[k] for k in ("chosen", "with_coding", "agreed",
                                                       "observed_seconds", "segmentation")}
        strands_out.append(item)

    # Slice 1's display-level code strand: the FIRST codes strand's (the only one in an
    # implicit pair) — r1-3, dropped with the rows' slice 1 fields.
    first = next((code_states[s.key] for s in strands if s.kind == STRAND_KIND_CODES), None)
    first = first or _CodeStrandState(groups, coder_ids, layer_scope)
    return {
        "unit": UNIT_PARTICIPANTS,
        "group_by": {
            "column_id": grouping.id,
            "name": grouping.column_name or grouping.column_text,
            "dataset_id": grouping.dataset_id,
            "dataset_name": dataset.name if dataset else None,
        },
        # #1626 (D243): the code strand's own denominator and its participants with no
        # coding in scope — None with no code row (no strand to describe).
        "groups": [{"key": g, "participants": group_size[g], **{
                        k: v for k, v in gi.items() if k not in ("key", "surveyed")}}
                   for g, gi in zip(groups, first.groups_out(groups))],
        "unavailable_reason": NO_GROUP_VALUES if not groups else None,
        "scope": first.scope,
        "rating": rating_block,
        "strands": strands_out,
        "rows": out_rows,
    }
