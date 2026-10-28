"""Rewrite every canvas copy of a quote a withdrawal removes (#1320).

## Why a canvas needs its own pass

An `excerpt-embed` is a SNAPSHOT: `displayText` is the quote's words as they were
when it was inserted, and nothing re-reads them (`frontend/src/components/canvas/
the internal design notes). That is right for a researcher's writing — a quote should not change
under them — and it means deleting an `Excerpt` leaves the words on the canvas, in
`searchable_text`, in every snapshot, in the Canvas DOCX and in the `.mmproject`.
A withdrawal is the one act that must reach them, so it rewrites them itself.

⚠️ **Not `refresh_theme_content`.** It re-reads a LIVE excerpt by id, so for a
deleted one it does nothing (`{"refreshed": false}`, measured), and with SQLite's id
reuse it would copy an unrelated quote into the embed (#1192).

## What is rewritten

| Copy | Action |
|---|---|
| a theme's embed of a removed quote | `displayText` → the blanked-turn text, `excerptId` → null, then `update_theme_content` (which rebuilds `searchable_text` and `referenced_source_ids`) |
| the same embed inside each snapshot's theme copies | the same rewrite, and the copy's `searchable_text` / `referenced_source_ids` rebuilt by the same extractors |
| a snapshot's inbox entry for a removed quote | dropped |
| a live inbox item (`CanvasPendingItem`) for a removed quote | DELETED — left in place, the next quote given that id would appear in its place (#1192) |
| an ORPHAN embed (its quote deleted before the withdrawal) in a conversation where they spoke, whose text is inside one of their turns | the same rewrite (decision D8) |

An embed is an orphan when its `excerptId` names no live quote, or names a live
quote that no longer says what the embed shows (the id was reused). One bound to a
live quote saying exactly its words is someone's current quote and is left alone,
even when the same words also occur in a withdrawn turn.

⛔ **It never raises "softly".** A theme or snapshot it cannot read might hold the
words, so it raises `CanvasScrubError` and the withdrawal rolls back — the
opposite of `material_config.normalise_rc_keys`, whose job is a repair that must
never block startup. Here, an incomplete removal reported as complete is the
failure that matters.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict

from sqlalchemy.orm import Session

from ..models.canvas import Canvas, CanvasPendingItem, CanvasSnapshot, CanvasTheme
from ..models.dataset import DatasetValue
from ..models.excerpt import Excerpt, excerpt_text_from
from ..models.segment import Segment
from .canvas import (
    extract_referenced_source_ids,
    extract_theme_searchable_text,
    update_theme_content,
    walk_tiptap_nodes,
)

EXCERPT_EMBED = "excerpt-embed"
#: The `CanvasPendingItem.item_type` of a quote in a canvas's inbox.
EXCERPT_ITEM_TYPE = "excerpt"


class CanvasScrubError(RuntimeError):
    """A canvas copy could not be read, so the withdrawal cannot vouch for it."""


@dataclass
class EmbedScrubOutcome:
    """What the pass changed. Counts only — never the words it removed."""

    #: Embeds rewritten on live themes, and the themes that held them.
    embeds_scrubbed: int = 0
    themes_rewritten: int = 0
    #: Embeds rewritten inside snapshot copies, and the snapshots rewritten.
    snapshot_embeds_scrubbed: int = 0
    snapshots_rewritten: int = 0
    #: Live inbox rows deleted, and inbox entries dropped from snapshots.
    inbox_items_removed: int = 0
    snapshot_inbox_entries_removed: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def _as_int(value) -> int | None:
    """An embed's id attr as an int — Tiptap writes a number, an import may not."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse(raw, what: str):
    if raw is None or raw == "":
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise CanvasScrubError(
            f"{what} could not be read, so a withdrawal cannot confirm it holds none "
            "of this person's quotes."
        ) from exc


def _embed_attrs(doc) -> list[dict]:
    found: list[dict] = []

    def _collect(node: dict) -> None:
        attrs = node.get("attrs")
        if isinstance(attrs, dict):
            found.append(attrs)

    walk_tiptap_nodes(doc, {EXCERPT_EMBED}, _collect)
    return found


