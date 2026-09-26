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

## A refused row never half-applies

The whole file is planned, then applied. A row that cannot be resolved carries a
NAMED reason and its own sentence (§`Reason`), and the response is an ordinary
200 with the failures listed — #678's rule: a partial failure is a body, not a
throw, and the failed set is stated explicitly rather than derived from what
succeeded.

## Set membership is derived from the CODE

If the resolved code belongs to a `CodeSet`, the row is a SELECTION (exclusive,
through `code_sets.apply_selection`) rather than a plain apply. The file cannot
then contradict the database about what kind of write this is, and the researcher
has one less column to get wrong. An optional `code_set` column is checked as an
ASSERTION — a file built against a different codebook fails loudly instead of
quietly applying the wrong kind of write.

## What it does NOT do

- **It never marks staleness for a machine's rows.** `gather_target_votes` and
  the consensus materializer both filter `reliability_coder_clause()`, so a
  machine-attributed application cannot move consensus or a participant score.
  Marking anyway would enqueue one recompute marker per target for a recompute
  that provably changes nothing — up to 200,000 of them — one per row at the cap — for recomputes that provably change nothing (the bound is the row cap, not the
  368,717 figure that belongs to `merge_codes` on BES).
- **It never sets `origin='ai'`.** `origin` says how a ROW was produced and is
  reserved for a human accepting a model's suggestion (a future assist mode);
  the LAYER keys on the CODER. Writing it here would be a field no consumer reads
  (#941) and would make the two markers look interchangeable, which
  `coding_layers.py` is explicit that they are not.
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from sqlalchemy import func, insert
from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.code_set import CodeSet
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.segment import Segment
from ..models.text_coding_config import TextCodingConfig, is_empty_text, parse_treat_as_empty
from ..models.user import User
from ..auth import CODER_TYPE_HUMAN, CODER_TYPE_MACHINE, SYSTEM_CODER_TYPES, unique_username
from . import code_sets as code_set_rules
from . import machine_coder
from . import magnitude as magnitude_rules
from .coding_layers import build_effective_code_map, project_scoped_segments
from .id_set import in_id_set
from .identifier_match import group_unique_by_key, normalize_key
from .segment_groups import group_target_ids

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

#: Bounded because an import is exactly the shape `sql-id-sets.md` warns about,
#: and because every row becomes a row in `code_applications`. 200,000 covers the
#: demand case with room (a machine labelling all 75,699 posts of the GSS-scale
#: corpus on two variables) and is 4.7 MB of CSV, well under `MAX_UPLOAD_SIZE`.
#:
#: 🔴 **IT IS ALSO A FREEZE BUDGET, AND THAT IS MEASURED (#1000).** The endpoints
#: are `async def` for the multipart read and everything after it takes a `db`
#: Session, which no router in this codebase threadpools — so a full-cap import
#: runs **6.9 s ON the event loop** (parse 0.74 · plan 3.48 · apply 2.72,
#: measured 2026-09-22 against a 200,000-segment corpus). The three phases are
#: each linear in rows, so **raising this raises that number with it.**
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

REASON_UNIT_NOT_FOUND = "unit_not_found"
REASON_UNIT_AMBIGUOUS = "unit_ambiguous"
REASON_UNIT_NOT_CODEABLE = "unit_not_codeable"
REASON_CODE_NOT_FOUND = "code_not_found"
REASON_CODE_AMBIGUOUS = "code_ambiguous"
REASON_CODE_UNIVERSAL = "code_universal"
REASON_CODE_INACTIVE = "code_inactive"
REASON_CODER_MISSING = "coder_missing"
REASON_CODER_SKIPPED = "coder_skipped"
REASON_CODER_UNMAPPED = "coder_unmapped"
REASON_RATING_NOT_A_NUMBER = "rating_not_a_number"
REASON_RATING_OUTSIDE_SCALE = "rating_outside_scale"
REASON_RATING_WITHOUT_SCALE = "rating_without_scale"
REASON_SET_MISMATCH = "set_mismatch"
REASON_SET_CONFLICT_IN_FILE = "set_conflict_in_file"
REASON_DUPLICATE_ROW = "duplicate_row"

IMPORT_REASONS = (
    REASON_UNIT_NOT_FOUND, REASON_UNIT_AMBIGUOUS, REASON_UNIT_NOT_CODEABLE,
    REASON_CODE_NOT_FOUND, REASON_CODE_AMBIGUOUS, REASON_CODE_UNIVERSAL,
    REASON_CODE_INACTIVE, REASON_CODER_MISSING, REASON_CODER_SKIPPED,
    REASON_CODER_UNMAPPED, REASON_RATING_NOT_A_NUMBER,
    REASON_RATING_OUTSIDE_SCALE, REASON_RATING_WITHOUT_SCALE,
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
    """
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise CodingImportError("The file is empty.") from None

    positions: dict[str, int] = {}
    for index, raw in enumerate(header):
        name = _normalize_header(raw)
        # First wins: a duplicated header is a file defect, and silently taking
        # the LAST one is how `preview_dataset_csv` described the second column's
        # values under the first column's name (#973 (b')).
        if name and name not in positions:
            positions[name] = index

    missing = [h for h in REQUIRED_HEADERS if h not in positions]
    if missing:
        raise CodingImportError(
            "The file needs a column for "
            + ", ".join(f"“{h}”" for h in missing)
            + ". The header row should read: "
            + ", ".join(REQUIRED_HEADERS + OPTIONAL_HEADERS)
            + " (the last two are optional)."
        )

    def cell(row: Sequence[str], name: str) -> str:
        index = positions.get(name)
        if index is None or index >= len(row):
            return ""
        return (row[index] or "").strip()

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
    segment_id: int | None
    dataset_value_id: int | None
    #: The set this code belongs to, or None for a plain apply.
    code_set_id: int | None
    magnitude: float | None
    #: For a SET selection on a grouped segment: every visible sibling. Empty
    #: otherwise. Derived once, at plan time, through the SAME helper the
    #: workbench uses (`code-sets.md` §6 — the caller passes the siblings).
    group_segment_ids: tuple[int, ...] = ()


@dataclass(frozen=True)
class CoderCandidate:
    """A coder named in the file, and what this install already has by that name."""

    name: str
    row_count: int
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
    #: Distinct units and codes the file actually resolved to — the two numbers a
    #: researcher checks before committing, because a file that matched three
    #: units of five hundred is a file built against the wrong key.
    units_matched: int = 0
    codes_matched: int = 0

    @property
    def reason_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for problem in self.problems:
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
    group_segment_ids: tuple[int, ...] = ()


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
                    Segment.split_into_id,
                ),
                project_id,
            )
            .filter(Segment.uuid.in_(list(chunk)))
            .all()
        )
        for uuid, seg_id, merged_into, split_into in rows:
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
            )))
    return group_unique_by_key(found)


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
    """
    column = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id == column_id, Dataset.project_id == project_id)
        .first()
    )
    if column is None:
        raise CodingImportError("That text column is not in this project.")

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

    sets_by_id = {
        s.id: s for s in db.query(CodeSet).filter(CodeSet.project_id == project_id).all()
    }
    effective_map = build_effective_code_map(db, project_id)
    set_index = code_set_rules.build_code_set_index(db, project_id, effective_map)

    # Grouped segments: only a SET selection needs the siblings, so the Segment
    # rows are loaded for those units alone rather than for the whole file.
    grouped_cache: dict[int, tuple[int, ...]] = {}

    def _group_ids(segment_id: int) -> tuple[int, ...]:
        if segment_id not in grouped_cache:
            segment = db.get(Segment, segment_id)
            grouped_cache[segment_id] = (
                tuple(group_target_ids(db, segment)) if segment is not None else (segment_id,)
            )
        return grouped_cache[segment_id]

    coder_rows: dict[str, int] = defaultdict(int)
    seen_triples: set[tuple[str, int, int]] = set()
    #: (coder, unit, set) → (line, code_id) — the FIRST claim on a set for a unit.
    set_claims: dict[tuple[str, int, int], tuple[int, int]] = {}
    conflicted_claims: set[tuple[str, int, int]] = set()
    planned: list[PlannedApplication] = []
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
        if code.is_universal:
            problems.append(RowProblem(
                row.line, REASON_CODE_UNIVERSAL,
                f"“{code.name}” is a universal code. Universal codes are excluded "
                "from every coded-count and reliability surface, so importing one "
                "would have no effect on any figure.",
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
        resolved_set = None
        if code.code_set_id is not None:
            resolved_set = set_index.by_id(code.code_set_id)
        if row.code_set:
            declared = (sets_by_id.get(code.code_set_id).label
                        if code.code_set_id in sets_by_id else None)
            if normalize_key(row.code_set) != normalize_key(declared or ""):
                problems.append(RowProblem(
                    row.line, REASON_SET_MISMATCH,
                    f"“{code.name}” belongs to "
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

        unit_key = unit.segment_id if unit.segment_id is not None else unit.dataset_value_id
        triple = (row.coder, unit_key, code.id)
        if triple in seen_triples:
            problems.append(RowProblem(
                row.line, REASON_DUPLICATE_ROW,
                "The same coder, unit and code appear earlier in this file.",
            ))
            continue
        seen_triples.add(triple)

        group_ids: tuple[int, ...] = ()
        if resolved_set is not None:
            claim_key = (row.coder, unit_key, resolved_set.id)
            previous = set_claims.get(claim_key)
            if previous is not None and previous[1] != code.id:
                # 🔴 The `SET_MULTIPLE` rule, reached at the FILE: a contradiction
                # is counted, never resolved by picking one. BOTH claims are
                # refused, including the earlier one already planned.
                conflicted_claims.add(claim_key)
                problems.append(RowProblem(
                    row.line, REASON_SET_CONFLICT_IN_FILE,
                    f"This file gives “{row.coder}” two values of "
                    f"“{resolved_set.label}” for the same unit, so neither is "
                    "applied — a contradiction is not ours to resolve.",
                ))
                continue
            set_claims[claim_key] = (row.line, code.id)
            if unit.segment_id is not None:
                group_ids = _group_ids(unit.segment_id)

        planned.append(PlannedApplication(
            line=row.line,
            coder=row.coder,
            code_id=code.id,
            code_name=code.name,
            segment_id=unit.segment_id,
            dataset_value_id=unit.dataset_value_id,
            code_set_id=resolved_set.id if resolved_set is not None else None,
            magnitude=rating,
            group_segment_ids=group_ids,
        ))

    # The earlier half of every in-file set conflict is withdrawn here. It was
    # already planned when the contradiction arrived, and leaving it in would
    # apply the FIRST value — which is the coin toss this rule exists to refuse.
    if conflicted_claims:
        kept: list[PlannedApplication] = []
        for app in planned:
            key = (app.coder, app.segment_id if app.segment_id is not None
                   else app.dataset_value_id, app.code_set_id)
            if app.code_set_id is not None and key in conflicted_claims:
                line = set_claims[key][0]
                problems.append(RowProblem(
                    line, REASON_SET_CONFLICT_IN_FILE,
                    "A later row in this file gives the same coder a different "
                    "value of this set for this unit, so neither is applied.",
                ))
                continue
            kept.append(app)
        planned = kept

    plan.applications = planned
    plan.problems = sorted(problems, key=lambda p: p.line)
    plan.units_matched = len({
        (a.segment_id, a.dataset_value_id) for a in planned
    })
    plan.codes_matched = len({a.code_id for a in planned})
    plan.coders = _coder_candidates(db, coder_rows)
    return plan


def _coder_candidates(db: Session, coder_rows: dict[str, int]) -> list[CoderCandidate]:
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
            resolved[candidate.name] = target.id
            report.coders_matched += 1
            continue
        if decision.action == "create":
            base = (decision.new_username or candidate.name).strip() or "Coder"
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

    The write is in four passes, and the order matters:

    1. **Coders** — resolved or created first, because every later pass keys on a
       user id.
    2. **Set selections** — grouped by `(set, coder, chosen member)` so one call
       to `code_sets.apply_selection` covers every unit that took that value.
       That reuses the swap rather than re-implementing it (`code-sets.md` §6
       reason 4), and it is why `apply_selection`'s target arms are lists.
    3. **Plain applies** — a Core `executemany`, never N `db.add`s (#958's
       remaining import cost, met here before it is paid).
    4. **Ratings** — ONE pass over both kinds, grouped by
       `(code, coder, value)`. A rating is the same act however the application
       arrived, and re-rating clears `magnitude_conflict` because rating again IS
       the adjudication (#35 §6d).

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

    # ── 2. Set selections ────────────────────────────────────────────────────
    effective_map = build_effective_code_map(db, project_id)
    set_index = code_set_rules.build_code_set_index(db, project_id, effective_map)

    selection_groups: dict[tuple[int, int, int], list[PlannedApplication]] = defaultdict(list)
    plain: list[PlannedApplication] = []
    for app in applications:
        if app.code_set_id is None:
            plain.append(app)
        else:
            selection_groups[
                (app.code_set_id, resolved_user[app.coder], app.code_id)
            ].append(app)

    for (set_id, user_id, code_id), group in selection_groups.items():
        resolved_set = set_index.by_id(set_id)
        if resolved_set is None:
            # The set was deleted between the preview and the import. Not an
            # error worth aborting the whole file for: the codes still exist, so
            # the rows fall back to a plain apply, which is what the project now
            # says they are.
            plain.extend(group)
            continue
        segment_ids: list[int] = []
        value_ids: list[int] = []
        for app in group:
            if app.segment_id is not None:
                segment_ids.extend(app.group_segment_ids or (app.segment_id,))
            else:
                value_ids.append(app.dataset_value_id)
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

    # ── 3. Plain applies ─────────────────────────────────────────────────────
    if plain:
        wanted = {
            (resolved_user[a.coder], a.code_id, a.segment_id, a.dataset_value_id)
            for a in plain
        }
        existing = _existing_applications(db, plain, resolved_user)
        fresh = [w for w in wanted if w not in existing]
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
        segment_ids = [a.segment_id for a in group if a.segment_id is not None]
        value_ids = [a.dataset_value_id for a in group if a.dataset_value_id is not None]
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

    report.skipped = len(report.problems)
    report.problems.sort(key=lambda p: p.line)
    return report


def _existing_applications(
    db: Session,
    applications: list[PlannedApplication],
    resolved_user: dict[str, int],
) -> set[tuple[int, int, int | None, int | None]]:
    """Which planned `(coder, code, target)` rows already exist.

    ⚠️ Queried by (coder, code) PAIR rather than by target id, because the target
    list is the whole import while the pair list is the CODEBOOK — a handful of
    codes across a handful of coders, whatever the file's size.
    """
    out: set[tuple[int, int, int | None, int | None]] = set()
    pairs: dict[tuple[int, int], tuple[list[int], list[int]]] = defaultdict(
        lambda: ([], [])
    )
    for app in applications:
        key = (resolved_user[app.coder], app.code_id)
        if app.segment_id is not None:
            pairs[key][0].append(app.segment_id)
        else:
            pairs[key][1].append(app.dataset_value_id)

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
    recompute that provably changes nothing — up to 200,000 of them — one per row at the cap — for recomputes that provably change nothing, drained by the
    background sweep one target at a time. ⚠️ **The 368,717 figure this argument
    invites belongs to `merge_codes` on BES, a DIFFERENT operation; the bound
    HERE is the row cap.**

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
            segment_ids.update(app.group_segment_ids or (app.segment_id,))
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
