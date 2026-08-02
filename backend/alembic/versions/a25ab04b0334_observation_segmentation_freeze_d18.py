"""observation segmentation freeze (D18)

Adds ``observations.segmentation_frozen_at`` — the unit-provenance discriminant.

NULL (what every existing row gets) = OPEN: each coder marks their own clips, so
a clip has one voter, consensus is meaningless, and the reliability question is
about the BOUNDARIES (unitizing-alpha's job).

A timestamp = FROZEN: the team agreed the clips before coding, so every coder
codes the SAME units — and consensus, reconciliation and ordinary kappa all work
through the engines that already ship, because they are per-target and do not
care whether a target is a transcript turn or a slice of video.

Purely additive and nullable, so it rides `.mmproject` export/import for free
(portability serializes by column reflection) with no further format bump — v3
already covers the Observations track. No batch_alter_table: a nullable
ADD COLUMN needs no table rebuild in SQLite, so nothing here can cascade.

Revision ID: a25ab04b0334
Revises: f1a2b3c4d5e6
Create Date: 2026-07-12 18:01:05.088326

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a25ab04b0334'
down_revision: Union[str, None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "observations",
        sa.Column("segmentation_frozen_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("observations", "segmentation_frozen_at")
