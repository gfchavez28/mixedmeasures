"""A deleted turn's or answer's WORDS leave the audit trail with it (#1546, D157 + D160).

## Why

Two audit entries hold a person's words: the conversation door's `segment_updated`
(`old_text` / `new_text`, `routers/segments.py`) and the answer door's `value_updated`
(`old_value` / `new_value`, `routers/dataset.py`) — measured by an AST scan of every
`log_action` call (2026-11-08). The document door's edit holds lengths only (D6), and the
structural entries ids and counts.

Deleting a conversation, a dataset, a record or a column removed the turns and answers and
left those entries, keyed on ids nobody holds. A later withdrawal could not find them —
the link to the person went with the source — so their words stayed in the project and in
the Excel *Audit Trail* after it said they were removed. And SQLite gives a freed id to the
next new row, so the next turn or answer seemed to have them as its own history (#1547).

## What

Each door that deletes turns or answers strips their entries' words FIRST, in its own
transaction, in the shape a withdrawal already uses (`audit.stripped_details`: every string
nulled, `"redacted": "source_deleted"`, the entry kept — the trail keeps that an edit
happened). It happens at the delete, for everyone: at a withdrawal nothing says which
deleted turns were the person's any more, and recording that at the delete would keep one
more copy of the link the delete removes.

**The doors** (`tests/test_deleted_source_words_doors.py` finds them by what they delete):
`routers/conversations.py::delete_conversation` · `routers/dataset.py::delete_dataset` ·
`delete_row` · `delete_manual_column` · `delete_computed_column` · the participant table's
reap (`participant_dataset.sync_rows`).

**Not doors, on purpose** (each has its reason in that guard's allowlist): an Unmerge or
Unsplit — the segment it deletes is found again by `withdrawal_history.deleted_lineage`,
which needs its edits' words (#1473 b), and a conversation delete takes that lineage with
it; the withdrawal (D9 redacts its own); a project delete or overwrite (#1230 forgets or
moves the whole history); a document, an observation or a clip (no person's words: D6, and a
clip's text is the researcher's label).

**Cost:** every read starts from the AUDIT side and joins to the source by primary key —
the hand edits are few, a source's rows can be millions (the internal design notes).
`audit_entries.entity_id` has no index, so SQLite cannot be driven the other way.

**Existing installs (D160):** `repair_leftover_words`, in `data_repairs.run_data_repairs`,
strips what a delete before this fix left. SQL picks the CANDIDATES — an edit whose turn or
answer is gone, a turn edit written before its turn's conversation was imported, an answer
edit naming another column — so a settled install reads one query per kind and loads no
entry (measured: 100,000 live hand edits). Python then keeps what a merge result's or split
child's closed lifetime claims (the walk's, #1473 b).
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import and_, case, exists, func, or_, select
from sqlalchemy.orm import Session, aliased

from ..models.audit import AuditEntry
from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetRow, DatasetValue
from ..models.segment import Segment
from .audit import stripped_details
from .withdrawal_history import (
    CONVERSATION_IMPORTED,
    SEGMENT_WORDING_KEYS,
    deleted_lineage,
    history_starts,
    segment_history,
    wording_in,
)
from .withdrawal_report import ReachedTurns

#: The mark a deleted source's entry carries (a withdrawal's is "withdrawal", D9).
SOURCE_DELETED_MARK = "source_deleted"

#: The two word-holding entries: entity type, action, the keys holding the words.
TURN_EDIT = ("segment", "segment_updated", SEGMENT_WORDING_KEYS)
ANSWER_EDIT = ("dataset_value", "value_updated", ("old_value", "new_value"))

_IN_CHUNK = 5000


def _chunks(ids):
    ids = sorted(ids)
    for i in range(0, len(ids), _IN_CHUNK):
        yield ids[i:i + _IN_CHUNK]


def column_named_in(raw: str | None) -> int | None:
    """The column an answer's `value_updated` entry names (`routers/dataset.py`), or
    None. An entry naming ANOTHER column than its answer's was a previous holder's of
    the reused id (#1547 D159) — shared with `withdrawal_redaction`."""
    try:
        parsed = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return None
    v = parsed.get("column_id") if isinstance(parsed, dict) else None
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _of_kind(entry, kind):
    """The filter for one word-holding kind, on `entry` (the model or an alias)."""
    entity_type, action, keys = kind
    return and_(
        entry.entity_type == entity_type,
        entry.action == action,
        entry.entity_id.isnot(None),
        entry.project_id.isnot(None),
        or_(*(entry.details.like(f'%"{k}"%') for k in keys)),
    )


def _holds_words(entry, keys):
    """In SQL: some key holds a STRING (`json_type` 'text'). Guarded by `json_valid`, so
    one malformed row cannot fail the query (`json_type` raises on malformed JSON)."""
    return or_(*(
        case((func.json_valid(entry.details) == 1, func.json_type(entry.details, f"$.{k}")),
             else_=None) == "text"
        for k in keys
    ))


def _with_words(entries: Iterable[AuditEntry], keys) -> list[AuditEntry]:
    return [e for e in entries if wording_in(e.details, keys)]


def _strip(db: Session, entries: Iterable[AuditEntry]) -> int:
    """Strip each, and FLUSH when anything changed: a caller writing around the identity
    map ends with `expire_all()` (`participant_dataset.sync_rows`), which discards an
    unflushed change — silently. A flush with nothing dirty writes nothing (#1033)."""
    n = 0
    for e in entries:
        e.details = stripped_details(e.details, SOURCE_DELETED_MARK)
        n += 1
    if n:
        db.flush()
    return n


def strip_deleted_conversation_words(db: Session, project_id: int, conversation_id: int) -> int:
    """Call BEFORE the conversation's rows go. Returns the entries stripped.

    Its turns' edits within each turn's OWN history (`history_starts` — an earlier
    holder's are the repair's to judge), and its deleted merge results' and split
    children's (the walk, seeded from the turns a merge or split took as an original).
    """
    edits = _with_words(
        db.query(AuditEntry)
        .join(Segment, Segment.id == AuditEntry.entity_id)
        .filter(
            _of_kind(AuditEntry, TURN_EDIT),
            AuditEntry.project_id == project_id,
            Segment.conversation_id == conversation_id,
        ),
        SEGMENT_WORDING_KEYS,
    )
    history = segment_history(db, project_id)
    seeds: set[int] = set()
    for chunk in _chunks(history.made_from):
        seeds.update(sid for (sid,) in db.query(Segment.id).filter(
            Segment.id.in_(chunk), Segment.conversation_id == conversation_id))
    conv_of = {sid: conversation_id for sid in {e.entity_id for e in edits} | seeds}
    if not conv_of:
        return 0
    starts = history_starts(db, project_id, conv_of, history)
    targets = {e.id: e for e in edits if e.id >= starts[e.entity_id]}
    if seeds:
        lineage = deleted_lineage(
            db, project_id, ReachedTurns(own={conversation_id: sorted(seeds)}, combined={}),
            history,
        )
        for chunk in _chunks(lineage.audit_entry_ids - set(targets)):
            targets.update(
                (e.id, e) for e in _with_words(
                    db.query(AuditEntry).filter(
                        AuditEntry.id.in_(chunk), _of_kind(AuditEntry, TURN_EDIT)),
                    SEGMENT_WORDING_KEYS,
                )
            )
    return _strip(db, targets.values())


def strip_deleted_answer_words(
    db: Session,
    project_id: int,
    *,
    dataset_id: int | None = None,
    row_ids: Iterable[int] | None = None,
    column_id: int | None = None,
) -> int:
    """Call BEFORE the answers go — a dataset's, some records', or a column's (exactly
    one scope). Returns the entries stripped."""
    if sum(s is not None for s in (dataset_id, row_ids, column_id)) != 1:
        raise ValueError("strip_deleted_answer_words takes exactly one scope")
    keys = ANSWER_EDIT[2]
    base = (
        db.query(AuditEntry)
        .join(DatasetValue, DatasetValue.id == AuditEntry.entity_id)
        .filter(_of_kind(AuditEntry, ANSWER_EDIT), AuditEntry.project_id == project_id)
    )
    if dataset_id is not None:
        found = base.join(DatasetRow, DatasetRow.id == DatasetValue.row_id).filter(
            DatasetRow.dataset_id == dataset_id).all()
    elif column_id is not None:
        found = base.filter(DatasetValue.column_id == column_id).all()
    else:
        found = []
        for chunk in _chunks(set(row_ids)):
            found += base.filter(DatasetValue.row_id.in_(chunk)).all()
    return _strip(db, _with_words(found, keys))


# ── D160 — what a delete before the fix left behind ──────────────────────────


def _turn_candidates(db: Session) -> list[int]:
    """Turn edits holding words whose turn is gone from the project, or that were
    written before the latest import of their live turn's conversation."""
    a = aliased(AuditEntry)
    imports = (
        select(
            AuditEntry.entity_id.label("cid"),
            AuditEntry.project_id.label("pid"),
            func.max(AuditEntry.id).label("imported_at"),
        )
        .where(AuditEntry.entity_type == "conversation",
               AuditEntry.action == CONVERSATION_IMPORTED)
        .group_by(AuditEntry.entity_id, AuditEntry.project_id)
        .subquery()
    )
    live = exists().where(
        Segment.id == a.entity_id,
        Conversation.id == Segment.conversation_id,
        Conversation.project_id == a.project_id,
    )
    before_import = exists().where(
        Segment.id == a.entity_id,
        imports.c.cid == Segment.conversation_id,
        imports.c.pid == a.project_id,
        a.id < imports.c.imported_at,
    )
    return [i for (i,) in db.execute(
        select(a.id).where(
            _of_kind(a, TURN_EDIT), _holds_words(a, SEGMENT_WORDING_KEYS),
            or_(~live, before_import),
        )
    )]


def _answer_candidates(db: Session) -> list[int]:
    """Answer edits holding words whose answer is gone from the project, or whose answer
    is in another column than the entry names."""
    a = aliased(AuditEntry)
    named = case(
        (func.json_valid(a.details) == 1, func.json_extract(a.details, "$.column_id")),
        else_=None,
    )
    own = exists().where(
        DatasetValue.id == a.entity_id,
        DatasetRow.id == DatasetValue.row_id,
        Dataset.id == DatasetRow.dataset_id,
        Dataset.project_id == a.project_id,
        or_(named.is_(None), named == DatasetValue.column_id),
    )
    return [i for (i,) in db.execute(
        select(a.id).where(_of_kind(a, ANSWER_EDIT), _holds_words(a, ANSWER_EDIT[2]), ~own)
    )]


def _load(db: Session, ids) -> list[AuditEntry]:
    out: list[AuditEntry] = []
    for chunk in _chunks(ids):
        out += db.query(AuditEntry).filter(AuditEntry.id.in_(chunk)).all()
    return out


def _in_a_closed_lifetime(lifetimes, sid: int, entry_id: int) -> bool:
    return any(made <= entry_id <= deleted for made, deleted in lifetimes.get(sid, ()))


def repair_leftover_words(db: Session) -> int:
    """D160 — strip the words an older build's delete left in the trail. Idempotent (a
    stripped entry holds no words, so a later run does not find it), and writes only what
    a read found (#1033). Returns the entries stripped; the caller commits."""
    turns = _with_words(_load(db, _turn_candidates(db)), SEGMENT_WORDING_KEYS)
    by_project: dict[int, list[AuditEntry]] = defaultdict(list)
    for e in turns:
        by_project[e.project_id].append(e)
    left: list[AuditEntry] = []
    for project_id, edits in by_project.items():
        lifetimes = segment_history(db, project_id).lifetimes()
        # A deleted merge result's or split child's: the walk's (#1473 b), while its
        # originals live — a conversation delete takes it with them (D157).
        left += [e for e in edits if not _in_a_closed_lifetime(lifetimes, e.entity_id, e.id)]
    answers = _with_words(_load(db, _answer_candidates(db)), ANSWER_EDIT[2])
    return _strip(db, [*left, *answers])
