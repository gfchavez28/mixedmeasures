import json
from typing import Any
from sqlalchemy.orm import Session
from ..models.audit import AuditEntry


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
