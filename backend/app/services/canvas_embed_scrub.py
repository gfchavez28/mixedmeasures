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
| an ORPHAN embed of an ANSWER — no conversation and no clip — whose text EQUALS a wording one of their answers held (#1473) | the same rewrite |
| an ORPHAN embed of a merge result an Unmerge DELETED (#1473 b) — inside its text rebuilt from the originals as they read at the merge (#1552 a), wholly inside no single original, and reaching THEIR part (#1613) | the same rewrite |
| a quote PINNED in a joint display (D163) — every row above applies to it, in themes and snapshots alike | the same rewrite, inside the display (`_embed_attrs`) — and the pin's `purpose`, the researcher's line about why that quote is there, goes with it (#1674 D356: D314's rule for a misfit case's reason) |
| a joint display row's drift stamp (D168.5) — the cells as they printed when its meta-inference was saved | every stamp in the project is CLEARED: `hash` and `cells` removed, the date kept, `cleared: "withdrawal"` (#1674 D357; `clear_drift_stamps`) |

An embed is an orphan when its `excerptId` names no live quote, or names a live
quote that no longer says what the embed shows (the id was reused). One bound to a
live quote saying exactly its words is someone's current quote and is left alone,
even when the same words also occur in a withdrawn turn or answer.

⚠️ **An answer is matched by EQUALITY, a turn by containment.** A quote of a turn
can be a slice of it (char-range); a quote of an answer is always the WHOLE answer
(`excerpt_text_from` ignores offsets on a value), so its embed shows exactly a
wording the answer once held. Containment would also take someone else's deleted
quote of a short answer ("No") that happens to sit inside one of theirs. The embed
carries no value id, which is why it is text at all: its `conversationId` is null
and nothing else names the answer.

⛔ **It never raises "softly".** A theme or snapshot it cannot read might hold the
words, so it raises `CanvasScrubError` and the withdrawal rolls back — the
opposite of `material_config.normalise_rc_keys`, whose job is a repair that must
never block startup. Here, an incomplete removal reported as complete is the
failure that matters.

## What it cannot place, and says so (#1546, D158)

An embed names no speaker and no answer — `sourceContext` is the source's NAME only —
so an orphan whose source is gone cannot be tied to anyone, and the rules above leave
it. Two kinds, both orphans (no live quote saying their words), neither the blanked
placeholder:

- a quote of a TURN whose conversation no longer exists in this project (D8 has no
  turns to look inside);
- a quote with no conversation and no clip — of an ANSWER or a DOCUMENT passage, which
  an embed cannot tell apart — that equals none of the person's answers' wordings.

They are COUNTED, with the canvas sections and snapshots that hold them, and handed to
a person — the posture of `withdrawal_redaction.py`'s notes and memos. Never guessed:
matching an orphan against their turns in EVERY conversation would blank another
person's short quote ("I agree") that sits inside one of theirs (#1547's harm), and
stamping whose words an embed shows would be a new JSON-held identity to remap on
every import. ONE predicate, `_Judge.unplaced`, beside `_Judge.theirs`: the report
asks it before the act (`unplaced_canvas_quotes`) and the act counts with it after
deciding what is theirs (`EmbedScrubOutcome.quotes_unplaced`), so the two cannot
disagree. A clip's text is the researcher's label, never a person's words, and is
never counted.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, asdict, field
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from ..models.canvas import Canvas, CanvasPendingItem, CanvasSnapshot, CanvasTheme
from ..models.conversation import Conversation
from ..models.dataset import DatasetValue
from ..models.excerpt import Excerpt, excerpt_text_from
from ..models.segment import Segment
from .canvas import (
    extract_referenced_source_ids,
    extract_theme_searchable_text,
    update_theme_content,
    walk_tiptap_nodes,
)
from .joint_display_node import (
    JOINT_DISPLAY_NODE,
    MISFIT_CASE_LISTS,
    MISFIT_KEY,
    UnreadableDisplay,
    display_of,
    display_pins,
    display_rows,
    row_misfit_cases,
)

if TYPE_CHECKING:  # the walk's module reaches the report's, which reaches this one
    from .withdrawal_history import Spans

EXCERPT_EMBED = "excerpt-embed"
#: The `CanvasPendingItem.item_type` of a quote in a canvas's inbox.
EXCERPT_ITEM_TYPE = "excerpt"


class CanvasScrubError(RuntimeError):
    """A canvas copy could not be read, so the withdrawal (or the delete) cannot vouch for it."""


#: #1651 (D338) — which act is reading the canvas, so a copy it cannot read is refused in THAT
#: act's words. The withdrawal looks for the person's quotes and cases; a plain participant
#: delete (`routers/participants.py::delete_participant`) looks only for their cases, and
#: nothing is being withdrawn — "so a withdrawal cannot confirm…" was false of it.
#: #1667 (D341) — the withdrawal REPORT is a third reader: one report serves the delete confirm,
#: the withdrawal confirm and the participant panel, so its words claim neither act.
ACT_WITHDRAWAL = "withdrawal"
ACT_DELETE = "delete"
ACT_REPORT = "report"
#: What failed to read (D341): a whole ``"copy"`` (a section or a snapshot that does not parse), or
#: a joint display inside a readable one, walked for its pins (``"quotes"``) or for its lists of
#: cases that don't fit (``"cases"``).
_UNREADABLE_TAIL = {
    (ACT_WITHDRAWAL, "copy"): "so a withdrawal cannot confirm it holds none of this person's quotes.",
    (ACT_WITHDRAWAL, "quotes"): "so a withdrawal cannot confirm it holds none of this person's quotes.",
    (ACT_WITHDRAWAL, "cases"): "so a withdrawal cannot confirm it names none of this person's cases.",
    # The delete reads for one thing, whichever copy failed: a section, a snapshot, a display.
    (ACT_DELETE, "copy"): "so it cannot be checked whether a joint display there lists this "
                          "person among its cases that don't fit.",
    (ACT_DELETE, "quotes"): "so it cannot be checked whether it lists this person among its "
                            "cases that don't fit.",
    (ACT_DELETE, "cases"): "so it cannot be checked whether it lists this person among its "
                           "cases that don't fit.",
    (ACT_REPORT, "copy"): "so what it holds of this person cannot be checked.",
    (ACT_REPORT, "quotes"): "so what it holds of this person cannot be checked.",
    (ACT_REPORT, "cases"): "so what it holds of this person cannot be checked.",
}


def _unreadable(act: str, about: str) -> str:
    """The end of a "… could not be read," sentence for ``act`` (fails closed on an unknown one)."""
    try:
        return _UNREADABLE_TAIL[(act, about)]
    except KeyError:
        raise ValueError(f"unknown canvas scrub act: {act!r}") from None


def _section_place(canvas_name: str, theme_name: str) -> str:
    """#1667 (D341) — a live section as the report's unplaced-quotes note names one."""
    return f"the canvas section “{canvas_name} › {theme_name}”"


def _snapshot_place(canvas_name: str, snapshot_name: str) -> str:
    """#1667 (D341) — a snapshot as the report's unplaced-quotes note names one."""
    return f"the snapshot “{snapshot_name}” of “{canvas_name}”"


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
    #: D158 — embeds it could not place and so LEFT (themes and snapshot copies).
    quotes_unplaced: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class UnplacedCanvasPlace:
    """One canvas section, or one snapshot, holding quotes a withdrawal cannot place.

    The researcher's own names only — never the words (D158).
    """

    canvas_id: int
    canvas_name: str
    #: The section's id (`CanvasTheme.id`) or the snapshot's (`CanvasSnapshot.id`).
    id: int
    name: str
    quotes: int = 0


@dataclass
class UnplacedCanvasQuotes:
    """#1546 (D158) — the canvas quotes a withdrawal cannot place, and where they are.

    `quotes` counts every embed, a snapshot's copy included (a restore brings it back).
    """

    quotes: int = 0
    sections: list[UnplacedCanvasPlace] = field(default_factory=list)
    snapshots: list[UnplacedCanvasPlace] = field(default_factory=list)


def _as_int(value) -> int | None:
    """An embed's id attr as an int — Tiptap writes a number, an import may not."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse(raw, what: str, act: str):
    if raw is None or raw == "":
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise CanvasScrubError(f"{what} could not be read, {_unreadable(act, 'copy')}") from exc


def _embed_attrs(doc, *, where: str, act: str) -> list[dict]:
    """Every canvas quote in one document, as the live attribute dicts — the scrub's ONE
    walk, so the report and the act see the same quotes.

    An `excerpt-embed`'s attrs, and each quote PINNED in a joint display (D163): a pin
    carries exactly an embed's attributes, so `_Judge` decides it unchanged and the
    rewrite below lands inside the display. A display it cannot walk might hold the
    person's words, so it raises (the module's fail-closed rule) — naming ``where`` the
    document lives (`_section_place` / `_snapshot_place`), in ``act``'s words (#1667, D341).
    """
    found: list[dict] = []

    def _collect(node: dict) -> None:
        attrs = node.get("attrs")
        if not isinstance(attrs, dict):
            return
        if node.get("type") != JOINT_DISPLAY_NODE:
            found.append(attrs)
            return
        try:
            display = display_of(attrs, strict=True)
            if display is not None:
                found.extend(display_pins(display, strict=True))
        except UnreadableDisplay as exc:
            raise CanvasScrubError(
                f"A joint display in {where} could not be read, {_unreadable(act, 'quotes')}"
            ) from exc

    walk_tiptap_nodes(doc, {EXCERPT_EMBED, JOINT_DISPLAY_NODE}, _collect)
    return found


def holds_canvas_quotes(doc) -> bool:
    """Whether a document holds any quote this scrub would judge — an excerpt embed or a
    joint display's pin (#1301: a deleted theme's undo asks it).

    A section copy kept OUTSIDE the project's themes and snapshots — the record a delete hands
    its undo — is a copy no withdrawal reaches, so a restore after a withdrawal must hold none.
    Same walk as the scrub (`_embed_attrs`), so the two cannot disagree about what a quote is;
    a display it cannot read counts as holding one (fail closed).
    """
    # The record is outside every canvas and the refusal is never shown (it reads as "holds
    # one"), so the place named is only a placeholder.
    where = "a deleted section"
    try:
        # Joint display slice 2 (r3-6): a picked case names a participant and carries the
        # researcher's reason about them — a restore after a withdrawal must hold none.
        return (bool(_embed_attrs(doc, where=where, act=ACT_WITHDRAWAL))
                or any(_misfit_case_lists(doc, where=where, act=ACT_WITHDRAWAL)))
    except CanvasScrubError:
        return True


def _misfit_case_lists(doc, *, where: str, act: str) -> list[dict]:
    """Every joint display row's ``misfit`` holding picked cases, in one document (D173).

    The live misfit dicts, so a rewrite of ``misfit["cases"]`` sticks. Fail-closed as
    `_embed_attrs`: a display or a misfit it cannot walk might name the person — refused in
    ``act``'s words (#1651), naming ``where`` the document lives (#1667, D341).
    """
    found: list[dict] = []

    def _collect(node: dict) -> None:
        attrs = node.get("attrs")
        if not isinstance(attrs, dict):
            return
        try:
            display = display_of(attrs, strict=True)
            if display is None:
                return
            for row in display_rows(display, strict=True):
                if row_misfit_cases(row, strict=True):
                    found.append(row[MISFIT_KEY])
        except UnreadableDisplay as exc:
            raise CanvasScrubError(
                f"A joint display in {where} could not be read, {_unreadable(act, 'cases')}"
            ) from exc

    walk_tiptap_nodes(doc, {JOINT_DISPLAY_NODE}, _collect)
    return found


def _names(case: dict, participant_id: int) -> bool:
    return _as_int(case.get("participant_id")) == participant_id


@dataclass
class MisfitScrubOutcome:
    """Joint display slice 2 (r3-6) — a withdrawal's listed cases removed, with reasons."""

    cases_removed: int = 0  # live sections and snapshot copies together
    themes_rewritten: int = 0
    snapshots_rewritten: int = 0


