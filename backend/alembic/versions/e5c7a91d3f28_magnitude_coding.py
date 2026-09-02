"""#35 — magnitude coding: a declared per-code rating scale, and a per-application value

Revision ID: e5c7a91d3f28
Revises: c9e1f4a2b7d3
Create Date: 2026-09-01

A code may opt into a rating scale ("Enthusiasm / buy-in", 0–10, anchored) and each
coder may then rate each application on it. Five nullable columns, no new table.

## Why the value rides `code_applications` rather than a side table

The per-`(target, code, coder)` grain Track J hardened is exactly the grain a rating
needs: "how much" is a property of ONE coder's application, and two coders rating the
same code on the same segment already have two rows. A side table would duplicate that
key and give the two a way to disagree about which applications exist.

## Why the scale rides `codes` rather than a side table

The declaration is small, singular, and read on every code-list response. Storing it
inline mirrors `dataset_columns` (`numeric_min` / `numeric_max` / `scale_labels`),
which holds the same shape for the same purpose — the researcher meets one vocabulary
for "declare an instrument" whether they are labelling a survey variable or a code.
Inline also means `.mmproject`'s reflection-driven `_build_entity` carries all five
columns with no new export branch.

## 🔴 `code_applications.magnitude` is NULLABLE and NULL means UNRATED, never zero

There is deliberately **no server_default**. MAXQDA stamps a default weight of 0 onto
every coded segment, which makes "not rated" and "rated zero" indistinguishable — and
on a −1…+1 scale zero is a real, meaningful neutral. A default here would silently
fabricate a rating for every application that already exists.

That is also why this migration back-fills nothing: every pre-existing application is
genuinely unrated, and that is the correct value for it.

## SQLite

Plain nullable columns with no foreign keys, so `op.add_column` is sufficient —
`batch_alter_table(recreate='always')` exists for FK-bearing changes, and recreating
`code_applications` would needlessly replay the two partial per-coder unique indexes
and the consensus partial index.
"""
from alembic import op
import sqlalchemy as sa


revision = 'e5c7a91d3f28'
down_revision = 'c9e1f4a2b7d3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The declared instrument, on the code.
    op.add_column('codes', sa.Column('magnitude_min', sa.Float(), nullable=True))
    op.add_column('codes', sa.Column('magnitude_max', sa.Float(), nullable=True))
    op.add_column('codes', sa.Column('magnitude_step', sa.Float(), nullable=True))
    op.add_column('codes', sa.Column('magnitude_labels', sa.Text(), nullable=True))

    # The rating, on one coder's application. No default — see the header.
    op.add_column('code_applications', sa.Column('magnitude', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('code_applications', 'magnitude')
    op.drop_column('codes', 'magnitude_labels')
    op.drop_column('codes', 'magnitude_step')
    op.drop_column('codes', 'magnitude_max')
    op.drop_column('codes', 'magnitude_min')
