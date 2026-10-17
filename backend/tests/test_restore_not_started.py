"""#1140 — a restore that stops before replacing anything says so, and keeps it true.

Two halves:

- **(b) the swap.** The live database's `-journal`/`-wal`/`-shm` used to be DELETED
  before the rename, on the premise that they hold nothing once this process's pool
  is disposed. False while ANOTHER process holds a connection: its commits live in the
  `-wal`, and on macOS/Linux an unlink succeeds under it. They are now set aside and
  put back if the swap fails, and the side of the line is decided by the `replacing`
  marker alone, set only after the swap returns.
- **(a) the population before the swap.** A backup that would not read when the
  restore re-checked it answered "Invalid backup: not a valid ZIP file" — never that
  nothing changed — and its neighbours (a damaged member, a full disk while checking,
  the staging folder that could not be made, another program's write lock on the
  audit row) reached the researcher as raw 500s. Each now has its own sentence, its
  own status, and the `X-MM-Restore-Outcome: not-started` header the dialog keys on.

⚠️ **Every database here is in WAL mode**, as the app's is (`database.py`): the older
backup fixtures use rollback-journal mode, where no `-wal` exists to lose — the first
probe of (b) silently had none.
"""

import errno
import sqlite3
import subprocess
import sys
import textwrap
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import OperationalError

from app.routers import backup as backup_router
from app.services import backup as backup_service
from app.services.backup import (
    RestoreError,
    RestoreNotStarted,
    create_backup,
    restore_from_backup,
    validate_backup,
)
from tests.backup_support import stamp_revision

OUTCOME = backup_router.RESTORE_OUTCOME_HEADER


