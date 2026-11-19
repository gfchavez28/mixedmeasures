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

🔴 **A turn holds their words by HISTORY, not only by speaker (#1320).** A merge
copies the originals' text into a NEW segment whose speaker is a combined
"Maria & Sam" row with no participant link — or NO speaker at all, when the first
turn merged had none — and a split copies a turn's text into children of which only
the first is linked back. Selecting by `speaker_id` saw none of them, so the report
counted the hidden originals and said nothing of the visible turn still holding the
words. `reached_turns` is the ONE walk: the report counts it and
`withdrawal_redaction.apply_withdrawal` blanks exactly it.

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

import json
import unicodedata
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Literal

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..config import get_backup_dir, get_settings
from ..database import is_pre_migration_copy_of
from ..models.audit import AuditEntry
from ..models.participant import Participant
from ..models.project import Project
from ..routers.helpers import apply_project_owner_filter
from ..models.speaker import Speaker
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.code_application import CodeApplication
from ..models.excerpt import Excerpt
from ..models.note import Note
from ..models.memo import Memo
from ..models.row_score import RowScore
from .canvas_embed_scrub import (
    ACT_REPORT, UnplacedCanvasQuotes, canvas_quote_counts, count_drift_stamps, count_misfit_cases,
    read_canvas_copies,
)
from .participant_dataset import MANAGED_COLUMN_SOURCE
from .tombstones import identifier_key


@dataclass
class ConversationTouchpoint:
    """One conversation this participant speaks in.

    `segments` are their OWN turns (their speaker); `combined_turns` are the turns
    their words reached through a merge or a split (#1320) — a combined or absent
    speaker, so no speaker query finds them. The code, quote and note counts cover
    BOTH, because the withdrawal acts on both.
    """

    conversation_id: int
    name: str
    segments: int = 0
    combined_turns: int = 0
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
    #: #1702 (D382) — how many canvas quotes (embeds and joint display pins, sections and
    #: snapshots) show this document's passages. They stay with the document, which stays for
    #: the researcher to read; the confirm's document line counts them so that reading finds
    #: them. NOT in `total_items` (nothing here is removed).
    canvas_quotes: int = 0


#: How a project is linked to this one by a Duplicate (#1606, D234): ``"copy"`` — it was
#: duplicated FROM this project; ``"source"`` — this project was duplicated from IT.
CopyRelation = Literal["copy", "source"]


@dataclass
class OtherProject:
    """#1606 (D234) — another project on this install holding a participant with the
    same ID. ``copy_relation`` from the ``project_duplicate`` audit entries, in either
    direction (D234's ``is_copy``, given its direction: the project a copy was made
    FROM must not read "a copy of this project"); None when no Duplicate links them."""

    project_id: int
    name: str
    copy_relation: CopyRelation | None = None


@dataclass
class OtherProjectsWithIdentifier:
    """#1606 (D234). ``projects`` — copies first, then by name — is capped at
    `OTHER_PROJECTS_CAP`; ``total`` counts every one."""

    projects: list[OtherProject] = field(default_factory=list)
    total: int = 0


@dataclass
class PreUpdateCopies:
    """#1606 (D235) — the copies of the whole database taken before each update
    (`database._backup_database`), which Settings does not list. A fact of the
    install, not of the participant: carried here because the report is where the
    researcher reads where their data still is. ``count`` is None when the folder
    could not be read — never 0, which would say there are none."""

    count: int | None = 0
    folder: str = ""


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
    # #1190 D14 — `unlinked_records_with_identifier`: possibly hers, never provably,
    # so counted beside the report and NOT in `total_items` (the withdrawal does not
    # touch them). See `_unlinked_records_with_identifier`.
    unlinked_records_with_identifier: int = 0
    # #1546 D158 — canvas quotes whose source is gone, so the withdrawal cannot tell
    # whose words they hold and LEAVES them: counted with the sections and snapshots
    # holding them, beside the report and NOT in `total_items`, as D14's are.
    canvas_quotes_unplaced: UnplacedCanvasQuotes = field(default_factory=UnplacedCanvasQuotes)
    # Joint display slice 2 (r3-6) — cases picked as "not fitting" in a joint display that
    # name them, each with the researcher's reason: the withdrawal REMOVES them (sections
    # and snapshot copies), so the confirm says how many. Beside `total_items`, as the
    # canvas quotes are (the withdrawal's data items stay the count they were).
    canvas_misfit_cases: int = 0
    # #1674 D357 — the drift stamps the withdrawal CLEARS: every set of numbers saved beside a
    # meta-inference in the project's joint displays (sections and snapshot copies). Beside
    # `total_items`, as the cases are; a stamp is the researcher's, re-made with one press.
    canvas_drift_stamps: int = 0
    # #1606 D234 — other projects here holding someone with this ID (a Duplicate made
    # before the withdrawal keeps everything). Possibly the same person, never provably:
    # beside the report, NOT in `total_items` — the withdrawal does not reach them.
    other_projects_with_identifier: OtherProjectsWithIdentifier = field(
        default_factory=OtherProjectsWithIdentifier)
    # #1606 D235 — the install's pre-update database copies, which hold everything.
    pre_update_copies: PreUpdateCopies = field(default_factory=PreUpdateCopies)

    @property
    def total_items(self) -> int:
        """Everything the report counts, for a one-line headline.

        Deliberately includes the participant record itself: "9 items" that
        silently omitted the row being deleted would misstate the very action
        the reader is about to take.
        """
        return 1 + sum(
            c.segments + c.combined_turns + c.code_applications + c.excerpts + c.notes
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


def _unlinked_records_with_identifier(db: Session, participant: Participant) -> int:
    """#1190 D14 — records linked to NOBODY that carry this participant's identifier.

    🔴 **Nothing stores which column identified a person.** Linking takes the column
    the researcher picks at that moment (`link-by-column`'s `column_id`; the append
    offer and the import's `participant_link_column_index` likewise) and keeps no
    record of it. So this counts what ANY identifier-typed column could link: a
    record whose cell in a column of type `identifier` is the same ID under the
    withdrawal record's rule (`tombstones.identifier_key`: trimmed, any canonically
    equivalent Unicode form, capitals kept — #1605, D227). The record number
    (`row_identifier`, "R0001") is not an identifier of a person and is not read. A
    record with two such cells is counted once.

    A count, never which records, and nothing is deleted: a matching cell is evidence,
    not proof (a code can be reused across studies), which is why D14 reports it.
    ⚠️ A cell holding the ID in a MIXED form (one accent composed, another decomposed)
    contains neither the composed nor the decomposed key, so `instr` passes it by: a
    stated residual of a count that is already only "may be theirs".
    """
    key = identifier_key(participant.identifier)
    if not key:
        return 0
    forms = sorted({key, unicodedata.normalize("NFD", key)})
    # SQLite's trim() trims spaces only; `instr` narrows to candidate cells in SQL (in
    # the ID's composed and decomposed forms) and Python applies the one rule, so the
    # two can never disagree.
    candidates = (
        db.query(DatasetRow.id, DatasetValue.value_text)
        .join(DatasetValue, DatasetValue.row_id == DatasetRow.id)
        .join(DatasetColumn, DatasetColumn.id == DatasetValue.column_id)
        .join(Dataset, Dataset.id == DatasetRow.dataset_id)
        .filter(
            Dataset.project_id == participant.project_id,
            DatasetColumn.column_type == ColumnType.IDENTIFIER,
            DatasetRow.participant_id.is_(None),
            or_(*(func.instr(DatasetValue.value_text, f) > 0 for f in forms)),
        )
    )
    return len({row_id for row_id, text in candidates if identifier_key(text) == key})


#: #1606 (D234) — how many other projects are named; `total` says how many there are.
OTHER_PROJECTS_CAP = 20


def _duplicate_links(db: Session, project_id: int) -> dict[int, CopyRelation]:
    """#1606 (D234) — the projects a Duplicate links to this one, from the
    ``project_duplicate`` entry every Duplicate writes in the COPY's trail
    (``details.source_project_id``, `routers/project_portability.py`).

    Both directions: copies' entries name this project, and this project's own entry
    names what it was copied from — so a withdrawal made in the copy finds the
    original too. ⚠️ Only a Duplicate leaves a link: an "Import as an independent
    project" records the file's name, and a copy of a copy is linked to its own
    source only. ⚠️ The entry keeps an id, which goes stale when the original is
    later replaced by an overwrite import; the flag is a hint beside a list that
    already says "check whether it is the same person".
    """
    links: dict[int, CopyRelation] = {}
    entries = (
        db.query(AuditEntry.project_id, AuditEntry.details)
        .filter(AuditEntry.action == "project_duplicate")
        .all()
    )
    for copy_id, details in entries:
        try:
            source_id = json.loads(details or "{}").get("source_project_id")
        except (ValueError, AttributeError):
            continue  # an entry this reader cannot parse links nothing
        if not isinstance(source_id, int) or copy_id is None:
            continue
        if source_id == project_id and copy_id != project_id:
            links[copy_id] = "copy"
        elif copy_id == project_id and source_id != project_id:
            links.setdefault(source_id, "source")
    return links


def other_projects_with_identifier(
    db: Session, project_id: int, identifier: str | None,
) -> OtherProjectsWithIdentifier:
    """#1606 (D234) — the OTHER projects on this install holding a participant whose ID
    is this one under the withdrawal record's rule (`tombstones.identifier_key`:
    trimmed, any canonically equivalent Unicode form, capitals kept — D227).

    A project duplicated from this one before the withdrawal keeps everything about the
    person, and nothing stops it being copied on (its own record is empty). So the
    report names it, and the projects that merely share the ID too: a short code
    (``P01``) can be another study's person, which is why the copy says "check
    whether it is the same person". Visible projects only — the ownership gate's own
    predicate, `apply_project_owner_filter`, with this project's owner (the caller
    passed `_get_project_or_404` for it). Names only, never what they hold.

    ⚠️ Misses, stated: a copy whose participant was renamed, a copy exported and sent
    away, another install — and, as D14's count, an ID held in a MIXED Unicode form.
    """
    key = identifier_key(identifier)
    if not key:
        return OtherProjectsWithIdentifier()
    owner_id = db.query(Project.user_id).filter(Project.id == project_id).scalar()
    forms = sorted({key, unicodedata.normalize("NFD", key)})
    # `instr` narrows in SQL (case-sensitive, as the rule is) and Python applies the one
    # rule, as `_unlinked_records_with_identifier` does.
    candidates = apply_project_owner_filter(
        db.query(Project.id, Project.name, Participant.identifier)
        .join(Participant, Participant.project_id == Project.id)
        .filter(
            Project.id != project_id,
            or_(*(func.instr(Participant.identifier, f) > 0 for f in forms)),
        ),
        owner_id,
    )
    holding = {pid: name for pid, name, ident in candidates if identifier_key(ident) == key}
    if not holding:
        return OtherProjectsWithIdentifier()
    links = _duplicate_links(db, project_id)
    projects = sorted(
        (OtherProject(project_id=pid, name=name, copy_relation=links.get(pid))
         for pid, name in holding.items()),
        key=lambda p: (p.copy_relation is None, p.name.casefold(), p.project_id),
    )
    return OtherProjectsWithIdentifier(
        projects=projects[:OTHER_PROJECTS_CAP], total=len(projects))


def pre_update_copies() -> PreUpdateCopies:
    """#1606 (D235) — how many copies of THIS database the updates left, and where.

    `database._backup_database` writes one before every update that changes the
    database, five kept; Settings lists none of them, so the withdrawal's own wording
    could not point at them. The folder is `get_backup_dir()`'s, made absolute for
    display — never composed. ⚠️ It can contain the computer's user name: it is shown
    in the app and returned to the page, and never stored (the withdrawal's audit
    entry does not carry it — it travels in every export).
    """
    folder = get_backup_dir()
    shown = str(folder.absolute())
    stem = Path(get_settings().mm_database_path).stem
    try:
        if not folder.is_dir():
            return PreUpdateCopies(count=0, folder=shown)
        count = sum(1 for p in folder.iterdir() if is_pre_migration_copy_of(p.name, stem))
    except OSError:
        # Unknown is said as unknown: 0 would tell the researcher there are none.
        return PreUpdateCopies(count=None, folder=shown)
    return PreUpdateCopies(count=count, folder=shown)


def copies_elsewhere(db: Session, project_id: int, identifier: str | None) -> dict:
    """#1606 — the two wire fields as the withdraw endpoint returns them beside its
    outcome, read BEFORE it changes anything. The report carries the same two."""
    return {
        "other_projects_with_identifier": asdict(
            other_projects_with_identifier(db, project_id, identifier)),
        "pre_update_copies": asdict(pre_update_copies()),
    }


def _count(db: Session, model, column, ids: list[int]) -> int:
    if not ids:
        return 0
    return db.query(model).filter(column.in_(ids)).count()


@dataclass(frozen=True)
class ReachedTurns:
    """The conversation turns that hold one person's words, by conversation (#1320).

    `own` — the turns their speaker holds, hidden ones included. `combined` — the
    turns their words reached only through a merge or a split: a merge result (its
    speaker is a combined "Maria & Sam" row, or none at all) and the children of a
    split of any reached turn. Both lists are ascending ids.
    """

    own: dict[int, list[int]]
    combined: dict[int, list[int]]

    @property
    def own_ids(self) -> list[int]:
        return sorted(i for ids in self.own.values() for i in ids)

    @property
    def combined_ids(self) -> list[int]:
        return sorted(i for ids in self.combined.values() for i in ids)

    @property
    def all_ids(self) -> list[int]:
        return sorted(self.own_ids + self.combined_ids)

    @property
    def conversation_ids(self) -> list[int]:
        return sorted(set(self.own) | set(self.combined))


#: A text split makes at most three children — before · selected · after
#: (`segment_operations._split_single` / `_split_multi`).
MAX_SPLIT_CHILDREN = 3


def _split_children(
    db: Session, first_children: set[int], reached: set[int], conv_ids: set[int],
) -> set[int]:
    """The children of each split whose first child is in `first_children`.

    A split points its original(s) at the FIRST child only (`split_into_id`), so
    the siblings have to be found. ⚠️ Not with `segment_operations.
    _find_split_siblings`, the rule Unsplit uses: it walks a contiguous run of
    VISIBLE split results by `sequence_order`, so two adjacent splits read as one
    family (it would blank another person's split turn) and a child that was later
    merged or split again is invisible to it (it would leave their words behind).
    One split inserts its children one after another and nothing else into
    `segments` in between, so a split's children are consecutive ids from the first
    one; the run ends at the next id that is not a split result of the same
    conversation, or that is the FIRST child of another split.

    A split across SEVERAL turns (`_split_multi`) whose originals are not all
    reached makes a 'before' child from the first original's text and an 'after'
    child from the last one's. A child whose text is found in an unreached
    original and in no reached one is that other person's words alone, and is not
    taken. Anything else is (an edited child, a 'selected' child joining several
    turns): removing too little is the failure that matters here.
    """
    split_targets = {
        t for (t,) in db.query(Segment.split_into_id).filter(
            Segment.conversation_id.in_(conv_ids), Segment.split_into_id.isnot(None),
        )
    }
    window = sorted({f + k for f in first_children for k in range(MAX_SPLIT_CHILDREN)})
    cand = {
        r.id: r for r in db.query(
            Segment.id, Segment.conversation_id, Segment.is_split_result, Segment.text,
        ).filter(Segment.id.in_(window))
    }
    out: set[int] = set()
    for first in sorted(first_children):
        head = cand.get(first)
        if head is None:
            continue
        batch = [first]
        for k in range(1, MAX_SPLIT_CHILDREN):
            child = cand.get(first + k)
            if (
                child is None
                or not child.is_split_result
                or child.conversation_id != head.conversation_id
                or child.id in split_targets
            ):
                break
            batch.append(child.id)

        originals = (
            db.query(Segment.id, Segment.text).filter(Segment.split_into_id == first).all()
        )
        unreached = [o.text or "" for o in originals if o.id not in reached]
        if not unreached:
            out.update(batch)
            continue
        reached_texts = [o.text or "" for o in originals if o.id in reached]
        for child_id in batch:
            text = (cand[child_id].text or "").strip()
            others_alone = (
                bool(text)
                and any(text in t for t in unreached)
                and not any(text in t for t in reached_texts)
            )
            if not others_alone:
                out.add(child_id)
    return out


def reached_turns(db: Session, speaker_ids: list[int]) -> ReachedTurns:
    """Every conversation turn holding the words of the people behind `speaker_ids`.

    The ONE walk (#1320): the report counts it, the withdrawal blanks it. Seeded by
    speaker, then closed over the turns' HISTORY — a reached turn's merge result
    (`merged_into_id`), and the children of its split (`split_into_id` plus the
    siblings, `_split_children`) — to a fixpoint, so a merge of a split of a merge
    is followed as far as it goes. Hidden turns are included on purpose: they hold
    the words, and Unmerge or Unsplit brings them back. A merge result or split child
    an Unmerge or Unsplit DELETED has no row to follow: `withdrawal_history.
    deleted_lineage` finds it from the audit trail, and nothing there is blanked.
    """
    if not speaker_ids:
        return ReachedTurns({}, {})
    own_ids = {
        sid for (sid,) in db.query(Segment.id).filter(
            Segment.speaker_id.in_(speaker_ids), Segment.conversation_id.isnot(None),
        )
    }
    reached = set(own_ids)
    rows: dict[int, tuple[int, int | None, int | None]] = {}
    while True:
        missing = sorted(reached - rows.keys())
        if missing:
            for sid, conv_id, merged_into, split_into in db.query(
                Segment.id, Segment.conversation_id,
                Segment.merged_into_id, Segment.split_into_id,
            ).filter(Segment.id.in_(missing)):
                rows[sid] = (conv_id, merged_into, split_into)
        merge_results = {rows[i][1] for i in reached if rows[i][1] is not None}
        first_children = {rows[i][2] for i in reached if rows[i][2] is not None}
        children = (
            _split_children(db, first_children, reached, {rows[i][0] for i in reached})
            if first_children else set()
        )
        new = (merge_results | children) - reached
        if not new:
            break
        reached |= new

    own: dict[int, list[int]] = {}
    combined: dict[int, list[int]] = {}
    for sid in sorted(reached):
        conv_id = rows[sid][0]
        if conv_id is None:
            continue
        (own if sid in own_ids else combined).setdefault(conv_id, []).append(sid)
    return ReachedTurns(own, combined)


def build_withdrawal_report(
    db: Session, participant: Participant, *, act: str = ACT_REPORT,
) -> WithdrawalReport:
    """Everything in this project that traces back to `participant`.

    Counts only — see the module docstring for what is deliberately excluded and
    why the segment count is unfiltered.

    Raises `canvas_embed_scrub.CanvasScrubError` on a canvas copy it cannot read, naming the
    copy in ``act``'s words (#1667, D341): the report's own (`ACT_REPORT`, read by both
    Participants-page confirms and the panel). (`apply_withdrawal` no longer builds it — #1676
    D363: the endpoint refuses an unreadable copy before its backup instead.)
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
    # #1320 — by speaker AND by history: `reached_turns` is the same walk the
    # withdrawal acts on, so the two cannot disagree about which turns are hers.
    # (Only conversation segments carry a speaker; a parentless one is skipped
    # inside the walk rather than crashing here.)
    reached = reached_turns(db, speaker_ids)
    for conv_id in reached.conversation_ids:
        own = reached.own.get(conv_id, [])
        shared = reached.combined.get(conv_id, [])
        seg_ids = own + shared
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        tp = ConversationTouchpoint(
            conversation_id=conv_id,
            name=conv.name if conv else "(unknown)",
            segments=len(own),
            combined_turns=len(shared),
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
    # Every answer of theirs — what an answer's orphan on a canvas is matched against.
    answer_ids: list[int] = []

    for ds_id, row_ids in rows_by_dataset.items():
        ds = db.query(Dataset).filter(Dataset.id == ds_id).first()
        tp = DatasetTouchpoint(
            dataset_id=ds_id, name=ds.name if ds else "(unknown)", rows=len(row_ids),
        )
        value_ids = [
            v[0] for v in
            db.query(DatasetValue.id).filter(DatasetValue.row_id.in_(row_ids)).all()
        ]
        answer_ids += value_ids
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
    # #1702 (D382): each linked document's quotes (any shape), for its canvas count below —
    # joined through the segment's document, so no id list is bound.
    doc_excerpts: dict[int, list[int]] = {}
    linked_docs = (
        db.query(Document)
        .filter(Document.participant_id == participant.id)
        .all()
    )
    for doc in linked_docs:
        doc_excerpts[doc.id] = [eid for (eid,) in (
            db.query(Excerpt.id).join(Segment, Excerpt.segment_id == Segment.id)
            .filter(Segment.document_id == doc.id)
        )]
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

    # ── The canvas quotes the withdrawal cannot place (#1546 D158) ────────
    #
    # An embed names no speaker, so one whose source is gone cannot be tied to
    # anyone, and the withdrawal leaves it. Asked of the withdrawal's OWN predicate,
    # against the answer wordings it will match with, so the count here is the one
    # the act leaves. ⚠️ Imported here: `withdrawal_redaction` imports this module.
    from .withdrawal_redaction import canvas_quotes_unplaced

    # #1676 D362 — every canvas copy parsed ONCE for the report's three canvas counts. It was
    # parsed per count, on every participant panel open: 4.5 s on the slice 2 build's heavy
    # canvas, which is also why the endpoint is `def`.
    copies = read_canvas_copies(db, participant.project_id, act=act)
    # #1702 (D382): a linked document stays (row 46), and so do its passages quoted on the
    # canvas, with any line written beside a pin — the confirm's document line counts them.
    if documents:
        quote_counts = canvas_quote_counts(db, participant.project_id, act=act, copies=copies)
        for tp in documents:
            tp.canvas_quotes = sum(quote_counts[eid] for eid in doc_excerpts[tp.document_id])

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
        unlinked_records_with_identifier=_unlinked_records_with_identifier(db, participant),
        canvas_quotes_unplaced=canvas_quotes_unplaced(
            db, participant.project_id, answer_ids, act=act, copies=copies),
        canvas_misfit_cases=count_misfit_cases(
            db, participant.project_id, participant.id, act=act, copies=copies),
        canvas_drift_stamps=count_drift_stamps(
            db, participant.project_id, act=act, copies=copies),
        other_projects_with_identifier=other_projects_with_identifier(
            db, participant.project_id, participant.identifier),
        pre_update_copies=pre_update_copies(),
    )
