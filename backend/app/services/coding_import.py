"""Bulk import of code applications — a file of codings becomes coding (row 49).

Until now the ONLY way a coding could enter a project from outside was a
`.mmproject` merge, which requires the other side to be Mixed Measures. This is
the door for everything else: a corpus coded in another tool, a scripted
pipeline, and — the case that motivated it — **labels a model produced elsewhere,
attributed to a MACHINE coder** (#989's layer) so they are visible, filterable and
permanently excluded from every reliability aggregate.

🔴 **NOTHING GENERATIVE ENTERS THE PRODUCT.** MM contains no model, calls no API
and sends nothing; a machine's labels arrive in a file exactly as a colleague's
arrive in a `.mmproject`. The 1.x claim is untouched, which is why row 49 ships in
1.x while Track D's assist mode stays at 2.0.

## The three questions a row asks, and where each is answered

1. **WHICH UNIT?** — §Unit resolution. One rule per target kind, DECLARED by the
   caller, never guessed: a segment uuid and a record identifier are different id
   spaces and resolving "whichever matches" is the silent-misattribution shape
   J3-2 built a confirm screen to avoid.
2. **WHICH CODE?** — trim-then-exact on the name, case-insensitively, because
   `create_code` has refused case-insensitive duplicates since #963.
3. **WHOSE JUDGEMENT?** — NOT answered here. `build_plan` is deliberately
   coder-agnostic; every distinct name in the file comes back as a candidate with
   its local match, and the researcher decides. **There is no silent name-match**,
   which is the one place this import departs from the merge's fallback.

## A file row is the SAME ACT as the workbench's (Batch 6, #1031)

🔴 **A grouped segment is ONE unit, for every kind of row.** A `SegmentGroup` exists
so adjacent turns are coded as one — `apply_code` fans a code out to every visible
sibling, and a rating and a set selection go with it. The import fanned out SET
selections only, so a plain code or a rating from a file reached the one sibling
the row named: a state the workbench cannot produce and cannot show as one unit.
Every segment row now carries its siblings (`group_targets_by_segment`, the
workbench's own derivation), and every in-file contradiction is judged on the
GROUP — two siblings given two values of one set, or two ratings of one code, by
one coder, is one unit given two answers.

🔴 **A code grouped INTO a set value is a selection too.** Routing by
`Code.code_set_id` alone wrote a synonym ("Pos" grouped with "Positive") as a plain
apply, so a coder holding "Negative" ended with both. `set_claimed_by` decides
membership now, as it does at every other apply door (#1028); a synonym goes
through the ordinary apply's swap because the set's own endpoint refuses a
non-member.

## A refused row never half-applies

The whole file is planned, then applied. A row that cannot be resolved carries a
NAMED reason and its own sentence (§`Reason`), and the response is an ordinary
200 with the failures listed — #678's rule: a partial failure is a body, not a
throw, and the failed set is stated explicitly rather than derived from what
succeeded.

## Set membership is derived from the CODE

If the resolved code counts in a `CodeSet`, the row is a SELECTION (exclusive)
rather than a plain apply. The file cannot then contradict the database about
what kind of write this is, and the researcher has one less column to get wrong.
An optional `code_set` column is checked as an ASSERTION — a file built against a
different codebook fails loudly instead of quietly applying the wrong kind of
write.

## What it does NOT do

- **It never marks staleness for a machine's rows.** `gather_target_votes` and
  the consensus materializer both filter `reliability_coder_clause()`, so a
  machine-attributed application cannot move consensus or a participant score.
  Marking anyway would enqueue one recompute marker per target for a recompute
  that provably changes nothing — up to one per row at the cap (the bound is the
  row cap, not the 368,717 figure that belongs to `merge_codes` on BES).
- **It never sets `origin='ai'`.** `origin` says how a ROW was produced and is
  reserved for a human accepting a model's suggestion (a future assist mode);
  the LAYER keys on the CODER. Writing it here would be a field no consumer reads
  (#941) and would make the two markers look interchangeable, which
  `coding_layers.py` is explicit that they are not.
"""
from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field, replace
from typing import Callable, Hashable, Iterable, Sequence

from sqlalchemy import func, insert
from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.dataset import (
    TEXT_CODEABLE_TYPES, Dataset, DatasetColumn, DatasetRow, DatasetValue,
)
from ..models.segment import Segment
from ..models.text_coding_config import TextCodingConfig, is_empty_text, parse_treat_as_empty
from ..models.user import User
from ..auth import CODER_TYPE_HUMAN, CODER_TYPE_MACHINE, SYSTEM_CODER_TYPES, unique_username
from . import code_sets as code_set_rules
from . import machine_coder
from . import magnitude as magnitude_rules
from .coding_layers import build_effective_code_map, project_scoped_segments
from .dataset_import import _csv_lines
from .id_set import in_id_set
from .identifier_match import group_unique_by_key, normalize_key
from .segment_groups import group_targets_by_segment

# ── Vocabulary ───────────────────────────────────────────────────────────────

#: `unit_id` names a `Segment.uuid`, anywhere in the project.
TARGET_SEGMENTS = "segments"
#: `unit_id` names a record in the dataset holding a chosen open-text column.
TARGET_TEXT_COLUMN = "text_column"

TARGET_KINDS = (TARGET_SEGMENTS, TARGET_TEXT_COLUMN)

#: Required and optional CSV headers. Matched case-insensitively with spaces and
#: hyphens folded to underscores, so `Unit ID` and `unit-id` both work — a
#: liberality that costs nothing and stops a spreadsheet's capitalisation being a
#: refusal the researcher cannot see.
REQUIRED_HEADERS = ("unit_id", "coder", "code")
OPTIONAL_HEADERS = ("code_set", "magnitude")

#: Another name a header may go by → the header it is read as.
#:
#: 🔴 **`rating` is what the coded-segments export WRITES (#1032 c)**, so without
#: it the export → import round trip — the design claim `coding-import.md` §2
#: makes — dropped every rating, silently: the import ignores a column it does not
#: know, and nothing said the ratings had not come with the codes.
HEADER_ALIASES = {"rating": "magnitude"}

#: The prefixes the exports' `csv_safe` defangs with a leading apostrophe
#: (`routers/export_helpers.py::_CSV_FORMULA_PREFIXES`). A service may not import
#: a router, so this is a copy — and `test_coding_import.py` pins the two equal.
CSV_DEFANGED_PREFIXES = ("=", "@", "\t", "\r")

#: The longest coder name any door accepts (`schemas/auth.py`'s `max_length=50`).
#: A `create` with no new name takes the FILE's cell, which is otherwise unbounded.
CODER_NAME_MAX_LENGTH = 50

#: Bounded because an import is exactly the shape `sql-id-sets.md` warns about,
#: and because every row becomes a row in `code_applications`. 200,000 covers the
#: demand case with room (a machine labelling all 75,699 posts of the GSS-scale
#: corpus on two variables) and is 4.7 MB of CSV, well under `MAX_UPLOAD_SIZE`.
#:
#: 🔴 **IT IS ALSO A FREEZE BUDGET, AND THAT IS MEASURED (#1000).** The endpoints
#: are `async def` for the multipart read and everything after it takes a `db`
#: Session, which no router in this codebase threadpools — so a full-cap import
#: runs ON the event loop: **6.9 s** on a plain file (parse 0.74 · plan 3.48 ·
#: apply 2.72, 2026-09-22, a 200,000-segment corpus) and **9.2–9.4 s** on a file
#: of grouped segments and code-set values (parse 0.9 · plan 4.9 · apply 3.5,
#: 2026-09-27d — that shape took 52.5–55.1 s before #1062). ⚠️ **A budget is a
#: claim about the shape it was measured on.** The phases are each linear in
#: rows, so **raising this raises those numbers with it.**
MAX_CODING_IMPORT_ROWS = 200_000

