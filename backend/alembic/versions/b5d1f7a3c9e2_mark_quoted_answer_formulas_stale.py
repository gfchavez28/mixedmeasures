"""#1368 D4 — mark out of date every computed column whose formula compares a column
with a quoted text (`[col] == "…"`, `[col] != "…"`, either side).

Revision ID: b5d1f7a3c9e2
Revises: a7c3e9f1d2b4

From this release the formula evaluator reads `[q1] == "Agree"` as "this cell's ANSWER
is Agree". Before, it compared the quoted text with the spelling of the cell's NUMBER —
and on a labelled column that number is the CODE (the label sits in `value_text`), so
the comparison was FALSE on every row, silently. A column computed before this revision
still holds those values: they reach the Data view, the charts, every metric over the
column and the R export. Nothing recomputes a computed column by itself, so this marks
it out of date (`dataset_columns.stale`): the Data view says so and offers Recompute,
and the R export names it in its Notes (#1322). The `.mmproject` import makes the same
mark for a file written by an earlier version
(`project_portability._mark_quoted_answer_columns_stale`).

## Data only

No schema change, and no value is recomputed here — recomputing is the evaluator's job,
on the researcher's click, and it marks what reads the column at that moment
(`recompute_column` → `mark_metrics_stale`). It is one SELECT and one UPDATE on the
connection it is given, inside the chain's one transaction (`backend/alembic/the internal design notes).

## How the shape is found, and why not with the app's parser

No revision in this chain imports `app.`, and this one must not start: a revision is
history and has to do the same thing on every database it ever meets, while
`services/computed_columns.py` is free to change — a renamed parser would make the chain
unrunnable for every install still below this revision, and a changed grammar would
change what an old upgrade marks. So the test is a frozen TEXTUAL one, and it is a
SUPERSET of the evaluator's shape by construction:

- the tokenizer skips only whitespace between tokens (`\\s+`); a column reference is
  `[…]` and a quoted text is `"…"` (no escapes); parentheses only group;
- so a comparison whose one operand IS a column reference and whose other IS a quoted
  text — the only shape the evaluator reads differently (`_quoted_answer`) — always
  appears in the text as `]`, then spaces and `)`, then `==` or `!=`, then spaces and
  `(`, then `"`; or mirrored. The pattern below looks for exactly that, anywhere.

It OVER-marks, as D4 accepts: `[a] + [b] == "x"` and `-[a] == "x"` (a sum or a negation
is compared the old way still), a text column (whose values do not move), and text
inside a quoted literal or a column name that happens to look like the shape. Each such
column reads "out of date" until Recompute, which then changes nothing.
`tests/test_quoted_answer_stale.py` holds the pattern to the app's own detector
(`computed_columns.compares_a_quoted_answer`) over a generated corpus: every formula the
app says has the shape, this revision marks.

## Downgrade marks the same columns

A stale flag says the stored values may not be what the formula now means. After a
downgrade the older evaluator reads the shape the OLD way, and a column recomputed
under this revision holds the NEW way's values — out of date in that direction too.
Un-marking is not possible in any case: this revision records nothing about which
columns it marked, and a column already stale must stay stale.
"""
import re

from alembic import op
import sqlalchemy as sa


revision = 'b5d1f7a3c9e2'
down_revision = 'a7c3e9f1d2b4'
branch_labels = None
depends_on = None


_QUOTED_TEXT_COMPARISON = re.compile(
    r'\][\s)]*(?:==|!=)[\s(]*"'     # [col] == "text"
    r'|"[\s)]*(?:==|!=)[\s(]*\['    # "text" == [col]
)


def _compares_a_quoted_text(expression: str | None) -> bool:
    return bool(expression) and _QUOTED_TEXT_COMPARISON.search(expression) is not None


def _mark_stale() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT id, expression FROM dataset_columns "
        "WHERE source = 'computed' AND expression IS NOT NULL"
    )).fetchall()
    ids = [col_id for col_id, expression in rows if _compares_a_quoted_text(expression)]
    if ids:
        conn.execute(
            sa.text("UPDATE dataset_columns SET stale = 1 WHERE id = :id"),
            [{"id": col_id} for col_id in ids],
        )


def upgrade() -> None:
    _mark_stale()


def downgrade() -> None:
    _mark_stale()
