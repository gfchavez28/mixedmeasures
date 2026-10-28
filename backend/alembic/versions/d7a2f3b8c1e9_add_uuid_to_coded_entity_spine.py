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


#: The SQL name of the per-row `uuid4()` this revision registers on its own connection.
_UUID4_SQL = "mm_migration_uuid4"


def upgrade() -> None:
    conn = op.get_bind()
    # #1362: ONE statement per table, not one per row. The per-row loop issued an UPDATE
    # through SQLAlchemy for every row of nine tables — 38 s of a 1.0 project's 48 s
    # upgrade at 400k turns, the one revision that outlasted the shell's startup deadline.
    # The values are the same Python `uuid4()` strings, made per row by a function
    # registered on this connection only (non-deterministic, so SQLite calls it per row).
    conn.connection.driver_connection.create_function(
        _UUID4_SQL, 0, lambda: str(_uuid.uuid4())
    )
    for table in _TABLES:
        op.add_column(table, sa.Column("uuid", sa.String(length=36), nullable=True))
        # Backfill existing rows so they carry a stable identity for round-trip/merge.
        conn.execute(sa.text(f"UPDATE {table} SET uuid = {_UUID4_SQL}() WHERE uuid IS NULL"))
        # Unique index named to match `Column(..., unique=True, index=True)` (ix_<table>_uuid).
        op.create_index(f"ix_{table}_uuid", table, ["uuid"], unique=True)


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_index(f"ix_{table}_uuid", table_name=table)
        op.drop_column(table, "uuid")
