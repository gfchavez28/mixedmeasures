"""Phase 0.5 regression: a present-but-unreadable DB must never read as "fresh".

The bug: `_get_current_revision` used a bare `except Exception: return None`, so a
corrupt file — or, once SQLCipher lands, a real DB opened with the wrong key —
looked identical to a brand-new install. `run_migrations()` would then baseline
over it, destroying data. These tests pin the distinction:
  - absent / zero-byte / readable-without-alembic_version  → None (legitimately fresh)
  - present, non-empty, unreadable as SQLite               → DatabaseUnreadableError
"""

import sqlite3
from pathlib import Path

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


# ── #692: a FAILED pre-migration backup must stop the migration ───────────────
#
# The bug: `_backup_database` caught every exception, logged `logger.warning`, and
# returned None. The caller's `if backup_path:` only controlled whether a SUCCESS
# message was logged — `command.upgrade()` ran on the very next line regardless. So
# the sole guard on the only destructive path was best-effort in exactly the
# disk-full scenario it exists for, and in a packaged app a warning is not a
# user-visible event.
#
# The distinction these tests pin is the whole fix: "nothing to back up" and
# "attempted and failed" both returned None before, leaving the caller unable to
# tell them apart.

def _readable_db_at_revision(path, rev="abc123"):
    _make_sqlite(path, with_alembic_rev=rev, other_table=True)
    return path


def test_failed_backup_raises_and_blocks_the_migration(tmp_path, monkeypatch):
    db = _readable_db_at_revision(tmp_path / "dev.db")
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")

    def _enospc(*_a, **_k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(database.shutil, "copy2", _enospc)

    import alembic.command
    called = {"upgrade": False}
    monkeypatch.setattr(
        alembic.command, "upgrade",
        lambda *a, **k: called.__setitem__("upgrade", True),
    )

    with pytest.raises(database.PreMigrationBackupError) as exc:
        run_migrations()

    assert called["upgrade"] is False, "must not migrate when the backup failed"
    # The message has to be actionable — this is what a user sees in the packaged
    # app's startup error dialog, and "backup failed" alone tells them nothing.
    msg = str(exc.value)
    assert "No space left on device" in msg
    assert "data is untouched" in msg


def test_empty_db_skips_backup_and_still_migrates(tmp_path, monkeypatch):
    """The other arm: nothing to back up is NOT a failure (#692).

    A fresh install has no revision, so `_backup_database` is never reached and the
    migration must proceed. Pinning this stops a future 'raise on None' shortcut
    from bricking first launch.
    """
    db = tmp_path / "fresh.db"  # absent entirely
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")

    import alembic.command
    called = {"upgrade": False}
    monkeypatch.setattr(
        alembic.command, "upgrade",
        lambda *a, **k: called.__setitem__("upgrade", True),
    )
    monkeypatch.setattr(database, "_probe_engine_readable", lambda: None)

    run_migrations()
    assert called["upgrade"] is True, "a fresh install must still migrate"


def test_backup_succeeds_even_if_pruning_old_backups_fails(tmp_path, monkeypatch):
    """A prune failure must NOT block the migration.

    The copy has already landed by the time pruning runs, so the guard's job is
    done. Folding the prune into the same try/except would turn a full-but-writable
    backup directory into a startup failure — a strictly worse outcome than keeping
    one extra old backup around.
    """
    db = _readable_db_at_revision(tmp_path / "dev.db")
    backup_dir = tmp_path / "backups"
    monkeypatch.setattr(database, "get_backup_dir", lambda: backup_dir)

    real_glob = Path.glob

    def _boom(self, pattern):
        if "dev_" in pattern:
            raise OSError(13, "Permission denied")
        return real_glob(self, pattern)

    monkeypatch.setattr(Path, "glob", _boom)

    result = database._backup_database(db)
    assert result is not None and result.exists(), "the backup itself must survive"
