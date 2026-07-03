"""trackj j2 5 consensus origin index

Track J · J2-5 (M-1/M-3). The `code_applications.origin` column leads every
consensus query (the materializer's project DELETE, `consensus_exists_for_project`,
`non_consensus_filter` scans, the staleness sweep) yet was unindexed. Add a partial
index covering only the consensus rows — small (consensus is a minority of rows),
and it serves the equality predicate `origin='consensus'` those queries use.

Additive index-only change → plain create_index, no table recreate, no backfill
(env.py holds PRAGMA foreign_keys=OFF for the whole migration regardless). NOT
unique — many consensus rows share `origin='consensus'`. Mirrors the partial-index
idiom of the per-coder unique indexes on the same table.

Revision ID: fa4d77977779
Revises: 57ce64c45560
Create Date: 2026-06-23 16:30:56.943358

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fa4d77977779'
down_revision: Union[str, None] = '57ce64c45560'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_code_applications_consensus",
        "code_applications",
        ["origin"],
        unique=False,
        sqlite_where=sa.text("origin='consensus'"),
    )


def downgrade() -> None:
    op.drop_index("ix_code_applications_consensus", table_name="code_applications")
