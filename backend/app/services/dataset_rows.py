"""Creating a dataset ROW, and the cell every hand-editable column needs on it.

## Why this module exists (#897)

🔴 **A cell that does not exist cannot be created, so a row born without one is
read-only in that column forever.** Three facts that are only a defect together:

  1. `routers/dataset.py::create_manual_column` gives its new column a cell on
     every row **that exists at that moment** — and nothing gives a LATER row one.
  2. `PATCH …/values/{value_id}` is the ONLY endpoint that writes a cell, and it
     is addressed by an existing `DatasetValue.id`. There is no create.
  3. `EditableCell.tsx` returns early when the cell is absent, so the edit is
     discarded with no toast and no error.

**Measured, not reasoned — THREE live instances, only one of which was reported:**

  * `participant_dataset.sync_rows` — a participant who joins AFTER a variable
    was added gets a row and no cell for it (it writes only the identifier cell);
  * `routers/dataset.py::append_import` — it iterates the FILE's column mapping,
    so a manual variable the file knows nothing about gets no cell on any
    appended row. Older and wider than the participant table;
  * `project_portability.import_project` in MERGE mode — rows arrive by
    REFLECTION, and a merge into a project holding a manual variable the
    incoming file lacks inserts rows with no cell for it.

## Why only `source="manual"`

The set is not "every column" — it is exactly the columns `update_value` will
write, which is the same predicate three endpoints already use (`!= "manual"`):

  * **imported** — SPARSE BY DESIGN. `dataset_import` skips a blank cell
    (`if not cell: continue`), so materialising here would add one row per blank
    on a 3.1M-cell import to make editable something the server 403s anyway.
  * **computed** — heals itself. `computed_columns.recompute_column_values`
    UPSERTS, creating the cell when it is missing.
  * **managed** — an absent cell MEANS something there (row 45: no usable
    rating ⇒ no cell, and NULL is never zero). A blank cell would be a claim.

⚠️ A DERIVED column is `source="manual"` (Decision B), so a row added after a
derive gets an EMPTY editable cell rather than the rule's output. That is the
honest result — the rule was applied once, to the rows that existed — and it is
why this function does not try to compute anything.

## Why it takes no row list

🔴 **It reconciles the whole dataset, and that is what makes it REPAIR rather
than merely prevent.** The first draft scoped the append call to the rows it had
just created — correct for new damage and useless for old, since an install that
has already appended to a dataset with a manual variable carries permanently
uneditable cells that nothing would ever revisit. Dataset-wide, every call site
is self-healing, exactly as `sync_rows` is about the row set itself.

It costs one `INSERT … SELECT`: no row ids are bound, so there is no
`IN (...)` and none of the 250,000-bind-parameter ceiling `project_portability`
records (#842). A dataset with no hand-editable column returns at the first
query, which is what keeps the import path's call free.

## The guard

`tests/test_dataset_row_cells.py::TestEveryRowConstructorMaterialisesCells` is a
fail-closed AST scan over `app/`: a fourth `DatasetRow(` site fails the suite
with instructions rather than shipping the fourth instance of this defect.
⚠️ It is structurally blind to `project_portability`, which builds rows by
REFLECTION — the same blindness `participant_dataset`'s docstring records for
`Participant(`. That path has its own call and its own test, which enters at
`import_project` rather than calling this function (#747 → #714 → #757), and the
scan asserts its own blindness so nobody reads a green result as covering it.
"""
from __future__ import annotations

import re

from sqlalchemy import and_, exists, insert, select, true
from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetRow, DatasetValue

#: The width a record identifier is padded to when a dataset has none to follow
#: (`R0001`). Only a starting point — an existing dataset's own widest-numbered
#: identifier wins, so appending to a `R001`-style import keeps that shape.
DEFAULT_RECORD_PAD = 4

_RECORD_ID = re.compile(r"^R(\d+)$")

#: `DatasetColumn.source` for a column a researcher may type into. The same
#: value `update_value`, `update_manual_column` and `delete_manual_column` gate
#: on — stated once here so this module cannot drift from the endpoints whose
#: reachability it exists to guarantee.
EDITABLE_COLUMN_SOURCE = "manual"