def count_misfit_cases(db: Session, project_id: int, participant_id: int, *, act: str,
                       copies: _Copies | None = None) -> int:
    """The withdrawal report's count, BEFORE the act — the same walk the act removes with.

    ``act`` words a copy it cannot read — the report's own, `ACT_REPORT` (#1667, D341).
    ``copies``: the report's one read (#1676 D362); read here when not given.
    """
    copies = copies if copies is not None else _read_copies(db, project_id, act=act)
    return sum(
        1
        for where, doc in copies.docs()
        for misfit in _misfit_case_lists(doc, where=where, act=act)
        for key in MISFIT_CASE_LISTS
        for case in misfit.get(key) or []
        if isinstance(case, dict) and _names(case, participant_id)
    )


def scrub_misfit_cases(db: Session, project_id: int, participant_id: int, *,
                       act: str, copies: _Copies | None = None) -> MisfitScrubOutcome:
    """Remove every added or removed case naming ``participant_id`` — and its reason — from every
    joint display, in live sections (through `update_theme_content`, which rebuilds the
    search index the reason was in) and snapshot copies alike.

    The case is REMOVED, never blanked: a case is a person, and a case with no person is
    nothing. Call BEFORE the participant row goes (it is what the case names). Flushes,
    does not commit; raises `CanvasScrubError` on a copy or a display it cannot walk, in the
    words of ``act`` (`ACT_WITHDRAWAL` / `ACT_DELETE`, no default — #1651, D338).
    ``copies``: the withdrawal's one read, shared with its other scrubs (#1676 D363) — which
    write back the SAME parsed documents in sequence; read here when not given.
    """
    out = MisfitScrubOutcome()
    copies = copies if copies is not None else _read_copies(db, project_id, act=act)

    def _scrub(doc, where: str) -> int:
        removed = 0
        for misfit in _misfit_case_lists(doc, where=where, act=act):
            for key in MISFIT_CASE_LISTS:
                listed = misfit.get(key)
                if not isinstance(listed, list):
                    continue
                kept = [c for c in listed
                        if not (isinstance(c, dict) and _names(c, participant_id))]
                removed += len(listed) - len(kept)
                misfit[key] = kept
        return removed

    for theme, canvas_name, doc in copies.themes:
        hits = _scrub(doc, _section_place(canvas_name, theme.name))
        if hits:
            update_theme_content(db, theme, doc)
            out.cases_removed += hits
            out.themes_rewritten += 1
    for snap, canvas_name, data, items in copies.snapshots:
        changed = False
        for item, doc in items:
            hits = _scrub(doc, _snapshot_place(canvas_name, snap.name))
            if hits:
                item["content"] = json.dumps(doc) if doc else None
                item["searchable_text"] = extract_theme_searchable_text(doc)
                out.cases_removed += hits
                changed = True
        if changed:
            snap.snapshot_data = json.dumps(data)
            out.snapshots_rewritten += 1
    db.flush()
    return out


