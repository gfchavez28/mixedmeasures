"""trackj d7 backfill unattributed coder for null-user code applications

Revision ID: 80630564072b
Revises: 452a3f6c2682
Create Date: 2026-06-22 19:51:45.329931

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '80630564072b'
down_revision: Union[str, None] = '452a3f6c2682'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Re-home legacy NULL-user code applications onto a global 'Unattributed'
    coder so every per-coder query stays uniform (Track J · D7).

    A `CodeApplication` is supposed to record its coder (`user_id`), but rows
    predating coder identity (Track J · J1) have `user_id IS NULL`. After this
    backfill every application has a real coder, so the widened
    (target, code, user_id) index has no NULL-ambiguity and group-by-coder / IRR
    queries need no NULL special-case. The Unattributed coder is a SYSTEM coder
    (`coder_type='unattributed'`) — hidden from the roster/switcher/multi-coder
    gate by the application layer.

    No duplicate risk: the narrow (target, code) unique index was in force for
    all of history until J2-1a, and J1 stamps user_id on every new application,
    so at most one NULL-user row can exist per (target, code).
    """
    bind = op.get_bind()

    # A clean install (every application already coder-stamped) needs no system
    # user — only act when there is legacy NULL-user data to re-home.
    null_count = bind.execute(
        sa.text("SELECT COUNT(*) FROM code_applications WHERE user_id IS NULL")
    ).scalar()
    if not null_count:
        return

    uid = bind.execute(
        sa.text("SELECT id FROM users WHERE coder_type = 'unattributed' ORDER BY id LIMIT 1")
    ).scalar()
    if uid is None:
        # username is UNIQUE — fall back to a suffixed name if 'Unattributed' is
        # already taken by a human coder.
        name = "Unattributed"
        suffix = 2
        while bind.execute(
            sa.text("SELECT 1 FROM users WHERE username = :u"), {"u": name}
        ).scalar():
            name = f"Unattributed ({suffix})"
            suffix += 1
        bind.execute(
            sa.text(
                "INSERT INTO users (username, password_hash, is_admin, created_at, "
                "coder_type, archived) "
                "VALUES (:u, NULL, 0, CURRENT_TIMESTAMP, 'unattributed', 0)"
            ),
            {"u": name},
        )
        uid = bind.execute(
            sa.text("SELECT id FROM users WHERE coder_type = 'unattributed' ORDER BY id LIMIT 1")
        ).scalar()

    bind.execute(
        sa.text("UPDATE code_applications SET user_id = :uid WHERE user_id IS NULL"),
        {"uid": uid},
    )


def downgrade() -> None:
    """Re-orphan the re-homed applications and drop the Unattributed coder."""
    bind = op.get_bind()
    uid = bind.execute(
        sa.text("SELECT id FROM users WHERE coder_type = 'unattributed' ORDER BY id LIMIT 1")
    ).scalar()
    if uid is None:
        return
    bind.execute(
        sa.text("UPDATE code_applications SET user_id = NULL WHERE user_id = :uid"),
        {"uid": uid},
    )
    bind.execute(sa.text("DELETE FROM users WHERE id = :uid"), {"uid": uid})
