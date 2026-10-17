"""#1230 — a deleted project's audit entries never reach the project given its id next.

SQLite reuses the newest project's id and `audit_entries.project_id` has no foreign key.
P1–P3 are the doors that hand the id out again (create, import, duplicate); P2 and P3 copy
the file's `created_at`, which is why a `created_at` floor was not the fix. R1–R3 are the
startup repair for installs that deleted projects before the fix; O1–O2 the overwrite,
which keeps its history. C1–C2 are controls.
"""
import asyncio
import datetime as dt
import io

import openpyxl

from app.models.audit import AuditEntry
from app.models.project import Project
from app.models.user import User
from app.routers.export_excel import export_study_excel
from app.routers.projects import delete_project
from app.services.audit import log_action, repair_project_audit_rows
from app.services.project_portability import export_project, import_project


async def _drain(resp):
    return b"".join([c async for c in resp.body_iterator])


def _audit_cells(db, pid):
    resp = export_study_excel(pid, user=db.get(User, 1), db=db)
    wb = openpyxl.load_workbook(io.BytesIO(asyncio.run(_drain(resp))))
    return [str(c.value) for row in wb["Audit Trail"].iter_rows() for c in row if c.value]


def _deleted_newest(db):
    gone = Project(name="Withdrawn study", user_id=1)
    db.add(gone)
    db.flush()
    log_action(db, action="created", entity_type="participant", entity_id=7, user_id=1,
               project_id=gone.id, details={"identifier": "Jane Doe (withdrawn)"})
    db.commit()
    gone_id = gone.id
    asyncio.run(delete_project(gone_id, user=db.get(User, 1), db=db))
    return gone_id


def test_P1_create_after_delete(db_session):
    db = db_session
    gone_id = _deleted_newest(db)
    fresh = Project(name="Unrelated new study", user_id=1)
    db.add(fresh)
    db.commit()
    assert fresh.id == gone_id, "fixture: the id must be reused"
    leaked = [c for c in _audit_cells(db, fresh.id) if "Jane Doe" in c]
    assert not leaked, f"P1 leaked {leaked}"


def test_P2_import_after_delete_old_created_at(db_session, tmp_path):
    db = db_session
    src = Project(name="Old source", user_id=1,
                  created_at=dt.datetime(2020, 1, 1), updated_at=dt.datetime(2020, 1, 1))
    db.add(src)
    db.commit()
    buf = export_project(db, src.id, tmp_path / "docs")
    archive = tmp_path / "old.mmproject"
    archive.write_bytes(buf.getvalue())

    gone_id = _deleted_newest(db)
    new_id, _ = import_project(db, archive, tmp_path / "docs", tmp_path / "media", user_id=1)
    db.commit()
    assert new_id == gone_id, "fixture: the id must be reused"
    # Why the filed `created_at` floor was not the fix: the import keeps the FILE's
    # created_at, which predates every entry the deleted project left.
    assert db.get(Project, new_id).created_at.year == 2020
    leaked = [c for c in _audit_cells(db, new_id) if "Jane Doe" in c]
    assert not leaked, f"P2 leaked {leaked}"


def test_P3_duplicate_after_delete(db_session, tmp_path):
    from app.routers.project_portability import duplicate_project_endpoint
    db = db_session
    src = Project(name="Older study", user_id=1, created_at=dt.datetime(2021, 5, 5))
    db.add(src)
    db.commit()
    gone_id = _deleted_newest(db)
    out = duplicate_project_endpoint(src.id, db=db, user=db.get(User, 1))
    new_id = out.project_id
    assert new_id == gone_id, "fixture: the id must be reused"
    leaked = [c for c in _audit_cells(db, new_id) if "Jane Doe" in c]
    assert not leaked, f"P3 leaked {leaked}"


