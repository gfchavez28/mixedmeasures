"""The DELETED segments that once held a withdrawn person's words (#1473 b, D5).

## Why a second walk

`withdrawal_report.reached_turns` follows history through the rows that still exist
(`merged_into_id`, `split_into_id`). An Unmerge DELETES the merge result and an Unsplit
deletes the split's children, and every link to them goes with the rows. What they held
stays in two places a withdrawal must reach:

- their audit entries — the conversation door's `segment_updated` keeps `old_text` /
  `new_text` (`routers/segments.py`), and the Excel Audit Trail exports them;
- a canvas copy of a quote made on a merge result — an orphan embed (its quote went with
  the segment) whose words span the merge's join, so D8's "inside one of their turns"
  never matches it.

The only record of a deleted segment is the audit trail, so this walks it: from each
reached turn, the `merged` / `split` entries that took it as an original, to the segment
each made, to the `unmerged` / `unsplit` entry that deleted that segment — and on, to a
fixpoint, through what was made from a deleted segment while it lived.

## A segment id names several segments over time

`segments` reuses the newest row's id (no AUTOINCREMENT — #1639's D319 gave it to nine
other tables and left `segments` out on purpose), so an Unmerge followed by any
merge gives the new result the deleted one's id, and its audit entries sit under the same
`entity_id`. So a deleted segment is read as a LIFETIME: the entries from the one that
created it to the one that deleted it. Audit ids rise in the order the entries were
written (#1230: audit rows are never deleted below a live project's own), so no clock
is needed. A live turn's own history starts after the last entry that created or deleted
its id — anything earlier was a previous holder's.

🔴 **Since #1547 (D159) that start is ONE function, `history_starts`, and every reader of a
live turn's entries asks it** — this walk's seeds, `apply_withdrawal`'s two reads (the
words an orphan quote is matched against, and the redaction set) and the conversation
delete (#1546). It also reads a THIRD bound: a conversation import makes its turns before
it writes its `imported` entry, so no entry before that entry is one of its turns'. Without
it, a turn an import gave a deleted interview's id took that interview's edits as its own
(an Unmerge is not the only way an id is freed — a conversation delete is another).

## A live original is read as it was AT THE MERGE (#1552 a)

A merge result's text is rebuilt from its originals. An original that still exists
may have been edited since the Unmerge, so its row's text is not what the merge
joined; the first text edit after the merge recorded that text as its `old_text`.
An original whose id an Unmerge or Unsplit freed after the merge, and whose words no
edit recorded, offers nothing: the row holding that id now is another segment.

## What it does NOT do

- It never adds a turn to the blanked set: everything it returns is deleted. A live turn
  holding their words is `reached_turns`' to find (through the UI it always is — the row
  actions act on visible segments only).
- A `.mmproject` carries no audit trail, so history from before an import is not walked —
  and the importing install holds no entries of it to redact.
- A deleted split child's text is not recorded anywhere unless it was edited, so a child is
  matched through its edits only; its unedited words are a slice of the original, which
  D8 already holds.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from itertools import islice, product

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.audit import AuditEntry
from ..models.segment import Segment
from .withdrawal_report import ReachedTurns

#: The conversation door's import entry (`routers/conversations.py::import_conversation`
#: — its only writer), keyed on the NEW conversation and written AFTER the turns it makes.
CONVERSATION_IMPORTED = "imported"

#: The conversation door's edit entry (`routers/segments.py::update_segment`). A TEXT
#: edit records `old_text`, the text it replaced (since before 1.0); a speaker-only
#: change records none.
SEGMENT_UPDATED = "segment_updated"

#: The keys of a conversation turn's `segment_updated` details that hold its WORDS. The
#: same entries carry structural strings too (#1319's `quote_rebase` outcomes "silent" /
#: "edge" / "straddle" / "gone"), so only these feed an orphan-embed match — a short
#: orphan embed reading "go" is a substring of "gone".
SEGMENT_WORDING_KEYS = ("old_text", "new_text")

#: The structural actions the walk reads, all keyed on `entity_type="segment"`
#: (`services/segment_operations.py`). The clip actions (`clip_merge`, …) are an
#: observation's, whose clips have no speaker and so no participant.
MERGED, UNMERGED, SPLIT, UNSPLIT = "merged", "unmerged", "split", "unsplit"
HISTORY_ACTIONS = (MERGED, UNMERGED, SPLIT, UNSPLIT)

#: `merge_segments` joins the originals' texts with this, in turn order.
MERGE_JOINER = " "

#: At most this many rebuilt texts per merge order. Each deleted original offers every
#: wording it held, and a merge of several edited ones multiplies them; past the cap a
#: quote made on an unlisted combination is not matched — a residual of a merge of
#: merges whose parts were each edited many times.
MAX_REBUILT = 256

_IN_CHUNK = 5000

#: `[start, end)` ranges of a text (#1613: where the withdrawn person's words sit).
Spans = tuple[tuple[int, int], ...]


def _joined_spans(combo) -> Spans | None:
    """Where their parts sit once `combo`'s `(text, spans)` are joined by the merge."""
    out: list[tuple[int, int]] = []
    at = 0
    for text, spans in combo:
        if spans is None:
            return None
        out.extend((at + s, at + e) for s, e in spans)
        at += len(text) + len(MERGE_JOINER)
    return tuple(out)


