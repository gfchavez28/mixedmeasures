"""Which participant does a CODING TARGET belong to? — the one accessor.

Row 45 step 1. A rating (`CodeApplication.magnitude`) lives on one coded
passage; rolling those up to a per-participant variable needs the question
*"whose passage was that?"* answered once, the same way, for every route.

**Three routes reach a participant, and one deliberately does not:**

    conversation segment ── Segment.speaker_id ── Speaker.participant_id
    document segment ───── Segment.document_id ── Document.participant_id   (row 46)
    dataset cell ───────── DatasetValue.row_id ── DatasetRow.participant_id
    observation clip ───── (nothing; `Observation` has no participant link)

Before this module the three joins existed only as aggregate `GROUP BY`
queries inside `code_analysis.py::_compute_source_groups`, which answers a
different question ("bucket these units by a participant ATTRIBUTE") and
cannot be asked about one target. `coding_counts.py::_participant_predicate`
is a FACILITATOR filter, not a resolver — it never names a participant.

🔴 **`participant_id` answers WHO. It does not answer WHETHER THIS TARGET
COUNTS.** Two eligibility facts ride alongside precisely so no consumer
re-derives the join to ask them:

  * ``via_facilitator`` — the turn is a facilitator's. Every participant count
    in the codebase excludes those (`coding_counts._participant_predicate`,
    `_compute_source_groups`'s `exclude_facilitator`), so a rollup that
    ignores this scores a facilitator on their own prompts. Meaningful on the
    speaker route only.
  * ``target_visible`` — the segment is not merged/split away. A hidden
    original's codings are unreachable everywhere in the UI (#500), so they
    must not enter an aggregate; the link itself is still real, which is why
    this is REPORTED rather than folded into ``participant_id``.

🔴 **An unresolved target SAYS WHY** (`unresolved_reason`), because "reaches
nobody" has five distinct causes and row 45's Decision 4 obliges the rollup to
disclose the clip case specifically rather than drop it silently. This is the
stated-basis posture applied to a service: the producer states how the answer
was reached and the consumer never infers it.

⚠️ **ABSENT ≠ UNRESOLVED.** A target that does not exist, or belongs to another
project, is simply MISSING from the returned map — never a ``None`` entry. The
queries are project-scoped, so a stale or foreign id cannot resolve to somebody
else's participant, and a consumer reading ``.get(id)`` can tell "I asked about
something that is not here" from "this target reaches nobody".

⚠️ **Bounded by construction.** Ids are looked up in chunks (`_ID_CHUNK`)
because SQLAlchemy renders one bind parameter per element and SQLite's
`SQLITE_MAX_VARIABLE_NUMBER` is exactly 250,000 (#842 — the ceiling that broke
`.mmproject` export). Callers hold a bounded set today (rated applications are
bounded by coding volume, not dataset size); a future PROJECT-WIDE consumer
should join back to `project_id` in its own query rather than materialise every
id and pass it here.

Enumeration is GATED, not remembered: `tests/test_participant_resolution.py`
reflects over `Base.metadata` for every FK naming `participants.id` and over
`segment_operations._PARENT_FK` for every segment parent, and fails with
instructions when one has no route. A fourth link to a participant is a failing
test in THREE places now — here, `withdrawal_report.py`, and
`withdrawal_redaction.py`.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetRow, DatasetValue
from ..models.document import Document
from ..models.segment import Segment
from ..models.speaker import Speaker
from .coding_layers import project_scoped_segments

# ── The route vocabulary ────────────────────────────────────────────────────
#
# One value per way a coding target can reach (or fail to reach) a person.
# `observation` is a real route that reaches nobody by design — the symmetric
# gap row 46 left when documents joined the spine.

ROUTE_SPEAKER = "speaker"
ROUTE_DOCUMENT = "document"
ROUTE_DATASET_ROW = "dataset_row"
ROUTE_OBSERVATION = "observation"

#: Every FK naming `participants.id`, and the route that follows it. The
#: observation route is deliberately absent — there is no such column, which
#: is exactly why a clip reaches nobody. Gated against the schema by
#: `TestEveryParticipantFkHasARoute`.
PARTICIPANT_FK_ROUTES: dict[tuple[str, str], str] = {
    ("speakers", "participant_id"): ROUTE_SPEAKER,
    ("dataset_rows", "participant_id"): ROUTE_DATASET_ROW,
    ("documents", "participant_id"): ROUTE_DOCUMENT,
}

#: Segment parent column → route. Keyed by COLUMN NAME so it can be gated
#: against `segment_operations._PARENT_FK`, the map a fourth parent must touch.
SEGMENT_PARENT_ROUTES: dict[str, str] = {
    "conversation_id": ROUTE_SPEAKER,
    "document_id": ROUTE_DOCUMENT,
    "observation_id": ROUTE_OBSERVATION,
}

# ── Why a target reached nobody ─────────────────────────────────────────────
#
# Five causes, deliberately distinct. Row 45 excludes clips and must SAY so
# (Decision 4); the other four are ordinary "not linked yet" states a
# researcher can act on, and conflating them would make the disclosure useless.

UNRESOLVED_OBSERVATION_CLIP = "observation_clip"
UNRESOLVED_NO_SPEAKER = "no_speaker"
UNRESOLVED_SPEAKER_UNLINKED = "speaker_unlinked"
UNRESOLVED_DOCUMENT_UNLINKED = "document_unlinked"
UNRESOLVED_ROW_UNLINKED = "row_unlinked"

UNRESOLVED_REASONS = (
    UNRESOLVED_OBSERVATION_CLIP,
    UNRESOLVED_NO_SPEAKER,
    UNRESOLVED_SPEAKER_UNLINKED,
    UNRESOLVED_DOCUMENT_UNLINKED,
    UNRESOLVED_ROW_UNLINKED,
)

#: One lookup per `.in_()`, well under SQLite's 250,000 bind-parameter ceiling
#: (#842). Mirrors `project_portability._UUID_LOOKUP_CHUNK`.
_ID_CHUNK = 5_000


@dataclass(frozen=True)
class ParticipantRoute:
    """One coding target's answer to "whose is this?".

    ``participant_id`` is ``None`` iff ``unresolved_reason`` is set — the two
    are a pair, never independently meaningful.
    """

    #: The person, or None. `is not None`, never truthiness (#414).
    participant_id: int | None
    #: How the answer was reached — one of the ROUTE_* constants.
    route: str
    #: Why there is no person, or None when there is one.
    unresolved_reason: str | None = None
    #: Speaker route only: the turn belongs to a facilitator. Every participant
    #: count in the codebase excludes these; this module does not decide that.
    via_facilitator: bool = False
    #: Segment targets: not merged/split away (#500). Dataset cells have no
    #: soft-delete, so they are always visible.
    target_visible: bool = True


@dataclass(frozen=True)
class ParticipantResolution:
    """The answers for one batch, keyed by target id within each grain.

    ⚠️ A key that is ABSENT was not resolvable at all — it does not exist, or
    it belongs to another project. That is a different fact from a present
    entry whose ``participant_id`` is None, and the two must not be merged.
    """

    segments: dict[int, ParticipantRoute]
    dataset_values: dict[int, ParticipantRoute]

    def for_target(
        self,
        *,
        segment_id: int | None = None,
        dataset_value_id: int | None = None,
    ) -> ParticipantRoute | None:
        """Dispatch `CodeApplication`'s segment-XOR-value target in ONE place.

        Mirrors `ck_code_application_exactly_one_target`: exactly one id must be
        given. Passing both, or neither, is a caller bug and raises — the same
        fail-closed posture `segment_operations._require_parent_type` takes,
        because both states are wiring errors rather than user input.
        """
        if (segment_id is None) == (dataset_value_id is None):
            raise ValueError(
                "for_target takes exactly one of segment_id / dataset_value_id "
                "(the CodeApplication target invariant), got "
                f"segment_id={segment_id!r}, dataset_value_id={dataset_value_id!r}"
            )
        if segment_id is not None:
            return self.segments.get(segment_id)
        return self.dataset_values.get(dataset_value_id)

    def unresolved_counts(self) -> dict[str, int]:
        """``{reason: how many targets}`` — the disclosure primitive.

        Row 45's Decision 4: clip ratings are excluded from the rollup and the
        rollup SAYS it excluded them. Computed here so every consumer's
        disclosure is derived from the same pass that produced the answers,
        rather than re-counted against a second predicate.
        """
        counts: dict[str, int] = {}
        for routes in (self.segments, self.dataset_values):
            for route in routes.values():
                if route.unresolved_reason is not None:
                    counts[route.unresolved_reason] = (
                        counts.get(route.unresolved_reason, 0) + 1
                    )
        return counts

    def participant_ids(self) -> set[int]:
        """Every distinct person this batch reached, both grains pooled.

        One participant is routinely reached twice — a workplan and their own
        interview turns — which is the case the rollup pools into one score.
        """
        return {
            route.participant_id
            for routes in (self.segments, self.dataset_values)
            for route in routes.values()
            if route.participant_id is not None
        }


def _chunks(ids: Sequence[int]) -> Iterable[Sequence[int]]:
    for start in range(0, len(ids), _ID_CHUNK):
        yield ids[start:start + _ID_CHUNK]


def _segment_route(
    *,
    conversation_id: int | None,
    document_id: int | None,
    observation_id: int | None,
    speaker_id: int | None,
    speaker_participant_id: int | None,
    is_facilitator: int | None,
    document_participant_id: int | None,
    visible: bool,
) -> ParticipantRoute:
    """One segment row → its answer. Pure; the parent branch is TOTAL.

    Raises on a segment with no parent. `ck_segment_exactly_one_parent` makes
    that unreachable today, so the only way to get here is a FOURTH parent
    added without widening `SEGMENT_PARENT_ROUTES` — which must be loud, not a
    silent "reaches nobody" that would quietly shrink every score.
    """
    if observation_id is not None:
        # The clip route. No `Observation.participant_id` exists — this is the
        # gap row 46 deliberately left, not a missing link on this recording.
        return ParticipantRoute(
            participant_id=None,
            route=ROUTE_OBSERVATION,
            unresolved_reason=UNRESOLVED_OBSERVATION_CLIP,
            target_visible=visible,
        )

    if document_id is not None:
        # Row 46's grain: the subject is a property of the DOCUMENT, so every
        # segment of it answers the same. No speaker exists to be a
        # facilitator, so `via_facilitator` stays False by construction.
        return ParticipantRoute(
            participant_id=document_participant_id,
            route=ROUTE_DOCUMENT,
            unresolved_reason=(
                None if document_participant_id is not None
                else UNRESOLVED_DOCUMENT_UNLINKED
            ),
            target_visible=visible,
        )

    if conversation_id is not None:
        if speaker_id is None:
            # An untagged turn. Distinct from a tagged-but-unlinked one: the
            # remedy is mapping speakers, not linking a participant.
            return ParticipantRoute(
                participant_id=None,
                route=ROUTE_SPEAKER,
                unresolved_reason=UNRESOLVED_NO_SPEAKER,
                target_visible=visible,
            )
        return ParticipantRoute(
            participant_id=speaker_participant_id,
            route=ROUTE_SPEAKER,
            unresolved_reason=(
                None if speaker_participant_id is not None
                else UNRESOLVED_SPEAKER_UNLINKED
            ),
            via_facilitator=bool(is_facilitator),
            target_visible=visible,
        )

    raise ValueError(
        "a segment reached participant resolution with no parent — add its "
        "parent column to participant_resolution.SEGMENT_PARENT_ROUTES and "
        "give it a branch in _segment_route"
    )


def resolve_participants(
    db: Session,
    project_id: int,
    *,
    segment_ids: Iterable[int] = (),
    dataset_value_ids: Iterable[int] = (),
) -> ParticipantResolution:
    """Resolve coding targets to the people they belong to. THE accessor.

    Project-scoped: a target outside ``project_id`` is absent from the result,
    so a stale or foreign id can never resolve to another project's
    participant. Two queries at most (one per grain), each chunked.
    """
    seg_ids = sorted({int(i) for i in segment_ids})
    value_ids = sorted({int(i) for i in dataset_value_ids})

    segments: dict[int, ParticipantRoute] = {}
    for chunk in _chunks(seg_ids):
        query = (
            db.query(
                Segment.id.label("segment_id"),
                Segment.conversation_id,
                Segment.document_id,
                Segment.observation_id,
                Segment.speaker_id,
                Speaker.participant_id.label("speaker_participant_id"),
                Speaker.is_facilitator,
                Document.participant_id.label("document_participant_id"),
                Segment.merged_into_id,
                Segment.split_into_id,
            )
            .outerjoin(Speaker, Speaker.id == Segment.speaker_id)
        )
        # The three-parent outerjoin AND the project filter, from the one place
        # that scope lives (D18's cleaner scope — every parent, no eligibility
        # clause: resolution is not consensus).
        query = project_scoped_segments(query, project_id)
        for row in query.filter(Segment.id.in_(chunk)).all():
            segments[row.segment_id] = _segment_route(
                conversation_id=row.conversation_id,
                document_id=row.document_id,
                observation_id=row.observation_id,
                speaker_id=row.speaker_id,
                speaker_participant_id=row.speaker_participant_id,
                is_facilitator=row.is_facilitator,
                document_participant_id=row.document_participant_id,
                visible=row.merged_into_id is None and row.split_into_id is None,
            )

    dataset_values: dict[int, ParticipantRoute] = {}
    for chunk in _chunks(value_ids):
        rows = (
            db.query(DatasetValue.id, DatasetRow.participant_id)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .join(Dataset, DatasetRow.dataset_id == Dataset.id)
            .filter(Dataset.project_id == project_id, DatasetValue.id.in_(chunk))
            .all()
        )
        for value_id, participant_id in rows:
            dataset_values[value_id] = ParticipantRoute(
                participant_id=participant_id,
                route=ROUTE_DATASET_ROW,
                unresolved_reason=(
                    None if participant_id is not None else UNRESOLVED_ROW_UNLINKED
                ),
                # A DatasetValue has no soft-delete: nothing hides one but
                # deleting it, which removes the coding too.
                target_visible=True,
            )

    return ParticipantResolution(segments=segments, dataset_values=dataset_values)


def resolve_for_applications(
    db: Session,
    project_id: int,
    applications: Iterable[object],
) -> ParticipantResolution:
    """`resolve_participants` for a batch of `CodeApplication`-shaped rows.

    Takes anything carrying ``segment_id`` and ``dataset_value_id`` — ORM
    instances or the labelled `Row`s of a column query — because the rating
    consumers hold one or the other and the XOR split is the same either way.
    """
    seg_ids: set[int] = set()
    value_ids: set[int] = set()
    for application in applications:
        segment_id = getattr(application, "segment_id", None)
        dataset_value_id = getattr(application, "dataset_value_id", None)
        if segment_id is not None:
            seg_ids.add(segment_id)
        elif dataset_value_id is not None:
            value_ids.add(dataset_value_id)
    return resolve_participants(
        db, project_id, segment_ids=seg_ids, dataset_value_ids=value_ids
    )