def _db(path: Path, name: str) -> Path:
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    for t in ("conversations", "datasets", "documents", "observations"):
        conn.execute(f"CREATE TABLE {t} (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("INSERT INTO projects VALUES (1, ?)", (name,))
    stamp_revision(conn)
    conn.commit()
    conn.close()
    return path


def _name(db: Path) -> str:
    conn = sqlite3.connect(str(db))
    try:
        return conn.execute("SELECT name FROM projects WHERE id = 1").fetchone()[0]
    finally:
        conn.close()


def _install(tmp_path):
    db = _db(tmp_path / "live.db", "IN THE BACKUP")
    docs, media, backups = tmp_path / "docs", tmp_path / "data" / "media", tmp_path / "backups"
    docs.mkdir()
    (docs / "a.txt").write_text("doc")
    (media / "1" / "1").mkdir(parents=True)
    (media / "1" / "1" / "original.mp3").write_bytes(b"audio" * 400)
    info = create_backup(db, docs, media, backups, "manual")
    conn = sqlite3.connect(str(db))
    conn.execute("UPDATE projects SET name = 'AFTER THE BACKUP'")
    conn.commit()
    conn.close()
    return db, docs, media, backups, backups / info.filename


def _pre_restores(backups: Path) -> list[Path]:
    return sorted(backups.glob("pre_restore_*.mmbackup"))


def _damage_member(archive: Path, member: str) -> None:
    """Flip bytes inside one member's stored data, leaving the ZIP's directory intact —
    so the archive opens and lists, and breaks only when THAT member is read."""
    data = bytearray(archive.read_bytes())
    with zipfile.ZipFile(archive) as zf:
        info = zf.getinfo(member)
    off = info.header_offset
    start = off + 30 + int.from_bytes(data[off + 26:off + 28], "little") \
        + int.from_bytes(data[off + 28:off + 30], "little")
    for k in range(start + 2, min(start + 42, start + info.compress_size)):
        data[k] ^= 0xFF
    archive.write_bytes(bytes(data))


def _plant(monkeypatch, db):
    """Companion files with recognisable bytes, AFTER the pre-restore backup (which
    opens the database, and SQLite clears stale ones on open)."""
    real = backup_service.create_backup
    planted = {}

    def planting(*a, **k):
        info = real(*a, **k)
        if a[4] == "pre_restore":
            for side in ("-wal", "-shm"):
                p = Path(f"{db}{side}")
                p.write_bytes(f"held {side}".encode())
                planted[p] = p.read_bytes()
        return info

    monkeypatch.setattr(backup_service, "create_backup", planting)
    return planted


def _refuse_swap(monkeypatch, db, exc):
    real = backup_service.os.replace

    def refusing(src, dst):
        if Path(dst) == db:
            raise exc
        return real(src, dst)

    monkeypatch.setattr(backup_service.os, "replace", refusing)


# ── (b) the swap ────────────────────────────────────────────────────────────


class TestASwapThatFailsChangedNothing:
    def test_a_refused_swap_says_nothing_changed_and_names_another_program(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _install(tmp_path)
        _refuse_swap(monkeypatch, db, PermissionError(13, "being used by another process"))
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        message = str(exc.value)
        assert "stopped before replacing anything" in message
        assert "Nothing was changed" in message
        assert "another program" in message
        assert "partway" not in message
        assert exc.value.status_code == 409
        assert exc.value.pre_restore_filename.startswith("pre_restore_")
        assert "“Before a restore” backup" in message
        assert _name(db) == "AFTER THE BACKUP"

    def test_the_companion_files_are_back_byte_for_byte(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _install(tmp_path)
        planted = _plant(monkeypatch, db)
        _refuse_swap(monkeypatch, db, OSError(16, "Device or resource busy"))
        with pytest.raises(RestoreNotStarted):
            restore_from_backup(archive, db, docs, media, backups)
        assert planted, "nothing was planted — this test would assert nothing"
        for p, data in planted.items():
            assert p.exists() and p.read_bytes() == data, f"{p.name} was not put back"

    def test_a_companion_file_that_will_not_move_changes_nothing(self, tmp_path, monkeypatch):
        """The SECOND of two refuses (Windows, a held `-shm`): the first must come back."""
        db, docs, media, backups, archive = _install(tmp_path)
        planted = _plant(monkeypatch, db)
        real = backup_service.os.replace

        def refusing(src, dst):
            if str(src).endswith("-shm"):
                raise PermissionError(13, "being used by another process")
            return real(src, dst)

        monkeypatch.setattr(backup_service.os, "replace", refusing)
        with pytest.raises(RestoreNotStarted, match="another program"):
            restore_from_backup(archive, db, docs, media, backups)
        for p, data in planted.items():
            assert p.read_bytes() == data, f"{p.name} was not put back"
        assert _name(db) == "AFTER THE BACKUP"

    def test_a_put_back_that_fails_is_partway(self, tmp_path, monkeypatch):
        """The live database is where it was but its companions are not — a change, so
        the way back is the pre-restore backup, and the sentence says so."""
        db, docs, media, backups, archive = _install(tmp_path)
        _plant(monkeypatch, db)
        real = backup_service.os.replace

        def refusing(src, dst):
            # The swap, and the PUT-BACK (from the staging folder's `live-wal`/`live-shm`).
            if Path(dst) == db or Path(src).name.startswith("live-"):
                raise OSError(5, "Input/output error")
            return real(src, dst)

        monkeypatch.setattr(backup_service.os, "replace", refusing)
        with pytest.raises(RestoreError, match="partway"):
            restore_from_backup(archive, db, docs, media, backups)

    def test_a_failure_after_the_swap_still_says_partway(self, tmp_path, monkeypatch):
        """The positive control: past the swap, "partway" — and the time it carries."""
        db, docs, media, backups, archive = _install(tmp_path)
        real = backup_service.shutil.rmtree

        def failing(path, *a, **k):
            if Path(str(path)) == docs:
                raise OSError("simulated")
            return real(path, *a, **k)

        monkeypatch.setattr(backup_service.shutil, "rmtree", failing)
        with pytest.raises(RestoreError, match="partway") as exc:
            restore_from_backup(archive, db, docs, media, backups)
        assert _name(db) == "IN THE BACKUP"
        assert exc.value.pre_restore_taken_at, "the dialog needs WHEN, not a UTC filename"


HOLDER = textwrap.dedent("""
    import os, sqlite3, sys, time
    db, ready, go = sys.argv[1:4]
    conn = sqlite3.connect(db, isolation_level=None)
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("UPDATE projects SET name = 'COMMITTED IN THE WAL' WHERE id = 1")
    open(ready, "w").close()
    deadline = time.time() + 20
    while not os.path.exists(go) and time.time() < deadline:
        time.sleep(0.05)
    conn.close()
""")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX: an unlink succeeds under a holder")
def test_another_programs_committed_work_survives_a_failed_swap(tmp_path, monkeypatch):
    """The filed premise — "the side files hold nothing" — is false while another
    process holds the database: its commit is in the `-wal`. Deleted, the commit
    vanished from a live file the sentence then called unchanged (executed, 10-14)."""
    db, docs, media, backups, archive = _install(tmp_path)
    ready, go = tmp_path / "ready", tmp_path / "go"
    script = tmp_path / "holder.py"
    script.write_text(HOLDER)
    child = subprocess.Popen(
        [sys.executable, "-I", str(script), str(db), str(ready), str(go)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(200):
            if ready.exists():
                break
            time.sleep(0.05)
        assert ready.exists() and Path(f"{db}-wal").stat().st_size > 0, "no live -wal to lose"
        _refuse_swap(monkeypatch, db, OSError(16, "Device or resource busy"))
        with pytest.raises(RestoreNotStarted):
            restore_from_backup(archive, db, docs, media, backups)
        assert _name(db) == "COMMITTED IN THE WAL"
    finally:
        go.touch()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()


# ── (a) every stop before the swap ──────────────────────────────────────────


class TestEveryStopBeforeTheSwapSaysSo:
    def _assert_not_started(self, exc, *, status: int, copy: bool):
        message = str(exc.value)
        assert "Nothing was changed" in message, message
        assert "partway" not in message
        assert exc.value.status_code == status, message
        assert ("“Before a restore” backup" in message) is copy, message

    @pytest.mark.parametrize("shape", ["garbage", "truncated"])
    def test_a_backup_that_no_longer_reads_when_the_restore_checks_it(self, tmp_path, shape):
        db, docs, media, backups, archive = _install(tmp_path)
        validate_backup(archive)  # the preview a moment ago
        if shape == "garbage":
            archive.write_bytes(b"not a zip")
        else:
            archive.write_bytes(archive.read_bytes()[: archive.stat().st_size // 2])
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=400, copy=False)
        assert "did not start" in str(exc.value)
        assert "choose it again" in str(exc.value)
        assert _pre_restores(backups) == []
        assert _name(db) == "AFTER THE BACKUP"

    def test_a_damaged_database_member_is_damage_not_a_500(self, tmp_path):
        """`zlib.error` is not a `BadZipFile`: it reached both doors as a raw 500."""
        db, docs, media, backups, archive = _install(tmp_path)
        _damage_member(archive, "database.db")
        with pytest.raises(ValueError, match="damaged"):
            validate_backup(archive)
        with pytest.raises(RestoreNotStarted, match="part of it is damaged") as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=400, copy=False)

    def test_a_member_damaged_deep_inside_stops_at_unpacking(self, tmp_path):
        """The preview never reads the recordings, so a damaged one is found only while
        unpacking — after the pre-restore backup, which the sentence then names."""
        db, docs, media, backups, archive = _install(tmp_path)
        _damage_member(archive, "media/1/1/original.mp3")
        validate_backup(archive)  # previews fine — that is the point
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=400, copy=True)
        assert "could not be unpacked" in str(exc.value)
        assert "choose it again" not in str(exc.value), "re-previewing it would pass again"
        assert len(_pre_restores(backups)) == 1
        assert _name(db) == "AFTER THE BACKUP"

    def test_a_backup_that_is_gone_says_so(self, tmp_path):
        db, docs, media, backups, archive = _install(tmp_path)
        archive.unlink()
        with pytest.raises(RestoreNotStarted, match="no longer in the backups folder") as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=404, copy=False)

    def test_a_full_disk_while_checking_is_named(self, tmp_path, monkeypatch):
        db, docs, media, backups, archive = _install(tmp_path)
        real = zipfile.ZipFile.extract

        def full(self, member, path=None, pwd=None):
            if ".validate." in str(path):
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(self, member, path, pwd)

        monkeypatch.setattr(zipfile.ZipFile, "extract", full)
        with pytest.raises(RestoreNotStarted, match="not enough free disk space to check") as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=507, copy=False)

    def test_a_staging_folder_that_cannot_be_made_names_the_copy(self, tmp_path, monkeypatch):
        """Made OUTSIDE the `try`, its failure was a raw 500 that never named the
        pre-restore backup just written."""
        db, docs, media, backups, archive = _install(tmp_path)
        real = backup_service._staging_dir
        label = backup_service._restore_db_staging_label(db)

        def refusing(folder, lbl):
            if lbl == label:
                raise PermissionError(13, "Permission denied")
            return real(folder, lbl)

        monkeypatch.setattr(backup_service, "_staging_dir", refusing)
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=500, copy=True)
        assert _name(db) == "AFTER THE BACKUP"

    def test_a_staged_database_swapped_out_during_the_pre_restore_backup(self, tmp_path, monkeypatch):
        """The archive changes between the check and the unpacking: the staged database
        will not open. A pre-restore backup exists by then, and is named."""
        db, docs, media, backups, archive = _install(tmp_path)
        real = backup_service.create_backup

        def swapping(*a, **k):
            info = real(*a, **k)
            if a[4] == "pre_restore":
                with zipfile.ZipFile(archive) as src:
                    members = {n: src.read(n) for n in src.namelist()}
                members["database.db"] = b"not a database" * 64
                with zipfile.ZipFile(archive, "w") as dst:
                    for n, data in members.items():
                        dst.writestr(n, data)
            return info

        monkeypatch.setattr(backup_service, "create_backup", swapping)
        with pytest.raises(RestoreNotStarted, match="could not be unpacked") as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=400, copy=True)

    def test_no_value_error_passes_ahead_of_the_marker(self, tmp_path, monkeypatch):
        """Every ValueError before the swap used to escape as itself — a 400 that never
        said nothing changed. The marker alone decides now."""
        db, docs, media, backups, archive = _install(tmp_path)

        def odd(*a, **k):
            raise ValueError("some check nobody listed")

        monkeypatch.setattr(backup_service, "_bring_to_this_version", odd)
        with pytest.raises(RestoreNotStarted) as exc:
            restore_from_backup(archive, db, docs, media, backups)
        self._assert_not_started(exc, status=400, copy=True)


