from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


class Code(Base):
    """A qualitative code that can be applied to segments."""
    __tablename__ = "codes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    numeric_id = Column(Integer, nullable=False)  # User-facing numeric code (0, 1, 2, ...)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    color = Column(String(7), nullable=True)  # Hex color code
    is_universal = Column(Boolean, default=False, nullable=False)  # Universal codes: 0, 1
    is_active = Column(Boolean, default=True, nullable=False)  # Soft delete
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Direct FK for flat categories (replaces M2M)
    category_id = Column(Integer, ForeignKey("code_categories.id", ondelete="SET NULL"), nullable=True, index=True)
    category_order = Column(Integer, nullable=True)

    # Effective-code grouping for agreement/consensus (Track J · J2-3), mirrors
    # category_id: a code belongs to at most one equivalence group.
    code_equivalence_group_id = Column(
        Integer, ForeignKey("code_equivalence_groups.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )

    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))

    # Relationships
    project = relationship("Project", back_populates="codes")
    applications = relationship("CodeApplication", back_populates="code", cascade="all, delete-orphan")
    category = relationship("CodeCategory", back_populates="codes")
    code_equivalence_group = relationship("CodeEquivalenceGroup", back_populates="codes")

    __table_args__ = (
        Index("ix_codes_project_numeric", "project_id", "numeric_id", unique=True),
    )


# Universal code constants
UNIVERSAL_CODES = [
    {"numeric_id": 0, "name": "Unsubstantive/Artifact", "description": "Non-substantive content or transcript artifacts", "is_universal": True},
    {"numeric_id": 1, "name": "Unclear", "description": "Content that is unclear or needs review", "is_universal": True},
]
