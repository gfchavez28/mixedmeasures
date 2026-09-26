"""Shared helpers for tests that build a database file to back up or restore.

Since #1026 a restore reads the Alembic revision recorded INSIDE the backup's
database and refuses one this build cannot read — including a database that
records none, which no real backup does. So a hand-built fixture database must
say which schema it claims to be, or every restore test meets that refusal
instead of the behaviour it was written for.
"""

import sqlite3

from alembic.script import ScriptDirectory

from app.database import _script_only_alembic_config


def head_revision() -> str:
    """This build's migration head."""
    return ScriptDirectory.from_config(_script_only_alembic_config()).get_current_head()


def stamp_revision(conn: sqlite3.Connection, revision: str | None = None) -> None:
    """Record `revision` (default: this build's head) the way Alembic does.

    ⚠️ A STAMP, not a migration: the fixture's tables stay whatever the test
    built. Use it for tests about the backup machinery; a test about the SCHEMA
    must build its database by migrating (see `test_restore_schema.py`).
    """
    conn.execute(
        "CREATE TABLE IF NOT EXISTS alembic_version "
        "(version_num VARCHAR(32) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
    )
    conn.execute("DELETE FROM alembic_version")
    conn.execute("INSERT INTO alembic_version VALUES (?)", (revision or head_revision(),))