def materialise_manual_cells(db: Session, dataset_id: int) -> int:
    """Give every hand-editable column a cell on every row. Returns how many.

    Idempotent, so a caller may ask twice and a re-run writes nothing — and
    idempotent PER CELL rather than per row, so a row holding three of four
    cells (a variable added between two syncs) gets the fourth and
    `ix_dataset_values_row_column` is never offered a duplicate.

    Flushes when it inserts; the caller owns the transaction.
    """
    has_editable_column = db.query(
        db.query(DatasetColumn.id).filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.source == EDITABLE_COLUMN_SOURCE,
        ).exists()
    ).scalar()
    # The common case, and the one the import path takes: no hand-editable
    # column exists, so no row can be missing a cell for one. Returning here
    # keeps this call free on a 75,699-row import.
    if not has_editable_column:
        return 0

    rows = select(DatasetRow.id.label("row_id")).where(
        DatasetRow.dataset_id == dataset_id,
    ).subquery()
    columns = select(DatasetColumn.id.label("column_id")).where(
        DatasetColumn.dataset_id == dataset_id,
        DatasetColumn.source == EDITABLE_COLUMN_SOURCE,
    ).subquery()

    # ⚠️ The cross join is DECLARED (`join(..., true())`), not left implicit.
    # Every (row, column) pair of this dataset is exactly what we want — but an
    # implicit one emits `SAWarning: cartesian product`, and a warning nobody
    # can tell from a real one is how a real one gets ignored.
    missing = (
        select(rows.c.row_id, columns.c.column_id)
        .select_from(rows)
        .join(columns, true())
        .where(~exists().where(and_(
            DatasetValue.row_id == rows.c.row_id,
            DatasetValue.column_id == columns.c.column_id,
        )))
    )
    result = db.execute(
        insert(DatasetValue).from_select(["row_id", "column_id"], missing)
    )
    written = result.rowcount or 0
    if written:
        # ⚠️ LOAD-BEARING under `autoflush=False` (production AND tests): a
        # caller that queries these cells back — or calls this function again —
        # would not see them, and would then insert a second copy and fail the
        # unique index at commit time, far from the cause. The #439/#440 family
        # reached from the insert side, exactly as `sync_rows` records.
        db.flush()
    return written


# ── Record identifiers ───────────────────────────────────────────────────────
#
# 🔴 **ONE derivation, shared by the append wizard and the hand-added record
# (row 47).** It lived inline in `routers/dataset.py::append_import`; a second
# copy is #542b's shape — two implementations of one question, each internally
# consistent, disagreeing the first time either is touched. Here the
# disagreement would be visible in the data itself: a dataset whose records read
# `R0001…R0120` gaining an `R121`.


def parse_record_identifier(rid: str | None) -> tuple[int, int] | None:
    """``'R0001'`` → ``(1, 4)`` — the number and the width it was padded to.

    None for anything else, which is not an error: an imported dataset may
    identify its records by a respondent code, and the participant table uses
    the participant's own identifier.
    """
    m = _RECORD_ID.match(rid or "")
    if m:
        return int(m.group(1)), len(m.group(1))
    return None


def next_record_number(db: Session, dataset_id: int) -> tuple[int, int]:
    """The next free ``R####`` number for this dataset, and the width to use.

    ⚠️ **The width follows the row with the LARGEST number, not the widest
    identifier** — that is the append path's rule, preserved deliberately so the
    two cannot drift. A dataset whose records are `R001…R120` keeps three
    digits; one with no `R####` identifiers at all starts at
    ``DEFAULT_RECORD_PAD``.

    ⚠️ Scans this dataset's identifiers in Python because the shape test is a
    regex. That is what `append_import` already pays, and it is bounded by the
    row count — acceptable for adding one record, and the reason not to build a
    bulk "add N records" on top of it without revisiting this.
    """
    max_num = 0
    pad_width = DEFAULT_RECORD_PAD
    for (rid,) in db.query(DatasetRow.row_identifier).filter(
        DatasetRow.dataset_id == dataset_id,
    ):
        parsed = parse_record_identifier(rid)
        if parsed is None:
            continue
        num, width = parsed
        if num > max_num:
            max_num = num
            pad_width = width
    return max_num + 1, pad_width


def format_record_identifier(number: int, pad_width: int) -> str:
    return f"R{str(number).zfill(pad_width)}"


def create_manual_row(db: Session, dataset_id: int) -> DatasetRow:
    """Add one empty record to ``dataset_id`` and return it. Flushes.

    🔴 **`import_batch` and `submitted_at` are both left NULL, and the second is
    a DECISION rather than an omission.** `dataset_row_order()` is
    ``submitted_at ASC NULLS LAST, id ASC``, so stamping `now()` would sort this
    record BEFORE every undated imported one — silently reordering the whole
    grid, and every `?row=` deep link with it, the first time someone adds a
    record to a dated import. NULL puts it last, which is also what a researcher
    typing a new row expects. `import_batch` stays NULL because the record came
    from no batch; a `"manual"` sentinel there would be a value written by one
    path and read by none (#895's shape).

    ⚠️ Materialising the cells is what makes the record TYPEABLE at all (#897) —
    without a `DatasetValue` per hand-editable column the grid discards every
    edit, because the only cell writer is addressed by an existing cell id.
    """
    number, pad_width = next_record_number(db, dataset_id)
    row = DatasetRow(
        dataset_id=dataset_id,
        participant_id=None,
        row_identifier=format_record_identifier(number, pad_width),
        import_batch=None,
        submitted_at=None,
    )
    db.add(row)
    db.flush()
    materialise_manual_cells(db, dataset_id)
    return row
