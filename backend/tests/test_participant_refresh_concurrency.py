"""#1033 — a participant-table refresh must not hold SQLite's write lock while it reads.

The refresh became a plain `def` in #1022, so it runs BESIDE other requests. SQLite
has one writer, and a transaction that has written keeps the lock until it ends,
so a refresh that wrote first and then ran its 16–25 s rollup made every other
writer fail with "database is locked" after the 5 s busy timeout. MEASURED on
122,382 participants before the fix: every coding click during a first create
(172 s) failed, and clicks 6–31 s into a 40 s refresh of a table with a variable
the researcher had added.

What these tests need that the rest of the suite does not have is a SECOND
CONNECTION to a REAL FILE — the in-memory harness shares one connection, where a
lock cannot be contended at all. So each test builds its own engine on
`tmp_path` with the app's two pragmas, holds the rollup open, and writes from a
second connection whose busy timeout is short enough to fail fast.

⚠️ The write here goes through `mark_participant_scores_stale` because that is
what every coding write calls; the second half of each test is that its flag
SURVIVES the refresh (#1033's other defect — clearing the flag at the end erased
a mark made while the rollup read).
"""
import threading
from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.routers import dataset as dataset_router
from app.services import participant_scores as ps
from app.services.participant_dataset import create_participant_dataset, get_participant_dataset

#: The competing writer gives up after this long. Short, so a regression fails in
#: well under a second rather than after the app's 5 s — and far longer than the
#: write needs when nothing holds the lock.
CONTENDED_TIMEOUT_S = 0.5

#: How long the held rollup waits for the other writer before carrying on.
HOLD_S = 10.0


def _engine(path, timeout):
    engine = create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False, "timeout": timeout},
    )

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection, _record):
        # The app's own two (`database.py::get_engine`): WAL is what lets a
        # reader and a writer overlap at all, and cascades are what the
        # set-based deletes rely on.
        dbapi_connection.execute("PRAGMA foreign_keys=ON")
        dbapi_connection.execute("PRAGMA journal_mode=WAL")

    return engine


@pytest.fixture
def world(tmp_path):
    path = tmp_path / "refresh.db"
    engine = _engine(path, timeout=5)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)
    db = Session()
    db.add(User(id=1, username="researcher", password_hash="x", is_admin=True))
    db.add(Project(id=1, name="Refresh", user_id=1))
    db.flush()
    conv = Conversation(project_id=1, name="Interviews")
    code = Code(project_id=1, numeric_id=1, name="Support",
                magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0)
    db.add_all([conv, code])
    db.flush()
    for i, ident in enumerate(("P-01", "P-02", "P-03"), start=1):
        person = Participant(project_id=1, identifier=ident)
        db.add(person)
        db.flush()
        speaker = Speaker(project_id=1, name=ident, participant_id=person.id)
        db.add(speaker)
        db.flush()
        seg = Segment(conversation_id=conv.id, speaker_id=speaker.id,
                      sequence_order=i, text=f"turn {i}")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1,
                               magnitude=float(i)))
    db.commit()
    yield {"path": path, "engine": engine, "Session": Session, "db": db}
    db.close()
    engine.dispose()


def _add_the_two_triggers(db):
    """What made the OLD refresh write before it read: a variable the researcher
    added (`materialise_manual_cells`' `INSERT … SELECT` takes the lock even when
    it inserts nothing) and a participant with no row yet."""
    dataset = get_participant_dataset(db, 1)
    db.add(DatasetColumn(dataset_id=dataset.id, column_text="Site",
                         column_type=ColumnType.NOMINAL, sequence_order=50,
                         display_order=50, source="manual"))
    db.add(Participant(project_id=1, identifier="P-04"))
    db.commit()


@contextmanager
def _rollup_held_open(monkeypatch):
    """Hold the rollup until the test's other writer is done, recording whether
    the refresh's connection had a transaction open while it read."""
    started = threading.Event()
    release = threading.Event()
    seen = {}
    real = ps.compute_magnitude_rollup

    def held(db, project_id):
        # `in_transaction` is the DB-API's own answer: True once a write has
        # begun a transaction that has not ended. The rollup must see False.
        seen["write_txn_open"] = db.connection().connection.dbapi_connection.in_transaction
        started.set()
        release.wait(HOLD_S)
        return real(db, project_id)

    monkeypatch.setattr(ps, "compute_magnitude_rollup", held)
    yield started, release, seen