#: Bound for a chunked `.in_()` over STRING keys. `services/id_set.py::in_id_set`
#: is integers-only (`json.dumps(True)` is `true`, which silently matches
#: nothing), so string lookups chunk instead. Far below SQLite's 250,000.
_STRING_CHUNK = 5_000

# ── Why a row was not applied ────────────────────────────────────────────────
#
# NAMED rather than counted. Each needs different words and a different remedy —
# `participant_resolution.py`'s five-reason shape — and a summary that said only
# "37 rows skipped" would leave the researcher with no way to act.
#
# ⚠️ The client labels each one (`frontend/src/lib/coding-import-report.ts`,
# `satisfies Record<CodingImportReason, …>`), and `test_coding_import.py` reads
# that file: a reason added here without a label fails the suite.

REASON_UNIT_NOT_FOUND = "unit_not_found"
REASON_UNIT_AMBIGUOUS = "unit_ambiguous"
REASON_UNIT_NOT_CODEABLE = "unit_not_codeable"
REASON_CODE_NOT_FOUND = "code_not_found"
REASON_CODE_AMBIGUOUS = "code_ambiguous"
REASON_CODE_INACTIVE = "code_inactive"
REASON_CODER_MISSING = "coder_missing"
REASON_CODER_SKIPPED = "coder_skipped"
REASON_RATING_NOT_A_NUMBER = "rating_not_a_number"
REASON_RATING_OUTSIDE_SCALE = "rating_outside_scale"
REASON_RATING_WITHOUT_SCALE = "rating_without_scale"
REASON_RATING_CONFLICT_IN_FILE = "rating_conflict_in_file"
REASON_SET_MISMATCH = "set_mismatch"
REASON_SET_CONFLICT_IN_FILE = "set_conflict_in_file"
REASON_DUPLICATE_ROW = "duplicate_row"

#: ⚠️ Two reasons LEFT this list in Batch 6, each for its own reason:
#: `code_universal` — a universal code ("Unclear", "Unsubstantive") is ordinary
#: coding a researcher makes in the workbench, and refusing it lost those marks on
#: every export → import round trip with a sentence that offered no remedy;
#: `coder_unmapped` — never emitted (an unmapped name refuses the whole file,
#: `resolve_coders`), so it was vocabulary no row could carry (#1039 i, #941).
IMPORT_REASONS = (
    REASON_UNIT_NOT_FOUND, REASON_UNIT_AMBIGUOUS, REASON_UNIT_NOT_CODEABLE,
    REASON_CODE_NOT_FOUND, REASON_CODE_AMBIGUOUS, REASON_CODE_INACTIVE,
    REASON_CODER_MISSING, REASON_CODER_SKIPPED,
    REASON_RATING_NOT_A_NUMBER, REASON_RATING_OUTSIDE_SCALE,
    REASON_RATING_WITHOUT_SCALE, REASON_RATING_CONFLICT_IN_FILE,
    REASON_SET_MISMATCH, REASON_SET_CONFLICT_IN_FILE, REASON_DUPLICATE_ROW,
)


class CodingImportError(ValueError):
    """A file that cannot be read at all. The router renders `str(exc)` (#871)."""


# ── Parsing ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ParsedRow:
    """One data row, trimmed, with its 1-based line number for the report."""

    line: int
    unit_id: str
    coder: str
    code: str
    code_set: str
    magnitude: str


def _normalize_header(value: str | None) -> str:
    return (value or "").strip().lower().replace(" ", "_").replace("-", "_")


def undo_formula_defang(cell: str) -> str:
    """The inverse of the exports' `csv_safe`: `'@mention` → `@mention`.

    🔴 **A code, coder or record id that begins with a formula character comes
    out of this app's own exports with an apostrophe in front** (#1032 c), and the
    import compared it verbatim — so a code named `@mention` came back as
    *"There is no code called “'@mention”"*, from a file the tool wrote.

    ⚠️ Only an apostrophe followed by one of the defanged prefixes is removed, so
    an ordinary leading apostrophe survives. The one value this misreads is a
    name that genuinely begins `'@` — which `csv_safe` itself cannot round-trip
    either.
    """
    if len(cell) > 1 and cell[0] == "'" and cell[1] in CSV_DEFANGED_PREFIXES:
        return cell[1:]
    return cell


def decode_csv(raw: bytes) -> str:
    """Bytes to text, UTF-8 first.

    ⚠️ `utf-8-sig` so a BOM from Excel is consumed rather than becoming part of
    the first header name — the trap `codebook_exchange.py` records for `.qdc`
    (#764), reached by the same route. A cp1252 fallback covers the other thing
    Excel emits; anything else is refused with its own sentence rather than
    decoded into mojibake that would then fail to match any unit.
    """
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise CodingImportError(
        "This file is not readable as text. Save it as CSV with UTF-8 encoding "
        "and try again."
    )


def parse_rows(text: str) -> list[ParsedRow]:
    """The CSV as rows, or raise `CodingImportError` naming what is missing.

    ⚠️ **Blank lines are skipped and do NOT advance the reported line number's
    meaning** — the number is the spreadsheet row a researcher will look at, so
    it counts every physical line including the header.

    ⚠️ **`_csv_lines`, never `io.StringIO(text)`** (#1039 i): the latter stores its
    buffer at 4 bytes per character, so a 49 MB file cost ~190 MB before a row was
    read — and before the row cap below could refuse it.
    """
    reader = csv.reader(_csv_lines(text))
    try:
        header = next(reader)
    except StopIteration:
        raise CodingImportError("The file is empty.") from None

    positions: dict[str, int] = {}
    spelled: dict[str, str] = {}
    for index, raw in enumerate(header):
        name = _normalize_header(raw)
        canonical = HEADER_ALIASES.get(name, name)
        if canonical in spelled and spelled[canonical] != name:
            raise CodingImportError(
                f"The file has both a “{spelled[canonical]}” and a “{name}” column, "
                "and they mean the same thing. Keep one of them."
            )
        # First wins: a duplicated header is a file defect, and silently taking
        # the LAST one is how `preview_dataset_csv` described the second column's
        # values under the first column's name (#973 (b')).
        if canonical and canonical not in positions:
            positions[canonical] = index
            spelled[canonical] = name

    missing = [h for h in REQUIRED_HEADERS if h not in positions]
    if missing:
        raise CodingImportError(
            "The file needs a column for "
            + ", ".join(f"“{h}”" for h in missing)
            + ". The header row should read: "
            + ", ".join(REQUIRED_HEADERS + OPTIONAL_HEADERS)
            + " (the last two are optional, and “rating” works for “magnitude”)."
        )

    def cell(row: Sequence[str], name: str) -> str:
        index = positions.get(name)
        if index is None or index >= len(row):
            return ""
        return undo_formula_defang((row[index] or "").strip()).strip()

    rows: list[ParsedRow] = []
    for line, raw_row in enumerate(reader, start=2):
        if not any((c or "").strip() for c in raw_row):
            continue
        rows.append(ParsedRow(
            line=line,
            unit_id=cell(raw_row, "unit_id"),
            coder=cell(raw_row, "coder"),
            code=cell(raw_row, "code"),
            code_set=cell(raw_row, "code_set"),
            magnitude=cell(raw_row, "magnitude"),
        ))
        if len(rows) > MAX_CODING_IMPORT_ROWS:
            raise CodingImportError(
                f"This file has more than {MAX_CODING_IMPORT_ROWS:,} codings. "
                "Split it and import the parts one after another — they add up in "
                "the project."
            )
    return rows


