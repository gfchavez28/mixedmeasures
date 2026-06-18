from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class Memo(Base):
    """Analytical reflections attached to a project, conversation, code, or code category."""
    __tablename__ = "memos"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    numeric_id = Column(Integer, nullable=False)  # Human-friendly ID per project (M-1, M-2, etc.)
    entity_type = Column(String(50), nullable=False)  # "project", "conversation", "code", "code_category", "analysis"
    entity_id = Column(Integer, nullable=False)
    title = Column(String(255), nullable=True)
    content = Column(Text, nullable=False, default="")
    is_archived = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    project = relationship("Project", back_populates="memos")

    __table_args__ = (
        Index("ix_memos_entity", "entity_type", "entity_id"),
    )
