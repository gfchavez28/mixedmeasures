"""MaterialCollection and Material models for the materials system."""

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class MaterialCollection(Base):
    """A collection containing saved analysis materials for a project."""
    __tablename__ = "material_collections"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(255), nullable=False, default="Materials")
    display_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="material_collections")
    materials = relationship(
        "Material",
        back_populates="collection",
        cascade="all, delete-orphan",
        order_by="Material.display_order",
    )

    __table_args__ = (
        Index("ix_material_collections_project", "project_id"),
    )


class Material(Base):
    """A single saved analysis material within a collection."""
    __tablename__ = "materials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    collection_id = Column(
        Integer,
        ForeignKey("material_collections.id", ondelete="CASCADE"),
        nullable=False,
    )
    material_type = Column(String(50), nullable=False)
    config = Column(Text, nullable=False)  # JSON
    auto_name = Column(String(500), nullable=False)
    custom_name = Column(String(255), nullable=True)
    display_order = Column(Integer, nullable=False, default=0)
    source_tab = Column(String(40), nullable=False, default="descriptives")
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    collection = relationship("MaterialCollection", back_populates="materials")

    __table_args__ = (
        Index("ix_materials_collection", "collection_id"),
    )
