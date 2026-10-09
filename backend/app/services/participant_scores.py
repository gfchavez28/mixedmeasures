"""Rating scores as ordinary dataset variables (row 45 (i) step 4).

Step 2 turned a participant's ratings into one number per person per rated code.
Step 3 built the table whose rows ARE the project's participants. This writes the
first into the second, at which point the analysis pickers, comparisons, charts,
the crosswalk and the R export light up **with no consumer change at all** —
which was the whole argument for Option C over a virtual column.

## Two columns per rated code, and the second one is the point

`{code} (score)` carries the mean; `{code} (rated passages)` carries its *n*.

🔴 **#693's rule: the *n* is the dangerous half.** A `DatasetValue` holds one
number, so a score column alone reduces `mean 3.643 over 7 passages` and
`mean 3.643 over 1 passage` to the same cell — and the rollup computes the
distinction precisely so it cannot be lost. As a second VARIABLE it stays
analysable: filter to participants with >= 3 rated passages, chart the coverage,
export both to R. As prose in a column description it would not be.

## The column set is the codes that DECLARE A SCALE, never the codes that scored

A declared scale is the researcher saying *"this is a measurement"*, so it is the
honest population — and it is STABLE. Deriving the set from who happens to have a
score would make columns appear and vanish as coding proceeds, so a saved chart or
an export could lose a variable it referenced between two readings.

A code whose scale is CLEARED keeps its columns and goes NULL: clearing is
recoverable (`magnitude-coding.md` §5 — the ratings survive, uninterpretable until
a scale returns), and destroying the variable would not be. A code that is
DELETED has its columns reaped, for the reason `sync_rows` reaps orphaned rows:
`source="managed"` makes them read-only through the three `source != "manual"`
gates, so a column nothing can recompute would otherwise be permanently
undeletable — step 3's own lesson, reached from the column side.

## NULL is not zero, here too

A participant with no usable rating gets **no cell**, not a zero — matching the
importer, which stores no row for a blank. `participants_coded_unrated` (coded but
never rated) and "not coded at all" both land as an empty cell; the DIFFERENCE
rides the refresh report, which is where a researcher can act on it.

## Freshness is a PAIR and only one half can be trusted

`Dataset.managed_synced_at` is the truth and is always displayed.
`Dataset.managed_stale` is a positive signal only — see the model comment and the
migration for the eight input classes that move a score, of which a rating write
is one. **Nothing here ever claims a score is up to date.**
"""
from __future__ import annotations

import json
import logging
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterator

from sqlalchemy import bindparam, delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from . import magnitude
from .column_cleanup import delete_column_references
from .magnitude_rollup import (
    MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
    MagnitudeRollup,
    compute_magnitude_rollup,
)
from .participant_dataset import (
    MANAGED_COLUMN_SOURCE,
    MANAGED_KIND_PARTICIPANTS,
    get_participant_dataset,
    sync_rows,
)
from .staleness import mark_metrics_stale

logger = logging.getLogger(__name__)

#: `managed_spec.kind` for the column carrying the participant score itself.
MANAGED_SPEC_KIND_SCORE = "magnitude_score"

#: ...and for the column carrying that score's *n*. Two kinds rather than a
#: boolean: a third derived column (a spread, a flagged-target count) is a new
#: value here, not a second flag to combine.
MANAGED_SPEC_KIND_RATED_TARGETS = "magnitude_rated_targets"

MANAGED_SPEC_KINDS = frozenset({
    MANAGED_SPEC_KIND_SCORE,
    MANAGED_SPEC_KIND_RATED_TARGETS,
})

#: Suffixes appended to the code's name. They are part of the column HEADING a
#: researcher reads in a picker, so they say what the number is rather than how
#: it was made — the basis is a separate, stated field.
_SUFFIX = {
    MANAGED_SPEC_KIND_SCORE: "(score)",
    MANAGED_SPEC_KIND_RATED_TARGETS: "(rated passages)",
}

