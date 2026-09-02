"""#35 — the merge disagreement flag: the rating a merged copy carried, kept beside ours

Revision ID: a9c3e7b1d5f2
Revises: e5c7a91d3f28
Create Date: 2026-09-01

When a merge matches a code application (same target, code and coder) in a
colleague's copy of the project and that copy carries a DIFFERENT rating, the
target's rating is KEPT and the incoming value is recorded in this column, so the
reconciliation grid can say "your other copy rated this 5" and the coder can
adjudicate. Decided by the developer 2026-09-01: keep the target's value, flag the
disagreement, never block the merge.

## Why a column and not a bit inside `origin_context`

`origin_context` is the consensus rule's home (and D15's provenance reserve) —
putting a merge fact inside it would make one field carry two provenances, and a
bit alone would tell the coder there WAS a disagreement and nothing about what it
was, which is the one piece of information the merge is the last place to have
seen. The differing value is the flag.

## NULL semantics

NULL = no unresolved conflict. Cleared when the coder re-rates (or unrates) the
application — that act is the adjudication. No default, no back-fill: every
pre-existing application has no unresolved merge, and that is the correct value.

## SQLite

A plain nullable column with no foreign key, so `op.add_column` suffices — the
same reasoning as `e5c7a91d3f28`: recreating `code_applications` would needlessly
replay its two partial per-coder unique indexes and the consensus partial index.
"""
from alembic import op
import sqlalchemy as sa


revision = 'a9c3e7b1d5f2'
down_revision = 'e5c7a91d3f28'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('code_applications', sa.Column('magnitude_conflict', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('code_applications', 'magnitude_conflict')