@dataclass(frozen=True)
class DeletedSegment:
    """One deleted merge result or split child, in one lifetime of its id."""

    segment_id: int
    conversation_id: int
    #: The audit entries that made it and deleted it — its lifetime's bounds.
    created_by: int
    deleted_by: int
    #: What it held: a merge result's text rebuilt from its originals, and every
    #: wording its edits recorded.
    wordings: tuple[str, ...]
    #: Its originals' texts as they were when it was made (a live original's from the
    #: first edit after the merge, else as its row holds it — #1552 a). A quote wholly
    #: inside ONE of these is that original's quote, and
    #: that original decides it — D8 when the turn is theirs, this walk when it is
    #: another deleted segment of theirs, nobody when it is someone else's turn. Only a
    #: quote across a join is this segment's to decide.
    parts: tuple[str, ...]
    #: #1613 — per wording (same order), WHERE their words sit in it: the `[start, end)`
    #: ranges of the parts that are theirs — their own turn, a turn holding theirs
    #: combined (D7 blanks it whole), what a deleted segment of theirs held there. A
    #: quote across a join is theirs only if it reaches one of these: across two OTHER
    #: people's join it is neither's to lose. `None` where that is not known — an
    #: EDIT's wording of a segment that also held someone else's words.
    spans: tuple[Spans | None, ...] = ()


@dataclass(frozen=True)
class DeletedLineage:
    segments: tuple[DeletedSegment, ...]
    #: Every audit entry keyed on one of `segments` within its lifetime.
    audit_entry_ids: frozenset[int]

    def wordings_by_conversation(
        self,
    ) -> dict[int, list[tuple[str, tuple[str, ...], Spans | None]]]:
        out: dict[int, list[tuple[str, tuple[str, ...], Spans | None]]] = {}
        for seg in self.segments:
            for i, wording in enumerate(seg.wordings):
                spans = seg.spans[i] if i < len(seg.spans) else None
                out.setdefault(seg.conversation_id, []).append((wording, seg.parts, spans))
        return out


@dataclass(frozen=True)
class _Made:
    """A `merged` or `split` entry: the originals it took and the segments it made."""

    entry_id: int
    action: str
    originals: tuple[int, ...]
    results: tuple[int, ...]


def _ids(value) -> tuple[int, ...]:
    if not isinstance(value, list):
        return ()
    out = []
    for v in value:
        if isinstance(v, bool):
            continue
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return tuple(out)


def _parse(raw) -> dict:
    try:
        parsed = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def wording_in(raw: str | None, keys=SEGMENT_WORDING_KEYS) -> list[str]:
    """The words an audit entry's details recorded under `keys`, and no other string.

    The ONE reader of an entry's wording for a withdrawal: `withdrawal_redaction`
    reads its reached turns' and answers' entries through it too (pinned by
    `test_withdrawal_edit_wording.py`).
    """
    parsed = _parse(raw)
    return [v for k in keys if isinstance(v := parsed.get(k), str) and v]


