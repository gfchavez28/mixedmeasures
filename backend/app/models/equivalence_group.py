"""EquivalenceGroup model for cross-dataset column equivalence."""

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class EquivalenceGroup(Base):
    """A named group of columns across datasets that measure the same construct."""
    __tablename__ = "equivalence_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    sequence_order = Column(Integer, nullable=True)
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="equivalence_groups")
    # passive_deletes=True: trust the DB-level `ON DELETE SET NULL` on
    # DatasetColumn.equivalence_group_id; do NOT let SQLAlchemy's unit of work
    # issue pre-delete UPDATEs that nullify columns which have already been
    # explicitly moved elsewhere (e.g., during merge_groups).
    columns = relationship(
        "DatasetColumn",
        back_populates="equivalence_group",
        passive_deletes=True,
    )
