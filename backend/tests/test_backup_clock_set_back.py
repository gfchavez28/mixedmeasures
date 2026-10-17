"""#1199 — a clock set back must not make a rotation delete the backup it just wrote.

A file in the backup folder was written before now, so a name stamped LATER than now
is a past write by a clock that was ahead — or by a right clock, read after this one
was set back (a CMOS reset, a manual change, a folder copied from a machine whose clock
differed). Ordered by name it outranked every new backup until its date: with five
`auto_2030…` files, every automatic backup and every *Backup now* was deleted the
moment it was written while the caller said it was saved; *Download Backup* streamed a
deleted file (a 500 after its audit row); the pre-migration copy was deleted before
the migration it guards.

Two rules, and each test below names the mutant it kills:
- (a) the rotation never deletes `keep`, the archive its caller just wrote;
- (b) a stamp later than `now` orders OLDER than every believable one
      (`stamp_is_believable`, which the #1186 schedule shares).
The scenarios run on a fake clock: the rotation reads names and nothing else, so a
turn is "write a name stamped by the fake clock, then rotate at that clock".
"""

import asyncio
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

import app.main as app_main
from app import database
from app.models.audit import AuditEntry
from app.models.user import User
from app.routers import backup as backup_router
from app.services import backup as backup_service
from app.services.backup import (
    backup_files,
    cleanup_old_backups,
    get_backup_status,
    next_automatic_backup_at,
)
from tests.backup_support import stamp_revision

UTC = timezone.utc
STEP = timedelta(hours=4)
T0 = datetime(2026, 10, 13, tzinfo=UTC)


def _name(kind: str, at: datetime, n: int | None = None) -> str:
    tail = f"-{n}" if n else ""
    return f"{kind}_{at.strftime('%Y%m%d_%H%M%S')}{tail}.mmbackup"


