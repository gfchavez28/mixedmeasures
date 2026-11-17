"""#1617 / #1623 (D222, D224) — the participant table records WHOSE ratings its snapshot
holds, and rated codings get a partial index for the live rule a table without that
record falls back to.

Revision ID: f2a6c8d4b1e7
Revises: e7b3c5a9d2f4

## `datasets.managed_rater_ids` (D222, D223)

While blind, a reader is kept from the participant table's rating columns when some
coder whose ratings the table holds is outside their scope. The rule asked who holds a
rating NOW, but the cells are a snapshot taken at the last refresh, so a colleague whose
every rating went after it was shown again, readable from the score (#1623). The refresh
now writes the set its rollup read; this column holds it. NULL — every existing table,
until its first refresh by this build — means "no record", and the live rule answers.
No backfill: the set can only come from a refresh, which is the app's code.

## `ix_code_applications_rated` on `code_applications (code_id, user_id, magnitude) WHERE
magnitude IS NOT NULL` (D224, its key amended by D226)

The live rule asks, per coder, whether a rating exists on a code of the project. Without
this index SQLite walks the project's codes in id order and, for each, every one of the
coder's applications of it until a rated one: 25.7–27.6 s on an encrypted copy of a
4.9-million-coding project (#1617, measured; the Data view's request aborts at 30 s).
With it, a coder's unrated codings are not in the walk: 0.6–3.4 ms. Built in 1.04 s
there (59,658 rated of 4,863,794). Code-first, as `ix_code_applications_code_user`
(`0a5c5d4ceb29`) is and for its reason: `(user_id, code_id)` was measured to plan from
the coder, across every project on the install. The four other reads whose WHERE
implies the predicate were timed with and without it; none moved.

`magnitude` is the third key column (D226): on `(code_id, user_id)` alone this index and
`ix_code_applications_code_user` cost the same to SQLite, which has no statistics here,
so the one created last won. This chain creates it last, but `create_all` does not keep
an order, and a later batch recreate of the table would not either. As a key column the
query's `magnitude IS NOT NULL` is a range on it, so it is chosen in either order.

## Schema only

No data changes. Both directions work on the connection they are given, inside the
chain's one transaction (`backend/alembic/the internal design notes), and import nothing from `app.`.
Both objects are declared on the models too (`Dataset.managed_rater_ids`,
`CodeApplication.__table_args__`), so `scripts/schema_diff_harness.py` sees no drift and
a fresh database (`create_all`) has them; the index predicate's text must normalise like
the model's.
"""
from alembic import op
import sqlalchemy as sa


revision = 'f2a6c8d4b1e7'
down_revision = 'e7b3c5a9d2f4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('datasets') as batch_op:
        batch_op.add_column(sa.Column('managed_rater_ids', sa.Text(), nullable=True))
    op.create_index(
        "ix_code_applications_rated",
        "code_applications",
        ["code_id", "user_id", "magnitude"],
        unique=False,
        sqlite_where=sa.text("magnitude IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_code_applications_rated", table_name="code_applications")
    with op.batch_alter_table('datasets') as batch_op:
        batch_op.drop_column('managed_rater_ids')
