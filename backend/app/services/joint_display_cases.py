"""The joint display's case-ordered view and its "cases that don't fit" rule (slice 2, D173).

ROADMAP row 56, STRATEGY question 5. A row's numbers (`services/joint_display.py`) are per
GROUP; this module reads the same row per PERSON — one case per participant of the
display's groups, with their group and, per per-group strand, which of the row's codes
they used and their value on each of the row's variables (O'Cathain et al.'s cases × data
matrix; the "comprehensive case analysis" of Younas, Pedersen & Inayat, *Practical strategies
to identify and address discordant findings in mixed methods research*, Res Methods Med Health
Sci 4(1):24–34, doi 10.1177/26320843221122342 — abstract verified).

🔴 **The app never decides misfit (D173).** A row's misfit list is either a RULE the
researcher states — conditions joined by AND (r3-1), evaluated here — and the cases they
ADD to or REMOVE from it, each with their reason (r3-12; stored in the node,
`joint_display_node.py`); with no rule, the list is what they added. The published
exemplars select this way: a stated rule (Bradt et al.'s z-score typology; Lee & Greene's
"high CEEPT score and nevertheless a low GPA") with the cases shown beside it. This module
answers which cases the rule selects, which make the list, and how many it cannot check;
it suggests nothing.

The rules each part follows, so the case view and the row's cells cannot disagree:

- **Who is a case:** every participant the display's grouping variable puts in a group —
  `code_analysis.grouping_column` (the ONE gate: a rating-derived grouping is refused
  while blind, 409, #1615 D284) and `_build_participant_group_map`, the compute's own.
- **A code fact** is `code_analysis.gather_participant_codes`, per code strand, over THAT
  strand's sources, with the display's coder + layer scope (D175) — the compute's gather,
  so "used" here is the cell's numerator and "has material" its denominator (D168.1). A
  person with no material in the strand's sources has no answer to "used it?" (None),
  never "no" (#1421's four doors); ``coded`` says whether any of their material carries
  a coding in scope (#1626 D243 — "did not use" is true only once it is coded).
- **A variable fact** is the person's value from their ONE row of the column's dataset,
  missing through the column's rules (`missing_values`), a category named by
  `answer_label_resolver` (#1332), numbers only for `SCALE_SCORE_ELIGIBLE_TYPES` (the
  compute's SUMMARY_MEAN set) and labels only for `CATEGORICAL_GROUPING_TYPES`. An open
  text answer is never shown (VARIABLE_NOT_SUMMARISABLE — it is the person's words). A
  column worked out from participant scores is withheld while blind (#1615,
  `withheld_rating_columns_in_project`): its fact says so, and a rule that names it is
  NOT evaluated (r3-3) — leaving the condition out would select by a rule the researcher
  did not write.
- **Three-valued AND (r3-2):** a condition on a missing value or on a person with no
  material is UNKNOWN; AND is False if any condition is False, else unknown if any is,
  else True — SQL's rule, as the computed-column language's. ``matched`` counts True,
  ``unknown`` counts the cases the rule cannot check; neither is folded into the other.
- **A rule names only the ROW's own bindings** (r3-1): a variable the row binds, a code a
  code strand of the row binds, or a group. So every condition is a column of the case
  view — the rule is always visible beside what it selects (Rohlfing & Starke: such
  classifications are fragile, so the rule must be seen).
- **An INACTIVE bound code is left out, as the compute leaves it out (#1664, D332–D333;
  D325's rule).** The codebook's merge moves a code's coding to its target and makes it
  inactive, so read as a column it showed "not used" for everyone and a rule "did not use
  it" selected every case with material (measured: 4 of 6, two of whom had used it). It
  leaves the heads, the gather and the case facts, and is named in ``inactive_codes`` (the
  compute's shape, `merged_into` for where its coding went). A saved condition naming one is
  KEPT and NOT RUN (`MISFIT_RULE_CODE_INACTIVE`) — never silently dropped (R1), never
  evaluated over a code with no coding of its own.
- **Order (r3-8):** the display's group order (`order_value_labels`), then the
  participant's identifier, then their id — the Participants page's identifier order
  within a group. Stable, so paging is.
- **Scale (`sql-id-sets.md`):** nothing binds a list built from the data — the population
  is read through the grouping column's cells, codes through the gather, values through
  each column's cells, identifiers by project; the picked list is filtered in Python.

The endpoint is plain `def` (`routers/joint_display.py`; `test_endpoint_event_loop.py::
MUST_BE_SYNC`): the gather is the compute's.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.dataset import (
    CATEGORICAL_GROUPING_TYPES,
    SCALE_SCORE_ELIGIBLE_TYPES,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from ..models.participant import Participant
from .code_analysis import _build_participant_group_map, gather_participant_codes, grouping_column
from .grouping import order_value_labels
from .joint_display import (
    STRAND_KIND_CODES,
    STRAND_KIND_TEXT_CODES,
    STRAND_KIND_VARIABLES,
    VARIABLE_NOT_SUMMARISABLE,
    VARIABLE_RATING_WITHHELD,
    StrandRequest,
    answer_strand_gather,
    merged_into,
)
from .missing_values import column_missing_rules, is_missing
from .participant_scores import withheld_rating_columns_in_project
from .undefined_stats import NO_GROUP_VALUES, finite_or_none
from .value_labels import answer_label_resolver

# ── The case view's stated vocabulary (mirrored in `lib/joint-display-vocabulary.ts`) ──

#: Why a case's value is absent — beside VARIABLE_NOT_SUMMARISABLE / _RATING_WITHHELD.
CASE_VALUE_MISSING = "missing"  # a blank or declared non-answer (the column's rules)
CASE_NO_ROW = "no_row"  # no row of theirs in the variable's dataset

#: r3-12 — why a case is on the misfit list: the rule selects it, or the researcher added it.
MISFIT_LISTED_BY_RULE = "rule"
MISFIT_LISTED_BY_ADDED = "added"

#: Why a rule is not evaluated — every case's ``matches`` is then None, and said.
MISFIT_RULE_REFERENCE_MISSING = "reference_missing"  # names nothing the row binds now
MISFIT_RULE_CONDITION_INVALID = "condition_invalid"  # an operator its variable's type lacks
#: #1664 (D333) — a condition on a bound code the codebook made inactive: kept, never run.
MISFIT_RULE_CODE_INACTIVE = "code_inactive"
#: #1615 — a condition on a variable withheld while blind: never evaluated, never dropped.
MISFIT_RULE_RATING_WITHHELD = VARIABLE_RATING_WITHHELD

#: r3-4 — the operators, by key. Their words live in the client vocabulary.
CASE_OP_LT = "lt"
CASE_OP_LE = "le"
CASE_OP_GT = "gt"
CASE_OP_GE = "ge"
CASE_OP_EQ = "eq"
CASE_OP_NE = "ne"
CASE_OP_IS = "is"
CASE_OP_IS_NOT = "is_not"
CASE_OP_MISSING = "missing"

_NUMBER_OPS = (CASE_OP_LT, CASE_OP_LE, CASE_OP_GT, CASE_OP_GE, CASE_OP_EQ, CASE_OP_NE)
_LABEL_OPS = (CASE_OP_IS, CASE_OP_IS_NOT)

#: Bounds on one request (the schema's).
MAX_CASE_PAGE = 200
MAX_LISTED_CASES = 100  # added, and removed, each
MAX_RULE_CONDITIONS = 8


def operators_for(column_type) -> tuple[str, ...]:
    """r3-4 — the operators a variable condition may use, by the eligibility frozensets.

    Comparisons where a mean is meaningful (`SCALE_SCORE_ELIGIBLE_TYPES`), is / is not
    where a variable forms groups (`CATEGORICAL_GROUPING_TYPES`) — an ordinal takes both
    — and "has no answer" for either. Open text, an identifier or a multi-select: none.
    """
    ops: tuple[str, ...] = ()
    if column_type in SCALE_SCORE_ELIGIBLE_TYPES:
        ops += _NUMBER_OPS
    if column_type in CATEGORICAL_GROUPING_TYPES:
        ops += _LABEL_OPS
    return ops + (CASE_OP_MISSING,) if ops else ()


#: The case read takes the compute's own strand (joint display slice 2, R10: r3's C1 stub
#: re-pointed at r1's model). An ``observation_codes`` strand is never a case column — an
#: observation names no participant (D165) — and a ``text_codes`` strand's facts are
#: "answered / not answered" from r4's gather (`answer_strand_gather`): its
#: ``has_material`` is whether the person answered the strand's questions.
CaseStrand = StrandRequest


@dataclass(frozen=True)
class CaseBinding:
    code_ids: tuple[int, ...] = ()
    column_ids: tuple[int, ...] = ()


@dataclass
class _Value:
    value: float | None = None
    label: str | None = None
    reason: str | None = None


@dataclass
class _CodeFacts:
    material: set[int] = field(default_factory=set)
    coded: set[int] = field(default_factory=set)
    used: dict[tuple[int, int], int] = field(default_factory=dict)  # (pid, code) → passages


def _and(results) -> bool | None:
    """r3-2 — three-valued AND: False wins, then unknown, then True."""
    unknown = False
    for r in results:
        if r is False:
            return False
        if r is None:
            unknown = True
    return None if unknown else True


def _as_number(raw) -> float | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return finite_or_none(float(raw))
    if isinstance(raw, str):
        try:
            return finite_or_none(float(raw.strip()))
        except ValueError:
            return None
    return None


def _compare(op: str, a: float, b: float) -> bool:
    return {CASE_OP_LT: a < b, CASE_OP_LE: a <= b, CASE_OP_GT: a > b, CASE_OP_GE: a >= b,
            CASE_OP_EQ: a == b, CASE_OP_NE: a != b}[op]


def read_cases(
    db: Session,
    project_id: int,
    *,
    group_by_column_id: int,
    strands: list[CaseStrand],
    bindings: dict[str, CaseBinding],
    coder_ids: list[int] | None,
    layer_scope: str | None,
    rule: list[dict] | None,
    only: str,
    added_participant_ids: list[int],
    removed_participant_ids: list[int],
    offset: int,
    limit: int,
) -> dict:
    """One row of a display, per case — see the module docstring for every rule."""
    grouping = grouping_column(db, project_id, group_by_column_id, blind_scope=coder_ids)
    part_group = _build_participant_group_map(db, project_id, column_id=grouping.id,
                                              blind_scope=None)  # the gate above answered
    groups = order_value_labels(set(part_group.values()))
    withheld = withheld_rating_columns_in_project(db, project_id, coder_ids)

    # R10: the per-group strands only — an observation strand names no participant.
    code_strands = [s for s in strands if s.kind in (STRAND_KIND_CODES, STRAND_KIND_TEXT_CODES)]
    var_strands = [s for s in strands if s.kind == STRAND_KIND_VARIABLES]

    # ── What the row binds, resolved against THIS project ────────────────────────
    wanted_codes = sorted({c for s in code_strands for c in bindings.get(s.key, CaseBinding()).code_ids})
    codes = {c.id: c for c in db.query(Code).filter(
        Code.project_id == project_id, Code.id.in_(wanted_codes))} if wanted_codes else {}
    # #1664 (D332): an inactive code leaves the read exactly as it leaves the compute (D325) —
    # the heads, the gather and every case fact read the ACTIVE ones; the inactive are named.
    inactive = {cid: c for cid, c in codes.items() if not c.is_active}
    codes = {cid: c for cid, c in codes.items() if c.is_active}
    into = merged_into(db, project_id, inactive)
    wanted_cols = sorted({c for s in var_strands for c in bindings.get(s.key, CaseBinding()).column_ids})
    columns = {c.id: c for c in db.query(DatasetColumn)
               .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
               .filter(Dataset.project_id == project_id, DatasetColumn.id.in_(wanted_cols))
               } if wanted_cols else {}

    def _strand_columns(s) -> list[int]:
        """The strand's bound columns that resolve here — and, for a strand naming its ONE
        dataset (D205, R5), only that dataset's: the compute lists the others as missing."""
        return [c for c in bindings.get(s.key, CaseBinding()).column_ids if c in columns
                and (s.dataset_id is None or columns[c].dataset_id == s.dataset_id)]

    # ── Code facts: the compute's gather, per code strand over its own sources ────
    code_facts: dict[str, _CodeFacts] = {}
    for s in code_strands:
        ids = [c for c in bindings.get(s.key, CaseBinding()).code_ids if c in codes]
        facts = _CodeFacts()
        if ids and s.kind == STRAND_KIND_TEXT_CODES:
            # R10: an answer strand's base is who ANSWERED its questions (r4-1, #519).
            answers = answer_strand_gather(
                db, project_id, text_column_ids=None if s.text_column_ids is None
                else list(s.text_column_ids), code_ids=sorted(set(ids)),
                coder_ids=coder_ids, layer_scope=layer_scope)
            facts.material = set(answers.answered)
            facts.coded = set(answers.coded_people)
            for pid, cid, n in answers.person_codes:
                if pid is not None:
                    facts.used[(pid, cid)] = facts.used.get((pid, cid), 0) + n
        elif ids:
            gathered = gather_participant_codes(
                db, project_id,
                conversation_ids=None if s.conversation_ids is None else list(s.conversation_ids),
                document_ids=None if s.document_ids is None else list(s.document_ids),
                text_column_ids=[],
                exclude_facilitator=True, participant_ids=None, code_ids=sorted(set(ids)),
                coder_ids=coder_ids, layer_scope=layer_scope)
            facts.material = set(gathered.person_passages)
            facts.coded = set(gathered.coded_people)
            for pid, cid, n in gathered.person_codes:
                if pid is not None:
                    facts.used[(pid, cid)] = facts.used.get((pid, cid), 0) + n
        code_facts[s.key] = facts

    # ── Variable facts: each column's cells through their linked rows ────────────
    values: dict[int, dict[int, _Value]] = {}  # column → participant → value
    has_row: dict[int, set[int]] = {}  # dataset → participants with a row
    for cid, column in columns.items():
        if column.dataset_id not in has_row:
            has_row[column.dataset_id] = {pid for (pid,) in db.query(DatasetRow.participant_id)
                                          .filter(DatasetRow.dataset_id == column.dataset_id,
                                                  DatasetRow.participant_id != None)}  # noqa: E711
        if cid in withheld or not operators_for(column.column_type):
            values[cid] = {}
            continue
        rules = column_missing_rules(column)
        as_label = answer_label_resolver(column)
        numeric = column.column_type in SCALE_SCORE_ELIGIBLE_TYPES
        labelled = column.column_type in CATEGORICAL_GROUPING_TYPES
        per_person: dict[int, _Value] = {}
        for text, number, pid in (
            db.query(DatasetValue.value_text, DatasetValue.value_numeric, DatasetRow.participant_id)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetValue.column_id == cid, DatasetRow.dataset_id == column.dataset_id,
                    DatasetRow.participant_id != None)  # noqa: E711
        ):
            if pid not in part_group:
                continue
            if text is None or not text.strip() or is_missing(text, rules):
                per_person[pid] = _Value(reason=CASE_VALUE_MISSING)
                continue
            per_person[pid] = _Value(
                value=finite_or_none(number) if numeric else None,
                label=as_label(text).strip() if labelled else None)
        values[cid] = per_person

    def _value(cid: int, pid: int) -> _Value:
        column = columns[cid]
        if cid in withheld:
            return _Value(reason=VARIABLE_RATING_WITHHELD)
        if not operators_for(column.column_type):
            return _Value(reason=VARIABLE_NOT_SUMMARISABLE)
        if pid not in has_row[column.dataset_id]:
            return _Value(reason=CASE_NO_ROW)
        return values[cid].get(pid) or _Value(reason=CASE_VALUE_MISSING)

    # ── The rule: checked against the row's bindings first, then per case ────────
    bound_columns = {c: columns[c] for s in var_strands for c in _strand_columns(s)}
    rule_reason, withheld_names, evaluators = _compile_rule(
        rule, code_strands, var_strands, bindings, codes, inactive, bound_columns, withheld,
        code_facts, _value)

    names = dict(db.query(Participant.id, Participant.identifier)
                 .filter(Participant.project_id == project_id))
    group_index = {g: i for i, g in enumerate(groups)}
    population = sorted(part_group, key=lambda p: (group_index[part_group[p]], names.get(p, ""), p))

    matches: dict[int, bool | None] = {}
    if evaluators is not None:
        for pid in population:
            matches[pid] = _and(ev(pid, part_group[pid]) for ev in evaluators)

    added, removed = set(added_participant_ids), set(removed_participant_ids)
    in_list = misfit_list(population, matches, added, removed)
    listed = [p for p in population if p in in_list] if only == "list" else population

    def _case(pid: int) -> dict:
        facts: dict[str, dict] = {}
        for s in code_strands:
            f = code_facts[s.key]
            has = pid in f.material
            facts[s.key] = {
                "has_material": has, "coded": pid in f.coded, "values": [],
                "codes": [{"code_id": c, "passages": f.used.get((pid, c), 0),
                           "used": ((pid, c) in f.used) if has else None}
                          for c in bindings.get(s.key, CaseBinding()).code_ids if c in codes]}
        for s in var_strands:
            facts[s.key] = {"has_material": None, "coded": None, "codes": [], "values": [
                {"column_id": c, **_value(c, pid).__dict__} for c in _strand_columns(s)]}
        return {"participant_id": pid, "label": names.get(pid, ""), "group": part_group[pid],
                "facts": facts, "matches": matches.get(pid) if evaluators is not None else None,
                "listed_by": in_list.get(pid), "removed": pid in removed}

    return {
        "groups": groups,
        "total": len(population),
        "listed": len(listed),
        "matched": sum(1 for v in matches.values() if v is True) if evaluators is not None else None,
        "unknown": sum(1 for v in matches.values() if v is None) if evaluators is not None else None,
        "rule_unavailable_reason": rule_reason,
        "rule_withheld_columns": withheld_names,
        "list_size": len(in_list),
        # Added cases no longer among the display's groups (no group value, or gone).
        "added_outside": len(added - set(population)),
        "codes": [{"code_id": c.id, "name": c.name} for c in codes.values()],
        # #1664 (D332, D334): the compute's `inactive_codes`, per (strand, code) — the case view
        # says which code is out and where its coding went, and names it in a saved rule.
        "inactive_codes": [
            {"strand_key": s.key, "code_id": cid, "name": inactive[cid].name,
             "merged_into_id": into[cid].id if into.get(cid) else None,
             "merged_into_name": into[cid].name if into.get(cid) else None}
            for s in code_strands for cid in bindings.get(s.key, CaseBinding()).code_ids
            if cid in inactive],
        "variables": [{"column_id": c.id, "name": c.column_name or c.column_text,
                       "dataset_id": c.dataset_id, "withheld": c.id in withheld,
                       "operators": list(operators_for(c.column_type))}
                      for c in bound_columns.values()],
        "cases": [_case(p) for p in listed[offset:offset + limit]],
        # Joint display slice 2, round 2 (r5-6): who each case the researcher ADDED or REMOVED
        # is, and their group (None = no longer in the display's groups) — the open
        # construct's lists and the export's note name them by it, whatever page is read.
        # Never a rule-selected case (r3-11): those are counted, not named. An id naming no
        # participant here is absent, so the reader says "no longer in the project".
        "named_cases": [{"participant_id": p, "label": names[p] or "", "group": part_group.get(p)}
                        for p in sorted(added | removed) if p in names],
        "unavailable_reason": NO_GROUP_VALUES if not groups else None,
    }


