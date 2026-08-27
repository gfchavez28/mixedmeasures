"""What a participant's data actually touches — the withdrawal report (#702(2)).

## Why a report before a delete

Deleting a `Participant` removes exactly one row. Both links to it are
`ondelete="SET NULL"`, so the transcript survives verbatim, `Speaker.name` still
carries the identifying name, and the survey responses survive unlinked. That is
the identity spine working as designed — Participant and Speaker are deliberately
project-scoped and outlive their sources.

🔴 **The consequence nobody guesses, and the reason this exists: deleting the
participant record FIRST makes a withdrawal HARDER**, because it destroys the
link you would use to find everything else. So the honest first tool is not a
delete — it is the thing that answers *"what would I have to remove?"* while the
link still exists. Read-only, auditable, and it cannot destroy anything.

⛔ This does not delete, redact or change anything, and the orphaning default is
unchanged. It is a code-level report about reachability, **not legal advice** — a
compliance reviewer owns the conclusion.

## What is reachable, and how that set was derived

Not hand-listed. Walked from the schema: two FKs name `participants.id`
(`Speaker.participant_id`, `DatasetRow.participant_id`), and each hop below is
every model that names the previous hop's table:

    Participant
      ├── Speaker ─── Segment (speaker_id) ─── CodeApplication · Excerpt · Note
      └── DatasetRow ┬─ DatasetValue (row_id) ─ CodeApplication · Excerpt · Note
                     ├─ RowScore (dataset_row_id)
                     └─ Memo (entity_type='dataset_row')

⚠️ **`Speaker` is PROJECT-scoped, not conversation-scoped** — one speaker row
spans every conversation the person appears in. So the conversation breakdown is
derived from the SEGMENTS (which carry `conversation_id`), never from the
speaker, and the identifying `speaker_names` are reported once at the top as the
project-level fact they are. A speaker row with no segments still appears there:
the NAME is identifying data that survives the delete even when the person never
got a turn.

⚠️ **`ConsensusStaleTarget` also references both `segments.id` and
`dataset_values.id` and is deliberately EXCLUDED** — it is a recompute marker,
not anything the participant said or answered. A report padded with internal
bookkeeping is harder to act on, not more complete.

⚠️ **Segments are NOT filtered by `visible_segment_filter`.** A merged or split
segment still holds the participant's words, so counting only visible rows would
UNDER-report — and on a withdrawal report under-reporting is the direction that
matters. The number may therefore exceed what the workbench shows.

⚠️ **`Memo` carries no ForeignKey**, so its reachable arm is found by
`entity_type`, and the type vocabulary is declared in exactly two places that
must agree: `schemas/memo.py`'s regex and `project_portability.MEMO_ENTITY_REMAP`.
Both list `dataset_row` and NEITHER lists `segment` or `participant` — so a
memo cannot hang off a transcript turn or off the participant itself, and the
dataset-row arm below is the whole memo story. If `segment` ever becomes
memo-able, this report gains an arm.

## What it deliberately does NOT include

**The text itself.** No transcript lines, no response values, no quote bodies —
only counts and the sources they live in. A report that reproduced the content
would be one more copy of the data a researcher is trying to remove, stored in
one more place.
"""

from dataclasses import dataclass, asdict, field

from sqlalchemy.orm import Session

from ..models.participant import Participant
from ..models.speaker import Speaker
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetRow, DatasetValue
from ..models.code_application import CodeApplication
from ..models.excerpt import Excerpt
from ..models.note import Note
from ..models.memo import Memo
from ..models.row_score import RowScore


@dataclass
class ConversationTouchpoint:
    """One conversation this participant speaks in."""

    conversation_id: int
    name: str
    segments: int = 0
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0


@dataclass
class DatasetTouchpoint:
    """One dataset this participant has a row in."""

    dataset_id: int
    name: str
    rows: int = 0
    responses: int = 0
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0
    memos: int = 0
    row_scores: int = 0


@dataclass
class WithdrawalReport:
    participant_id: int
    identifier: str
    display_name: str | None
    role: str | None
    has_demographics: bool
    # The identifying name(s) the transcripts carry for this person. Project-
    # scoped like `Speaker` itself, and the field that SURVIVES the delete —
    # which is exactly why a withdrawal report has to name it.
    speaker_names: list[str]
    conversations: list[ConversationTouchpoint]
    datasets: list[DatasetTouchpoint]

    @property
    def total_items(self) -> int:
        """Everything the report counts, for a one-line headline.

        Deliberately includes the participant record itself: "9 items" that
        silently omitted the row being deleted would misstate the very action
        the reader is about to take.
        """
        return 1 + sum(
            c.segments + c.code_applications + c.excerpts + c.notes
            for c in self.conversations
        ) + sum(
            d.rows + d.responses + d.code_applications + d.excerpts
            + d.notes + d.memos + d.row_scores
            for d in self.datasets
        )

    def to_dict(self) -> dict:
        out = asdict(self)
        out["total_items"] = self.total_items
        return out


