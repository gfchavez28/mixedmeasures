"""declared missing values on dataset columns (#592 slab 1)

Adds ``dataset_columns.missing_values`` — a nullable JSON rule list declaring
which cell values are missing/non-response for THIS column (discrete codes,
optionally labelled, and SPSS-style numeric ranges — shapes + semantics in
``services/missing_values.py``).

NULL (what every existing row gets — no backfill, the ``treat_as_empty``
pattern) = "no declaration": the recognized-N/A ``_is_na`` defaults apply, so
nothing changes at rest. A non-null declaration REPLACES the defaults for its
column (#592 §I.7).

Purely additive and nullable — no batch_alter_table (a nullable ADD COLUMN
needs no table rebuild in SQLite, so nothing here can cascade). The column
rides `.mmproject` export/import by reflection. FORMAT-VERSION DECISION
(#592 §I.10, made here as the plan requires): ``CURRENT_FORMAT_VERSION`` WILL
bump 3→4 — an older build silently DROPS the field on import, losing a
statistics-deciding declaration without a word (the silent-wrongness class
that v2/#414 and v3/Observations bumped for) — but the bump lands with the
slab that ships the first production WRITE path (slab 3's re-apply endpoint /
slab 4's authoring), not here: until something writes a declaration, every
export carries NULL and refusing old builds would cost compatibility for
nothing.

Revision ID: b7c2e4a91d03
Revises: a25ab04b0334
Create Date: 2026-07-16 16:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c2e4a91d03'
down_revision: Union[str, None] = 'a25ab04b0334'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dataset_columns",
        sa.Column("missing_values", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dataset_columns", "missing_values")