@dataclass(frozen=True)
class SegmentHistory:
    """Every structural entry of a project, read once (#1547: shared by the walk, the
    history starts, the conversation delete and the startup repair)."""

    #: an original's id → the entries that took it
    made_from: dict[int, list[_Made]]
    #: a result's id → the entries that made it
    made: dict[int, list[int]]
    #: a segment id → the entries that deleted it (an Unmerge or an Unsplit)
    deleted: dict[int, list[int]]

    def lifetimes(self) -> dict[int, list[tuple[int, int]]]:
        """Each id's closed lifetimes `(made by, deleted by)` — a merge result or split
        child an Unmerge or Unsplit deleted. The entries inside one belong to that
        segment, which the walk can still find (#1473 b)."""
        out: dict[int, list[tuple[int, int]]] = {}
        for sid, makers in self.made.items():
            for m in makers:
                end = min((d for d in self.deleted.get(sid, ()) if d > m), default=None)
                if end is not None:
                    out.setdefault(sid, []).append((m, end))
        return out


def segment_history(db: Session, project_id: int) -> SegmentHistory:
    """Every structural entry of the project — one per merge or split a researcher made,
    so the set is small next to the project. Nothing reads them in row order: the entry
    ids alone say which came first."""
    made_from: dict[int, list[_Made]] = {}
    made: dict[int, list[int]] = {}
    deleted: dict[int, list[int]] = {}
    for entry_id, action, entity_id, raw in (
        db.query(AuditEntry.id, AuditEntry.action, AuditEntry.entity_id, AuditEntry.details)
        .filter(
            AuditEntry.project_id == project_id,
            AuditEntry.entity_type == "segment",
            AuditEntry.action.in_(HISTORY_ACTIONS),
        )
    ):
        details = _parse(raw)
        if action == MERGED and entity_id is not None:
            ev = _Made(entry_id, action, _ids(details.get("merged_segment_ids")), (entity_id,))
        elif action == SPLIT:
            originals = (
                _ids(details.get("original_segment_ids"))
                or _ids([details.get("original_segment_id", entity_id)])
            )
            ev = _Made(entry_id, action, originals, _ids(details.get("new_segment_ids")))
        elif action == UNMERGED and entity_id is not None:
            deleted.setdefault(entity_id, []).append(entry_id)
            continue
        elif action == UNSPLIT:
            for sid in _ids(details.get("deleted_split_ids")):
                deleted.setdefault(sid, []).append(entry_id)
            continue
        else:
            continue
        for o in ev.originals:
            made_from.setdefault(o, []).append(ev)
        for r in ev.results:
            made.setdefault(r, []).append(entry_id)
    return SegmentHistory(made_from, made, deleted)


def _conversation_floors(db: Session, project_id: int, conversation_ids) -> dict[int, int]:
    """The LATEST `imported` entry per conversation id. Conversation ids are reused too,
    so an earlier holder's entry may be found — it can only be EARLIER than the live
    conversation's own, never later, so a bound built on it never cuts real history."""
    out: dict[int, int] = {}
    for chunk in _chunks(set(conversation_ids)):
        for cid, top in (
            db.query(AuditEntry.entity_id, func.max(AuditEntry.id))
            .filter(
                AuditEntry.project_id == project_id,
                AuditEntry.entity_type == "conversation",
                AuditEntry.action == CONVERSATION_IMPORTED,
                AuditEntry.entity_id.in_(chunk),
            )
            .group_by(AuditEntry.entity_id)
        ):
            out[cid] = top
    return out


def history_starts(
    db: Session,
    project_id: int,
    conv_of: dict[int, int],
    history: SegmentHistory | None = None,
) -> dict[int, int]:
    """#1547 (D159) — per live turn (`{turn id: its conversation id}`), the lowest audit
    entry id that can be its own. Its entries are those with `id >= start`.

    The max of three lower bounds, each never later than the truth, so the max never
    cuts a turn's real history (an entry it misses would keep a withdrawn person's words):
    - the last entry that MADE its id — a merge or split, which is its own;
    - one past the last entry that DELETED its id — an Unmerge or Unsplit; before it, a
      previous holder;
    - one past its conversation's latest `imported` entry, which the import writes after
      the turns it makes.
    A turn a `.mmproject` merge inserted has neither of the last two to read (stated in
    #1547's review as a residual; since #1546 D157 a previous holder's entry there holds
    no words).
    """
    h = history or segment_history(db, project_id)
    floors = _conversation_floors(db, project_id, conv_of.values())
    out: dict[int, int] = {}
    for sid, cid in conv_of.items():
        start = 0
        if h.made.get(sid):
            start = max(start, max(h.made[sid]))
        if h.deleted.get(sid):
            start = max(start, max(h.deleted[sid]) + 1)
        if cid in floors:
            start = max(start, floors[cid] + 1)
        out[sid] = start
    return out


