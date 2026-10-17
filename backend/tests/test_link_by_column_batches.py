"""#1054 — linking a dataset's records to participants: plan, then apply in batches.

`link_rows_by_identifier_column` held the event loop 76 s on BES (122,382 records),
~65% of it a role-column lookup repeated per row; as `def` in one transaction it
held SQLite's write lock long enough that 9 of 17 concurrent writes failed. Now it
plans with reads only and applies in transactions of `LINK_WRITE_BATCH`, each
statement re-checking its decision (the 2026-10-13 large-project batch review,
§2).

Guards:
- **Equivalence** — the review's edge fixture (padding, NBSP, tab, blanks, N/A
  forms, 100/101-character ids, case and `12`/`12.0`, duplicates, a conflict, a
  manual link, existing roles, two role columns, a declared-missing identifier,
  another project's identical id, append scope, a re-run). The expected output in
  `reference_data/link_by_column_edge_head.json` is what the PRE-#1054 code
  (`38104564`) produced — an oracle from the OLD implementation, so never
  regenerate it from the code it checks. Both modes must reproduce it exactly.
- **Cost** — the statement count does not grow with the records (kills the
  per-row role lookup).
- **Batches** — the plan holds no write lock, and another writer gets in between.
- **Races** — one per row of the review's §2.5 table, each with exact counts.
- **Ceiling** — whole-dataset and append scope past a lowered bind limit (HEAD's
  three `.in_()` lists failed there).
- **One at a time per project**, the dry-run preview, and the stop after re-plans.
- **#1231** — any stop after a committed batch (a lock, the ID column changed, an
  unexpected error) answers 409 with the count, keeps none of the batch in flight,
  and writes its audit entry when the lock allows; a finished link whose entry is
  refused still answers.
"""
import json
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

import app.services.participant_linking as pl
from app.database import Base
from app.models.audit import AuditEntry
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import link_by_column, preview_link_by_column
from app.schemas.dataset import LinkByColumnRequest

PROJECT = 10
EDGE_ORACLE = Path(__file__).parent / "reference_data" / "link_by_column_edge_head.json"


# ── a real file database, so a second connection can write between batches ──


def _engine(path, timeout=5):
    engine = create_engine(
        f"sqlite:///{path}", connect_args={"check_same_thread": False, "timeout": timeout},
    )

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.close()

    return engine


def _world(path, timeout):
    engine = _engine(path, timeout)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, autoflush=False)()
    db.add(User(id=1, username="u", password_hash="x"))
    db.add(Project(id=PROJECT, name="P", user_id=1))
    db.commit()
    return {"path": path, "engine": engine, "db": db}


@pytest.fixture
def world(tmp_path):
    w = _world(tmp_path / "link.db", 5)
    yield w
    w["db"].close()
    w["engine"].dispose()


@pytest.fixture
def short_world(tmp_path):
    """`world` with a 0.2 s busy timeout, so another writer's lock fails a
    statement quickly — SQLite's own 5 s would make each lock test 5 s long."""
    w = _world(tmp_path / "link.db", 0.2)
    yield w
    w["db"].close()
    w["engine"].dispose()


def _dataset(db, values, *, role=False, prefix="R"):
    ds = Dataset(project_id=PROJECT, name="Survey")
    db.add(ds)
    db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_text="id",
                        column_type=ColumnType.IDENTIFIER, sequence_order=0)
    db.add(col)
    db.flush()
    role_col = None
    if role:
        role_col = DatasetColumn(dataset_id=ds.id, column_text="Role",
                                 column_type=ColumnType.DEMOGRAPHIC,
                                 demographic_subtype="role", sequence_order=1)
        db.add(role_col)
        db.flush()
    rows = []
    for i, value in enumerate(values):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"{prefix}{i}")
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=value))
        if role_col is not None:
            db.add(DatasetValue(row_id=row.id, column_id=role_col.id, value_text=f"role{i}"))
        rows.append(row.id)
    db.commit()
    return ds.id, col.id, rows


def _other(path, sql, *args):
    """A write from ANOTHER connection, with a 0.5 s busy timeout."""
    c = sqlite3.connect(path, timeout=0.5)
    c.execute("PRAGMA foreign_keys=ON")
    c.execute(sql, args)
    c.commit()
    c.close()


def _linked_to(db, row_id):
    return db.execute(text(
        "SELECT p.identifier FROM dataset_rows r JOIN participants p ON p.id = r.participant_id "
        "WHERE r.id = :r"), {"r": row_id}).scalar()


