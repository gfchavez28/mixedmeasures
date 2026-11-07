"""#1463 D61 — index `code_applications` on `(code_id, user_id)`, so "has this coder a
coding here?" is a seek, not a walk over every coding.

Revision ID: 0a5c5d4ceb29
Revises: b5d1f7a3c9e2

Three questions the app asks on every page ask "who has coded here": the Dashboard's
and every project page's coder count (`coding_coverage.project_coder_counts`), the
analysis page's coder list (`project_coder_coverage`) and the roster's provenance lock
(`machine_coder.locked_coder_ids`). Each was a DISTINCT over every coding — 29 s on a
3.6-million-coding project, encrypted, against the client's 30 s abort. Asked per coder
("does a coding of this coder exist on one of these codes?") through this index, each is
one seek per (code, coder) and costs about 1 ms whatever the project holds. Neither half
works alone: without the index the per-coder form walks every coding once per coder who
has none (slower than before), and an index without the per-coder form still visits
every coding (the internal design notes, git-ignored).

## Schema only, one statement

No data changes. One `CREATE INDEX` on the connection it is given, inside the chain's one
transaction (`backend/alembic/the internal design notes), importing nothing from `app.`. Declared in
`CodeApplication.__table_args__` too, so `scripts/schema_diff_harness.py` sees no drift
and a fresh database (`create_all`) has it.

Measured cost on update: 6.1 s at 3.66M codings and 1.4 s at 1.38M, encrypted, under the
`MM-PHASE: migrating` splash; +43.5 MiB and +15.0 MiB.

## `ix_code_applications_code_id` is KEPT

The new index leads with `code_id`, so it makes the old single-column index redundant.
It stays so that this revision moves no other query's plan beyond what the build's plan
diff checked (D64); dropping it (about 40 MiB at 3.6M codings) is its own change.

## Code-first, not coder-first

An index leading with `user_id` would answer the roster lock directly, but about fifty
queries filter `code_applications.user_id` (blind mode's self-scope, the reliability and
consensus gathers, text coding), and a coder-first index invites SQLite — which has no
statistics here — to start any of them from one coder's codings across the whole
install: the #1021 class. A code-first index can only replace `ix_code_applications_code_id`
where that index was already chosen.
"""
from alembic import op


revision = '0a5c5d4ceb29'
down_revision = 'b5d1f7a3c9e2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_code_applications_code_user",
        "code_applications",
        ["code_id", "user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_code_applications_code_user", table_name="code_applications")