@dataclass
class _Copies:
    """Every canvas copy in a project, parsed — read before anything is judged or written.

    `themes`: (theme, its canvas's name, document). `snapshots`: (snapshot, its canvas's
    name, its data, and each of its section copies with that copy's document).
    """

    themes: list[tuple]
    snapshots: list[tuple]

    def docs(self) -> list[tuple[str, object]]:
        """Every document, with where it lives — so a display it cannot walk names its copy
        (#1667, D341)."""
        return [(_section_place(canvas_name, theme.name), doc)
                for theme, canvas_name, doc in self.themes] + [
            (_snapshot_place(canvas_name, snap.name), doc)
            for snap, canvas_name, _, copies in self.snapshots for _, doc in copies
        ]


def read_canvas_copies(db: Session, project_id: int, *, act: str) -> _Copies:
    """#1676 D362–D363 — every canvas copy in the project, parsed ONCE for a caller that hands
    them to several of this module's readers (the report's three counts; the withdrawal's two
    scrubs and its drift clearing). Each reader also reads them itself when given none.

    ⚠️ Never carried across a backup or any other long wait: another request may save a
    section in between (#1033's second actor), and a scrub writing back the older document
    would lose it. Read, then use at once.
    """
    return _read_copies(db, project_id, act=act)


def check_canvas_copies(db: Session, project_id: int, *, act: str) -> None:
    """#1676 D363 — what the withdrawal will walk, walked without writing: every copy parsed,
    and every display's pins, case lists and drift stamps. Raises `CanvasScrubError` in
    ``act``'s words on anything the act would refuse (`_Judge` raises nothing, so the act's
    canvas refusals are exactly these) — so the act can refuse BEFORE its backup."""
    for where, doc in _read_copies(db, project_id, act=act).docs():
        _embed_attrs(doc, where=where, act=act)
        _misfit_case_lists(doc, where=where, act=act)
        _drift_stamps(doc, where=where, act=act)