def _on_apply(monkeypatch, at_call, act):
    """Run `act()` just before the `at_call`-th batch is written."""
    real = pl.apply_identifier_links
    calls = {"n": 0}

    def hook(session, plan, **kw):
        calls["n"] += 1
        if calls["n"] == at_call:
            act()
        return real(session, plan, **kw)

    monkeypatch.setattr(pl, "apply_identifier_links", hook)
    return calls


def _after_apply(monkeypatch, at_call, act):
    """Run `act()` just after the `at_call`-th batch is written, before its commit."""
    real = pl.apply_identifier_links
    calls = {"n": 0}

    def hook(session, plan, **kw):
        calls["n"] += 1
        result = real(session, plan, **kw)
        if calls["n"] == at_call:
            act()
        return result

    monkeypatch.setattr(pl, "apply_identifier_links", hook)
    return calls


# ── equivalence with the code it replaced ──────────────────────────────────


def _edge_fixture(db):
    """the internal design notes's
    world, verbatim — the oracle was produced from exactly this."""
    db.add_all([Project(id=10, name="P", user_id=1), Project(id=11, name="Other", user_id=1)])
    db.flush()

    def dataset(name, values, *, roles=None, role_cols=1, missing=None, pid=10):
        ds = Dataset(project_id=pid, name=name)
        db.add(ds); db.flush()
        col = DatasetColumn(dataset_id=ds.id, column_text="id", column_type=ColumnType.IDENTIFIER,
                            sequence_order=0, missing_values=missing)
        db.add(col); db.flush()
        rcols = []
        if roles is not None:
            for k in range(role_cols):
                rc = DatasetColumn(dataset_id=ds.id, column_text=f"Role{k}",
                                   column_type=ColumnType.DEMOGRAPHIC,
                                   demographic_subtype="role", sequence_order=1 + k)
                db.add(rc); db.flush(); rcols.append(rc)
        rows = []
        for i, v in enumerate(values):
            r = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i+1:03d}" if i % 5 else None)
            db.add(r); db.flush()
            if v is not None:
                db.add(DatasetValue(row_id=r.id, column_id=col.id, value_text=v))
            if roles is not None:
                for k, rc in enumerate(rcols):
                    rv = roles[i] if i < len(roles) else None
                    if rv is not None:
                        db.add(DatasetValue(row_id=r.id, column_id=rc.id,
                                            value_text=f"{rv}{'' if k == 0 else '#' + str(k)}"))
            rows.append(r)
        db.flush()
        return ds, col, rows

    maria = Participant(project_id=10, identifier="P001", display_name="Maria")
    lower = Participant(project_id=10, identifier="p004")
    teacher = Participant(project_id=10, identifier="P003", role="Teacher")
    blank_role = Participant(project_id=10, identifier="E1", role="")
    taken = Participant(project_id=10, identifier="C1")
    manual = Participant(project_id=10, identifier="Maria Lopez")
    other_proj = Participant(project_id=11, identifier="X1")
    db.add_all([maria, lower, teacher, blank_role, taken, manual, other_proj]); db.flush()

    values1 = ["  P001  ", "P002", "P002", "", "   ", None, "N/A", "Prefer not to say", "n/a.",
               "P003 ", "x" * 101, "y" * 100, "p001", "12", "12.0", "Don’t know", "P004",
               "E1", "X1", "\tTAB\t", "Na", "nation", "C1", "D1", "D1-solo", "P009"]
    roles1 = ["Admin", "Staff", "Staff", None, None, None, None, None, None,
              "Nurse", None, "Board", "Doc", "", "Exec", None, "Lead", "Chair", "Other", "T",
              None, "Nat", "Conf", "Dup", "Solo", "Mgr"]
    ds1, col1, rows1 = dataset("Survey One", values1, roles=roles1)
    extra = DatasetRow(dataset_id=ds1.id, participant_id=taken.id, row_identifier="R999")
    db.add(extra); db.flush()
    rows1[25].participant_id = manual.id
    lr = DatasetRow(dataset_id=ds1.id, participant_id=None, row_identifier="R998")
    db.add(lr); db.flush()
    db.add(DatasetValue(row_id=lr.id, column_id=col1.id, value_text="D1"))
    db.flush()
    ds2, col2, _ = dataset("Declared", ["999", "N/A", "Q1"],
                           missing=json.dumps([{"value": "999"}]))
    ds3, col3, _ = dataset("TwoRoles", ["T1", "T2"], roles=["A", "B"], role_cols=2)
    ds4, col4, rows4 = dataset("Append", ["S1", "S2", "S3", "S1"])
    db.commit()
    return (ds1.id, col1.id), (ds2.id, col2.id), (ds3.id, col3.id), (ds4.id, col4.id, rows4)


