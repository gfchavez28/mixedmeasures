"""#422(c): the projects list reflects real recent WORK via MAX(audit timestamp),
not just Project-row edits (which `updated_at` alone misses)."""

import asyncio
from datetime import datetime

from app.routers.projects import list_projects
from app.models.project import Project
from app.models.audit import AuditEntry
from app.models.user import User


def _list(db):
    user = db.query(User).filter(User.id == 1).first()
    return asyncio.run(list_projects(user=user, db=db))


def test_recent_audit_outranks_a_newer_row_edit(db_session):
    # A: a recent Project-row edit (rename) but no work since. B: an old row edit but
    # a recent coding audit entry. B should sort first and report the audit time.
    a = Project(user_id=1, name="A (row edit)",
                created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 6, 1))
    b = Project(user_id=1, name="B (coded recently)",
                created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 2, 1))
    db_session.add_all([a, b])
    db_session.flush()
    db_session.add(AuditEntry(action="apply_code", entity_type="segment",
                              project_id=b.id, timestamp=datetime(2024, 12, 1)))
    db_session.commit()

    res = _list(db_session)
    assert [p.name for p in res.projects][0] == "B (coded recently)"
    by_id = {p.id: p for p in res.projects}
    assert by_id[b.id].last_activity_at == datetime(2024, 12, 1)   # audit wins
    assert by_id[a.id].last_activity_at == datetime(2024, 6, 1)    # no audit → updated_at


def test_last_activity_never_regresses_below_updated_at(db_session):
    # An audit entry OLDER than the row's own timestamps (e.g. an orphaned row from a
    # since-deleted project that reused this id) must not lower last_activity_at.
    p = Project(user_id=1, name="P",
                created_at=datetime(2024, 5, 1), updated_at=datetime(2024, 5, 1))
    db_session.add(p)
    db_session.flush()
    db_session.add(AuditEntry(action="x", entity_type="y",
                              project_id=p.id, timestamp=datetime(2023, 1, 1)))
    db_session.commit()

    res = _list(db_session)
    by_id = {pp.id: pp for pp in res.projects}
    assert by_id[p.id].last_activity_at == datetime(2024, 5, 1)   # stale audit ignored


def test_no_audit_falls_back_to_updated_at(db_session):
    p = Project(user_id=1, name="Fresh",
                created_at=datetime(2024, 3, 1), updated_at=datetime(2024, 4, 1))
    db_session.add(p)
    db_session.commit()

    res = _list(db_session)
    assert res.projects[0].last_activity_at == datetime(2024, 4, 1)
