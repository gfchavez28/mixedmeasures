"""Batch 8: what a backup or a restore leaves when it is stopped, and the restore's
remaining size and failure claims (#1080, #1036, #1084, #1043, #1039 e/f).

What these guard, and why each is here:

- **Nothing stages in OS temp, and what a killed writer leaves is swept (#1080).**
  A `kill -9` 4.5 s into an on-quit backup left a 205 MB copy of the database in
  `/tmp` and a hidden `.partial` in the backup folder, and nothing ever removed
  either. A Windows quit is `taskkill /F`, so this is every Windows quit that lands
  during a backup. The kill is REAL here: a child process, SIGKILLed mid-ZIP.
- **The sweep removes only what nobody is writing** — an entry untouched for an
  hour, named the way a writer of this app stages — and is WIRED into startup and
  the 4-hourly turn (a sweep nobody calls is #747's shape).
- **Recordings a stopped restore set aside come back at startup**, not at the next
  restore, which may never come — **but never while a restore that outlived its app
  is still running in another process (#1142)**: the restore holds a lock, and a
  start, or a second restore, leaves its keep folder alone while it does.
- **A backup in the app's own folder restores whatever its size (#1036 a)**; the
  20 GB unpacking cap stays for a file from outside.
- **The database is swapped in by one rename, its old companion files removed
  FIRST (#1036 b)**, and a failure before the swap says that nothing changed
  (#1036 d) instead of "failed partway … restore that backup".
- **The restored database records the restore (#1084 c)**, and a turn the gate
  skipped is retried in minutes (#1084 b).
- **`0` turns automatic backups off; a value with no meaning refuses to start
  (#1043)**, and the status says which schedule this install runs.
- **The name patterns are exact, rotation keeps to its own database, and a row's
  time is the one in its name (#1039 e/f).**
"""

import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import errno
import json
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import database
from app import main as app_main
from app.routers import backup as backup_router
from app.services import backup as backup_service
from app.services import safety_copies
from app.services.backup import (
    AUTO_BACKUP_BUSY_RETRY_SECONDS,
    BACKUP_COMPRESS_LEVEL,
    STAGING_ABANDONED_AFTER_SECONDS,
    BackupSettingsError,
    RestoreError,
    RestoreNotStarted,
    check_backup_settings,
    create_backup,
    get_backup_status,
    is_staging_name,
    list_backups,
    parse_backup_name,
    recover_interrupted_restore,
    restore_from_backup,
    sweep_abandoned_staging,
    validate_backup,
)
from app.services.restore_gate import RestoreRefused
from app.startup_errors import FatalStartupError
from tests.backup_support import stamp_revision

BACKEND = Path(__file__).resolve().parents[1]
HOUR_AGO = time.time() - STAGING_ABANDONED_AFTER_SECONDS - 60


def _db(path: Path, name: str = "Study") -> Path:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    for t in ("conversations", "datasets", "documents", "observations"):
        conn.execute(f"CREATE TABLE {t} (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("INSERT INTO projects VALUES (1, ?)", (name,))
    stamp_revision(conn)
    conn.commit()
    conn.close()
    return path


def _project_name(path: Path) -> str:
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute("SELECT name FROM projects WHERE id = 1").fetchone()[0]
    finally:
        conn.close()


def _age(path: Path, when: float = HOUR_AGO) -> Path:
    """Backdate an entry and everything in it, as an abandoned one would be."""
    for root, dirs, files in os.walk(path) if path.is_dir() else []:
        for n in dirs + files:
            os.utime(os.path.join(root, n), (when, when))
    os.utime(path, (when, when))
    return path


@pytest.fixture
def os_temp(tmp_path, monkeypatch) -> Path:
    """OS temp pointed at a folder of its own: anything a writer puts there by
    calling `tempfile` WITHOUT a folder lands here, and the test can see it."""
    folder = tmp_path / "os-temp"
    folder.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(folder))
    return folder


# ── #1080: a writer stopped partway ─────────────────────────────────────────


class TestNothingStagesInOsTemp:
    def test_a_backup_stages_its_snapshot_inside_the_backup_folder(self, tmp_path, os_temp, monkeypatch):
        db = _db(tmp_path / "live.db")
        backups = tmp_path / "backups"
        seen: list[Path] = []
        real = backup_service.snapshot_database_file

        def spy(src, dest, **kw):
            seen.append(Path(dest))
            return real(src, dest, **kw)

        monkeypatch.setattr(backup_service, "snapshot_database_file", spy)
        create_backup(db, tmp_path / "docs", tmp_path / "media", backups, "auto")

        assert len(seen) == 1
        staging = seen[0].parent
        assert staging.parent == backups, f"the snapshot was written to {staging}"
        assert is_staging_name(staging.name)
        assert not staging.exists(), "the staging folder outlived a finished backup"
        assert list(os_temp.iterdir()) == []

    def test_validation_and_restore_stage_nothing_in_os_temp(self, tmp_path, os_temp, monkeypatch):
        db = _db(tmp_path / "live.db")
        backups = tmp_path / "backups"
        info = create_backup(db, tmp_path / "docs", tmp_path / "data" / "media", backups, "manual")
        # WHERE the preview's probe lands, seen while it exists: a probe staged in OS
        # temp and removed afterwards leaves OS temp empty too (a mutant passed that).
        probed: list[Path] = []
        real_probe = backup_service._assert_backup_db_readable

        def spy(path):
            probed.append(Path(path))
            return real_probe(path)

        monkeypatch.setattr(backup_service, "_assert_backup_db_readable", spy)
        validate_backup(backups / info.filename)
        assert probed and probed[0].parent.parent == backups, f"probe staged at {probed[0].parent}"
        assert is_staging_name(probed[0].parent.name)
        restore_from_backup(backups / info.filename, db, tmp_path / "docs", tmp_path / "data" / "media", backups)
        assert list(os_temp.iterdir()) == []
        for folder in (tmp_path, backups, tmp_path / "data"):
            assert [p.name for p in folder.iterdir() if is_staging_name(p.name)] == []