@pytest.mark.parametrize("commit_every", [None, 2], ids=["one-transaction", "batches-of-2"])
def test_the_edge_fixture_links_exactly_as_the_code_it_replaced(db_session, commit_every):
    db = db_session
    (d1, c1), (d2, c2), (d3, c3), (d4, c4, rows4) = _edge_fixture(db)
    kw = {} if commit_every is None else {"commit_every": commit_every}
    link = pl.link_rows_by_identifier_column
    out = {}
    out["r1"] = link(db, project_id=10, dataset_id=d1, column_id=c1, **kw); db.commit()
    out["r1_again"] = link(db, project_id=10, dataset_id=d1, column_id=c1, **kw); db.commit()
    out["r2"] = link(db, project_id=10, dataset_id=d2, column_id=c2, **kw); db.commit()
    out["r3"] = link(db, project_id=10, dataset_id=d3, column_id=c3, **kw); db.commit()
    out["r4"] = link(db, project_id=10, dataset_id=d4, column_id=c4,
                     row_ids=[r.id for r in rows4[1:]]); db.commit()
    with pytest.raises(ValueError) as e:
        link(db, project_id=10, dataset_id=d4, column_id=999999)
    out["bad_col"] = str(e.value)
    db.rollback()
    out["participants"] = [list(r) for r in db.execute(text(
        "select id, project_id, identifier, display_name, role, role_auto_filled_from, "
        "uuid is not null, created_at is not null, updated_at is not null "
        "from participants order by id"))]
    out["links"] = [list(r) for r in db.execute(text(
        "select r.dataset_id, r.id, r.row_identifier, r.participant_id, p.identifier "
        "from dataset_rows r left join participants p on p.id = r.participant_id order by r.id"))]
    assert out == json.loads(EDGE_ORACLE.read_text(encoding="utf-8"))


# ── cost ───────────────────────────────────────────────────────────────────


def test_the_statement_count_does_not_grow_with_the_records(world):
    """HEAD issued ~2 statements per record (122,387 SELECTs on BES), most of them
    the role column looked up again for every row."""
    db, engine = world["db"], world["engine"]
    counts = {}
    for n, prefix in ((20, "A"), (200, "B")):
        values = [f"{prefix}{i}" for i in range(n)]
        ds, col, _ = _dataset(db, values, role=True, prefix=prefix)
        seen = []
        listener = lambda *a: seen.append(1)  # noqa: E731
        event.listen(engine, "before_cursor_execute", listener)
        try:
            report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                                       column_id=col)
            db.commit()
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        assert report["linked"] == report["created"] == n
        counts[n] = len(seen)
    assert counts[20] == counts[200], counts
    assert db.execute(text("SELECT count(*) FROM participants WHERE role LIKE 'role%'")).scalar() == 220


# ── batches ────────────────────────────────────────────────────────────────


def test_the_plan_holds_no_write_lock_and_a_writer_gets_in_between_batches(world, monkeypatch):
    db, path = world["db"], world["path"]
    ds, col, _ = _dataset(db, [f"P{i}" for i in range(6)])
    seen = []
    real = pl.apply_identifier_links

    def hook(session, plan, **kw):
        seen.append(session.connection().connection.dbapi_connection.in_transaction)
        _other(path, "UPDATE projects SET name = name || '.' WHERE id = 10")
        return real(session, plan, **kw)

    monkeypatch.setattr(pl, "apply_identifier_links", hook)
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, commit_every=2)
    assert report["linked"] == report["created"] == 6
    assert seen == [False, False, False], "a batch began with a write transaction already open"


# ── the races `def` exposes (review §2.5) ──────────────────────────────────


