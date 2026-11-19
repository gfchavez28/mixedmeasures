"""The joint display's canvas node — its shape, as every server-side walker reads it.

A joint display (ROADMAP row 56, STRATEGY question 5) lives IN a canvas section's text,
on its own Tiptap node (D162): snapshots, the withdrawal scrub, the `.mmproject` remap,
search and duplicate-canvas already walk theme content, and a Material would be missed
by all of them. This module is the one statement of where inside that node the server
finds what it must act on — ids to remap, quotes to scrub, text to index. It imports
nothing from the app, so `services/canvas.py`, `canvas_embed_scrub.py` and
`project_portability.py` can all use it.

## The node

``{"type": "joint-display", "attrs": {"displayKey": "<uuid>", "figureEpoch": <int>,
"display": {...}}}`` — `displayKey` keys the display's export table (there is no
Material id), `figureEpoch` is drift's (D168.5), and `display` holds everything else as
ONE JSON object (chart-embed's `config` pattern). It is an OBJECT in stored theme
content; a string (an HTML round trip) is parsed by `display_of`, and the scrub writes
the object back.

## The display's key space (the contract session B builds against)

Display level:
  - ``group_by_column_id`` — int | null — the variable that forms the groups (D166).
  - ``conversation_ids`` / ``document_ids`` — [int | null] | null — the code strand's
    sources; null = every source of that kind (#1297's rule).
  - ``attribution`` — {"label": ..., "column_id": int | null} — how a pin is attributed
    at render (D163.4: derived, never stored); ``column_id`` is an optional
    participant-linked column (e.g. School).
  - ``strands`` — [object] | absent — joint display slice 2 (r1-1): the display's strands,
    explicit and NAMED. Each is ``{"key": str (stable, never an id), "kind": "codes" |
    "variables" | "observation_codes", "label": str (the researcher's name for it — their
    words, indexed), ...its sources}``: ``conversation_ids`` / ``document_ids`` /
    ``text_column_ids`` (codes) and ``observation_ids`` (observation codes) — [int | null]
    | null, null = every source of the kind (#1297) — and ``dataset_id`` (variables, D205's
    one dataset per strand) — int | null. ABSENT = slice 1's implicit pair, read from the
    display-level sources above and each row's ``code_ids`` / ``column_ids``.
  - anything else (``settings``, ``title``, …) — plain, carries no id.

Each of ``rows`` (a list of objects):
  - ``key`` — a stable string; ``construct`` — the researcher's name for the row.
  - ``code_ids`` / ``column_ids`` / ``result_material_ids`` — [int | null] — the code
    strand, the survey strand (D167) and the different-unit strand (D165).
  - ``meta_inference`` — {"text": str, "author_id": int | null, …} (D170); ``author_id``
    is an install-global `users.id`.
  - ``implication`` — str (D170, optional column).
  - ``pins`` — [object] — (slice 2: plus an optional plain ``strand`` key, the strand it was
    picked from — r2-5) each EXACTLY an `excerpt-embed`'s attributes (``excerptId`` ·
    ``displayText`` · ``sourceContext`` · ``conversationId`` · ``observationId``) plus
    ``group`` (the group's key, text), ``role`` (typical / illustrative / discrepant
    / null) and ``purpose`` (the researcher's one line on why a discrepant quote is there,
    D163.5 — their words, never a participant's, so plain text and in the search index)
    — D163, so the scrub's one predicate decides a pin as it decides any other canvas
    quote.
  - ``bindings`` — {strand key: {"code_ids": [int | null], "column_ids": [int | null],
    "marked_formed": bool}} — slice 2 (r1-1): what the row binds from each NAMED strand.
    ``status`` becomes {strand key: "covers" | "silent" | null}, and ``fits`` —
    [{"strands": [strand key, strand key], "fit": str | null}] — is the researcher's fit per
    pair they compare (r1-8; slice 1's one ``fit`` reads as one fit over the implicit pair,
    and is never written again) — keys, never ids.
  - ``baseline`` — the drift stamp (D168.5). Its ``cells`` are keyed ``<kind>:<id>:<rest>``
    or ``<kind>:<id>@<strand key>:<rest>`` with ``<kind>`` one of `BASELINE_KEY_TABLES` —
    the KEY carries an id, so the remap rewrites it too (slice 2, r1-7: an import otherwise
    made every stamped cell "move"). ``scope`` (#1672 D353) is ``"all"`` or a ``users.id`` —
    the coder view the cells were read under — remapped through the coders remap and dropped
    when that coder did not travel. ``cleared: "withdrawal"`` (#1674 D357) marks a stamp whose
    ``hash`` and ``cells`` a withdrawal removed; ``stamped_at`` stays.
  - ``misfit`` — joint display slice 2, D173 (r3-1 … r3-6, r3-12): the row's "cases that
    don't fit", ``{"rule": {"conditions": [...]} | null, "added": [case], "removed":
    [case]}``, a case ``{"participant_id": int | null, "reason": str}`` — a stated rule
    PLUS the researcher's recorded additions and removals, each with a reason; a
    hand-picked list is no rule and its additions. A condition is
    ``{"kind": "group", "group": str}`` · ``{"kind": "variable", "column_id": int | null,
    "op": str, "value": str | number | null}`` · ``{"kind": "code", "strand_key": str,
    "code_id": int | null, "present": bool}``, joined by AND. 🔴 A listed case NAMES A
    PARTICIPANT and carries the researcher's reason, which may identify them: the
    withdrawal removes the case and its reason (`canvas_embed_scrub.scrub_misfit_cases`),
    and an import DROPS a case whose participant did not travel, never nulls it (r3-5: a
    merge skips a withdrawn person, and her reason must not arrive without her). The
    reason is the researcher's own writing, so it is in the search index (as a pin's
    ``purpose`` is) — and leaves it with the case.
  - anything else (``fit``, ``fits``, ``status``, ``by_construction``, the
    ``*_marked_formed`` flags — ``results_marked_formed`` since session C, D171 for the
    different-unit strand) — plain, carries no id.

🔴 **A new key that holds an id must be added to the remap below** — the JSON-id class
(`backend-invariants.md` §6): `_build_entity` copies theme content verbatim, so an id
nothing remaps names the SOURCE install's row after an import.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable

JOINT_DISPLAY_NODE = "joint-display"
DISPLAY_ATTR = "display"
DISPLAY_KEY_ATTR = "displayKey"

#: The pin attributes that are an `excerpt-embed`'s, in the embed's own names.
PIN_EXCERPT_ATTRS = ("excerptId", "displayText", "sourceContext", "conversationId",
                     "observationId")

#: Display-level ids: key → (remap table, is a list).
DISPLAY_ID_KEYS: dict[str, tuple[str, bool]] = {
    "group_by_column_id": ("dataset_columns", False),
    "conversation_ids": ("conversations", True),
    "document_ids": ("documents", True),
}
#: Ids inside ``attribution``.
ATTRIBUTION_ID_KEYS: dict[str, tuple[str, bool]] = {
    "column_id": ("dataset_columns", False),
}
#: Row-level ids.
ROW_ID_KEYS: dict[str, tuple[str, bool]] = {
    "code_ids": ("codes", True),
    "column_ids": ("dataset_columns", True),
    "result_material_ids": ("materials", True),
}
#: Ids inside a row's ``meta_inference``. `users.id` is INSTALL-global: the import's
#: coder remap is the only way to the same person here.
META_INFERENCE_ID_KEYS: dict[str, tuple[str, bool]] = {
    "author_id": ("coders", False),
}
#: Ids on a strand (joint display slice 2, r1-1) — every source a strand of any kind may
#: name. ``text_column_ids`` and ``observation_ids`` are declared for every kind ON PURPOSE
#: (r1-6): a key this release's import does not name is copied verbatim, so a later release
#: that starts writing one would need a refusal bump (v9) to stay correct here.
STRAND_ID_KEYS: dict[str, tuple[str, bool]] = {
    "conversation_ids": ("conversations", True),
    "document_ids": ("documents", True),
    "text_column_ids": ("dataset_columns", True),
    "observation_ids": ("observations", True),
    "dataset_id": ("datasets", False),
}
#: Ids inside each of a row's ``bindings`` (one per named strand).
BINDING_ID_KEYS: dict[str, tuple[str, bool]] = {
    "code_ids": ("codes", True),
    "column_ids": ("dataset_columns", True),
}
#: The drift baseline's cell keys name an id (`lib/joint-display.ts::rowCells`): the key's
#: first part → the table its second part's id is from. A key of another shape is kept.
BASELINE_KEY_TABLES: dict[str, str] = {
    "code": "codes",
    "rating": "codes",
    "variable": "dataset_columns",
    "clips": "codes",
    "observation": "codes",  # r2's observation drift key
}
#: Ids on a pin — the `excerpt-embed`'s own three.
PIN_ID_KEYS: dict[str, tuple[str, bool]] = {
    "excerptId": ("excerpts", False),
    "conversationId": ("conversations", False),
    "observationId": ("observations", False),
}
#: Joint display slice 2 (D173) — a row's ``misfit``. Ids on an added or removed case.
MISFIT_KEY = "misfit"
#: r3-12 — the misfit's case lists, each naming participants with a reason. ONE constant,
#: which the remap, the search index and the withdrawal's scrub all iterate, so a switch
#: back to the contract's single ``cases`` list (C4) is this line.
MISFIT_CASE_LISTS = ("added", "removed")
MISFIT_CASE_ID_KEYS: dict[str, tuple[str, bool]] = {
    "participant_id": ("participants", False),
}
#: Ids on a rule's condition (a variable condition's column, a code condition's code).
MISFIT_CONDITION_ID_KEYS: dict[str, tuple[str, bool]] = {
    "column_id": ("dataset_columns", False),
    "code_id": ("codes", False),
}


class UnreadableDisplay(ValueError):
    """A display whose shape a walker cannot follow — so it cannot vouch for it."""


def display_of(attrs: dict, *, strict: bool) -> dict | None:
    """The node's display object, or None when it carries none.

    A JSON string is parsed and the OBJECT written back into ``attrs``, so a caller that
    rewrites the display (the scrub) changes what is stored. ``strict`` raises
    `UnreadableDisplay` on a display that is present and not an object; otherwise it
    reads as absent.
    """
    raw = attrs.get(DISPLAY_ATTR)
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            raw = None
        if isinstance(raw, dict):
            attrs[DISPLAY_ATTR] = raw
    if isinstance(raw, dict):
        return raw
    if strict:
        raise UnreadableDisplay("a joint display's contents could not be read")
    return None


def _objects(value, *, strict: bool, what: str) -> list[dict]:
    """The objects of a list member — ``[]`` when absent."""
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise UnreadableDisplay(f"a joint display's {what} could not be read")
        return []
    out = []
    for item in value:
        if isinstance(item, dict):
            out.append(item)
        elif strict:
            raise UnreadableDisplay(f"a joint display's {what} could not be read")
    return out


def display_rows(display: dict, *, strict: bool) -> list[dict]:
    return _objects(display.get("rows"), strict=strict, what="rows")


def display_strands(display: dict, *, strict: bool) -> list[dict]:
    """The display's named strands (slice 2) — ``[]`` for slice 1's implicit pair."""
    return _objects(display.get("strands"), strict=strict, what="strands")


def row_bindings(row: dict) -> list[dict]:
    """A row's per-strand bindings, as the live dicts (slice 2) — ``[]`` when absent."""
    bindings = row.get("bindings")
    if not isinstance(bindings, dict):
        return []
    return [b for b in bindings.values() if isinstance(b, dict)]