def _write_while_held(world, started, release):
    """A coding write's shape — re-rating a passage, as `set_code_magnitude`
    does — from a second connection with a short timeout."""
    assert started.wait(HOLD_S), "the refresh never reached its rollup"
    other = _engine(world["path"], timeout=CONTENDED_TIMEOUT_S)
    try:
        with sessionmaker(bind=other, autoflush=False)() as db:
            application = db.query(CodeApplication).order_by(CodeApplication.id).first()
            application.magnitude = 5.0
            ps.mark_participant_scores_stale(db, 1)
            db.commit()
        return None
    except OperationalError as exc:
        return str(exc.orig)
    finally:
        release.set()
        other.dispose()


def _in_thread(fn):
    out = {}

    def run():
        try:
            out["value"] = fn()
        except BaseException as exc:  # surfaced to the test, never swallowed
            out["error"] = exc

    t = threading.Thread(target=run)
    t.start()
    return t, out


class TestAnotherWriterIsNotLockedOut:
    def test_during_a_REFRESH_of_a_table_with_a_hand_added_variable(self, world, monkeypatch):
        create_participant_dataset(world["db"], 1)
        world["db"].commit()
        _add_the_two_triggers(world["db"])

        with _rollup_held_open(monkeypatch) as (started, release, seen):
            refresh_db = world["Session"]()
            t, out = _in_thread(lambda: (ps.refresh_participant_dataset(refresh_db, 1),
                                         refresh_db.commit()))
            error = _write_while_held(world, started, release)
            t.join()
            refresh_db.close()

        assert "error" not in out, out.get("error")
        assert error is None, f"the other writer was locked out: {error}"
        assert seen["write_txn_open"] is False
        report = out["value"][0]
        # The two triggers were really exercised, so the lock had a reason to be taken.
        assert report.rows_added == 1

    def test_during_the_FIRST_CREATE_through_the_endpoint(self, world, monkeypatch):
        """The create endpoint writes a whole new table first — the audit's
        worst case. It must commit that before the rollup reads."""
        with _rollup_held_open(monkeypatch) as (started, release, seen):
            create_db = world["Session"]()
            user = create_db.get(User, 1)
            t, out = _in_thread(
                lambda: dataset_router.create_participants_dataset(1, user=user, db=create_db)
            )
            error = _write_while_held(world, started, release)
            t.join()
            create_db.close()

        assert "error" not in out, out.get("error")
        assert error is None, f"the other writer was locked out: {error}"
        assert seen["write_txn_open"] is False
        assert out["value"].row_count == 3


class TestAMarkMadeWhileTheRollupReadsSurvives:
    def test_the_flag_the_other_writer_set_is_still_set(self, world, monkeypatch):
        """Clearing `managed_stale` at the END erased this mark: the scores were
        read before the rating landed, and the table then said nothing was
        waiting. The claim clears it at the START instead."""
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        ps.refresh_participant_dataset(db, 1)
        db.commit()
        assert get_participant_dataset(db, 1).managed_stale is False

        with _rollup_held_open(monkeypatch) as (started, release, _seen):
            refresh_db = world["Session"]()
            t, out = _in_thread(lambda: (ps.refresh_participant_dataset(refresh_db, 1),
                                         refresh_db.commit()))
            assert _write_while_held(world, started, release) is None
            t.join()
            refresh_db.close()

        assert "error" not in out, out.get("error")
        db.expire_all()
        assert get_participant_dataset(db, 1).managed_stale is True

    def test_a_refresh_with_nothing_happening_still_clears_it(self, world):
        """Positive control: the claim is what clears the flag, so a refresh
        nobody raced leaves the table marked fresh."""
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        ps.mark_participant_scores_stale(db, 1)
        db.commit()
        ps.refresh_participant_dataset(db, 1)
        db.commit()
        assert get_participant_dataset(db, 1).managed_stale is False


class TestAFailedRefreshSaysSo:
    def test_the_table_is_marked_stale_again_and_its_time_is_untouched(self, world, monkeypatch):
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        ps.refresh_participant_dataset(db, 1)
        db.commit()
        before = get_participant_dataset(db, 1).managed_synced_at

        def boom(_db, _project_id):
            raise RuntimeError("the rollup failed")

        monkeypatch.setattr(ps, "compute_magnitude_rollup", boom)
        with pytest.raises(RuntimeError, match="the rollup failed"):
            ps.refresh_participant_dataset(db, 1)

        db.expire_all()
        dataset = db.query(Dataset).filter(Dataset.managed_kind.isnot(None)).one()
        assert dataset.managed_stale is True
        assert dataset.managed_synced_at == before


