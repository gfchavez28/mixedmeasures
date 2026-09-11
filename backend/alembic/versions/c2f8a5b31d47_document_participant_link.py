"""Row 46 — `Document.participant_id`: put documents on the participant spine

Revision ID: c2f8a5b31d47
Revises: a9c3e7b1d5f2
Create Date: 2026-09-07

Documents were the one coded source type with no route to a `Participant`.
Conversations reach it through `Speaker.participant_id` and survey responses
through `DatasetRow.participant_id`; a document segment has no speaker, so
nothing coded on a document could be compared by the subject's attributes —
`code_analysis._build_source_group_breakdowns` says so in its own docstring
("documents have no participant spine so document sources keep groups=None").

## Why nullable, SET NULL, and deliberately NOT unique

Nullable because most documents are not *about* one identifiable subject, and
requiring a link would make the common case answer a question it does not have.

SET NULL to match the two existing links: `Participant` and `Speaker` are
project-scoped and deliberately outlive their sources, so deleting a participant
must not take the document with it.

**Not unique** — and this is the point of the row rather than an omission. The
sibling link on `dataset_rows` carries a partial unique index
(`uq_dataset_rows_dataset_participant`, one row per participant per dataset);
copying that shape here would cap a participant at ONE document and break the
motivating cases outright: several years of workplans for one person, or an
interview transcript plus the artefacts filed alongside it. Many documents, one
participant.

## SQLite

`batch_alter_table(recreate='always')` — the same reasoning as
`f1a2b3c4d5e6`'s `notes` block: a real FK constraint on SQLite needs the table
rebuilt, and `ALTER TABLE ... ADD COLUMN ... REFERENCES` would leave the
constraint unenforced and drift from `create_all()`. `documents` carries no
CHECK constraints and no partial indexes, so nothing has to be dropped before
the batch or restored after it (the partial-index trap in
`backend/alembic/the internal design notes). env.py holds `PRAGMA foreign_keys=OFF` at the
connection level, so the recreate cannot cascade into `segments` or `notes`.

## `.mmproject`

`CURRENT_FORMAT_VERSION` is deliberately NOT bumped. v6 shipped in v1.5.0 and
v1.5.1, so it is in the field and widening it is no longer free. An older build
drops the unknown column and imports the document unlinked — which is precisely
how that build already behaves, so the file degrades to that build's own status
quo rather than to something wrong. Decided with the developer 2026-09-07.
"""
from alembic import op
import sqlalchemy as sa


revision = 'c2f8a5b31d47'
down_revision = 'a9c3e7b1d5f2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('documents', recreate='always') as batch_op:
        batch_op.add_column(sa.Column('participant_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_documents_participant_id', 'participants',
            ['participant_id'], ['id'], ondelete='SET NULL',
        )
        batch_op.create_index('ix_documents_participant_id', ['participant_id'])


def downgrade() -> None:
    with op.batch_alter_table('documents', recreate='always') as batch_op:
        batch_op.drop_index('ix_documents_participant_id')
        batch_op.drop_constraint('fk_documents_participant_id', type_='foreignkey')
        batch_op.drop_column('participant_id')