# ── the router: status, sentence and the outcome header ─────────────────────


@pytest.fixture
def router_paths(tmp_path, monkeypatch):
    backups = tmp_path / "backups"
    backups.mkdir()
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: backups)
    monkeypatch.setattr(backup_router.engine, "dispose", lambda: None)
    return backups


def _local(name, db_session):
    return backup_router.backup_restore_local(name, user=SimpleNamespace(id=1), db=db_session)


class TestTheRouterSaysWhichSide:
    NAME = "manual_20260101_000000.mmbackup"

    def test_a_stop_before_the_swap_carries_its_status_and_not_started(self, router_paths, monkeypatch, db_session):
        (router_paths / self.NAME).write_bytes(b"x")

        def stopped(*a, **k):
            raise RestoreNotStarted("The restore stopped before replacing anything: x. Nothing was changed.",
                                    status_code=409)

        monkeypatch.setattr(backup_router, "restore_from_backup", stopped)
        with pytest.raises(HTTPException) as exc:
            _local(self.NAME, db_session)
        assert exc.value.status_code == 409
        assert exc.value.headers == {OUTCOME: "not-started"}

    def test_partway_carries_the_time_and_never_a_filename(self, router_paths, monkeypatch, db_session):
        (router_paths / self.NAME).write_bytes(b"x")

        def partway(*a, **k):
            raise RestoreError("Restore failed partway (x).", "pre_restore_20261014_121530.mmbackup",
                               pre_restore_taken_at="2026-10-14T12:15:30+00:00")

        monkeypatch.setattr(backup_router, "restore_from_backup", partway)
        with pytest.raises(HTTPException) as exc:
            _local(self.NAME, db_session)
        assert exc.value.status_code == 500
        assert "partway" in exc.value.detail
        # Its digits are UTC, and disagreed with every Backup history row by the
        # zone offset — on the recovery instruction itself.
        assert ".mmbackup" not in exc.value.detail and "20261014" not in exc.value.detail
        assert exc.value.headers[OUTCOME] == "partway"
        assert exc.value.headers[backup_router.PRE_RESTORE_TAKEN_AT_HEADER] == "2026-10-14T12:15:30+00:00"

    def test_the_restore_doors_404_says_nothing_changed(self, router_paths, db_session):
        with pytest.raises(HTTPException) as exc:
            _local(self.NAME, db_session)  # never written: rotated away since its preview
        assert exc.value.status_code == 404
        assert "Nothing was changed" in exc.value.detail
        assert exc.value.headers == {OUTCOME: "not-started"}

    def test_another_programs_write_lock_on_the_audit_row_is_a_409(self, router_paths, monkeypatch, db_session):
        (router_paths / self.NAME).write_bytes(b"x")
        called = []
        monkeypatch.setattr(backup_router, "restore_from_backup", lambda *a, **k: called.append(1))

        def locked():
            raise OperationalError("INSERT INTO audit_log …", None, Exception("database is locked"))

        monkeypatch.setattr(db_session, "commit", locked)
        with pytest.raises(HTTPException) as exc:
            _local(self.NAME, db_session)
        assert exc.value.status_code == 409
        assert "another program" in exc.value.detail and "Nothing was changed" in exc.value.detail
        assert "sqlalche.me" not in exc.value.detail
        assert exc.value.headers == {OUTCOME: "not-started"}
        assert called == [], "the restore ran after its record could not be written"

    def test_the_preview_door_answers_a_damaged_member_with_a_sentence(self, tmp_path, router_paths):
        db, docs, media, backups, archive = _install(tmp_path)
        target = router_paths / self.NAME
        target.write_bytes(archive.read_bytes())
        _damage_member(target, "database.db")
        with pytest.raises(HTTPException) as exc:
            backup_router.backup_validate_local(self.NAME, user=SimpleNamespace(id=1))
        assert exc.value.status_code == 400
        assert "damaged" in exc.value.detail

    def test_the_preview_door_names_a_full_disk(self, tmp_path, router_paths, monkeypatch):
        db, docs, media, backups, archive = _install(tmp_path)
        (router_paths / self.NAME).write_bytes(archive.read_bytes())

        def full(*a, **k):
            raise OSError(errno.ENOSPC, "No space left on device")

        monkeypatch.setattr(backup_router, "validate_backup", full)
        with pytest.raises(HTTPException) as exc:
            backup_router.backup_validate_local(self.NAME, user=SimpleNamespace(id=1))
        assert exc.value.status_code == 507
        assert "not enough free disk space" in exc.value.detail