#: Decimal places for a score cell. `value_text` and `value_numeric` are written
#: from the SAME rounded number — a text/numeric pair that disagree is how an
#: export and a chart come to show different values for one cell.
_SCORE_DP = 3

#: #1073 (a) — how many cell statements one write transaction carries. The cells
#: are written in batches, each COMMITTED, so another writer waits at most one
#: batch for SQLite's lock (5 s busy timeout) rather than the whole write.
#: MEASURED on 122,382 participants × 4 rated codes (979,056 cells): the refresh
#: that wrote them in ONE transaction held the lock 8.90 s and a competing
#: writer failed at 5.06 s. At ~120,000 inserts a second, a batch is ~0.2 s.
CELL_WRITE_BATCH = 25_000


# ── One create or refresh at a time, per project (#1073 c) ───────────────────

#: The sentence a second, concurrent refresh answers with (409).
PARTICIPANT_TABLE_BUSY_MESSAGE = (
    "The participant table is already being updated, so a second update was not "
    "started. Its scores will be current when that one finishes."
)


class ParticipantTableBusy(RuntimeError):
    """Another create or refresh of this project's participant table is running."""


_turns = threading.Condition()
#: project id → (the thread holding its turn, how many times it has entered).
_turn_holders: dict[int, tuple[int, int]] = {}


@contextmanager
def participant_table_turn(project_id: int) -> Iterator[None]:
    """Hold this project's participant-table turn for a block, or raise
    `ParticipantTableBusy` without waiting.

    🔴 **Why it exists (#1073 c, CONFIRMED by execution):** two refreshes whose
    reads interleave both INSERT the same rows, and one dies on
    `uq_dataset_rows_dataset_participant` — then marks the table stale straight
    after the other one succeeded. Two creates die on
    `uq_datasets_project_managed_kind` (a 500) despite the endpoint's idempotent
    promise. Both became reachable when #1022 made the endpoints `def`: the event
    loop had serialised them. The Data view's per-column *Refresh scores* item is
    not disabled while a refresh runs, so one researcher can start two.

    ⚠️ **Re-entrant for the thread that holds it** — the create endpoint takes the
    turn for creation AND the refresh inside it, and the refresh takes it too,
    because 56 direct test calls and any future caller must not be able to
    refresh without it. A module global, for `restore_gate.db_gate`'s reason: the
    thing it guards (this process's engine) is one too. It cannot see another
    PROCESS; the unique indexes stay the backstop there.
    """
    me = threading.get_ident()
    with _turns:
        held = _turn_holders.get(project_id)
        if held is not None and held[0] != me:
            raise ParticipantTableBusy(PARTICIPANT_TABLE_BUSY_MESSAGE)
        _turn_holders[project_id] = (me, (held[1] if held else 0) + 1)
    try:
        yield
    finally:
        with _turns:
            ident, depth = _turn_holders[project_id]
            if depth <= 1:
                del _turn_holders[project_id]
            else:
                _turn_holders[project_id] = (ident, depth - 1)
            _turns.notify_all()


def wait_for_participant_table_turn(project_id: int, timeout: float) -> bool:
    """Wait (up to `timeout` s) until nobody holds this project's turn. For the
    create endpoint's double press: the second press waits for the first to finish
    rather than failing, then returns the table the first one built."""
    with _turns:
        return _turns.wait_for(lambda: project_id not in _turn_holders, timeout)


def build_managed_spec(kind: str, code_id: int, basis: str | None = None) -> str:
    """Serialise a managed column's provenance. Fails closed on an unknown kind."""
    if kind not in MANAGED_SPEC_KINDS:
        raise ValueError(
            f"unknown managed column kind {kind!r}; expected one of "
            f"{sorted(MANAGED_SPEC_KINDS)}"
        )
    spec: dict = {"kind": kind, "code_id": code_id}
    if basis is not None:
        spec["basis"] = basis
    return json.dumps(spec)


