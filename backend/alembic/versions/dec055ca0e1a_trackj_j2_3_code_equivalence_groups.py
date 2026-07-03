"""trackj j2-3 code equivalence groups

Revision ID: dec055ca0e1a
Revises: 80630564072b
Create Date: 2026-06-22 20:25:15.885325

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'dec055ca0e1a'
down_revision: Union[str, None] = '80630564072b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Track J · J2-3 — the CodeEquivalenceGroup table + the Code membership FK.

    `canonical_code_id` is a plain int (no FK) to avoid a codes ↔
    code_equivalence_groups creation cycle (see the model docstring). The codes
    column is added via batch (SQLite ALTER ADD COLUMN with a FK needs batch
    mode); env.py handles FK-off safety.
    """
    op.create_table(
        "code_equivalence_groups",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.Integer(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("sequence_order", sa.Integer(), nullable=True),
        sa.Column("canonical_code_id", sa.Integer(), nullable=True),
        sa.Column("origin", sa.String(length=20), nullable=False, server_default="human"),
        sa.Column("origin_context", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_code_equivalence_groups_project_id",
                    "code_equivalence_groups", ["project_id"])

    with op.batch_alter_table("codes") as batch:
        batch.add_column(sa.Column("code_equivalence_group_id", sa.Integer(), nullable=True))
        batch.create_index("ix_codes_code_equivalence_group_id", ["code_equivalence_group_id"])
        batch.create_foreign_key(
            "fk_codes_code_equivalence_group_id", "code_equivalence_groups",
            ["code_equivalence_group_id"], ["id"], ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("codes") as batch:
        batch.drop_constraint("fk_codes_code_equivalence_group_id", type_="foreignkey")
        batch.drop_index("ix_codes_code_equivalence_group_id")
        batch.drop_column("code_equivalence_group_id")
    op.drop_index("ix_code_equivalence_groups_project_id", "code_equivalence_groups")
    op.drop_table("code_equivalence_groups")
