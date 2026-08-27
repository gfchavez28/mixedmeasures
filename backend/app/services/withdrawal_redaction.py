"""Honour a withdrawal — remove the person, keep everyone else's data (#702(3)).

## The decision this implements

Developer, 2026-08-22, after weighing three options: **remove the identity, delete
what is unambiguously theirs, and BLANK — not delete — their turns in shared
conversations.** Blanking was judged sufficient for now: *"Only time and some
actual experiences of this will tell otherwise."* So the destructive reach is
deliberately conservative and the design leaves room to go further later.

## Why the two sides are treated differently

A survey response has exactly one author, so it is deleted outright.

A conversation TURN is the only place where one person's data and another's
occupy the same structure: the turns either side of it belong to participants who
did not withdraw, and they stop making sense if it disappears. Deleting it would
damage those people's records to honour this person's request, and it would
silently move every coverage and reliability figure in the project. So the words
go and the turn stays as an empty placeholder.

## What each thing on a blanked turn does, and why

| Thing | Action | Why |
|---|---|---|
| `Segment.text` | blanked, `word_count` → 0 | their words; the count must move with the text or density silently keeps counting them |
| `Excerpt` | DELETED | a quote is a POINTER INTO the text — after blanking its offsets address nothing, and a quote of removed words is exactly what a withdrawal is about |
| `CodeApplication` | KEPT | the researcher's analysis, not the participant's personal data — and deleting it would silently change every κ/α figure other coders' work feeds |
| `Note` / `Memo` | KEPT and REPORTED | researcher-authored prose that may QUOTE the person; a machine cannot judge that, so it is surfaced for human review rather than guessed at |

⚠️ **The speaker row survives, renamed.** Deleting it would orphan the turns and
lose the turn-taking structure that makes a transcript readable. It is renamed to
a numbered token so that two people withdrawing from the SAME conversation stay
distinguishable as two speakers — anonymity does not require pretending several
people were one, and collapsing them would corrupt the discourse structure.

## ⛔ What this deliberately does NOT claim to do

It cannot find the person's name inside OTHER people's turns, or inside free-text
answers, notes or memos. That is reading, by someone who knows the project. The
confirmation UI must say so — a researcher who believes this button completed a
withdrawal, while the name sits three turns later, is worse off than with no
feature at all.
"""

from dataclasses import dataclass, asdict

from sqlalchemy.orm import Session

from ..models.participant import Participant
from ..models.speaker import Speaker
from ..models.segment import Segment
from ..models.dataset import DatasetRow, DatasetValue
from ..models.excerpt import Excerpt
from ..models.note import Note
from ..models.memo import Memo
from ..models.row_score import RowScore
from ..models.code_application import CodeApplication
from .withdrawal_report import build_withdrawal_report


#: What a redacted speaker is called. Numbered per project so two withdrawals
#: from one conversation remain two speakers.
WITHDRAWN_SPEAKER_PREFIX = "Withdrawn participant"

#: What replaces a blanked turn. Deliberately NOT an empty string: an empty turn
#: reads as a rendering bug, and a reader of the transcript is entitled to know
#: that something stood here and why it is gone.
BLANKED_SEGMENT_TEXT = "[Removed at the participant's request]"


@dataclass
class RedactionOutcome:
    """What was actually done. Stored in the audit entry as the record."""

    participant_id: int
    identifier: str
    speaker_label: str | None
    segments_blanked: int
    excerpts_deleted: int
    dataset_rows_deleted: int
    responses_deleted: int
    row_scores_deleted: int
    #: KEPT, and reported so a human can review them for quoted content.
    code_applications_kept: int
    notes_for_review: int
    memos_for_review: int

    def to_dict(self) -> dict:
        return asdict(self)


def _next_withdrawn_label(db: Session, project_id: int) -> str:
    """`Withdrawn participant 1`, `2`, … within one project.

    Counts existing tokens rather than tracking a counter: the label only has to
    be unique and non-identifying, and a column would be one more thing to keep
    in step with a value that is already visible in the data.
    """
    existing = (
        db.query(Speaker)
        .filter(
            Speaker.project_id == project_id,
            Speaker.name.like(f"{WITHDRAWN_SPEAKER_PREFIX}%"),
        )
        .count()
    )
    return f"{WITHDRAWN_SPEAKER_PREFIX} {existing + 1}"