def _count(db: Session, model, column, ids: list[int]) -> int:
    if not ids:
        return 0
    return db.query(model).filter(column.in_(ids)).count()


def build_withdrawal_report(
    db: Session, participant: Participant,
) -> WithdrawalReport:
    """Everything in this project that traces back to `participant`.

    Counts only — see the module docstring for what is deliberately excluded and
    why the segment count is unfiltered.
    """
    # ── The conversation side, via Speaker ────────────────────────────────
    #
    # `Speaker` is PROJECT-scoped, so it cannot tell us WHICH conversations the
    # person appears in — only the segments can. The names are collected here
    # as the project-level fact they are.
    speakers = (
        db.query(Speaker)
        .filter(Speaker.participant_id == participant.id)
        .all()
    )
    speaker_names: list[str] = []
    for sp in speakers:
        # One person can hold several speaker rows (a re-import, a mis-split
        # later linked to the same participant), each with its own spelling —
        # every one of them identifies.
        if sp.name not in speaker_names:
            speaker_names.append(sp.name)

    conversations: dict[int, ConversationTouchpoint] = {}
    speaker_ids = [sp.id for sp in speakers]
    if speaker_ids:
        segments = (
            db.query(Segment.id, Segment.conversation_id)
            .filter(Segment.speaker_id.in_(speaker_ids))
            .all()
        )
        by_conv: dict[int, list[int]] = {}
        for seg_id, conv_id in segments:
            # Only conversation segments carry a speaker (document and
            # observation segments have none), but the report's job is to find
            # data — so a parentless one is skipped rather than crashing here.
            if conv_id is None:
                continue
            by_conv.setdefault(conv_id, []).append(seg_id)

        for conv_id, seg_ids in by_conv.items():
            conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
            tp = ConversationTouchpoint(
                conversation_id=conv_id,
                name=conv.name if conv else "(unknown)",
                segments=len(seg_ids),
            )
            tp.code_applications = _count(
                db, CodeApplication, CodeApplication.segment_id, seg_ids)
            tp.excerpts = _count(db, Excerpt, Excerpt.segment_id, seg_ids)
            tp.notes = _count(db, Note, Note.segment_id, seg_ids)
            conversations[conv_id] = tp

    # ── The dataset side, via DatasetRow ──────────────────────────────────
    rows = (
        db.query(DatasetRow)
        .filter(DatasetRow.participant_id == participant.id)
        .all()
    )
    datasets: dict[int, DatasetTouchpoint] = {}
    rows_by_dataset: dict[int, list[int]] = {}
    for r in rows:
        rows_by_dataset.setdefault(r.dataset_id, []).append(r.id)

    for ds_id, row_ids in rows_by_dataset.items():
        ds = db.query(Dataset).filter(Dataset.id == ds_id).first()
        tp = DatasetTouchpoint(
            dataset_id=ds_id, name=ds.name if ds else "(unknown)", rows=len(row_ids),
        )
        value_ids = [
            v[0] for v in
            db.query(DatasetValue.id).filter(DatasetValue.row_id.in_(row_ids)).all()
        ]
        tp.responses = len(value_ids)
        tp.code_applications = _count(
            db, CodeApplication, CodeApplication.dataset_value_id, value_ids)
        tp.excerpts = _count(db, Excerpt, Excerpt.dataset_value_id, value_ids)
        tp.notes = _count(db, Note, Note.dataset_value_id, value_ids)
        tp.row_scores = _count(db, RowScore, RowScore.dataset_row_id, row_ids)
        tp.memos = (
            db.query(Memo)
            .filter(Memo.entity_type == "dataset_row", Memo.entity_id.in_(row_ids))
            .count()
        )
        datasets[ds_id] = tp

    return WithdrawalReport(
        participant_id=participant.id,
        identifier=participant.identifier,
        display_name=participant.display_name,
        role=participant.role,
        has_demographics=bool(participant.demographics),
        speaker_names=speaker_names,
        conversations=sorted(conversations.values(), key=lambda c: c.conversation_id),
        datasets=sorted(datasets.values(), key=lambda d: d.dataset_id),
    )