def parse_managed_spec(raw: str | None) -> dict | None:
    """Read a managed column's provenance, or None if it has none.

    Tolerant on the way OUT and strict on the way IN: a malformed or
    unrecognised spec reads as "not a managed column" rather than raising, so a
    hand-edited database or a file from a future build degrades to an ordinary
    (if read-only) column instead of 500ing every dataset request.
    """
    if not raw:
        return None
    try:
        spec = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(spec, dict) or spec.get("kind") not in MANAGED_SPEC_KINDS:
        return None
    if not isinstance(spec.get("code_id"), int):
        return None
    return spec


@dataclass(frozen=True)
class RefreshReport:
    """What one refresh changed, and what it could not score.

    The exclusion counts are the rollup's own disclosure carried to the surface —
    Decision 4's obligation is that the rollup SAYS what it left out, and a
    report nobody sees discharges nothing.
    """

    rows_added: int = 0
    rows_removed: int = 0
    columns_added: int = 0
    columns_removed: int = 0
    #: Saved metrics (charts, tests) deleted with a reaped score column (#923).
    #: Reported because it is the one thing the reap destroys that the researcher
    #: authored deliberately and will go looking for again.
    metrics_removed: int = 0
    cells_written: int = 0
    cells_cleared: int = 0
    participants_scored: int = 0
    #: Coded, could still be rated — a different fact from "not coded".
    participants_coded_unrated: int = 0
    #: `{reason: coder judgements not used}`, rating-grained (see the rollup).
    excluded_ratings: dict[str, int] = field(default_factory=dict)
    synced_at: datetime | None = None


def mark_participant_scores_stale(db: Session, project_id: int | None = None) -> bool:
    """Record that something a score depends on has changed. Returns whether a
    managed dataset existed to mark.

    ⚠️ ``project_id=None`` marks EVERY project, and it has exactly one caller:
    archiving a coder. A `User` is instance-global, not a project entity, and
    `gather_target_votes` filters `User.archived == False` — so archiving
    someone in Settings removes their votes from every score in every project on
    the install. It is the input class furthest from anything that looks like
    coding, which is why it is named here rather than left to the timestamp.

    🔴 **UNGATED, and that is the whole reason it is not
    `_mark_segment_consensus_stale`.** That helper returns early when
    `consensus_enabled(db)` is false — correct for CONSENSUS, which is
    meaningless with one voter, and wrong for anything derived from RATINGS,
    which is not. A single-coder project is the default install, and its scores
    are computed from the sole coder's judgement (the rollup's sole-voter arm);
    reusing the gated trigger would leave exactly those projects with a score
    that is never marked out of date.

    ⚠️ It is a positive signal only. See `Dataset.managed_stale`: no caller,
    here or anywhere, may read its absence as "up to date".

    One UPDATE against a partial-unique-indexed pair; cheap enough to call from
    a hot coding path. Flushes nothing — the caller owns the transaction.
    """
    query = db.query(Dataset).filter(Dataset.managed_kind.isnot(None))
    if project_id is not None:
        query = query.filter(Dataset.project_id == project_id)
    updated = query.update({"managed_stale": True}, synchronize_session="fetch")
    return bool(updated)


def _scaled_codes(db: Session, project_id: int) -> list[Code]:
    """The project's codes that DECLARE a rating scale, in a stable order.

    `magnitude.has_scale` is the shared predicate — the three questions about a
    scale are answered in that one module (#589), and a local
    `magnitude_min is not None` here would be a fourth implementation of one of
    them.
    """
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id)
        .order_by(Code.id)
        .all()
    )
    return [c for c in codes if magnitude.has_scale(c)]


def _column_heading(code_name: str, kind: str) -> str:
    return f"{code_name} {_SUFFIX[kind]}".strip()


