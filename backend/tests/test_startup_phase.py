"""#1362: the backend tells the shell when it is UPDATING its database.

The lifespan migrates before uvicorn serves, so `/health` cannot answer until the update
has committed — and the shell gave the whole startup a fixed 60 s. A 1.0 project of 400k
turns took 78 s to its first `/health` on SQLCipher (measured), so the shell killed a
healthy update, and on Windows that undid it at every launch.

`run_migrations` now writes `MM-PHASE: migrating` before the pre-migration copy and
`MM-PHASE: migrated` after the commit, through the fatal line's own writer, and the shell
(`electron/backend-process.js::createStartupDeadline`) waits for the update under its own
deadline. These tests enter at `run_migrations` itself.
"""
import io
import re
import shutil
import sqlite3
from pathlib import Path

import pytest

from app import config, database
from app.database import _script_only_alembic_config, run_migrations, upgrade_database_file
from app.startup_errors import MM_PHASE_PREFIX, STARTUP_PHASES, emit_startup_phase
from tests.test_migration_atomicity import PARTWAY, _head_db, _scripts


def _baseline(path: Path) -> Path:
    from alembic import command
    from alembic.script import ScriptDirectory

    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(path)
    command.upgrade(cfg, ScriptDirectory.from_config(cfg).get_base())
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'r', '', '2026-06-19')")
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def events(monkeypatch, tmp_path):
    """What `run_migrations` announced, in order, beside the pre-migration copy."""
    seen = []
    monkeypatch.setattr(database, "emit_startup_phase", lambda phase: seen.append(phase))
    real_backup = database._backup_database

    def backup(db_path):
        seen.append("copy")
        return real_backup(db_path)

    monkeypatch.setattr(database, "_backup_database", backup)
    monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")
    return seen


def _point_at(monkeypatch, db: Path):
    monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)


def test_a_pending_update_is_announced_before_its_copy_and_after_its_commit(tmp_path, monkeypatch, events):
    db = _baseline(tmp_path / "old.db")
    _point_at(monkeypatch, db)
    run_migrations()
    assert events == ["migrating", "copy", "migrated"]


def test_at_head_nothing_is_announced(tmp_path, monkeypatch, events):
    db = _baseline(tmp_path / "old.db")
    _point_at(monkeypatch, db)
    run_migrations()
    events.clear()
    run_migrations()  # now at head
    assert events == []


def test_a_failed_update_is_never_announced_as_migrated(tmp_path, monkeypatch, events):
    """The fatal line follows instead; `migrated` would put the shell back on 60 s."""
    db = _head_db(tmp_path, None)
    base = tmp_path / "build"
    base.mkdir()
    shutil.copy(config.resource_base() / "alembic.ini", base / "alembic.ini")
    shutil.copytree(_scripts(tmp_path, PARTWAY), base / "alembic")
    monkeypatch.setattr(database, "resource_base", lambda: base)
    _point_at(monkeypatch, db)
    with pytest.raises(database.MigrationFailedError):
        run_migrations()
    assert events == ["migrating", "copy"]


def test_a_restore_bringing_a_backup_forward_announces_nothing(tmp_path, events):
    """It runs INSIDE a request; no shell is waiting on a startup deadline then."""
    upgrade_database_file(_baseline(tmp_path / "staged.db"))
    assert events == []


class TestTheLine:
    def test_it_is_one_ascii_line_written_as_bytes(self):
        class Stream(io.TextIOWrapper):
            pass
        raw = io.BytesIO()
        out = Stream(raw, encoding="cp1252")  # the frozen Windows interpreter's (#762)
        emit_startup_phase("migrating", stream=out)
        assert raw.getvalue() == b"\nMM-PHASE: migrating\n"

    def test_an_unknown_phase_is_refused_by_the_writer(self):
        with pytest.raises(ValueError):
            emit_startup_phase("almost-done", stream=io.StringIO())

    def test_no_stderr_is_not_an_error(self, monkeypatch):
        monkeypatch.setattr("sys.stderr", None)
        emit_startup_phase("migrated")  # PyInstaller windowed: sys.stderr is None


class TestCrossLanguageContract:
    """Hand-mirrored in `electron/fatal-error.js`, like MM_FATAL_PREFIX."""

    def _js(self) -> str:
        js = Path(__file__).resolve().parents[2] / "electron" / "fatal-error.js"
        assert js.exists()
        return js.read_text(encoding="utf-8")

    def test_the_shell_reads_the_same_prefix(self):
        found = re.search(r"^const MM_PHASE_PREFIX = '([^']*)'", self._js(), re.M)
        assert found and found.group(1) == MM_PHASE_PREFIX

    def test_the_shell_knows_the_same_phases(self):
        found = re.search(r"^const STARTUP_PHASES = \[([^\]]*)\]", self._js(), re.M)
        assert found
        assert tuple(re.findall(r"'([^']*)'", found.group(1))) == STARTUP_PHASES