def test_a_record_linked_by_hand_meanwhile_is_never_overwritten(world, monkeypatch):
    db, path = world["db"], world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])

    def act():
        _other(path, "INSERT INTO participants (project_id, identifier, uuid, created_at, updated_at) "
                     "VALUES (10, 'HAND', 'u-hand', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
        _other(path, "UPDATE dataset_rows SET participant_id = "
                     "(SELECT id FROM participants WHERE identifier = 'HAND') WHERE id = ?", rows[3])

    _on_apply(monkeypatch, 2, act)
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, commit_every=2)
    assert (report["linked"], report["created"], report["already_linked"]) == (4, 4, 1)
    assert _linked_to(db, rows[3]) == "HAND"
    assert db.execute(text("SELECT count(*) FROM participants WHERE identifier = 'P3'")).scalar() == 0


def test_a_participant_created_meanwhile_is_matched_not_duplicated(world, monkeypatch):
    db, path = world["db"], world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    _on_apply(monkeypatch, 2, lambda: _other(
        path, "INSERT INTO participants (project_id, identifier, uuid, created_at, updated_at) "
              "VALUES (10, 'P3', 'u-p3', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"))
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, commit_every=2)
    assert (report["linked"], report["created"], report["matched"]) == (5, 4, 1)
    assert db.execute(text("SELECT uuid FROM participants WHERE identifier = 'P3'")).scalar() == "u-p3"


def test_an_identifier_edited_meanwhile_links_by_the_new_value(world, monkeypatch):
    db, path = world["db"], world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    _on_apply(monkeypatch, 2, lambda: _other(
        path, "UPDATE dataset_values SET value_text = 'Z3' WHERE row_id = ? AND column_id = ?",
        rows[3], col))
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, commit_every=2)
    assert (report["linked"], report["created"]) == (5, 5)
    assert _linked_to(db, rows[3]) == "Z3"
    assert db.execute(text("SELECT count(*) FROM participants WHERE identifier = 'P3'")).scalar() == 0


def test_a_matched_participant_renamed_meanwhile_is_not_linked_by_its_old_name(world, monkeypatch):
    db, path = world["db"], world["path"]
    for i in range(5):
        db.add(Participant(project_id=PROJECT, identifier=f"P{i}"))
    db.commit()
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    _on_apply(monkeypatch, 2, lambda: _other(
        path, "UPDATE participants SET identifier = 'P3x' WHERE identifier = 'P3'"))
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, commit_every=2)
    assert (report["linked"], report["matched"], report["created"]) == (5, 4, 1)
    assert _linked_to(db, rows[3]) == "P3"
    assert db.execute(text(
        "SELECT count(*) FROM dataset_rows r JOIN participants p ON p.id = r.participant_id "
        "WHERE p.identifier = 'P3x'")).scalar() == 0


def test_a_manual_link_to_a_planned_participant_meanwhile_is_a_conflict(world, monkeypatch):
    db, path = world["db"], world["path"]
    for i in range(5):
        db.add(Participant(project_id=PROJECT, identifier=f"P{i}"))
    db.commit()
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    spare = DatasetRow(dataset_id=ds, row_identifier="spare")
    db.add(spare)
    db.commit()
    spare_id = spare.id
    _on_apply(monkeypatch, 2, lambda: _other(
        path, "UPDATE dataset_rows SET participant_id = "
              "(SELECT id FROM participants WHERE identifier = 'P3') WHERE id = ?", spare_id))
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, commit_every=2)
    assert (report["linked"], report["matched"], report["skipped_conflict"]) == (4, 4, 1)
    assert _linked_to(db, rows[3]) is None
    assert _linked_to(db, spare_id) == "P3"


def test_a_dataset_deleted_meanwhile_is_a_404_and_leaves_no_half_batch(world, monkeypatch):
    db, path = world["db"], world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    monkeypatch.setattr("app.routers.dataset.LINK_WRITE_BATCH", 2)
    _on_apply(monkeypatch, 2, lambda: _other(path, "DELETE FROM datasets WHERE id = ?", ds))
    with pytest.raises(HTTPException) as e:
        link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col),
                       user=db.get(User, 1), db=db)
    assert e.value.status_code == 404
    # The first batch committed two participants; the batch in flight wrote none.
    assert db.execute(text("SELECT count(*) FROM participants")).scalar() == 2