def sync_score_columns(db: Session, dataset: Dataset) -> tuple[int, int, int]:
    """Reconcile the score columns against the project's scaled codes.

    Returns ``(added, removed, metrics_removed)``. Reconciles two sets rather
    than listening for scale declarations, for the reason `sync_rows` does: the
    trigger sites are a population nobody enumerates correctly, and a reconcile
    is immune to a new one appearing.

    ⚠️ A column is REAPED only when its code is GONE. A code whose scale was
    merely cleared keeps its columns and scores NULL — clearing is recoverable
    and deleting the variable is not.

    🔴 **The third return value exists because the reap can destroy a saved
    chart (#923).** A score column is an ordinary `DatasetColumn`, which is the
    whole argument for Option C — so the analysis view will build a
    `MetricDefinition` on it, and a metric's `input_source_id` is polymorphic
    with no ForeignKey. Reaping the column without the cleanup left that metric
    pointing at an id that no longer existed and `compute_metric` raised. The
    count is reported rather than swallowed because the thing removed is
    something the researcher set up and will look for again.
    """
    if dataset.managed_kind != MANAGED_KIND_PARTICIPANTS:
        raise ValueError(
            f"sync_score_columns expects the participants dataset, got "
            f"managed_kind={dataset.managed_kind!r}"
        )

    codes = {c.id: c for c in _scaled_codes(db, dataset.project_id)}
    live_code_ids = {
        r[0] for r in db.query(Code.id).filter(Code.project_id == dataset.project_id)
    }

    columns = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset.id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )
    existing: dict[tuple[str, int], DatasetColumn] = {}
    removed = 0
    metrics_removed = 0
    for column in columns:
        spec = parse_managed_spec(column.managed_spec)
        if spec is None:
            continue
        if spec["code_id"] not in live_code_ids:
            # The code is gone. Nothing can ever recompute this column, and
            # `source="managed"` makes it read-only through the three
            # `source != "manual"` gates — so leaving it would be an orphan the
            # refusals make permanently undeletable, exactly the shape
            # `sync_rows`' reap exists to prevent.
            #
            # 🔴 `validate_domains=False`, and the reason is the whole argument
            # for that parameter having no default (#923). The blocking arm
            # raises 409 and rolls back; here the column is going away as a
            # CONSEQUENCE of a code deleted elsewhere, discovered at the next
            # refresh — so a raise would abort the whole refresh, leaving every
            # other score stale, over a domain the researcher did not touch in
            # this action. `metrics.py::_assert_domain_members_paired` is the
            # documented second layer and fires at compute time instead.
            metrics_removed += delete_column_references(
                db, dataset.project_id, column.id, validate_domains=False,
            )
            db.delete(column)
            removed += 1
            continue
        existing[(spec["kind"], spec["code_id"])] = column
    if removed:
        db.flush()

    next_order = max((c.sequence_order for c in columns), default=-1) + 1
    added = 0
    for code_id in sorted(codes):
        code = codes[code_id]
        scale = magnitude.read_scale(code)
        for kind in (MANAGED_SPEC_KIND_SCORE, MANAGED_SPEC_KIND_RATED_TARGETS):
            column = existing.get((kind, code_id))
            heading = _column_heading(code.name, kind)
            if column is None:
                column = DatasetColumn(
                    dataset_id=dataset.id,
                    column_text=heading,
                    column_type=ColumnType.NUMERIC,
                    sequence_order=next_order,
                    display_order=next_order,
                    source=MANAGED_COLUMN_SOURCE,
                    # The basis rides the SCORE column only — the *n* is a
                    # count, not an aggregate, so it has no basis to state and
                    # inventing one for symmetry would make the vocabulary
                    # describe two different kinds of claim.
                    managed_spec=build_managed_spec(
                        kind, code_id,
                        basis=(
                            MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
                            if kind == MANAGED_SPEC_KIND_SCORE else None
                        ),
                    ),
                )
                db.add(column)
                next_order += 1
                added += 1
            if kind == MANAGED_SPEC_KIND_SCORE and scale is not None:
                # Seed the axis from the DECLARED instrument, not the observed
                # range: a chart of scores on a -2..+2 scale should show the
                # scale, so a corpus whose values happen to span 1..2 is not
                # drawn as though that were the whole instrument.
                column.numeric_min = scale["min"]
                column.numeric_max = scale["max"]
            elif kind == MANAGED_SPEC_KIND_RATED_TARGETS:
                column.numeric_min = 0
                column.numeric_max = None
    if added:
        db.flush()
    return added, removed, metrics_removed