# ── The plan ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RowProblem:
    line: int
    reason: str
    detail: str


@dataclass(frozen=True)
class PlannedApplication:
    line: int
    coder: str
    code_id: int
    code_name: str
    #: Exactly one is set, matching `ck_code_application_exactly_one_target`.
    #: For a segment this is the one the ROW named; `targets` is what it reaches.
    segment_id: int | None
    dataset_value_id: int | None
    #: The set this code counts in (a member's own set, or the set a synonym is
    #: grouped into), or None for a plain apply.
    code_set_id: int | None
    magnitude: float | None
    #: A grouped segment's VISIBLE siblings, itself included — derived once, at
    #: plan time, through the workbench's own helper. Empty for an ungrouped
    #: segment and for a dataset cell.
    group_segment_ids: tuple[int, ...] = ()
    #: What "this unit" is when the file is checked for contradictions: the GROUP
    #: for a grouped segment, else the segment or the cell.
    unit_key: tuple[str, int] = ("", 0)
    #: The set VALUE this code reads as (`ResolvedSet.claimants`) — a synonym and
    #: its value are one choice, two values are a contradiction.
    set_value_id: int | None = None
    set_label: str = ""

    @property
    def segment_targets(self) -> tuple[int, ...]:
        """Every segment this row's act covers (empty for a dataset cell)."""
        if self.segment_id is None:
            return ()
        return self.group_segment_ids or (self.segment_id,)


@dataclass(frozen=True)
class CoderCandidate:
    """A coder named in the file, and what this install already has by that name."""

    name: str
    row_count: int
    #: Of those, how many the plan would WRITE. Found by driving (Batch 6): a name
    #: whose every row is refused was still asked for a kind and, if created,
    #: added an empty coder to the roster — so the page can default it to skip.
    rows_to_apply: int
    local_user_id: int | None
    local_coder_type: str | None
    local_archived: bool
    local_application_count: int
    local_machine_provenance: dict | None


@dataclass
class ImportPlan:
    target_kind: str
    column_id: int | None
    rows_read: int
    applications: list[PlannedApplication] = field(default_factory=list)
    problems: list[RowProblem] = field(default_factory=list)
    coders: list[CoderCandidate] = field(default_factory=list)
    #: 🔴 **Each HALF of the addressing, counted on its own (#1004).** Distinct
    #: unit ids the file names, and how many of them name a unit in this project;
    #: distinct code names, and how many name a code. They used to be counted over
    #: the rows that would be WRITTEN, so a file whose ids were all wrong showed
    #: "Codes matched 0" beside a codebook it matched perfectly — both headline
    #: numbers pointing at the codes when only the key was wrong.
    units_in_file: int = 0
    units_matched: int = 0
    codes_in_file: int = 0
    codes_matched: int = 0
    #: Passages coded because they are GROUPED with one the file names — the
    #: difference between "rows applied" and "codings added", said before the act.
    grouped_passages: int = 0

    @property
    def reason_counts(self) -> dict[str, int]:
        return reason_counts(self.problems)


def reason_counts(problems: Iterable[RowProblem]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for problem in problems:
        counts[problem.reason] = counts.get(problem.reason, 0) + 1
    return counts


@dataclass(frozen=True)
class CoderDecision:
    """What to do with one name in the file. `skip` imports none of its rows."""

    action: str  # "match" | "create" | "skip"
    target_user_id: int | None = None
    new_username: str | None = None
    coder_type: str = CODER_TYPE_HUMAN
    machine_provenance: dict | None = None
    #: `match` onto an ARCHIVED coder: bring them back (#1031 c). The merge's
    #: decision carries the same flag, for the same reason.
    unarchive: bool = False


@dataclass
class ImportReport:
    rows_read: int = 0
    applied: int = 0
    already_present: int = 0
    selections: int = 0
    replaced: int = 0
    ratings_set: int = 0
    coders_matched: int = 0
    coders_created: int = 0
    coders_unarchived: int = 0
    #: Who was brought back — for the audit entry, which is the durable record.
    unarchived_coder_ids: list[int] = field(default_factory=list)
    skipped: int = 0
    problems: list[RowProblem] = field(default_factory=list)


def _chunked(values: Sequence, size: int = _STRING_CHUNK) -> Iterable[Sequence]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


# ── Unit resolution ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _ResolvedUnit:
    segment_id: int | None
    dataset_value_id: int | None
    codeable: bool
    #: The sentence for `unit_not_codeable`, because the two ways to be uncodeable
    #: have different remedies (re-word the project's non-response list vs undo a
    #: segment merge).
    not_codeable_detail: str = ""
    group_id: int | None = None


def _resolve_segment_units(
    db: Session, project_id: int, keys: list[str],
) -> tuple[dict[str, _ResolvedUnit], list[str]]:
    """`Segment.uuid` → unit, for the uuids this file names.

    🔴 **Bounded by the FILE, never by the project.** Loading every segment uuid
    would be 1.2 million strings on the BES corpus — the shape #842 and #958 are
    both about. Chunked `.in_()` on strings, because `in_id_set` is integers-only.

    ⚠️ A merged-away or split-away segment is returned as NOT CODEABLE rather
    than as missing: its codings are UI-unreachable (#500), so writing one would
    create a row with no chip, no row and no way to remove it — and telling the
    researcher the unit does not exist would be a false sentence about a unit
    that does.
    """
    found: list[tuple[str, _ResolvedUnit]] = []
    for chunk in _chunked(keys):
        rows = (
            project_scoped_segments(
                db.query(
                    Segment.uuid, Segment.id, Segment.merged_into_id,
                    Segment.split_into_id, Segment.group_id,
                ),
                project_id,
            )
            .filter(Segment.uuid.in_(list(chunk)))
            .all()
        )
        for uuid, seg_id, merged_into, split_into, group_id in rows:
            hidden = merged_into is not None or split_into is not None
            found.append((normalize_key(uuid), _ResolvedUnit(
                segment_id=seg_id,
                dataset_value_id=None,
                codeable=not hidden,
                not_codeable_detail=(
                    "That segment was merged or split away, so its coding would be "
                    "unreachable in the app. Undo the merge or split first."
                    if hidden else ""
                ),
                group_id=group_id,
            )))
    return group_unique_by_key(found)


def _coded_column(db: Session, project_id: int, column_id: int) -> DatasetColumn:
    """The column the file codes — in this project, and one Text Coding shows.

    ⚠️ **A column of another type is REFUSED, not coded (Batch 6).** The import
    took any column id, so a file could code an identifier's or a number's cells:
    applications no screen offers, shows or removes — #987's UI-unreachable class.
    The page only offers text columns; a script could send anything.
    """
    column = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id == column_id, Dataset.project_id == project_id)
        .first()
    )
    if column is None:
        raise CodingImportError("That text column is not in this project.")
    if column.column_type not in TEXT_CODEABLE_TYPES:
        raise CodingImportError(
            f"“{column.column_name or column.column_text}” is not an open-text "
            "column, so codings on it would not appear anywhere in the app. Choose "
            "the open-text column these codings are about."
        )
    return column