def test_C1_control_not_reused(db_session):
    db = db_session
    gone = Project(name="Withdrawn study", user_id=1)
    db.add(gone)
    db.flush()
    log_action(db, action="created", entity_type="participant", entity_id=7, user_id=1,
               project_id=gone.id, details={"identifier": "Jane Doe (withdrawn)"})
    db.add(Project(name="Newer", user_id=1))
    db.commit()
    gone_id = gone.id
    asyncio.run(delete_project(gone_id, user=db.get(User, 1), db=db))
    fresh = Project(name="Unrelated new study", user_id=1)
    db.add(fresh)
    db.commit()
    assert fresh.id != gone_id
    assert not [c for c in _audit_cells(db, fresh.id) if "Jane Doe" in c]


def test_C2_own_and_system_rows_survive(db_session):
    db = db_session
    gone_id = _deleted_newest(db)
    fresh = Project(name="Unrelated new study", user_id=1)
    db.add(fresh)
    db.flush()
    log_action(db, action="created", entity_type="code", entity_id=1, user_id=1,
               project_id=fresh.id, details={"name": "OWN-ROW"})
    log_action(db, action="restore_completed", entity_type="backup", details={"b": "SYSTEM-ROW"})
    db.commit()
    cells = _audit_cells(db, fresh.id)
    assert any("OWN-ROW" in c for c in cells), "the new project's own row must be listed"
    sys_rows = db.query(AuditEntry).filter(AuditEntry.project_id.is_(None),
                                           AuditEntry.action == "restore_completed").count()
    assert sys_rows == 1
    # the deletion's own record survives (project_id NULL, name only)
    assert db.query(AuditEntry).filter(AuditEntry.action == "deleted",
                                       AuditEntry.entity_type == "project",
                                       AuditEntry.entity_id == gone_id).count() == 1


# ── The startup repair: what a build before #1230 left behind ──────────────────────────


def _pre_fix_delete(db, project):
    """What `delete_project` did before #1230: the deletion record, and nothing else."""
    log_action(db, action="deleted", entity_type="project", entity_id=project.id,
               user_id=1, details={"name": project.name})
    db.delete(project)
    db.commit()


def test_R1_repair_removes_the_entries_of_an_id_no_project_holds(db_session):
    db = db_session
    gone = Project(name="Gone", user_id=1)
    keep = Project(name="Kept", user_id=1)
    db.add_all([gone, keep])
    db.flush()
    log_action(db, action="created", entity_type="participant", user_id=1,
               project_id=gone.id, details={"identifier": "Jane Doe (withdrawn)"})
    log_action(db, action="created", entity_type="code", user_id=1,
               project_id=keep.id, details={"name": "KEPT-ROW"})
    db.commit()
    gone_id = gone.id
    _pre_fix_delete(db, gone)
    assert repair_project_audit_rows(db) == 1
    db.commit()
    assert db.query(AuditEntry).filter(AuditEntry.project_id == gone_id).count() == 0
    assert db.query(AuditEntry).filter(AuditEntry.project_id == keep.id).count() == 1
    assert repair_project_audit_rows(db) == 0, "idempotent"


def test_R2_repair_separates_a_reused_id_by_the_deletion_record(db_session):
    """The leak had ALREADY happened: the id is held again, and both projects' entries sit
    under it. The deletion record divides them — no clock involved."""
    db = db_session
    gone = Project(name="Gone", user_id=1)
    db.add(gone)
    db.flush()
    log_action(db, action="created", entity_type="participant", user_id=1,
               project_id=gone.id, details={"identifier": "Jane Doe (withdrawn)"})
    db.commit()
    gone_id = gone.id
    _pre_fix_delete(db, gone)
    fresh = Project(name="Fresh", user_id=1, created_at=dt.datetime(2019, 1, 1))
    db.add(fresh)
    db.flush()
    assert fresh.id == gone_id
    log_action(db, action="created", entity_type="code", user_id=1,
               project_id=fresh.id, details={"name": "OWN-ROW"})
    db.commit()
    assert repair_project_audit_rows(db) == 1
    db.commit()
    left = [r.details for r in db.query(AuditEntry).filter(AuditEntry.project_id == fresh.id)]
    assert left == ['{"name": "OWN-ROW"}']


