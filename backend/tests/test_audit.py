import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import json
from app.services.audit import log_action, get_audit_trail


def test_log_action_basic(db_session):
    entry = log_action(db_session, action="created", entity_type="code", entity_id=1)
    db_session.flush()
    assert entry.id is not None
    assert entry.action == "created"
    assert entry.entity_type == "code"
    assert entry.entity_id == 1


def test_log_action_with_details(db_session):
    details = {"old_name": "foo", "new_name": "bar"}
    entry = log_action(
        db_session, action="updated", entity_type="segment",
        entity_id=5, details=details
    )
    db_session.flush()
    assert json.loads(entry.details) == details


def test_log_action_all_none_optionals(db_session):
    entry = log_action(db_session, action="system_check", entity_type="backup")
    db_session.flush()
    assert entry.entity_id is None
    assert entry.user_id is None
    assert entry.project_id is None
    assert entry.details is None


def test_get_audit_trail_newest_first(db_session):
    log_action(db_session, action="first", entity_type="code", entity_id=1)
    db_session.flush()
    log_action(db_session, action="second", entity_type="code", entity_id=2)
    db_session.flush()

    trail = get_audit_trail(db_session)
    assert len(trail) == 2
    assert trail[0].action == "second"
    assert trail[1].action == "first"


def test_get_audit_trail_filter_by_project(db_session):
    log_action(db_session, action="a", entity_type="code", project_id=1)
    log_action(db_session, action="b", entity_type="code", project_id=2)
    db_session.flush()

    trail = get_audit_trail(db_session, project_id=1)
    assert len(trail) == 1
    assert trail[0].action == "a"


def test_get_audit_trail_respects_limit(db_session):
    for i in range(5):
        log_action(db_session, action=f"action_{i}", entity_type="code")
    db_session.flush()

    trail = get_audit_trail(db_session, limit=3)
    assert len(trail) == 3