def display_pins(display: dict, *, strict: bool) -> list[dict]:
    """Every pinned quote in the display, as the live dicts (a rewrite sticks).

    ``strict`` is the scrub's: a row or a pin list it cannot walk might hold a
    withdrawn person's words, so it raises rather than passing over them.
    """
    pins: list[dict] = []
    for row in display_rows(display, strict=strict):
        pins.extend(_objects(row.get("pins"), strict=strict, what="pinned quotes"))
    return pins


def row_misfit(row: dict, *, strict: bool) -> dict | None:
    """Joint display slice 2 (D173) — the row's misfit object, or None when it has none.

    ``strict`` is the scrub's (as `display_pins`): a misfit it cannot walk might name a
    withdrawn person, so it raises rather than passing over it.
    """
    raw = row.get(MISFIT_KEY)
    if raw is None:
        return None
    if not isinstance(raw, dict):
        if strict:
            raise UnreadableDisplay("a joint display's cases that don't fit could not be read")
        return None
    return raw


def row_misfit_cases(row: dict, *, strict: bool) -> list[dict]:
    """Every case the row's misfit names (each of `MISFIT_CASE_LISTS`), as the live dicts
    (a rewrite sticks) — ``[]`` when none."""
    misfit = row_misfit(row, strict=strict)
    if misfit is None:
        return []
    return [case for key in MISFIT_CASE_LISTS
            for case in _objects(misfit.get(key), strict=strict, what="cases that don't fit")]