def misfit_list(population: list[int], matches: dict[int, bool | None],
                added: set[int], removed: set[int]) -> dict[int, str]:
    """r3-12 — the misfit list: the rule's cases less those REMOVED, plus those ADDED, each
    with why it is listed. A case the rule cannot check (``None``) is not listed by it —
    the researcher may add it. ONE function, so the contract's exclusive rule-or-picked
    (C4) is a switch here: return the rule's cases or the added ones, never both.
    """
    out: dict[int, str] = {}
    for pid in population:
        if pid in added:
            out[pid] = MISFIT_LISTED_BY_ADDED
        elif matches.get(pid) is True and pid not in removed:
            out[pid] = MISFIT_LISTED_BY_RULE
    return out


def _compile_rule(rule, code_strands, var_strands, bindings, codes, inactive, columns, withheld,
                  code_facts, value_of):
    """The rule's conditions as per-case evaluators — or why the rule is not evaluated.

    Returns ``(reason, withheld column names, evaluators | None)``; ``None`` evaluators with
    no reason means there is no rule. Withheld is reported FIRST (#1615: say it, by name).
    """
    if not rule:
        return None, [], None
    code_keys = {s.key for s in code_strands}
    withheld_names: list[str] = []
    reason = None
    evaluators = []
    for cond in rule:
        kind = cond.get("kind")
        if kind == "group":
            group = cond.get("group")
            if not isinstance(group, str):
                reason = reason or MISFIT_RULE_CONDITION_INVALID
                continue
            evaluators.append(lambda pid, g, want=group: g == want)
        elif kind == "variable":
            cid, op = cond.get("column_id"), cond.get("op")
            column = columns.get(cid)  # holds the row's bound columns only (M15: a second
            # "is it bound?" test was redundant — it survived its mutant)
            if column is None:
                reason = reason or MISFIT_RULE_REFERENCE_MISSING
                continue
            if cid in withheld:
                withheld_names.append(column.column_name or column.column_text)
                continue
            if op not in operators_for(column.column_type):
                reason = reason or MISFIT_RULE_CONDITION_INVALID
                continue
            if op == CASE_OP_MISSING:
                evaluators.append(lambda pid, g, c=cid: value_of(c, pid).reason is not None)
            elif op in _NUMBER_OPS:
                want = _as_number(cond.get("value"))
                if want is None:
                    reason = reason or MISFIT_RULE_CONDITION_INVALID
                    continue
                evaluators.append(
                    lambda pid, g, c=cid, o=op, w=want:
                    None if value_of(c, pid).value is None else _compare(o, value_of(c, pid).value, w))
            else:
                raw = cond.get("value")
                if raw is None or not str(raw).strip():
                    reason = reason or MISFIT_RULE_CONDITION_INVALID
                    continue
                want = answer_label_resolver(column)(str(raw)).strip()  # #1332: a variant names its label
                evaluators.append(
                    lambda pid, g, c=cid, o=op, w=want:
                    None if value_of(c, pid).label is None
                    else (value_of(c, pid).label == w) == (o == CASE_OP_IS))
        elif kind == "code":
            key, code_id, present = cond.get("strand_key"), cond.get("code_id"), cond.get("present")
            # #1664 (D333): a code the row still binds but the codebook made inactive is KEPT
            # and not run — its coding was moved (a merge) or set aside, so "used it?" over it
            # would select by a fact the code no longer holds.
            if key in code_keys and code_id in inactive \
                    and code_id in bindings.get(key, CaseBinding()).code_ids:
                reason = reason or MISFIT_RULE_CODE_INACTIVE
                continue
            if key not in code_keys or code_id not in codes \
                    or code_id not in bindings.get(key, CaseBinding()).code_ids:
                reason = reason or MISFIT_RULE_REFERENCE_MISSING
                continue
            if not isinstance(present, bool):
                reason = reason or MISFIT_RULE_CONDITION_INVALID
                continue
            facts = code_facts[key]
            evaluators.append(
                lambda pid, g, f=facts, c=code_id, want=present:
                None if pid not in f.material else (((pid, c) in f.used) == want))
        else:
            reason = reason or MISFIT_RULE_CONDITION_INVALID
    if withheld_names:
        return MISFIT_RULE_RATING_WITHHELD, withheld_names, None
    if reason:
        return reason, [], None
    return None, [], evaluators
