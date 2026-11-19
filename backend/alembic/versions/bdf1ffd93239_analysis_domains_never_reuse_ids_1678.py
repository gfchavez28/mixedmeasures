"""#1678 — a deleted variable group's id is never handed out again: AUTOINCREMENT on
`analysis_domains`

Revision ID: bdf1ffd93239
Revises: c3a7e1f9b5d8

A saved chart names its variable groups by id (`material_config.ID_KEYS`: `domain_ids`, the
legacy `selected_domains`), plain integers in JSON with no foreign key, in the material and in
every canvas chart embed's copy of its settings. `analysis_domains` had no AUTOINCREMENT, so
SQLite gave a new group `max(id) + 1`: when the NEWEST group was deleted — by its own delete, or
by a manual-column delete that empties it (#923's cascade) — the next group made took its id,
and a chart saved over *Wellbeing* drew *Burnout*'s members under its stored name. The 2026-11-17c
review found it is the only table a chart setting names that still reused ids (`codes` and the
rest are `c3a7e1f9b5d8`'s nine; coders are never deleted; `custom_order` only orders).

## How — `c3a7e1f9b5d8`'s pattern, for one table

The table is rebuilt with `batch_alter_table(recreate='always')` and
`table_kwargs={"sqlite_autoincrement": True}`: SQLite cannot add AUTOINCREMENT in place. The copy
keeps every id, so `sqlite_sequence` starts at the highest id in the table. env.py holds
`PRAGMA foreign_keys=OFF` at the connection level, so the DROP inside the rebuild cascades into
none of its children (`analysis_domain_members`, the domain metrics' `input_source_id` — which
has no FK); the chain is one transaction (`backend/alembic/the internal design notes).

## The seed — ids freed BEFORE this upgrade (D320's leftover, D366)

The sequence is raised to the highest id the audit trail names for `entity_type =
"analysis_domain"` (every create and delete door logs one — `routers/analysis_domains.py`,
`routers/crosswalk.py`), when that is higher than the copy's start. An id freed before the upgrade
above every audited one can still be issued once — the stated residual, as D320's.

## Downgrade

Rebuilds the table without AUTOINCREMENT; dropping the AUTOINCREMENT table removes its
`sqlite_sequence` row. Ids issued meanwhile are kept.

On the connection it is given, inside the chain's one transaction; imports nothing from `app.`.
"""
from alembic import op
import sqlalchemy as sa


revision = 'bdf1ffd93239'
down_revision = 'c3a7e1f9b5d8'
branch_labels = None
depends_on = None


#: The rebuilt table → the audit trail's `entity_type` for its rows. FROZEN here, as a revision
#: must be; `tests/test_id_reuse_autoincrement_1639.py` holds the UNION of this list and
#: `c3a7e1f9b5d8`'s against the models and the stored-id census.
TABLES: dict[str, str | None] = {
    "analysis_domains": "analysis_domain",
}


def _seed(table: str, entity_type: str | None) -> None:
    """Raise `table`'s sequence to the highest id the audit trail names for it (D320)."""
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