def scrub_excerpt_embeds(
    db: Session,
    project_id: int,
    excerpt_ids,
    *,
    replacement_text: str,
    words_by_conversation: dict[int, list[str]] | None = None,
) -> EmbedScrubOutcome:
    """Rewrite every canvas copy of the quotes in `excerpt_ids` (see the module).

    `excerpt_ids` are quotes the caller is removing (on segments AND on dataset
    values). `words_by_conversation` maps a conversation id to the texts the
    withdrawn person's turns held BEFORE they were blanked — what an orphan embed is
    matched against (D8). Call it after the quotes are deleted; it flushes and does
    not commit.
    """
    removed = {i for i in (_as_int(x) for x in excerpt_ids) if i is not None}
    words = {
        conv: [t for t in texts if t]
        for conv, texts in (words_by_conversation or {}).items()
    }
    out = EmbedScrubOutcome()

    # ── Read every copy first: the orphan rule needs the live quotes they name ──
    themes = (
        db.query(CanvasTheme)
        .join(Canvas, CanvasTheme.canvas_id == Canvas.id)
        .filter(Canvas.project_id == project_id, CanvasTheme.content.isnot(None))
        .order_by(CanvasTheme.id)
        .all()
    )
    theme_docs = [
        (theme, _parse(theme.content, f"The canvas section “{theme.name}”"))
        for theme in themes
    ]

    snapshots = (
        db.query(CanvasSnapshot)
        .join(Canvas, CanvasSnapshot.canvas_id == Canvas.id)
        .filter(Canvas.project_id == project_id)
        .order_by(CanvasSnapshot.id)
        .all()
    )
    snapshot_docs = []
    for snap in snapshots:
        data = _parse(snap.snapshot_data, f"The canvas snapshot “{snap.name}”")
        if not isinstance(data, dict):
            raise CanvasScrubError(
                f"The canvas snapshot “{snap.name}” could not be read, so a withdrawal "
                "cannot confirm it holds none of this person's quotes."
            )
        copies = []
        for item in data.get("themes") or []:
            if not isinstance(item, dict):
                continue
            copies.append((item, _parse(
                item.get("content"),
                f"A section of the canvas snapshot “{snap.name}”",
            )))
        snapshot_docs.append((snap, data, copies))

    named: set[int] = set()
    for _, doc in theme_docs + [c for _, _, cs in snapshot_docs for c in cs]:
        for attrs in _embed_attrs(doc):
            eid = _as_int(attrs.get("excerptId"))
            if eid is not None and eid not in removed:
                named.add(eid)
    live: dict[int, str] = {}
    if named:
        for eid, seg_text, lo, hi, value_text in (
            db.query(
                Excerpt.id, Segment.text, Excerpt.start_offset, Excerpt.end_offset,
                DatasetValue.value_text,
            )
            .outerjoin(Segment, Excerpt.segment_id == Segment.id)
            .outerjoin(DatasetValue, Excerpt.dataset_value_id == DatasetValue.id)
            .filter(Excerpt.project_id == project_id, Excerpt.id.in_(sorted(named)))
        ):
            live[eid] = excerpt_text_from(seg_text, lo, hi, value_text)

    def _theirs(attrs: dict) -> bool:
        eid = _as_int(attrs.get("excerptId"))
        if eid is not None and eid in removed:
            return True
        texts = words.get(_as_int(attrs.get("conversationId")))
        shown = attrs.get("displayText")
        shown = shown.strip() if isinstance(shown, str) else ""
        if not texts or not shown:
            return False
        if eid is not None and eid in live and live[eid].strip() == shown:
            return False  # someone's current quote, saying exactly this
        return any(shown in t for t in texts)

    def _scrub(doc) -> int:
        hits = 0
        for attrs in _embed_attrs(doc):
            if _theirs(attrs):
                attrs["displayText"] = replacement_text
                attrs["excerptId"] = None
                hits += 1
        return hits

    # ── Live themes: through `update_theme_content`, which rebuilds the two
    # derived columns from the rewritten document ──
    for theme, doc in theme_docs:
        hits = _scrub(doc)
        if hits:
            update_theme_content(db, theme, doc)
            out.embeds_scrubbed += hits
            out.themes_rewritten += 1

    # ── Snapshots: the same rewrite on each theme copy, the copy's derived
    # fields rebuilt by the same extractors, and the inbox entries dropped ──
    for snap, data, copies in snapshot_docs:
        changed = False
        for item, doc in copies:
            hits = _scrub(doc)
            if hits:
                item["content"] = json.dumps(doc) if doc else None
                item["searchable_text"] = extract_theme_searchable_text(doc)
                refs = extract_referenced_source_ids(doc)
                item["referenced_source_ids"] = json.dumps(refs) if refs else None
                out.snapshot_embeds_scrubbed += hits
                changed = True
        pending = data.get("pending_items")
        if isinstance(pending, list):
            kept = [
                p for p in pending
                if not (
                    isinstance(p, dict)
                    and p.get("item_type") == EXCERPT_ITEM_TYPE
                    and _as_int(p.get("source_id")) in removed
                )
            ]
            if len(kept) != len(pending):
                out.snapshot_inbox_entries_removed += len(pending) - len(kept)
                data["pending_items"] = kept
                changed = True
        if changed:
            snap.snapshot_data = json.dumps(data)
            out.snapshots_rewritten += 1

    # ── The live inbox: deleted, so a reused id cannot rebind it (#1192) ──
    if removed:
        canvas_ids = [
            cid for (cid,) in db.query(Canvas.id).filter(Canvas.project_id == project_id)
        ]
        if canvas_ids:
            out.inbox_items_removed = (
                db.query(CanvasPendingItem)
                .filter(
                    CanvasPendingItem.canvas_id.in_(canvas_ids),
                    CanvasPendingItem.item_type == EXCERPT_ITEM_TYPE,
                    CanvasPendingItem.source_id.in_(sorted(removed)),
                )
                .delete(synchronize_session=False)
            )
    db.flush()
    return out
