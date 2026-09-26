"""Is this appended record already in the dataset? ONE answer for both append steps (#1014).

## Why this module exists

The append wizard asks the question twice — `append_preview` to say *"N of M
rows match existing responses"* and `append_import` to skip them — and each
step carried its own copy of the answer. Three consequences, all measured on a
40,000 × 30 dataset before this module existed:

  * **The cost scaled with the EXISTING dataset, not the file.** Both steps
    loaded every `DatasetRow` with every `DatasetValue` as ORM objects (1.14M
    here) to fingerprint them: preview 23.5 s / 1,945 MB peak, import
    27.5 s / 2,582 MB — to add five records. Both endpoints are `async def`
    with `await`s in them, so every second of that froze the whole server.
  * **The two copies disagreed about a record repeated WITHIN the file.** The
    import adds each record's fingerprint as it goes, so a second copy is
    skipped; the preview did not, so the page promised one more record than
    the import wrote.
  * **They disagreed about a CODE-format file on a value-labelled column.** The
    import resolves a cell through `resolve_labelled_cell` before
    fingerprinting (#575, so `"3"` matches an existing `"Agree"`); the preview
    fingerprinted the raw cell and reported no duplicates for the same file.

`fingerprint` is now the one normalisation and `DuplicateCheck` the one
decision; the router resolves cells the same way on both steps.

## How the existing side is read

One Core `SELECT row_id, column_id, value_text`, streamed in `row_id` order, so
only ONE record's cells are held at a time and each record is reduced to a
16-byte digest. The normalisation — `strip().lower()` — stays in PYTHON on
purpose: SQLite's `lower()` folds ASCII only and its `trim()` strips spaces
only, so moving either into SQL would silently stop `"ÉTÉ"` matching `"été"`
or a tab-padded cell matching its trimmed twin.

⚠️ **A record with no cell in ANY compared column never appears in that
stream** (the importer stores no row for a blank cell), and it must still match
an all-blank appended record, as it did when every row was loaded. The count
of records the stream saw is compared with the dataset's row count to find
out whether one exists.

⚠️ **The digest can in principle collide** (BLAKE2b-128: ~2^-128 per pair); the
tuples it replaces could not. That is the trade for holding 16 bytes per record
instead of every cell's text.
"""
from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models.dataset import DatasetRow, DatasetValue
from .id_set import in_id_set

#: Rows fetched per round trip while streaming the existing values.
_STREAM_BATCH = 10_000


def fingerprint(cells: Mapping[int, str | None], column_ids: Iterable[int]) -> bytes:
    """The identity of one record over ``column_ids``: its cells, trimmed and
    case-folded, in column-id order. A column with no cell counts as blank.

    The ONE normalisation — existing records and appended ones both go through
    here, so the two sides cannot fold case or whitespace differently.
    """
    # `repr` of a tuple of str is unambiguous (it quotes and escapes each item)
    # and twice as fast as `json.dumps` here, measured. Column ids need not be
    # encoded: both sides of one comparison use the same sorted column set, so
    # POSITION identifies the column.
    parts = tuple((cells.get(cid) or "").strip().lower() for cid in sorted(column_ids))
    return hashlib.blake2b(repr(parts).encode(), digest_size=16).digest()


def existing_fingerprints(db: Session, dataset_id: int, column_ids: Iterable[int]) -> set[bytes]:
    """One fingerprint per record already in ``dataset_id``, over ``column_ids``."""
    col_ids = sorted(set(column_ids))
    found: set[bytes] = set()
    if not col_ids:
        return found

    # ⚠️ The column ids alone already confine this to ONE dataset (a column
    # belongs to one), so the `dataset_id` term decides no membership — a
    # mutant dropping it survives the suite by design. It is here for the PLAN:
    # SQLite drives from the dataset's rows (a covering index, in id order) and
    # probes `ix_dataset_values_row_column` per row. And the ORDER BY names
    # `DatasetRow.id`, not the equal `DatasetValue.row_id`, because that is the
    # order the outer loop already yields — ordering by the value column made
    # SQLite sort every fetched value in a temp B-tree first (EXPLAIN QUERY PLAN).
    stmt = (
        select(DatasetValue.row_id, DatasetValue.column_id, DatasetValue.value_text)
        .join(DatasetRow, DatasetRow.id == DatasetValue.row_id)
        .where(
            DatasetRow.dataset_id == dataset_id,
            in_id_set(DatasetValue.column_id, col_ids),
        )
        .order_by(DatasetRow.id)
    )

    rows_seen = 0
    current_row: int | None = None
    cells: dict[int, str | None] = {}
    # Through the CONNECTION, not `db.execute`: the Session wraps every result
    # row in the ORM loading layer, which was ~70% of this function's time on
    # 1.1M values (measured) for rows that are plain tuples either way.
    result = db.connection().execute(stmt)
    for row_id, column_id, value_text in _stream(result):
        if row_id != current_row:
            if current_row is not None:
                found.add(fingerprint(cells, col_ids))
                rows_seen += 1
            current_row = row_id
            cells = {}
        cells[column_id] = value_text
    if current_row is not None:
        found.add(fingerprint(cells, col_ids))
        rows_seen += 1

    total_rows = db.execute(
        select(func.count(DatasetRow.id)).where(DatasetRow.dataset_id == dataset_id)
    ).scalar_one()
    if total_rows > rows_seen:
        found.add(fingerprint({}, col_ids))
    return found


def _stream(result):
    """Yield a result's rows a batch at a time, never the whole set at once."""
    while batch := result.fetchmany(_STREAM_BATCH):
        yield from batch


class DuplicateCheck:
    """Decides, record by record in file order, whether an appended record is a
    duplicate — of one already in the dataset, or of an EARLIER record in the
    same file. Both append steps walk the file through one of these, so the
    preview's count is the import's.
    """

    EXISTING = "existing"
    IN_FILE = "in_file"

    def __init__(self, existing: set[bytes]):
        self._existing = existing
        self._file: set[bytes] = set()

    def check(self, fp: bytes) -> str | None:
        """``EXISTING``, ``IN_FILE``, or None for a new record — and remembers it."""
        if fp in self._existing:
            return self.EXISTING
        if fp in self._file:
            return self.IN_FILE
        self._file.add(fp)
        return None
