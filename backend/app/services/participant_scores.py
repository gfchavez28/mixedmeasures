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
from dataclasses import dataclass, field
from datetime import datetime, timezone

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


def _write_cells(
    db: Session, dataset: Dataset, rollup: MagnitudeRollup,
) -> tuple[int, int]:
    """Write every score cell. Returns ``(written, cleared)``.

    Reconciles, like everything else here: a participant who no longer has a
    score has their cell DELETED rather than zeroed, because the importer stores
    no row for a blank cell and a zero would be a rating nobody gave.
    """
    columns = [
        (parse_managed_spec(c.managed_spec), c)
        for c in db.query(DatasetColumn).filter(DatasetColumn.dataset_id == dataset.id)
    ]
    managed = [(spec, col) for spec, col in columns if spec is not None]
    if not managed:
        return 0, 0

    rows = {
        r.participant_id: r
        for r in db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id)
        if r.participant_id is not None
    }
    by_key = {(s.participant_id, s.code_id): s for s in rollup.scores}

    column_ids = [col.id for _spec, col in managed]
    cells = {
        (v.row_id, v.column_id): v
        for v in db.query(DatasetValue).filter(DatasetValue.column_id.in_(column_ids))
    }

    written = 0
    cleared = 0
    pending: list[DatasetValue] = []
    for spec, column in managed:
        for participant_id, row in rows.items():
            score = by_key.get((participant_id, spec["code_id"]))
            value: float | None = None
            if score is not None:
                if spec["kind"] == MANAGED_SPEC_KIND_SCORE:
                    value = round(score.mean, _SCORE_DP)
                else:
                    value = float(score.n_targets)

            cell = cells.get((row.id, column.id))
            if value is None:
                # NULL is not zero (#35 §2). No cell at all, matching the
                # importer's own treatment of a blank.
                if cell is not None:
                    db.delete(cell)
                    cleared += 1
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
                pending.append(DatasetValue(
                    row_id=row.id, column_id=column.id,
                    value_text=text, value_numeric=value,
                ))
                written += 1
            elif cell.value_text != text or cell.value_numeric != value:
                cell.value_text = text
                cell.value_numeric = value
                written += 1

    if cleared:
        db.flush()
    if pending:
        db.add_all(pending)
    # ⚠️ LOAD-BEARING under `autoflush=False`, the #439/#440 family reached from
    # the insert side: without it the rows added above are invisible to the next
    # caller's queries, and step 3's own sync hit exactly this by writing a
    # second cell per row.
    db.flush()
    return written, cleared


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

    Returns None when the project has no participant dataset. Flushes; the
    caller owns the transaction.

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
    """
    dataset = get_participant_dataset(db, project_id)
    if dataset is None:
        return None

    row_report = sync_rows(db, dataset)
    columns_added, columns_removed, metrics_removed = sync_score_columns(db, dataset)
    rollup = compute_magnitude_rollup(db, project_id)
    written, cleared = _write_cells(db, dataset, rollup)

    synced_at = datetime.now(timezone.utc).replace(tzinfo=None)
    dataset.managed_synced_at = synced_at
    dataset.managed_stale = False
    db.flush()

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