@dataclass
class _CellPlan:
    """Every score-cell change one refresh will make, decided before any is made."""

    inserts: list[dict] = field(default_factory=list)
    updates: list[dict] = field(default_factory=list)
    deletes: list[dict] = field(default_factory=list)
    #: #1144 — the columns any of the three touches, so a metric built on one of
    #: them can be marked out of date. Bounded by the scaled codes (two each).
    columns: set[int] = field(default_factory=set)


def _plan_cells(db: Session, dataset_id: int, rollup: MagnitudeRollup) -> _CellPlan:
    """Decide every score cell's change. READS ONLY — no write lock is taken here.

    Reconciles, like everything else here: a participant who no longer has a
    score has their cell DELETED rather than zeroed, because the importer stores
    no row for a blank cell and a zero would be a rating nobody gave.

    🔴 **Tuples in (#1033), and read BEFORE the first write (#1073 a).** This
    reads every managed cell — 979,056 at 122,382 participants × 4 rated codes —
    and it used to run after `sync_rows` / `sync_score_columns` had written, i.e.
    INSIDE the write transaction: the audit measured the lock held 9.30 s for a
    refresh after a create, and 4.31 s (4.69 s in the audit's run) to add ONE
    participant whose scores had not changed, with a coding saved meanwhile
    failing at the 5 s busy timeout. The refresh now commits its row and column
    sync first, so this read holds nothing.
    """
    columns = [
        (parse_managed_spec(spec), column_id)
        for column_id, spec in db.execute(
            select(DatasetColumn.id, DatasetColumn.managed_spec)
            .where(DatasetColumn.dataset_id == dataset_id)
        )
    ]
    managed = [(spec, column_id) for spec, column_id in columns if spec is not None]
    plan = _CellPlan()
    if not managed:
        return plan

    rows_t = DatasetRow.__table__
    values_t = DatasetValue.__table__

    rows = dict(db.execute(
        select(rows_t.c.participant_id, rows_t.c.id).where(
            rows_t.c.dataset_id == dataset_id,
            rows_t.c.participant_id.isnot(None),
        )
    ).all())
    by_key = {(s.participant_id, s.code_id): s for s in rollup.scores}

    # Bounded by the SCALED CODES (two columns each), never by the participants.
    column_ids = [column_id for _spec, column_id in managed]
    cells = {
        (row_id, column_id): (value_id, text, number)
        for value_id, row_id, column_id, text, number in db.execute(
            select(
                values_t.c.id, values_t.c.row_id, values_t.c.column_id,
                values_t.c.value_text, values_t.c.value_numeric,
            ).where(values_t.c.column_id.in_(column_ids))
        )
    }

    for spec, column_id in managed:
        for participant_id, row_id in rows.items():
            score = by_key.get((participant_id, spec["code_id"]))
            value: float | None = None
            if score is not None:
                if spec["kind"] == MANAGED_SPEC_KIND_SCORE:
                    value = round(score.mean, _SCORE_DP)
                else:
                    value = float(score.n_targets)

            cell = cells.get((row_id, column_id))
            if value is None:
                # NULL is not zero (#35 §2). No cell at all, matching the
                # importer's own treatment of a blank.
                if cell is not None:
                    plan.deletes.append({"b_id": cell[0]})
                    plan.columns.add(column_id)
                continue

            # #942 — a SCORE is a measurement and gets a fixed number of decimal
            # places; an *n* is a count and gets none. One formatter with the
            # decision passed in, rather than two formatters that can drift.
            text = _format_number(
                value,
                decimals=(
                    _SCORE_DP if spec["kind"] == MANAGED_SPEC_KIND_SCORE else 0
                ),
            )
            if cell is None:
                plan.inserts.append({
                    "row_id": row_id, "column_id": column_id,
                    "value_text": text, "value_numeric": value,
                })
                plan.columns.add(column_id)
            elif cell[1] != text or cell[2] != value:
                plan.updates.append({"b_id": cell[0], "b_text": text, "b_number": value})
                plan.columns.add(column_id)
    return plan


