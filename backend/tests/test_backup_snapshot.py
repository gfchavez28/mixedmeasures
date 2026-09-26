"""A backup holds everything committed, or it is not written (#1025, #1044).

The app keeps its database in WAL mode: a committed change lives in the `-wal` file
until a checkpoint moves it into the main file. Two designs that copied the FILE
failed, and both are guarded here:

- **#1025 (the 2026-09-24 audit).** A checkpoint that could not finish RETURNED busy
  (it never raises), the main file was copied anyway, and the backup held 0 of the
  live database's 2 projects while passing every integrity check.
- **#1044 (found driving #1025's fix).** Copying the live file with an ordinary
  descriptor, then closing it, released every POSIX lock the process held on the
  database — so a second process concluded it was the last connection and deleted
  the `-wal` and `-shm` under the running server.

`database.snapshot_database_file` now copies through SQLite's online backup API.

What these guard, and why each is here:

- **A reader holding an old snapshot does not stop the backup, and the work in the
  WAL is in it** — #1025's own scenario, which the file copy lost.
- **The copier never checkpoints and never opens the live file itself** — the two
  mechanisms of the two defects, pinned structurally.
- **A second process cannot delete the WAL under the server after a backup** — #1044's
  reproduction, end to end.
- **Only a lock held EXCLUSIVELY elsewhere refuses a backup**, within its budget and
  having written nothing; a writer that merely holds the write lock does not.
- **A backup never holds back a save.** The checkpoint the old design ran stalled
  every NEW writer while it waited.
- **Every caller turns the refusal into its own sentence**, and a refused automatic
  backup is retried in minutes rather than hours.
"""

import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import builtins
import re
import sqlite3
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import database
from app import main as app_main
from app.database import DatabaseBusyError, snapshot_database_file
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers import backup as backup_router
from app.routers import participants as participants_router
from app.services import backup as backup_service
from app.services.backup import (
    AUTO_BACKUP_BUSY_RETRY_SECONDS,
    AUTO_BACKUP_BUSY_WAIT_SECONDS,
    SHUTDOWN_BACKUP_BUSY_WAIT_SECONDS,
    create_backup,
    restore_from_backup,
)
from app.services.restore_gate import RESTORE_DRAIN_TIMEOUT_SECONDS, db_gate
from tests.backup_support import stamp_revision

REPO = Path(__file__).resolve().parents[2]


