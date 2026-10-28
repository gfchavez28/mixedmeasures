"""#1190 — `removal_tombstones`: what a withdrawal removed, so a merge, an import
or participant linking never brings it back.

Revision ID: a7c3e9f1d2b4
Revises: c6e2a8d41f97
"""

from alembic import op
import sqlalchemy as sa


revision = 'a7c3e9f1d2b4'
down_revision = 'c6e2a8d41f97'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'removal_tombstones',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('project_uuid', sa.String(length=36), nullable=False),
        sa.Column('entity_type', sa.String(length=32), nullable=False),
        sa.Column('entity_uuid', sa.String(length=36), nullable=True),
        sa.Column('identifier_hash', sa.String(length=64), nullable=True),
        sa.Column('reason', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index(
        'ix_removal_tombstones_project', 'removal_tombstones', ['project_uuid', 'entity_type'],
    )


def downgrade() -> None:
    op.drop_index('ix_removal_tombstones_project', table_name='removal_tombstones')
    op.drop_table('removal_tombstones')
