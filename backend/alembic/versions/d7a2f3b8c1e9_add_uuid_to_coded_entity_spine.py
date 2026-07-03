"""add stable uuid to the coded-entity spine (J3-2-0)

Track J · J3-2-0 (merge-engine prerequisite). Adds a stable per-entity `uuid` to the
coded-data spine (conversations, documents, segments, codes, code_categories,
datasets, dataset_columns, dataset_rows, participants) so a future `merge_project()`
can match entities across `.mmproject` copies EXACTLY, instead of by fragile natural
keys (a wrong match silently mis-attributes coding — the failure this prevents).
Mirrors the J1 `project_uuid` pattern.

Additive nullable columns + a Python backfill of existing rows (so projects created
before J3-2-0 are still mergeable) + per-column unique indexes. env.py holds
PRAGMA foreign_keys=OFF for the whole migration; a plain nullable column add needs no
batch_alter_table.

Revision ID: d7a2f3b8c1e9
Revises: c5d8e1f20a3b
Create Date: 2026-06-24 00:00:00.000000

"""
from typing import Sequence, Union
import uuid as _uuid

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7a2f3b8c1e9'
down_revision: Union[str, None] = 'c5d8e1f20a3b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Mirrors the 9 model classes given a `uuid` column in J3-2-0.
_TABLES = [
    "conversations", "documents", "segments", "codes", "code_categories",
    "datasets", "dataset_columns", "dataset_rows", "participants",
]


def upgrade() -> None:
    conn = op.get_bind()
    for table in _TABLES:
        op.add_column(table, sa.Column("uuid", sa.String(length=36), nullable=True))
        # Backfill existing rows so they carry a stable identity for round-trip/merge.
        rows = conn.execute(sa.text(f"SELECT id FROM {table} WHERE uuid IS NULL")).fetchall()
        for (rid,) in rows:
            conn.execute(
                sa.text(f"UPDATE {table} SET uuid = :u WHERE id = :i"),
                {"u": str(_uuid.uuid4()), "i": rid},
            )
        # Unique index named to match `Column(..., unique=True, index=True)` (ix_<table>_uuid).
        op.create_index(f"ix_{table}_uuid", table, ["uuid"], unique=True)


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_index(f"ix_{table}_uuid", table_name=table)
        op.drop_column(table, "uuid")