def _resolve_text_units(
    db: Session,
    project_id: int,
    keys: list[str],
    *,
    column_id: int,
    match_column_id: int | None,
) -> tuple[dict[str, _ResolvedUnit], list[str]]:
    """A record identifier (or a chosen column's value) → the cell in `column_id`.

    Two named keys, and the caller CHOOSES between them:

    - **the record identifier** (`DatasetRow.row_identifier`) — what the Text
      Coding export emits as *Record ID* and what the view displays, so a file
      built from this tool's own export round-trips;
    - **a column's values** (`match_column_id`) — the researcher's OWN key, e.g.
      the `post_id` a model pipeline was given. `row_identifier` is always
      MACHINE-generated (`R0001`, or a participant identifier), never a raw cell,
      so without this arm a pipeline built on the original file could not address
      anything.

    ⚠️ **Resolution is two hops on purpose** — key → ROW, then row → the cell in
    the coded column — so both keys share one path and one set of refusals.

    🔴 **The id column must be in the CODED column's dataset (#1032 a).** It was
    filtered by its id alone: a column from another dataset refused every row with
    a sentence about the wrong thing, and — under `MM_MULTIUSER_AUTH_ENABLED` — a
    foreign project's column id answered `unit_not_codeable` for its values and
    `unit_not_found` for anything else, an existence oracle (#782/#783's rule:
    every per-entity id is checked, not only the project). One sentence for
    "not there" and "somewhere else", so the refusal says nothing about which.
    """
    column = _coded_column(db, project_id, column_id)
    if match_column_id is not None:
        same_dataset = (
            db.query(DatasetColumn.id)
            .filter(
                DatasetColumn.id == match_column_id,
                DatasetColumn.dataset_id == column.dataset_id,
            )
            .first()
        )
        if same_dataset is None:
            raise CodingImportError(
                "The column chosen for the ids is not in the same dataset as the "
                "column you are coding. Choose one of that dataset's columns, or "
                "use the record IDs."
            )

    row_pairs: list[tuple[str, int]] = []
    for chunk in _chunked(keys):
        if match_column_id is None:
            rows = (
                db.query(DatasetRow.row_identifier, DatasetRow.id)
                .filter(
                    DatasetRow.dataset_id == column.dataset_id,
                    DatasetRow.row_identifier.in_(list(chunk)),
                )
                .all()
            )
        else:
            rows = (
                db.query(DatasetValue.value_text, DatasetValue.row_id)
                .filter(
                    DatasetValue.column_id == match_column_id,
                    DatasetValue.value_text.in_(list(chunk)),
                )
                .all()
            )
        row_pairs.extend((normalize_key(key), row_id) for key, row_id in rows)

    rows_by_key, duplicates = group_unique_by_key(row_pairs)
    if not rows_by_key:
        return {}, duplicates

    # Hop two: the cell in the CODED column. A record with no cell there is a
    # real state — an imported column is sparse by design (#897) — and it is not
    # codeable, which is a different sentence from "no such record".
    row_ids = list(rows_by_key.values())
    cells = {
        row_id: (value_id, value_text)
        for value_id, row_id, value_text in db.query(
            DatasetValue.id, DatasetValue.row_id, DatasetValue.value_text,
        ).filter(
            DatasetValue.column_id == column_id,
            in_id_set(DatasetValue.row_id, row_ids),
        ).all()
    }

    config = (
        db.query(TextCodingConfig)
        .filter(TextCodingConfig.project_id == project_id)
        .first()
    )
    treat_as_empty = parse_treat_as_empty(config.treat_as_empty if config else None)

    resolved: dict[str, _ResolvedUnit] = {}
    for key, row_id in rows_by_key.items():
        cell = cells.get(row_id)
        if cell is None:
            resolved[key] = _ResolvedUnit(
                segment_id=None, dataset_value_id=None, codeable=False,
                not_codeable_detail=(
                    "That record has no text in the column you are coding."
                ),
            )
            continue
        value_id, value_text = cell
        # 🔴 #987's rule, reached from the import side: a cell the project treats
        # as a non-response is NOT a unit a coder could reach, so coding it would
        # create exactly the UI-unreachable application #987 removed from the
        # reliability statistic — no chip, no row, no way to remove it.
        empty = is_empty_text(value_text, treat_as_empty)
        resolved[key] = _ResolvedUnit(
            segment_id=None,
            dataset_value_id=value_id,
            codeable=not empty,
            not_codeable_detail=(
                "This project treats that response as a non-response, so it is not "
                "offered for coding. Change the non-response list in Text Coding "
                "settings if it should be."
                if empty else ""
            ),
        )
    return resolved, duplicates


# ── In-file contradictions ───────────────────────────────────────────────────


def _lines_phrase(lines: Sequence[int]) -> str:
    ordered = sorted(lines)
    if len(ordered) == 1:
        return f"Line {ordered[0]}"
    return "Lines " + ", ".join(str(n) for n in ordered[:-1]) + f" and {ordered[-1]}"


def _who(rows: Sequence[PlannedApplication]) -> str:
    """The coder a group of rows belongs to, as the researcher named them.

    Two names appear only when both were mapped onto ONE coder (#1039 i), and the
    sentence then has to say so or it would read as two people disagreeing.
    """
    names = sorted({r.coder for r in rows})
    if len(names) == 1:
        return f"“{names[0]}”"
    return " and ".join(f"“{n}”" for n in names) + " (imported as one coder)"


def _grouped_note(rows: Sequence[PlannedApplication]) -> str:
    if len({r.segment_id for r in rows}) > 1:
        return " (those passages are grouped, and a group is coded as one unit)"
    return ""


def _fmt_rating(value: float) -> str:
    return magnitude_rules._fmt(value)


