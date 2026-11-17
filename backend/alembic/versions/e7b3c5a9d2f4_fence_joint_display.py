"""The joint display's version fence — no schema change; it exists to be unknown (D164).

Revision ID: e7b3c5a9d2f4
Revises: d4e8a1c7b2f6

The release that ships the joint display stores it as a canvas node (`joint-display`) in
theme content, a column every older build already has. So an older build — 1.6.0 or
before, reinstalled over this one — would open the database, find nothing it cannot
read, and its canvas content cleaner would turn every display into a paragraph or drop
it, saving the result the first time the canvas is opened (`canvas-utils.ts`,
`ThemeEditor.tsx`). A `.mmproject` is fenced by its format version (v8); a backup by its
app version (`backup.py`); the live database is fenced only by a revision the older build
does not know: it refuses to open one (`database.py::NewerDatabaseError`, #1476). It
refuses ONLY when the newer build added a revision, so this one is added on purpose.

If the release also carries a schema change of its own, this revision is still correct —
it simply becomes one of two the older build does not know.

Both directions do nothing, on the connection they are given, inside the chain's one
transaction (`backend/alembic/the internal design notes); they import nothing from `app.`. A downgrade
below it leaves any joint display in theme content for the older build to meet — which
is what a downgrade is.
"""

revision = 'e7b3c5a9d2f4'
down_revision = 'd4e8a1c7b2f6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
