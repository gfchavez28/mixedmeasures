from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


class Participant(Base):
    """A person involved in a project -- may be a dataset record,
    conversation speaker, or both."""
    __tablename__ = "participants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    identifier = Column(String(100), nullable=False)  # Anonymized ID, e.g. "B-03", "S-07"
    display_name = Column(String(255), nullable=True)  # Optional human-readable name
    role = Column(String(100), nullable=True)  # e.g. "board", "staff", "eo", "self"
    demographics = Column(Text, nullable=True)  # JSON string for flexible demographic data
    role_auto_filled_from = Column(String(255), nullable=True)  # e.g. "Board Survey · R0003"
    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="participants")
    speakers = relationship("Speaker", back_populates="participant")
    dataset_rows = relationship("DatasetRow", back_populates="participant")

    __table_args__ = (
        Index("ix_participants_project_identifier", "project_id", "identifier", unique=True),
        Index("ix_participants_project_role", "project_id", "role"),
    )
