from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class CodeCategory(Base):
    """Category for organizing codes."""
    __tablename__ = "code_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    color = Column(String(7), nullable=True)
    display_order = Column(Integer, default=0, nullable=False)
    parent_id = Column(Integer, ForeignKey("code_categories.id", ondelete="CASCADE"), nullable=True, index=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="categories")
    codes = relationship("Code", back_populates="category", order_by="Code.category_order")
    parent = relationship("CodeCategory", remote_side=[id], back_populates="children")
    children = relationship("CodeCategory", back_populates="parent", order_by="CodeCategory.display_order", passive_deletes=True)


class CodeCategoryMembership(Base):
    """Legacy M2M table — superseded by the Code.category_id direct FK.
    Model retained so Alembic autogenerate doesn't try to drop the table."""
    __tablename__ = "code_category_memberships"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code_id = Column(Integer, ForeignKey("codes.id", ondelete="CASCADE"), nullable=False)
    category_id = Column(Integer, ForeignKey("code_categories.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_code_category_membership_unique", "code_id", "category_id", unique=True),
    )