#: #1674 D357 — the mark a withdrawal leaves on a drift stamp whose figures it removed.
DRIFT_CLEARED_BY_WITHDRAWAL = "withdrawal"
#: The stamp's members that hold FIGURES — the cells as they printed, and their fingerprint
#: (a hash of a group-of-one's few cells can be matched against every value they could take).
_DRIFT_FIGURE_KEYS = ("hash", "cells")


def _drift_stamps(doc, *, where: str, act: str) -> list[dict]:
    """Every joint display row's drift stamp that still holds figures, in one document — the
    live ``baseline`` dicts, so a rewrite sticks. Fail-closed as `_embed_attrs`."""
    found: list[dict] = []

    def _collect(node: dict) -> None:
        attrs = node.get("attrs")
        if not isinstance(attrs, dict):
            return
        try:
            display = display_of(attrs, strict=True)
            if display is None:
                return
            for row in display_rows(display, strict=True):
                stamp = row.get("baseline")
                if (isinstance(stamp, dict)
                        and stamp.get("cleared") != DRIFT_CLEARED_BY_WITHDRAWAL
                        and any(k in stamp for k in _DRIFT_FIGURE_KEYS)):
                    found.append(stamp)
        except UnreadableDisplay as exc:
            raise CanvasScrubError(
                f"A joint display in {where} could not be read, {_unreadable(act, 'quotes')}"
            ) from exc

    walk_tiptap_nodes(doc, {JOINT_DISPLAY_NODE}, _collect)
    return found