# ── #1073 — the WRITE step's lock hold, and one refresh at a time ─────────────


def _write_now(world):
    """A coding write from a second connection with the short timeout, NOW —
    returns None when it committed, else SQLite's refusal."""
    other = _engine(world["path"], timeout=CONTENDED_TIMEOUT_S)
    try:
        with sessionmaker(bind=other, autoflush=False)() as db:
            application = db.query(CodeApplication).order_by(CodeApplication.id).first()
            application.magnitude = 4.0
            db.commit()
        return None
    except OperationalError as exc:
        return str(exc.orig)
    finally:
        other.dispose()


class TestTheWriteStepHoldsNoLongLock:
    """#1073 (a) — MEASURED by the audit on 122,382 participants × 4 rated codes:
    the WRITE step read every managed cell AFTER its first write, so adding ONE
    participant held the lock ~4.3 s, and a first scoring (979,056 cells in one
    transaction) held it 8.90 s with a competing writer failing at 5.06 s. The
    guard at `test_participant_refresh_concurrency.py`'s top holds the ROLLUP, so
    it could not see this step at all."""

    def test_the_cell_READ_runs_with_no_write_transaction_open(self, world, monkeypatch):
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        ps.refresh_participant_dataset(db, 1)
        db.commit()
        # One new participant: the row sync WRITES, and then the cells are read —
        # the audit's 4.3 s case.
        db.add(Participant(project_id=1, identifier="P-09"))
        db.commit()

        seen = {}
        real = ps._plan_cells

        def spy(session, dataset_id, rollup):
            seen["write_txn_open"] = session.connection().connection.dbapi_connection.in_transaction
            seen["other_writer"] = _write_now(world)
            return real(session, dataset_id, rollup)

        monkeypatch.setattr(ps, "_plan_cells", spy)
        report = ps.refresh_participant_dataset(db, 1)
        db.commit()

        assert report.rows_added == 1              # the row sync really wrote
        assert seen["write_txn_open"] is False
        assert seen["other_writer"] is None, f"locked out during the cell read: {seen['other_writer']}"

    def test_each_cell_BATCH_is_its_own_short_transaction(self, world, monkeypatch):
        """Six cells (three participants × a score and its n) at a batch of two:
        every batch must START outside a write transaction, i.e. the one before
        it committed and let the lock go."""
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        monkeypatch.setattr(ps, "CELL_WRITE_BATCH", 2)

        batch_starts = []

        def before(conn, _cursor, statement, _params, _context, _executemany):
            head = " ".join(statement.split()[:3]).upper()
            if head.startswith(("INSERT INTO DATASET_VALUES", "UPDATE DATASET_VALUES",
                                "DELETE FROM DATASET_VALUES")):
                batch_starts.append(conn.connection.dbapi_connection.in_transaction)

        event.listen(world["engine"], "before_cursor_execute", before)
        try:
            report = ps.refresh_participant_dataset(db, 1)
            db.commit()
        finally:
            event.remove(world["engine"], "before_cursor_execute", before)

        assert report.cells_written == 6
        assert len(batch_starts) == 3              # population: the batches ran
        assert batch_starts == [False, False, False]


