"""Membership in a LARGE id collection, as one bound parameter (#956).

`column.in_(ids)` renders ONE BIND PARAMETER PER ELEMENT, and SQLite refuses a
statement carrying more than `SQLITE_MAX_VARIABLE_NUMBER` = **250,000** of them
(measured by bisection for #842). Any collection that grows with a dataset —
every value in the selected text columns is rows × columns, 843,535 on the BES
corpus — therefore turns an ordinary request into a raw
`sqlite3.OperationalError: too many SQL variables` and a 500.

`in_id_set` sends the whole collection as ONE JSON array and lets SQLite unpack
it: `column IN (SELECT value FROM json_each(?))`. The result set is identical to
`.in_()` — same members, same semantics for an empty collection (matches
nothing) — so a call site changes its spelling and nothing else.

**Measured on the BES corpus, 2026-09-13** (plain SQLite 3.45.1):

| query | ids | bound list | `in_id_set` |
|---|---|---|---|
| `count(distinct dataset_value_id)` over `code_applications` | 240,000 | 0.34 s | 0.23 s |
| same | 843,535 | 🔴 too many SQL variables | 1.06 s |

The plan is unchanged: `SEARCH code_applications USING COVERING INDEX
ix_code_applications_dataset_value_id`, with the JSON array as a `LIST SUBQUERY`.

⚠️ **Why not chunk the list.** Half of these call sites are aggregates
(`count(distinct …)` grouped by code); chunked, each needs its own merge logic,
and #842 measured that chunking a bind list moves the failure into memory rather
than removing it. A join back to the dataset is the other exact remedy (#842's
export), but here most sites filter in PYTHON first (`is_empty_text`), so the SQL
set would have to re-implement that rule — the two-implementations hazard
`substantive_text_clause` already carries.

⚠️ **`json_each` is present in BOTH shipped builds** — checked, not assumed: the
dev/test driver (stdlib `sqlite3`, SQLite 3.45.1) and the packaged app's
`sqlcipher3` (SQLCipher 4.12.0 community, SQLite 3.51.1). JSON functions are
built in from SQLite 3.38 unless compiled out.

⚠️ **SQLite only.** PostgreSQL spells this differently (`= ANY(:array)`), and a
port must give this helper a dialect arm rather than inherit a function that
does not exist there.
"""
from __future__ import annotations

import json
from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.sql.elements import ColumnElement


def in_id_set(column, ids: Iterable[int]) -> ColumnElement[bool]:
    """`column IN ids` with ONE bind parameter however many ids there are.

    `ids` must be integers — ids, not values. A bool is refused even though it
    IS an int in Python: `json.dumps(True)` is `true`, which never equals a
    column value, so the row would silently fall out of the set.
    """
    members: list[int] = []
    for value in ids:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(
                f"in_id_set takes integer ids; got {type(value).__name__} {value!r}"
            )
        members.append(value)
    unpacked = func.json_each(json.dumps(members)).table_valued("value")
    return column.in_(select(unpacked.c.value))