def _write_cell_plan(db: Session, plan: _CellPlan) -> tuple[int, int]:
    """Write a `_CellPlan` in batches of `CELL_WRITE_BATCH`, COMMITTING each.
    Returns ``(written, cleared)``.

    🔴 **Batched and committed (#1073 a):** the write itself is the long part of a
    first scoring — 979,056 inserts — and one transaction for it held SQLite's
    lock ~8.9 s. A batch holds it ~0.2 s, so a coding saved during a refresh waits
    a moment instead of failing. ⚠️ Between batches a reader can see a table
    partly updated; `managed_synced_at` still names the previous refresh until the
    last batch lands (the caller stamps it), and a failure part-way re-marks the
    table stale (the refresh's `except`), so neither claims more than is true.

    A cleared cell's notes and codings go with it by `ON DELETE CASCADE` — the
    database's rule, which the ORM's `delete-orphan` cascade mirrored.
    """
    values_t = DatasetValue.__table__
    statements = (
        (delete(values_t).where(values_t.c.id == bindparam("b_id")), plan.deletes),
        (
            update(values_t)
            .where(values_t.c.id == bindparam("b_id"))
            .values(value_text=bindparam("b_text"), value_numeric=bindparam("b_number")),
            plan.updates,
        ),
        (insert(values_t), plan.inserts),
    )
    for statement, params in statements:
        for start in range(0, len(params), CELL_WRITE_BATCH):
            db.execute(statement, params[start:start + CELL_WRITE_BATCH])
            db.commit()
    return len(plan.inserts) + len(plan.updates), len(plan.deletes)


def _format_number(value: float, *, decimals: int) -> str:
    """Render a cell's number at a FIXED number of decimal places.

    Mirrors `magnitude._fmt`'s posture for a DATA cell: a plain hyphen for a
    negative, never the U+2212 the chips use — this string is read by the CSV
    export, the Excel export and `_compute_value_numeric` on any re-import.

    🔴 **Fixed, not shortest (#942).** It used to strip trailing zeros, so one
    column read `3.643 / 1.25 / 4.167 / 2 / 3.75`: every cell a different width,
    the decimal points unaligned, and a mean of exactly 2 looking like a
    different KIND of number from its neighbours. A summary score is a column to
    be scanned down.

    ⚠️ **The stored value is NOT rounded harder to achieve this**, which is what
    the entry warned against: `value_numeric` keeps its `_SCORE_DP` rounding and
    the text is the same number padded, so the two still agree
    (`"2.000"` parses to `2.0`). Alignment was never a precision question.

    `decimals=0` is the *n*'s case: a count of 7 is `7`, never `7.0`.
    """
    if decimals <= 0:
        return str(int(round(value)))
    return f"{value:.{decimals}f}"


