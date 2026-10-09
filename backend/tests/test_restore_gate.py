"""Nothing may reach the database a restore is replacing (#1024).

The defect, executed by the 2026-09-24 audit: the in-place restore disposed the
connection pool BEFORE the swap and never after, and admitted requests throughout.
A connection opened during the restore — any request, or the 30-second consensus
sweep — stayed pooled against the OLD file, so after the restore a request read the
replaced data and its write went into a file that no longer had a name. The edit was
lost after the researcher had been told the restore succeeded.

What these guard, and why each is here:

- **The gate itself** — a request is refused while a restore runs; a restore waits
  for work already running and gives up, having changed nothing, when it will not
  finish; a second restore is refused at once rather than queued.
- **The middleware** — the refusal reaches a real request with its reason, and a
  request holds its slot until its RESPONSE BODY is out, not only its headers.
- **The restore does not wait for itself** — it arrives as a request, so it holds a
  slot; the context variable that says so must reach the worker thread.
- **The end-to-end #1024 shape on a real file database** — including the door the
  gate does not know about, which is what the dispose AFTER the swap is for.
"""

import asyncio
import os
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from starlette.applications import Starlette
from starlette.responses import StreamingResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app.database import Base
from app.models.project import Project
from app.models.user import User
from app.routers import backup as backup_router
from app.schemas.backup import BackupInfo
from app.services import backup as backup_service
from app.services import restore_gate
from app.services.backup import create_backup
from app.services.restore_gate import (
    ALREADY_RESTORING_MESSAGE,
    BUSY_MESSAGE,
    RESTORING_MESSAGE,
    DatabaseGate,
    DatabaseGateMiddleware,
    RestoreInProgress,
    RestoreRefused,
    db_gate,
)
from tests.backup_support import stamp_revision


def _in_thread(fn) -> threading.Thread:
    t = threading.Thread(target=fn, daemon=True)
    t.start()
    return t


# ── the gate ──────────────────────────────────────────────────────────────


class TestTheGate:
    def test_work_is_refused_while_a_restore_holds_the_gate(self):
        gate = DatabaseGate()
        with gate.exclusive(timeout=1):
            assert gate.try_enter() is False
            with pytest.raises(RestoreInProgress):
                with gate.activity():
                    pass
        assert gate.try_enter() is True, "the gate did not reopen after the restore"

    def test_a_restore_waits_for_work_already_running(self):
        """The whole point: the swap must not happen under a connection in use."""
        gate = DatabaseGate()
        release = threading.Event()
        holding = threading.Event()
        swapped = threading.Event()

        def running_request():
            with gate.activity():
                holding.set()
                release.wait(5)

        def restore():
            with gate.exclusive(timeout=5):
                swapped.set()

        _in_thread(running_request)
        assert holding.wait(2)
        restorer = _in_thread(restore)
        time.sleep(0.2)
        assert not swapped.is_set(), "the restore went ahead under a running request"
        assert gate.try_enter() is False, "new work was admitted while the restore waited"
        release.set()
        restorer.join(5)
        assert swapped.is_set()

    def test_a_restore_that_cannot_drain_gives_up_and_changes_nothing(self):
        gate = DatabaseGate()
        assert gate.try_enter()  # a long import, still running
        with pytest.raises(RestoreRefused) as exc:
            with gate.exclusive(timeout=0.2):
                pytest.fail("the restore ran while other work held the gate")
        assert exc.value.reason == "busy"
        assert str(exc.value) == BUSY_MESSAGE
        assert gate.restoring is False, "a refused restore left the app refusing requests"
        assert gate.try_enter() is True

    def test_a_second_restore_is_refused_at_once_not_queued(self):
        """Queued, it would run the moment the first finished — restoring a backup
        the researcher had already restored over, on a client that had already
        given up on it. #1036(c)'s shared staging folders are the other half: two
        restores at once clobber each other's staged media."""
        gate = DatabaseGate()
        with gate.exclusive(timeout=1):
            started = time.monotonic()
            with pytest.raises(RestoreRefused) as exc:
                with gate.exclusive(timeout=5):
                    pass
            assert time.monotonic() - started < 1, "the second restore waited instead of refusing"
        assert exc.value.reason == "already_restoring"
        assert str(exc.value) == ALREADY_RESTORING_MESSAGE

    def test_the_gate_reopens_when_the_restore_raises(self):
        gate = DatabaseGate()
        with pytest.raises(OSError):
            with gate.exclusive(timeout=1):
                raise OSError("disk full")
        assert gate.restoring is False
        assert gate.try_enter() is True

    def test_a_restore_does_not_wait_for_its_own_slot_and_only_its_own(self):
        """A restore arrives as a request, so the middleware has given it a slot.
        Waiting for ALL slots would wait for itself and time out; skipping MORE
        than its own would swap under someone else's."""
        gate = DatabaseGate()
        token = restore_gate._HOLDS_SLOT.set(True)
        try:
            assert gate.try_enter()  # the restore request's own slot
            with gate.exclusive(timeout=1):
                pass  # proceeds: the only slot is its own

            assert gate.try_enter()  # somebody else's
            with pytest.raises(RestoreRefused):
                with gate.exclusive(timeout=0.2):
                    pass
        finally:
            restore_gate._HOLDS_SLOT.reset(token)


