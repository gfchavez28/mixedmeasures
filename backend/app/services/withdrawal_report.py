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

Walked from the schema: **three** FKs name `participants.id`
(`Speaker.participant_id`, `DatasetRow.participant_id`, and — since row 46 —
`Document.participant_id`), and each hop below is every model that names the
previous hop's table:

    Participant
      ├── Speaker ─── Segment (speaker_id) ─── CodeApplication · Excerpt · Note
      ├── DatasetRow ┬─ DatasetValue (row_id) ─ CodeApplication · Excerpt · Note
      │              ├─ RowScore (dataset_row_id)
      │              └─ Memo (entity_type='dataset_row')
      └── Document ── Segment (document_id) ─── CodeApplication · Excerpt · Note

🔴 **That sentence used to say "two", and nothing would have caught it turning
false.** The set was walked once, by hand, and the walk left no artifact — so
the docstring was a COUNT maintained by memory, on a report whose whole job is
completeness. `tests/test_withdrawal_report.py::TestEveryParticipantFkHasAnArm`
now reflects over the SQLAlchemy metadata for every column pointing at
`participants.id` and fails when one has no arm here. **A fourth FK is a failing
test, not a silent under-report.**

⚠️ **The document arm's grain differs from the other two:** `Speaker` and
`DatasetRow` are per-turn and per-row children, so the participant reaches only
PART of a conversation or dataset; `Document.participant_id` sits on the source
itself, so the whole document is in scope.

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

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.participant import Participant
from ..models.speaker import Speaker
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.code_application import CodeApplication
from ..models.excerpt import Excerpt
from ..models.note import Note
from ..models.memo import Memo
from ..models.row_score import RowScore
from .participant_dataset import MANAGED_COLUMN_SOURCE


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
    #: Cells this person ANSWERED. #896 — it excludes the tool's own columns,
    #: because a derived rating score is not a response and a researcher reading
    #: *"1 record, 3 responses"* on a participant table would be told this person
    #: answered three questions they were never asked.
    responses: int = 0
    #: Cells the TOOL maintains here (the identifier it wrote, the scores it
    #: derived). Counted and reported separately rather than dropped: the row
    #: genuinely traces back to this person and a withdrawal must account for it.
    #: ⚠️ Excluding managed datasets from the report entirely was considered and
    #: REFUSED — under-reporting is the failure that matters here.
    tool_maintained_values: int = 0
    #: The kind of spine this dataset projects (`Dataset.managed_kind`), or None
    #: for an ordinary one — so the report can SAY what the record is instead of
    #: showing a bare row count with no explanation.
    managed_kind: str | None = None
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0
    memos: int = 0
    row_scores: int = 0


@dataclass
class DocumentTouchpoint:
    """One document this participant is the subject of (row 46).

    Unlike the two touchpoints above, the link is on the SOURCE itself rather
    than on a per-turn or per-row child, so the whole document is in scope: a
    workplan filed under this person is theirs end to end.
    """

    document_id: int
    name: str
    segments: int = 0
    code_applications: int = 0
    excerpts: int = 0
    notes: int = 0


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
    documents: list[DocumentTouchpoint] = field(default_factory=list)

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
        ) + sum(
            doc.segments + doc.code_applications + doc.excerpts + doc.notes
            for doc in self.documents
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
        # #896 — split the cells by who wrote them. `source == "managed"` is
        # the tool's own; everything else is the researcher's data, which is
        # what "responses" has always meant on an ordinary dataset (where the
        # managed set is empty and this is byte-identical to the old count).
        tp.managed_kind = ds.managed_kind if ds else None
        managed_column_ids = {
            c[0] for c in
            db.query(DatasetColumn.id).filter(
                DatasetColumn.dataset_id == ds_id,
                DatasetColumn.source == MANAGED_COLUMN_SOURCE,
            ).all()
        }
        if managed_column_ids:
            managed_values = (
                db.query(func.count(DatasetValue.id))
                .filter(
                    DatasetValue.row_id.in_(row_ids),
                    DatasetValue.column_id.in_(managed_column_ids),
                )
                .scalar()
            ) or 0
        else:
            managed_values = 0
        tp.tool_maintained_values = managed_values
        tp.responses = len(value_ids) - managed_values
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

    # ── The document side, via Document.participant_id (row 46) ───────────
    #
    # The third FK naming `participants.id`, and the only one where the link
    # sits on the SOURCE. No speaker hop and no row hop: the document's own
    # segments are the unit, counted with the same unfiltered rule as the
    # conversation arm (a merged/split-away segment still holds the words).
    documents: list[DocumentTouchpoint] = []
    linked_docs = (
        db.query(Document)
        .filter(Document.participant_id == participant.id)
        .all()
    )
    for doc in linked_docs:
        seg_ids = [
            s[0] for s in
            db.query(Segment.id).filter(Segment.document_id == doc.id).all()
        ]
        tp = DocumentTouchpoint(
            document_id=doc.id, name=doc.name, segments=len(seg_ids),
        )
        tp.code_applications = _count(
            db, CodeApplication, CodeApplication.segment_id, seg_ids)
        tp.excerpts = _count(db, Excerpt, Excerpt.segment_id, seg_ids)
        tp.notes = _count(db, Note, Note.segment_id, seg_ids)
        documents.append(tp)

    return WithdrawalReport(
        participant_id=participant.id,
        identifier=participant.identifier,
        display_name=participant.display_name,
        role=participant.role,
        has_demographics=bool(participant.demographics),
        speaker_names=speaker_names,
        conversations=sorted(conversations.values(), key=lambda c: c.conversation_id),
        datasets=sorted(datasets.values(), key=lambda d: d.dataset_id),
        documents=sorted(documents, key=lambda d: d.document_id),
    )