def refresh_participant_dataset(db: Session, project_id: int) -> RefreshReport | None:
    """Bring the participant dataset's rows AND scores up to date.

    Returns None when the project has no participant dataset.

    🔴 **ONE call recomputes EVERY score column, and the endpoint is on the
    DATASET rather than the column, deliberately departing from the
    computed-column precedent (`POST …/columns/{id}/recompute`).** The rollup is
    a single project-wide scan that produces every participant's every score at
    once, so a per-column verb would run that whole scan once per rated code for
    numbers it already had.

    ⚠️ **Never called from a GET** (DEC-C, and `GET …/data` is the endpoint
    paginated for scale): this writes. The row set and the scores are a snapshot
    refreshed deliberately, which is the decision the stale marker exists to
    make visible.

    🔴 **READ, THEN WRITE — AND IT COMMITS (#1033).** SQLite has one writer, and
    a transaction that has written holds the lock until it ends; every other
    writer gives up after the 5 s busy timeout. This used to write first (a new
    row, or — on EVERY refresh of a table with a variable the researcher added —
    `materialise_manual_cells`' `INSERT … SELECT`, which takes the lock even
    when it inserts nothing) and then run the rollup inside that transaction.
    MEASURED on 122,382 participants: a coding click 6–31 s into a 40 s refresh
    failed with "database is locked", and every click during a first create
    (172 s) did. The steps now:

      1. **CLAIM** — clear `managed_stale` and COMMIT. That also ends any write
         transaction the CALLER holds (the create endpoint's new table), which
         is what keeps the lock out of step 2 whoever calls this.
      2. **READ** — the rollup, the 16–25 s part, with no write transaction
         open. Other writers commit freely meanwhile.
      3. **STRUCTURE** — the row sync and the column reconcile, each set-based,
         then COMMITTED (#1073 a): until then the cells were read inside this
         transaction, so adding one participant held the lock ~4.3 s.
      4. **CELLS** — planned with no lock held (`_plan_cells`), then written in
         short committed batches (`_write_cell_plan`); then `managed_synced_at`,
         flushed for the caller to commit. MEASURED on 122,382 participants × 4
         rated codes before this: 8.90 s held for a first scoring, a competing
         writer failing at 5.06 s.
      5. **METRICS** (#1144) — every saved metric on a column this refresh moved is
         marked out of date, in the same final transaction
         (`_mark_moved_metrics_stale`).

    🔴 **One refresh at a time (#1073 c).** It runs inside
    `participant_table_turn`, so a second one — another tab, the per-column menu
    pressed during a refresh — is refused with `ParticipantTableBusy` (409)
    before it touches anything, instead of dying on a unique index and marking a
    freshly refreshed table stale.

    ⚠️ **The claim is what keeps a coding made DURING step 2 visible.** A
    rating written while the rollup reads may or may not be in it, and it calls
    `mark_participant_scores_stale` — which lands AFTER the claim, so the flag
    it sets survives this refresh. Clearing the flag at the end instead would
    erase it and report scores as up to date that are not. That is the same
    positive-signal-only posture the module docstring gives the flag, and
    `managed_synced_at` is the time the READ began for the same reason.

    ⚠️ **A failure after the claim marks the table stale again** (best effort,
    logged if even that fails): the flag was cleared and the scores never
    written. `managed_synced_at` is untouched on failure, so the displayed time
    stays honest either way.
    """
    with participant_table_turn(project_id):
        return _refresh_in_turn(db, project_id)