def _live_db(path: Path) -> Path:
    """A database kept the way the app keeps its own — WAL mode — holding one
    project, fully checkpointed."""
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    for t in ("conversations", "datasets", "documents", "observations"):
        conn.execute(f"CREATE TABLE {t} (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("INSERT INTO projects (name) VALUES ('Alpha')")
    stamp_revision(conn)  # a restore refuses a database that records no revision (#1026)
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    return path


def _commit_project(db: Path, name: str) -> None:
    conn = sqlite3.connect(str(db))
    conn.execute("INSERT INTO projects (name) VALUES (?)", (name,))
    conn.commit()
    conn.close()


def _projects_in(path: Path) -> list[str]:
    conn = sqlite3.connect(str(path))
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return [r[0] for r in conn.execute("SELECT name FROM projects ORDER BY id")]
    finally:
        conn.close()


def _projects_in_backup(archive: Path, out: Path) -> list[str]:
    with zipfile.ZipFile(archive) as zf:
        zf.extract("database.db", out)
    return _projects_in(out / "database.db")


class _Reader:
    """A read transaction held open on its own connection — what a long export,
    merge or import looks like to everyone else."""

    def __init__(self, db: Path):
        self.conn = sqlite3.connect(str(db), check_same_thread=False)
        self.conn.execute("BEGIN")
        self.conn.execute("SELECT count(*) FROM projects").fetchone()

    def close(self) -> None:
        self.conn.close()


class _ExclusiveHolder:
    """Another program holding the database EXCLUSIVELY — the one lock that blocks a
    reader in WAL mode, and one this app never takes."""

    def __init__(self, db: Path):
        self.conn = sqlite3.connect(str(db), check_same_thread=False, isolation_level=None)
        self.conn.execute("PRAGMA locking_mode=EXCLUSIVE")
        self.conn.execute("BEGIN EXCLUSIVE")
        self.conn.execute("INSERT INTO projects (name) VALUES ('Held')")

    def release(self) -> None:
        self.conn.execute("COMMIT")
        self.conn.close()

    def abandon(self) -> None:
        self.conn.close()


@pytest.fixture
def bare_install(tmp_path):
    """The same, with NO connection of this process open — the only state in which
    another program can take the database EXCLUSIVELY. While the server's pool holds
    a connection that lock cannot be had (measured: `database is locked` on the
    holder), so the refusal is reachable at startup and during a restore (the pool is
    disposed), not while the app is serving."""
    db = _live_db(tmp_path / "live.db")
    docs = tmp_path / "documents"
    docs.mkdir()
    return SimpleNamespace(db=db, docs=docs, media=tmp_path / "media",
                           backups=tmp_path / "backups", tmp=tmp_path)


@pytest.fixture
def install(tmp_path):
    """A live WAL-mode database holding 'Alpha', and the folders a backup reads.

    ⚠️ **An idle connection stays open for the whole test, as the app's pool does.**
    Whichever connection closes LAST checkpoints the WAL and deletes it; the running
    app never closes its last one, so a fixture without this one tests a state the
    app is never in (under #1025's file copy it let a snapshot with no checkpoint
    pass). It is also the "server" whose files #1044's second process must not touch.
    """
    db = _live_db(tmp_path / "live.db")
    docs = tmp_path / "documents"
    docs.mkdir()
    pool = sqlite3.connect(str(db), check_same_thread=False)
    pool.execute("SELECT count(*) FROM projects").fetchone()
    yield SimpleNamespace(db=db, docs=docs, media=tmp_path / "media",
                          backups=tmp_path / "backups", tmp=tmp_path)
    pool.close()


# ── what the copy holds ───────────────────────────────────────────────────


def test_a_reader_holding_an_old_snapshot_does_not_stop_the_backup_and_the_wal_work_is_in_it(install):
    """#1025's scenario: 'Beta' is committed after a reader opened, so it sits in the
    WAL where no checkpoint can reach it. The file copy produced ['Alpha']; #1025's
    first fix refused the backup after its whole wait. The backup API reads past the
    reader and includes Beta, at once."""
    reader = _Reader(install.db)
    _commit_project(install.db, "Beta")
    try:
        started = time.monotonic()
        info = create_backup(install.db, install.docs, install.media, install.backups,
                             "manual", busy_wait_seconds=2.5)
        elapsed = time.monotonic() - started
    finally:
        reader.close()

    assert _projects_in_backup(install.backups / info.filename, install.tmp / "x") == [
        "Alpha", "Beta",
    ]
    assert elapsed < 2.0, f"the backup waited for the reader ({elapsed:.1f} s)"


def test_a_writer_holding_the_write_lock_does_not_refuse_the_backup(install):
    """In WAL mode a writer blocks no reader: the copy is the last COMMITTED state,
    and the writer's commit afterwards lands in the live database, not in the copy."""
    writer = sqlite3.connect(str(install.db), isolation_level=None, check_same_thread=False)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute("INSERT INTO projects (name) VALUES ('Uncommitted during the copy')")
    try:
        snapshot_database_file(install.db, install.tmp / "copy.db", busy_wait_seconds=2.5)
        writer.execute("COMMIT")
    finally:
        writer.close()

    assert _projects_in(install.tmp / "copy.db") == ["Alpha"]
    assert _projects_in(install.db) == ["Alpha", "Uncommitted during the copy"]


def test_a_database_not_in_wal_mode_is_copied_as_it_is(tmp_path):
    """The suite's hand-built fixtures are all rollback-journal databases."""
    db = tmp_path / "rollback.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO projects (name) VALUES ('Alpha')")
    conn.commit()
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    conn.close()

    snapshot_database_file(db, tmp_path / "copy.db", busy_wait_seconds=2)
    assert _projects_in(tmp_path / "copy.db") == ["Alpha"]