# ── #1160: what the preview counts ──────────────────────────────────────────


def test_the_preview_counts_recordings_not_files(tmp_path):
    """`media_file_count` is every file under `media/` — canvas images included — so
    the preview's *Recordings* overstated; counted from the members, it is right for
    every backup ever written. And an upload still in flight is not carried at all."""
    db = _db(tmp_path / "live.db", "S")
    docs, media, backups = tmp_path / "docs", tmp_path / "media", tmp_path / "backups"
    docs.mkdir()
    (media / "1" / "1").mkdir(parents=True)
    (media / "1" / "1" / "original.mp3").write_bytes(b"a")
    (media / "1" / "obs-2").mkdir()
    (media / "1" / "obs-2" / "original.mp4").write_bytes(b"v")
    (media / "1" / "canvas").mkdir()
    (media / "1" / "canvas" / "7.png").write_bytes(b"i")
    (media / "1" / "1" / ".upload-abc.part").write_bytes(b"half a recording")
    # A folder that owns no media, holding a file of a recording's NAME —
    # `parse_media_owner_segment`'s own example of what a caller must not count.
    (media / "1" / "dropped-in").mkdir()
    (media / "1" / "dropped-in" / "original.mp3").write_bytes(b"?")
    info = create_backup(db, docs, media, backups, "manual")
    archive = backups / info.filename
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
    assert not any(n.endswith(".part") for n in names), "an in-flight upload was carried"
    preview = validate_backup(archive)
    assert preview.recording_count == 2
    # The fixture can tell the two counts apart (else it certifies nothing).
    assert preview.manifest.media_file_count == 4 != preview.recording_count


def test_a_video_excluded_backup_still_leaves_an_in_flight_upload_out(tmp_path):
    db = _db(tmp_path / "live.db", "S")
    media = tmp_path / "media"
    (media / "1" / "1").mkdir(parents=True)
    (media / "1" / "1" / ".copy-xyz.part").write_bytes(b"half")
    info = create_backup(db, tmp_path / "docs", media, tmp_path / "b", "auto", False)
    with zipfile.ZipFile(tmp_path / "b" / info.filename) as zf:
        assert not any(n.endswith(".part") for n in zf.namelist())