# ── the middleware ────────────────────────────────────────────────────────


class TestTheMiddleware:
    def test_a_request_during_a_restore_is_refused_with_the_reason(self):
        """The real app, the real middleware stack. Without auth: the refusal comes
        before the session lookup, which is itself a database read."""
        from app.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            with db_gate.exclusive(timeout=2):
                api = client.get("/api/backup/status")
                health = client.get("/health")
                elsewhere = client.get("/not-an-api-path")
            after = client.get("/health")

        assert api.status_code == 503
        assert api.json()["detail"] == RESTORING_MESSAGE
        assert api.headers["retry-after"] == "5"
        assert api.headers["x-content-type-options"] == "nosniff", (
            "the refusal skipped the security headers — the gate must be the innermost layer"
        )
        # `/health` runs SELECT 1 outside /api — a gate on the prefix alone would
        # leave it opening a connection mid-swap.
        assert health.status_code == 503
        assert elsewhere.status_code != 503, "a path that reads no database was refused"
        # By the BODY, not the status: /health also answers 503 on a nearly full
        # disk, and that must not make this pass or fail.
        assert after.json().get("database") == "ok", "the gate did not reopen"

    def test_a_request_holds_its_slot_until_the_body_is_sent(self):
        """A download streams long after its headers. `BaseHTTPMiddleware` would
        release at the headers; the swap would then land under the stream."""
        gate = DatabaseGate()
        seen: list[int] = []

        async def body():
            for chunk in (b"a", b"b", b"c"):
                seen.append(gate.active)
                yield chunk

        async def download(request):
            return StreamingResponse(body())

        async def boom(request):
            raise RuntimeError("handler failed")

        app = Starlette(routes=[Route("/api/download", download), Route("/api/boom", boom)])
        app.add_middleware(DatabaseGateMiddleware, gate=gate)

        with TestClient(app, raise_server_exceptions=False) as client:
            assert client.get("/api/download").content == b"abc"
            assert client.get("/api/boom").status_code == 500

        assert seen == [1, 1, 1], "the slot was released before the body was sent"
        assert gate.active == 0, "a slot leaked — the next restore would wait for it forever"


# ── the background writers ────────────────────────────────────────────────


class TestTheBackgroundWritersStandAside:
    """None of these is a request, so the middleware never sees them — and the
    consensus sweep opens a connection every 30 seconds on every install, which
    made it the likeliest thing to reach the old file during a restore."""

    def test_the_consensus_sweep_skips_its_tick_without_opening_a_session(self, monkeypatch):
        import app.main as app_main

        opened: list[int] = []
        monkeypatch.setattr(app_main, "SessionLocal", lambda: opened.append(1))
        with db_gate.exclusive(timeout=1):
            assert app_main._drain_consensus() == 0
        assert opened == [], "the sweep opened a session during the restore"
        assert db_gate.active == 0

    def test_the_four_hourly_backup_skips_its_turn(self, tmp_path, monkeypatch):
        import app.main as app_main

        wrote: list[str] = []
        monkeypatch.setattr(backup_service, "create_backup", lambda *a, **k: wrote.append(a[4]))
        with db_gate.exclusive(timeout=1):
            ran = app_main._run_auto_backup(tmp_path / "x.db", tmp_path, tmp_path, tmp_path, 5)
        assert ran is False and wrote == []
        # …and takes its turn otherwise, releasing its slot.
        assert app_main._run_auto_backup(tmp_path / "x.db", tmp_path, tmp_path, tmp_path, 5) is True
        assert wrote == ["auto"]
        assert db_gate.active == 0

    def test_the_quit_backup_is_skipped_rather_than_taken_across_the_swap(
        self, tmp_path, monkeypatch
    ):
        import app.main as app_main

        db = tmp_path / "live.db"
        db.write_bytes(b"x")
        wrote: list[str] = []
        monkeypatch.setattr(backup_service, "create_backup", lambda *a, **k: wrote.append(a[4]))
        monkeypatch.setattr(app_main.get_settings(), "mm_database_path", str(db), raising=False)
        monkeypatch.setattr(app_main, "get_backup_dir", lambda: tmp_path / "b")
        with db_gate.exclusive(timeout=1):
            app_main._shutdown_backup()
        assert wrote == []
        app_main._shutdown_backup()
        assert wrote == ["shutdown"]
        assert db_gate.active == 0


