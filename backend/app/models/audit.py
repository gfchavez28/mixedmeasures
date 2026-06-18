from sqlalchemy import Column, Integer, String, DateTime, Text
from sqlalchemy.sql import func
from ..database import Base


class AuditEntry(Base):
    """Immutable audit log for all significant actions."""
    __tablename__ = "audit_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, default=func.now(), nullable=False, index=True)
    user_id = Column(Integer, nullable=True)  # Null for system actions
    action = Column(String(50), nullable=False, index=True)
    entity_type = Column(String(50), nullable=False, index=True)
    entity_id = Column(Integer, nullable=True)
    details = Column(Text, nullable=True)  # JSON string for additional context
    project_id = Column(Integer, nullable=True, index=True)  # For project-scoped queries
