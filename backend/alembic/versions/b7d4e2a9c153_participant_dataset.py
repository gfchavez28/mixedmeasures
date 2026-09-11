"""Row 45 (i) step 3 — `Dataset.managed_kind`: a tool-maintained participant dataset

Revision ID: b7d4e2a9c153
Revises: c2f8a5b31d47
Create Date: 2026-09-08

Row 45 turns a participant's code ratings into one number per person per rated
code. For that number to get identical treatment in pickers, comparisons, charts
and the R export it has to BE a `DatasetColumn` — `routers/metrics.py:716` builds
the analysis picker from `DatasetColumn` joined to `Dataset`, so the alternative
is teaching every consumer a second source of columns. But a column lives in a
dataset and its cells live on `DatasetRow`s, and MEASURED on the Ferncrest corpus
only **5 of 23** coded participants hold a dataset row anywhere. So the score
needs a dataset whose rows ARE the project's participants.

## What `managed_kind` encodes

NULL = an ordinary dataset the researcher imported. A value names the KIND of
spine the table projects; today only `"participants"`.

The decision it carries (developer, 2026-09-08) is **"locked spine, open
columns"**: the ROWS are the tool's — they are DERIVED from `Participant`, so
deleting a record, appending a file, re-linking a row and deleting the dataset
are refused — while the COLUMNS are the researcher's, who may add variables,
edit their own cells, rename and export freely. Chosen over a fully-locked table
(which kills the generalisation to `Participant.role` and other hand-entered case
attributes, the shape NVivo validates) and over no lock at all (where a deleted
record silently reappears). **The refusal set follows from one property rather
than a list**, which is what stops the next affordance needing a new decision.

## Why an INDEX rather than a service check

`uq_datasets_project_managed_kind` is partial (`managed_kind IS NOT NULL`), so
ordinary datasets are untouched, and it makes "at most one participant dataset
per project" structural rather than something a service has to remember. Same
shape and same reasoning as `uq_dataset_rows_dataset_participant`, which already
guarantees one row per participant per dataset — the other half of the spine.

## SQLite

`batch_alter_table(recreate='always')`: the column itself would be fine as a
plain `ADD COLUMN`, but the partial unique index must exist on the table the
models declare or `scripts/schema_diff_harness.py` reports drift. `datasets`
carries no CHECK constraints and no pre-existing partial indexes, so nothing has
to be dropped before the batch (the partial-index trap in
`backend/alembic/the internal design notes). The index is created explicitly AFTER the batch so
its `WHERE` text is deterministic rather than whatever reflection copied.

env.py holds `PRAGMA foreign_keys=OFF` at the connection level, so the recreate
cannot cascade into `dataset_rows` / `dataset_columns`.

## `.mmproject`

`CURRENT_FORMAT_VERSION` deliberately NOT bumped, on the row-46 precedent
(2026-09-07). v6 shipped in v1.5.0 and v1.5.1, so widening is no longer free —
and an older build drops the unknown column and imports an ORDINARY dataset
holding exactly the same rows and cells. That is that build's own status quo, not
something wrong; re-importing into a newer build restores the marker, and the
row sync is the repair for anything the older build did to the row set meanwhile.
"""
from alembic import op
import sqlalchemy as sa


revision = 'b7d4e2a9c153'
down_revision = 'c2f8a5b31d47'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('datasets', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('managed_kind', sa.String(length=32), nullable=True))
    op.execute('DROP INDEX IF EXISTS uq_datasets_project_managed_kind')
    op.create_index(
        'uq_datasets_project_managed_kind', 'datasets',
        ['project_id', 'managed_kind'], unique=True,
        sqlite_where=sa.text('managed_kind IS NOT NULL'),
    )


def downgrade() -> None:
    op.execute('DROP INDEX IF EXISTS uq_datasets_project_managed_kind')
    with op.batch_alter_table('datasets', recreate='always') as batch_op:
        batch_op.drop_column('managed_kind')
