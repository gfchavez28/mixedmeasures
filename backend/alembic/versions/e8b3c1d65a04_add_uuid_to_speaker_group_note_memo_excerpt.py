"""add stable uuid to speaker/segment_group/note/memo/excerpt (J3-2-0b)

Track J · J3-2-0b. Extends the J3-2-0 per-entity uuid spine to the entities that the
merge loop would otherwise DUPLICATE (they have no natural key): Speaker, SegmentGroup
(shared sources — match-and-skip on merge) and Note, Memo, Excerpt (a co-coder's
annotations — match-or-insert, so re-merging the same file doesn't duplicate them).
Same additive pattern as d7a2f3b8c1e9: nullable column + Python backfill + unique index.

Revision ID: e8b3c1d65a04
Revises: d7a2f3b8c1e9
Create Date: 2026-06-24 00:00:00.000000

"""
from typing import Sequence, Union
import uuid as _uuid

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e8b3c1d65a04'
down_revision: Union[str, None] = 'd7a2f3b8c1e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# NOTE: excerpt is SINGULAR (Excerpt.__tablename__ == "excerpt").
_TABLES = ["speakers", "segment_groups", "notes", "memos", "excerpt"]


def upgrade() -> None:
    conn = op.get_bind()
    for table in _TABLES:
        op.add_column(table, sa.Column("uuid", sa.String(length=36), nullable=True))
        rows = conn.execute(sa.text(f"SELECT id FROM {table} WHERE uuid IS NULL")).fetchall()
        for (rid,) in rows:
            conn.execute(
                sa.text(f"UPDATE {table} SET uuid = :u WHERE id = :i"),
                {"u": str(_uuid.uuid4()), "i": rid},
            )
        op.create_index(f"ix_{table}_uuid", table, ["uuid"], unique=True)


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_index(f"ix_{table}_uuid", table_name=table)
        op.drop_column(table, "uuid")
