"""#1639 — a deleted row's id is never handed out again: AUTOINCREMENT on the nine tables a
joint display names by id

Revision ID: c3a7e1f9b5d8
Revises: b8d4f2a6c0e9

A joint display is one Tiptap node in a canvas section's text (D162), so the ids it binds are
plain integers in JSON and no foreign key protects them. Without AUTOINCREMENT SQLite gives a
new row `max(id) + 1`, so when the NEWEST row of a table is deleted the next row made takes its
id, and a display that bound the deleted row draws the new one's numbers under the old
construct's name. AUTOINCREMENT makes SQLite remember the highest id it ever issued
(`sqlite_sequence`), so a freed id is never issued again: the display finds nothing for that id
and says so (the compute's missing list), the same as for any other deleted row.

## The tables (r2-1) — every table `services/joint_display_node.py` names, less two

`codes`, `dataset_columns`, `conversations`, `documents`, `observations`, `datasets`,
`materials`, `excerpt` (the node's "excerpts"), `participants`. Left out:

- `users` (the node's "coders", a meta-inference's author): nothing deletes a user.
- `segments`: the display binds no segment id, it is the largest table by far (1.2 M rows on
  D12), and `services/withdrawal_history.py` already reads a segment id as LIFETIMES (#1547).

## How

Each table is rebuilt with `batch_alter_table(recreate='always')` and
`table_kwargs={"sqlite_autoincrement": True}`: SQLite cannot add AUTOINCREMENT to a table in
place. The copy keeps every id (an `INSERT … SELECT`), so `sqlite_sequence` starts at the
table's highest id, and the rename keeps that row. env.py holds `PRAGMA foreign_keys=OFF` at the
connection level, so the DROP inside the rebuild cascades into no child; the chain is one
transaction (`backend/alembic/the internal design notes). No column is dropped, so the partial indexes the
batch copies (datasets, dataset_columns, excerpt) keep their `WHERE` unchanged.

⚠️ SQLAlchemy 2.0 does not REFLECT `sqlite_autoincrement`, so a LATER migration that rebuilds
one of these tables with `batch_alter_table` must pass the same `table_kwargs`, or it silently
returns the table to reusing ids. `scripts/schema_diff_harness.py` compares AUTOINCREMENT
since this revision, so a rebuild that forgets fails that gate.

## The seed (r2-2) — ids freed BEFORE this upgrade

The copy starts the sequence at the highest id still in the table, so an id freed above it
before the upgrade (the newest row, already deleted) would still be issued once. The sequence
is raised to the highest id the audit trail names for that entity type, when that is higher:
every create and delete door that logs an entry names the row's id, so it is the highest id
the install is known to have issued. Rows the audit does not name (a dataset delete's columns,
`materials`) keep the copy's start. One indexed aggregate per table; raising a sequence only
skips ids, so a stray entry costs nothing but a gap.

No joint display exists before this upgrade on a released install — the node arrives in the
same release (`e7b3c5a9d2f4`), and this chain is one transaction — so the seed is for the
OTHER stored ids the same tables back (chart configs, canvas quote embeds).

## Downgrade

Rebuilds each table without AUTOINCREMENT; dropping the AUTOINCREMENT table removes its
`sqlite_sequence` row. Ids issued meanwhile are kept.

On the connection it is given, inside the chain's one transaction; imports nothing from `app.`.
"""
from alembic import op
import sqlalchemy as sa


revision = 'c3a7e1f9b5d8'
down_revision = 'b8d4f2a6c0e9'
branch_labels = None
depends_on = None


#: Each rebuilt table → the audit trail's `entity_type` for its rows (None: never named by id).
#: FROZEN here, as a revision must be; `tests/test_id_reuse_autoincrement_1639.py` holds the
#: table list against `joint_display_node`'s and the models'.
TABLES: dict[str, str | None] = {
    "codes": "code",
    "dataset_columns": "dataset_column",
    "conversations": "conversation",
    "documents": "document",
    "observations": "observation",
    "datasets": "dataset",
    "materials": None,
    "excerpt": "excerpt",
    "participants": "participant",
}


def _seed(table: str, entity_type: str | None) -> None:
    """Raise `table`'s sequence to the highest id the audit trail names for it (r2-2)."""
    if entity_type is None:
        return
    bind = op.get_bind()
    # An empty table has no `sqlite_sequence` row until its first insert.
    bind.execute(sa.text(
        "INSERT INTO sqlite_sequence (name, seq) SELECT :t, 0 "
        "WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = :t)"), {"t": table})
    bind.execute(sa.text(
        "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE("
        "(SELECT MAX(entity_id) FROM audit_entries WHERE entity_type = :et), 0)) "
        "WHERE name = :t"), {"t": table, "et": entity_type})


def upgrade() -> None:
    for table, entity_type in TABLES.items():
        with op.batch_alter_table(table, recreate='always',
                                  table_kwargs={"sqlite_autoincrement": True}):
            pass
        _seed(table, entity_type)


def downgrade() -> None:
    for table in reversed(list(TABLES)):
        with op.batch_alter_table(table, recreate='always',
                                  table_kwargs={"sqlite_autoincrement": False}):
            pass
