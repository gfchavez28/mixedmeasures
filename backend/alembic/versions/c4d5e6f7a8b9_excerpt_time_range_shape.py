"""excerpt time-range shape (Observations slab 5, D29)

Adds the third excerpt shape — a sub-clip TIME range on an observation clip —
as nullable `start_time`/`end_time` (absolute timeline seconds), with:

- four new CHECKs: times both-or-neither · valid range (`end >= start`, the
  `>=` deliberately allowing point quotes per D7, unlike the char shape's
  strict `>`) · one-shape XOR (offsets and times never coexist) · times ⇒
  segment target (comment excerpts stay whole-only)
- `ix_excerpt_segment_whole` REWRITTEN to `... AND start_time IS NULL` — the
  old predicate (`start_offset IS NULL` alone) matches a time-range excerpt
  too, so the SECOND time excerpt on a clip would trip whole-segment
  uniqueness (plan §8j.0.2)
- new partial unique `ix_excerpt_segment_time_range`

The CHECK additions force `batch_alter_table(recreate='always')`. env.py holds
PRAGMA foreign_keys=OFF at the connection level — NO PRAGMA statements here
(see backend/alembic/CLAUDE.md). The partial indexes are dropped-if-present and
recreated explicitly AFTER the batch so the outcome never depends on how batch
reflection handles partial-index WHERE clauses; `schema_diff_harness.py`
compares the WHERE text against the model, which is the zero-drift gate.

Revision ID: c4d5e6f7a8b9
Revises: b7c2e4a91d03
Create Date: 2026-07-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4d5e6f7a8b9'
down_revision: Union[str, None] = 'b7c2e4a91d03'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CK_TIMES_BOTH = (
    '(start_time IS NULL AND end_time IS NULL) OR '
    '(start_time IS NOT NULL AND end_time IS NOT NULL)'
)
_CK_TIMES_RANGE = 'start_time IS NULL OR (start_time >= 0 AND end_time >= start_time)'
_CK_ONE_SHAPE = 'start_offset IS NULL OR start_time IS NULL'
_CK_TIMES_SEGMENT_ONLY = 'start_time IS NULL OR segment_id IS NOT NULL'

_WHOLE_WHERE_NEW = 'segment_id IS NOT NULL AND start_offset IS NULL AND start_time IS NULL'
_WHOLE_WHERE_OLD = 'segment_id IS NOT NULL AND start_offset IS NULL'
_RANGE_WHERE = 'segment_id IS NOT NULL AND start_offset IS NOT NULL'
_TIME_WHERE = 'segment_id IS NOT NULL AND start_time IS NOT NULL'


def upgrade() -> None:
    with op.batch_alter_table('excerpt', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('start_time', sa.Float(), nullable=True))
        batch_op.add_column(sa.Column('end_time', sa.Float(), nullable=True))
        batch_op.create_check_constraint('ck_excerpt_times_both_or_neither', _CK_TIMES_BOTH)
        batch_op.create_check_constraint('ck_excerpt_times_valid_range', _CK_TIMES_RANGE)
        batch_op.create_check_constraint('ck_excerpt_one_shape', _CK_ONE_SHAPE)
        batch_op.create_check_constraint('ck_excerpt_times_segment_only', _CK_TIMES_SEGMENT_ONLY)

    # Deterministic partial-index state regardless of batch reflection:
    op.execute('DROP INDEX IF EXISTS ix_excerpt_segment_whole')
    op.execute('DROP INDEX IF EXISTS ix_excerpt_segment_range')
    op.create_index(
        'ix_excerpt_segment_whole', 'excerpt', ['segment_id'],
        unique=True, sqlite_where=sa.text(_WHOLE_WHERE_NEW),
    )
    op.create_index(
        'ix_excerpt_segment_range', 'excerpt', ['segment_id', 'start_offset', 'end_offset'],
        unique=True, sqlite_where=sa.text(_RANGE_WHERE),
    )
    op.create_index(
        'ix_excerpt_segment_time_range', 'excerpt', ['segment_id', 'start_time', 'end_time'],
        unique=True, sqlite_where=sa.text(_TIME_WHERE),
    )


def downgrade() -> None:
    # Dev-only, like the 452a3f6c2682 precedent: with time-range rows present,
    # dropping the columns collapses them to whole-shape and the narrow whole
    # index recreate fails on the duplicates — collapse the data first.
    #
    # ALL partial indexes drop BEFORE the batch: batch reflection copies them
    # onto the recreated table, and the new whole-index predicate references
    # `start_time`, which the batch is about to drop (measured failure).
    op.execute('DROP INDEX IF EXISTS ix_excerpt_segment_time_range')
    op.execute('DROP INDEX IF EXISTS ix_excerpt_segment_whole')
    op.execute('DROP INDEX IF EXISTS ix_excerpt_segment_range')

    with op.batch_alter_table('excerpt', recreate='always') as batch_op:
        batch_op.drop_constraint('ck_excerpt_times_segment_only', type_='check')
        batch_op.drop_constraint('ck_excerpt_one_shape', type_='check')
        batch_op.drop_constraint('ck_excerpt_times_valid_range', type_='check')
        batch_op.drop_constraint('ck_excerpt_times_both_or_neither', type_='check')
        batch_op.drop_column('end_time')
        batch_op.drop_column('start_time')

    op.create_index(
        'ix_excerpt_segment_whole', 'excerpt', ['segment_id'],
        unique=True, sqlite_where=sa.text(_WHOLE_WHERE_OLD),
    )
    op.create_index(
        'ix_excerpt_segment_range', 'excerpt', ['segment_id', 'start_offset', 'end_offset'],
        unique=True, sqlite_where=sa.text(_RANGE_WHERE),
    )
