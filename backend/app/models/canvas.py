"""Canvas models: Canvas, CanvasTheme, CanvasThemeRelationship,
CanvasPendingItem."""

from sqlalchemy import (
    Column, Integer, Float, String, DateTime, Text, Boolean, ForeignKey,
    Index, CheckConstraint, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class Canvas(Base):
    __tablename__ = "canvases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(255), nullable=False, default="Untitled canvas")
    display_order = Column(Integer, nullable=False, default=0)
    introduction = Column(Text, nullable=True)
    is_archived = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="canvases")
    themes = relationship(
        "CanvasTheme",
        back_populates="canvas",
        cascade="all, delete-orphan",
        order_by="CanvasTheme.doc_order",
    )
    theme_relationships = relationship(
        "CanvasThemeRelationship",
        back_populates="canvas",
        cascade="all, delete-orphan",
    )
    pending_items = relationship(
        "CanvasPendingItem",
        back_populates="canvas",
        cascade="all, delete-orphan",
    )
    snapshots = relationship(
        "CanvasSnapshot",
        back_populates="canvas",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_canvases_project", "project_id"),
    )


class CanvasTheme(Base):
    __tablename__ = "canvas_themes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    canvas_id = Column(
        Integer,
        ForeignKey("canvases.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(255), nullable=False)
    section_type = Column(String(10), nullable=False, default="theme")  # "theme" or "prose"
    description = Column(Text, nullable=True)
    color = Column(String(7), nullable=True)
    doc_order = Column(Integer, nullable=False, default=0)
    table_column_order = Column(Integer, nullable=False, default=0)
    viz_x = Column(Float, nullable=True)
    viz_y = Column(Float, nullable=True)
    # Prose content (Tiptap JSON) — replaces CanvasBlock rows for the Writing View
    content = Column(Text, nullable=True)
    searchable_text = Column(Text, nullable=True)
    referenced_source_ids = Column(Text, nullable=True)  # JSON array of {type, id}
    parent_theme_id = Column(
        Integer,
        ForeignKey("canvas_themes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Self-referential relationship (for future Nest mode)
    parent = relationship("CanvasTheme", remote_side=[id], back_populates="children")
    children = relationship("CanvasTheme", back_populates="parent")

    # Relationships
    canvas = relationship("Canvas", back_populates="themes")
    relationships_out = relationship(
        "CanvasThemeRelationship",
        foreign_keys="CanvasThemeRelationship.source_theme_id",
        back_populates="source_theme",
        cascade="all, delete-orphan",
    )
    relationships_in = relationship(
        "CanvasThemeRelationship",
        foreign_keys="CanvasThemeRelationship.target_theme_id",
        back_populates="target_theme",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_canvas_themes_canvas", "canvas_id"),
        Index("ix_canvas_themes_canvas_doc", "canvas_id", "doc_order"),
    )


class CanvasThemeRelationship(Base):
    __tablename__ = "canvas_theme_relationships"

    id = Column(Integer, primary_key=True, autoincrement=True)
    canvas_id = Column(
        Integer,
        ForeignKey("canvases.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_theme_id = Column(
        Integer,
        ForeignKey("canvas_themes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_theme_id = Column(
        Integer,
        ForeignKey("canvas_themes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    relationship_type = Column(String(30), nullable=False)
    label = Column(String(255), nullable=True)
    weight = Column(Integer, nullable=False, default=1)
    is_bidirectional = Column(Boolean, nullable=False, default=False)
    line_style = Column(String(20), nullable=True)
    line_color = Column(String(7), nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    canvas = relationship("Canvas", back_populates="theme_relationships")
    source_theme = relationship(
        "CanvasTheme",
        foreign_keys=[source_theme_id],
        back_populates="relationships_out",
    )
    target_theme = relationship(
        "CanvasTheme",
        foreign_keys=[target_theme_id],
        back_populates="relationships_in",
    )

    __table_args__ = (
        CheckConstraint(
            "source_theme_id != target_theme_id",
            name="ck_canvas_theme_rel_not_self",
        ),
        UniqueConstraint(
            "canvas_id", "source_theme_id", "target_theme_id",
            name="uq_canvas_theme_rel_pair",
        ),
        Index("ix_canvas_theme_rels_canvas", "canvas_id"),
    )


class CanvasPendingItem(Base):
    """Lightweight inbox for items sent to a canvas from Analysis/Coding views.

    The Writing View renders them in the Unsorted section. When the researcher
    embeds one into prose, the pending row is deleted and a Tiptap embed node
    is inserted into theme content.

    source_id is polymorphic (no FK constraint) — the item_type determines
    which table it refers to (excerpt, material, memo).
    """
    __tablename__ = "canvas_pending_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    canvas_id = Column(
        Integer,
        ForeignKey("canvases.id", ondelete="CASCADE"),
        nullable=False,
    )
    item_type = Column(String(30), nullable=False)
    source_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    canvas = relationship("Canvas", back_populates="pending_items")

    __table_args__ = (
        Index("ix_canvas_pending_items_canvas", "canvas_id"),
    )


class CanvasSnapshot(Base):
    __tablename__ = "canvas_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    canvas_id = Column(
        Integer,
        ForeignKey("canvases.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(255), nullable=False)
    snapshot_data = Column(Text, nullable=False)
    theme_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    canvas = relationship("Canvas", back_populates="snapshots")

    __table_args__ = (
        Index("ix_canvas_snapshots_canvas", "canvas_id"),
    )