def deleted_lineage(
    db: Session,
    project_id: int,
    reached: ReachedTurns,
    history: SegmentHistory | None = None,
) -> DeletedLineage:
    """The deleted segments their words passed through (see the module).

    Call it BEFORE the reached turns are blanked: a merge result's text is rebuilt from
    its originals' texts as they stand, theirs included. `history` saves a caller that
    already read the structural entries a second pass.
    """
    seeds: dict[int, int] = {}
    for by_conv in (reached.own, reached.combined):
        for conv_id, ids in by_conv.items():
            for sid in ids:
                seeds[sid] = conv_id
    if not seeds:
        return DeletedLineage((), frozenset())

    h = history or segment_history(db, project_id)
    made_from, deleted = h.made_from, h.deleted
    # A seed's own history starts where `history_starts` says; `lo` is exclusive.
    starts = history_starts(db, project_id, seeds, h)

    def _end_of(sid: int, after: int) -> int | None:
        # The first entry after its making that deleted this id ends the lifetime.
        return min((d for d in deleted.get(sid, ()) if d > after), default=None)

    # ── The walk, to a fixpoint: (id, lifetime start, lifetime end, conversation) ──
    found: dict[tuple[int, int], tuple[int, int, _Made]] = {}  # (id, made by) → (end, conv, entry)
    queue = [(sid, starts[sid] - 1, float("inf"), conv) for sid, conv in seeds.items()]
    while queue:
        sid, lo, hi, conv = queue.pop()
        for ev in made_from.get(sid, ()):
            if not (lo < ev.entry_id < hi):
                continue
            for r in ev.results:
                end = _end_of(r, ev.entry_id)
                if end is None or (r, ev.entry_id) in found:
                    continue  # never deleted: it is live, and `reached_turns`' to find
                found[(r, ev.entry_id)] = (end, conv, ev)
                queue.append((r, ev.entry_id, end, conv))
    if not found:
        return DeletedLineage((), frozenset())

    # ── Their lifetimes' own entries: the edits' words, and what to redact ──
    windows: dict[int, list[tuple[int, int]]] = {}
    for (r, start), (end, _, _) in found.items():
        windows.setdefault(r, []).append((start, end))
    entry_ids: set[int] = set()
    edits: dict[tuple[int, int], list[str]] = {}
    for chunk in _chunks(windows):
        for entry_id, entity_id, raw in db.query(
            AuditEntry.id, AuditEntry.entity_id, AuditEntry.details,
        ).filter(
            AuditEntry.project_id == project_id,
            AuditEntry.entity_type == "segment",
            AuditEntry.entity_id.in_(chunk),
        ):
            for start, end in windows[entity_id]:
                if start <= entry_id <= end:
                    entry_ids.add(entry_id)
                    edits.setdefault((entity_id, start), []).extend(wording_in(raw))

    # ── A merge result's text, rebuilt from its originals ──
    originals = {o for (_, _, ev) in found.values() for o in ev.originals}
    live: dict[int, tuple[str, int]] = {}
    for chunk in _chunks(originals):
        for sid, text, order in db.query(
            Segment.id, Segment.text, Segment.sequence_order,
        ).filter(Segment.id.in_(chunk)):
            live[sid] = (text or "", order)

    # #1552 (a) — a LIVE original's text WHEN the merge was made. Its row holds today's
    # text, and an edit after the Unmerge changed it, so a merge rebuilt from it no
    # longer held a quote made across the join. The edit door acts on visible turns
    # only (`routers/segments.py::_editable_segment_or_404`), so nothing edits an
    # original while it is merged away, and it records the text it replaced: the FIRST
    # text edit after the merge, inside the original's own lifetime, replaced exactly
    # what the merge joined. One text per live original, so this adds nothing to the
    # product `MAX_REBUILT` caps (only a DELETED original offers several wordings).
    replaced: dict[int, list[tuple[int, object]]] = {}  # id → [(entry id, old_text)]
    for chunk in _chunks(live):
        for entry_id, entity_id, raw in db.query(
            AuditEntry.id, AuditEntry.entity_id, AuditEntry.details,
        ).filter(
            AuditEntry.project_id == project_id,
            AuditEntry.entity_type == "segment",
            AuditEntry.action == SEGMENT_UPDATED,
            AuditEntry.entity_id.in_(chunk),
        ):
            details = _parse(raw)
            if "old_text" in details:  # a text edit; a speaker change records none
                replaced.setdefault(entity_id, []).append((entry_id, details["old_text"]))

    def _live_text_at(sid: int, when: int) -> str:
        # An Unmerge or Unsplit after the merge that deleted this id ended that
        # original's life; the row holding the id now is a later segment (#1547's
        # class), so neither its text nor its edits are the original's.
        end = _end_of(sid, when)
        for entry_id, old in sorted(replaced.get(sid, ())):
            if when < entry_id and (end is None or entry_id < end):
                # A redacted entry (D9) keeps the key and no words: what the merge
                # joined was someone's withdrawn words, and is not recorded.
                return old if isinstance(old, str) else ""
        return live[sid][0] if end is None else ""

    # Earliest made first, so a nested merge's originals are resolved before it. An
    # original is asked about as it was WHEN the merge was made: its id may have been
    # their deleted segment then and someone else's since, or the other way round. A
    # deleted original offers EVERY wording it held (which one was current at the merge
    # is not recorded), so the outer text is rebuilt once per combination, capped.
    # Each option is `(text, spans)`: #1613 — where THEIR words sit in it, so a quote
    # across a join between two other people's parts is not taken as theirs.
    # id → (start, end, options, wholly theirs)
    held: dict[int, list[tuple[int, int, tuple[tuple[str, Spans | None], ...], bool]]] = {}

    def _held_at(sid: int, when: int):
        for start, end, options, whole in held.get(sid, ()):
            if start < when < end:
                return options, whole
        return None

    def _texts_at(sid: int, when: int) -> tuple[tuple[str, Spans | None], ...]:
        h = _held_at(sid, when)
        if h is not None:
            return h[0]
        text = _live_text_at(sid, when) if sid in live else ""
        if not text:
            return ()
        # A live original is theirs whole when it is one of their reached turns: their
        # own, or a turn holding theirs combined (D7 blanks it whole) — else nobody's here.
        return ((text, ((0, len(text)),) if sid in seeds else ()),)

    def _wholly_theirs(sid: int, when: int) -> bool:
        h = _held_at(sid, when)
        return h[1] if h is not None else sid in seeds

    segments: list[DeletedSegment] = []
    for (r, start), (end, conv, ev) in sorted(found.items(), key=lambda kv: kv[0][1]):
        wordings: list[str] = []
        spans: list[Spans | None] = []
        if ev.action == MERGED:
            options = {o: _texts_at(o, ev.entry_id) for o in ev.originals}
            if all(options.values()):
                # The merge joined them in turn order; the entry keeps the ids as the
                # request sent them. Both, because a HIDDEN turn keeps the position it
                # had when hidden while undoing an earlier merge moves the visible
                # ones, so today's positions can put the two turns the wrong way round.
                by_turn = sorted(ev.originals, key=lambda o: (live.get(o, ("", 0))[1], o))
                for order in (by_turn, list(ev.originals)):
                    for combo in islice(product(*(options[o] for o in order)), MAX_REBUILT):
                        joined = MERGE_JOINER.join(t for t, _ in combo)
                        if joined not in wordings:
                            wordings.append(joined)
                            spans.append(_joined_spans(combo))
        # An edit's wording has no join to place their words by: wholly theirs only when
        # every original was (a split of their turn, a merge of their own turns).
        whole = all(_wholly_theirs(o, ev.entry_id) for o in ev.originals)
        for w in edits.get((r, start), []):
            if w not in wordings:
                wordings.append(w)
                spans.append(((0, len(w)),) if whole else None)
        held.setdefault(r, []).append((start, end, tuple(zip(wordings, spans)), whole))
        parts = tuple(t for o in ev.originals for t, _ in _texts_at(o, ev.entry_id))
        segments.append(DeletedSegment(
            segment_id=r, conversation_id=conv, created_by=start, deleted_by=end,
            wordings=tuple(wordings), parts=parts, spans=tuple(spans),
        ))
    return DeletedLineage(tuple(segments), frozenset(entry_ids))


def _chunks(ids):
    ids = sorted(ids)
    for i in range(0, len(ids), _IN_CHUNK):
        yield ids[i:i + _IN_CHUNK]
