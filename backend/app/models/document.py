from sqlalchemy import Column, Integer, String, DateTime, Enum, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from ..database import Base


class SegmentationMode(str, enum.Enum):
    PARAGRAPH = "paragraph"
    SENTENCE = "sentence"
    HEADING = "heading"
    PAGE = "page"
    DOUBLE_NEWLINE = "double_newline"


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    source_filename = Column(String(500), nullable=False)
    source_format = Column(String(10), nullable=False)  # "docx", "pdf", "txt"
    segmentation_mode = Column(
        Enum(SegmentationMode, values_callable=lambda x: [e.value for e in x]),
        default=SegmentationMode.PARAGRAPH,
        nullable=False,
    )
    page_count = Column(Integer, nullable=True)
    summary = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="documents")
    segments = relationship("Segment", back_populates="document",
                            cascade="all, delete-orphan",
                            order_by="Segment.sequence_order")
    notes = relationship("Note", back_populates="document",
                         cascade="all, delete-orphan")