def settle_contradictions(
    applications: Sequence[PlannedApplication],
    coder_key: Callable[[PlannedApplication], Hashable],
) -> tuple[list[PlannedApplication], list[RowProblem]]:
    """What the file says, once the rows that contradict each other are out.

    🔴 **A contradiction is counted, never resolved by picking one** — the
    `SET_MULTIPLE` rule, reached at the file. "First wins" and "last wins" are
    both a coin toss by another name. Three shapes, each judged on the UNIT a
    coder codes (a segment GROUP is one, #1031 b):

    1. one coder, one unit, one set, TWO VALUES → every row of that claim refused;
    2. one coder, one unit, one code, TWO RATINGS → every row refused. Until
       Batch 6 an exact repeat with another rating kept the first silently, and
       siblings of one group each kept their own, a state the workbench's rating
       fan-out cannot produce;
    3. the same coder, unit and code named twice with no disagreement → the
       repeat is a `duplicate_row`, and a rating stated on only one of them is
       the rating (a blank magnitude is "no statement", never a clear).

    Rows naming two SIBLINGS of a group with the same code both stay: an export
    lists every sibling, and the two rows are one act that the apply de-duplicates.

    ⚠️ **Called twice, with two keys, and that is the point of the parameter.**
    The planner keys on the file's NAME; the apply keys on the resolved CODER,
    because two names mapped onto one coder can contradict each other and neither
    name alone shows it.

    ⚠️ **Only a REPEATED key is grouped** (`_repeats`): at the 200,000-row cap
    nearly every key occurs once, and a list per key was ~30 MB of the import's
    peak for groups of one.
    """
    problems: list[RowProblem] = []
    refused: set[int] = set()

    # ── 1 + the synonym case: one choice per coder, unit and set ─────────────
    by_claim = _repeats(
        (a for a in applications if a.code_set_id is not None),
        lambda a: (coder_key(a), a.unit_key, a.code_set_id),
    )
    for rows in by_claim:
        values = {r.set_value_id for r in rows}
        if len(values) > 1:
            lines = [r.line for r in rows]
            names = sorted({r.code_name for r in rows})
            for r in rows:
                refused.add(r.line)
                problems.append(RowProblem(
                    r.line, REASON_SET_CONFLICT_IN_FILE,
                    f"{_lines_phrase(lines)} give {_who(rows)} different values of "
                    f"“{r.set_label}” ({', '.join(names)}) for the same "
                    f"unit{_grouped_note(rows)}, so none of them is applied — a "
                    "contradiction is not ours to resolve.",
                ))
            continue
        # One VALUE, possibly spelled by two codes (a synonym and its value).
        # Holding both is one choice, and the write keeps only one of them, so
        # the first code named is the one written and a later spelling adds
        # nothing — said, rather than swapped out by whichever runs second.
        first_code = rows[0].code_id
        for r in rows[1:]:
            if r.code_id != first_code:
                refused.add(r.line)
                problems.append(RowProblem(
                    r.line, REASON_DUPLICATE_ROW,
                    f"“{r.code_name}” and “{rows[0].code_name}” are the same value "
                    f"of “{r.set_label}”, and line {rows[0].line} already gives it "
                    "to this coder for this unit.",
                ))

    # ── 2 + 3: per coder, unit and code ──────────────────────────────────────
    by_code = _repeats(
        (a for a in applications if a.line not in refused),
        lambda a: (coder_key(a), a.unit_key, a.code_id),
    )

    # A row outside every repeated key is kept exactly as it came.
    rewritten: dict[int, PlannedApplication] = {}
    for rows in by_code:
        ratings = sorted({r.magnitude for r in rows if r.magnitude is not None})
        if len(ratings) > 1:
            lines = [r.line for r in rows]
            for r in rows:
                refused.add(r.line)
                problems.append(RowProblem(
                    r.line, REASON_RATING_CONFLICT_IN_FILE,
                    f"{_lines_phrase(lines)} give {_who(rows)} different ratings of "
                    f"“{r.code_name}” ({', '.join(_fmt_rating(v) for v in ratings)}) "
                    f"for the same unit{_grouped_note(rows)}, so none of them is "
                    "applied — a contradiction is not ours to resolve.",
                ))
            continue
        agreed = ratings[0] if ratings else None
        first_line_for_target: dict[int, int] = {}
        for r in rows:
            named = r.segment_id if r.segment_id is not None else r.dataset_value_id
            if named in first_line_for_target:
                refused.add(r.line)
                problems.append(RowProblem(
                    r.line, REASON_DUPLICATE_ROW,
                    "The same coder, unit and code appear earlier in this file "
                    f"(line {first_line_for_target[named]}).",
                ))
                continue
            first_line_for_target[named] = r.line
            if r.magnitude != agreed:
                rewritten[r.line] = replace(r, magnitude=agreed)

    kept = [rewritten.get(a.line, a) for a in applications if a.line not in refused]
    return kept, problems


def _repeats(
    items: Iterable[PlannedApplication],
    key: Callable[[PlannedApplication], Hashable],
) -> list[list[PlannedApplication]]:
    """The groups of items that SHARE a key, in file order — never a group of one."""
    first: dict[Hashable, PlannedApplication] = {}
    repeated: dict[Hashable, list[PlannedApplication]] = {}
    for item in items:
        k = key(item)
        if k in repeated:
            repeated[k].append(item)
        elif k in first:
            repeated[k] = [first[k], item]
        else:
            first[k] = item
    return list(repeated.values())


# ── Planning ─────────────────────────────────────────────────────────────────