_KILL_CHILD = r"""
import os, sys, time, zipfile
os.environ["MM_DATABASE_PATH"] = ":memory:"
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from app.services.backup import create_backup

work = Path(sys.argv[2])
signal_file = work / "zipping"
real_write = zipfile.ZipFile.write

def slow_write(self, filename, arcname=None, *a, **k):
    real_write(self, filename, arcname, *a, **k)
    if arcname == "database.db":
        signal_file.write_text("x")
        time.sleep(60)   # the parent kills us here, mid-archive

zipfile.ZipFile.write = slow_write
create_backup(work / "live.db", work / "docs", work / "media", work / "backups", "shutdown")
"""


def test_a_backup_killed_mid_write_leaves_only_what_the_sweep_removes(tmp_path):
    """#1080's reproduction, end to end: a REAL SIGKILL, so no `finally` runs.

    Before: the snapshot was in OS temp (here, the child's TMPDIR) and stayed
    there; the `.partial` stayed in the backup folder; nothing swept either.
    """
    if not hasattr(signal, "SIGKILL"):
        pytest.skip("needs SIGKILL")  # Windows; the same defect is a taskkill /F there
    _db(tmp_path / "live.db")
    child_tmp = tmp_path / "child-os-temp"
    child_tmp.mkdir()
    env = {**os.environ, "TMPDIR": str(child_tmp), "MM_DATABASE_PATH": ":memory:"}
    proc = subprocess.Popen(
        [sys.executable, "-c", _KILL_CHILD, str(BACKEND), str(tmp_path)],
        env=env, cwd=str(BACKEND),
    )
    try:
        deadline = time.time() + 60
        while not (tmp_path / "zipping").exists():
            assert proc.poll() is None, "the child exited before it began the archive"
            assert time.time() < deadline, "the child never reached the archive"
            time.sleep(0.05)
        proc.send_signal(signal.SIGKILL)
        proc.wait(10)
    finally:
        if proc.poll() is None:
            proc.kill()

    backups = tmp_path / "backups"
    left = sorted(p.name for p in backups.iterdir())
    assert left, "precondition: the kill landed after staging began"
    assert all(is_staging_name(n) for n in left), f"a killed backup left {left}"
    assert list_backups(backups) == [], "a half-written backup was listed"
    assert list(child_tmp.iterdir()) == [], "the killed backup left files in OS temp"

    # A live writer is never swept…
    assert sweep_abandoned_staging(backups) == 0
    # …and an abandoned one is.
    for name in left:
        _age(backups / name)
    assert sweep_abandoned_staging(backups) == len(left)
    assert list(backups.iterdir()) == []


class TestTheSweep:
    def _plant(self, folder: Path) -> dict[str, Path]:
        folder.mkdir(parents=True, exist_ok=True)
        planted = {}
        # Every staging shape a writer of this app has used (1.5.4–1.5.6).
        staging_dir = folder / ".auto_20260101_000000.mmbackup.abc123.partial"
        (staging_dir).mkdir()
        (staging_dir / "database.db").write_bytes(b"x" * 100)
        planted["backup staging folder"] = staging_dir
        for name in (
            ".auto_20260101_000000.mmbackup.k3j2.partial",       # 1.5.5's ZIP
            ".upload_9fj2.partial",                              # an upload
            ".pre-merge_3_20260101_000000.mmproject.partial",    # a safety copy
            ".dev_20260101_000000.db.partial",                   # a pre-migration copy
            ".dev_20260101_000000.db.partial-journal",           # …and its journal
        ):
            (folder / name).write_bytes(b"x")
            planted[name] = folder / name
        for p in planted.values():
            _age(p)
        return planted

    def _keepers(self, folder: Path) -> list[Path]:
        keep = []
        for name in (
            "auto_20260101_000000.mmbackup",
            "pre-merge_3_20260101_000000.mmproject",
            "dev_20260101_000000.db",
            "notes.partial",          # not hidden: not ours
            ".DS_Store",              # hidden, not staging
        ):
            (folder / name).write_bytes(b"x")
            keep.append(_age(folder / name))
        return keep

    def test_it_removes_every_abandoned_staging_shape_and_nothing_else(self, tmp_path):
        folder = tmp_path / "backups"
        planted = self._plant(folder)
        keep = self._keepers(folder)
        assert sweep_abandoned_staging(folder) == len(planted)
        assert sorted(p.name for p in folder.iterdir()) == sorted(p.name for p in keep)

    def test_an_entry_still_being_written_is_left(self, tmp_path):
        """The age is the NEWEST write anywhere inside the entry: a folder whose own
        time is old but whose snapshot is still growing belongs to a live writer
        (another process — an update relaunch leaves the old backend finishing its
        on-quit backup while the new one sweeps)."""
        folder = tmp_path / "backups"
        live = folder / ".auto_20260101_000000.mmbackup.live.partial"
        live.mkdir(parents=True)
        (live / "database.db").write_bytes(b"growing")
        os.utime(live, (HOUR_AGO, HOUR_AGO))           # the folder looks old…
        fresh_file = folder / ".upload_live.partial"
        fresh_file.write_bytes(b"x")                    # …and this is just written
        assert sweep_abandoned_staging(folder) == 0
        assert live.exists() and fresh_file.exists()

    def test_it_never_raises(self, tmp_path, monkeypatch):
        assert sweep_abandoned_staging(tmp_path / "missing") == 0

        def boom(self):
            raise PermissionError("denied")

        monkeypatch.setattr(Path, "iterdir", boom)
        assert sweep_abandoned_staging(tmp_path) == 0

    def test_beside_the_database_only_the_restores_own_staging_is_touched(self, tmp_path):
        """That folder can be anyone's — in development it is `backend/`."""
        db = tmp_path / "mixedmeasures.db"
        ours = tmp_path / ".mixedmeasures.db.restore.k2.partial"
        ours.mkdir()
        (ours / "database.db").write_bytes(b"x")
        theirs = tmp_path / ".something-else.partial"
        theirs.write_bytes(b"x")
        _age(ours), _age(theirs)
        recover_interrupted_restore(db, tmp_path / "data" / "media")
        assert not ours.exists()
        assert theirs.exists()


