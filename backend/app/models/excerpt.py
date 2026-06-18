from sqlalchemy import Column, Integer, DateTime, ForeignKey, Index, CheckConstraint, text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class Excerpt(Base):
    """A saved text selection from a segment or comment response.

    Supports whole-segment excerpts (offsets NULL) and sub-segment excerpts
    (start_offset/end_offset specify character range within segment text).

    Invariant: Exactly one of segment_id, dataset_value_id must be NOT NULL.
    Enforced by CHECK constraint ck_excerpt_exactly_one_target.
    """
    __tablename__ = "excerpt"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    segment_id = Column(Integer, ForeignKey("segments.id", ondelete="CASCADE"), nullable=True, index=True)
    dataset_value_id = Column(Integer, ForeignKey("dataset_values.id", ondelete="CASCADE"), nullable=True, index=True)
    start_offset = Column(Integer, nullable=True)
    end_offset = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="excerpts")
    segment = relationship("Segment", back_populates="excerpts")
    dataset_value = relationship("DatasetValue", back_populates="excerpts")
    note = relationship("Note", back_populates="excerpt", uselist=False)

    __table_args__ = (
        CheckConstraint(
            '(segment_id IS NOT NULL AND dataset_value_id IS NULL) OR '
            '(segment_id IS NULL AND dataset_value_id IS NOT NULL)',
            name='ck_excerpt_exactly_one_target'
        ),
        CheckConstraint(
            '(start_offset IS NULL AND end_offset IS NULL) OR '
            '(start_offset IS NOT NULL AND end_offset IS NOT NULL)',
            name='ck_excerpt_offsets_both_or_neither'
        ),
        CheckConstraint(
            'start_offset IS NULL OR (start_offset >= 0 AND end_offset > start_offset)',
            name='ck_excerpt_offsets_valid_range'
        ),
        Index('ix_excerpt_project_segment', 'project_id', 'segment_id'),
        Index('ix_excerpt_project_dataset_value', 'project_id', 'dataset_value_id'),
        Index('ix_excerpt_segment_whole', 'segment_id',
              unique=True, sqlite_where=text('segment_id IS NOT NULL AND start_offset IS NULL')),
        Index('ix_excerpt_segment_range', 'segment_id', 'start_offset', 'end_offset',
              unique=True, sqlite_where=text('segment_id IS NOT NULL AND start_offset IS NOT NULL')),
    )
