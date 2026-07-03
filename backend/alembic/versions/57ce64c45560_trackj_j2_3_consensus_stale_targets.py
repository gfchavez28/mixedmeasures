"""trackj j2-3 consensus stale targets

Revision ID: 57ce64c45560
Revises: dec055ca0e1a
Create Date: 2026-06-22 21:16:50.986809

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '57ce64c45560'
down_revision: Union[str, None] = 'dec055ca0e1a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Track J · J2-3 (Slab 5) — the consensus staleness marker table.

    One row per stale target (segment XOR dataset value). Partial unique indexes
    make marking idempotent; the CHECK enforces exactly-one-target (mirrors
    code_applications). New table → no batch needed.
    """
    op.create_table(
        "consensus_stale_targets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.Integer(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("segment_id", sa.Integer(),
                  sa.ForeignKey("segments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("dataset_value_id", sa.Integer(),
                  sa.ForeignKey("dataset_values.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            '(segment_id IS NOT NULL AND dataset_value_id IS NULL) OR '
            '(segment_id IS NULL AND dataset_value_id IS NOT NULL)',
            name="ck_consensus_stale_target_exactly_one_target",
        ),
    )
    op.create_index("ix_consensus_stale_targets_project_id",
                    "consensus_stale_targets", ["project_id"])
    op.create_index("ix_consensus_stale_target_segment_unique",
                    "consensus_stale_targets", ["segment_id"],
                    unique=True, sqlite_where=sa.text("segment_id IS NOT NULL"))
    op.create_index("ix_consensus_stale_target_value_unique",
                    "consensus_stale_targets", ["dataset_value_id"],
                    unique=True, sqlite_where=sa.text("dataset_value_id IS NOT NULL"))


def downgrade() -> None:
    op.drop_index("ix_consensus_stale_target_value_unique", "consensus_stale_targets")
    op.drop_index("ix_consensus_stale_target_segment_unique", "consensus_stale_targets")
    op.drop_index("ix_consensus_stale_targets_project_id", "consensus_stale_targets")
    op.drop_table("consensus_stale_targets")
