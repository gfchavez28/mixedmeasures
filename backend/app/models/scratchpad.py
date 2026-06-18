from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class ScratchpadEntry(Base):
    """Quick-capture thoughts that can later be converted to memos or discarded."""
    __tablename__ = "scratchpad_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    numeric_id = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    context_hint = Column(String(255), nullable=True)
    resolved = Column(Boolean, default=False, nullable=False)
    resolved_into_type = Column(String(20), nullable=True)  # 'memo' | 'deleted'
    resolved_into_id = Column(Integer, nullable=True)  # polymorphic, no hard FK
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    project = relationship("Project", back_populates="scratchpad_entries")
