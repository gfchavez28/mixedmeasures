"""add stable uuid to code_equivalence_groups (J3-2b · B0)

Track J · J3-2b (divergent-codebook reconciliation prerequisite). Extends the
J3-2-0/0b per-entity uuid spine to `CodeEquivalenceGroup` — the reconciliation
substrate. The merge path CREATES equivalence groups on the target (it does not
import the file's), so this uuid is not needed for the first merge; it keeps a
later re-export → re-merge of an already-reconciled project from DUPLICATING its
groups (the same forward-merge-safety the rest of the spine provides).

Same additive pattern as d7a2f3b8c1e9 / e8b3c1d65a04: nullable column + Python
backfill of existing rows + a unique index. env.py holds PRAGMA foreign_keys=OFF
for the whole migration; a plain nullable column add needs no batch_alter_table.

Revision ID: b3f1d9a7c2e5
Revises: e8b3c1d65a04
Create Date: 2026-06-25 00:00:00.000000

"""
from typing import Sequence, Union
import uuid as _uuid

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3f1d9a7c2e5'
down_revision: Union[str, None] = 'e8b3c1d65a04'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "code_equivalence_groups"


def upgrade() -> None:
    conn = op.get_bind()
    op.add_column(_TABLE, sa.Column("uuid", sa.String(length=36), nullable=True))
    rows = conn.execute(sa.text(f"SELECT id FROM {_TABLE} WHERE uuid IS NULL")).fetchall()
    for (rid,) in rows:
        conn.execute(
            sa.text(f"UPDATE {_TABLE} SET uuid = :u WHERE id = :i"),
            {"u": str(_uuid.uuid4()), "i": rid},
        )
    op.create_index(f"ix_{_TABLE}_uuid", _TABLE, ["uuid"], unique=True)


def downgrade() -> None:
    op.drop_index(f"ix_{_TABLE}_uuid", table_name=_TABLE)
    op.drop_column(_TABLE, "uuid")
