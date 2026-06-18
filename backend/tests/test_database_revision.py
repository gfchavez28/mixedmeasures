"""Phase 0.5 regression: a present-but-unreadable DB must never read as "fresh".

The bug: `_get_current_revision` used a bare `except Exception: return None`, so a
corrupt file — or, once SQLCipher lands, a real DB opened with the wrong key —
looked identical to a brand-new install. `run_migrations()` would then baseline
over it, destroying data. These tests pin the distinction:
  - absent / zero-byte / readable-without-alembic_version  → None (legitimately fresh)
  - present, non-empty, unreadable as SQLite               → DatabaseUnreadableError
"""

import sqlite3

import pytest

from app.database import (
    DatabaseUnreadableError,
    _get_current_revision,
    run_migrations,
)
import app.database as database


def _make_sqlite(path, *, with_alembic_rev=None, other_table=False):
    conn = sqlite3.connect(str(path))
    try:
        if other_table:
            conn.execute("CREATE TABLE things (id INTEGER PRIMARY KEY)")
        if with_alembic_rev is not None:
            conn.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
            conn.execute("INSERT INTO alembic_version (version_num) VALUES (?)", (with_alembic_rev,))
        conn.commit()
    finally:
        conn.close()


# ── Legitimately fresh → None ─────────────────────────────────────────────

def test_absent_file_is_fresh(tmp_path):
    assert _get_current_revision(tmp_path / "nope.db") is None


def test_zero_byte_file_is_fresh(tmp_path):
    p = tmp_path / "empty.db"
    p.touch()
    assert p.stat().st_size == 0
    assert _get_current_revision(p) is None


def test_readable_db_without_alembic_table_is_fresh(tmp_path):
    p = tmp_path / "legacy.db"
    _make_sqlite(p, other_table=True)
    assert _get_current_revision(p) is None


# ── Real, migrated DB → the revision ──────────────────────────────────────

def test_migrated_db_returns_revision(tmp_path):
    p = tmp_path / "real.db"
    _make_sqlite(p, with_alembic_rev="94edc0f39eba")
    assert _get_current_revision(p) == "94edc0f39eba"


# ── The Phase 0.5 guard: present-but-unreadable must NOT be "fresh" ───────

def test_garbage_file_raises_not_fresh(tmp_path):
    p = tmp_path / "corrupt.db"
    # Non-empty bytes that are not a valid SQLite header (also simulates a
    # SQLCipher-encrypted file opened with the wrong/no key).
    p.write_bytes(b"\x89not-a-sqlite-database\x00\xff" * 64)
    assert p.stat().st_size > 0
    with pytest.raises(DatabaseUnreadableError):
        _get_current_revision(p)


def test_run_migrations_refuses_unreadable_db(tmp_path, monkeypatch):
    """run_migrations must raise (not baseline) and never call command.upgrade."""
    p = tmp_path / "corrupt.db"
    p.write_bytes(b"\x89not-a-sqlite-database\x00\xff" * 64)

    monkeypatch.setattr(database.settings, "mm_database_path", str(p), raising=False)

    # `run_migrations` does `from alembic import command` then `command.upgrade`,
    # so patching the source module's attribute intercepts the call.
    import alembic.command
    called = {"upgrade": False}
    monkeypatch.setattr(
        alembic.command, "upgrade",
        lambda *a, **k: called.__setitem__("upgrade", True),
    )

    with pytest.raises(DatabaseUnreadableError):
        run_migrations()
    assert called["upgrade"] is False, "must not migrate over an unreadable DB"