class TestTheSweepIsWired:
    def test_startup_sweeps_and_puts_set_aside_recordings_back(self, tmp_path, monkeypatch):
        """Entered at the pipeline's mouth (#747): the lifespan itself."""
        from fastapi.testclient import TestClient

        backups, data = tmp_path / "backups", tmp_path / "data"
        backups.mkdir()
        abandoned = backups / ".shutdown_20260101_000000.mmbackup.x.partial"
        abandoned.mkdir()
        (abandoned / "database.db").write_bytes(b"x")
        _age(abandoned)
        keep = data / ".video_keep_restore_tmp" / "3" / "7"
        keep.mkdir(parents=True)
        (keep / "original.mp4").write_bytes(b"the only copy")
        monkeypatch.setattr(app_main, "get_backup_dir", lambda: backups)
        monkeypatch.setattr(app_main, "get_media_dir", lambda: data / "media")
        monkeypatch.setattr(app_main, "get_documents_dir", lambda: data / "documents")

        with TestClient(app_main.app):
            pass

        assert not abandoned.exists(), "startup did not sweep the backup folder"
        assert (data / "media" / "3" / "7" / "original.mp4").read_bytes() == b"the only copy"
        assert not (data / ".video_keep_restore_tmp").exists()

    def test_every_automatic_turn_sweeps_before_it_backs_up(self, tmp_path):
        db = _db(tmp_path / "live.db")
        backups = tmp_path / "backups"
        backups.mkdir()
        abandoned = backups / ".upload_x.partial"
        abandoned.write_bytes(b"x")
        _age(abandoned)
        assert app_main._run_auto_backup(db, tmp_path / "docs", tmp_path / "media", backups, 5)
        assert not abandoned.exists()
        assert [b.backup_type for b in list_backups(backups)] == ["auto"]


def test_startup_puts_recordings_back_without_overwriting(tmp_path):
    """The never-overwrite rule of #550 holds at startup too: a file already at the
    path wins and the kept copy stays where it is."""
    media = tmp_path / "data" / "media"
    (media / "1").mkdir(parents=True)
    (media / "1" / "a.mp4").write_bytes(b"present")
    keep = tmp_path / "data" / ".video_keep_restore_tmp" / "1"
    keep.mkdir(parents=True)
    (keep / "a.mp4").write_bytes(b"kept")
    (keep / "b.mp4").write_bytes(b"kept b")
    recover_interrupted_restore(tmp_path / "x.db", media)
    assert (media / "1" / "a.mp4").read_bytes() == b"present"
    assert (keep / "a.mp4").read_bytes() == b"kept"
    assert (media / "1" / "b.mp4").read_bytes() == b"kept b"


# ── #1142: a restore that outlives its app ──────────────────────────────────
#
# On macOS and Linux the shell never force-stops the backend after a quit (#1142),
# so a restore can still be running when the app is opened again, and the new
# backend starts beside it on the same data folder. #1080 (1.5.6) made every start
# put back the recordings a stopped restore had set aside — and a start that landed
# inside a RUNNING restore put them back moments before that restore deleted
# `media/`: the only copy of each, gone (executed 2026-10-08 by the audit's probe).
# The restore now holds a lock from first step to last, and the other process
# leaves its keep folder and staging alone while it does.
#
# The "other process" in these tests is a REAL one, because the property lives
# between processes: the relaunched start, and the lock holder that stands in for a
# running restore (and is then killed), are child processes.

_RECORDING = b"the only copy of the recording"

needs_flock = pytest.mark.skipif(
    backup_service.fcntl is None,
    reason="POSIX only: Windows has no flock, and no restore outlives its app there",
)

_HOLD_THE_LOCK = r"""
import os, sys
os.environ["MM_DATABASE_PATH"] = ":memory:"
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from app.services.backup import _restore_lock
with _restore_lock(Path(sys.argv[2])) as lock:
    Path(sys.argv[3]).write_text(lock)
    sys.stdin.read()   # held until the test closes our stdin, or kills us
"""

_RELAUNCHED_STARTUP = r"""
import os, sys
os.environ["MM_DATABASE_PATH"] = ":memory:"
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from app.services.backup import recover_interrupted_restore
recover_interrupted_restore(Path(sys.argv[2]), Path(sys.argv[3]))
"""


def _install_with_a_recording(tmp_path: Path):
    """A live install holding a recording its backup LEAVES OUT — every automatic
    backup excludes video — so restoring that backup sets the recording aside, and
    the keep folder holds the only copy until the restore puts it back."""
    db = _db(tmp_path / "live.db")
    docs = tmp_path / "data" / "documents"
    docs.mkdir(parents=True)
    media = tmp_path / "data" / "media"
    (media / "1" / "1").mkdir(parents=True)
    (media / "1" / "1" / "original.mp4").write_bytes(_RECORDING)
    backups = tmp_path / "backups"
    info = create_backup(db, docs, media, backups, "auto", include_video=False)
    return db, docs, media, backups, backups / info.filename