def rekey_displays(doc, mint: Callable[[], str] | None = None) -> int:
    """#1670 D349 — give every joint display in a Tiptap document a fresh ``displayKey``,
    in place; returns how many it re-keyed.

    The key identifies a display on the page (its export table, its dialogs, the kept
    open rows, view choice and drafts — never stored data), so two nodes that share one
    act as one. A COPY must therefore not carry its original's key: the client re-keys a
    paste or drop (`extensions/joint-display.ts`, D348), and the server re-keys where IT
    copies — `canvas.duplicate_canvas` and the `.mmproject` import's canvas remap. A
    snapshot restore and a deleted section's restore bring back the SAME display, so they
    keep its key and do not call this.
    """
    make = mint or (lambda: str(uuid.uuid4()))
    count = 0

    def _walk(node) -> None:
        nonlocal count
        if not isinstance(node, dict):
            return
        if node.get("type") == JOINT_DISPLAY_NODE:
            attrs = node.get("attrs")
            if isinstance(attrs, dict):
                attrs[DISPLAY_KEY_ATTR] = make()
                count += 1
        children = node.get("content")
        if isinstance(children, list):
            for child in children:
                _walk(child)

    _walk(doc)
    return count


def rekey_displays_in_json(content_json: str | None) -> str | None:
    """`rekey_displays` over stored theme content (a JSON string) — the text unchanged,
    byte for byte, when it holds no display or cannot be parsed."""
    if not content_json:
        return content_json
    try:
        doc = json.loads(content_json)
    except (TypeError, ValueError):
        return content_json
    return json.dumps(doc) if rekey_displays(doc) else content_json