def build_plan(
    db: Session,
    project_id: int,
    rows: list[ParsedRow],
    *,
    target_kind: str,
    column_id: int | None = None,
    match_column_id: int | None = None,
) -> ImportPlan:
    """Resolve every row against this project. NO WRITES, and no coder decisions.

    🔴 **Coder-agnostic on purpose.** Who a name maps onto is the researcher's
    decision (§module docstring), and keeping it out of the plan is what lets the
    preview and the apply run the SAME planner — #974's rule: a preview computed
    differently from the act it predicts is a preview of something else.
    """
    if target_kind not in TARGET_KINDS:
        raise CodingImportError(f"Unknown target kind {target_kind!r}.")
    if target_kind == TARGET_TEXT_COLUMN and column_id is None:
        raise CodingImportError("Choose the text column these codings are about.")

    plan = ImportPlan(target_kind=target_kind, column_id=column_id, rows_read=len(rows))

    unit_keys = sorted({r.unit_id for r in rows if r.unit_id})
    if target_kind == TARGET_SEGMENTS:
        units, ambiguous_keys = _resolve_segment_units(db, project_id, unit_keys)
    else:
        units, ambiguous_keys = _resolve_text_units(
            db, project_id, unit_keys,
            column_id=column_id, match_column_id=match_column_id,
        )
    ambiguous = set(ambiguous_keys)

    # A grouped segment's siblings, for every grouped unit the file names — the
    # workbench's derivation, batched (a query per chunk of GROUPS, not per row).
    group_targets = group_targets_by_segment(db, [
        (u.segment_id, u.group_id)
        for u in units.values()
        if u.codeable and u.segment_id is not None and u.group_id
    ])

    # ── Codes, by name ───────────────────────────────────────────────────────
    #
    # ⚠️ CASE-INSENSITIVE here while the UNIT key is case-sensitive, and the
    # asymmetry is deliberate: `create_code` refuses a case-insensitive duplicate
    # (#963), so two spellings of a code name ARE one code, while `P01` and `p01`
    # in a participant register can genuinely be two people. A project created
    # before that refusal can still hold two — `group_unique_by_key` turns those
    # into `code_ambiguous` rather than a coin toss.
    all_codes = db.query(Code).filter(Code.project_id == project_id).all()
    codes_by_name, ambiguous_code_names = group_unique_by_key(
        (c.name.strip().lower(), c) for c in all_codes if c.name
    )
    ambiguous_codes = set(ambiguous_code_names)

    effective_map = build_effective_code_map(db, project_id)
    set_index = code_set_rules.build_code_set_index(db, project_id, effective_map)

    # ── Each half of the addressing, counted on its own (#1004) ──────────────
    code_keys = {r.code.strip().lower() for r in rows if r.code.strip()}
    plan.units_in_file = len(unit_keys)
    plan.units_matched = sum(1 for k in unit_keys if k in units)
    plan.codes_in_file = len(code_keys)
    plan.codes_matched = sum(1 for k in code_keys if k in codes_by_name)

    coder_rows: dict[str, int] = defaultdict(int)
    candidates: list[PlannedApplication] = []
    problems: list[RowProblem] = []

    for row in rows:
        if not row.coder:
            problems.append(RowProblem(
                row.line, REASON_CODER_MISSING,
                "This row names no coder, so there is nobody to attribute it to.",
            ))
            continue
        coder_rows[row.coder] += 1

        if not row.unit_id:
            problems.append(RowProblem(
                row.line, REASON_UNIT_NOT_FOUND, "This row names no unit."))
            continue
        if row.unit_id in ambiguous:
            problems.append(RowProblem(
                row.line, REASON_UNIT_AMBIGUOUS,
                f"“{row.unit_id}” names more than one unit, so it matches none of "
                "them — picking one would attribute this coding to a unit nobody "
                "chose.",
            ))
            continue
        unit = units.get(row.unit_id)
        if unit is None:
            problems.append(RowProblem(
                row.line, REASON_UNIT_NOT_FOUND,
                f"Nothing in this project is identified by “{row.unit_id}”.",
            ))
            continue
        if not unit.codeable:
            problems.append(RowProblem(
                row.line, REASON_UNIT_NOT_CODEABLE, unit.not_codeable_detail))
            continue

        code_key = row.code.strip().lower()
        if not code_key:
            problems.append(RowProblem(
                row.line, REASON_CODE_NOT_FOUND, "This row names no code."))
            continue
        if code_key in ambiguous_codes:
            problems.append(RowProblem(
                row.line, REASON_CODE_AMBIGUOUS,
                f"Two codes in this project are called “{row.code}”. Rename one "
                "before importing.",
            ))
            continue
        code = codes_by_name.get(code_key)
        if code is None:
            problems.append(RowProblem(
                row.line, REASON_CODE_NOT_FOUND,
                f"There is no code called “{row.code}” in this project. Create it "
                "first, or correct the spelling in the file.",
            ))
            continue
        if not code.is_active:
            problems.append(RowProblem(
                row.line, REASON_CODE_INACTIVE,
                f"“{code.name}” is inactive, so it takes no new coding. Restore it "
                "first.",
            ))
            continue

        # ── The set, DERIVED from the code ───────────────────────────────────
        # `set_claimed_by`, never `Code.code_set_id`: a code GROUPED INTO a value
        # counts in the set too (#1028), and every other apply door swaps it.
        resolved_set = set_index.set_claimed_by(code.id)
        if row.code_set:
            declared = resolved_set.label if resolved_set is not None else None
            if normalize_key(row.code_set) != normalize_key(declared or ""):
                relation = (
                    "belongs to" if code.code_set_id is not None or resolved_set is None
                    else "counts as a value of"
                )
                problems.append(RowProblem(
                    row.line, REASON_SET_MISMATCH,
                    f"“{code.name}” {relation} "
                    + (f"“{declared}”" if declared else "no code set")
                    + f", not “{row.code_set}”. This file was built against a "
                    "different codebook.",
                ))
                continue

        # ── The rating ───────────────────────────────────────────────────────
        rating: float | None = None
        if row.magnitude:
            try:
                rating = float(row.magnitude)
            except ValueError:
                problems.append(RowProblem(
                    row.line, REASON_RATING_NOT_A_NUMBER,
                    f"“{row.magnitude}” is not a number.",
                ))
                continue
            if not magnitude_rules.has_scale(code):
                problems.append(RowProblem(
                    row.line, REASON_RATING_WITHOUT_SCALE,
                    f"“{code.name}” has no rating scale, so it cannot carry "
                    f"{row.magnitude}. Declare one on the code first.",
                ))
                continue
            try:
                rating = magnitude_rules.validate_value(code, rating)
            except magnitude_rules.MagnitudeError as exc:
                problems.append(RowProblem(
                    row.line, REASON_RATING_OUTSIDE_SCALE, str(exc)))
                continue

        if unit.segment_id is not None:
            siblings = group_targets.get(unit.segment_id, ()) if unit.group_id else ()
            unit_key = ("group", unit.group_id) if unit.group_id else ("segment", unit.segment_id)
        else:
            siblings = ()
            unit_key = ("value", unit.dataset_value_id)

        candidates.append(PlannedApplication(
            line=row.line,
            coder=row.coder,
            code_id=code.id,
            code_name=code.name,
            segment_id=unit.segment_id,
            dataset_value_id=unit.dataset_value_id,
            code_set_id=resolved_set.id if resolved_set is not None else None,
            magnitude=rating,
            group_segment_ids=siblings,
            unit_key=unit_key,
            set_value_id=(
                resolved_set.claimants.get(code.id, code.id)
                if resolved_set is not None else None
            ),
            set_label=resolved_set.label if resolved_set is not None else "",
        ))

    planned, settled_problems = settle_contradictions(candidates, lambda a: a.coder)
    problems.extend(settled_problems)

    plan.applications = planned
    plan.problems = sorted(problems, key=lambda p: p.line)
    named = {a.segment_id for a in planned if a.segment_id is not None}
    reached = {t for a in planned for t in a.segment_targets}
    plan.grouped_passages = len(reached - named)
    to_apply: dict[str, int] = defaultdict(int)
    for app in planned:
        to_apply[app.coder] += 1
    plan.coders = _coder_candidates(db, coder_rows, to_apply)
    return plan


def _coder_candidates(
    db: Session, coder_rows: dict[str, int], to_apply: dict[str, int],
) -> list[CoderCandidate]:
    """Every name in the file with what this install already has by that name.

    🔴 **A CANDIDATE, never a decision.** The merge's coder loop falls back to a
    silent name-match when no decision is supplied; this import does NOT, because
    a `.mmproject` at least carries a uuid spine while a CSV carries a string a
    researcher typed. Silent misattribution is what J3-2's confirm screen exists
    to prevent, and it would be worse here.

    ⚠️ **A SYSTEM coder is never a candidate.** "Unattributed" and "Consensus" own
    data and are not people; matching onto either would write a researcher's
    codings into a derived layer.
    """
    if not coder_rows:
        return []
    names = list(coder_rows.keys())
    locals_by_name = {
        u.username: u
        for u in db.query(User).filter(
            User.username.in_(names),
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
        ).all()
    }
    local_ids = [u.id for u in locals_by_name.values()]
    counts: dict[int, int] = {}
    if local_ids:
        # ⚠️ `func.count()` — a bare COUNT(*) of that coder's APPLICATION rows,
        # which is what the merge's own coder preview shows (`local_app_count`)
        # and for the same reason: it is how a researcher tells two coders with
        # the same name apart. It is deliberately NOT a code count or a usage
        # count, so the J2-0 grain the sweep polices ("rows counted as codes")
        # does not apply — and it is spelled without `CodeApplication.id` so it
        # cannot be mistaken for one.
        counts = dict(
            db.query(CodeApplication.user_id, func.count())
            .filter(CodeApplication.user_id.in_(local_ids))
            .group_by(CodeApplication.user_id)
            .all()
        )
    out: list[CoderCandidate] = []
    for name in sorted(names):
        local = locals_by_name.get(name)
        out.append(CoderCandidate(
            name=name,
            row_count=coder_rows[name],
            rows_to_apply=to_apply.get(name, 0),
            local_user_id=local.id if local else None,
            local_coder_type=local.coder_type if local else None,
            local_archived=bool(local.archived) if local else False,
            local_application_count=counts.get(local.id, 0) if local else 0,
            local_machine_provenance=(
                machine_coder.read_provenance(local) if local else None
            ),
        ))
    return out


# ── Applying ─────────────────────────────────────────────────────────────────