class _LockHolder:
    """Another process holding the restore lock — a restore running there."""

    def __init__(self, tmp_path: Path, data_parent: Path):
        self.ready = tmp_path / "lock-state"
        self.proc = subprocess.Popen(
            [sys.executable, "-c", _HOLD_THE_LOCK, str(BACKEND), str(data_parent), str(self.ready)],
            stdin=subprocess.PIPE, cwd=str(BACKEND),
            env={**os.environ, "MM_DATABASE_PATH": ":memory:"},
        )
        deadline = time.time() + 30
        while not self.ready.exists() or not self.ready.read_text():
            assert self.proc.poll() is None, "the lock holder exited before taking the lock"
            assert time.time() < deadline, "the lock holder never took the lock"
            time.sleep(0.05)
        assert self.ready.read_text() == backup_service.LOCK_HELD, "precondition: it holds the lock"

    def release(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(30)

    def kill(self) -> None:
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(30)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(30)


@needs_flock
class TestARestoreThatOutlivesItsApp:
    def test_a_relaunched_start_leaves_a_running_restores_recording_alone(self, tmp_path, monkeypatch):
        """The 2026-10-08 reproduction: the restore paused between setting the
        recording aside and tearing `media/` down, and a relaunched backend's startup
        run in ANOTHER process. Before the lock it moved the recording back into
        `media/`, and the teardown deleted it."""
        db, docs, media, backups, archive = _install_with_a_recording(tmp_path)
        recording = media / "1" / "1" / "original.mp4"
        kept = media.parent / backup_service.VIDEO_KEEP_DIR_NAME / "1" / "1" / "original.mp4"

        real_rmtree = backup_service.shutil.rmtree
        at_teardown, resume = threading.Event(), threading.Event()

        def paused(path, *a, **k):
            if Path(str(path)) == media and not at_teardown.is_set():
                at_teardown.set()
                resume.wait(30)
            return real_rmtree(path, *a, **k)

        monkeypatch.setattr(backup_service.shutil, "rmtree", paused)
        errors: list[BaseException] = []

        def restore():
            try:
                restore_from_backup(archive, db, docs, media, backups)
            except BaseException as e:  # noqa: BLE001 - reported by the assertion below
                errors.append(e)

        worker = threading.Thread(target=restore)
        worker.start()
        try:
            assert at_teardown.wait(30), "the restore never reached the media teardown"
            assert kept.read_bytes() == _RECORDING and not recording.exists(), (
                "precondition: the keep folder holds the only copy"
            )
            startup = subprocess.run(
                [sys.executable, "-c", _RELAUNCHED_STARTUP, str(BACKEND), str(db), str(media)],
                cwd=str(BACKEND), env={**os.environ, "MM_DATABASE_PATH": ":memory:"},
                capture_output=True, text=True, timeout=60,
            )
            assert startup.returncode == 0, startup.stderr
            assert "still running in another Mixed Measures process" in startup.stderr
            assert kept.read_bytes() == _RECORDING, "the relaunched start moved the recording"
        finally:
            resume.set()
            worker.join(60)
        assert errors == []
        assert recording.read_bytes() == _RECORDING, "the running restore's recording was lost"
        assert not kept.parent.parent.exists()

    def test_a_killed_restore_leaves_no_lock_so_the_next_start_puts_its_recording_back(self, tmp_path):
        """#1080's point survives the lock: the OS drops a `flock` with the process
        that held it, so a restore that was KILLED (no `finally` runs) blocks nothing."""
        media = tmp_path / "data" / "media"
        media.mkdir(parents=True)
        kept = media.parent / backup_service.VIDEO_KEEP_DIR_NAME / "1" / "1" / "original.mp4"
        kept.parent.mkdir(parents=True)
        kept.write_bytes(_RECORDING)
        holder = _LockHolder(tmp_path, media.parent)
        try:
            recover_interrupted_restore(tmp_path / "live.db", media)
            assert kept.read_bytes() == _RECORDING, "a start moved a running restore's recording"
            holder.kill()
            recover_interrupted_restore(tmp_path / "live.db", media)
        finally:
            holder.close()
        assert (media / "1" / "1" / "original.mp4").read_bytes() == _RECORDING
        assert not kept.exists()

    def test_a_restore_is_refused_while_another_process_restores(self, tmp_path, monkeypatch, db_session):
        """The restore gate is per process; the lock is what spans them. Refused
        before anything is read or written — the door answers 409, nothing changed."""
        db, docs, media, backups, archive = _install_with_a_recording(tmp_path)
        before = sorted(p.name for p in backups.iterdir())
        holder = _LockHolder(tmp_path, media.parent)
        try:
            with pytest.raises(RestoreRefused) as refused:
                restore_from_backup(archive, db, docs, media, backups)
            assert refused.value.reason == "restoring_elsewhere"

            monkeypatch.setattr(backup_router, "engine", SimpleNamespace(dispose=lambda: None))
            monkeypatch.setattr(backup_router, "_get_paths", lambda: (db, docs, media, backups))
            with pytest.raises(HTTPException) as door:
                backup_router._restore_in_place(archive, db=db_session, user_id=1, audit_details={})
            assert door.value.status_code == 409
            assert door.value.detail == backup_service.RESTORING_ELSEWHERE_MESSAGE
            assert "Nothing was changed." in door.value.detail
            gate = backup_router.db_gate
            assert gate.active == 0 and gate.restoring is False
            assert sorted(p.name for p in backups.iterdir()) == before, "a refused restore wrote a backup"
            assert (media / "1" / "1" / "original.mp4").read_bytes() == _RECORDING
            holder.release()
        finally:
            holder.close()
        restore_from_backup(archive, db, docs, media, backups)  # the lock is free again
        assert (media / "1" / "1" / "original.mp4").read_bytes() == _RECORDING


class TestWhereNoLockCanBeHad:
    def test_on_windows_a_start_puts_recordings_back_and_a_restore_runs(self, tmp_path, monkeypatch):
        """No `flock` there, and none needed: a quit is `taskkill /F`, so no restore
        outlives its app — and that kill is exactly when a start must put back."""
        monkeypatch.setattr(backup_service, "fcntl", None)
        db, docs, media, backups, archive = _install_with_a_recording(tmp_path)
        recording = media / "1" / "1" / "original.mp4"
        kept = media.parent / backup_service.VIDEO_KEEP_DIR_NAME / "1" / "1" / "original.mp4"
        kept.parent.mkdir(parents=True)
        recording.rename(kept)
        recover_interrupted_restore(db, media)
        assert recording.read_bytes() == _RECORDING
        restore_from_backup(archive, db, docs, media, backups)
        assert recording.read_bytes() == _RECORDING
        assert not (media.parent / backup_service.RESTORE_LOCK_NAME).exists()

    @needs_flock
    def test_a_lock_that_cannot_be_taken_holds_the_start_back_but_not_a_restore(self, tmp_path, monkeypatch):
        """The two callers read a failed lock oppositely, on purpose: a start that
        cannot tell leaves the keep folder for the next restore (1.5.5's behaviour,
        nothing lost); a restore — the way back from a disaster — must not depend on
        a lock, so it runs."""
        def refuse(fd, op):
            raise OSError(errno.ENOLCK, "No locks available")

        monkeypatch.setattr(backup_service.fcntl, "flock", refuse)
        db, docs, media, backups, archive = _install_with_a_recording(tmp_path)
        recording = media / "1" / "1" / "original.mp4"
        kept = media.parent / backup_service.VIDEO_KEEP_DIR_NAME / "1" / "1" / "original.mp4"
        kept.parent.mkdir(parents=True)
        recording.rename(kept)
        recover_interrupted_restore(db, media)
        assert kept.read_bytes() == _RECORDING and not recording.exists()
        restore_from_backup(archive, db, docs, media, backups)  # re-seats on entry
        assert recording.read_bytes() == _RECORDING


@needs_flock
def test_the_lock_file_is_neither_swept_nor_backed_up(tmp_path):
    """It is never deleted (a removed lock file lets two processes lock two files),
    so nothing that cleans up or copies the data folder may treat it as data."""
    db, docs, media, backups, archive = _install_with_a_recording(tmp_path)
    restore_from_backup(archive, db, docs, media, backups)
    lock = media.parent / backup_service.RESTORE_LOCK_NAME
    assert lock.exists(), "precondition: a restore created the lock file"
    assert not is_staging_name(lock.name)
    _age(lock)
    assert sweep_abandoned_staging(media.parent) == 0
    recover_interrupted_restore(db, media)
    assert lock.exists()
    info = create_backup(db, docs, media, backups, "manual")
    with zipfile.ZipFile(backups / info.filename) as zf:
        assert not [n for n in zf.namelist() if backup_service.RESTORE_LOCK_NAME in n]


def test_the_database_is_compressed_at_the_measured_level(tmp_path, monkeypatch):
    """The level is what lets the on-quit backup fit the shell's kill window (11.4 s
    → 4.1 s on a 469 MB database). Recordings stay stored."""
    seen: list[dict] = []
    real = zipfile.ZipFile

    class Spy(real):
        def __init__(self, *a, **k):
            seen.append(k)
            super().__init__(*a, **k)

    monkeypatch.setattr(backup_service.zipfile, "ZipFile", Spy)
    db = _db(tmp_path / "live.db")
    media = tmp_path / "media" / "1" / "1"
    media.mkdir(parents=True)
    (media / "original.mp4").write_bytes(b"video")
    info = create_backup(db, tmp_path / "docs", tmp_path / "media", tmp_path / "b", "manual")
    monkeypatch.setattr(backup_service.zipfile, "ZipFile", real)
    assert BACKUP_COMPRESS_LEVEL == 1
    assert seen[0].get("compresslevel") == BACKUP_COMPRESS_LEVEL
    with real(tmp_path / "b" / info.filename) as zf:
        assert zf.getinfo("database.db").compress_type == zipfile.ZIP_DEFLATED
        assert zf.getinfo("media/1/1/original.mp4").compress_type == zipfile.ZIP_STORED


# ── #1036: size, the swap, and what a failure says ──────────────────────────


def _live_install(tmp_path: Path, name: str = "IN THE BACKUP"):
    db = _db(tmp_path / "live.db", name)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.txt").write_text("doc")
    media = tmp_path / "data" / "media"
    (media / "1" / "1").mkdir(parents=True)
    (media / "1" / "1" / "original.mp3").write_bytes(b"audio")
    backups = tmp_path / "backups"
    info = create_backup(db, docs, media, backups, "manual")
    conn = sqlite3.connect(str(db))
    conn.execute("UPDATE projects SET name = 'AFTER THE BACKUP'")
    conn.commit()
    conn.close()
    return db, docs, media, backups, backups / info.filename


class TestTheUnpackingCapIsForFilesFromOutside:
    def test_the_cap_refuses_by_default_and_an_own_backup_passes(self, tmp_path):
        db, docs, media, backups, archive = _live_install(tmp_path)
        with pytest.raises(ValueError, match="limit"):
            validate_backup(archive, expansion_limit=10)
        validate_backup(archive, expansion_limit=None)
        with pytest.raises(ValueError, match="limit"):
            restore_from_backup(archive, db, docs, media, backups, expansion_limit=10)
        restore_from_backup(archive, db, docs, media, backups, expansion_limit=None)
        assert _project_name(db) == "IN THE BACKUP"

    def test_the_in_folder_doors_pass_no_cap_and_the_upload_door_keeps_it(self, tmp_path, monkeypatch, db_session):
        from app.services.archive_safety import MAX_ARCHIVE_EXPANDED_BYTES

        backups = tmp_path / "backups"
        backups.mkdir()
        name = "manual_20260101_000000.mmbackup"
        (backups / name).write_bytes(b"x")
        monkeypatch.setattr(backup_router, "get_backup_dir", lambda: backups)
        seen: dict[str, object] = {}

        def validate_spy(path, **kw):
            seen["validate"] = kw.get("expansion_limit", "default")
            raise ValueError("stop")

        monkeypatch.setattr(backup_router, "validate_backup", validate_spy)
        with pytest.raises(HTTPException):
            backup_router.backup_validate_local(name, user=SimpleNamespace(id=1))
        assert seen["validate"] is None

        def restore_spy(zip_path, *, db, user_id, audit_details, expansion_limit=MAX_ARCHIVE_EXPANDED_BYTES):
            seen["restore"] = expansion_limit
            return {"status": "restored"}

        monkeypatch.setattr(backup_router, "_restore_in_place", restore_spy)
        backup_router.backup_restore_local(name, user=SimpleNamespace(id=1), db=db_session)
        assert seen["restore"] is None

        class _Upload:
            filename = "from-elsewhere.mmbackup"
            _chunks = [b"x" * 10, b""]

            async def read(self, n):
                return self._chunks.pop(0)

        asyncio.run(backup_router.backup_restore(file=_Upload(), user=SimpleNamespace(id=1), db=None))
        assert seen["restore"] == MAX_ARCHIVE_EXPANDED_BYTES

    def test_the_preview_says_when_the_disk_is_too_small(self, tmp_path):
        *_, archive = _live_install(tmp_path)
        warned = validate_backup(archive, free_bytes=1).warnings
        assert any("free" in w and "stops before it replaces anything" in w for w in warned)
        assert not any("free" in w for w in validate_backup(archive, free_bytes=10**15).warnings)
        assert not any("free" in w for w in validate_backup(archive).warnings)


def _plant_after_the_pre_restore_backup(monkeypatch, db: Path, sides=("-wal",)) -> None:
    """Leave stale companion files beside the live database once the pre-restore
    backup has run. ⚠️ Planted any earlier they are proof of nothing: that backup
    OPENS the database, and SQLite removes stale `-wal`/`-shm`/`-journal` files on
    open (measured), so a restore that never removed them would pass — two
    mutants survived the first version of these tests exactly that way."""
    real = backup_service.create_backup

    def planting(*a, **k):
        info = real(*a, **k)
        if a[4] == "pre_restore":
            for side in sides:
                Path(f"{db}{side}").write_bytes(b"another database's pages")
        return info

    monkeypatch.setattr(backup_service, "create_backup", planting)


class TestTheSwap:
    def test_the_database_is_staged_beside_itself_and_renamed_into_place(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _live_install(tmp_path)
        wal = Path(f"{db}-wal")
        _plant_after_the_pre_restore_backup(monkeypatch, db)
        swaps: list[tuple[Path, Path, bool]] = []
        real = backup_service.os.replace

        def spy(src, dst):
            if Path(dst) == db:
                swaps.append((Path(src), Path(dst), wal.exists()))
            return real(src, dst)

        monkeypatch.setattr(backup_service.os, "replace", spy)
        restore_from_backup(archive, db, docs, media, backups)

        assert len(swaps) == 1, "the database was not swapped by one rename"
        src, _, wal_still_there = swaps[0]
        assert src.parent.parent == db.parent, f"staged at {src.parent}, not beside the database"
        assert is_staging_name(src.parent.name)
        assert wal_still_there is False, "the old -wal was still beside the file swapped in"
        assert _project_name(db) == "IN THE BACKUP"

    def test_companion_files_are_named_by_appending_whatever_the_database_is_called(self, tmp_path, monkeypatch):
        """`with_suffix(".db-wal")` named `live.sqlite`'s WAL `live.db-wal`."""
        db = _db(tmp_path / "live.sqlite")
        backups = tmp_path / "backups"
        info = create_backup(db, tmp_path / "docs", tmp_path / "media", backups, "manual")
        _plant_after_the_pre_restore_backup(monkeypatch, db, ("-wal", "-shm", "-journal"))
        restore_from_backup(backups / info.filename, db, tmp_path / "docs", tmp_path / "media", backups)
        for side in ("-wal", "-shm", "-journal"):
            assert not Path(f"{db}{side}").exists(), side

    def test_documents_stage_beside_the_documents_folder(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _live_install(tmp_path)
        moves: list[tuple[str, str]] = []
        real = backup_service.shutil.move

        def spy(src, dst, *a, **k):
            moves.append((str(src), str(dst)))
            return real(src, dst, *a, **k)

        monkeypatch.setattr(backup_service.shutil, "move", spy)
        restore_from_backup(archive, db, docs, media, backups)
        installs = [s for s, d in moves if d == str(docs)]
        assert installs and all(s.startswith(str(docs.parent / ".documents_restore_stage_tmp")) for s in installs)
        assert (docs / "a.txt").read_text() == "doc"


class TestAFailureBeforeTheSwapSaysNothingChanged:
    def test_a_damaged_member_while_unpacking(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _live_install(tmp_path)
        before = db.read_bytes()
        real_extract = zipfile.ZipFile.extract

        def failing(self, member, path=None, pwd=None):
            if str(member).startswith("media/"):
                raise zipfile.BadZipFile("Bad CRC-32 for file 'media/1/1/original.mp3'")
            return real_extract(self, member, path, pwd)

        monkeypatch.setattr(zipfile.ZipFile, "extract", failing)
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        message = str(exc.value)
        assert "stopped before replacing anything" in message
        assert "Nothing was changed" in message
        assert "partway" not in message
        assert exc.value.pre_restore_filename.startswith("pre_restore_")
        assert db.read_bytes() == before
        assert _project_name(db) == "AFTER THE BACKUP"
        assert [p.name for p in tmp_path.iterdir() if is_staging_name(p.name)] == []

    def test_a_full_disk_while_unpacking_is_named(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _live_install(tmp_path)
        real_extract = zipfile.ZipFile.extract

        def full(self, member, path=None, pwd=None):
            if str(member).startswith("documents/"):
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_extract(self, member, path, pwd)

        monkeypatch.setattr(zipfile.ZipFile, "extract", full)
        with pytest.raises(RestoreNotStarted, match="ran out of space"):
            restore_from_backup(archive, db, docs, media, backups)
        assert _project_name(db) == "AFTER THE BACKUP"

    def test_a_pre_restore_backup_that_cannot_be_written(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _live_install(tmp_path)
        real = backup_service.create_backup

        def full(*a, **k):
            if a[4] == "pre_restore":
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(*a, **k)

        monkeypatch.setattr(backup_service, "create_backup", full)
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        assert "did not start" in str(exc.value) and "not enough free disk space" in str(exc.value)
        assert exc.value.pre_restore_filename is None
        assert _project_name(db) == "AFTER THE BACKUP"

    def test_a_failure_after_the_swap_still_says_partway(self, tmp_path, monkeypatch):
        """The positive control: the other side of the line keeps its sentence."""
        db, docs, media, backups, archive = _live_install(tmp_path)
        real_rmtree = backup_service.shutil.rmtree

        def failing(path, *a, **k):
            if Path(str(path)) == media:
                raise OSError("simulated open playback handle")
            return real_rmtree(path, *a, **k)

        monkeypatch.setattr(backup_service.shutil, "rmtree", failing)
        with pytest.raises(RestoreError, match="partway"):
            restore_from_backup(archive, db, docs, media, backups)

    def test_the_router_says_it_in_the_servers_own_words(self, tmp_path, monkeypatch, db_session):
        backups = tmp_path / "backups"
        backups.mkdir()
        name = "manual_20260101_000000.mmbackup"
        (backups / name).write_bytes(b"x")
        monkeypatch.setattr(backup_router, "get_backup_dir", lambda: backups)
        monkeypatch.setattr(backup_router.engine, "dispose", lambda: None)

        def stopped(*a, **k):
            raise RestoreNotStarted("The restore stopped before replacing anything: x. Nothing was changed.")

        monkeypatch.setattr(backup_router, "restore_from_backup", stopped)
        with pytest.raises(HTTPException) as exc:
            backup_router.backup_restore_local(name, user=SimpleNamespace(id=1), db=db_session)
        assert exc.value.status_code == 500
        # Verbatim — wrapped in the generic arm's words it still CONTAINS the
        # sentence, which is how the first version of this test passed a mutant.
        assert exc.value.detail == "The restore stopped before replacing anything: x. Nothing was changed."

    def test_no_failure_sends_the_researcher_to_a_server_log(self):
        """Read from the STRINGS the function can return, never its comments, which
        quote the old sentence to say why it went."""
        import ast
        import inspect
        import textwrap

        tree = ast.parse(textwrap.dedent(inspect.getsource(backup_router._restore_in_place)))
        said = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        assert any("Backup history" in s for s in said), "the scan found none of the sentences"
        assert not any("server log" in s.lower() for s in said)


# ── #1084 ───────────────────────────────────────────────────────────────────


def test_the_restored_database_records_the_restore(tmp_path, monkeypatch):
    """(c) `restore_started` goes into the database being REPLACED, so the restored
    install's trail never said it had been restored. Driven through the real door
    on a real file database."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.database import Base
    from app.models.audit import AuditEntry
    from app.models.project import Project
    from app.models.user import User
    from app.services.restore_gate import DatabaseGate

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

    result = backup_router.backup_restore_local(backup.filename, user=SimpleNamespace(id=1), db=Session())
    assert result["status"] == "restored"

    with Session() as s:
        actions = [(e.action, json.loads(e.details)) for e in s.query(AuditEntry).order_by(AuditEntry.id)]
    assert [a for a, _ in actions] == ["restore_completed"], (
        "the restored file's trail: started belongs to the replaced database"
    )
    details = actions[0][1]
    assert details == {
        "filename": backup.filename,
        "source": "backup_folder",
        "pre_restore_backup": result["pre_restore_backup"],
    }
    with Session() as s:
        assert s.query(AuditEntry).filter(AuditEntry.action == "restore_completed").one().user_id is None
    engine.dispose()


def test_recording_the_restore_never_fails_a_restore_that_succeeded(monkeypatch):
    def broken():
        raise RuntimeError("no such table: audit_entries")

    monkeypatch.setattr(backup_router, "SessionLocal", broken)
    backup_router._record_the_restore_in_the_restored_database(
        {"filename": "f", "source": "upload"}, SimpleNamespace(filename="pre_restore_x.mmbackup")
    )


def test_a_turn_the_restore_gate_skipped_is_retried_in_minutes(tmp_path, monkeypatch):
    """(b) It returned the whole interval — four hours with no automatic backup,
    including after a restore that gave up and changed nothing."""
    db = _db(tmp_path / "live.db")
    settings = SimpleNamespace(
        auto_backup_interval_hours=4, auto_backup_max_count=5, mm_database_path=str(db)
    )
    monkeypatch.setattr(app_main, "_run_auto_backup", lambda *a: False)
    assert asyncio.run(app_main._auto_backup_turn(settings)) == AUTO_BACKUP_BUSY_RETRY_SECONDS
    monkeypatch.setattr(app_main, "_run_auto_backup", lambda *a: True)
    assert asyncio.run(app_main._auto_backup_turn(settings)) == 4 * 3600


def test_the_upload_preview_runs_off_the_event_loop(tmp_path, monkeypatch):
    calls: list[str] = []
    loop_thread: list[str] = []

    def spy(path, **kw):
        calls.append(threading.current_thread().name)
        return "preview"

    monkeypatch.setattr(backup_router, "validate_backup", spy)
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: tmp_path)

    class _Upload:
        filename = "x.mmbackup"
        _chunks = [b"x", b""]

        async def read(self, n):
            return self._chunks.pop(0)

    async def run():
        loop_thread.append(threading.current_thread().name)
        return await backup_router.backup_validate(file=_Upload(), user=SimpleNamespace(id=1))

    assert asyncio.run(run()) == "preview"
    assert calls and calls[0] != loop_thread[0], "the validation ran on the event loop"
    assert list(tmp_path.iterdir()) == []


# ── #1043: the schedule ─────────────────────────────────────────────────────


class TestTheSchedule:
    @pytest.mark.parametrize("interval,count,fragment", [
        (-1, 5, "MM_AUTO_BACKUP_INTERVAL_HOURS is set to -1"),
        (4, 0, "MM_AUTO_BACKUP_MAX_COUNT is set to 0"),
        (4, -2, "MM_AUTO_BACKUP_MAX_COUNT is set to -2"),
    ])
    def test_a_value_with_no_meaning_refuses_to_start_with_the_fix(self, interval, count, fragment):
        with pytest.raises(BackupSettingsError) as exc:
            check_backup_settings(interval, count)
        assert fragment in str(exc.value)
        assert "start Mixed Measures again" in str(exc.value)
        assert isinstance(exc.value, FatalStartupError)

    @pytest.mark.parametrize("interval,count", [(0, 5), (4, 1), (1, 1), (24, 30)])
    def test_zero_means_off_and_is_accepted(self, interval, count):
        check_backup_settings(interval, count)

    @pytest.mark.parametrize("interval,started", [(0, False), (4, True)])
    def test_zero_starts_no_loop(self, monkeypatch, interval, started):
        """Before: `asyncio.sleep(0 * 3600)` — 640 backups in a few seconds."""
        from fastapi.testclient import TestClient

        settings = app_main.get_settings()
        monkeypatch.setattr(settings, "auto_backup_interval_hours", interval)
        ran: list[bool] = []

        async def loop():
            ran.append(True)

        monkeypatch.setattr(app_main, "_auto_backup_loop", loop)
        with TestClient(app_main.app):
            pass
        assert bool(ran) is started

    def test_startup_refuses_a_negative_interval(self, monkeypatch):
        from fastapi.testclient import TestClient

        monkeypatch.setattr(app_main.get_settings(), "auto_backup_interval_hours", -4)
        with pytest.raises(BackupSettingsError):
            with TestClient(app_main.app):
                pass

    def test_the_status_states_this_installs_schedule(self, tmp_path, monkeypatch):
        off = get_backup_status(tmp_path, interval_hours=0, max_count=5)
        assert (off.auto_backup_interval_hours, off.auto_backup_max_count) == (0, 5)
        settings = app_main.get_settings()
        monkeypatch.setattr(settings, "auto_backup_interval_hours", 0)
        monkeypatch.setattr(settings, "auto_backup_max_count", 9)
        monkeypatch.setattr(backup_router, "get_backup_dir", lambda: tmp_path)
        status = asyncio.run(backup_router.backup_status(user=SimpleNamespace(id=1)))
        assert (status.auto_backup_interval_hours, status.auto_backup_max_count) == (0, 9)
        assert status.next_backup_at is None


# ── #1039 (e)(f) ────────────────────────────────────────────────────────────


class TestTheNamePatternsAreExact:
    @pytest.mark.parametrize("parse,good", [
        (parse_backup_name, "auto_20260101_000000.mmbackup"),
        (safety_copies._NAME_RE.match, "pre-merge_1_20260101_000000.mmproject"),
        (database._PRE_MIGRATION_RE.match, "dev_20260101_000000.db"),
    ])
    def test_a_trailing_newline_or_another_scripts_digits_is_not_a_name(self, parse, good):
        assert parse(good) is not None          # the positive control
        assert parse(good + "\n") is None
        arabic_indic = good.replace("2026", "٢٠٢٦")
        assert parse(arabic_indic) is None


def test_a_rows_time_is_the_one_in_its_name(tmp_path):
    db = _db(tmp_path / "live.db")
    backups = tmp_path / "backups"
    info = create_backup(db, tmp_path / "docs", tmp_path / "media", backups, "auto")
    # A copy to another computer rewrites the time on every file.
    os.utime(backups / info.filename, (2_000_000_000, 2_000_000_000))
    row = list_backups(backups)[0]
    stamp = parse_backup_name(info.filename)
    expected = f"{stamp['date'][:4]}-{stamp['date'][4:6]}-{stamp['date'][6:]}T" \
               f"{stamp['time'][:2]}:{stamp['time'][2:4]}:{stamp['time'][4:]}+00:00"
    assert row.created_at == expected
    assert info.created_at == expected, "the restore's sentence and the list would disagree"
    with zipfile.ZipFile(backups / info.filename) as zf:
        assert json.loads(zf.read("manifest.json"))["created_at"] == expected


class TestPreMigrationCopies:
    def _copy(self, folder: Path, name: str) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(b"x")
        return folder / name

    def test_the_rotation_keeps_to_its_own_database(self, tmp_path, monkeypatch):
        backups = tmp_path / "backups"
        monkeypatch.setattr(database, "get_backup_dir", lambda: backups)
        theirs = [self._copy(backups, f"dev_bes_2026010{i}_000000.db") for i in range(1, 7)]
        mine = [self._copy(backups, f"dev_2026010{i}_000000.db") for i in range(1, 5)]
        db = _db(tmp_path / "dev.db")
        written = database._backup_database(db)
        assert written.exists(), "the rotation deleted the copy it had just written"
        assert all(p.exists() for p in theirs), "another database's copies were rotated"
        assert sum(p.exists() for p in mine) == 4   # 4 old + the new one = 5 kept

    def test_the_rotation_removes_a_rotated_copys_companion_files(self, tmp_path, monkeypatch):
        backups = tmp_path / "backups"
        monkeypatch.setattr(database, "get_backup_dir", lambda: backups)
        oldest = self._copy(backups, "dev_20250101_000000.db")
        self._copy(backups, "dev_20250101_000000.db-wal")
        for i in range(2, 7):
            self._copy(backups, f"dev_2026010{i}_000000.db")
        database._backup_database(_db(tmp_path / "dev.db"))
        assert not oldest.exists()
        assert not (backups / "dev_20250101_000000.db-wal").exists()

    def test_the_orphan_prune_removes_companion_files_whose_copy_is_gone(self, tmp_path):
        """MEASURED on the developer's folder: `vl_20260714_235953.db-wal`/`-shm`
        outliving the copy #982's prune removed."""
        backups = tmp_path / "backups"
        db = _db(tmp_path / "dev.db")
        stranded = [self._copy(backups, "vl_20260714_235953.db" + s) for s in ("-wal", "-shm")]
        kept_copy = self._copy(backups, "dev_20260101_000000.db")
        kept_side = self._copy(backups, "dev_20260101_000000.db-wal")
        orphan = self._copy(backups, "gone_20260101_000000.db")
        orphan_side = self._copy(backups, "gone_20260101_000000.db-shm")
        database.prune_orphaned_pre_migration_backups(db, backups)
        assert not any(p.exists() for p in stranded + [orphan, orphan_side])
        assert kept_copy.exists() and kept_side.exists()