# ── the restore does not wait for itself, over HTTP ───────────────────────


@pytest.fixture(scope="module")
def _schema():
    from app.database import engine
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def test_the_restore_request_does_not_wait_for_its_own_slot(_schema, tmp_path, monkeypatch):
    """The context variable must reach the worker thread a `def` endpoint runs in.
    If it did not, every restore would wait for its own slot and be refused as
    busy — so this drives the REAL endpoint through the REAL middleware, with a
    drain timeout short enough that the failure is a 409 rather than a minute."""
    from app.database import engine
    from app.main import app

    backups = tmp_path / "backups"
    backups.mkdir()
    name = "manual_20260101_000000.mmbackup"
    (backups / name).write_bytes(b"not read: the restore is a spy")
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: backups)
    monkeypatch.setattr(restore_gate, "RESTORE_DRAIN_TIMEOUT_SECONDS", 1.0)
    # The suite's engine is the shared :memory: one; disposing it would drop the
    # database every other test in this process is using.
    monkeypatch.setattr(engine, "dispose", lambda: None)
    monkeypatch.setattr(backup_router, "restore_from_backup", lambda *a, **k: BackupInfo(
        filename="pre_restore_20260101_000001.mmbackup",
        created_at="2026-01-01T00:00:01+00:00", size_bytes=1, backup_type="pre_restore",
    ))

    with TestClient(app, raise_server_exceptions=False) as client:
        csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
        response = client.post(
            f"/api/backup/archives/{name}/restore", headers={"X-CSRF-Token": csrf}
        )

    assert response.status_code == 200, response.text
    assert response.json()["pre_restore_backup"] == "pre_restore_20260101_000001.mmbackup"
    assert response.json()["pre_restore_taken_at"] == "2026-01-01T00:00:01+00:00"
    assert db_gate.active == 0 and db_gate.restoring is False


def test_the_upload_door_runs_the_same_gated_restore_off_the_event_loop(tmp_path, monkeypatch):
    """It ran the restore ON the event loop: every other request froze for the
    whole restore, and requests already in the threadpool kept their connections
    to the old file anyway."""
    calls: list[tuple[str, dict]] = []
    loop_thread: list[threading.Thread] = []

    def spy(zip_path, *, db, user_id, audit_details):
        calls.append((threading.current_thread().name, audit_details))
        return {"status": "restored"}

    monkeypatch.setattr(backup_router, "_restore_in_place", spy)
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: tmp_path)

    class _Upload:
        filename = "from-another-computer.mmbackup"
        _chunks = [b"x" * 10, b""]

        async def read(self, n):
            return self._chunks.pop(0)

    async def run():
        loop_thread.append(threading.current_thread())
        return await backup_router.backup_restore(
            file=_Upload(), user=SimpleNamespace(id=1), db=None
        )

    assert asyncio.run(run()) == {"status": "restored"}
    assert len(calls) == 1
    thread_name, details = calls[0]
    assert thread_name != loop_thread[0].name, "the restore ran on the event loop"
    assert details == {"filename": "from-another-computer.mmbackup", "source": "upload"}
    assert list(tmp_path.iterdir()) == [], "the uploaded file was not cleaned up"


# ── #1024 end to end, on a real file database ─────────────────────────────


