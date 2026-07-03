"""add codebook_frozen_at to projects

Track J · J3-1: the "Freeze Codebook" soft-lock. Adds a nullable timestamp on
`projects` (NULL = unfrozen; a value = frozen-at, the audit-log anchor). Plain
nullable column add → `op.add_column`, no table recreate, no backfill (env.py holds
PRAGMA foreign_keys=OFF for the whole migration regardless).

Revision ID: c5d8e1f20a3b
Revises: fa4d77977779
Create Date: 2026-06-24 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5d8e1f20a3b'
down_revision: Union[str, None] = 'fa4d77977779'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("codebook_frozen_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "codebook_frozen_at")