def canvas_quote_counts(db: Session, project_id: int, *, act: str,
                        copies: _Copies | None = None) -> Counter[int]:
    """#1702 (D382) — how many canvas quotes show each excerpt: every `excerpt-embed` and every
    joint display pin, in sections and snapshot copies, by its `excerptId` — through the scrub's
    ONE walk (`_embed_attrs`), so a copy it cannot read raises in ``act``'s words like the
    report's other counts. A blanked embed (`excerptId` null) shows no excerpt and is not counted.

    The withdrawal report sums it over a linked document's quotes: the document stays,
    unlinked, for the researcher to read (row 46), and its passages quoted on the canvas stay
    with it — so the confirm's document line says how many, for that reading to find them.
    """
    copies = copies if copies is not None else _read_copies(db, project_id, act=act)
    counts: Counter[int] = Counter()
    for where, doc in copies.docs():
        for attrs in _embed_attrs(doc, where=where, act=act):
            eid = _as_int(attrs.get("excerptId"))
            if eid is not None:
                counts[eid] += 1
    return counts


def count_drift_stamps(db: Session, project_id: int, *, act: str,
                       copies: _Copies | None = None) -> int:
    """#1674 D357 — the report's count of the drift stamps a withdrawal will clear: EVERY stamp
    with figures in the project's joint displays, sections and snapshots alike. Every one,
    deliberately — telling which drew on the person would need each display's compute inside
    the withdrawal's transaction, and a stamp is re-made with one press (fail closed)."""
    copies = copies if copies is not None else _read_copies(db, project_id, act=act)
    return sum(len(_drift_stamps(doc, where=where, act=act)) for where, doc in copies.docs())


@dataclass
class DriftClearOutcome:
    """#1674 D357 — stamps cleared (live sections and snapshot copies together)."""

    stamps_cleared: int = 0
    themes_rewritten: int = 0
    snapshots_rewritten: int = 0


def clear_drift_stamps(db: Session, project_id: int, *, act: str,
                       copies: _Copies | None = None) -> DriftClearOutcome:
    """#1674 D357 — clear every drift stamp's figures: ``hash`` and ``cells`` go, the date and
    the coder scope stay, and ``cleared: "withdrawal"`` says why. A stamp printed the cells as
    they were — for a group of one, their answer, code or rating, and for any group the
    difference shows it — so after a withdrawal its *was* is a copy of their data. Flushes,
    does not commit; ``copies`` as `scrub_misfit_cases`."""
    out = DriftClearOutcome()
    copies = copies if copies is not None else _read_copies(db, project_id, act=act)

    def _clear(doc, where: str) -> int:
        stamps = _drift_stamps(doc, where=where, act=act)
        for stamp in stamps:
            for key in _DRIFT_FIGURE_KEYS:
                stamp.pop(key, None)
            stamp["cleared"] = DRIFT_CLEARED_BY_WITHDRAWAL
        return len(stamps)

    for theme, canvas_name, doc in copies.themes:
        hits = _clear(doc, _section_place(canvas_name, theme.name))
        if hits:
            update_theme_content(db, theme, doc)
            out.stamps_cleared += hits
            out.themes_rewritten += 1
    for snap, canvas_name, data, items in copies.snapshots:
        changed = False
        for item, doc in items:
            hits = _clear(doc, _snapshot_place(canvas_name, snap.name))
            if hits:
                item["content"] = json.dumps(doc) if doc else None
                out.stamps_cleared += hits
                changed = True
        if changed:
            snap.snapshot_data = json.dumps(data)
            out.snapshots_rewritten += 1
    db.flush()
    return out


