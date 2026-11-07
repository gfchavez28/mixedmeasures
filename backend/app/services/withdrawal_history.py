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

SQLite reuses the newest row's id (no AUTOINCREMENT), so an Unmerge followed by any
merge gives the new result the deleted one's id, and its audit entries sit under the same
`entity_id`. So a deleted segment is read as a LIFETIME: the entries from the one that
created it to the one that deleted it. Audit ids rise in the order the entries were
written (#1230: audit rows are never deleted below a live project's own), so no clock
is needed. A live turn's own history starts after the last entry that created or deleted
its id — anything earlier was a previous holder's.

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

from sqlalchemy.orm import Session

from ..models.audit import AuditEntry
from ..models.segment import Segment
from .withdrawal_report import ReachedTurns

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
    #: Its originals' texts as they were when it was made (a live original's as its
    #: row holds it). A quote wholly inside ONE of these is that original's quote, and
    #: that original decides it — D8 when the turn is theirs, this walk when it is
    #: another deleted segment of theirs, nobody when it is someone else's turn. Only a
    #: quote across a join is this segment's to decide.
    parts: tuple[str, ...]


@dataclass(frozen=True)
class DeletedLineage:
    segments: tuple[DeletedSegment, ...]
    #: Every audit entry keyed on one of `segments` within its lifetime.
    audit_entry_ids: frozenset[int]

    def wordings_by_conversation(self) -> dict[int, list[tuple[str, tuple[str, ...]]]]:
        out: dict[int, list[tuple[str, tuple[str, ...]]]] = {}
        for seg in self.segments:
            for wording in seg.wordings:
                out.setdefault(seg.conversation_id, []).append((wording, seg.parts))
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


def deleted_lineage(db: Session, project_id: int, reached: ReachedTurns) -> DeletedLineage:
    """The deleted segments their words passed through (see the module).

    Call it BEFORE the reached turns are blanked: a merge result's text is rebuilt from
    its originals' texts as they stand, theirs included.
    """
    seeds: dict[int, int] = {}
    for by_conv in (reached.own, reached.combined):
        for conv_id, ids in by_conv.items():
            for sid in ids:
                seeds[sid] = conv_id
    if not seeds:
        return DeletedLineage((), frozenset())

    # Every structural entry of the project — one per merge or split a researcher made,
    # so the set is small next to the project. Nothing below reads them in row order:
    # the entry ids alone say which came first.
    made_from: dict[int, list[_Made]] = {}   # an original's id → the entries that took it
    made: dict[int, list[int]] = {}           # a result's id → the entries that made it
    deleted: dict[int, list[int]] = {}        # a segment id → the entries that deleted it
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

    def _start_of_live(sid: int) -> int:
        # The last entry that made or deleted this id: before it, a previous holder.
        return max([*made.get(sid, ()), *deleted.get(sid, ())], default=0)

    def _end_of(sid: int, after: int) -> int | None:
        # The first entry after its making that deleted this id ends the lifetime.
        return min((d for d in deleted.get(sid, ()) if d > after), default=None)

    # ── The walk, to a fixpoint: (id, lifetime start, lifetime end, conversation) ──
    found: dict[tuple[int, int], tuple[int, int, _Made]] = {}  # (id, made by) → (end, conv, entry)
    queue = [(sid, _start_of_live(sid), float("inf"), conv) for sid, conv in seeds.items()]
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

    # Earliest made first, so a nested merge's originals are resolved before it. An
    # original is asked about as it was WHEN the merge was made: its id may have been
    # their deleted segment then and someone else's since, or the other way round. A
    # deleted original offers EVERY wording it held (which one was current at the merge
    # is not recorded), so the outer text is rebuilt once per combination, capped.
    held: dict[int, list[tuple[int, int, tuple[str, ...]]]] = {}  # id → (start, end, wordings)

    def _texts_at(sid: int, when: int) -> tuple[str, ...]:
        for start, end, wordings in held.get(sid, ()):
            if start < when < end:
                return wordings
        return (live[sid][0],) if sid in live and live[sid][0] else ()

    segments: list[DeletedSegment] = []
    for (r, start), (end, conv, ev) in sorted(found.items(), key=lambda kv: kv[0][1]):
        wordings: list[str] = []
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
                        joined = MERGE_JOINER.join(combo)
                        if joined not in wordings:
                            wordings.append(joined)
        for w in edits.get((r, start), []):
            if w not in wordings:
                wordings.append(w)
        held.setdefault(r, []).append((start, end, tuple(wordings)))
        parts = tuple(t for o in ev.originals for t in _texts_at(o, ev.entry_id))
        segments.append(DeletedSegment(
            segment_id=r, conversation_id=conv, created_by=start, deleted_by=end,
            wordings=tuple(wordings), parts=parts,
        ))
    return DeletedLineage(tuple(segments), frozenset(entry_ids))


def _chunks(ids):
    ids = sorted(ids)
    for i in range(0, len(ids), _IN_CHUNK):
        yield ids[i:i + _IN_CHUNK]