def display_search_text(display: dict) -> list[str]:
    """What the researcher wrote and pinned — the search index's share of the node."""
    parts: list[str] = []

    def _add(value) -> None:
        if isinstance(value, str) and value.strip():
            parts.append(value)

    _add(display.get("title"))
    for strand in display_strands(display, strict=False):
        _add(strand.get("label"))  # slice 2: the researcher's name for a strand
    for row in display_rows(display, strict=False):
        _add(row.get("construct"))
        meta = row.get("meta_inference")
        if isinstance(meta, dict):
            _add(meta.get("text"))
        _add(row.get("implication"))
        for pin in _objects(row.get("pins"), strict=False, what="pinned quotes"):
            _add(pin.get("displayText"))
            _add(pin.get("purpose"))
        # Joint display slice 2 (r3-5): a listed case's reason is the researcher's writing.
        for case in row_misfit_cases(row, strict=False):
            _add(case.get("reason"))
    return parts


def display_referenced_excerpt_ids(display: dict) -> list[int]:
    """The quotes the display pins — `referenced_source_ids`' share of the node."""
    out = []
    for pin in display_pins(display, strict=False):
        eid = pin.get("excerptId")
        if isinstance(eid, int) and not isinstance(eid, bool):
            out.append(eid)
    return out


def _remap_keys(obj: dict, keys: dict[str, tuple[str, bool]],
                lookup: Callable[[str, int], int | None]) -> None:
    for key, (table, is_list) in keys.items():
        if key not in obj:
            continue
        value = obj[key]
        if is_list:
            if isinstance(value, list):
                obj[key] = [_one(table, v, lookup) for v in value]
        else:
            obj[key] = _one(table, value, lookup)


def _one(table: str, old, lookup: Callable[[str, int], int | None]):
    if old is None:
        return None
    if not isinstance(old, int) or isinstance(old, bool):
        return None
    return lookup(table, old)


def remap_display(display: dict, lookup: Callable[[str, int], int | None]) -> None:
    """Rewrite every id the display carries through an import's remap, in place.

    ``lookup(table, old_id)`` answers the new id or None. 🔴 **An unresolved id becomes
    null — in a list it keeps its place — and is NEVER kept** (D202, amending D164's
    "keep a project-scoped id"): the imported project's rows are given new ids, from 1
    on a fresh install, so a kept SOURCE id can name a DIFFERENT live row of the very
    project imported (#922's id-overlap lesson) and the display would draw another code's
    numbers under the row's name, silently. Null says "the reference did not travel",
    which is what D164 wanted the display to show. A pin's ``excerptId`` is nulled with
    its ``displayText`` kept, as the scrub does; a coder id that does not resolve names
    someone else on this install and is nulled for that reason too
    (`_remap_material_config`'s rule).
    """
    _remap_keys(display, DISPLAY_ID_KEYS, lookup)
    attribution = display.get("attribution")
    if isinstance(attribution, dict):
        _remap_keys(attribution, ATTRIBUTION_ID_KEYS, lookup)
    for strand in display_strands(display, strict=False):
        _remap_keys(strand, STRAND_ID_KEYS, lookup)
    for row in display_rows(display, strict=False):
        _remap_keys(row, ROW_ID_KEYS, lookup)
        for binding in row_bindings(row):
            _remap_keys(binding, BINDING_ID_KEYS, lookup)
        baseline = row.get("baseline")
        if isinstance(baseline, dict) and isinstance(baseline.get("cells"), dict):
            baseline["cells"] = _remap_baseline_cells(baseline["cells"], lookup)
        if isinstance(baseline, dict):
            _remap_baseline_scope(baseline, lookup)
        meta = row.get("meta_inference")
        if isinstance(meta, dict):
            _remap_keys(meta, META_INFERENCE_ID_KEYS, lookup)
        for pin in _objects(row.get("pins"), strict=False, what="pinned quotes"):
            _remap_keys(pin, PIN_ID_KEYS, lookup)
        _remap_misfit(row, lookup)