def test_R4_a_settled_install_pays_reads_only(db_session):
    """Startup runs the repair every launch. Once it has run, it must WRITE nothing: a
    DELETE takes SQLite's write lock even when it matches no row (#1033)."""
    from sqlalchemy import event
    db = db_session
    gone = Project(name="Gone", user_id=1)
    db.add(gone)
    db.flush()
    log_action(db, action="created", entity_type="participant", user_id=1,
               project_id=gone.id, details={"identifier": "Jane Doe (withdrawn)"})
    db.commit()
    _pre_fix_delete(db, gone)
    fresh = Project(name="Fresh", user_id=1)
    db.add(fresh)
    db.flush()
    log_action(db, action="created", entity_type="code", user_id=1,
               project_id=fresh.id, details={"name": "OWN-ROW"})
    db.commit()
    assert repair_project_audit_rows(db) == 1  # precondition: the reused-id arm ran
    db.commit()

    statements: list[str] = []
    engine = db.get_bind()

    def spy(conn, cursor, statement, *args):
        statements.append(statement.lstrip().split(None, 1)[0].upper())

    event.listen(engine, "before_cursor_execute", spy)
    try:
        assert repair_project_audit_rows(db) == 0
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    assert statements, "the spy saw nothing — it is not watching this engine"
    assert "DELETE" not in statements


def test_R3_repair_runs_in_the_startup_list(db_session):
    from app.services import data_repairs
    import inspect
    src = inspect.getsource(data_repairs.run_data_repairs)
    assert "repair_deleted_project_audit(" in src


# ── The overwrite keeps its history, whatever id it lands on ──────────────────────────


def test_O1_overwrite_onto_a_new_id_carries_the_history(db_session, tmp_path):
    db = db_session
    target = Project(name="Study", user_id=1, project_uuid="aaaaaaaa-0000-4000-8000-000000000001")
    db.add(target)
    db.flush()
    log_action(db, action="created", entity_type="code", user_id=1,
               project_id=target.id, details={"name": "HISTORY-ROW"})
    db.add(Project(name="Newer", user_id=1))  # so the overwrite cannot reuse target's id
    db.commit()
    old_id = target.id
    archive = tmp_path / "study.mmproject"
    archive.write_bytes(export_project(db, old_id, tmp_path / "docs").getvalue())
    new_id, _ = import_project(db, archive, tmp_path / "docs", tmp_path / "media", user_id=1,
                               import_mode="overwrite", target_project_id=old_id)
    db.commit()
    assert new_id != old_id, "fixture: the overwrite must land on another id"
    assert db.query(AuditEntry).filter(AuditEntry.project_id == old_id).count() == 0
    assert any("HISTORY-ROW" in c for c in _audit_cells(db, new_id))


def test_O2_overwrite_onto_the_same_id_keeps_the_history(db_session, tmp_path):
    db = db_session
    target = Project(name="Study", user_id=1, project_uuid="aaaaaaaa-0000-4000-8000-000000000002")
    db.add(target)
    db.flush()
    log_action(db, action="created", entity_type="code", user_id=1,
               project_id=target.id, details={"name": "HISTORY-ROW"})
    db.commit()
    old_id = target.id
    archive = tmp_path / "study.mmproject"
    archive.write_bytes(export_project(db, old_id, tmp_path / "docs").getvalue())
    new_id, _ = import_project(db, archive, tmp_path / "docs", tmp_path / "media", user_id=1,
                               import_mode="overwrite", target_project_id=old_id)
    db.commit()
    assert new_id == old_id
    assert any("HISTORY-ROW" in c for c in _audit_cells(db, new_id))