def _read_copies(db: Session, project_id: int, *, act: str) -> _Copies:
    """Every canvas copy, parsed; a copy it cannot read refuses in ``act``'s words (#1651)."""
    themes = (
        db.query(CanvasTheme, Canvas.name)
        .join(Canvas, CanvasTheme.canvas_id == Canvas.id)
        .filter(Canvas.project_id == project_id, CanvasTheme.content.isnot(None))
        .order_by(CanvasTheme.id)
        .all()
    )
    # #1667 (D341): each copy named as the report's unplaced-quotes note names it — a section
    # with its canvas, a snapshot with its canvas — so the researcher can find the one to repair.
    theme_docs = [
        (theme, canvas_name,
         _parse(theme.content, f"The canvas section “{canvas_name} › {theme.name}”", act))
        for theme, canvas_name in themes
    ]

    snapshots = (
        db.query(CanvasSnapshot, Canvas.name)
        .join(Canvas, CanvasSnapshot.canvas_id == Canvas.id)
        .filter(Canvas.project_id == project_id)
        .order_by(CanvasSnapshot.id)
        .all()
    )
    snapshot_docs = []
    for snap, canvas_name in snapshots:
        named = f"canvas snapshot “{snap.name}” of “{canvas_name}”"
        data = _parse(snap.snapshot_data, f"The {named}", act)
        if not isinstance(data, dict):
            raise CanvasScrubError(f"The {named} could not be read, {_unreadable(act, 'copy')}")
        copies = []
        for item in data.get("themes") or []:
            if not isinstance(item, dict):
                continue
            copies.append((item, _parse(item.get("content"), f"A section of the {named}", act)))
        snapshot_docs.append((snap, canvas_name, data, copies))
    return _Copies(theme_docs, snapshot_docs)


def _reaches(held: str, shown: str, spans: Spans) -> bool:
    """#1613 — some place `shown` sits in `held` overlaps one of their `[start, end)`
    parts. ANY place: the embed records no offset, so a quote whose words also stand
    across their join may be theirs, and it goes (D8's rule inside a turn is the same).
    A quote whose words also stand wholly inside one original is still that
    original's to decide — the join rule before this asks that first."""
    n = len(shown)
    at = held.find(shown)
    while at != -1:
        if any(s < at + n and at < e for s, e in spans):
            return True
        at = held.find(shown, at + 1)
    return False


