"""#1352 / #1246 — `users.uuid`: a coder's identity across installs

Revision ID: c6e2a8d41f97
Revises: f5b2d8c47e13
Create Date: 2026-10-23

Every install's first coder is "Researcher" (`auth.DEFAULT_CODER_NAME`), and a coder
crossed installs by NAME alone, so a colleague's coding copy landed the lead's codings
on the colleague's own "Researcher" and the merge back landed the colleague on the
lead's: two people became one coder before either screen could ask. A name is a string
somebody typed; this column is the coder's own identity, minted where the coder was
created and carried in every `.mmproject` (`CODER_PORTABLE_FIELDS`).

The `b3f1d9a7c2e5` shape: a nullable column, every existing row backfilled, then a
unique index. NULL stays legal — a row written around the ORM default has no identity,
and the import then falls back to the name rules it had before.

`.mmproject` stays v7: an older build drops the field and resolves coders by name, which
is that build's own behaviour today (the descriptive case, not a refusal gate).
"""
from typing import Sequence, Union
import uuid as _uuid

from alembic import op
import sqlalchemy as sa


revision: str = 'c6e2a8d41f97'
down_revision: Union[str, None] = 'f5b2d8c47e13'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "users"


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
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column("uuid")