# ── the two mechanisms, pinned ────────────────────────────────────────────


def test_the_copier_never_checkpoints_and_never_opens_the_live_file_itself(install, monkeypatch):
    """#1025 was a checkpoint whose answer was ignored; #1044 was an ordinary
    descriptor on the live file (`shutil.copy2` opens it through `open`). The backup
    API needs neither, so either one coming back is the defect returning."""
    statements: list[str] = []
    real_open_raw = database.open_raw_connection

    class _Recorder:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, *args):
            statements.append(sql)
            return self._conn.execute(sql, *args)

        def backup(self, target, **kwargs):
            return self._conn.backup(getattr(target, "_conn", target), **kwargs)

        def close(self):
            self._conn.close()

    monkeypatch.setattr(database, "open_raw_connection", lambda p: _Recorder(real_open_raw(p)))
    opened: list[str] = []
    real_open = builtins.open

    def recording_open(file, *args, **kwargs):
        opened.append(os.fspath(file) if isinstance(file, (str, os.PathLike)) else repr(file))
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", recording_open)
    snapshot_database_file(install.db, install.tmp / "copy.db", busy_wait_seconds=2)
    monkeypatch.setattr(builtins, "open", real_open)

    assert statements, "the recorder saw nothing — the copier bypassed open_raw_connection"
    assert not [s for s in statements if "checkpoint" in s.lower()]
    assert str(install.db) not in opened, "the live database was opened with an ordinary descriptor"
    assert _projects_in(install.tmp / "copy.db") == ["Alpha"]


def test_a_second_process_cannot_delete_the_wal_under_the_server_after_a_backup(install):
    """#1044, end to end. The fixture's idle connection is the server. After a copy
    that opened and closed the live file, a second process that opened and closed the
    database found no lock, took itself for the last connection, and deleted `-wal`
    and `-shm` while the server was still using them (then: `disk I/O error`)."""
    snapshot_database_file(install.db, install.tmp / "copy.db", busy_wait_seconds=2)
    other = (
        "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); "
        "c.execute('SELECT count(*) FROM projects').fetchall(); c.close()"
    )
    subprocess.run([sys.executable, "-c", other, str(install.db)], check=True)

    assert Path(f"{install.db}-wal").exists(), "the WAL was deleted under an open connection"
    assert Path(f"{install.db}-shm").exists(), "the shared-memory index was deleted"


def test_a_backup_never_holds_back_a_save(install):
    """#1025's first fix ran a TRUNCATE checkpoint, which stalls every NEW writer while
    it waits on a reader (measured 2.74 s of a 3 s wait). The backup API runs none:
    a save made during a backup, with a reader holding an old snapshot, is immediate."""
    reader = _Reader(install.db)
    _commit_project(install.db, "Beta")
    worker = threading.Thread(
        target=create_backup,
        args=(install.db, install.docs, install.media, install.backups, "manual"),
        kwargs={"busy_wait_seconds": 4},
    )
    worker.start()
    time.sleep(0.2)
    writer = sqlite3.connect(str(install.db), timeout=10)
    started = time.monotonic()
    writer.execute("INSERT INTO projects (name) VALUES ('Saved meanwhile')")
    writer.commit()
    latency = time.monotonic() - started
    writer.close()
    worker.join()
    reader.close()

    assert latency < 0.5, f"a save waited {latency:.2f} s behind the backup"


# ── the one refusal left ──────────────────────────────────────────────────