class _Judge:
    """Whose an embed is — the scrub's one predicate, and what it cannot place (D158).

    Built once per pass from the copies it will judge: the live quotes they name (the
    orphan rule) and the conversations they name that still exist in this project.
    """

    def __init__(
        self,
        db: Session,
        project_id: int,
        copies: _Copies,
        *,
        removed: set[int],
        words: dict[int, list[str]],
        answers: Callable[[], set[str]],
        deleted: dict[int, list[tuple[str, tuple[str, ...], Spans | None]]],
        placeholder: str,
        act: str,
    ):
        self.removed = removed
        self.words = words
        self._answer_source = answers
        self._answers: set[str] | None = None
        self.deleted = deleted
        self.placeholder = placeholder.strip()

        named: set[int] = set()
        conversations: set[int] = set()
        for where, doc in copies.docs():
            for attrs in _embed_attrs(doc, where=where, act=act):
                eid = _as_int(attrs.get("excerptId"))
                if eid is not None and eid not in removed:
                    named.add(eid)
                conv = _as_int(attrs.get("conversationId"))
                if conv is not None:
                    conversations.add(conv)
        self.live: dict[int, str] = {}
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
                self.live[eid] = excerpt_text_from(seg_text, lo, hi, value_text)
        # A conversation id from another project is gone FOR THIS ONE: the embed's
        # conversation is a project's, and nothing of the person's lives elsewhere.
        self.live_conversations: set[int] = set()
        if conversations:
            self.live_conversations = {
                cid for (cid,) in db.query(Conversation.id).filter(
                    Conversation.project_id == project_id,
                    Conversation.id.in_(sorted(conversations)),
                )
            }

    @property
    def answers(self) -> set[str]:
        """Read only when an embed needs it: most canvases hold no orphan of an answer."""
        if self._answers is None:
            self._answers = {
                a.strip() for a in self._answer_source()
                if isinstance(a, str) and a.strip()
            }
        return self._answers

    def _shown(self, attrs: dict) -> str:
        shown = attrs.get("displayText")
        return shown.strip() if isinstance(shown, str) else ""

    def _current(self, attrs: dict, shown: str) -> bool:
        """Someone's current quote, saying exactly this — not an orphan."""
        eid = _as_int(attrs.get("excerptId"))
        return eid is not None and eid in self.live and self.live[eid].strip() == shown

    def theirs(self, attrs: dict) -> bool:
        eid = _as_int(attrs.get("excerptId"))
        if eid is not None and eid in self.removed:
            return True
        shown = self._shown(attrs)
        if not shown:
            return False
        conversation = _as_int(attrs.get("conversationId"))
        if conversation is not None:
            # D8: a quote of a turn, inside one of their turns in that conversation.
            theirs = any(shown in t for t in self.words.get(conversation, ())) or any(
                # #1473 (b): inside what a deleted merge result or split child held,
                # and ACROSS a join — a quote wholly inside one of its originals is
                # that original's to decide (the other speaker's half of a merge is
                # someone else's words; their own half is D8's, just above).
                shown in held and not any(shown in p for p in parts)
                # #1613: and it reaches THEIR part somewhere — a quote across the join
                # of two other people's turns in that merge is theirs, not this
                # person's. Unknown (`None`, an edit's wording of a mixed segment):
                # the join rule alone, as before.
                and (spans is None or _reaches(held, shown, spans))
                for held, parts, spans in self.deleted.get(conversation, ())
            )
        elif _as_int(attrs.get("observationId")) is None:
            # #1473: a quote of an answer is the whole answer — equal, not inside.
            theirs = shown in self.answers
        else:
            theirs = False  # a clip's text is the researcher's label, never theirs
        if not theirs:
            return False
        return not self._current(attrs, shown)

    def unplaced(self, attrs: dict) -> bool:
        """D158 — an embed nothing can tie to anyone.

        Asked only of one not `theirs` — so a quote being removed (`theirs`' first arm)
        never reaches here, and the report removes nothing.
        """
        shown = self._shown(attrs)
        if not shown or shown == self.placeholder:
            return False  # no words, or a quote a withdrawal already blanked
        if self._current(attrs, shown):
            return False
        conversation = _as_int(attrs.get("conversationId"))
        if conversation is not None:
            return conversation not in self.live_conversations
        if _as_int(attrs.get("observationId")) is not None:
            return False  # a clip's label is the researcher's
        # An answer or a document passage, its quote gone: unless it is one of their
        # answers' wordings (the scrub's own rule — `theirs` above), nothing says whose.
        return shown not in self.answers


def unplaced_canvas_quotes(
    db: Session,
    project_id: int,
    *,
    answer_words: Callable[[], Iterable[str]],
    placeholder_text: str,
    act: str,
    copies: _Copies | None = None,
) -> UnplacedCanvasQuotes:
    """#1546 (D158) — the canvas quotes a withdrawal would LEAVE, read without writing.

    `answer_words` gives the person's answers' wordings — the one list the withdrawal
    matches an answer's orphan against (`withdrawal_redaction.answer_wordings`), asked
    only when a canvas holds such an orphan. Nothing else of theirs can claim an
    unplaced embed: a turn's quote is unplaced only when its conversation is gone, and
    every turn they hold, live or deleted by an Unmerge, is in a live conversation.
    ``act`` words a copy it cannot read — the report's own, `ACT_REPORT` (#1667, D341).
    ``copies``: the report's one read (#1676 D362); read here when not given.
    """
    copies = copies if copies is not None else _read_copies(db, project_id, act=act)
    judge = _Judge(
        db, project_id, copies, removed=set(), words={},
        answers=lambda: set(answer_words()), deleted={}, placeholder=placeholder_text, act=act,
    )
    out = UnplacedCanvasQuotes()

    def _count(doc, where: str) -> int:
        return sum(1 for attrs in _embed_attrs(doc, where=where, act=act) if judge.unplaced(attrs))

    for theme, canvas_name, doc in copies.themes:
        hits = _count(doc, _section_place(canvas_name, theme.name))
        if hits:
            out.sections.append(UnplacedCanvasPlace(
                theme.canvas_id, canvas_name, theme.id, theme.name, hits))
    for snap, canvas_name, _, items in copies.snapshots:
        hits = sum(_count(doc, _snapshot_place(canvas_name, snap.name)) for _, doc in items)
        if hits:
            out.snapshots.append(UnplacedCanvasPlace(
                snap.canvas_id, canvas_name, snap.id, snap.name, hits))
    out.quotes = sum(p.quotes for p in out.sections + out.snapshots)
    return out


