"""A restore brings the backup's data to THIS version, or refuses it (#1026).

The defect, executed by the 2026-09-24 audit: restore compared nothing but the
app-version string, and only as a warning.
- An OLDER backup was installed as it was, so every page reading a newer column
  failed (`no such column: codes.code_set_id`) until the app was relaunched. This
  cut adds two migrations, so EVERY automatic backup taken before upgrading is one.
- A NEWER backup (another machine, or a downgrade) was accepted with no warning,
  and the next launch was fatal (`Can't locate revision`) — with the one backup
  that could undo it restorable only from inside the app that no longer started.

What these guard:
- an older backup is MIGRATED IN STAGING, before the swap: what is swapped in can
  be read by this build's models, and the backup archive itself is not changed;
- a migration that fails changes NOTHING (the destructive phase is still
  renames-only, #550);
- a backup this build cannot read is refused at PREVIEW, before the pre-restore
  backup is taken, with a sentence that names the version;
- the restored database gets the same data repairs startup gives every database
  it opens, from the same list.

The older database here is a REAL one — migrated to the baseline revision, not a
stamp on a hand-built schema — so the migration run in staging is the real chain.
"""

import hashlib
import logging
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

import app.services.backup as backup_service
from app.database import (
    _script_only_alembic_config,
    classify_revision,
    database_file_revision,
    upgrade_database_file,
)
from app.routers import backup as backup_router
from app.services.backup import APP_VERSION, create_backup, restore_from_backup, validate_backup
from app.services.restore_gate import DatabaseGate
from tests.backup_support import head_revision, stamp_revision


def _script() -> ScriptDirectory:
    return ScriptDirectory.from_config(_script_only_alembic_config())


