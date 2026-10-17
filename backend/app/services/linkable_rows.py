"""The record picker's search — which records of a dataset a participant can be linked to (#1053).

## Why this is a server search

🔴 **The picker used to load EVERY record of the dataset, with every value, and
filter them in the browser.** `GET …/linkable-rows` read each row and each cell as
an ORM object, bound every row id into one `IN (…)` (past 250,000 records that is
SQLite's bind ceiling, #960) and built a lowercased copy of every value for the
client to substring-match. MEASURED on the scale corpus (2026-10-13): GSS 70.3 s,
72 MB of JSON, 5.0 GB in the server, the app frozen for all 70 s (`async def` with
no `await`) — and the client's 30 s limit plus `retry: 1` meant it never loaded at
all. BES: 27.1 s. The Participants panel then rendered one button per record.

Now: one statement answers a term with ONE page (`limit`, default 50) and the
total, and only the page's own values are read for its labels. Measured on the
same corpus, the prototype took 0.3–2.3 s and answered 9–13 KB.

## What a match is

- **Every stored value of the record, and its record id** — #418's guarantee
  (a picker that found only the label's columns could not find "S001" or "T05").
- 🔴 **A declared-missing value COUNTS as a match** (decision D5, 2026-10-13). On
  GSS every record holds `.i: inapplicable` somewhere, so that term matches all
  75,699 — and the `matched` excerpt is what makes that legible: it names the
  column and shows the words. Labels still skip missing values (#592's rule for a
  LABEL is unchanged; a slot spent on "99" identifies nothing).
- **Case is folded, and the fold must reach non-ASCII text.** SQLite's `LIKE` and
  `lower()` fold ASCII only. An ASCII term uses plain `LIKE` (case-insensitive for
  ASCII, and +55% cheaper than `ILIKE`'s translation, measured); any other term goes
  through `mm_casefold`, a deterministic Python function registered on the
  connection (~2× the cost, measured) — without it "élodie" stops finding
  "Élodie", which the old browser search did. ⚠️ A PostgreSQL port needs `ILIKE`
  for the ASCII arm and its own fold for the other.
- `%`, `_` and `\\` in a term are literal (escaped), not wildcards.

## The ranking

`rank = (identity ? 0 : 3) + tier`, the minimum over a record's matches, then the
grid's own order (`dataset_row_order`). `tier` is exact (0) · starts with (1) ·
contains (2), compared on the trimmed, folded text. **Identity** is the record id
or a column typed `identifier` — the values that exist to name a record — so on
GSS a search for "23" puts the record whose id contains 23 ahead of every record
whose AGE is 23. A bounded list needs a ranking (`participant-search.ts`'s
reasoning): in the grid's order an exact id sits behind every longer id that
contains it.

## The plan, which is the cost

🔴 **Rows by `dataset_id`, then values by `row_id` — and NO `column_id` filter.**
Adding `column_id IN (the dataset's columns)` "for safety" flips SQLite onto
`ix_dataset_values_column_id` and walks every value of every column: 2.6 s against
0.95 s on GSS (EXPLAIN QUERY PLAN, measured). `test_linkable_rows_search.py` pins
the plan. No row-id list is bound anywhere, so there is no ceiling to meet (the
old endpoint's `IN (every row id)` was on #960's list); the page's own ids go
through `in_id_set`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import case, func, literal, select, union_all
from sqlalchemy.orm import Session

from ..models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.participant import Participant
from .dataset_rows import dataset_row_order
from .id_set import in_id_set
from .missing_values import column_missing_rules, is_missing
from .participant_dataset import ACTION_LINK_PARTICIPANTS, managed_dataset_refusal

#: One page of the picker (D5). The client shows it and offers *Show more*.
LINKABLE_PAGE_SIZE = 50
#: What a caller may ASK for — a bound, not a tuning knob (`DATASET_PAGE_SIZE`'s
#: reasoning). It is also the most ids the page's label read binds.
MAX_LINKABLE_PAGE_SIZE = 200
#: A search term longer than any value worth typing is refused (422) rather than
#: sent through `LIKE`; the client's box carries the same limit.
MAX_SEARCH_TERM_LENGTH = 200

#: The column types whose values LABEL a record (#414/#418): identifier columns
#: exist to name rows; names, schools and categories identify; a score does not.
IDENTIFYING_TYPES = frozenset({
    ColumnType.IDENTIFIER, ColumnType.OPEN_TEXT, ColumnType.NOMINAL, ColumnType.DEMOGRAPHIC,
})
#: How many identifying values a record's label carries, and how long each may be.
DISPLAY_VALUE_LIMIT = 3
DISPLAY_VALUE_CHARS = 40
#: Characters of context either side of a match in the `matched` excerpt.
EXCERPT_CONTEXT = 25
_WHITESPACE = re.compile(r"\s+")

#: The SQL name of the non-ASCII fold. Registered per connection on first use.
CASEFOLD_FUNCTION = "mm_casefold"

_IDENTITY_RANK = 0
_VALUE_RANK = 3


def _casefold(text: str | None) -> str | None:
    return text.casefold() if text is not None else None


def _register_casefold(db: Session) -> None:
    """Make ``mm_casefold`` callable on the session's connection.

    ⚠️ Registered on the DBAPI connection the session is using, every time a
    non-ASCII term arrives — cheap, idempotent, and it reaches whichever engine
    built that connection (the app's, SQLCipher's, a test's), where a connect hook
    in `database.py` would miss the last. `sqlcipher3` accepts
    ``deterministic=True`` (checked 2026-10-13 against the pinned build).
    """
    dbapi = db.connection().connection.dbapi_connection
    dbapi.create_function(CASEFOLD_FUNCTION, 1, _casefold, deterministic=True)


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@dataclass(frozen=True)
class _Predicates:
    """`(contains, exact, starts_with)` for one text expression."""
    contains: object
    exact: object
    starts_with: object


def _predicates(expr, term: str) -> _Predicates:
    """The three tests a term makes of ``expr``, ASCII and non-ASCII alike."""
    if term.isascii():
        low = term.lower()
        escaped = _escape_like(low)
        return _Predicates(
            contains=expr.like(f"%{escaped}%", escape="\\"),
            exact=func.lower(func.trim(expr)) == low,
            starts_with=func.trim(expr).like(f"{escaped}%", escape="\\"),
        )
    folded = term.casefold()
    fold = getattr(func, CASEFOLD_FUNCTION)
    trimmed = fold(func.trim(expr))
    return _Predicates(
        contains=func.instr(fold(expr), folded) > 0,
        exact=trimmed == folded,
        starts_with=func.instr(trimmed, folded) == 1,
    )


def _tier(p: _Predicates):
    return case((p.exact, 0), (p.starts_with, 1), else_=2)


def match_statement(dataset_id: int, term: str, identifier_column_ids: list[int]):
    """``(row_id, rank)`` for every record of the dataset that ``term`` matches.

    A record id match and a value match are `UNION ALL`ed and reduced to the best
    rank per record. Exposed for the plan test, which asks SQLite how it runs THIS
    statement rather than a copy of it.
    """
    value = _predicates(DatasetValue.value_text, term)
    identity = (
        case((DatasetValue.column_id.in_(identifier_column_ids), _IDENTITY_RANK), else_=_VALUE_RANK)
        if identifier_column_ids else literal(_VALUE_RANK)
    )
    value_matches = (
        select(DatasetValue.row_id.label("row_id"), func.min(identity + _tier(value)).label("rank"))
        .select_from(DatasetRow)
        # 🔴 rows by dataset, then values by row — never a `column_id` filter (module doc).
        .join(DatasetValue, DatasetValue.row_id == DatasetRow.id)
        .where(DatasetRow.dataset_id == dataset_id, value.contains)
        .group_by(DatasetValue.row_id)
    )
    record_id = _predicates(DatasetRow.row_identifier, term)
    record_id_matches = (
        select(DatasetRow.id.label("row_id"), (_IDENTITY_RANK + _tier(record_id)).label("rank"))
        .where(DatasetRow.dataset_id == dataset_id, record_id.contains)
    )
    both = union_all(value_matches, record_id_matches).subquery()
    return (
        select(both.c.row_id, func.min(both.c.rank).label("rank"))
        .group_by(both.c.row_id)
        .subquery("matches")
    )


def _column_label(column: DatasetColumn) -> str:
    """The client's `columnDisplayLabel` precedence (#575), for the excerpt's label."""
    for text in (column.column_name, column.column_text, column.column_code):
        if text and text.strip():
            return text.strip()
    return f"Column {column.id}"


def _folded_span(text: str, folded_term: str) -> tuple[int, int] | None:
    """Where ``folded_term`` occurs in ``text`` under casefolding, in ``text``'s own indices.

    ⚠️ Not ``text.casefold().find(...)`` used as an index into ``text``: a fold can
    change a string's length ("ß" → "ss"), and the excerpt would then cut the
    wrong characters. Each folded character remembers which original it came from.
    """
    folded_chars: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        f = ch.casefold()
        folded_chars.append(f)
        origin.extend([i] * len(f))
    at = "".join(folded_chars).find(folded_term)
    if at < 0:
        return None
    return origin[at], origin[at + len(folded_term) - 1] + 1


def _excerpt(text: str, span: tuple[int, int]) -> str:
    """The match with up to `EXCERPT_CONTEXT` characters either side, cut at a word
    boundary where the context has one, whitespace collapsed, and an ellipsis
    wherever text was left out."""
    start, end = span
    lo = max(0, start - EXCERPT_CONTEXT)
    hi = min(len(text), end + EXCERPT_CONTEXT)
    # Cut only where the window would split a word.
    if 0 < lo and not text[lo - 1].isspace() and not text[lo].isspace():
        gap = _WHITESPACE.search(text, lo, start)
        if gap:
            lo = gap.end()
    if hi < len(text) and not text[hi].isspace() and not text[hi - 1].isspace():
        gaps = list(_WHITESPACE.finditer(text, end, hi))
        if gaps:
            hi = gaps[-1].start()
    window = " ".join(text[lo:hi].split())
    return ("…" if lo > 0 else "") + window + ("…" if hi < len(text) else "")


def _label(value: str | None, rules) -> str | None:
    """A value as a record's label shows it, or None when it identifies nothing."""
    if not value or not value.strip() or is_missing(value, rules):
        return None
    cleaned = value.strip()
    if len(cleaned) > DISPLAY_VALUE_CHARS:
        return cleaned[:DISPLAY_VALUE_CHARS - 1].rstrip() + "…"
    return cleaned


def search_linkable_rows(
    db: Session,
    dataset: Dataset,
    q: str = "",
    limit: int = LINKABLE_PAGE_SIZE,
    offset: int = 0,
) -> dict:
    """One page of the records ``q`` matches, best first, and how many there are.

    An empty ``q`` is every record in the grid's order. Records already linked to
    someone are INCLUDED, with the holder's name — the picker shows them as taken,
    which is how a researcher learns where a record went.

    A table the tool maintains (`managed_kind`) answers with its refusal sentence
    and no rows: its records link themselves at the next refresh (#1157), and a
    409 on a GET would render as "could not be loaded".
    """
    refusal = managed_dataset_refusal(dataset, ACTION_LINK_PARTICIPANTS)
    if refusal is not None:
        return {"rows": [], "total": 0, "limit": limit, "offset": offset, "link_refusal": refusal}

    columns = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset.id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )
    term = q.strip()

    if not term:
        total = db.execute(
            select(func.count()).select_from(DatasetRow).where(DatasetRow.dataset_id == dataset.id)
        ).scalar_one()
        page = db.execute(
            select(DatasetRow.id, DatasetRow.row_identifier, DatasetRow.participant_id)
            .where(DatasetRow.dataset_id == dataset.id)
            .order_by(*dataset_row_order())
            .limit(limit).offset(offset)
        ).all()
    else:
        if not term.isascii():
            _register_casefold(db)
        matches = match_statement(
            dataset.id, term,
            [c.id for c in columns if c.column_type == ColumnType.IDENTIFIER],
        )
        page = db.execute(
            select(
                DatasetRow.id, DatasetRow.row_identifier, DatasetRow.participant_id,
                func.count().over().label("total"),
            )
            .join(matches, matches.c.row_id == DatasetRow.id)
            .order_by(matches.c.rank, *dataset_row_order())
            .limit(limit).offset(offset)
        ).all()
        if page:
            total = page[0].total
        else:
            # Nothing on this page: either nothing matched, or the offset is past
            # the end — only a count can say which.
            total = (
                db.execute(select(func.count()).select_from(matches)).scalar_one()
                if offset else 0
            )

    page_ids = [r.id for r in page]
    values: dict[tuple[int, int], str | None] = {}
    if page_ids:
        # Bounded by the page, never by the dataset — and sent as one parameter
        # (`in_id_set`), so no page size meets the bind ceiling either.
        for row_id, column_id, text in db.execute(
            select(DatasetValue.row_id, DatasetValue.column_id, DatasetValue.value_text)
            .where(in_id_set(DatasetValue.row_id, page_ids))
        ):
            values[(row_id, column_id)] = text

    linked_ids = {r.participant_id for r in page if r.participant_id}
    names: dict[int, str] = {}
    if linked_ids:
        for pid, display_name, identifier in db.execute(
            select(Participant.id, Participant.display_name, Participant.identifier)
            .where(in_id_set(Participant.id, linked_ids))
        ):
            names[pid] = display_name or identifier

    # #592: per-column missing rules for the LABEL skip (parsed once per request).
    label_rules = {c.id: column_missing_rules(c) for c in columns if c.column_type in IDENTIFYING_TYPES}
    folded_term = term.casefold()

    rows = []
    for r in page:
        display: list[str] = []
        shown_columns: set[int] = set()  # columns whose WHOLE value the label shows
        for c in columns:
            if c.id not in label_rules:
                continue
            text = values.get((r.id, c.id))
            shown = _label(text, label_rules[c.id])
            if shown is None:
                continue
            display.append(shown)
            if shown == text.strip():
                shown_columns.add(c.id)
            if len(display) >= DISPLAY_VALUE_LIMIT:
                break

        # Which value matched, when the row's label does not already say so: the
        # record id, or a value shown whole, needs no excerpt.
        matched = None
        if term and not (r.row_identifier and _folded_span(r.row_identifier, folded_term)):
            for c in columns:
                text = values.get((r.id, c.id))
                if not text:
                    continue
                span = _folded_span(text, folded_term)
                if span is None:
                    continue
                if c.id in shown_columns:
                    break
                matched = {
                    "column_id": c.id,
                    "column_label": _column_label(c),
                    "excerpt": _excerpt(text, span),
                }
                break

        rows.append({
            "row_id": r.id,
            "row_identifier": r.row_identifier,
            "linked_participant_id": r.participant_id,
            "linked_participant_name": names.get(r.participant_id) if r.participant_id else None,
            "display_values": display,
            "matched": matched,
        })

    return {"rows": rows, "total": total, "limit": limit, "offset": offset, "link_refusal": None}
