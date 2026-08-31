"""#823(d) — a recode rule can band a continuous variable by RANGE

Revision ID: c9e1f4a2b7d3
Revises: d7f3a91c8b24
Create Date: 2026-08-31

Before this, Scale Map and Category Group listed one row per DISTINCT value —
72 for GSS `age`, 39 for a 48-row Ferncrest dataset — so "two bands" meant
typing 72 group names with no ranges and no fill-down. The missing-values editor
three inches away on the same screen has had `Add range` since #592.

## Why a new column rather than an encoding inside `mapping`

`mapping` is a JSON OBJECT matched case-insensitively against the cell's
`value_text`. A range is a numeric PREDICATE, not a key, and it is ORDERED
(first match wins). Encoding one as a reserved key (`"__range__:18:29"`) would
make every consumer of `mapping` — three matchers, the flip, the copy-to remap,
the reverse-offset computation — responsible for knowing the magic prefix, and
`mapping_numeric_values` would start seeing bounds as scale points.

A sibling JSON column keeps `mapping` meaning exactly what it has always meant.
It mirrors `dataset_columns.missing_values`, which stores the same shape for the
same reason.

## Shape

`[{"lo": <number|null>, "hi": <number|null>, "output": <number|string>}, ...]`

`lo`/`hi` are inclusive and either may be null for an open end (SPSS's
`LO THRU` / `THRU HI`); `output` is the band's value — a number on a
`scale_map`, a group name on a `category_group`. ⚠️ **`output` is REQUIRED**,
which is where this diverges from a missing-values range: there a `label` is
optional display metadata because ranges never label-match cells, while here the
output IS the rule's result.

## SQLite

A plain nullable column, so `op.add_column` is enough — no `batch_alter_table`.
That rule exists for adding a column WITH a foreign key (table recreation), and
recreating `recode_definitions` unnecessarily would replay its reflected indexes
for no gain.
"""
from alembic import op
import sqlalchemy as sa


revision = 'c9e1f4a2b7d3'
down_revision = 'd7f3a91c8b24'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'recode_definitions',
        sa.Column('ranges', sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('recode_definitions', 'ranges')
