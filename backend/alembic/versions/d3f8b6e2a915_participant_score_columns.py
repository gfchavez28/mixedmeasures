"""Row 45 (i) step 4 — the score column, its provenance, and an HONEST freshness claim

Revision ID: d3f8b6e2a915
Revises: b7d4e2a9c153
Create Date: 2026-09-08

Step 3 built the table whose rows are the project's participants. Step 4 puts the
rating scores INTO it as ordinary `DatasetColumn`s, at which point the pickers,
comparisons, charts and the R export light up with no consumer change. Three
columns are needed for that, and the interesting one is the freshness pair.

## `dataset_columns.managed_spec` — which code does this column score?

A score column is not derivable from its name (a rename must not orphan it), so
the column records what it is: JSON, `{"kind": ..., "code_id": N, "basis": ...}`.
`kind` distinguishes the SCORE from its `n` — **two columns per rated code**,
because a `DatasetValue` holds one number and #693's rule is that *the n is the
dangerous half*: a mean of 3.64 over one passage and over eight are the same
number and not the same evidence. Putting the n in a second variable makes it
analysable (filter to participants with >= 3 rated passages) instead of prose.

`basis` is the stated-basis family's field, carried per column so a future
variant (a median at step 2, a rating-weighted mean) is a NEW value rather than a
silent change of meaning under an unchanged heading.

## `datasets.managed_synced_at` + `managed_stale` — and why BOTH

The decision (developer, 2026-09-08) was a SNAPSHOT with a stale marker, on the
computed-column model. Building only the marker would have been wrong, and the
reason is a measurement rather than a preference: **a score moves when any of
eight input classes changes**, and only one of them is a rating write —

    a rating * a code application appearing or disappearing * a code's declared
    scale * code equivalence grouping * any of THREE participant-link FKs *
    `Speaker.is_facilitator` * a segment merge or split * ARCHIVING A CODER
    (`gather_target_votes` filters `User.archived == False`, so archiving
    someone in Settings silently removes their votes from every score)

No enumeration of write sites reliably covers that, and `mark_metrics_stale`
cannot help — it keys on `expression` / `depends_on_column_ids`, which a score
column has neither of. `CodeApplication` also carries `created_at` and no
`updated_at`, so a timestamp watermark cannot see a re-rating.

So the two fields divide the work by what each can HONESTLY claim:

  * `managed_synced_at` is the truth and is always shown — *"computed 3 days
    ago"*. It cannot be wrong.
  * `managed_stale` is a POSITIVE signal only: *we know something changed*. Its
    ABSENCE never claims freshness.

That asymmetry is the whole design. A missed trigger degrades to "the timestamp
is old", never to "we told you this was current" — which is the failure mode this
codebase keeps rediscovering and the one the snapshot decision exists to avoid.

## SQLite

Both are plain `ADD COLUMN`s with no index or constraint changes, so
`batch_alter_table` is used without `recreate='always'`: neither table gains a
partial index or a CHECK here, and a recreate would be cost with no benefit (the
partial-index trap in `backend/alembic/the internal design notes applies to recreates only).
`datasets` already carries `uq_datasets_project_managed_kind` from `b7d4e2a9c153`
and it is deliberately left untouched.

## `.mmproject`

`CURRENT_FORMAT_VERSION` NOT bumped, on the same reasoning as `b7d4e2a9c153` and
row 46. An older build drops these three columns and imports an ordinary dataset
holding the scores as ordinary numbers — a frozen but readable snapshot, which is
that build's own status quo. Re-importing into a newer build restores the
provenance, and a refresh is the repair. Nothing is silently WRONG in the older
build: the numbers it shows were true when they were computed, which is exactly
what the snapshot model already promises.
"""
from alembic import op
import sqlalchemy as sa


revision = 'd3f8b6e2a915'
down_revision = 'b7d4e2a9c153'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('datasets') as batch_op:
        batch_op.add_column(sa.Column('managed_synced_at', sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column(
            'managed_stale', sa.Boolean(), nullable=True, server_default='0',
        ))
    with op.batch_alter_table('dataset_columns') as batch_op:
        batch_op.add_column(sa.Column('managed_spec', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('dataset_columns') as batch_op:
        batch_op.drop_column('managed_spec')
    with op.batch_alter_table('datasets') as batch_op:
        batch_op.drop_column('managed_stale')
        batch_op.drop_column('managed_synced_at')
