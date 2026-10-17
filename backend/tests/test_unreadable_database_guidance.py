"""#953 — what the crash dialog says when the database will not open.

`DatabaseUnreadableError` ended at the driver's words — *"Database at ⟨path⟩ exists
(4096 bytes) but could not be opened: file is not a database"* — while
`FatalStartupError`'s contract says its message is GUIDANCE, shown verbatim. One
sentence cannot serve: four causes stand behind the error, MEASURED 2026-10-12, and
advice right for one is wrong for the next (a file that is merely LOCKED must not be
told it is damaged). So the guidance branches on the driver's message, and:

- the four driver strings are bound FOR REAL here (a canary, #1128's precedent) — a
  driver that rewords one fails this file rather than sending a dialog to the
  generic branch;
- the guidance is composed by the STARTUP callers, never by `_get_current_revision`,
  whose message the restore quotes in its own sentence;
- the file, its size and the driver's words go LAST and survive the channel's 800
  characters with a long path, because the line is cut from its end.
"""

import os
import sqlite3
from pathlib import Path

import pytest

import app.database as database
from app.database import (
    HELP_CONTACT,
    UNREADABLE_DAMAGED,
    UNREADABLE_LOCKED,
    UNREADABLE_NO_ACCESS,
    UNREADABLE_NOT_A_DATABASE,
    DatabaseUnreadableError,
    _get_current_revision,
    run_migrations,
    unreadable_database_guidance,
)
from app.startup_errors import MAX_FATAL_MESSAGE_CHARS, fatal_startup_message


def _read(path, *, timeout=5.0):
    """The reads `_get_current_revision` makes, on a stdlib connection."""
    conn = sqlite3.connect(str(path), timeout=timeout)
    try:
        conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        conn.execute("SELECT count(*) FROM t").fetchone()
    finally:
        conn.close()


def _garbage(path):
    path.write_bytes(b"\x89not-a-sqlite-database\x00\xff" * 64)
    return path


def _damaged(path):
    """A real database cut short — the right key (none), the wrong length."""
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE alembic_version (version_num TEXT)")
    conn.execute("INSERT INTO alembic_version VALUES ('94edc0f39eba')")
    conn.execute("CREATE TABLE t (x TEXT)")
    conn.executemany("INSERT INTO t VALUES (?)", [("y" * 200,)] * 2000)
    conn.commit()
    conn.close()
    os.truncate(path, 4096 * 3)
    return path


def _driver_error(read):
    with pytest.raises(sqlite3.Error) as caught:
        read()
    return str(caught.value)


# ── The canary: the driver strings the branches key on ──────────────────────────

