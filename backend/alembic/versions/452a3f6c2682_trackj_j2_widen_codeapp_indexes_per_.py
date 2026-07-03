"""trackj_j2_widen_codeapp_indexes_per_coder

Track J · J2-A — per-coder layers. Widen the two partial unique indexes on
`code_applications` from (target, code) to (target, code, user_id) so each coder
holds an INDEPENDENT layer over the same material (two coders can now apply the
same code to the same segment/value as separate rows). This RELAXES the old
constraint, so it is behavior-preserving under single-coder data.

Index-only change → no table recreate, no backfill. Existing rows (incl. legacy
NULL user_id) satisfy the wider index: the old narrow index already guaranteed
≤1 row per (target, code), and SQLite treats NULLs as distinct in unique indexes.
The D7 NULL→"Unattributed"-coder backfill is DEFERRED to the layer-aware-counts
slab (J2-2), where the "Unattributed" coder's semantics (IRR exclusion, roster
visibility) are designed; it is not required for this index change.

See the internal design notes (§1 J2-A, §2 J2-1a).

Revision ID: 452a3f6c2682
Revises: 24a18b3ca714
Create Date: 2026-06-22 15:47:20.026612

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '452a3f6c2682'
down_revision: Union[str, None] = '24a18b3ca714'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Index drop/create needs no table recreate on SQLite; env.py holds
    # PRAGMA foreign_keys=OFF for the whole migration regardless.
    op.drop_index("ix_code_applications_seg_code_unique", table_name="code_applications")
    op.drop_index("ix_code_applications_value_code_unique", table_name="code_applications")
    op.create_index(
        "ix_code_applications_seg_code_user_unique",
        "code_applications",
        ["segment_id", "code_id", "user_id"],
        unique=True,
        sqlite_where=sa.text("segment_id IS NOT NULL"),
    )
    op.create_index(
        "ix_code_applications_value_code_user_unique",
        "code_applications",
        ["dataset_value_id", "code_id", "user_id"],
        unique=True,
        sqlite_where=sa.text("dataset_value_id IS NOT NULL"),
    )


def downgrade() -> None:
    # Revert to the narrow (target, code) uniqueness. NOTE: if per-coder layers
    # exist (two coders' applications of the same code on one target), this revert
    # FAILS on the now-duplicate (target, code) — downgrades are dev-only and the
    # data would have to be collapsed first.
    op.drop_index("ix_code_applications_seg_code_user_unique", table_name="code_applications")
    op.drop_index("ix_code_applications_value_code_user_unique", table_name="code_applications")
    op.create_index(
        "ix_code_applications_seg_code_unique",
        "code_applications",
        ["segment_id", "code_id"],
        unique=True,
        sqlite_where=sa.text("segment_id IS NOT NULL"),
    )
    op.create_index(
        "ix_code_applications_value_code_unique",
        "code_applications",
        ["dataset_value_id", "code_id"],
        unique=True,
        sqlite_where=sa.text("dataset_value_id IS NOT NULL"),
    )
