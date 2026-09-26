"""Queue row 48 — `CodeSet` + `Code.code_set_id`: a mutually exclusive group of codes

Revision ID: e4a9c7b21f68
Revises: d3f8b6e2a915
Create Date: 2026-09-21

MM's coding grain is the grounded-theory one: per code, independently,
presence/absence. Content analysis asks a different question — *which ONE of
these values does this unit take?* — and the difference is not cosmetic. A stance
variable with four values reports, today, four binary Krippendorff's α figures
plus a pooled figure across stacked binary indicators, and that pooled figure is
not a statistic the content-analysis literature names. The single number a
methods reviewer asks for — *how much did the coders agree about stance?* — is
not computed at all.

`_krippendorff_alpha` already accepts multi-valued nominal input, so the
arithmetic needs nothing. What was missing is the data model that produces a
multi-valued row and the interface that enforces one-and-only-one.

## Shape

A new entity plus a single nullable FK on `codes`, mirroring `category_id` and
`code_equivalence_group_id` — a code belongs to at most one set, because two sets
claiming one code makes "which value did this unit take?" ambiguous.

`exhaustive` carries a decision rather than a preference, and it changes the
DENOMINATOR: with it set, a unit where the coder chose no member is MISSING
data; without it, that blank is the real value "none of these". `server_default`
is `'0'` so rows created by a build that predates the ORM default are `False`
rather than NULL — the safe direction, since `True` would silently reclassify
every uncoded unit as missing.

## SQLite

`batch_alter_table(recreate='always')` on `codes`: an `ADD COLUMN` with a REFERENCES
clause is legal in SQLite only with a NULL default, which is what we have, but the
FK would then be invisible to `PRAGMA foreign_key_list` on some older builds and
`scripts/schema_diff_harness.py` compares against what the models declare. The
recreate makes the outcome deterministic.

⚠️ `codes` carries a partial-index-free `__table_args__` (one plain unique index,
`ix_codes_project_numeric`), so nothing has to be dropped before the batch — the
partial-index trap in `backend/alembic/the internal design notes does not bite here. env.py holds
`PRAGMA foreign_keys=OFF` at the connection level, so the recreate cannot cascade
into `code_applications`.

## `.mmproject`

`CURRENT_FORMAT_VERSION` stays **7**, WIDENED rather than bumped, and the window
is real rather than assumed: v7 was minted 2026-09-21 by #958 and **has not
shipped in any release** (v1.5.3, the current `latest`, carries v6). A structural
change smuggled into a SHIPPED version is half-understood rather than refused —
that is the v6 mistake this project made once — so widening is available only
while the boundary is unreleased, and row 48's own entry says it should ride this
one rather than open a second.

It qualifies on its own merits as a refusal gate either way: `_build_entity`
keeps only columns the model declares, so an older build drops `code_set_id`
silently, and a set whose membership vanished is not a degraded set — it is N
loose codes and a reliability figure that no longer exists.
"""
from alembic import op
import sqlalchemy as sa


revision = 'e4a9c7b21f68'
down_revision = 'd3f8b6e2a915'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'code_sets',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('uuid', sa.String(length=36), nullable=True),
        sa.Column('label', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('exhaustive', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('sequence_order', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_code_sets_project_id', 'code_sets', ['project_id'])
    op.create_index('ix_code_sets_uuid', 'code_sets', ['uuid'], unique=True)

    with op.batch_alter_table('codes', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('code_set_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_codes_code_set_id', 'code_sets', ['code_set_id'], ['id'],
            ondelete='SET NULL',
        )
    op.create_index('ix_codes_code_set_id', 'codes', ['code_set_id'])


def downgrade() -> None:
    op.execute('DROP INDEX IF EXISTS ix_codes_code_set_id')
    with op.batch_alter_table('codes', recreate='always') as batch_op:
        batch_op.drop_column('code_set_id')
    op.execute('DROP INDEX IF EXISTS ix_code_sets_uuid')
    op.execute('DROP INDEX IF EXISTS ix_code_sets_project_id')
    op.drop_table('code_sets')