def _remap_baseline_cells(cells: dict, lookup: Callable[[str, int], int | None]) -> dict:
    """The drift stamp's cells with the id in each KEY remapped (slice 2, r1-7).

    A key is ``<kind>:<id>:<rest>`` (`lib/joint-display.ts::rowCells`). Its id is the source
    install's, while the live cells the row is compared with come back under the imported
    ids, so an unremapped stamp read EVERY cell as moved after an import. An id that did not
    travel drops its cell: the row then draws nothing under that key either, and a cell of
    "was X, now —" would be a claim about a reference, not about the numbers.
    """
    out: dict = {}
    for key, value in cells.items():
        parts = key.split(":", 2) if isinstance(key, str) else []
        table = BASELINE_KEY_TABLES.get(parts[0]) if len(parts) == 3 else None
        # The id part is ``<id>`` or ``<id>@<strand key>`` (r2's per-strand key, reconciled).
        ident, at, strand = parts[1].partition("@") if table else ("", "", "")
        if table is None or not ident.lstrip("-").isdigit():
            out[key] = value
            continue
        new = lookup(table, int(ident))
        if new is not None:
            out[f"{parts[0]}:{new}{at}{strand}:{parts[2]}"] = value
    return out


#: #1672 D353 — the drift stamp's ``scope``: ``"all"`` (every coder) or the ``users.id`` of the
#: one coder whose own view it was read under while blind. An install-global id, so it goes
#: through the import's coder remap, as ``meta_inference.author_id`` does.
BASELINE_SCOPE_ALL = "all"
BASELINE_SCOPE_TABLE = "coders"


def _remap_baseline_scope(baseline: dict, lookup: Callable[[str, int], int | None]) -> None:
    """A coder scope is remapped; one that did not travel is DROPPED, so it reads as unknown and
    nothing is compared under it (D353) — never kept, which would name another coder here."""
    if "scope" not in baseline:
        return
    scope = baseline["scope"]
    if scope == BASELINE_SCOPE_ALL:
        return
    new = _one(BASELINE_SCOPE_TABLE, scope, lookup)
    if new is None:
        baseline.pop("scope")
    else:
        baseline["scope"] = new


def keep_unresolved_case(case: dict) -> bool:
    """Joint display slice 2, r3-5 — is a listed case whose participant did not travel kept?

    No: it is DROPPED with its reason. D202's null-in-place would leave the researcher's
    reason about a person with no person — and the one ordinary way a participant fails
    to travel is a merge SKIPPING a withdrawn one (`removal-tombstones.md` §3), whose
    reason may identify her. One function, so the literature or the developer can switch
    it to null-in-place cheaply.
    """
    return False


def _remap_misfit(row: dict, lookup: Callable[[str, int], int | None]) -> None:
    misfit = row_misfit(row, strict=False)
    if misfit is None:
        return
    rule = misfit.get("rule")
    if isinstance(rule, dict):
        for condition in _objects(rule.get("conditions"), strict=False, what="rule"):
            _remap_keys(condition, MISFIT_CONDITION_ID_KEYS, lookup)
    for key in MISFIT_CASE_LISTS:
        listed = misfit.get(key)
        if not isinstance(listed, list):
            continue
        kept = []
        for case in listed:
            if not isinstance(case, dict):
                continue
            _remap_keys(case, MISFIT_CASE_ID_KEYS, lookup)
            if case.get("participant_id") is None and not keep_unresolved_case(case):
                continue
            kept.append(case)
        misfit[key] = kept
