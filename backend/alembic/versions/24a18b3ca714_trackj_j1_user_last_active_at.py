"""trackj_j1_user_last_active_at

Track J · J1 active-coder persistence ([MEDIUM] misattribution fix). Adds a
nullable `users.last_active_at` timestamp, stamped on every coder switch, so
`ensure_default_user` can re-select the most-recently-active coder after a
session expiry / restart instead of silently reverting to the lowest-id
"Researcher". Additive nullable column — no backfill, no data change.

See the internal design notes (Review delta, D-b).

Revision ID: 24a18b3ca714
Revises: af95c698c3a2
Create Date: 2026-06-21 19:48:24.208961

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '24a18b3ca714'
down_revision: Union[str, None] = 'af95c698c3a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable add — SQLite supports plain ADD COLUMN, no table recreate needed.
    op.add_column("users", sa.Column("last_active_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    # batch_alter_table for the drop (portable SQLite column removal); env.py
    # holds PRAGMA foreign_keys=OFF so the recreate doesn't cascade to children.
    with op.batch_alter_table("users", recreate="always") as batch_op:
        batch_op.drop_column("last_active_at")