def _file_engine(path: Path):
    """The app's engine shape: a pooled file engine with WAL — the pool is the
    whole mechanism, so the suite's StaticPool :memory: engine cannot show this."""
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.close()

    return engine


def _name_on_disk(path: Path) -> str:
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute("SELECT name FROM projects WHERE id = 1").fetchone()[0]
    finally:
        conn.close()


def test_nothing_reaches_the_replaced_database_during_or_after_a_restore(tmp_path, monkeypatch):
    """The audit's reproduction, rebuilt as a regression test.

    A backup holds the project named *IN THE BACKUP*; the live database has since
    renamed it *AFTER THE BACKUP*. The pre-restore snapshot is held open so that
    the middle of the restore can be observed:

    - a request arriving then is REFUSED (the gate);
    - a door the gate does not know about opens a connection anyway — standing in
      for whatever the next new code path is — which is what the dispose AFTER the
      swap exists for;
    - after the restore, a request reads the backup's data, and its edit is in the
      restored file ON DISK.
    """
    db_path = tmp_path / "live.db"
    docs, media, backups = tmp_path / "docs", tmp_path / "media", tmp_path / "backups"
    engine = _file_engine(db_path)
    Base.metadata.create_all(engine)
    with engine.begin() as conn:  # the schema create_all built IS this build's head
        stamp_revision(conn.connection.dbapi_connection)
    Session = sessionmaker(bind=engine, autoflush=False)
    with Session() as s:
        s.add(User(id=1, username="Researcher", password_hash=""))
        s.add(Project(id=1, user_id=1, name="IN THE BACKUP"))
        s.commit()
    backup = create_backup(db_path, docs, media, backups, "manual")
    with Session() as s:
        s.get(Project, 1).name = "AFTER THE BACKUP"
        s.commit()

    # The swap is a rename — the POSIX shape, where a connection opened before it
    # keeps the old inode. Asserted below, not assumed. This test used to force it
    # by pointing OS temp at `tmp_path`; since #1036 (b) the restore stages beside
    # the database itself, so the rename is what the product does.
    paused, resume = threading.Event(), threading.Event()
    real_create_backup = backup_service.create_backup

    def held_open_pre_restore(*args, **kwargs):
        if args[4] == "pre_restore":
            paused.set()
            assert resume.wait(10)
        return real_create_backup(*args, **kwargs)

    monkeypatch.setattr(backup_service, "create_backup", held_open_pre_restore)
    monkeypatch.setattr(backup_router, "engine", engine)
    monkeypatch.setattr(backup_router, "_get_paths", lambda: (db_path, docs, media, backups))
    gate = DatabaseGate()
    monkeypatch.setattr(backup_router, "db_gate", gate)

    inode_before = os.stat(db_path).st_ino
    outcome: dict = {}

    def restore():
        try:
            outcome["result"] = backup_router.backup_restore_local(
                backup.filename, user=SimpleNamespace(id=1), db=Session()
            )
        except Exception as e:  # pragma: no cover - reported below
            outcome["error"] = e

    restorer = _in_thread(restore)
    assert paused.wait(10), "the restore never reached its pre-restore snapshot"

    # 1. A request now is refused — this is what the middleware asks.
    assert gate.try_enter() is False, "a request was admitted during the restore"

    # 2. A door the gate cannot see: it reads the OLD file and leaves a connection
    #    in the pool.
    with Session() as s:
        assert s.get(Project, 1).name == "AFTER THE BACKUP"

    resume.set()
    restorer.join(30)
    assert "error" not in outcome, outcome.get("error")
    assert outcome["result"]["status"] == "restored"
    assert os.stat(db_path).st_ino != inode_before, (
        "precondition: the swap was not a rename, so this test cannot see the defect"
    )

    # 3. After the restore: the restored data, and an edit that lands in the file.
    with Session() as s:
        project = s.get(Project, 1)
        assert project.name == "IN THE BACKUP", (
            "a request after the restore was served by the REPLACED database"
        )
        project.name = "EDITED AFTER THE RESTORE"
        s.commit()
    assert _name_on_disk(db_path) == "EDITED AFTER THE RESTORE", (
        "the edit went into the replaced file and is lost"
    )
    assert gate.restoring is False and gate.try_enter() is True
    engine.dispose()
