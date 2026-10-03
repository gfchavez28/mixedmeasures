"""What a column's TYPE decides about the cells it has already STORED (#1079 b).

## Why this module exists

🔴 **A cell's stored number is derived from its text UNDER THE COLUMN'S TYPE, once,
when the cell is written — and changing the type re-derived nothing.** The import
(`dataset_import._compute_value_numeric`) and a hand-typed cell
(`routers/dataset.py::update_value`) both compute ``value_numeric`` from the text
by the type of the day: a NUMERIC cell parses, an ORDINAL cell maps its label,
a NOMINAL or free-text cell stores nothing. Both retype doors — the Variables
view's type select and the Data view's header (`routers/recode.py::
bulk_type_update`, every column) and *Variable details…* (`routers/dataset.py::
update_manual_column`, a hand-made one) — changed the type and left the numbers.

MEASURED before this module (the 2026-09-28 pre-implementation review): a column
of ``5``, ``10``, ``12`` typed NOMINAL and retyped NUMERIC kept ``value_numeric =
NULL`` in every cell, through BOTH doors. Every reader of the stored number —
Correlations, Comparisons, means, both exports' numeric cells — saw an empty
column, and Data Quality called every cell unusable, while the grid showed the
numbers. The retype also moved which cells are MISSING (#1048 made that depend
on the type — free text judges whole answers, everything else the prefixes),
and nothing downstream was marked stale.

## What it re-derives, and what it must never touch

Only a column whose stored numbers COME FROM ITS TEXT by the type rule:

* ``source`` is ``imported`` or ``manual`` — a COMPUTED column's numbers come
  from its formula (`update_computed_column` re-evaluates on its own) and a
  MANAGED one's from the rollup (and it refuses a retype anyway, #926);
* it is not a DERIVED variable (Decision B: ``source="manual"`` with
  ``derived_from_column_id`` / ``derived_via``) — its cells are the rule's output,
  a snapshot that deliberately never recomputes, and an unmapped source value
  carried through as text with NO number would gain one here;
* it has no PRIMARY recode — the primary owns ``value_numeric`` (both retype
  doors refuse while any recode exists, but a label edit does not).

⚠️ **The rule is `_compute_value_numeric` itself, never a copy** — the import and
the cell edit both call it, so a re-derivation that used its own arithmetic
would be a third owner of one number (#28's three-owner lesson). The WORD COUNT
mirrors the import's inline rule and is held to it by a round-trip test
(`tests/test_column_retype.py`): retyping away and back reproduces an import
byte for byte.

⚠️ **Existing projects are NOT repaired at startup.** A column retyped before this
build keeps the numbers its old type gave it until it is retyped again. A
startup pass would have to read every cell of every numeric-typed column on
every boot to find them — the scan #1069 measured at 4 s and refused — and the
retype leaves no trace in the column's metadata to gate on. Retyping the column
away and back re-derives it.
"""

from __future__ import annotations

import json

from sqlalchemy import bindparam, select, update
from sqlalchemy.orm import Session

from ..models.dataset import ColumnType, DatasetColumn, DatasetValue
from ..models.recode import RecodeDefinition
from .dataset_import import _compute_value_numeric
from .missing_values import column_missing_rules

#: The sources whose stored numbers come from the cell's TEXT by the type rule.
TEXT_DERIVED_SOURCES = frozenset({"imported", "manual"})


def numbers_follow_text(db: Session, column: DatasetColumn) -> bool:
    """Is this column's ``value_numeric`` derived from its text by its type?

    The ONE predicate for "a retype must re-derive these cells" — see the module
    docstring for why each exclusion exists.
    """
    # `source` alone decides the formula case: every writer of an `expression`
    # writes `source="computed"` (a separate `expression` test was removed when no
    # mutant could fail it, #941).
    if column.source not in TEXT_DERIVED_SOURCES:
        return False
    if column.derived_from_column_id is not None or column.derived_via is not None:
        return False
    has_primary = db.execute(
        select(RecodeDefinition.id).where(
            RecodeDefinition.column_id == column.id,
            RecodeDefinition.is_primary.is_(True),
        ).limit(1)
    ).first()
    return has_primary is None


def _word_count(text: str, column_type: str) -> int | None:
    """The import's rule (`import_dataset_csv`): words for free text, else none."""
    return len(text.split()) if column_type == ColumnType.OPEN_TEXT.value and text.strip() else None


def plan_rederived_cells(db: Session, column: DatasetColumn) -> list[dict]:
    """Every cell whose stored number or word count its CURRENT type would write
    differently, as ``executemany`` parameters. Reads only — takes no write lock,
    so a caller can plan every column before it writes anything (#1033's shape).

    Reads the column's metadata as it is NOW, pending changes included: the
    retype doors set the type (and any scale labels) on the ORM object first.
    """
    if not numbers_follow_text(db, column):
        return []
    column_type = column.column_type.value if hasattr(column.column_type, "value") else str(column.column_type)
    try:
        labels = json.loads(column.scale_labels) if column.scale_labels else None
        values = json.loads(column.scale_values) if column.scale_values else None
    except (json.JSONDecodeError, TypeError):
        labels = values = None
    rules = column_missing_rules(column)

    values_t = DatasetValue.__table__
    changes: list[dict] = []
    for value_id, text, number, words in db.execute(
        select(values_t.c.id, values_t.c.value_text, values_t.c.value_numeric, values_t.c.word_count)
        .where(values_t.c.column_id == column.id, values_t.c.value_text.isnot(None))
    ):
        new_number = _compute_value_numeric(text, column_type, labels, values, missing_rules=rules)
        new_words = _word_count(text, column_type)
        if new_number != number or new_words != words:
            changes.append({"b_id": value_id, "b_text": text, "b_number": new_number, "b_words": new_words})
    return changes


def write_rederived_cells(db: Session, changes: list[dict]) -> int:
    """Write what `plan_rederived_cells` found, in one ``executemany``.

    ⚠️ **Only where the text is still the text the plan read.** The plan is read
    with no lock held, so a cell edited in between (`update_value` derives its own
    number) must not be overwritten with a number computed from the OLD text —
    that would leave a cell whose number is not its text's. Such a cell is
    skipped; its own edit wrote a number for its new text.
    """
    if changes:
        values_t = DatasetValue.__table__
        db.execute(
            update(values_t)
            .where(values_t.c.id == bindparam("b_id"), values_t.c.value_text == bindparam("b_text"))
            .values(value_numeric=bindparam("b_number"), word_count=bindparam("b_words")),
            changes,
        )
    return len(changes)