def _put(folder: Path, name: str, mtime: datetime | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / name
    p.write_bytes(b"PK")
    if mtime is not None:
        os.utime(p, (mtime.timestamp(), mtime.timestamp()))
    return p


def _db(path: Path) -> Path:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    for t in ("conversations", "datasets", "documents", "observations"):
        conn.execute(f"CREATE TABLE {t} (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("INSERT INTO projects VALUES (1, 'Study')")
    stamp_revision(conn)
    conn.commit()
    conn.close()
    return path


def _future(folder: Path, kind: str, k: int = 5) -> list[str]:
    at = datetime(2030, 1, 1, tzinfo=UTC)
    return [_put(folder, _name(kind, at + i * STEP), mtime=at + i * STEP).name for i in range(k)]


# ── the rule, on a fake clock ───────────────────────────────────────────────


def _turns(folder: Path, clocks, *, max_count: int = 5) -> list[str]:
    """Each turn writes a name stamped by the fake clock, then rotates at that clock.
    Returns the names in REAL write order (oldest first)."""
    written = []
    for now in clocks:
        name = _name("auto", now)
        if (folder / name).exists():  # create_backup's tail (#982) — not under test here
            name = _name("auto", now, 2)
        _put(folder, name)
        cleanup_old_backups(folder, "auto", max_count, keep=name, now=now)
        assert (folder / name).exists(), f"the rotation deleted the archive it just wrote: {name}"
        written.append(name)
    return written


@pytest.mark.parametrize("scenario,history,clocks", [
    # The issue's reproduction: five written while the clock read 2030, then set back.
    ("ran ahead, set back", lambda: [], [datetime(2026, 10, 14, 12, tzinfo=UTC) + i * STEP for i in range(10)]),
    # A CMOS-style reset: every file already there was written by a RIGHT clock and
    # now looks future. The issue's "cost" — deleting a real backup from a right clock —
    # is the rotation working: those files are older, in real time, than every new one.
    ("reset to 2000", lambda: [T0 + i * STEP for i in range(5)], [datetime(2000, 1, 1, tzinfo=UTC) + i * STEP for i in range(10)]),
    ("reset to 1970", lambda: [T0 + i * STEP for i in range(5)], [datetime(1970, 1, 1, tzinfo=UTC) + i * STEP for i in range(10)]),
    # A folder copied from a right machine onto one whose clock is three days behind.
    ("this clock behind", lambda: [T0 + i * STEP for i in range(5)], [T0 - timedelta(days=3) + i * STEP for i in range(10)]),
])
def test_after_five_turns_the_folder_holds_the_five_newest_real_backups(tmp_path, scenario, history, clocks):
    """Kills (b)'s removal: under (a) alone the new archive survives, and the folder
    then holds it plus FOUR future-dated files until their date — a window of one."""
    folder = tmp_path / "b"
    pre = [_put(folder, _name("auto", at)).name for at in history()]
    if scenario == "ran ahead, set back":
        pre = _future(folder, "auto")
    written = _turns(folder, clocks[:5])
    assert sorted(p.name for p in backup_files(folder)) == sorted(written), (scenario, pre)
    written += _turns(folder, clocks[5:])
    assert sorted(p.name for p in backup_files(folder)) == sorted(written[-5:]), scenario


def test_the_archive_just_written_survives_even_when_its_own_stamp_reads_future(tmp_path):
    """Kills (a)'s removal. The clock steps back between the write and the rotation, so
    the archive just written is itself "future" — (b) alone orders it as the oldest of
    six and deletes it. The case (a) exists for: whatever the ORDER gets wrong next
    (#982 was the `-n` tail), the rotation cannot delete what its caller is about to
    report as saved."""
    folder = tmp_path / "b"
    _future(folder, "auto")
    just = _put(folder, _name("auto", datetime(2026, 10, 14, 12, tzinfo=UTC))).name
    cleanup_old_backups(folder, "auto", 5, keep=just, now=datetime(2026, 10, 14, 11, 59, 59, tzinfo=UTC))
    assert (folder / just).exists()
    assert len(backup_files(folder)) == 5


def test_a_stamp_equal_to_now_is_believable(tmp_path):
    """Kills `<=` → `<` in `stamp_is_believable`: a file stamped exactly now must order
    ahead of the future-dated ones (with `<` it joins them, as their oldest)."""
    folder = tmp_path / "b"
    future = _future(folder, "auto")
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    exact = _put(folder, _name("auto", now)).name
    cleanup_old_backups(folder, "auto", 5, keep=None, now=now)
    assert (folder / exact).exists()
    assert not (folder / future[0]).exists(), "the oldest future-dated file is the one to go"


def test_among_future_dated_files_the_newest_name_is_kept(tmp_path):
    """Kills a reversed order inside the unbelievable group: they were written by one
    clock that was ahead, so their names keep their real order."""
    folder = tmp_path / "b"
    future = _future(folder, "auto", 3)
    present = _put(folder, _name("auto", T0)).name
    cleanup_old_backups(folder, "auto", 2, keep=None, now=T0 + STEP)
    assert {p.name for p in backup_files(folder)} == {present, future[-1]}


def test_the_schedule_and_the_rotation_share_one_predicate(tmp_path):
    """The schedule skips a future stamp (#1186); the rotation orders it last. A
    mutant of `stamp_is_believable` (say, dropping `<= now`) must fail BOTH halves."""
    folder = tmp_path / "b"
    _future(folder, "auto", 1)
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    assert next_automatic_backup_at(folder, 4, now=now) == now
    assert backup_service.stamp_is_believable(
        backup_service.parse_backup_name(_name("auto", now + timedelta(seconds=1))), now
    ) is False


# ── every door that rotates, entered at its mouth (#747) ────────────────────


@pytest.fixture
def paths(tmp_path, monkeypatch):
    db = _db(tmp_path / "t.db")
    b = tmp_path / "backups"
    monkeypatch.setattr(backup_router, "_get_paths", lambda: (db, tmp_path / "d", tmp_path / "m", b))
    return SimpleNamespace(db=db, docs=tmp_path / "d", media=tmp_path / "m", backups=b)


def test_backup_now_keeps_what_it_says_it_saved(db_session, paths):
    _future(paths.backups, "auto")
    asyncio.run(backup_router.backup_now(user=db_session.get(User, 1), db=db_session))
    row = db_session.query(AuditEntry).filter(AuditEntry.action == "backup_now").one()
    assert (paths.backups / json.loads(row.details)["filename"]).exists()


def test_download_backup_streams_a_file_that_exists(db_session, paths):
    _future(paths.backups, "manual", 2)
    resp = backup_router.backup_create(user=db_session.get(User, 1), db=db_session, include_video=False)
    assert Path(resp.path).exists()


def test_the_automatic_turn_keeps_its_backup(paths):
    _future(paths.backups, "auto")
    assert app_main._run_auto_backup(paths.db, paths.docs, paths.media, paths.backups, 5) is True
    assert len([p for p in backup_files(paths.backups) if p.name.startswith("auto_2026")]) == 1


def test_the_on_quit_backup_keeps_its_backup(paths, monkeypatch):
    _future(paths.backups, "shutdown", 2)
    monkeypatch.setattr(app_main, "get_settings", lambda: SimpleNamespace(mm_database_path=str(paths.db)))
    monkeypatch.setattr(app_main, "get_documents_dir", lambda: paths.docs)
    monkeypatch.setattr(app_main, "get_media_dir", lambda: paths.media)
    monkeypatch.setattr(app_main, "get_backup_dir", lambda: paths.backups)
    app_main._shutdown_backup()
    assert len([p for p in backup_files(paths.backups) if p.name.startswith("shutdown_2026")]) == 1


def test_the_pre_migration_copy_survives_its_own_rotation(tmp_path, monkeypatch):
    """The one guard on the only destructive path. Five copies stamped later than now
    used to outrank it, and it was deleted before `command.upgrade` ran."""
    live = _db(tmp_path / "live.db")
    pm = tmp_path / "pm"
    pm.mkdir()
    future = [f"live_2030010{i + 1}_000000.db" for i in range(5)]
    for n in future:
        (pm / n).write_bytes(b"x")
    monkeypatch.setattr(database, "get_backup_dir", lambda: pm)
    path = database._backup_database(live)
    assert path.exists()
    assert len(list(pm.glob("live_*.db"))) == 5
    assert not (pm / future[0]).exists(), "the oldest future-dated copy is the one to go"


# ── freshness: a future mtime is no evidence either ─────────────────────────


def test_a_future_dated_file_does_not_hold_the_stale_warning_off(tmp_path):
    folder = tmp_path / "b"
    _put(folder, _name("pre_restore", datetime(2030, 1, 1, tzinfo=UTC)), mtime=datetime(2030, 1, 1, tzinfo=UTC))
    old = datetime.now(UTC) - timedelta(days=30)
    _put(folder, _name("auto", old.replace(microsecond=0)), mtime=old)
    s = get_backup_status(folder, interval_hours=4, max_count=5)
    assert s.is_stale is True
    assert s.last_backup_at.startswith(old.strftime("%Y-%m-%d"))
    assert s.backup_count == 2, "the future-dated file is still a backup — it is listed and counted"


def test_a_backup_written_a_moment_ago_reads_fresh_within_the_filesystems_skew(tmp_path):
    """FAT rounds an mtime UP to 2 s and a network share stamps by its server's clock."""
    folder = tmp_path / "b"
    ahead = datetime.now(UTC) + timedelta(seconds=2)
    _put(folder, _name("auto", datetime.now(UTC).replace(microsecond=0)), mtime=ahead)
    assert get_backup_status(folder, interval_hours=4).is_stale is False


# ── (a) at every door: the clock steps back between the write and its rotation ──
#
# Under (b) alone the archive just written is the newest BELIEVABLE file, so a door
# that forgot `keep=` would pass every test above. These replay the one case where it
# is not: the clock steps back one second between `create_backup` naming the file and
# the rotation reading `now`, so the new file is itself "future" and (b) orders it the
# oldest of its kind. Kills `keep=None` at each door separately.

WRITE_AT = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)


def _stepping_clock(module, monkeypatch):
    calls = {"n": 0}

    class Stepping(datetime):
        @classmethod
        def now(cls, tz=None):
            calls["n"] += 1
            at = WRITE_AT if calls["n"] == 1 else WRITE_AT - timedelta(seconds=1)
            return at if tz is not None else at.replace(tzinfo=None)

    monkeypatch.setattr(module, "datetime", Stepping)


def test_backup_now_keeps_it_across_a_step_back(db_session, paths, monkeypatch):
    _future(paths.backups, "auto")
    _stepping_clock(backup_service, monkeypatch)
    asyncio.run(backup_router.backup_now(user=db_session.get(User, 1), db=db_session))
    assert (paths.backups / _name("auto", WRITE_AT)).exists()


def test_download_backup_keeps_it_across_a_step_back(db_session, paths, monkeypatch):
    _future(paths.backups, "manual", 2)
    _stepping_clock(backup_service, monkeypatch)
    resp = backup_router.backup_create(user=db_session.get(User, 1), db=db_session, include_video=False)
    assert Path(resp.path).exists()


def test_the_automatic_turn_keeps_it_across_a_step_back(paths, monkeypatch):
    _future(paths.backups, "auto")
    _stepping_clock(backup_service, monkeypatch)
    app_main._run_auto_backup(paths.db, paths.docs, paths.media, paths.backups, 5)
    assert (paths.backups / _name("auto", WRITE_AT)).exists()


def test_the_on_quit_backup_keeps_it_across_a_step_back(paths, monkeypatch):
    _future(paths.backups, "shutdown", 2)
    _stepping_clock(backup_service, monkeypatch)
    monkeypatch.setattr(app_main, "get_settings", lambda: SimpleNamespace(mm_database_path=str(paths.db)))
    monkeypatch.setattr(app_main, "get_documents_dir", lambda: paths.docs)
    monkeypatch.setattr(app_main, "get_media_dir", lambda: paths.media)
    monkeypatch.setattr(app_main, "get_backup_dir", lambda: paths.backups)
    app_main._shutdown_backup()
    assert (paths.backups / _name("shutdown", WRITE_AT)).exists()


def test_the_pre_migration_copy_keeps_it_across_a_step_back(tmp_path, monkeypatch):
    live = _db(tmp_path / "live.db")
    pm = tmp_path / "pm"
    pm.mkdir()
    for i in range(5):
        (pm / f"live_2030010{i + 1}_000000.db").write_bytes(b"x")
    monkeypatch.setattr(database, "get_backup_dir", lambda: pm)
    _stepping_clock(database, monkeypatch)
    path = database._backup_database(live)
    assert path.exists() and path.name == f"live_{WRITE_AT.strftime('%Y%m%d_%H%M%S')}.db"


def test_the_pre_migration_rotation_rotates_future_dated_copies_first(tmp_path, monkeypatch):
    """Kills (b)'s removal in `database.py`: with two real older copies and four
    future-dated ones, by name the two REAL ones would go."""
    live = _db(tmp_path / "live.db")
    pm = tmp_path / "pm"
    pm.mkdir()
    real = ["live_20261001_000000.db", "live_20261002_000000.db"]
    future = [f"live_2030010{i + 1}_000000.db" for i in range(4)]
    for n in real + future:
        (pm / n).write_bytes(b"x")
    monkeypatch.setattr(database, "get_backup_dir", lambda: pm)
    path = database._backup_database(live)
    left = sorted(p.name for p in pm.glob("live_*.db"))
    assert path.name in left and all(r in left for r in real), left
    assert len(left) == 5
