import json
from typing import Any
from sqlalchemy import func
from sqlalchemy.orm import Session
from ..models.audit import AuditEntry

#: The record `routers/projects.py::delete_project` writes when it deletes a project. It
#: carries no `project_id` (the project is gone) and names the id in `entity_id`.
PROJECT_DELETED_ACTION = "deleted"

#: The record `routers/code_analysis.py::reveal_blind_mode` writes when a coder breaks
#: blind mode (DEC-G: hide while blind, one LOGGED reveal). The Excel Audit Trail keeps
#: every one of them past its row cap (#1532 D100), so the writer and that reader share
#: this one spelling.
BLIND_MODE_REVEAL_ACTION = "reveal_codes"


def _strip_strings(value):
    if isinstance(value, str):
        return None
    if isinstance(value, list):
        return [_strip_strings(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip_strings(v) for k, v in value.items()}
    return value


def stripped_details(raw: str | None, mark: str) -> str:
    """An entry's details with every string nulled and `"redacted": mark` added.

    The shape of a withdrawal's redaction (#1320 D9) and of a deleted source's
    (#1546 D157): keys, numbers and booleans stay — ids and counts are the trail,
    the words are a person's. Details that are not a JSON object are a string
    themselves. `mark` says why: `withdrawal_redaction.AUDIT_REDACTION_MARK` or
    `deleted_source_audit.SOURCE_DELETED_MARK`.
    """
    try:
        parsed = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    out = _strip_strings(parsed)
    out["redacted"] = mark
    return json.dumps(out)


def forget_project_audit(db: Session, project_id: int) -> int:
    """#1230 — remove a DELETED project's entries, in the delete's own transaction.

    `audit_entries.project_id` has no foreign key, and SQLite reuses the id of the newest
    project, so the next project created, imported or duplicated inherited every entry
    the deleted one left — participant identifiers included — into its Excel export.
    A `created_at` floor cannot tell them apart: an import copies the file's
    `created_at`, which predates the leaked rows. The project's own deletion record stays
    (it carries no `project_id`). Returns the number removed.
    """
    return (
        db.query(AuditEntry)
        .filter(AuditEntry.project_id == project_id)
        .delete(synchronize_session=False)
    )


def repair_project_audit_rows(db: Session) -> int:
    """#1230 — the entries an older build left for an id it then gave to a new project.

    Two shapes, both decided without a clock:
    - an id no project holds: every entry under it (a delete, or an overwrite import
      whose new project took another id before #1230);
    - an id held AGAIN after a delete: the entries written before that deletion's own
      record. Audit rows are never deleted below a deletion record, so their ids rise
      in the order they were written.

    Startup runs it (`data_repairs.run_data_repairs`), so a settled install pays reads
    only: one walk of the `project_id` index (3.9 ms per 100,000 entries, measured) and
    one query per id held again — a DELETE is issued only where a read found an entry,
    since a write statement takes SQLite's lock even when it changes nothing (#1033).

    Not separable: an overwrite import before #1230 that landed on a NEW id left the old
    id's entries with no deletion record. They are removed while the id is unheld (the
    first arm), but if a later project took that id before this build first started,
    nothing marks where the old entries end. Returns the number removed.
    """
    from ..models.project import Project

    held = {pid for (pid,) in db.query(Project.id)}
    with_rows = {
        pid for (pid,) in db.query(AuditEntry.project_id)
        .filter(AuditEntry.project_id.isnot(None)).distinct()
    }
    removed = 0
    for pid in sorted(with_rows - held):
        removed += forget_project_audit(db, pid)
    reused = sorted(with_rows & held)
    if reused:
        deletions = (
            db.query(AuditEntry.entity_id, func.max(AuditEntry.id))
            .filter(
                AuditEntry.action == PROJECT_DELETED_ACTION,
                AuditEntry.entity_type == "project",
                AuditEntry.entity_id.in_(reused),
            )
            .group_by(AuditEntry.entity_id)
            .all()
        )
        for pid, deletion_row_id in deletions:
            older = db.query(AuditEntry).filter(
                AuditEntry.project_id == pid, AuditEntry.id < deletion_row_id
            )
            if older.first() is not None:
                removed += older.delete(synchronize_session=False)
    return removed


def log_action(
    db: Session,
    action: str,
    entity_type: str,
    entity_id: int | None = None,
    user_id: int | None = None,
    project_id: int | None = None,
    details: dict[str, Any] | None = None
) -> AuditEntry:
    """
    Create an audit log entry.

    Args:
        db: Database session
        action: Action performed (e.g., 'created', 'updated', 'deleted')
        entity_type: Type of entity (e.g., 'code', 'segment', 'conversation')
        entity_id: ID of the entity
        user_id: ID of the user who performed the action
        project_id: ID of the project (for project-scoped queries)
        details: Additional context as a dict

    Returns:
        The created AuditEntry
    """
    entry = AuditEntry(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        user_id=user_id,
        project_id=project_id,
        details=json.dumps(details) if details else None
    )
    db.add(entry)
    return entry


def get_audit_trail(
    db: Session,
    project_id: int | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
    limit: int = 100
) -> list[AuditEntry]:
    """
    Retrieve audit log entries with optional filters.

    Args:
        db: Database session
        project_id: Filter by project
        entity_type: Filter by entity type
        entity_id: Filter by entity ID
        limit: Maximum number of entries to return

    Returns:
        List of AuditEntry objects, most recent first
    """
    query = db.query(AuditEntry)

    if project_id is not None:
        query = query.filter(AuditEntry.project_id == project_id)
    if entity_type is not None:
        query = query.filter(AuditEntry.entity_type == entity_type)
    if entity_id is not None:
        query = query.filter(AuditEntry.entity_id == entity_id)

    return query.order_by(AuditEntry.timestamp.desc()).limit(limit).all()