class TestOneRefreshAtATime:
    """#1073 (c), CONFIRMED by the audit's execution: two refreshes whose reads
    interleave both insert the same rows and one dies on the unique index — then
    marks a freshly refreshed table stale. Two creates 500 on
    `uq_datasets_project_managed_kind` despite the idempotent promise. Reachable
    since #1022 made the endpoints `def`; the per-column *Refresh scores* item is
    not disabled while a refresh runs."""

    def _first_refresh_held(self, world, monkeypatch, run):
        """Start `run` in a thread and return once it is inside the rollup — i.e.
        holding the project's turn."""
        cm = _rollup_held_open(monkeypatch)
        started, release, _seen = cm.__enter__()
        session = world["Session"]()
        t, out = _in_thread(lambda: run(session))
        assert started.wait(HOLD_S), "the first call never reached its rollup"
        return cm, release, t, out, session

    def test_a_second_refresh_is_REFUSED_and_marks_nothing_stale(self, world, monkeypatch):
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        cm, release, t, out, first = self._first_refresh_held(
            world, monkeypatch, lambda s: (ps.refresh_participant_dataset(s, 1), s.commit()))
        second = world["Session"]()
        try:
            with pytest.raises(ps.ParticipantTableBusy):
                ps.refresh_participant_dataset(second, 1)
        finally:
            second.close()
            release.set()
            t.join()
            first.close()
            cm.__exit__(None, None, None)
        assert "error" not in out, out.get("error")
        db.expire_all()
        assert get_participant_dataset(db, 1).managed_stale is False

    def test_the_refresh_ENDPOINT_answers_409_with_the_sentence(self, world, monkeypatch):
        from fastapi import HTTPException
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        cm, release, t, out, first = self._first_refresh_held(
            world, monkeypatch, lambda s: (ps.refresh_participant_dataset(s, 1), s.commit()))
        second = world["Session"]()
        try:
            with pytest.raises(HTTPException) as exc:
                dataset_router.refresh_participants_dataset(1, user=second.get(User, 1), db=second)
        finally:
            second.close()
            release.set()
            t.join()
            first.close()
            cm.__exit__(None, None, None)
        assert exc.value.status_code == 409
        assert exc.value.detail == ps.PARTICIPANT_TABLE_BUSY_MESSAGE

    def test_a_second_CREATE_waits_and_returns_the_same_table_without_a_second_refresh(
        self, world, monkeypatch,
    ):
        rollups = []
        real = ps.compute_magnitude_rollup
        started, release = threading.Event(), threading.Event()

        def held(session, project_id):
            rollups.append(project_id)
            started.set()
            release.wait(HOLD_S)
            return real(session, project_id)

        monkeypatch.setattr(ps, "compute_magnitude_rollup", held)
        first, second = world["Session"](), world["Session"]()
        t1, out1 = _in_thread(lambda: dataset_router.create_participants_dataset(
            1, user=first.get(User, 1), db=first))
        assert started.wait(HOLD_S)
        t2, out2 = _in_thread(lambda: dataset_router.create_participants_dataset(
            1, user=second.get(User, 1), db=second))
        release.set()
        t1.join()
        t2.join()
        first.close()
        second.close()

        assert "error" not in out1, out1.get("error")
        assert "error" not in out2, out2.get("error")
        assert out1["value"].id == out2["value"].id
        world["db"].expire_all()
        assert world["db"].query(Dataset).filter(Dataset.managed_kind.isnot(None)).count() == 1
        assert rollups == [1]                      # the second press did not refresh again

    def test_create_RECOVERS_when_another_process_made_the_table_first(self, world, monkeypatch):
        """The in-process turn cannot see another PROCESS, so the unique index is
        the backstop there: a collision re-reads the table instead of a 500."""
        real = dataset_router.create_participant_dataset

        def racing(session, project_id):
            elsewhere = world["Session"]()
            real(elsewhere, project_id)
            elsewhere.commit()
            elsewhere.close()
            session.add(Dataset(project_id=project_id, name="dup", managed_kind="participants"))
            session.flush()                        # → IntegrityError, as the race would

        monkeypatch.setattr(dataset_router, "create_participant_dataset", racing)
        db = world["Session"]()
        try:
            response = dataset_router.create_participants_dataset(1, user=db.get(User, 1), db=db)
        finally:
            db.close()
        world["db"].expire_all()
        tables = world["db"].query(Dataset).filter(Dataset.managed_kind.isnot(None)).all()
        assert len(tables) == 1 and response.id == tables[0].id

    def test_a_collision_from_ANOTHER_PROCESS_is_busy_and_marks_nothing_stale(self, world, monkeypatch):
        """The turn is in-process, so another process's refresh reaches this one
        only as a unique-index collision. That refresh is the one that lands, so
        this one is BUSY — and re-marking the table stale, as any other failure
        does, would mark those fresh scores out of date (#1073 c's second half)."""
        from sqlalchemy.exc import IntegrityError
        db = world["db"]
        create_participant_dataset(db, 1)
        db.commit()
        ps.mark_participant_scores_stale(db, 1)
        db.commit()

        def collide(_session, _dataset):
            raise IntegrityError("INSERT INTO dataset_rows", {}, Exception("UNIQUE constraint failed"))

        monkeypatch.setattr(ps, "sync_rows", collide)
        with pytest.raises(ps.ParticipantTableBusy):
            ps.refresh_participant_dataset(db, 1)
        db.expire_all()
        # The claim cleared the flag and nothing re-marked it: the other refresh owns it.
        assert get_participant_dataset(db, 1).managed_stale is False