def test_a_dataset_that_keeps_changing_stops_and_says_how_much_was_linked(world, monkeypatch):
    db, path = world["db"], world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(9)])
    real = pl.apply_identifier_links
    calls = {"n": 0}

    def hook(session, plan, **kw):
        calls["n"] += 1
        if calls["n"] >= 2:  # every batch after the first meets a hand link
            target = plan.to_create[kw["create_slice"]][0][0]
            hand = f"HAND{calls['n']}"
            _other(path, "INSERT INTO participants (project_id, identifier, uuid, created_at, "
                         "updated_at) VALUES (10, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                   hand, f"u-{hand}")
            _other(path, "UPDATE dataset_rows SET participant_id = "
                         "(SELECT id FROM participants WHERE identifier = ?) WHERE id = ?",
                   hand, target)
        return real(session, plan, **kw)

    monkeypatch.setattr(pl, "apply_identifier_links", hook)
    monkeypatch.setattr("app.routers.dataset.LINK_WRITE_BATCH", 2)
    with pytest.raises(HTTPException) as e:
        link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col),
                       user=db.get(User, 1), db=db)
    assert e.value.status_code == 409
    assert "2 records were linked" in e.value.detail
    assert "Run Link by column again" in e.value.detail
    entry = db.query(AuditEntry).filter(AuditEntry.action == "participants_linked_by_column").one()
    assert json.loads(entry.details) == {"column_id": col, "linked": 2, "created": 2,
                                         "stopped": True, "reason": pl.LINK_STOPPED_KEPT_CHANGING}
    assert calls["n"] == 1 + (pl.MAX_REPLANS + 1)


# ── #1231: ANY stop after a committed batch says how much was linked ───────


class _Holder:
    """Another connection holding SQLite's write lock (`BEGIN IMMEDIATE`) — what a
    project delete, an import or another program does for seconds at a time."""

    def __init__(self, path):
        self.c = sqlite3.connect(path, timeout=0.2)
        self.c.execute("BEGIN IMMEDIATE")

    def release(self):
        if self.c is not None:
            self.c.rollback()
            self.c.close()
            self.c = None


def _stopped_audit(db):
    rows = db.query(AuditEntry).filter(AuditEntry.action == "participants_linked_by_column").all()
    return [json.loads(r.details) for r in rows]


def _link(db, ds, col):
    return link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col), user=db.get(User, 1), db=db)


def test_another_writers_lock_after_a_commit_stops_the_link_and_says_how_much(short_world, monkeypatch):
    """Reproduced 2026-10-15 (audit `link_lock_probe.py`): 5,000 of 12,000 linked, a
    plain-text 500 the client read as "The records could not be linked.", no audit."""
    db, path = short_world["db"], short_world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    monkeypatch.setattr("app.routers.dataset.LINK_WRITE_BATCH", 2)
    holder = {}
    _on_apply(monkeypatch, 2, lambda: holder.setdefault("h", _Holder(path)))
    real_log = __import__("app.routers.dataset", fromlist=["log_action"]).log_action

    def log_after_release(*a, **kw):  # the other writer finishes before the entry is written
        holder["h"].release()
        return real_log(*a, **kw)

    monkeypatch.setattr("app.routers.dataset.log_action", log_after_release)
    with pytest.raises(HTTPException) as e:
        _link(db, ds, col)
    assert e.value.status_code == 409
    assert e.value.detail == pl.link_stopped_sentence(
        pl.LinkStopped(pl.LINK_STOPPED_BUSY, linked=2, created=2))
    assert "2 records were linked" in e.value.detail
    assert _stopped_audit(db) == [{"column_id": col, "linked": 2, "created": 2,
                                   "stopped": True, "reason": pl.LINK_STOPPED_BUSY}]
    assert db.execute(text("SELECT count(*) FROM dataset_rows WHERE participant_id IS NOT NULL")).scalar() == 2


def test_a_lock_that_outlasts_the_link_still_answers_with_the_count(short_world, monkeypatch):
    """The audit entry meets the same lock: it is logged, and the answer still says it."""
    db, path = short_world["db"], short_world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    monkeypatch.setattr("app.routers.dataset.LINK_WRITE_BATCH", 2)
    holder = {}
    _on_apply(monkeypatch, 2, lambda: holder.setdefault("h", _Holder(path)))
    try:
        with pytest.raises(HTTPException) as e:
            _link(db, ds, col)
    finally:
        holder["h"].release()
    assert e.value.status_code == 409
    assert "2 records were linked" in e.value.detail
    assert _stopped_audit(db) == []          # it could not be written — said in the log

    # Running it again finishes the rest: nothing linked twice, no participant twice.
    report = _link(db, ds, col)
    assert (report.linked, report.created, report.already_linked) == (3, 3, 2)
    assert db.execute(text("SELECT count(*) FROM participants")).scalar() == 5
    assert db.execute(text(
        "SELECT count(DISTINCT participant_id) FROM dataset_rows WHERE participant_id IS NOT NULL")).scalar() == 5