def test_the_four_driver_strings_are_what_the_driver_says(tmp_path):
    folder = tmp_path / "a-folder.db"
    folder.mkdir()
    locked = tmp_path / "locked.db"
    sqlite3.connect(str(locked)).execute("CREATE TABLE t (x)").connection.close()
    holder = sqlite3.connect(str(locked), isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        said = {
            UNREADABLE_NOT_A_DATABASE: _driver_error(lambda: _read(_garbage(tmp_path / "g.db"))),
            UNREADABLE_DAMAGED: _driver_error(lambda: _read(_damaged(tmp_path / "d.db"))),
            UNREADABLE_NO_ACCESS: _driver_error(lambda: _read(folder)),
            UNREADABLE_LOCKED: _driver_error(lambda: _read(locked, timeout=0)),
        }
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    for expected, actual in said.items():
        assert expected in actual, f"the driver now says {actual!r}, not {expected!r}"


# ── Each cause gets its own advice ──────────────────────────────────────────────

DB = Path("/home/me/.config/Mixed Measures/mixedmeasures.db")


@pytest.fixture
def backups_beside(monkeypatch):
    monkeypatch.setattr(database, "get_backup_dir", lambda: DB.parent / "backups")


def test_a_locked_file_is_told_to_close_the_other_program_not_that_it_is_damaged(backups_beside):
    msg = unreadable_database_guidance(DB, UNREADABLE_LOCKED)
    assert msg.startswith("Another program has the Mixed Measures database open")
    assert "Close the other program" in msg
    assert "damaged" not in msg


def test_a_file_the_app_may_not_open_is_told_to_check_its_permissions(backups_beside):
    msg = unreadable_database_guidance(DB, UNREADABLE_NO_ACCESS)
    assert msg.startswith("Mixed Measures is not allowed to open its database file")
    assert "damaged" not in msg


def test_a_damaged_file_keeps_its_backups_and_gets_a_private_way_to_ask(backups_beside):
    msg = unreadable_database_guidance(DB, UNREADABLE_DAMAGED)
    assert msg.startswith("The Mixed Measures database is damaged")
    assert "keep the file, and the “backups” folder beside it" in msg
    assert f"email {HELP_CONTACT}" in msg
    assert "never your recovery key or your database" in msg


def test_not_a_database_names_the_copy_from_another_installation(backups_beside):
    msg = unreadable_database_guidance(DB, UNREADABLE_NOT_A_DATABASE)
    assert "copied from another computer or installation" in msg
    assert "opens only with the key it was made with" in msg
    assert f"email {HELP_CONTACT}" in msg


def test_a_driver_message_none_of_the_four_still_gets_the_help_line(backups_beside):
    msg = unreadable_database_guidance(DB, "disk I/O error")
    assert msg.startswith("The Mixed Measures database could not be read. Nothing")
    assert f"email {HELP_CONTACT}" in msg


def test_a_backup_folder_elsewhere_is_named_by_its_path(monkeypatch):
    monkeypatch.setattr(database, "get_backup_dir", lambda: Path("/srv/mm-backups"))
    msg = unreadable_database_guidance(DB, UNREADABLE_DAMAGED)
    assert "keep the file, and /srv/mm-backups." in msg


# ── The channel: one line, 800 characters, cut from the end ────────────────────

@pytest.mark.parametrize("cause", [
    UNREADABLE_LOCKED, UNREADABLE_NO_ACCESS, UNREADABLE_DAMAGED,
    UNREADABLE_NOT_A_DATABASE, "disk I/O error",
])
def test_with_a_long_path_every_message_reaches_the_dialog_whole(cause, tmp_path, monkeypatch):
    """A path just past Windows' 260-character MAX_PATH. The packaged app's own folder
    is far shorter on every system (the home folder + `Mixed Measures`), so this is
    headroom, not a typical case — and its first draft, at ~370 characters, did cut the
    longest branch, which is how the wording was held to this budget."""
    deep = tmp_path
    while len(str(deep / "Mixed Measures" / "mixedmeasures.db")) < 262:
        deep = deep / "a-deeply-nested-folder"
    deep = deep / "Mixed Measures"
    deep.mkdir(parents=True)
    db = deep / "mixedmeasures.db"
    db.write_bytes(b"x" * 4096)
    monkeypatch.setattr(database, "get_backup_dir", lambda: deep / "backups")
    assert 260 < len(str(db)) < 300, "the fixture must sit just past MAX_PATH"

    shown = fatal_startup_message(DatabaseUnreadableError(unreadable_database_guidance(db, cause)))
    assert len(shown) <= MAX_FATAL_MESSAGE_CHARS
    assert shown.endswith(f"The file is: {db} (4096 bytes; {cause}).")


# ── Where the guidance is composed ──────────────────────────────────────────────

def test_startup_shows_the_guidance(tmp_path, monkeypatch):
    db = _garbage(tmp_path / "mixedmeasures.db")
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")
    import alembic.command
    monkeypatch.setattr(alembic.command, "upgrade", lambda *a, **k: pytest.fail("migrated"))

    with pytest.raises(DatabaseUnreadableError) as caught:
        run_migrations()
    assert str(caught.value) == unreadable_database_guidance(db, UNREADABLE_NOT_A_DATABASE)


def test_the_reader_keeps_its_diagnostic_because_the_restore_quotes_it(tmp_path):
    """`services/backup.py::_bring_to_this_version` puts this text in a restore's
    sentence, where "choose Quit" would be nonsense."""
    db = _garbage(tmp_path / "backup-db.db")
    with pytest.raises(DatabaseUnreadableError) as caught:
        _get_current_revision(db)
    assert str(caught.value).startswith(f"Database at {db} exists")
    assert HELP_CONTACT not in str(caught.value)


def test_the_engine_probe_shows_the_same_guidance(tmp_path, monkeypatch):
    from sqlalchemy.exc import DatabaseError

    db = _garbage(tmp_path / "mixedmeasures.db")
    monkeypatch.setattr(database.settings, "mm_encryption_enabled", True, raising=False)
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")

    class _Engine:
        def connect(self):
            raise DatabaseError("SELECT count(*) FROM sqlite_master", None,
                                sqlite3.DatabaseError(UNREADABLE_NOT_A_DATABASE))

    monkeypatch.setattr(database, "engine", _Engine())
    with pytest.raises(DatabaseUnreadableError) as caught:
        database._probe_engine_readable()
    assert str(caught.value) == unreadable_database_guidance(db, UNREADABLE_NOT_A_DATABASE)