def scrub_excerpt_embeds(
    db: Session,
    project_id: int,
    excerpt_ids,
    *,
    replacement_text: str,
    words_by_conversation: dict[int, list[str]] | None = None,
    answer_words=None,
    deleted_wordings: dict[int, list[tuple[str, tuple[str, ...], Spans | None]]]
    | None = None,
    copies: _Copies | None = None,
) -> EmbedScrubOutcome:
    """Rewrite every canvas copy of the quotes in `excerpt_ids` (see the module).

    `excerpt_ids` are quotes the caller is removing (on segments AND on dataset
    values). `words_by_conversation` maps a conversation id to the texts the
    withdrawn person's turns held BEFORE they were blanked — what an orphan embed is
    matched against (D8). `answer_words` are the wordings their ANSWERS held (each
    answer's text, and its edits' old and new values) — what an orphan embed with no
    conversation is matched against, by equality (#1473). `deleted_wordings` maps a
    conversation id to what each DELETED merge result or split child their words
    passed through held, each with its originals' texts and where their words sit in it
    (#1473 b, #1613; `withdrawal_history.DeletedSegment`). Call it after the quotes are deleted; it
    flushes and does not commit. An embed it cannot place is left and counted in
    `quotes_unplaced` (D158), by the predicate the report asked before the act. ``copies``:
    the withdrawal's one read, shared with its other scrubs (#1676 D363).
    """
    removed = {i for i in (_as_int(x) for x in excerpt_ids) if i is not None}
    words = {
        conv: [t for t in texts if t]
        for conv, texts in (words_by_conversation or {}).items()
    }
    out = EmbedScrubOutcome()

    # ── Read every copy first: the orphan rule needs the live quotes they name ──
    copies = copies if copies is not None else _read_copies(db, project_id, act=ACT_WITHDRAWAL)
    judge = _Judge(
        db, project_id, copies, removed=removed, words=words,
        answers=lambda: set(answer_words or ()), deleted=deleted_wordings or {},
        placeholder=replacement_text, act=ACT_WITHDRAWAL,
    )

    def _scrub(doc, where: str) -> int:
        hits = 0
        for attrs in _embed_attrs(doc, where=where, act=ACT_WITHDRAWAL):
            if judge.theirs(attrs):
                attrs["displayText"] = replacement_text
                attrs["excerptId"] = None
                # #1674 D356: a PIN's purpose is the researcher's line about why THIS quote of
                # theirs is there ("the only Franklin teacher who opposed it") — it goes with the
                # quote, as a misfit case's reason goes with the person (D314). An embed has none.
                if "purpose" in attrs:
                    attrs["purpose"] = None
                hits += 1
            elif judge.unplaced(attrs):
                # D158 — left as it is, and counted: nothing says whose words it holds.
                out.quotes_unplaced += 1
        return hits

    # ── Live themes: through `update_theme_content`, which rebuilds the two
    # derived columns from the rewritten document ──
    for theme, canvas_name, doc in copies.themes:
        hits = _scrub(doc, _section_place(canvas_name, theme.name))
        if hits:
            update_theme_content(db, theme, doc)
            out.embeds_scrubbed += hits
            out.themes_rewritten += 1

    # ── Snapshots: the same rewrite on each theme copy, the copy's derived
    # fields rebuilt by the same extractors, and the inbox entries dropped ──
    for snap, canvas_name, data, items in copies.snapshots:
        changed = False
        for item, doc in items:
            hits = _scrub(doc, _snapshot_place(canvas_name, snap.name))
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