def test_the_id_column_changed_under_a_replan_after_a_commit_says_how_much(world, monkeypatch):
    """The re-plan's column check used to answer 400 "requires an identifier-type
    column" — true of the column now, silent about the two records already linked."""
    db, path = world["db"], world["path"]
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(5)])
    monkeypatch.setattr("app.routers.dataset.LINK_WRITE_BATCH", 2)

    def retype_and_link_one_by_hand():
        _other(path, "UPDATE dataset_columns SET column_type = 'numeric' WHERE id = ?", col)
        _other(path, "INSERT INTO participants (project_id, identifier, uuid, created_at, updated_at) "
                     "VALUES (10, 'HAND', 'u-hand', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
        _other(path, "UPDATE dataset_rows SET participant_id = "
                     "(SELECT id FROM participants WHERE identifier = 'HAND') WHERE id = ?", rows[2])

    _on_apply(monkeypatch, 2, retype_and_link_one_by_hand)
    with pytest.raises(HTTPException) as e:
        _link(db, ds, col)
    assert e.value.status_code == 409
    assert "ID column was changed" in e.value.detail and "2 records were linked" in e.value.detail
    assert _stopped_audit(db)[0]["reason"] == pl.LINK_STOPPED_COLUMN


def test_an_unexpected_error_after_a_commit_is_a_stop_and_before_one_is_not(world, monkeypatch):
    db = world["db"]
    ds, col, _ = _dataset(db, [f"P{i}" for i in range(5)])
    monkeypatch.setattr("app.routers.dataset.LINK_WRITE_BATCH", 2)

    def boom():
        raise RuntimeError("boom")

    # The error lands after the second batch has WRITTEN its two participants and
    # links, before its commit — the audit entry's commit must not carry them.
    calls = _after_apply(monkeypatch, 2, boom)
    with pytest.raises(HTTPException) as e:
        _link(db, ds, col)
    assert e.value.status_code == 409 and "unexpected error" in e.value.detail
    assert "2 records were linked" in e.value.detail
    assert _stopped_audit(db)[0]["reason"] == pl.LINK_STOPPED_ERROR
    assert db.execute(text("SELECT count(*) FROM participants")).scalar() == 2
    assert db.execute(text("SELECT count(*) FROM dataset_rows WHERE participant_id IS NOT NULL")).scalar() == 2

    # Control: nothing committed yet, so nothing is claimed — the error goes through.
    ds2, col2, _ = _dataset(db, ["Q0"], prefix="S")
    calls["n"] = 0
    _on_apply(monkeypatch, 1, boom)
    with pytest.raises(RuntimeError):
        _link(db, ds2, col2)


@pytest.mark.parametrize("reason, linked, sentence", [
    (pl.LINK_STOPPED_BUSY, 5000,
     "Linking stopped because another change to the project was being saved and the link "
     "could not wait for it. 5,000 records were linked before it stopped and stay linked. "
     "Run Link by column again to finish."),
    (pl.LINK_STOPPED_COLUMN, 1,
     "Linking stopped because the ID column was changed while the records were being linked. "
     "1 record was linked before it stopped and stays linked. "
     "Choose an ID column and run Link by column again to link the rest."),
    (pl.LINK_STOPPED_KEPT_CHANGING, 0,
     "Linking stopped because the dataset kept changing while it was being linked. "
     "No record was linked. Run Link by column again."),
])
def test_the_stop_sentence_says_why_then_how_many(reason, linked, sentence):
    assert pl.link_stopped_sentence(pl.LinkStopped(reason, linked=linked, created=0)) == sentence


def test_a_finished_link_whose_audit_entry_is_locked_out_still_reports_it(short_world, monkeypatch):
    db, path = short_world["db"], short_world["path"]
    ds, col, _ = _dataset(db, [f"P{i}" for i in range(3)])
    holder = {}
    real_log = __import__("app.routers.dataset", fromlist=["log_action"]).log_action

    def log_under_a_lock(*a, **kw):
        holder["h"] = _Holder(path)
        return real_log(*a, **kw)

    monkeypatch.setattr("app.routers.dataset.log_action", log_under_a_lock)
    try:
        report = _link(db, ds, col)
    finally:
        holder["h"].release()
    assert report.linked == 3
    assert _stopped_audit(db) == []


# ── one link at a time per project ─────────────────────────────────────────


def test_a_second_link_in_the_project_is_refused_at_once(world):
    db = world["db"]
    ds, col, _ = _dataset(db, ["P0"])
    with pl.link_turn(PROJECT):
        with pytest.raises(HTTPException) as e:
            link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col),
                           user=db.get(User, 1), db=db)
        assert e.value.status_code == 409
        assert e.value.detail == pl.LINK_BUSY_MESSAGE
        # Another thread is refused too; the turn is the project's, not the thread's.
        seen = []

        def other():
            try:
                with pl.link_turn(PROJECT):
                    seen.append("entered")
            except pl.LinkBusy:
                seen.append("busy")

        t = threading.Thread(target=other)
        t.start(); t.join()
        assert seen == ["busy"]
    report = link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col),
                            user=db.get(User, 1), db=db)
    assert report.linked == 1, "the turn is released when the link ends"


