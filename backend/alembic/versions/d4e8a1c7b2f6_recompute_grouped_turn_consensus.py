"""#1597 — queue a consensus recompute for every turn of a segment group that two or
more people coded, so the saved consensus layer takes 1.6.0's rule.

Revision ID: d4e8a1c7b2f6
Revises: 0a5c5d4ceb29

1.6.0 decides a segment group's consensus ONCE, over all its turns (#1334 unit 3, D30–D34);
1.5.8 decided each turn of a group on its own. Nothing recomputes the saved layer by
itself: the background sweep and *Recompute consensus* drain only the markers in
`consensus_stale_targets`, and the update queued none. So after updating, a group whose
coders' codings sat on different turns kept 1.5.8's per-turn consensus — often none at
all — on every Analysis tab that reads the saved layer, while the Reconciliation grid,
which derives consensus live, showed the new decision, and *Recompute consensus* said
it was up to date. This queues those turns; the sweep then recomputes each group once
(`consensus_staleness.sweep_stale_consensus`), as it does after any grouping change.

## Data only, one statement

No schema change. One `INSERT … SELECT … WHERE NOT EXISTS` on the connection it is
given, inside the chain's one transaction (`backend/alembic/the internal design notes), importing
nothing from `app.`. Its cost does not grow in statements with the data
(`tests/test_migration_scaling.py` holds grouped, two-coder turns in its fixture).

## Which turns — a superset of the groups whose consensus can change

Every turn (visible or not) of a group whose turns carry codings from two or more
distinct coders (`COUNT(DISTINCT user_id)`, which leaves an unattributed coding out). A
group with fewer cannot reach consensus under either rule — 1.5.8's per-turn rule needed
two voters on one turn, which is two coders on the group — so its saved layer is the same
under both and needs nothing. The frozen predicate OVER-queues, as the app's recompute
then sorts out: it counts archived and machine coders, whom the recompute does not let
vote; it counts the consensus coder, so a group left with one coder and a consensus row
(a state the sweep normally clears) is recomputed and the row cleared; and it marks a
hidden member, whose marker reaches its group through the turn's own `group_id`. A
recompute that changes nothing writes the same rows back.

It deliberately does NOT mark a single-coder install's groups. Draining a marker creates
the global consensus coder if it is absent (`auth.get_or_create_consensus_user`), and a
lone researcher's install has no use for one. (Counting the consensus coder cannot bring
that about: a consensus row means the coder already exists.)

`consensus_eligible_segment_clause` (the app's rule) is not re-inlined: a segment group
is conversation-scoped, so every member is a transcript turn, which is always eligible.

## Restores and imports

A `.mmbackup` from before 1.6.0 is brought to head by this chain on restore
(`database.upgrade_database_file`), so it is queued too. A `.mmproject` import rebuilds
the layer whole (`materialize_consensus_for_project`) and needs nothing.

## Downgrade queues the same turns

After a downgrade the older app decides a group's turns one by one again, and a layer
the new rule wrote is out of date in that direction too. The older sweep drains the
markers with its own rule.
"""
from alembic import op
import sqlalchemy as sa


revision = 'd4e8a1c7b2f6'
down_revision = '0a5c5d4ceb29'
branch_labels = None
depends_on = None


_QUEUE_GROUPED_TURNS = sa.text("""
    INSERT INTO consensus_stale_targets (project_id, segment_id, created_at)
    SELECT c.project_id, s.id, CURRENT_TIMESTAMP
    FROM segments AS s
    JOIN conversations AS c ON c.id = s.conversation_id
    WHERE s.group_id IN (
        SELECT m.group_id
        FROM segments AS m
        JOIN code_applications AS ca ON ca.segment_id = m.id
        WHERE m.group_id IS NOT NULL
        GROUP BY m.group_id
        HAVING COUNT(DISTINCT ca.user_id) >= 2
    )
    AND NOT EXISTS (
        SELECT 1 FROM consensus_stale_targets AS t WHERE t.segment_id = s.id
    )
""")


def upgrade() -> None:
    op.get_bind().execute(_QUEUE_GROUPED_TURNS)


def downgrade() -> None:
    op.get_bind().execute(_QUEUE_GROUPED_TURNS)
