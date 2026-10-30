"""#1476: starting on a database a NEWER version wrote is refused, before anything is written.

Reached by reinstalling an older version, or running an old AppImage or `.app` still on
disk, after a later version updated the data. The database then records a revision this
build's scripts do not contain. `run_migrations` read that as pending: it announced an
update (`MM-PHASE: migrating`, the splash's *"Updating your data…"*), wrote a full
pre-migration copy — rotating out the older copies, the only way back to the older
schema, after five launches — and then showed `migration_failed_guidance`, which says
the update was undone and the version updated FROM can open the data.

The refusal uses the restore's own classifier (`classify_revision`, #1026), and must not
catch a FRESH database, which records no revision and which that classifier also calls
"unknown".
"""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from app import database
from app.database import NewerDatabaseError, classify_revision, run_migrations
from app.services.backup import APP_VERSION
from app.startup_errors import (
    MAX_FATAL_MESSAGE_CHARS,
    MM_FATAL_PREFIX,
    MM_PHASE_PREFIX,
    fatal_startup_message,
)
from tests.test_migration_atomicity import _connect, _head_db, driver  # noqa: F401

#: A revision no build of these scripts contains — what a newer build leaves behind.
NEWER = "feedfacecafe"
BACKEND = Path(__file__).resolve().parents[1]


def _as_if_newer(db: Path, key: str | None) -> Path:
    conn = _connect(db, key)
    conn.execute("UPDATE alembic_version SET version_num = ?", (NEWER,))
    conn.commit()
    conn.close()
    return db


def _bytes_and_rev(db: Path, key: str | None):
    conn = _connect(db, key)
    try:
        rev = conn.execute("SELECT version_num FROM alembic_version").fetchall()
        rows = conn.execute("SELECT id, name FROM projects").fetchall()
    finally:
        conn.close()
    return rev, rows


@pytest.fixture
def seen(monkeypatch, tmp_path):
    """Everything `run_migrations` did that a researcher could see or lose."""
    events = []
    monkeypatch.setattr(database, "emit_startup_phase", lambda phase: events.append(phase))
    real_backup = database._backup_database

    def backup(db_path):
        events.append("copy")
        return real_backup(db_path)

    monkeypatch.setattr(database, "_backup_database", backup)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")
    import alembic.command

    real_upgrade = alembic.command.upgrade

    def upgrade(*a, **k):
        events.append("upgrade")
        return real_upgrade(*a, **k)

    monkeypatch.setattr(alembic.command, "upgrade", upgrade)
    return events


def test_the_fixture_is_a_revision_this_build_does_not_contain():
    assert classify_revision(NEWER) == "unknown"


def test_a_newer_database_is_refused_before_the_phase_line_and_the_copy(
    tmp_path, monkeypatch, driver, seen  # noqa: F811
):
    """On both drivers: under SQLCipher the revision is read through the keyed raw
    connection, and the refusal must come before the engine is ever asked to migrate."""
    db = _as_if_newer(_head_db(tmp_path, driver), driver)
    before = _bytes_and_rev(db, driver)
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    seen.clear()  # building the fixture database ran an upgrade of its own

    with pytest.raises(NewerDatabaseError):
        run_migrations()

    assert seen == [], "no update announced, no copy written, no upgrade attempted"
    assert not (tmp_path / "backups").exists() or list((tmp_path / "backups").iterdir()) == []
    assert _bytes_and_rev(db, driver) == before


def test_the_older_copies_survive_any_number_of_launches(tmp_path, monkeypatch):
    """The second half of the defect: each launch rotated the five copies, so five
    launches replaced every copy of the older states."""
    db = _as_if_newer(_head_db(tmp_path, None), None)
    backups = tmp_path / "backups"
    backups.mkdir()
    seeded = [f"{db.stem}_2026100{i}_120000.db" for i in range(1, 6)]
    for name in seeded:
        (backups / name).write_bytes(db.read_bytes())
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "get_backup_dir", lambda: backups)
    monkeypatch.setattr(database, "emit_startup_phase", lambda phase: None)

    for _ in range(2):
        with pytest.raises(NewerDatabaseError):
            run_migrations()

    assert sorted(p.name for p in backups.iterdir()) == seeded


def test_the_dialog_says_a_newer_version_wrote_it_and_what_to_do(tmp_path, monkeypatch):
    """Shown verbatim (`FatalStartupError`), so it is guidance; the path goes LAST and
    survives the 800-character cut with a path past Windows' MAX_PATH."""
    deep = tmp_path / ("d" * 120) / ("e" * 120) / ("f" * 40)
    deep.mkdir(parents=True)
    db = _as_if_newer(_head_db(deep, None), None)
    assert len(str(db)) > 260
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")

    with pytest.raises(NewerDatabaseError) as exc:
        run_migrations()

    message = str(exc.value)
    assert message.startswith("Your Mixed Measures data was last opened by a newer version")
    assert f"this version ({APP_VERSION})" in message
    assert "Nothing has been changed." in message
    assert "Install the newest version of Mixed Measures" in message
    # The wrong sentence this replaces must not come back by another route.
    assert "update was undone" not in message and "updated from" not in message
    assert message.endswith(f"The database is: {db} (database version {NEWER}).")
    assert len(message) < MAX_FATAL_MESSAGE_CHARS
    assert fatal_startup_message(exc.value) == message


@pytest.mark.parametrize("fresh", ["absent", "empty"])
def test_a_fresh_install_is_not_refused(tmp_path, monkeypatch, seen, fresh):
    """`classify_revision(None)` is "unknown" (the restore refuses a backup with no
    revision); a first launch also has none, and must still be baselined to head."""
    db = tmp_path / "fresh.db"
    if fresh == "empty":
        db.touch()
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(database, "_probe_engine_readable", lambda: None)

    run_migrations()

    assert seen == ["upgrade"], "nothing to copy, nothing announced, and migrated"
    assert classify_revision(_bytes_and_rev(db, None)[0][0][0]) == "current"


def test_the_frozen_entry_reports_it_on_the_marker_line_and_announces_no_update(tmp_path):
    """Entered at the MOUTH (#747): `run_server.py` in a child process, so the lifespan's
    own `emit_fatal_startup` writes the line the shell lifts into its dialog."""
    db = _as_if_newer(_head_db(tmp_path, None), None)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("MM_")}
    env.update(
        MM_DATABASE_PATH=str(db), MM_DATA_DIR=str(tmp_path / "data"),
        MM_BACKUP_DIR=str(tmp_path / "backups"), MM_PORT="8086",
    )
    r = subprocess.run([sys.executable, "run_server.py"], cwd=BACKEND, env=env,
                       capture_output=True, timeout=120)
    err = r.stderr.decode("utf-8")
    assert r.returncode != 0
    fatal = [line for line in err.splitlines() if MM_FATAL_PREFIX in line]
    assert len(fatal) == 1, err[-2000:]
    assert "last opened by a newer version" in fatal[0]
    assert not [line for line in err.splitlines() if line.startswith(MM_PHASE_PREFIX)]
    assert not (tmp_path / "backups").exists() or not any(
        p.suffix == ".db" for p in (tmp_path / "backups").iterdir()
    )