def test_an_exclusive_lock_elsewhere_refuses_the_backup_and_writes_nothing(bare_install):
    holder = _ExclusiveHolder(bare_install.db)
    try:
        started = time.monotonic()
        with pytest.raises(DatabaseBusyError) as exc:
            create_backup(bare_install.db, bare_install.docs, bare_install.media, bare_install.backups,
                          "manual", busy_wait_seconds=2.5)
        elapsed = time.monotonic() - started
    finally:
        holder.abandon()

    assert list(bare_install.backups.iterdir()) == [], "a refused backup left a file behind"
    assert elapsed < 2.5 + 1.5, f"the wait overran its budget: {elapsed:.1f} s"
    assert exc.value.waited_seconds <= elapsed


def test_a_refused_snapshot_leaves_nothing_at_its_destination(bare_install):
    holder = _ExclusiveHolder(bare_install.db)
    dest = bare_install.tmp / "copy.db"
    try:
        with pytest.raises(DatabaseBusyError):
            snapshot_database_file(bare_install.db, dest, busy_wait_seconds=1.5)
    finally:
        holder.abandon()
    assert sorted(p.name for p in bare_install.tmp.glob("copy.db*")) == []


def test_a_lock_released_during_the_wait_gets_a_complete_backup(bare_install):
    """The POSITIVE control for the refusal: the wait is worth having."""
    holder = _ExclusiveHolder(bare_install.db)
    releaser = threading.Timer(1.2, holder.release)
    releaser.start()
    try:
        info = create_backup(bare_install.db, bare_install.docs, bare_install.media, bare_install.backups,
                             "manual", busy_wait_seconds=10)
    finally:
        releaser.join()

    assert _projects_in_backup(bare_install.backups / info.filename, bare_install.tmp / "x") == [
        "Alpha", "Held",
    ]


def test_the_waits_fit_the_limits_around_them():
    """Each budget is bounded by something outside this module, so the relation is
    pinned rather than the numbers."""
    # The 4-hourly backup holds a restore-gate slot while it waits; a restore asked
    # for meanwhile waits RESTORE_DRAIN_TIMEOUT_SECONDS for it, then is refused.
    assert AUTO_BACKUP_BUSY_WAIT_SECONDS < RESTORE_DRAIN_TIMEOUT_SECONDS
    # The on-quit backup: the desktop shell kills the backend `graceMs` after
    # asking it to stop (macOS and Linux; Windows kills it outright).
    source = (REPO / "electron" / "backend-process.js").read_text()
    grace_ms = int(re.search(r"graceMs = ([\d_]+)", source)[1].replace("_", ""))
    assert SHUTDOWN_BACKUP_BUSY_WAIT_SECONDS < grace_ms / 1000


# ── every caller says what was not done ───────────────────────────────────


def _busy(*_a, **_k):
    raise DatabaseBusyError(20.0)


