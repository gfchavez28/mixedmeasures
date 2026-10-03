"""How far a MACHINE coder's labels agree with a person's — and what that is NOT
evidence of (queue row 49).

#989 made a machine coder a layer and excluded it from every reliability
aggregate. That left a question nothing could answer: *how close is this model to
what our coders did?* This module answers it, in a SEPARATE table that is never
pooled with anything.

🔴 **IT DESCRIBES THE MODEL. IT IS NOT VALIDATION OF THE CODING, AND IT IS NOT
RELIABILITY.** A κ between a person and a model is a statement about how well the
model reproduces that person's judgements. It is evidence for none of
Krippendorff's validity types, it does not license a claim that the coding is
correct, and it must never be read as an inter-rater figure — the raters of an
agreement statistic are people making independent interpretations, which a model
run is not. STRATEGY's own constraint, discharged in three ways:

1. **The number is never pooled.** No project-level figure, no contribution to
   the headline α, no row in the per-code reliability table. One coefficient per
   (person × machine × code), which is the grain the claim is actually about.
2. **The unit set and both coverage counts ride the payload**, so a figure
   computed over a corner of the corpus cannot look like one computed over all of
   it (§Coverage below).
3. **The copy says so**, single-sourced in `lib/machine-agreement-copy.ts`.

## The unit set is Option B's — the SAME rule the human table uses

A coder who applied ≥1 code anywhere in a source "reviewed" it, so blanks inside
are real zeros; sources neither touched are missing. That is
`irr.gather_coder_applications`' rule and this module deliberately copies it
rather than inventing a narrower one.

🔴 **A NARROWER RULE FOR THIS TABLE ALONE WAS CONSIDERED AND REFUSED**, and the
reason is worth keeping. A machine that labelled a whole column engaged it, so a
human 30 posts into 500 takes 470 hard zeros — the κ ≈ −1 pathology
`multicoder.md` records for open cuts, reached from a second direction. The
tempting fix is to score only the units the human reached. But then the
human-vs-machine number beside the human-vs-human number would be computed
differently with nothing saying so, which is the failure the whole stated-basis
family exists to prevent. **So the rule stays and the COVERAGE is displayed:**
`n_units` with each side's applied count, and per-code prevalence — the
κ-paradox teaching the IRR table already carries. A researcher mid-pass sees why
the figure is low instead of being handed a flattering one.

## Why this needs its own gather

`irr.gather_coder_applications` filters `auth.reliability_coder_clause()` twice —
at the roster query and in `base_filters` — so a machine's applications are
invisible to it BY CONSTRUCTION. **Relaxing that is the one thing that must not
happen**: it is exactly what #989 shipped to prevent, and it would put a machine
into the headline α. This module asks its own, narrower question instead.

## Not a stated-basis member, and that is a decision

The family's rule is *the server states HOW a number was produced because the
same data yields a different number under another reading*. Here there is ONE
reading — Option B, shared with the human table — so a `basis` field would be a
one-valued vocabulary: a constant wearing a vocabulary's obligations. If a second
unit rule is ever offered, it becomes a member that day and takes the whole
contract with it (a cross-language test, a `satisfies Record`, no re-derivation).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..auth import CODER_TYPE_MACHINE, RELIABILITY_CODER_TYPES
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.segment import Segment
from ..models.user import User
from . import machine_coder
from . import undefined_stats
from .coding_layers import (
    build_effective_code_map,
    consensus_eligible_segment_clause,
    consensus_scoped_segments,
    non_consensus_filter,
    resolve_effective_code,
)
from .irr import (
    _cohens_kappa,
    _distinct_comparable_values,
    _interpret_kappa,
    _n_comparable_units,
    _percent_agreement,
    _prevalence,
    _segment_source_key,
)
from .text_analysis import substantive_text_clause, treat_as_empty_for_project
from ..routers.helpers import visible_segment_filter


@dataclass(frozen=True)
class CodeAgreement:
    """One code, one (person, machine) pair."""

    code_id: int
    code_name: str
    #: Units both of them were in a position to judge (Option B).
    n_units: int
    #: How many of those each side actually applied the code to. **The pair of
    #: numbers is the disclosure**: 3 and 480 is a figure about a corpus one side
    #: barely touched, and κ alone cannot say so.
    human_applied: int
    machine_applied: int
    both_applied: int
    percent_agreement: float | None
    kappa: float | None
    kappa_interpretation: str | None
    #: The base rate, to defuse the prevalence paradox — high agreement plus an
    #: extreme base rate gives a low κ, and without this the table reads as a
    #: failure when it is describing a rare code.
    #: ⚠️ Legal here and ILLEGAL on a code-set matrix, whose cells are code ids
    #: rather than 0/1 (`code-sets.md` §8) — the prohibition there is about the
    #: matrix, not about the function.
    prevalence: float | None
    undefined_reason: str | None = None


@dataclass(frozen=True)
class MachinePairAgreement:
    """One person against one machine, code by code. NEVER pooled."""

    human_id: int
    human_name: str
    machine_id: int
    machine_name: str
    #: The configuration that produced these labels — the whole point of row 49.
    #: A comparison against an unrecorded configuration is a number nobody can
    #: reproduce, so the table SAYS when it is missing rather than omitting it.
    machine_provenance: dict | None
    #: Units both engaged, across every shared source.
    n_units: int
    per_code: list[CodeAgreement] = field(default_factory=list)


@dataclass(frozen=True)
class MachineAgreementResult:
    available: bool
    #: Why there is nothing to show, when there is nothing to show. Named so the
    #: surface can say which of the three states it is in rather than rendering a
    #: silence that reads as "still thinking" (#963 Tier 3's lesson).
    unavailable_reason: str | None = None
    pairs: list[MachinePairAgreement] = field(default_factory=list)


#: Why the table is empty. Distinct sentences, distinct remedies.
NO_MACHINE_CODER = "no_machine_coder"
NO_HUMAN_CODER = "no_human_coder"
NO_SHARED_SOURCE = "no_shared_source"

UNAVAILABLE_REASONS = (NO_MACHINE_CODER, NO_HUMAN_CODER, NO_SHARED_SOURCE)


def _gather(db: Session, project_id: int, coder_ids: list[int]):
    """`(applied, unit_source, engaged)` for an explicit coder list.

    Mirrors `irr.gather_coder_applications`' two passes and its unit rules —
    D18 segment scope, `substantive_text_clause` for cells (#987), non-consensus,
    non-universal — with ONE difference: the coder set is given rather than
    derived from `reliability_coder_clause()`, because a machine is the point.

    ⚠️ **`consensus_scoped_segments` and `substantive_text_clause`, never a
    hand-rolled scope or an emptiness test.** Both were re-inlined once and both
    were wrong: an unfrozen clip entering the gather is a row of fabricated
    disagreement, and `value_text != ""` counted 40 units where a coder could
    reach 36 (#987, measured).
    """
    effective = build_effective_code_map(db, project_id)
    treat_as_empty = treat_as_empty_for_project(db, project_id)

    applied: dict[tuple, dict[int, set[int]]] = defaultdict(lambda: defaultdict(set))
    unit_source: dict[tuple, tuple] = {}
    engaged: dict[tuple, set[int]] = defaultdict(set)

    base = [
        non_consensus_filter(),
        Code.is_universal == False,  # noqa: E712
        CodeApplication.user_id.in_(coder_ids),
    ]

    for seg_id, conv_id, doc_id, obs_id, uid, code_id in (
        consensus_scoped_segments(
            db.query(
                Segment.id, Segment.conversation_id, Segment.document_id,
                Segment.observation_id, CodeApplication.user_id,
                CodeApplication.code_id,
            )
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, CodeApplication.code_id == Code.id),
            project_id,
        ).filter(*visible_segment_filter(), *base).all()
    ):
        src = _segment_source_key(conv_id, doc_id, obs_id)
        ukey = ("seg", seg_id)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(effective, code_id))

    for val_id, col_id, uid, code_id in (
        db.query(
            DatasetValue.id, DatasetValue.column_id, CodeApplication.user_id,
            CodeApplication.code_id,
        )
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(
            Dataset.project_id == project_id,
            substantive_text_clause(treat_as_empty),
            *base,
        ).all()
    ):
        src = ("col", col_id)
        ukey = ("val", val_id)
        unit_source[ukey] = src
        engaged[src].add(uid)
        applied[ukey][uid].add(resolve_effective_code(effective, code_id))

    return applied, unit_source, engaged, treat_as_empty


def _backfill_units(
    db: Session, project_id: int, sources: set[tuple], unit_source: dict,
    treat_as_empty: list[str],
) -> None:
    """Every in-play unit of `sources`, including ones nobody coded.

    Option B's other half: a unit inside a source both engaged is a real judged
    zero for each of them, so it must be present even when it carries no
    application at all.
    """
    conv_ids = [sid for (t, sid) in sources if t == "conv"]
    doc_ids = [sid for (t, sid) in sources if t == "doc"]
    obs_ids = [sid for (t, sid) in sources if t == "obs"]
    col_ids = [sid for (t, sid) in sources if t == "col"]

    if conv_ids or doc_ids or obs_ids:
        from sqlalchemy import or_
        for seg_id, conv_id, doc_id, obs_id in (
            db.query(
                Segment.id, Segment.conversation_id, Segment.document_id,
                Segment.observation_id,
            ).filter(
                *visible_segment_filter(),
                consensus_eligible_segment_clause(),
                or_(
                    Segment.conversation_id.in_(conv_ids),
                    Segment.document_id.in_(doc_ids),
                    Segment.observation_id.in_(obs_ids),
                ),
            ).all()
        ):
            unit_source.setdefault(
                ("seg", seg_id), _segment_source_key(conv_id, doc_id, obs_id),
            )
    if col_ids:
        for val_id, col_id in (
            db.query(DatasetValue.id, DatasetValue.column_id).filter(
                DatasetValue.column_id.in_(col_ids),
                substantive_text_clause(treat_as_empty),
            ).all()
        ):
            unit_source.setdefault(("val", val_id), ("col", col_id))


def compute_machine_agreement(
    db: Session, project_id: int, *, human_id: int | None = None,
) -> MachineAgreementResult:
    """Every (person × machine) pair's per-code agreement. Never a pooled figure.

    ⚠️ **Archived coders are excluded on BOTH sides**, matching the DEC-F voter
    roster: an archived colleague does not vote, and comparing a model against
    somebody who has left the project is a number nobody asked for.

    🔴 **`human_id` narrows the PEOPLE to one, and it is what blind mode sends (#1030).**
    A coder working blind may compare their OWN coding with a model — the model is
    not a colleague, and its chips are already on their screen — but a colleague's
    row would name them and describe their coding. Narrowed HERE, not by the client
    hiding rows, so a colleague's figures never leave the server (the coding-progress
    `coder_id` rule). The machines are never narrowed.
    """
    machines = (
        db.query(User)
        .filter(User.coder_type == CODER_TYPE_MACHINE, User.archived == False)  # noqa: E712
        .order_by(User.id)
        .all()
    )
    if not machines:
        return MachineAgreementResult(available=False, unavailable_reason=NO_MACHINE_CODER)

    human_q = db.query(User).filter(
        User.coder_type.in_(RELIABILITY_CODER_TYPES),
        User.archived == False,  # noqa: E712
    )
    if human_id is not None:
        human_q = human_q.filter(User.id == human_id)
    humans = human_q.order_by(User.id).all()
    if not humans:
        return MachineAgreementResult(available=False, unavailable_reason=NO_HUMAN_CODER)

    coder_ids = [u.id for u in humans + machines]
    applied, unit_source, engaged, treat_as_empty = _gather(db, project_id, coder_ids)

    code_names = dict(
        db.query(Code.id, Code.name).filter(Code.project_id == project_id).all()
    )

    pairs: list[MachinePairAgreement] = []
    for machine in machines:
        provenance = machine_coder.read_provenance(machine)
        for human in humans:
            shared = {
                src for src, cs in engaged.items()
                if human.id in cs and machine.id in cs
            }
            if not shared:
                continue
            # The backfill is per PAIR, because the shared source set is.
            scoped_units = dict(unit_source)
            _backfill_units(db, project_id, shared, scoped_units, treat_as_empty)
            units = [u for u, src in scoped_units.items() if src in shared]
            if not units:
                continue

            in_play_codes = sorted({
                code_id
                for u in units
                for uid in (human.id, machine.id)
                for code_id in applied.get(u, {}).get(uid, ())
            })
            per_code: list[CodeAgreement] = []
            for code_id in in_play_codes:
                matrix: list[list[int | None]] = []
                human_applied = machine_applied = both = 0
                for u in units:
                    by_coder = applied.get(u, {})
                    h = 1 if code_id in by_coder.get(human.id, ()) else 0
                    m = 1 if code_id in by_coder.get(machine.id, ()) else 0
                    human_applied += h
                    machine_applied += m
                    both += 1 if h and m else 0
                    matrix.append([h, m])

                comparable = _n_comparable_units(matrix)
                distinct = _distinct_comparable_values(matrix)
                reason: str | None = None
                if comparable == 0:
                    reason = undefined_stats.INSUFFICIENT_N
                elif len(distinct) < 2:
                    # 🔴 #689/#828's rider: with no variance there is nothing to
                    # agree ABOUT, and κ's `pe >= 1.0` branch would print 1.0 —
                    # rendered "almost perfect" over a code neither of them used.
                    reason = undefined_stats.NO_VARIANCE

                kappa = None if reason else _cohens_kappa(matrix)
                per_code.append(CodeAgreement(
                    code_id=code_id,
                    code_name=code_names.get(code_id, f"Code {code_id}"),
                    n_units=len(units),
                    human_applied=human_applied,
                    machine_applied=machine_applied,
                    both_applied=both,
                    percent_agreement=(
                        None if reason == undefined_stats.INSUFFICIENT_N
                        else _percent_agreement(matrix)
                    ),
                    kappa=undefined_stats.finite_or_none(kappa, 4),
                    kappa_interpretation=_interpret_kappa(kappa),
                    prevalence=_prevalence(matrix),
                    undefined_reason=reason,
                ))

            pairs.append(MachinePairAgreement(
                human_id=human.id,
                human_name=human.username,
                machine_id=machine.id,
                machine_name=machine.username,
                machine_provenance=provenance,
                n_units=len(units),
                per_code=per_code,
            ))

    if not pairs:
        return MachineAgreementResult(available=False, unavailable_reason=NO_SHARED_SOURCE)
    return MachineAgreementResult(available=True, pairs=pairs)