def _mark_moved_metrics_stale(
    db: Session,
    project_id: int,
    dataset_id: int,
    row_report,
    plan: _CellPlan | None,
) -> int:
    """#1144 — mark out of date every saved metric whose INPUT this refresh moved.

    🔴 **A refresh rewrote a score column's cells and marked nothing**, and quick
    compute recomputes only a metric that is `stale` or has no result — so the
    analysis view kept showing the number from before the refresh, silently, until
    *Recompute all* (measured: 2.0 shown, 1.0 true). Batch 16's "was the metric
    stale?" gate on saved tests (#1039 a) relies on this flag being complete.

    What moved, and the second half is the one easy to miss:
      - a score column with any planned insert, update or delete;
      - EVERY column of the table when `sync_rows` added or reaped a ROW — a row is
        a member of every column's population, and a reaped row takes the cells
        the researcher typed into their own variables with it.
    A refresh that moved nothing marks NOTHING: an amber marker on a number that
    cannot have changed trains a researcher to ignore it (#1149's lesson).

    Bounded by the table's columns, never by its rows (`sql-id-sets.md`).
    """
    column_ids: set[int] = set(plan.columns) if plan is not None else set()
    if row_report is not None and (row_report.added or row_report.removed):
        column_ids.update(
            column_id for (column_id,) in db.execute(
                select(DatasetColumn.id).where(DatasetColumn.dataset_id == dataset_id)
            )
        )
    if not column_ids:
        return 0
    return mark_metrics_stale(db, project_id, column_ids=sorted(column_ids))


def _refresh_in_turn(db: Session, project_id: int) -> RefreshReport | None:
    """`refresh_participant_dataset`'s body, with the project's turn held."""
    dataset = get_participant_dataset(db, project_id)
    if dataset is None:
        return None
    dataset_id = dataset.id

    # (1) CLAIM.
    db.query(Dataset).filter(Dataset.id == dataset_id).update(
        {"managed_stale": False}, synchronize_session="fetch",
    )
    db.commit()
    synced_at = datetime.now(timezone.utc).replace(tzinfo=None)

    row_report = None
    plan: _CellPlan | None = None
    try:
        # (2) READ — nothing may write before this returns.
        rollup = compute_magnitude_rollup(db, project_id)

        # (3) STRUCTURE — rows and columns, committed on their own so the cell
        # read below holds no lock (#1073 a).
        dataset = db.get(Dataset, dataset_id)
        row_report = sync_rows(db, dataset)
        columns_added, columns_removed, metrics_removed = sync_score_columns(db, dataset)
        db.commit()

        # (4) CELLS — planned with no lock held, written in committed batches.
        plan = _plan_cells(db, dataset_id, rollup)
        written, cleared = _write_cell_plan(db, plan)
        dataset = db.get(Dataset, dataset_id)
        dataset.managed_synced_at = synced_at

        # (5) #1144 — the metrics built on what moved. AFTER the cells, in the
        # transaction that stamps `managed_synced_at`: marked before them, a quick
        # compute between two committed batches would recompute on half-written
        # numbers and clear the flag (#1145 (c)'s shape).
        _mark_moved_metrics_stale(db, project_id, dataset_id, row_report, plan)
        db.flush()
    except IntegrityError:
        # Another PROCESS updating the same table (this one's turn keeps a second
        # refresh out of this process): its refresh is the one that lands, so
        # this is "busy", and re-marking the table stale would mark ITS fresh
        # scores out of date — #1073 (c)'s second half.
        db.rollback()
        raise ParticipantTableBusy(PARTICIPANT_TABLE_BUSY_MESSAGE) from None
    except Exception:
        db.rollback()
        try:
            mark_participant_scores_stale(db, project_id)
            # Batches committed before the failure have already moved cells (#1144).
            _mark_moved_metrics_stale(db, project_id, dataset_id, row_report, plan)
            db.commit()
        except Exception:
            db.rollback()
            logger.warning(
                "participant table %s: the refresh failed and the stale marker "
                "could not be restored", dataset_id, exc_info=True,
            )
        raise

    return RefreshReport(
        rows_added=row_report.added,
        rows_removed=row_report.removed,
        columns_added=columns_added,
        columns_removed=columns_removed,
        metrics_removed=metrics_removed,
        cells_written=written,
        cells_cleared=cleared,
        participants_scored=len({s.participant_id for s in rollup.scores}),
        participants_coded_unrated=len(rollup.participants_coded_unrated),
        excluded_ratings=dict(rollup.excluded_ratings),
        synced_at=synced_at,
    )