def resolve_coders(
    db: Session, plan: ImportPlan, decisions: dict[str, CoderDecision],
) -> tuple[dict[str, int | None], ImportReport]:
    """Turn each name into a user id (creating where asked), or refuse.

    Returns `(name → user_id or None-for-skip, a report carrying the counts)`.

    🔴 **An UNMAPPED name is a refusal, not a fallback.** `CodingImportError` names
    the coders, so the client sends the researcher back to the mapping step rather
    than writing somebody's coding under a name that merely looked similar.

    ⚠️ **A decision carrying something it cannot use is REFUSED, never ignored**
    (#1039 i): a configuration on a person, or on a coder being MATCHED (whose
    configuration is its own, and frozen once it has coded) — dropping either
    silently would leave the researcher believing it was recorded.
    """
    report = ImportReport()
    resolved: dict[str, int | None] = {}
    missing = [c.name for c in plan.coders if c.name not in decisions]
    if missing:
        raise CodingImportError(
            "Say who these codings belong to before importing: "
            + ", ".join(f"“{n}”" for n in sorted(missing))
            + "."
        )

    for candidate in plan.coders:
        decision = decisions[candidate.name]
        if decision.action == "skip":
            resolved[candidate.name] = None
            continue
        if decision.action == "match":
            if decision.target_user_id is None:
                raise CodingImportError(
                    f"No coder was chosen for “{candidate.name}”."
                )
            if decision.machine_provenance is not None:
                raise CodingImportError(
                    f"A model configuration was sent for “{candidate.name}”, which is "
                    "being matched to an existing coder. An existing machine coder "
                    "keeps its own recorded configuration — create a new coder for a "
                    "different one."
                )
            target = (
                db.query(User)
                .filter(
                    User.id == decision.target_user_id,
                    User.coder_type.notin_(SYSTEM_CODER_TYPES),
                )
                .first()
            )
            if target is None:
                raise CodingImportError(
                    f"The coder chosen for “{candidate.name}” no longer exists. "
                    "Re-check the file before importing."
                )
            # 🔴 #1031 (c): an ARCHIVED coder's codings are hidden by default and
            # left out of reliability, consensus and the model comparison. The page
            # shows the state and offers this; nothing here decides it.
            if decision.unarchive and target.archived:
                target.archived = False
                report.coders_unarchived += 1
                report.unarchived_coder_ids.append(target.id)
            resolved[candidate.name] = target.id
            report.coders_matched += 1
            continue
        if decision.action == "create":
            base = (decision.new_username or candidate.name).strip() or "Coder"
            if len(base) > CODER_NAME_MAX_LENGTH:
                raise CodingImportError(
                    f"“{base[:40]}…” is longer than {CODER_NAME_MAX_LENGTH} "
                    "characters, the longest a coder's name can be. Give the new "
                    "coder a shorter name."
                )
            coder_type = (
                CODER_TYPE_MACHINE if decision.coder_type == CODER_TYPE_MACHINE
                else CODER_TYPE_HUMAN
            )
            provenance = None
            if decision.machine_provenance is not None:
                if coder_type != CODER_TYPE_MACHINE:
                    raise CodingImportError(
                        "Only a machine coder carries a model configuration."
                    )
                try:
                    provenance = machine_coder.normalize_provenance(
                        decision.machine_provenance
                    )
                except machine_coder.MachineCoderError as exc:
                    raise CodingImportError(str(exc)) from None
            coder = User(
                username=unique_username(db, base),
                password_hash=None,
                is_admin=False,
                coder_type=coder_type,
            )
            machine_coder.write_provenance(coder, provenance)
            db.add(coder)
            db.flush()
            resolved[candidate.name] = coder.id
            report.coders_created += 1
            continue
        raise CodingImportError(f"Unknown decision {decision.action!r}.")
    return resolved, report


def apply_plan(
    db: Session,
    project_id: int,
    plan: ImportPlan,
    decisions: dict[str, CoderDecision],
    *,
    attribution: str | None = None,
) -> ImportReport:
    """Write the plan. Flushes; the CALLER commits (the house transaction rule).

    The write is in five passes, and the order matters:

    1. **Coders** — resolved or created first, because every later pass keys on a
       user id. Two NAMES mapped onto one coder are checked for contradictions
       again, per coder (`settle_contradictions`).
    2. **Set selections** — members grouped by `(set, coder, chosen member)` so
       one call to `code_sets.apply_selection` covers every unit that took that
       value (`code-sets.md` §6 reason 4). A SYNONYM goes through
       `clear_rival_values`, the ordinary apply's swap, then the plain insert —
       `apply_selection` refuses a non-member.
    3. **Plain applies** — a Core `executemany`, never N `db.add`s, over every
       target each row reaches (a grouped segment's siblings included).
    4. **Ratings** — ONE pass over both kinds, grouped by `(code, coder, value)`,
       over the same targets. Re-rating clears `magnitude_conflict` because
       rating again IS the adjudication (#35 §6d).
    5. **Staleness** — marked HERE rather than at the router, so the rule
       *"every code-application mutation site marks consensus stale"* cannot be
       forgotten by a second caller. See `_mark_staleness` for why a machine's
       rows are excluded.
    """
    coder_ids, report = resolve_coders(db, plan, decisions)
    report.rows_read = plan.rows_read
    report.problems = list(plan.problems)

    applications: list[PlannedApplication] = []
    for app in plan.applications:
        user_id = coder_ids.get(app.coder)
        if user_id is None:
            report.problems.append(RowProblem(
                app.line, REASON_CODER_SKIPPED,
                f"“{app.coder}” was not imported, so this row was left out.",
            ))
            continue
        applications.append(app)

    resolved_user = {a.coder: coder_ids[a.coder] for a in applications}

    # 🔴 Two names onto ONE coder (#1039 i). The planner judged contradictions per
    # NAME, so "Alice: Positive" and "alice: Negative" on one unit both passed —
    # and whichever selection ran second swapped the first out. Judged per CODER
    # now, only when the mapping actually merged names.
    if len(set(resolved_user.values())) < len(resolved_user):
        applications, merged_problems = settle_contradictions(
            applications, lambda a: resolved_user[a.coder],
        )
        report.problems.extend(merged_problems)

    # ── 2. Set selections ────────────────────────────────────────────────────
    effective_map = build_effective_code_map(db, project_id)
    set_index = code_set_rules.build_code_set_index(db, project_id, effective_map)

    selection_groups: dict[tuple[int, int, int], list[PlannedApplication]] = defaultdict(list)
    synonym_groups: dict[tuple[int, int], list[PlannedApplication]] = defaultdict(list)
    plain: list[PlannedApplication] = []
    for app in applications:
        resolved_set = (
            set_index.by_id(app.code_set_id) if app.code_set_id is not None else None
        )
        if resolved_set is None:
            # No set — or the set was deleted between the preview and the import.
            # Not worth aborting the file for: the codes still exist, so the rows
            # are what the project now says they are, a plain apply.
            plain.append(app)
        elif app.code_id in resolved_set.raw_member_ids:
            selection_groups[
                (app.code_set_id, resolved_user[app.coder], app.code_id)
            ].append(app)
        else:
            synonym_groups[(resolved_user[app.coder], app.code_id)].append(app)

    for (set_id, user_id, code_id), group in selection_groups.items():
        resolved_set = set_index.by_id(set_id)
        segment_ids = [t for app in group for t in app.segment_targets]
        value_ids = [app.dataset_value_id for app in group if app.dataset_value_id is not None]
        if segment_ids:
            _, removed = code_set_rules.apply_selection(
                db, resolved_set, user_id=user_id, code_id=code_id,
                segment_ids=segment_ids, attribution=attribution,
            )
            report.replaced += removed
        if value_ids:
            _, removed = code_set_rules.apply_selection(
                db, resolved_set, user_id=user_id, code_id=code_id,
                dataset_value_ids=value_ids, attribution=attribution,
            )
            report.replaced += removed
        report.selections += len(group)

    for (user_id, code_id), group in synonym_groups.items():
        segment_ids = [t for app in group for t in app.segment_targets]
        value_ids = [app.dataset_value_id for app in group if app.dataset_value_id is not None]
        for kind, ids in (("segment_ids", segment_ids), ("dataset_value_ids", value_ids)):
            if ids:
                removed = code_set_rules.clear_rival_values(
                    db, set_index, code_id=code_id, user_id=user_id, **{kind: ids},
                )
                report.replaced += sum(len(codes) for codes in removed.values())
        report.selections += len(group)
        plain.extend(group)

    # ── 3. Plain applies ─────────────────────────────────────────────────────
    if plain:
        wanted: set[tuple[int, int, int | None, int | None]] = set()
        for app in plain:
            user_id = resolved_user[app.coder]
            if app.dataset_value_id is not None:
                wanted.add((user_id, app.code_id, None, app.dataset_value_id))
            for target in app.segment_targets:
                wanted.add((user_id, app.code_id, target, None))
        existing = _existing_applications(db, wanted)
        fresh = sorted(
            (w for w in wanted if w not in existing),
            key=lambda w: (w[0], w[1], w[2] or 0, w[3] or 0),
        )
        report.already_present += len(wanted) - len(fresh)
        if fresh:
            db.execute(insert(CodeApplication), [
                {
                    "segment_id": segment_id,
                    "dataset_value_id": value_id,
                    "code_id": code_id,
                    "user_id": user_id,
                    "attribution": attribution,
                }
                for (user_id, code_id, segment_id, value_id) in fresh
            ])
            db.flush()
        report.applied += len(fresh)

    # ── 4. Ratings, one pass over both kinds ─────────────────────────────────
    rating_groups: dict[tuple[int, int, float], list[PlannedApplication]] = defaultdict(list)
    for app in applications:
        if app.magnitude is not None:
            rating_groups[(app.code_id, resolved_user[app.coder], app.magnitude)].append(app)
    for (code_id, user_id, value), group in rating_groups.items():
        segment_ids = sorted({t for a in group for t in a.segment_targets})
        value_ids = sorted({a.dataset_value_id for a in group if a.dataset_value_id is not None})
        for column, ids in (
            (CodeApplication.segment_id, segment_ids),
            (CodeApplication.dataset_value_id, value_ids),
        ):
            if not ids:
                continue
            report.ratings_set += (
                db.query(CodeApplication)
                .filter(
                    CodeApplication.code_id == code_id,
                    CodeApplication.user_id == user_id,
                    in_id_set(column, ids),
                )
                # Rating again IS the adjudication of a merge conflict (#35 §6d),
                # so the flag goes with the value.
                .update({"magnitude": value, "magnitude_conflict": None},
                        synchronize_session=False)
            )
    db.flush()

    # ── 5. Staleness ─────────────────────────────────────────────────────────
    _mark_staleness(db, project_id, applications, resolved_user)
    if report.coders_unarchived:
        # Archiving a coder moves every participant score on the install
        # (`gather_target_votes` filters `archived`), and so does bringing one
        # back — the archive path marks them; this is the same fact reversed.
        from .participant_scores import mark_participant_scores_stale
        mark_participant_scores_stale(db)

    report.skipped = len(report.problems)
    report.problems.sort(key=lambda p: p.line)
    return report