def apply_withdrawal(
    db: Session, participant: Participant, *, blank_turns: bool = True,
) -> RedactionOutcome:
    """Remove this participant, preserving every other participant's data.

    ⚠️ **The reachable set comes from `build_withdrawal_report`**, not from a
    second walk. Two enumerations of "what traces back to this person" is the
    copies-propagate shape with DATA LOSS as the failure mode — one of them
    drifts, and the one that under-reports is the one that leaves personal data
    behind while telling the researcher it is gone.

    ⚠️ Not committed here. The caller owns the transaction so the forced backup,
    the redaction and the audit entry succeed or fail together.
    """
    project_id = participant.project_id
    report = build_withdrawal_report(db, participant)

    speakers = (
        db.query(Speaker).filter(Speaker.participant_id == participant.id).all()
    )
    speaker_ids = [s.id for s in speakers]

    # ── The conversation side: blank the words, keep the structure ─────────
    segments_blanked = 0
    excerpts_deleted = 0
    notes_for_review = 0
    code_applications_kept = 0

    if speaker_ids:
        segments = (
            db.query(Segment).filter(Segment.speaker_id.in_(speaker_ids)).all()
        )
        seg_ids = [s.id for s in segments]

        if seg_ids:
            code_applications_kept = (
                db.query(CodeApplication)
                .filter(CodeApplication.segment_id.in_(seg_ids))
                .count()
            )
            notes_for_review = (
                db.query(Note).filter(Note.segment_id.in_(seg_ids)).count()
            )
            # Excerpts are POINTERS INTO the text. After blanking, their offsets
            # address nothing — and a quote of removed words is precisely what a
            # withdrawal asks to be gone.
            excerpts_deleted = (
                db.query(Excerpt)
                .filter(Excerpt.segment_id.in_(seg_ids))
                .delete(synchronize_session=False)
            )

        if blank_turns:
            for seg in segments:
                seg.text = BLANKED_SEGMENT_TEXT
                # The count must move WITH the text. Leaving it would keep the
                # person's words in every density and volume figure while the
                # words themselves are gone (#703's unit is whitespace tokens).
                seg.word_count = 0
                segments_blanked += 1

    # ── The identity: the speaker row survives, renamed ───────────────────
    speaker_label = None
    for sp in speakers:
        speaker_label = _next_withdrawn_label(db, project_id)
        sp.name = speaker_label
        sp.original_label = None
        sp.participant_id = None
        db.flush()  # so the next label's count sees this one

    # ── The dataset side: theirs alone, so it goes ────────────────────────
    rows = (
        db.query(DatasetRow).filter(DatasetRow.participant_id == participant.id).all()
    )
    row_ids = [r.id for r in rows]
    responses_deleted = 0
    row_scores_deleted = 0
    memos_for_review = 0

    if row_ids:
        value_ids = [
            v[0] for v in
            db.query(DatasetValue.id).filter(DatasetValue.row_id.in_(row_ids)).all()
        ]
        memos_for_review = (
            db.query(Memo)
            .filter(Memo.entity_type == "dataset_row", Memo.entity_id.in_(row_ids))
            .count()
        )
        if value_ids:
            # Delete what hangs off the responses BEFORE the responses, so no FK
            # is left addressing a row that is going away in the same flush.
            db.query(Excerpt).filter(
                Excerpt.dataset_value_id.in_(value_ids)
            ).delete(synchronize_session=False)
            db.query(Note).filter(
                Note.dataset_value_id.in_(value_ids)
            ).delete(synchronize_session=False)
            db.query(CodeApplication).filter(
                CodeApplication.dataset_value_id.in_(value_ids)
            ).delete(synchronize_session=False)
            responses_deleted = (
                db.query(DatasetValue)
                .filter(DatasetValue.id.in_(value_ids))
                .delete(synchronize_session=False)
            )
        row_scores_deleted = (
            db.query(RowScore)
            .filter(RowScore.dataset_row_id.in_(row_ids))
            .delete(synchronize_session=False)
        )
        db.flush()
        db.query(DatasetRow).filter(DatasetRow.id.in_(row_ids)).delete(
            synchronize_session=False
        )

    outcome = RedactionOutcome(
        participant_id=participant.id,
        identifier=report.identifier,
        speaker_label=speaker_label,
        segments_blanked=segments_blanked,
        excerpts_deleted=excerpts_deleted,
        dataset_rows_deleted=len(row_ids),
        responses_deleted=responses_deleted,
        row_scores_deleted=row_scores_deleted,
        code_applications_kept=code_applications_kept,
        notes_for_review=notes_for_review,
        memos_for_review=memos_for_review,
    )

    # ⚠️ Last, and after a flush: the participant row is what every lookup above
    # keys on. Deleting it earlier would leave the rest of this function walking
    # a link that no longer exists — the same "delete destroys the link you need"
    # trap the withdrawal REPORT exists to warn about.
    db.flush()
    db.delete(participant)

    return outcome