def test_backup_now_is_refused_naming_what_holds_the_database(db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(backup_router, "create_backup", _busy)
    monkeypatch.setattr(backup_router, "_get_paths",
                        lambda: (tmp_path / "x.db", tmp_path, tmp_path, tmp_path))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(backup_router.backup_now(user=db_session.get(User, 1), db=db_session))
    assert exc.value.status_code == 409
    assert "was not taken" in exc.value.detail
    assert "another program" in exc.value.detail
    # #1044: this app's own work can no longer cause it, so it must not be blamed.
    assert "import" not in exc.value.detail and "merge" not in exc.value.detail
    assert "Nothing was saved." in exc.value.detail


def test_download_backup_is_refused_naming_what_holds_the_database(db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(backup_router, "create_backup", _busy)
    monkeypatch.setattr(backup_router, "_get_paths",
                        lambda: (tmp_path / "x.db", tmp_path, tmp_path, tmp_path))
    with pytest.raises(HTTPException) as exc:
        backup_router.backup_create(user=db_session.get(User, 1), db=db_session)
    assert exc.value.status_code == 409
    assert "another program" in exc.value.detail
    assert "Nothing was saved or downloaded." in exc.value.detail


def test_a_backup_that_fails_otherwise_does_not_point_at_server_logs(
    db_session, tmp_path, monkeypatch
):
    """There is no server log a desktop researcher can reach."""
    def full_disk(*_a, **_k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(backup_router, "create_backup", full_disk)
    monkeypatch.setattr(backup_router, "_get_paths",
                        lambda: (tmp_path / "x.db", tmp_path, tmp_path, tmp_path))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(backup_router.backup_now(user=db_session.get(User, 1), db=db_session))
    assert exc.value.status_code == 500
    assert "log" not in exc.value.detail
    assert "free space" in exc.value.detail


def test_a_locked_database_refuses_a_withdrawal_and_changes_nothing(db_session, monkeypatch):
    project = Project(user_id=1, name="Study")
    db_session.add(project)
    db_session.flush()
    person = Participant(project_id=project.id, identifier="B-03")
    db_session.add(person)
    db_session.flush()
    monkeypatch.setattr(participants_router, "create_backup", _busy)

    with pytest.raises(HTTPException) as exc:
        participants_router.withdraw_participant(
            project.id, person.id, user=db_session.get(User, 1), db=db_session,
        )
    assert exc.value.status_code == 409
    assert "Nothing was changed." in exc.value.detail
    assert "another program" in exc.value.detail
    assert "disk space" not in exc.value.detail
    assert db_session.get(Participant, person.id) is not None


def test_a_refused_pre_restore_backup_stops_the_restore_before_anything_changes(install, monkeypatch):
    """Raised BEFORE the restore's try block, so it is never reported as "failed
    partway … your data was saved to backup X" — no such backup exists."""
    archive = install.backups / create_backup(
        install.db, install.docs, install.media, install.backups, "manual"
    ).filename
    _commit_project(install.db, "Since the backup")
    live_before = _projects_in(install.db)
    monkeypatch.setattr(backup_service, "create_backup", _busy)

    with pytest.raises(DatabaseBusyError):
        restore_from_backup(archive, install.db, install.docs, install.media, install.backups)
    assert _projects_in(install.db) == live_before


def test_the_restore_door_says_it_did_not_start(db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(backup_router, "restore_from_backup", _busy)
    monkeypatch.setattr(backup_router, "engine", SimpleNamespace(dispose=lambda: None))
    monkeypatch.setattr(backup_router, "_get_paths",
                        lambda: (tmp_path / "x.db", tmp_path, tmp_path, tmp_path))
    with pytest.raises(HTTPException) as exc:
        backup_router._restore_in_place(
            tmp_path / "a.mmbackup", db=db_session, user_id=1, audit_details={},
        )
    assert exc.value.status_code == 409
    assert "did not start" in exc.value.detail
    assert "another program" in exc.value.detail
    assert "Nothing was changed." in exc.value.detail
    assert db_gate.active == 0 and db_gate.restoring is False


# ── the pre-migration copy ────────────────────────────────────────────────


def test_a_locked_database_refuses_the_migration_with_its_own_guidance(tmp_path, monkeypatch):
    """A PreMigrationBackupError is shown verbatim in the packaged app's crash
    dialog. Its other wording — free up disk space — is the wrong advice here."""
    db = _live_db(tmp_path / "live.db")
    holder = _ExclusiveHolder(db)
    backups = tmp_path / "pre-migration"
    monkeypatch.setattr(database, "get_backup_dir", lambda: backups)
    monkeypatch.setattr(database, "PRE_MIGRATION_BUSY_WAIT_SECONDS", 2.5)
    try:
        with pytest.raises(database.PreMigrationBackupError) as exc:
            database._backup_database(db)
    finally:
        holder.abandon()
    assert "another program" in str(exc.value)
    assert "disk space" not in str(exc.value)
    assert sorted(p.name for p in backups.iterdir()) == []


def test_the_pre_migration_copy_takes_its_name_only_when_complete(tmp_path, monkeypatch):
    """It is written under a staging name and renamed, so a half-written file never
    carries a copy's name — the 5-deep rotation counts files by that name."""
    db = _live_db(tmp_path / "live.db")
    reader = _Reader(db)
    _commit_project(db, "Beta")  # in the WAL: the copy must carry it
    backups = tmp_path / "pre-migration"
    monkeypatch.setattr(database, "get_backup_dir", lambda: backups)
    try:
        path = database._backup_database(db)
    finally:
        reader.close()

    assert sorted(p.name for p in backups.iterdir()) == [path.name]
    assert database._PRE_MIGRATION_RE.match(path.name)
    assert _projects_in(path) == ["Alpha", "Beta"]


def test_a_copy_interrupted_mid_write_never_carries_a_copys_name(tmp_path, monkeypatch):
    """What the staging name is FOR: a process killed mid-write runs no cleanup, and
    a half-written file carrying `{stem}_{date}_{time}.db` would be counted by the
    5-deep rotation and could push out a good copy. Simulated by a copier that writes
    part of its file and then dies the way a kill does (nothing below catches it)."""
    db = _live_db(tmp_path / "live.db")
    backups = tmp_path / "pre-migration"
    monkeypatch.setattr(database, "get_backup_dir", lambda: backups)

    def dies_mid_write(_src, dest, **_kw):
        Path(dest).write_bytes(b"SQLite format 3\x00" + b"\x00" * 100)
        raise SystemExit("killed")

    monkeypatch.setattr(database, "snapshot_database_file", dies_mid_write)
    with pytest.raises(SystemExit):
        database._backup_database(db)

    left = [p.name for p in backups.iterdir()]
    assert left, "precondition: the interrupted copy left a file"
    assert not [n for n in left if database._PRE_MIGRATION_RE.match(n)], left


# ── the background backups ────────────────────────────────────────────────


def test_a_refused_automatic_backup_is_tried_again_in_minutes_not_hours(tmp_path, monkeypatch):
    db = tmp_path / "live.db"
    db.write_bytes(b"x")
    settings = SimpleNamespace(auto_backup_interval_hours=4, mm_database_path=str(db),
                               auto_backup_max_count=5)

    monkeypatch.setattr(app_main, "_run_auto_backup", _busy)
    assert asyncio.run(app_main._auto_backup_turn(settings)) == AUTO_BACKUP_BUSY_RETRY_SECONDS

    # Anything else waits the whole interval, as before: a full disk is not
    # cleared in five minutes.
    def full_disk(*_a, **_k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(app_main, "_run_auto_backup", full_disk)
    assert asyncio.run(app_main._auto_backup_turn(settings)) == 4 * 3600

    monkeypatch.setattr(app_main, "_run_auto_backup", lambda *a, **k: True)
    assert asyncio.run(app_main._auto_backup_turn(settings)) == 4 * 3600


def test_each_background_backup_waits_as_long_as_its_moment_allows(tmp_path, monkeypatch):
    db = tmp_path / "live.db"
    db.write_bytes(b"x")
    waits: dict[str, float] = {}
    monkeypatch.setattr(backup_service, "create_backup",
                        lambda *a, **k: waits.__setitem__(a[4], k.get("busy_wait_seconds")))
    monkeypatch.setattr(app_main.get_settings(), "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(app_main, "get_backup_dir", lambda: tmp_path / "b")

    app_main._run_auto_backup(db, tmp_path, tmp_path, tmp_path, 5)
    app_main._shutdown_backup()

    assert waits == {"auto": AUTO_BACKUP_BUSY_WAIT_SECONDS,
                     "shutdown": SHUTDOWN_BACKUP_BUSY_WAIT_SECONDS}


def test_a_refused_quit_backup_still_releases_its_gate_slot(tmp_path, monkeypatch):
    db = tmp_path / "live.db"
    db.write_bytes(b"x")
    monkeypatch.setattr(backup_service, "create_backup", _busy)
    monkeypatch.setattr(app_main.get_settings(), "mm_database_path", str(db), raising=False)
    monkeypatch.setattr(app_main, "get_backup_dir", lambda: tmp_path / "b")

    app_main._shutdown_backup()  # logs, never raises
    assert db_gate.active == 0