def _migrate_to(path: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(path)
    command.upgrade(cfg, revision)


def _baseline_db(path: Path, project_name: str) -> Path:
    """A database as the FIRST release's schema left it, holding one project."""
    _migrate_to(path, _script().get_base())
    conn = sqlite3.connect(str(path))
    conn.execute(
        "INSERT INTO users (id, username, password_hash, created_at) "
        "VALUES (1, 'Researcher', '', '2026-06-06 00:00:00')"
    )
    conn.execute(
        "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) "
        "VALUES (1, 1, ?, 'active', '2026-06-06 00:00:00', '2026-06-06 00:00:00')",
        (project_name,),
    )
    conn.commit()
    conn.close()
    return path


def _head_db(path: Path, project_name: str) -> Path:
    upgrade_database_file(path)
    conn = sqlite3.connect(str(path))
    conn.execute(
        "INSERT INTO users (id, username, password_hash, created_at) "
        "VALUES (1, 'Researcher', '', '2026-09-24 00:00:00')"
    )
    conn.execute(
        "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) "
        "VALUES (1, 1, ?, 'active', '2026-09-24 00:00:00', '2026-09-24 00:00:00')",
        (project_name,),
    )
    conn.commit()
    conn.close()
    return path


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _project_name(db: Path) -> str:
    conn = sqlite3.connect(str(db))
    try:
        return conn.execute("SELECT name FROM projects WHERE id = 1").fetchone()[0]
    finally:
        conn.close()


@pytest.fixture
def install(tmp_path):
    """A live install at this build's head, holding the CURRENT project."""
    live = _head_db(tmp_path / "live.db", "CURRENT")
    return SimpleNamespace(
        db=live, docs=tmp_path / "docs", media=tmp_path / "media", backups=tmp_path / "backups",
        tmp=tmp_path,
    )


def _older_backup(install) -> Path:
    old = _baseline_db(install.tmp / "old.db", "FROM THE OLD BACKUP")
    info = create_backup(old, install.docs, install.media, install.backups, "auto", False)
    return install.backups / info.filename


def _newer_backup(install, *, app_version: str, revision: str | None, monkeypatch) -> Path:
    newer = _head_db(install.tmp / "newer.db", "FROM A NEWER BUILD")
    conn = sqlite3.connect(str(newer))
    if revision is None:
        conn.execute("DROP TABLE alembic_version")
    else:
        stamp_revision(conn, revision)
    conn.commit()
    conn.close()
    with monkeypatch.context() as m:  # only the manifest may claim the other version
        m.setattr(backup_service, "APP_VERSION", app_version)
        info = create_backup(newer, install.docs, install.media, install.backups, "manual")
    return install.backups / info.filename


# ── what this build can read ───────────────────────────────────────────────


class TestClassifyRevision:
    def test_the_three_answers(self):
        script = _script()
        assert classify_revision(script.get_current_head()) == "current"
        assert classify_revision(script.get_base()) == "older"
        assert classify_revision("ffffffffffff") == "unknown"
        assert classify_revision(None) == "unknown"

    def test_every_revision_in_the_chain_is_one_this_build_can_bring_forward(self):
        """POPULATION: an `older` that silently shrank to a few revisions would
        refuse real backups as 'unknown'."""
        revisions = [s.revision for s in _script().walk_revisions()]
        assert len(revisions) > 20
        assert {classify_revision(r) for r in revisions} == {"current", "older"}


class TestUpgradingAFileThatIsNotTheRunningDatabase:
    def test_it_reaches_head_and_leaves_no_wal_to_lose_in_a_move(self, tmp_path):
        db = _baseline_db(tmp_path / "old.db", "x")
        assert upgrade_database_file(db) == head_revision()
        assert list(tmp_path.glob("old.db-*")) == [], "a -wal left here would be lost when only the .db moves"
        assert _project_name(db) == "x"

    def test_it_does_not_reset_the_running_servers_logging(self, tmp_path):
        """It runs INSIDE a request. `env.py` calls `fileConfig` whenever it is given
        `alembic.ini`, which replaces root's handlers — harmless once at startup,
        not mid-flight. Asserted on logger STATE, never captured output (#631)."""
        import app.main  # noqa: F401 — the app's own logging configuration

        root_before = list(logging.getLogger().handlers)
        upgrade_database_file(_baseline_db(tmp_path / "old.db", "x"))
        assert logging.getLogger().handlers == root_before
        assert logging.getLogger("app.services.backup").isEnabledFor(logging.ERROR)


# ── an OLDER backup ────────────────────────────────────────────────────────


class TestAnOlderBackup:
    def test_the_preview_says_it_will_be_upgraded(self, install):
        preview = validate_backup(_older_backup(install))
        notes = [w for w in preview.warnings if "earlier version" in w]
        assert len(notes) == 1
        assert "will be upgraded to this version" in notes[0]
        assert "not changed" in notes[0]

    def test_it_is_restored_at_THIS_version_and_the_app_can_read_it(self, install):
        archive = _older_backup(install)
        archive_digest = _digest(archive)

        restore_from_backup(archive, install.db, install.docs, install.media, install.backups)

        assert database_file_revision(install.db) == head_revision()
        assert _project_name(install.db) == "FROM THE OLD BACKUP"
        # The audit's symptom: the running app's first read of a newer column.
        engine = create_engine(f"sqlite:///{install.db}")
        with engine.connect() as conn:
            conn.execute(text("SELECT code_set_id FROM codes")).fetchall()
        engine.dispose()
        assert _digest(archive) == archive_digest, "the backup file itself was changed"

    def test_a_migration_that_fails_changes_nothing(self, install, monkeypatch):
        archive = _older_backup(install)
        live_before = _digest(install.db)

        def fails(path):
            raise RuntimeError("simulated migration failure")

        monkeypatch.setattr(backup_service, "upgrade_database_file", fails)
        with pytest.raises(ValueError) as exc:
            restore_from_backup(archive, install.db, install.docs, install.media, install.backups)

        assert "could not be upgraded" in str(exc.value)
        assert "Nothing has been changed" in str(exc.value)
        assert _digest(install.db) == live_before
        assert database_file_revision(install.db) == head_revision()

    def test_an_upgrade_that_reports_success_but_did_not_happen_is_refused(
        self, install, monkeypatch
    ):
        """The shape of `env.py` ignoring the path it was given and migrating the
        RUNNING database instead: no error, and the staged file still old. The
        re-check after the upgrade is what stops that file being swapped in."""
        archive = _older_backup(install)
        live_before = _digest(install.db)
        monkeypatch.setattr(backup_service, "upgrade_database_file", lambda path: None)

        with pytest.raises(ValueError) as exc:
            restore_from_backup(archive, install.db, install.docs, install.media, install.backups)

        assert "could not be upgraded" in str(exc.value)
        assert _digest(install.db) == live_before


# ── a backup this build CANNOT read ────────────────────────────────────────


class TestABackupThisBuildCannotRead:
    def test_from_a_newer_version_it_is_refused_by_name_before_anything_happens(
        self, install, monkeypatch
    ):
        archive = _newer_backup(install, app_version="9.9.9", revision="ffffffffffff",
                                monkeypatch=monkeypatch)
        live_before = _digest(install.db)

        with pytest.raises(ValueError) as preview_exc:
            validate_backup(archive)
        message = str(preview_exc.value)
        assert "Mixed Measures 9.9.9, which is newer than this version" in message
        assert APP_VERSION in message
        assert "Nothing has been changed" in message

        with pytest.raises(ValueError) as restore_exc:
            restore_from_backup(archive, install.db, install.docs, install.media, install.backups)
        assert str(restore_exc.value) == message
        assert _digest(install.db) == live_before
        assert not list(install.backups.glob("pre_restore_*")), (
            "a pre-restore backup was taken for a restore that was always going to be refused"
        )

    def test_same_version_label_but_a_revision_this_build_lacks(self, install, monkeypatch):
        """A newer DEV build still says 1.5.3 until the cut bumps it — "newer than
        this version (1.5.3)" would be nonsense beside "made by 1.5.3"."""
        archive = _newer_backup(install, app_version=APP_VERSION, revision="ffffffffffff",
                                monkeypatch=monkeypatch)
        with pytest.raises(ValueError) as exc:
            validate_backup(archive)
        assert "cannot read (database version ffffffffffff)" in str(exc.value)
        assert "newer than" not in str(exc.value)

    def test_a_database_that_records_no_version_is_refused(self, install, monkeypatch):
        archive = _newer_backup(install, app_version=APP_VERSION, revision=None,
                                monkeypatch=monkeypatch)
        with pytest.raises(ValueError) as exc:
            validate_backup(archive)
        assert "it records no database version" in str(exc.value)

    def test_the_refusal_reaches_the_researcher_as_a_400_with_its_sentence(
        self, install, monkeypatch
    ):
        archive = _newer_backup(install, app_version="9.9.9", revision="ffffffffffff",
                                monkeypatch=monkeypatch)
        monkeypatch.setattr(backup_router, "get_backup_dir", lambda: install.backups)
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            backup_router.backup_validate_local(archive.name, user=SimpleNamespace(id=1))
        assert exc.value.status_code == 400
        assert "9.9.9" in exc.value.detail


# ── the data repairs startup runs ──────────────────────────────────────────


class TestTheRestoredDatabaseGetsStartupsRepairs:
    def test_they_run_on_the_new_file_after_the_swap_while_the_gate_is_held(
        self, tmp_path, monkeypatch
    ):
        events: list[str] = []
        gate = DatabaseGate()
        (tmp_path / "manual_20260101_000000.mmbackup").write_bytes(b"x")
        monkeypatch.setattr(backup_router, "get_backup_dir", lambda: tmp_path)
        monkeypatch.setattr(backup_router, "db_gate", gate)
        monkeypatch.setattr(backup_router.engine, "dispose", lambda: events.append("dispose"))

        def restore(*a, **k):
            events.append("swap")
            return SimpleNamespace(filename="pre_restore_x.mmbackup", created_at="2026-01-01T00:00:00+00:00")

        def repairs(session_factory):
            assert session_factory is backup_router.SessionLocal
            assert gate.restoring, "repairs ran after other requests were let back in"
            events.append("repairs")

        monkeypatch.setattr(backup_router, "restore_from_backup", restore)
        monkeypatch.setattr(backup_router, "run_data_repairs", repairs)
        db = SimpleNamespace(add=lambda _: None, commit=lambda: None, close=lambda: None)

        backup_router.backup_restore_local(
            "manual_20260101_000000.mmbackup", user=SimpleNamespace(id=1), db=db
        )
        assert events == ["dispose", "swap", "dispose", "repairs"]

    def test_they_do_not_run_when_the_restore_failed(self, tmp_path, monkeypatch):
        (tmp_path / "manual_20260101_000000.mmbackup").write_bytes(b"x")
        monkeypatch.setattr(backup_router, "get_backup_dir", lambda: tmp_path)
        monkeypatch.setattr(backup_router, "db_gate", DatabaseGate())
        monkeypatch.setattr(backup_router.engine, "dispose", lambda: None)
        ran: list[int] = []

        def refused(*a, **k):
            raise ValueError("This backup cannot be restored here.")

        monkeypatch.setattr(backup_router, "restore_from_backup", refused)
        monkeypatch.setattr(backup_router, "run_data_repairs", lambda f: ran.append(1))
        db = SimpleNamespace(add=lambda _: None, commit=lambda: None, close=lambda: None)
        from fastapi import HTTPException

        with pytest.raises(HTTPException):
            backup_router.backup_restore_local(
                "manual_20260101_000000.mmbackup", user=SimpleNamespace(id=1), db=db
            )
        assert ran == []

    def test_startup_runs_the_same_list(self, monkeypatch):
        """One list, two callers — the next repair added reaches a restore too."""
        from starlette.testclient import TestClient

        import app.services.data_repairs as data_repairs
        from app.main import app

        calls: list[object] = []
        monkeypatch.setattr(data_repairs, "run_data_repairs", lambda f: calls.append(f))
        with TestClient(app):
            pass
        assert len(calls) == 1
