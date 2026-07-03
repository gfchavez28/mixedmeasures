"""trackj_j1_coder_roster_and_reserved_columns

Track J · J1 schema groundwork (no behavior change — reserve-only columns):
  users:            password_hash -> nullable; + display_color, coder_type (reserve, D14),
                    archived (archive-not-delete)
  code_applications:+ origin (reserve, default 'human'), origin_context (reserve, D15)
  projects:         + project_uuid (stable cross-instance identity; reserve for the J3 round-trip/merge)

See the internal design notes

Revision ID: af95c698c3a2
Revises: 94edc0f39eba
Create Date: 2026-06-21 17:49:03.608979

"""
from typing import Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'af95c698c3a2'
down_revision: Union[str, None] = '94edc0f39eba'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users: password_hash nullable + coder-roster columns ──────────────────
    # SQLite can't ALTER a column's nullability in place, so the alter_column
    # forces a table recreate. env.py holds PRAGMA foreign_keys=OFF at the
    # connection level, so recreating `users` does not cascade to children.
    with op.batch_alter_table("users", recreate="always") as batch_op:
        batch_op.alter_column("password_hash", existing_type=sa.String(255), nullable=True)
        batch_op.add_column(sa.Column("display_color", sa.String(7), nullable=True))
        batch_op.add_column(sa.Column("coder_type", sa.String(20), nullable=False, server_default="human"))
        batch_op.add_column(sa.Column("archived", sa.Boolean(), nullable=False, server_default="0"))

    # ── code_applications: provenance reserve (NOT NULL via server_default) ────
    op.add_column("code_applications", sa.Column("origin", sa.String(20), nullable=False, server_default="human"))
    op.add_column("code_applications", sa.Column("origin_context", sa.Text(), nullable=True))

    # ── projects: stable cross-instance identity (reserve) ────────────────────
    # Add nullable, backfill a distinct uuid4 per existing row, then add the
    # unique index. (server_default can't generate a per-row-unique value in
    # SQLite, so the backfill is a data migration; new rows get the ORM default.)
    op.add_column("projects", sa.Column("project_uuid", sa.String(36), nullable=True))
    conn = op.get_bind()
    project_ids = [row[0] for row in conn.execute(sa.text("SELECT id FROM projects")).fetchall()]
    for pid in project_ids:
        conn.execute(
            sa.text("UPDATE projects SET project_uuid = :u WHERE id = :id"),
            {"u": str(uuid.uuid4()), "id": pid},
        )
    op.create_index("ix_projects_project_uuid", "projects", ["project_uuid"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_projects_project_uuid", table_name="projects")
    op.drop_column("projects", "project_uuid")

    op.drop_column("code_applications", "origin_context")
    op.drop_column("code_applications", "origin")

    with op.batch_alter_table("users", recreate="always") as batch_op:
        batch_op.drop_column("archived")
        batch_op.drop_column("coder_type")
        batch_op.drop_column("display_color")
        batch_op.alter_column("password_hash", existing_type=sa.String(255), nullable=False)