# ── the dry run ────────────────────────────────────────────────────────────


def test_the_preview_says_what_the_link_will_do_and_writes_nothing(world):
    db = world["db"]
    db.add(Participant(project_id=PROJECT, identifier="P0"))
    db.commit()
    ds, col, _ = _dataset(db, ["P0", "P1", "P2", "P2", ""])
    preview = preview_link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col),
                                     user=db.get(User, 1), db=db)
    assert (preview.linked, preview.created, preview.matched) == (2, 1, 1)
    assert (preview.skipped_duplicate, preview.skipped_missing) == (2, 1)
    assert db.execute(text("SELECT count(*) FROM participants")).scalar() == 1
    assert db.execute(text("SELECT count(*) FROM dataset_rows WHERE participant_id IS NOT NULL")).scalar() == 0
    act = link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col), user=db.get(User, 1), db=db)
    assert act.model_dump() == preview.model_dump()


def test_the_preview_refuses_what_the_link_refuses(world):
    db = world["db"]
    ds, col, _ = _dataset(db, ["P0"])
    num = DatasetColumn(dataset_id=ds, column_text="n", column_type=ColumnType.NUMERIC, sequence_order=5)
    db.add(num)
    db.commit()
    with pytest.raises(HTTPException) as e:
        preview_link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=num.id),
                               user=db.get(User, 1), db=db)
    assert e.value.status_code == 400
    db.get(Dataset, ds).managed_kind = "participants"
    db.commit()
    with pytest.raises(HTTPException) as e:
        preview_link_by_column(PROJECT, ds, LinkByColumnRequest(column_id=col),
                               user=db.get(User, 1), db=db)
    assert e.value.status_code == 409


# ── the bind-parameter ceiling (#960) ──────────────────────────────────────

LIMIT = 40


def _lower_limit(db):
    db.connection().connection.dbapi_connection.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, LIMIT)


@pytest.fixture
def wide(db_session):
    db = db_session
    db.add(Project(id=PROJECT, name="P", user_id=1))
    db.flush()
    ds, col, rows = _dataset(db, [f"P{i}" for i in range(LIMIT * 3)])
    for i in range(0, LIMIT * 3, 2):  # half of them already exist, so both arms run
        db.add(Participant(project_id=PROJECT, identifier=f"P{i}"))
    db.commit()
    _lower_limit(db)
    return db, ds, col, rows


def test_the_lowered_limit_really_refuses_a_bound_list(wide):
    """Discrimination (backend/tests/the internal design notes): without it a limit that silently
    failed to apply would leave the two tests below green."""
    db, ds, col, rows = wide
    from sqlalchemy.exc import OperationalError
    with pytest.raises(OperationalError, match="too many SQL variables"):
        db.query(DatasetRow).filter(DatasetRow.id.in_(rows)).all()
    db.rollback()


@pytest.mark.parametrize("scope", ["whole-dataset", "append"])
def test_linking_more_records_than_the_bind_limit(wide, scope):
    db, ds, col, rows = wide
    _lower_limit(db)
    row_ids = rows if scope == "append" else None
    report = pl.link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds,
                                               column_id=col, row_ids=row_ids)
    db.commit()
    assert (report["linked"], report["matched"], report["created"]) == (LIMIT * 3, LIMIT * 3 // 2, LIMIT * 3 // 2)
