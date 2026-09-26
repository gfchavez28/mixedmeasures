"""Queue row 49 — `users.machine_provenance`: which model, reached how, at what settings

Revision ID: f5b2d8c47e13
Revises: e4a9c7b21f68
Create Date: 2026-09-22

#989 gave a machine coder a LAYER — on the roster, attributed, filterable, never
selectable, never in a reliability aggregate. It did not give it an IDENTITY:
"GPT-4o" named a coder and recorded nothing about which GPT-4o, reached which
way, under what prompt or at what temperature.

That is the gap row 49 exists to close, and it is measured rather than assumed: a
2026 scoping review of LLM use in qualitative research found **75% of studies
report no model parameter settings at all** and **45% do not say whether the
model was reached by API, web or local deployment**, with human-vs-LLM agreement
spanning 36%–99% precisely because the configuration varies unrecorded (Kempny et
al., *BMC Med Res Methodol*). Under STRATEGY's five-question purpose statement
this is **question 3 — provenance** — asked of a non-human interpreter, and it is
the one thing every camp in the GenAI-QDA debate agrees a tool should record.

## Shape

ONE nullable `Text` column holding JSON, not four typed ones. Decoding parameters
differ by vendor (`temperature`/`top_p`/`top_k`/`seed`/`num_predict`/…), so a
fixed column set would be wrong for the next model family, and this record has to
outlive them. The canonical shape — `{model, access?, prompt?, parameters?}` — and
every refusal live in `services/machine_coder.py`; nothing else reads or writes
the column.

⚠️ **NULL is the honest default and stays legal forever.** A machine coder whose
configuration the researcher has not recorded is the state every other tool is
permanently in; refusing to create one until the prompt is to hand would make the
import unusable at the moment it is most useful.

## No format-version bump, and the test is the DESCRIPTIVE/CONSTITUTIVE one

`.mmproject` `CURRENT_FORMAT_VERSION` stays **7**, and this is deliberately NOT
even a widening. Coders are exported by REFLECTION (`_serialize_all(coders,
cols[User])`), so the column travels on export and `_build_entity` carries it on
import with no code change.

What an OLDER build does with a v7 file is the question a bump answers. It drops
the unknown column and imports a machine coder whose configuration is unrecorded
— i.e. exactly this build's own state before today, recoverable by re-importing
into a newer build. Nothing computes differently and no number changes. That is
v5's descriptive case, not v6's constitutive one (where a band list vanishing
NULLs every banded cell), so it does not earn a refusal gate.

## SQLite

A plain `ADD COLUMN` with a NULL default — no constraint, no index, no
`batch_alter_table`. `users` carries no partial index, so the partial-index trap
in `backend/alembic/the internal design notes does not arise.
"""
from alembic import op
import sqlalchemy as sa


revision = 'f5b2d8c47e13'
down_revision = 'e4a9c7b21f68'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('machine_provenance', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('users') as batch_op:
        batch_op.drop_column('machine_provenance')
