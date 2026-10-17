"""#1202 — a restore that stopped before the swap says so in the trail.

`restore_started` is committed inside the gate BEFORE `restore_from_backup` runs its
own checks, so a refused restore left a started row with nothing after it — the same
trail as a restore that died partway. Driven through the real door on a real file
database (the #1084 test's pattern), so "which database holds the rows" is the file's
answer, not the test's.
"""

import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.audit import AuditEntry
from app.models.project import Project
from app.models.user import User
from app.routers import backup as backup_router
from app.services.backup import RESTORE_LOCK_NAME, RestoreError, create_backup
from app.services.restore_gate import DatabaseGate, RestoreRefused
from tests.backup_support import stamp_revision

OUTCOME = backup_router.RESTORE_OUTCOME_HEADER


@pytest.fixture
def live(tmp_path, monkeypatch):
    db_path = tmp_path / "live.db"
    docs, media, backups = tmp_path / "docs", tmp_path / "data" / "media", tmp_path / "backups"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        stamp_revision(conn.connection.dbapi_connection)
    Session = sessionmaker(bind=engine, autoflush=False)
    with Session() as s:
        s.add(User(id=1, username="Researcher", password_hash=""))
        s.add(Project(id=1, user_id=1, name="Study"))
        s.commit()
    backup = create_backup(db_path, docs, media, backups, "manual")
    monkeypatch.setattr(backup_router, "engine", engine)
    monkeypatch.setattr(backup_router, "SessionLocal", Session)
    monkeypatch.setattr(backup_router, "run_data_repairs", lambda _s: None)
    monkeypatch.setattr(backup_router, "_get_paths", lambda: (db_path, docs, media, backups))
    monkeypatch.setattr(backup_router, "db_gate", DatabaseGate())
    yield SimpleNamespace(db_path=db_path, media=media, backups=backups, backup=backup, Session=Session)
    engine.dispose()


def _restore(live):
    return backup_router.backup_restore_local(live.backup.filename, user=SimpleNamespace(id=1), db=live.Session())


def _trail(live):
    """Read from the FILE at the live path, through a fresh engine — not the pool the
    restore used."""
    e = create_engine(f"sqlite:///{live.db_path}")
    try:
        with sessionmaker(bind=e)() as s:
            return [(a.action, a.user_id, json.loads(a.details)) for a in s.query(AuditEntry).order_by(AuditEntry.id)]
    finally:
        e.dispose()


def test_a_backup_that_no_longer_reads_records_started_then_not_started(live):
    live.backup.filename and (live.backups / live.backup.filename).write_bytes(b"not a zip")
    with pytest.raises(HTTPException) as exc:
        _restore(live)
    assert exc.value.status_code == 400 and exc.value.headers == {OUTCOME: "not-started"}
    trail = _trail(live)
    assert [a for a, _, _ in trail] == ["restore_started", "restore_not_started"]
    _, user_id, details = trail[1]
    assert user_id == 1, "nothing was swapped: the id still names the same person"
    assert details["filename"] == live.backup.filename and details["source"] == "backup_folder"
    assert details["error"] == "RestoreNotStarted" and "Nothing was changed" in details["reason"]


def test_a_restore_running_in_another_process_is_recorded_as_not_started(live):
    """`RestoreRefused` raised INSIDE `restore_from_backup` (the cross-process lock)."""
    live.media.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(live.media.parent / RESTORE_LOCK_NAME), os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # another open file description: conflicts
    try:
        with pytest.raises(HTTPException) as exc:
            _restore(live)
    finally:
        os.close(fd)
    assert exc.value.status_code == 409
    assert [a for a, _, _ in _trail(live)] == ["restore_started", "restore_not_started"]


def test_a_restore_the_gate_refused_records_nothing(live, monkeypatch):
    """The same TYPE refused BEFORE the started row: nothing to pair. Kills a record
    written from the router's outer `except RestoreRefused` arm."""
    class Busy:
        @contextmanager
        def exclusive(self, *a, **k):
            raise RestoreRefused("another restore is running", "restoring")
            yield

    monkeypatch.setattr(backup_router, "db_gate", Busy())
    with pytest.raises(HTTPException) as exc:
        _restore(live)
    assert exc.value.status_code == 409
    assert _trail(live) == []


def test_a_partway_failure_is_not_recorded_as_not_started(live, monkeypatch):
    """After the swap the live file may not be the one holding `restore_started`."""
    def partway(*a, **k):
        raise RestoreError("Restore failed partway (x).", "pre_restore_20261014_121530.mmbackup",
                           pre_restore_taken_at="2026-10-14T12:15:30+00:00")

    monkeypatch.setattr(backup_router, "restore_from_backup", partway)
    with pytest.raises(HTTPException) as exc:
        _restore(live)
    assert exc.value.headers[OUTCOME] == "partway"
    assert [a for a, _, _ in _trail(live)] == ["restore_started"]


def test_a_record_that_cannot_be_written_never_replaces_the_refusal(live, monkeypatch):
    """Another program's lock refuses the restore AND this write: the researcher must
    still get the refusal's own sentence, status and header."""
    live.backup.filename and (live.backups / live.backup.filename).write_bytes(b"not a zip")

    class Locked:
        def __enter__(self):
            raise OperationalError("INSERT INTO audit_entries …", None, Exception("database is locked"))

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(backup_router, "SessionLocal", lambda: Locked())
    with pytest.raises(HTTPException) as exc:
        _restore(live)
    assert exc.value.status_code == 400 and exc.value.headers == {OUTCOME: "not-started"}
    assert "could not be read" in exc.value.detail and "Nothing was changed" in exc.value.detail
    assert [a for a, _, _ in _trail(live)] == ["restore_started"]


def test_a_restore_that_succeeds_still_reads_completed_only_in_the_new_file(live):
    """Positive control: the success path is unchanged — the restored file carries
    `restore_completed` and nothing else (#1084 c)."""
    result = _restore(live)
    assert result["status"] == "restored"
    assert [a for a, _, _ in _trail(live)] == ["restore_completed"]
