"""Decision B — a derived variable records where it came from

Revision ID: d7f3a91c8b24
Revises: b8e4c2a70d19
Create Date: 2026-08-24

Decision B makes "recode into a NEW variable" the offered path. Without
provenance the result is indistinguishable from a hand-made manual column, which
loses the very distinction B exists to create — a researcher opening a project
six months later cannot tell `Math_Anxiety_R` from a column somebody typed.

## Two fields, and why it is not one

`derived_from_column_id` — a real FK with ON DELETE SET NULL, so deleting the
source degrades the trail rather than leaving a dangling id pointing at whatever
row later takes that number.

`derived_via` — the rule's NAME, snapshotted at derivation time. ⚠️ **This is
deliberately a string and NOT a FK to `recode_definitions`.** A derived column is
a SNAPSHOT: its cells were computed once and never recompute. An FK would keep
resolving to the definition's CURRENT mapping, so editing that rule would
silently make the provenance claim false — the column would say it was produced
by a rule that no longer describes it. A name captured at the time cannot lie in
that direction, and the honest reading of a snapshot is a name, not a live link.

## Why not reuse `depends_on_column_ids`

Measured before writing this: all three of its readers gate on
`expression IS NOT NULL` (`services/staleness.py`, `routers/dataset.py`) or
`source == "computed" and expression` (`routers/export_r.py`), so setting it on a
manual column happens to be inert TODAY. That is a coincidence, not a contract —
a future reader keying on `depends_on_column_ids IS NOT NULL` would sweep derived
columns into a computed-column recompute. It is also semantically wrong: that
field means "this formula references these columns", and a snapshot references
nothing at runtime.

## SQLite

`batch_alter_table` because adding a column WITH a foreign key needs table
recreation on SQLite. `alembic/env.py` holds `PRAGMA foreign_keys=OFF` at the
connection level for the duration, which is what makes the DROP+RENAME safe.
Reflection copies this table's partial unique index
(`ix_equivalence_unique_column_per_dataset`, `WHERE equivalence_group_id IS NOT
NULL`); its predicate references a column this migration does not touch, so the
replay is a no-op rather than the "no such column" failure that rule warns about.
"""
from alembic import op
import sqlalchemy as sa


revision = 'd7f3a91c8b24'
down_revision = 'b8e4c2a70d19'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('dataset_columns', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('derived_from_column_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('derived_via', sa.String(length=255), nullable=True))
        batch_op.create_foreign_key(
            'fk_dataset_columns_derived_from',
            'dataset_columns',
            ['derived_from_column_id'],
            ['id'],
            ondelete='SET NULL',
        )
    op.create_index(
        'ix_dataset_columns_derived_from_column_id',
        'dataset_columns',
        ['derived_from_column_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_dataset_columns_derived_from_column_id', table_name='dataset_columns')
    with op.batch_alter_table('dataset_columns', recreate='always') as batch_op:
        batch_op.drop_constraint('fk_dataset_columns_derived_from', type_='foreignkey')
        batch_op.drop_column('derived_via')
        batch_op.drop_column('derived_from_column_id')
