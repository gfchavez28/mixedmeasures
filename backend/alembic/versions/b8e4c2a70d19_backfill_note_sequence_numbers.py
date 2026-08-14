"""#747 — backfill note sequence numbers for the three parents that stored 0

Revision ID: b8e4c2a70d19
Revises: a1b2c3d4e5f7
Create Date: 2026-08-11

Only `POST /conversations/{id}/notes` ever computed a number. Notes on a
document, an observation clip or a dataset value were written with the literal
`sequence_number = 0`, which `models/note.py` had promoted to a convention. Every
such note therefore shares one label: the Excel export writes `N-0` for all of
them, and the Memos & Notes page renders the same document note as "3" in its
workbench (which renumbered positionally on read) and "N-0" there.

The writers are fixed as of this release; this numbers what they already wrote.

## Scope: non-conversation parents only

`WHERE conversation_id IS NULL` — conversation notes already hold real numbers,
and those are the ones a researcher may have cited. Renumbering them would be the
harm this migration exists to prevent, so they are not touched even though the
new numbering rule would mostly reproduce them.

## Ordering: by `id` within each parent

That is exactly what the document read path displayed before this release
(`sequence_number=idx + 1` over notes sorted by `id`), so document notes keep the
labels their users have been seeing. For observations and dataset values there
was no visible label to preserve, and `id` order is creation order.

## Partitioning

Each note has exactly one parent set, so partitioning by all three columns at once
groups by "the parent this note hangs off" without needing a CASE: two document
notes share `(document_id=7, NULL, NULL)`, and a note on another parent can never
land in that group. SQLite treats NULLs as equal for PARTITION BY, which is what
makes this work.

## Downgrade

Restores the literal 0 for the same rows — the value the pre-fix writers stored.
It is not a byte-for-byte inverse of anything (there is nothing to restore *to*),
but it lands the data in exactly the state the older build expects to find.
"""
from alembic import op


revision = 'b8e4c2a70d19'
down_revision = 'a1b2c3d4e5f7'
branch_labels = None
depends_on = None


# Numbered from 1 per parent, in id order. Kept as one statement so a large
# project is one pass rather than a query per parent.
_BACKFILL = """
UPDATE notes
   SET sequence_number = (
       SELECT rn FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                      PARTITION BY document_id, observation_id, dataset_value_id
                      ORDER BY id
                  ) AS rn
             FROM notes
            WHERE conversation_id IS NULL
       ) AS numbered
        WHERE numbered.id = notes.id
   )
 WHERE conversation_id IS NULL
"""


def upgrade():
    op.execute(_BACKFILL)


def downgrade():
    op.execute("UPDATE notes SET sequence_number = 0 WHERE conversation_id IS NULL")
