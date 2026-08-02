"""observations table + observation_id third Segment/Note parent

Observations track, slab 1. Adds the `observations` table (a recording coded on
its own timeline, no transcript) as the THIRD `Segment` parent, and a
`Note.observation_id` parent so notes can attach to observation segments.

- new table `observations` (media block mirrors conversations)
- `segments.observation_id` FK + widened `ck_segment_exactly_one_parent`
  (exactly one of conversation_id/document_id/observation_id) + two indexes
- `notes.observation_id` FK + widened `ck_note_at_least_one_parent`

The CHECK redefinitions force `batch_alter_table(recreate='always')`. env.py
holds PRAGMA foreign_keys=OFF at the connection level, so recreating `segments`
/`notes` does not cascade-delete their children — NO PRAGMA statements here
(they are a no-op inside Alembic's transaction). See backend/alembic/CLAUDE.md.

Revision ID: f1a2b3c4d5e6
Revises: b3f1d9a7c2e5
Create Date: 2026-07-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, None] = 'b3f1d9a7c2e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SEG_CHECK_3WAY = (
    '(conversation_id IS NOT NULL AND document_id IS NULL AND observation_id IS NULL) OR '
    '(conversation_id IS NULL AND document_id IS NOT NULL AND observation_id IS NULL) OR '
    '(conversation_id IS NULL AND document_id IS NULL AND observation_id IS NOT NULL)'
)
_SEG_CHECK_2WAY = (
    '(conversation_id IS NOT NULL AND document_id IS NULL) OR '
    '(conversation_id IS NULL AND document_id IS NOT NULL)'
)
_NOTE_CHECK_4WAY = (
    'conversation_id IS NOT NULL OR dataset_value_id IS NOT NULL OR '
    'document_id IS NOT NULL OR observation_id IS NOT NULL'
)
_NOTE_CHECK_3WAY = (
    'conversation_id IS NOT NULL OR dataset_value_id IS NOT NULL OR document_id IS NOT NULL'
)


def upgrade() -> None:
    # ── new table: observations ───────────────────────────────────────────────
    op.create_table(
        'observations',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('uuid', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.Column('media_filename', sa.String(length=500), nullable=True),
        sa.Column('media_format', sa.String(length=10), nullable=True),
        sa.Column('media_type', sa.String(length=10), nullable=True),
        sa.Column('media_duration_seconds', sa.Float(), nullable=True),
        sa.Column('media_offset_seconds', sa.Float(), nullable=False),
        sa.Column('media_is_vbr', sa.Boolean(), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_observations_project_id', 'observations', ['project_id'])
    op.create_index('ix_observations_uuid', 'observations', ['uuid'], unique=True)

    # ── segments: third parent + widened CHECK + indexes ──────────────────────
    with op.batch_alter_table('segments', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('observation_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_segments_observation_id', 'observations',
            ['observation_id'], ['id'], ondelete='CASCADE',
        )
        batch_op.drop_constraint('ck_segment_exactly_one_parent', type_='check')
        batch_op.create_check_constraint('ck_segment_exactly_one_parent', _SEG_CHECK_3WAY)
        batch_op.create_index('ix_segments_observation_id', ['observation_id'])
        batch_op.create_index('ix_segments_observation_sequence', ['observation_id', 'sequence_order'])
        batch_op.create_index('ix_segments_observation_time', ['observation_id', 'start_time'])

    # ── notes: third-of-many parent + widened at-least-one CHECK ──────────────
    with op.batch_alter_table('notes', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('observation_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_notes_observation_id', 'observations',
            ['observation_id'], ['id'], ondelete='CASCADE',
        )
        batch_op.drop_constraint('ck_note_at_least_one_parent', type_='check')
        batch_op.create_check_constraint('ck_note_at_least_one_parent', _NOTE_CHECK_4WAY)
        batch_op.create_index('ix_notes_observation_id', ['observation_id'])


def downgrade() -> None:
    with op.batch_alter_table('notes', recreate='always') as batch_op:
        batch_op.drop_index('ix_notes_observation_id')
        batch_op.drop_constraint('ck_note_at_least_one_parent', type_='check')
        batch_op.create_check_constraint('ck_note_at_least_one_parent', _NOTE_CHECK_3WAY)
        batch_op.drop_constraint('fk_notes_observation_id', type_='foreignkey')
        batch_op.drop_column('observation_id')

    with op.batch_alter_table('segments', recreate='always') as batch_op:
        batch_op.drop_index('ix_segments_observation_time')
        batch_op.drop_index('ix_segments_observation_sequence')
        batch_op.drop_index('ix_segments_observation_id')
        batch_op.drop_constraint('ck_segment_exactly_one_parent', type_='check')
        batch_op.create_check_constraint('ck_segment_exactly_one_parent', _SEG_CHECK_2WAY)
        batch_op.drop_constraint('fk_segments_observation_id', type_='foreignkey')
        batch_op.drop_column('observation_id')

    op.drop_index('ix_observations_uuid', table_name='observations')
    op.drop_index('ix_observations_project_id', table_name='observations')
    op.drop_table('observations')