def _existing_applications(
    db: Session,
    wanted: Iterable[tuple[int, int, int | None, int | None]],
) -> set[tuple[int, int, int | None, int | None]]:
    """Which wanted `(coder, code, segment, value)` rows already exist.

    ⚠️ Queried by (coder, code) PAIR rather than by target id, because the target
    list is the whole import while the pair list is the CODEBOOK — a handful of
    codes across a handful of coders, whatever the file's size.
    """
    out: set[tuple[int, int, int | None, int | None]] = set()
    pairs: dict[tuple[int, int], tuple[list[int], list[int]]] = defaultdict(
        lambda: ([], [])
    )
    for user_id, code_id, segment_id, value_id in wanted:
        if segment_id is not None:
            pairs[(user_id, code_id)][0].append(segment_id)
        else:
            pairs[(user_id, code_id)][1].append(value_id)

    for (user_id, code_id), (segment_ids, value_ids) in pairs.items():
        if segment_ids:
            for (sid,) in db.query(CodeApplication.segment_id).filter(
                CodeApplication.user_id == user_id,
                CodeApplication.code_id == code_id,
                in_id_set(CodeApplication.segment_id, segment_ids),
            ).all():
                out.add((user_id, code_id, sid, None))
        if value_ids:
            for (vid,) in db.query(CodeApplication.dataset_value_id).filter(
                CodeApplication.user_id == user_id,
                CodeApplication.code_id == code_id,
                in_id_set(CodeApplication.dataset_value_id, value_ids),
            ).all():
                out.add((user_id, code_id, None, vid))
    return out


def machine_written_targets(
    db: Session,
    applications: list[PlannedApplication],
    resolved_user: dict[str, int],
) -> tuple[list[int], list[int]]:
    """The targets a NON-MACHINE coder was written to — and nothing else.

    🔴 **A machine's applications move neither consensus nor a participant
    score**, because `consensus.gather_target_votes` and
    `materialize_consensus_for_project` both filter `reliability_coder_clause()`.
    Marking them stale would enqueue one recompute marker per target for a
    recompute that provably changes nothing — up to one per row at the cap —
    drained by the background sweep one target at a time. ⚠️ **The 368,717 figure
    this argument invites belongs to `merge_codes` on BES, a DIFFERENT operation;
    the bound HERE is the row cap.**

    ⚠️ **The kind is read from the DATABASE, not from the file's description of
    it.** A coder whose kind this build does not recognise therefore counts as a
    PERSON — over-marking is the safe direction, and it is the same subtraction
    `useCoders` makes on the client for the same reason.
    """
    user_ids = sorted({uid for uid in resolved_user.values()})
    machine_ids = {
        uid for (uid,) in db.query(User.id).filter(
            User.id.in_(user_ids or [0]),
            User.coder_type == CODER_TYPE_MACHINE,
        ).all()
    }
    segment_ids: set[int] = set()
    value_ids: set[int] = set()
    for app in applications:
        user_id = resolved_user.get(app.coder)
        if user_id is None or user_id in machine_ids:
            continue
        if app.segment_id is not None:
            segment_ids.update(app.segment_targets)
        elif app.dataset_value_id is not None:
            value_ids.add(app.dataset_value_id)
    return sorted(segment_ids), sorted(value_ids)


def _mark_staleness(
    db: Session,
    project_id: int,
    applications: list[PlannedApplication],
    resolved_user: dict[str, int],
) -> None:
    """Rule (4) for this write path — and it lives in the SERVICE.

    Every code-application mutation site marks consensus stale
    (the internal design notes, headline rule 4). Putting it at the router
    would leave a second caller — a script, a future endpoint — free to forget,
    and this is the one write path that can create a hundred thousand
    applications in a request.

    ⚠️ `mark_participant_scores_stale` runs ABOVE the `consensus_enabled` gate,
    the rule `routers/coding.py:65` records: consensus is meaningless with one
    voter and a rating-derived score is not.
    """
    from .consensus import consensus_enabled
    from .consensus_staleness import mark_consensus_stale
    from .participant_scores import mark_participant_scores_stale

    segment_ids, value_ids = machine_written_targets(db, applications, resolved_user)
    if not segment_ids and not value_ids:
        return
    mark_participant_scores_stale(db, project_id)
    if consensus_enabled(db):
        mark_consensus_stale(
            db, project_id,
            segment_ids=segment_ids or None,
            dataset_value_ids=value_ids or None,
        )
