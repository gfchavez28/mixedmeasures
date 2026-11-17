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

## What each thing a withdrawal reaches does, and why

The turns are `withdrawal_report.reached_turns` — their speaker's turns AND every
turn their words reached through a merge or a split (#1320). The report counts
that one walk and this function acts on it, so the two cannot disagree.

| Thing | Action | Why |
|---|---|---|
| `Segment.text` of their own turns | blanked, `word_count` → 0 | their words; the count must move with the text or density silently keeps counting them |
| a MERGED or SPLIT turn holding their words (#1320) | blanked WHOLE, counted as `combined_turns_blanked` | decision D7: the other speaker loses nothing — their own original turn is kept hidden (`merged_into_id`) and Unmerge brings it back |
| `Segment.original_speaker_label` | cleared on their turns, and on a combined turn where it is one of their labels or names | a merge copies the FIRST turn's label (`segment_operations.py:330`), a split the original's |
| a combined speaker ("Maria & Sam") | renamed from the turns' history ("Withdrawn participant 3 & Sam"), or re-pointed to a row already called that; an unreferenced one naming them is deleted | its name is their name, on no participant link |
| `Excerpt` on any reached turn or response | DELETED | a quote is a POINTER INTO the text — after blanking its offsets address nothing, and a quote of removed words is exactly what a withdrawal is about |
| a canvas copy of such a quote | rewritten: embed text blanked, its link cleared, in themes AND snapshots; inbox items deleted (`canvas_embed_scrub`) | an embed is a snapshot of the words, not a pointer |
| a canvas quote whose source is GONE — a turn's whose conversation no longer exists, or an answer's or document's matching none of their answers' wordings (#1546 D158) | LEFT, and counted (`canvas_quotes_unplaced`); the report names its sections and snapshots before the act | an embed names no speaker, so nothing says whose words it holds; matching it against their turns everywhere would take another person's short quote (#1547's harm) |
| a merge result or split child their words passed through that an Unmerge or Unsplit DELETED (#1473 b) | found from the audit trail (`withdrawal_history.deleted_lineage`, each id read as one LIFETIME — SQLite reuses ids): its entries are redacted as below, and a canvas quote across its join is rewritten as above | the row is gone, so no link reaches it; the edit's entry kept their words and the embed's words sat inside neither original turn |
| `CodeApplication` on any reached TURN | KEPT | the researcher's analysis, not the participant's personal data — and deleting it would silently change every κ/α figure other coders' work feeds |
| `Note` on their turns, `Memo` on their records | KEPT and REPORTED | researcher-authored prose that may QUOTE the person; a machine cannot judge that, so it is surfaced for human review rather than guessed at |
| `Note` and `CodeApplication` on their ANSWERS | DELETED and counted (`notes_deleted`, `code_applications_deleted`, #1473) | they hang off the answer, which is deleted — a note's only parent is it — so the confirm lists them as removed, not kept |
| audit `details` of every entry keyed on their record, speakers, reached turns, rows, responses or quotes — a turn's and an answer's only within its OWN lifetime (#1547 D159: `withdrawal_history.history_starts`; an answer's entry naming another column) | every string nulled, `"redacted": "withdrawal"` added, the entry kept (D9) | the trail keeps that something happened; the Excel Audit Trail exported their words. SQLite reuses ids, so an entry from before the row existed is a previous holder's — redacting it took someone else's history, and its words took another participant's orphan quote |
| an edit's wording in a source deleted BEFORE the withdrawal | already stripped by that delete (#1546 D157, `services/deleted_source_audit.py`) | nothing links a deleted source to the person any more, so the withdrawal could not find it; the delete can |
| the `withdrawn` entry | written AFTER that pass by the endpoint, and keeps the identifier (D9) | it is the record that the request was honoured |
| a `removal_tombstones` row per removed or blanked thing, and their identifier as a HASH (#1190) | WRITTEN under the project's uuid, no foreign key (decision D8), and carried in every later `.mmproject` | a merge of an older copy, an import, a link or a typed create must not bring them back (`services/tombstones.py`); the hash is not anonymisation — a guessed identifier confirms against it |

On the dataset side their responses and rows are DELETED, and every saved metric on
a dataset that lost a row is marked out of date (#1144): a computed result is a copy
of what it was computed from, and quick compute reuses one that is not stale. Since
#1320 the stored results of every metric that mark reaches are DELETED too (D10) —
a stale frequency still listed their unique answer, in the Datasets Excel and the
`.mmproject`. Quick compute recomputes a stale metric before it shows one.

⚠️ **A linked DOCUMENT (row 46) is UNLINKED and REPORTED — a third treatment,
and it needed one.** The dataset rule ("theirs alone, so it goes") does not
transfer: `Document.participant_id` says the document is *about* this person,
which is true both of a workplan they wrote and of a policy document that merely
names them, and the two are indistinguishable to the tool. Deleting is
unrecoverable and would destroy someone else's work in the second case; blanking
leaves a shell that still counts in coverage. Removing the LINK removes the
identifying association, and the count goes to the researcher to finish.

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

It does not edit RECORDINGS (their voice stays in the audio or video), and a
blanked turn keeps its timestamps (D11), which point into that recording. It does
not reach BACKUPS, safety copies or files already exported. All of that is
disclosed in the confirm, the done note and the report (D12) — not done.

## ⛔ It fails CLOSED

Nothing here swallows an error to carry on: a copy it cannot read (a canvas
section, a snapshot) raises, and the endpoint rolls the whole withdrawal back after
its backup. An incomplete removal reported as complete is the failure that matters.
"""

import re
from dataclasses import dataclass, asdict

from sqlalchemy.orm import Session

from ..models.audit import AuditEntry
from ..models.participant import Participant
from ..models.speaker import Speaker
from ..models.segment import Segment
from ..models.document import Document
from ..models.dataset import DatasetColumn, DatasetRow, DatasetValue
from ..models.excerpt import Excerpt
from ..models.metric import ComputedResult, MetricDefinition
from ..models.note import Note
from ..models.memo import Memo
from ..models.row_score import RowScore
from ..models.code_application import CodeApplication
from .audit import stripped_details
from .canvas_embed_scrub import (
    ACT_WITHDRAWAL,
    UnplacedCanvasQuotes,
    scrub_excerpt_embeds,
    scrub_misfit_cases,
    unplaced_canvas_quotes,
)
from .deleted_source_audit import column_named_in
from . import tombstones as tomb
from ..models.project import Project
from .staleness import mark_metrics_stale
from .withdrawal_history import deleted_lineage, history_starts, segment_history, wording_in
from .withdrawal_report import build_withdrawal_report, reached_turns


#: What a redacted speaker is called. Numbered per project so two withdrawals
#: from one conversation remain two speakers.
WITHDRAWN_SPEAKER_PREFIX = "Withdrawn participant"
_WITHDRAWN_LABEL = re.compile(rf"^{re.escape(WITHDRAWN_SPEAKER_PREFIX)} (\d+)$")

#: What replaces a blanked turn. Deliberately NOT an empty string: an empty turn
#: reads as a rendering bug, and a reader of the transcript is entitled to know
#: that something stood here and why it is gone.
BLANKED_SEGMENT_TEXT = "[Removed at the participant's request]"

#: The marker an audit entry carries once its details were stripped (D9).
AUDIT_REDACTION_MARK = "withdrawal"

#: The audit entity types keyed on what a withdrawal removes. Entries are chosen by
#: ENTITY, never by action: a new action logged on one of these entities is
#: redacted without anyone remembering to list it.
AUDIT_ENTITY_PARTICIPANT = "participant"
AUDIT_ENTITY_SPEAKER = "speaker"
AUDIT_ENTITY_SEGMENT = "segment"
AUDIT_ENTITY_EXCERPT = "excerpt"
AUDIT_ENTITY_VALUE = "dataset_value"
AUDIT_ENTITY_ROW = "dataset_row"

#: The one action never stripped, by decision D9: the `withdrawn` entry is the
#: record that a request was honoured. (With SQLite's id reuse an EARLIER person's
#: entry can carry this participant's id; it keeps their identifier too.)
AUDIT_KEPT_ACTIONS = frozenset({"withdrawn"})

#: SQLite's bound-parameter ceiling is far above any one person's rows; chunk
#: anyway so an id list never meets it (#842).
_IN_CHUNK = 5000


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
    #: Row 46 — documents whose subject link was removed. The documents SURVIVE
    #: intact; this is the count a researcher has to look at by hand, because
    #: "this document is about them" and "this document is theirs" are not the
    #: same claim and only a person can tell which one applied.
    documents_unlinked: int = 0
    #: #1320 — turns their words reached through a merge or a split, blanked whole.
    combined_turns_blanked: int = 0
    #: #1320 — combined speakers ("Maria & Sam") renamed or re-pointed, and the
    #: unreferenced ones naming them that were deleted.
    combined_speakers_renamed: int = 0
    #: #1320 — canvas copies of their quotes: embeds rewritten (themes and
    #: snapshots), snapshots rewritten, inbox items removed (live and in snapshots).
    canvas_embeds_scrubbed: int = 0
    canvas_snapshots_rewritten: int = 0
    canvas_inbox_items_removed: int = 0
    #: #1320 (D10) — stored results of the metrics the withdrawal marks stale.
    computed_results_deleted: int = 0
    #: #1320 (D9) — audit entries whose details were stripped (entries kept).
    audit_entries_redacted: int = 0
    #: #1473 — the researcher's notes and the codings on their ANSWERS. Unlike a
    #: turn's, these are DELETED with the answer they hang off, so they are not
    #: "for review" and `code_applications_kept` / `notes_for_review` do not hold them.
    notes_deleted: int = 0
    code_applications_deleted: int = 0
    #: #1546 (D158) — canvas quotes LEFT because nothing says whose words they hold
    #: (their source is gone): themes and snapshot copies. The report counted them,
    #: with their sections, before the act (`canvas_embed_scrub.unplaced_canvas_quotes`).
    canvas_quotes_unplaced: int = 0
    #: Joint display slice 2 (r3-6) — picked "cases that don't fit" naming them, removed
    #: with the researcher's reason (sections and snapshot copies together).
    canvas_misfit_cases_removed: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def _chunks(ids):
    ids = sorted(ids)
    for i in range(0, len(ids), _IN_CHUNK):
        yield ids[i:i + _IN_CHUNK]


def _next_withdrawn_label(db: Session, project_id: int) -> str:
    """`Withdrawn participant 1`, `2`, … within one project.

    One past the largest number in use rather than a count: since #1320 a combined
    speaker can be called "Withdrawn participant 1 & Sam", which a `LIKE` count read
    as a second token, and a count re-issues a number once a token is gone. The
    label only has to be unique and non-identifying.
    """
    used = [
        int(m.group(1))
        for (name,) in db.query(Speaker.name).filter(
            Speaker.project_id == project_id,
            Speaker.name.like(f"{WITHDRAWN_SPEAKER_PREFIX} %"),
        )
        if name and (m := _WITHDRAWN_LABEL.match(name))
    ]
    return f"{WITHDRAWN_SPEAKER_PREFIX} {max(used, default=0) + 1}"


def combined_speaker_name(names: list[str]) -> str:
    """The name a merge gives a turn spoken by several people.

    ⚠️ The same rule as `segment_operations._build_combined_speaker`, which builds it
    inline; `test_withdrawal_census.py` pins the two to one answer, so a change to
    the merge's naming fails there rather than leaving a recomposed name that no
    later merge would find.
    """
    if len(names) == 2:
        return f"{names[0]} & {names[1]}"
    return ", ".join(names[:-1]) + f", & {names[-1]}"


def _name_parts(name: str) -> list[str]:
    """`combined_speaker_name` read backwards — best effort, for a name with no
    turns left to read its history from."""
    if ", & " in name:
        head, last = name.rsplit(", & ", 1)
        return head.split(", ") + [last]
    if " & " in name:
        return name.rsplit(" & ", 1)
    return [name]


def _history_speakers(db: Session, turns: list[Segment]) -> list[int] | None:
    """The speakers a combined speaker was composed of, from a turn's history.

    A merge result's originals (`merged_into_id`), or the originals of a split
    across several turns (`split_into_id` → the first child, at most two ids
    below). Unique, in turn order — `_build_combined_speaker`'s order. None when no
    turn here records two or more speakers.
    """
    for turn in turns:
        originals: list = []
        if turn.is_merge_result:
            originals = (
                db.query(Segment.speaker_id)
                .filter(Segment.merged_into_id == turn.id)
                .order_by(Segment.sequence_order).all()
            )
        elif turn.is_split_result:
            for k in range(3):
                originals = (
                    db.query(Segment.speaker_id)
                    .filter(Segment.split_into_id == turn.id - k)
                    .order_by(Segment.sequence_order).all()
                )
                if originals:
                    break
        seen: list[int] = []
        for (sp_id,) in originals:
            if sp_id is not None and sp_id not in seen:
                seen.append(sp_id)
        if len(seen) >= 2:
            return seen
    return None


def _recompose_combined_speakers(
    db: Session, project_id: int, combined: list[Segment], her_speaker_ids: set[int],
    her_names: set[str], new_label: str | None,
) -> list[int]:
    """Rename every combined speaker on a reached turn; return the old rows' ids.

    Recomposed from the turns' HISTORY with the components' current names (their
    speakers are already renamed), so a nested merge ("Maria & Sam" merged with
    "Kai") is done inner first: speakers are taken in the order of the earliest
    turn using them, and a merge result is always newer than its originals. A name
    already in use is a row a later merge would find by name
    (`_build_combined_speaker`), so the turns are re-pointed to it and the old row
    deleted; otherwise the row is renamed where it stands (it keeps its colour).
    """
    by_speaker: dict[int, list[Segment]] = {}
    for turn in sorted(combined, key=lambda s: s.id):
        if turn.speaker_id is None or turn.speaker_id in her_speaker_ids:
            continue
        by_speaker.setdefault(turn.speaker_id, []).append(turn)

    touched: list[int] = []
    moved: dict[int, int] = {}  # a row re-pointed to its twin → the twin
    for sp_id in sorted(by_speaker, key=lambda s: by_speaker[s][0].id):
        old = db.get(Speaker, sp_id)
        if old is None:
            continue
        components = _history_speakers(db, by_speaker[sp_id])
        if components is not None:
            # Unique by speaker, as `_build_combined_speaker` is.
            names, seen = [], set()
            for c in components:
                cid = moved.get(c, c)
                comp = db.get(Speaker, cid)
                if comp is not None and cid not in seen:
                    seen.add(cid)
                    names.append(comp.name)
        else:
            # No history left to read (a speaker set by hand): substitute the parts.
            parts = _name_parts(old.name or "")
            if new_label is None or not any(p in her_names for p in parts):
                continue
            names = []
            for p in parts:
                p = new_label if p in her_names else p
                if p not in names:
                    names.append(p)
        if len(names) < 2:
            continue
        new_name = combined_speaker_name(names)
        if new_name == old.name:
            continue
        twin = (
            db.query(Speaker)
            .filter(Speaker.project_id == project_id, Speaker.name == new_name,
                    Speaker.id != sp_id)
            .first()
        )
        touched.append(sp_id)
        if twin is None:
            old.name = new_name
            old.original_label = None
            db.flush()
        else:
            db.query(Segment).filter(Segment.speaker_id == sp_id).update(
                {Segment.speaker_id: twin.id}, synchronize_session="fetch",
            )
            db.flush()
            db.delete(old)
            db.flush()
            moved[sp_id] = twin.id
    return touched


def _delete_orphan_named_speakers(
    db: Session, project_id: int, her_names: set[str],
) -> list[int]:
    """Delete combined speakers that name them and that no turn uses any more.

    An Unmerge deletes the merged turn and leaves the "Maria & Sam" row it was
    given (found 2026-10-22, #1320's census). Nothing references it, so deleting it
    costs nothing; kept, it is their name in the speaker list and the `.mmproject`.
    """
    gone: list[int] = []
    for sp in (
        db.query(Speaker)
        .filter(Speaker.project_id == project_id, Speaker.participant_id.is_(None))
        .all()
    ):
        parts = _name_parts(sp.name or "")
        if len(parts) < 2 or not any(p in her_names for p in parts):
            continue
        # One indexed probe per candidate — never a scan of the project's turns.
        if db.query(Segment.id).filter(Segment.speaker_id == sp.id).first() is not None:
            continue
        gone.append(sp.id)
        db.delete(sp)
    if gone:
        db.flush()
    return gone


def redacted_details(raw: str | None) -> str:
    """An audit entry's details with every string nulled and the mark added (D9).

    Keys, numbers and booleans stay — ids and counts are the trail, the words are
    the person's. Details that are not a JSON object are a string themselves. The
    rule is `audit.stripped_details`, shared with a deleted source's entries (#1546).
    """
    return stripped_details(raw, AUDIT_REDACTION_MARK)


def _answer_entries_of(db: Session, project_id: int, value_ids: list[int]) -> list[AuditEntry]:
    """#1547 (D159) — the entries keyed on these answers that are THEIR OWN.

    SQLite gives a deleted answer's id to the next new one, and its `value_updated`
    entry stays keyed on it. Each entry names the column it was written for, so one
    naming ANOTHER column is a previous holder's: it neither supplies their words to
    the orphan-quote match nor is redacted as theirs. (A previous holder in the SAME
    column is not told apart — since #1546 D157 its entry holds no words.)
    """
    column_of: dict[int, int] = {}
    for chunk in _chunks(value_ids):
        column_of.update(
            db.query(DatasetValue.id, DatasetValue.column_id)
            .filter(DatasetValue.id.in_(chunk)).all()
        )
    return [
        e for e in _audit_entries_keyed_on(db, project_id, {AUDIT_ENTITY_VALUE: set(value_ids)})
        if column_named_in(e.details) in (None, column_of.get(e.entity_id))
    ]


def _audit_entries_keyed_on(
    db: Session, project_id: int, entities: dict[str, set[int]],
) -> list[AuditEntry]:
    found: list[AuditEntry] = []
    for entity_type, ids in entities.items():
        for chunk in _chunks(ids):
            found.extend(
                db.query(AuditEntry).filter(
                    AuditEntry.project_id == project_id,
                    AuditEntry.entity_type == entity_type,
                    AuditEntry.entity_id.in_(chunk),
                ).all()
            )
    return found


#: The keys of an answer's audit `details` (`value_updated`, `routers/dataset.py`)
#: that hold its WORDS: what an orphan embed of an answer is matched against, beside
#: its current text (#1473). A turn's are `withdrawal_history.SEGMENT_WORDING_KEYS`,
#: declared there because that walk reads the same entries of a DELETED segment.
_ANSWER_WORDING_KEYS = ("old_value", "new_value")

#: One reader of an entry's wording for both (`withdrawal_history.wording_in`) —
#: the name the edit-wording guard imports.
_edit_wording_in = wording_in


def answer_wordings(
    db: Session, project_id: int, value_ids: list[int],
) -> tuple[list[AuditEntry], list[str]]:
    """What an ORPHAN canvas embed of their answers is matched against, and its entries.

    Each answer's text, and the wording of its OWN `value_updated` entries (#1473;
    #1547 D159 — an entry naming another column is a previous holder's). ONE list for
    three readers, so none can disagree: the scrub's match, the redaction set (the
    entries), and the report's count of the canvas quotes it cannot place (#1546 D158).
    Read BEFORE the answers go.
    """
    words: list[str] = []
    for chunk in _chunks(value_ids):
        words += [
            t for (t,) in db.query(DatasetValue.value_text).filter(
                DatasetValue.id.in_(chunk)) if t
        ]
    entries = _answer_entries_of(db, project_id, value_ids)
    for entry in entries:
        words += _edit_wording_in(entry.details, _ANSWER_WORDING_KEYS)
    return entries, words


def canvas_quotes_unplaced(
    db: Session, project_id: int, value_ids: list[int], *, act: str,
) -> UnplacedCanvasQuotes:
    """#1546 (D158) — for the REPORT: the canvas quotes this withdrawal would leave.

    The scrub's own predicate, read without writing, against the same answer
    wordings the act will use (asked only when a canvas holds an answer's orphan).
    A copy it cannot read is refused in ``act``'s words (#1667, D341) — the report's own, or
    the withdrawal's when `apply_withdrawal` builds the report (`build_withdrawal_report`).
    """
    return unplaced_canvas_quotes(
        db, project_id,
        answer_words=lambda: answer_wordings(db, project_id, value_ids)[1],
        placeholder_text=BLANKED_SEGMENT_TEXT,
        act=act,
    )


def _metrics_reading(db: Session, project_id: int, column_ids: list[int]) -> set[int]:
    """Every metric `mark_metrics_stale` reaches for these columns — stale or not.

    The marker only touches metrics that are NOT already stale, and a metric marked
    stale yesterday still holds a result computed with this person's answers. So
    the reach is measured, not re-derived (a second copy of its arms would drift):
    inside a SAVEPOINT every metric of the project is set current, the marker runs,
    the stale set is read, and the savepoint is rolled back. Measured on pysqlite
    and sqlcipher3: the flags return exactly, and the enclosing transaction's own
    changes survive.
    """
    savepoint = db.begin_nested()
    try:
        db.query(MetricDefinition).filter(
            MetricDefinition.project_id == project_id,
        ).update({MetricDefinition.stale: False}, synchronize_session=False)
        mark_metrics_stale(db, project_id, column_ids=column_ids)
        reached = {
            mid for (mid,) in db.query(MetricDefinition.id).filter(
                MetricDefinition.project_id == project_id,
                MetricDefinition.stale == True,  # noqa: E712
            )
        }
    finally:
        savepoint.rollback()
    return reached


def apply_withdrawal(db: Session, participant: Participant) -> RedactionOutcome:
    """Remove this participant, preserving every other participant's data.

    ⚠️ **The turns come from `withdrawal_report.reached_turns`** — the same walk the
    report counts. Two enumerations of "what traces back to this person" is the
    copies-propagate shape with DATA LOSS as the failure mode: until #1320 the
    report was built here and then a second walk by `speaker_id` did the work, and
    the one that under-reported (it missed every merged turn) was the one that acted.

    ⚠️ Not committed here. The caller owns the transaction so the forced backup,
    the redaction and the audit entry succeed or fail together — and it raises
    rather than carrying on past a copy it cannot read.
    """
    project_id = participant.project_id
    # #1667 (D341): a canvas copy it cannot read is refused here first — in the ACT's words.
    report = build_withdrawal_report(db, participant, act=ACT_WITHDRAWAL)

    speakers = (
        db.query(Speaker).filter(Speaker.participant_id == participant.id).all()
    )
    speaker_ids = [s.id for s in speakers]
    # Every spelling that identifies them — read BEFORE anything is renamed.
    her_names: set[str] = {
        n for n in (
            participant.identifier, participant.display_name,
            *(s.name for s in speakers), *(s.original_label for s in speakers),
        ) if n
    }

    # ── The conversation side: blank the words, keep the structure ─────────
    reached = reached_turns(db, speaker_ids)
    own_ids = set(reached.own_ids)
    turn_ids = reached.all_ids
    turns = (
        db.query(Segment).filter(Segment.id.in_(turn_ids)).order_by(Segment.id).all()
        if turn_ids else []
    )
    her_names |= {
        t.original_speaker_label for t in turns
        if t.id in own_ids and t.original_speaker_label
    }

    # What an ORPHAN canvas embed is matched against (D8): their turns' words as
    # they stand, and as they stood before an edit (the edit's own audit entry).
    words_by_conversation: dict[int, list[str]] = {}
    conv_of = {t.id: t.conversation_id for t in turns}
    for t in turns:
        if t.text:
            words_by_conversation.setdefault(t.conversation_id, []).append(t.text)
    # 🔴 #1547 (D159) — an entry keyed on a reached turn's id is that turn's only
    # within the turn's OWN lifetime: SQLite gives a freed id to the next new turn,
    # whose speaker's withdrawal then took the previous holder's edit as theirs —
    # redacting it, and matching another participant's orphan quote against its
    # words. `history_starts` is the one answer, shared with the walk below and the
    # conversation delete (#1546). These entries feed BOTH the words and, below, the
    # redaction, so the two cannot disagree.
    history = segment_history(db, project_id)
    starts = history_starts(db, project_id, conv_of, history)
    turn_entries = [
        e for e in _audit_entries_keyed_on(
            db, project_id, {AUDIT_ENTITY_SEGMENT: set(turn_ids)},
        )
        if e.id >= starts[e.entity_id]
    ]
    for entry in turn_entries:
        words_by_conversation.setdefault(conv_of[entry.entity_id], []).extend(
            _edit_wording_in(entry.details)
        )
    # #1473 (b) — the merge results and split children their words passed through
    # that an Unmerge or Unsplit has since DELETED: their audit entries and what they
    # held, read from the trail before anything here is blanked (D5).
    lineage = deleted_lineage(db, project_id, reached, history)

    # #1190 — every uuid this removes or blanks, so no later import or link can
    # bring it back (`services/tombstones.py`). Read BEFORE each delete.
    removed = tomb.Tombstones()
    removed.add(tomb.PARTICIPANT, participant.uuid, tomb.identifier_hash(participant.identifier))
    # #1472 (D73) — and every name she was known by here, as its own kind, read only by
    # the speaker-label door: a transcript labelled "Maria" re-created M01. #1605 (D229,
    # D237) — each name as written AND folded, and her ID's own spelling folded too: a
    # participant made from a transcript has ID == name, so without it `MARÍA LÓPEZ`
    # or `m01` at the speaker door brought her back. The rule is the module's.
    for h in tomb.name_hashes_to_remember(her_names, participant.identifier):
        removed.add(tomb.PARTICIPANT_NAME, None, h)
    for t in turns:
        removed.add(tomb.SEGMENT_BLANKED, t.uuid)
    speaker_uuids_before = {
        u for (u,) in db.query(Speaker.uuid).filter(Speaker.project_id == project_id) if u
    }

    code_applications_kept = 0
    notes_for_review = 0
    turn_excerpt_ids: list[int] = []
    if turn_ids:
        for chunk in _chunks(turn_ids):
            code_applications_kept += (
                db.query(CodeApplication)
                .filter(CodeApplication.segment_id.in_(chunk)).count()
            )
            notes_for_review += db.query(Note).filter(Note.segment_id.in_(chunk)).count()
            turn_excerpt_ids += [
                e for (e,) in db.query(Excerpt.id).filter(Excerpt.segment_id.in_(chunk))
            ]
        # Excerpts are POINTERS INTO the text. After blanking, their offsets
        # address nothing — and a quote of removed words is precisely what a
        # withdrawal asks to be gone.
        for chunk in _chunks(turn_excerpt_ids):
            removed.uuids.setdefault(tomb.EXCERPT, set()).update(
                u for (u,) in db.query(Excerpt.uuid).filter(Excerpt.id.in_(chunk)) if u)
        for chunk in _chunks(turn_excerpt_ids):
            db.query(Excerpt).filter(Excerpt.id.in_(chunk)).delete(
                synchronize_session=False,
            )

    segments_blanked = 0
    combined_turns_blanked = 0
    for turn in turns:
        turn.text = BLANKED_SEGMENT_TEXT
        # The count must move WITH the text. Leaving it would keep the person's
        # words in every density and volume figure while the words themselves are
        # gone (#703's unit is whitespace tokens).
        turn.word_count = 0
        # Their own turn's label is theirs; a combined turn's is the FIRST
        # original's (merge) or the original's (split) — theirs only sometimes.
        if turn.id in own_ids or turn.original_speaker_label in her_names:
            turn.original_speaker_label = None
        if turn.id in own_ids:
            segments_blanked += 1
        else:
            combined_turns_blanked += 1
    db.flush()

    # ── The identity: the speaker row survives, renamed ───────────────────
    speaker_label = None
    for sp in speakers:
        speaker_label = _next_withdrawn_label(db, project_id)
        sp.name = speaker_label
        sp.original_label = None
        sp.participant_id = None
        db.flush()  # so the next label sees this one

    # #1320 — the combined speakers carry their name with no participant link.
    combined_turns = [t for t in turns if t.id not in own_ids]
    renamed_speakers = _recompose_combined_speakers(
        db, project_id, combined_turns, set(speaker_ids), her_names, speaker_label,
    )
    orphan_speakers = _delete_orphan_named_speakers(db, project_id, her_names)
    db.flush()
    for u in speaker_uuids_before - {
        u for (u,) in db.query(Speaker.uuid).filter(Speaker.project_id == project_id) if u
    }:
        removed.add(tomb.SPEAKER, u)

    # ── The dataset side: theirs alone, so it goes ────────────────────────
    rows = (
        db.query(DatasetRow).filter(DatasetRow.participant_id == participant.id).all()
    )
    row_ids = [r.id for r in rows]
    for r in rows:
        removed.add(tomb.DATASET_ROW, r.uuid)
    value_ids: list[int] = []
    value_entries: list[AuditEntry] = []
    value_excerpt_ids: list[int] = []
    # What an ORPHAN canvas embed of an answer is matched against (#1473): each
    # answer's text, and its edits' wording — read BEFORE the answers go
    # (`answer_wordings`, the list the report's D158 count reads too).
    answer_words: list[str] = []
    responses_deleted = 0
    notes_deleted = 0
    code_applications_deleted = 0
    row_scores_deleted = 0
    memos_for_review = 0
    computed_results_deleted = 0

    if row_ids:
        # #1144 — the datasets losing a row, read BEFORE the rows go.
        affected_dataset_ids = sorted({r.dataset_id for r in rows})
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
            value_excerpt_ids = [
                e for (e,) in db.query(Excerpt.id).filter(
                    Excerpt.dataset_value_id.in_(value_ids))
            ]
            for chunk in _chunks(value_ids):
                for (u,) in db.query(Excerpt.uuid).filter(Excerpt.dataset_value_id.in_(chunk)):
                    removed.add(tomb.EXCERPT, u)
                for (u,) in db.query(Note.uuid).filter(Note.dataset_value_id.in_(chunk)):
                    removed.add(tomb.NOTE, u)
            # #1547 (D159) — their answers' OWN entries; the same list is redacted below.
            value_entries, answer_words = answer_wordings(db, project_id, value_ids)
            # Delete what hangs off the responses BEFORE the responses, so no FK
            # is left addressing a row that is going away in the same flush.
            db.query(Excerpt).filter(
                Excerpt.dataset_value_id.in_(value_ids)
            ).delete(synchronize_session=False)
            # A note or a coding on an answer cannot outlive it (the note's parent
            # IS the answer), so unlike their turns' these are DELETED — and counted,
            # from the statement that deletes them (#1473 d4).
            notes_deleted = db.query(Note).filter(
                Note.dataset_value_id.in_(value_ids)
            ).delete(synchronize_session=False)
            code_applications_deleted = db.query(CodeApplication).filter(
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
        # 🔴 #1144 — their data must leave the NUMBERS too. A saved metric keeps the
        # result it last computed, and quick compute reuses any metric not marked
        # stale, so after a withdrawal the analysis view went on showing means and
        # frequencies that included this person's responses. Every column of each
        # dataset that lost a row: a row is in every column's population.
        affected_columns = [
            column_id for (column_id,) in
            db.query(DatasetColumn.id).filter(DatasetColumn.dataset_id.in_(affected_dataset_ids))
        ]
        if affected_columns:
            # 🔴 #1320 (D10) — and the stored results go: a stale frequency still
            # listed their unique answer, in every export that reads it. The reach
            # is measured BEFORE the real mark, which leaves an already-stale
            # metric untouched and so could not report it.
            reading = _metrics_reading(db, project_id, affected_columns)
            mark_metrics_stale(db, project_id, column_ids=affected_columns)
            for chunk in _chunks(reading):
                computed_results_deleted += (
                    db.query(ComputedResult)
                    .filter(ComputedResult.metric_definition_id.in_(chunk))
                    .delete(synchronize_session=False)
                )

    # ── The document side: UNLINKED and reported, never deleted (row 46) ──
    #
    # Decided with the developer 2026-09-07, and the reason is that the tool
    # cannot tell the two cases apart. A workplan filed under this person is
    # unambiguously theirs; a policy document that merely NAMES them is not, and
    # both wear the same link. Deleting would be unrecoverable (there is no
    # per-participant undo) and would destroy a non-withdrawing author's work in
    # the second case; blanking would leave an empty shell whose coding and
    # coverage figures still count. So the link goes — which is what carries the
    # identity — and the document is surfaced for the human decision, the same
    # treatment `Note` and `Memo` already get.
    #
    # ⚠️ **The loop is not what nulls the link — MEASURED, by deleting it.** The
    # `Participant.documents` relationship de-associates its children on delete
    # (SQLAlchemy's default for a relationship without a delete cascade), and the
    # FK's `ondelete="SET NULL"` says the same thing at the database. Removing
    # the loop leaves every assertion here green.
    #
    # It stays because the COUNT and the EFFECT must come from ONE list: with the
    # loop, `documents_unlinked` reports exactly the rows this function touched,
    # and the two cannot drift. Reporting a number derived from one query while a
    # different mechanism does the work is how a withdrawal outcome ends up
    # describing something that did not happen.
    #
    # ⚠️ What neither the loop nor the FK protects against is someone giving that
    # relationship a `delete-orphan` cascade — the documents would then be
    # DELETED while this still reported them unlinked. **No behavioural test here
    # can see that** (measured: the cascade added, all four green, because this
    # nulls the column rather than mutating the collection). It is pinned
    # structurally instead, by
    # `test_withdrawal_redaction.py::test_the_relationship_carries_no_delete_cascade`.
    linked_documents = (
        db.query(Document).filter(Document.participant_id == participant.id).all()
    )
    for doc in linked_documents:
        doc.participant_id = None

    # ── The canvas: its copies of every quote this removed (#1320) ────────
    removed_excerpt_ids = set(turn_excerpt_ids) | set(value_excerpt_ids)
    canvas = scrub_excerpt_embeds(
        db, project_id, removed_excerpt_ids,
        replacement_text=BLANKED_SEGMENT_TEXT,
        words_by_conversation=words_by_conversation,
        answer_words=answer_words,
        deleted_wordings=lineage.wordings_by_conversation(),
    )
    # Joint display slice 2 (r3-6): a picked case names THEM and carries the researcher's
    # reason about them — removed whole, before the participant row it names goes.
    misfit = scrub_misfit_cases(db, project_id, participant.id, act=ACT_WITHDRAWAL)

    # ── The audit trail: strip the words, keep the entries (D9) ───────────
    #
    # Keyed by ENTITY: every entry about their record, their speakers (and the
    # combined ones), their rows and quotes — whatever its action. The turns' and
    # answers' entries are the two lists read above, each within its own lifetime
    # (#1547 D159). Plus, by entry id, each deleted segment's entries within its own
    # lifetime (#1473 b — an id keyed alone would also name the next segment given
    # it). One entry once. The endpoint writes the `withdrawn` entry AFTER this.
    to_redact = {e.id: e for e in _audit_entries_keyed_on(db, project_id, {
        AUDIT_ENTITY_PARTICIPANT: {participant.id},
        AUDIT_ENTITY_SPEAKER: set(speaker_ids) | set(renamed_speakers) | set(orphan_speakers),
        AUDIT_ENTITY_EXCERPT: removed_excerpt_ids,
        AUDIT_ENTITY_ROW: set(row_ids),
    })}
    for e in turn_entries + value_entries:
        to_redact[e.id] = e
    for chunk in _chunks(lineage.audit_entry_ids - set(to_redact)):
        for e in db.query(AuditEntry).filter(AuditEntry.id.in_(chunk)):
            to_redact[e.id] = e
    redacted = 0
    for entry in to_redact.values():
        if entry.action in AUDIT_KEPT_ACTIONS:
            continue
        entry.details = redacted_details(entry.details)
        redacted += 1

    outcome = RedactionOutcome(
        participant_id=participant.id,
        identifier=report.identifier,
        speaker_label=speaker_label,
        segments_blanked=segments_blanked,
        # #1473 — every quote deleted: of their turns AND of their answers, the
        # count the confirm's "N quotes taken from their data" promised.
        excerpts_deleted=len(turn_excerpt_ids) + len(value_excerpt_ids),
        dataset_rows_deleted=len(row_ids),
        responses_deleted=responses_deleted,
        row_scores_deleted=row_scores_deleted,
        code_applications_kept=code_applications_kept,
        notes_for_review=notes_for_review,
        memos_for_review=memos_for_review,
        documents_unlinked=len(linked_documents),
        combined_turns_blanked=combined_turns_blanked,
        combined_speakers_renamed=len(renamed_speakers) + len(orphan_speakers),
        canvas_embeds_scrubbed=canvas.embeds_scrubbed + canvas.snapshot_embeds_scrubbed,
        canvas_snapshots_rewritten=canvas.snapshots_rewritten,
        canvas_inbox_items_removed=(
            canvas.inbox_items_removed + canvas.snapshot_inbox_entries_removed
        ),
        computed_results_deleted=computed_results_deleted,
        audit_entries_redacted=redacted,
        notes_deleted=notes_deleted,
        code_applications_deleted=code_applications_deleted,
        canvas_quotes_unplaced=canvas.quotes_unplaced,
        canvas_misfit_cases_removed=misfit.cases_removed,
    )

    project_uuid = db.query(Project.project_uuid).filter(Project.id == project_id).scalar()
    if project_uuid:
        tomb.write(db, project_uuid, removed)

    # ⚠️ Last, and after a flush: the participant row is what every lookup above
    # keys on. Deleting it earlier would leave the rest of this function walking
    # a link that no longer exists — the same "delete destroys the link you need"
    # trap the withdrawal REPORT exists to warn about.
    db.flush()
    db.delete(participant)

    return outcome
