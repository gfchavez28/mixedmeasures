from sqlalchemy import Column, Integer, Float, String, DateTime, ForeignKey, Index, CheckConstraint, and_, text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


class Excerpt(Base):
    """A saved selection from a segment or comment response — THREE shapes (slab 5):

    - whole-segment: offsets AND times all NULL (a whole transcript turn,
      document paragraph, or observation clip marked as a quote)
    - char-range: start_offset/end_offset set (a character range within a
      conversation/document segment's text — never on observation clips,
      whose `text` is just a label)
    - time-range: start_time/end_time set (a sub-clip range on an observation
      clip, in ABSOLUTE timeline seconds — never clip-relative, so a later
      clip-boundary edit re-anchors nothing; D29). `end_time >= start_time`
      deliberately allows point quotes (D7 symmetry), unlike the char shape's
      strict `>`.

    Shape is exclusive (ck_excerpt_one_shape); times require a segment target
    (ck_excerpt_times_segment_only — comment excerpts are whole-only).

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
    # Time-range shape (slab 5, D29): absolute timeline seconds on an
    # observation clip. Nullable Floats ride `.mmproject` export/import via
    # reflection automatically (no format bump — see plan §8j.0.1).
    start_time = Column(Float, nullable=True)
    end_time = Column(Float, nullable=True)
    # Track J · J3-2-0b: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
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
        CheckConstraint(
            '(start_time IS NULL AND end_time IS NULL) OR '
            '(start_time IS NOT NULL AND end_time IS NOT NULL)',
            name='ck_excerpt_times_both_or_neither'
        ),
        # `>=` (not the char shape's strict `>`): a point quote marks an
        # instant — D7 symmetry with point-event clips.
        CheckConstraint(
            'start_time IS NULL OR (start_time >= 0 AND end_time >= start_time)',
            name='ck_excerpt_times_valid_range'
        ),
        # One shape per excerpt: char offsets and a time range never coexist.
        CheckConstraint(
            'start_offset IS NULL OR start_time IS NULL',
            name='ck_excerpt_one_shape'
        ),
        # Written as "times ⇒ segment" — the inverse would break every existing
        # comment-excerpt row (they force segment_id NULL and carry no times).
        CheckConstraint(
            'start_time IS NULL OR segment_id IS NOT NULL',
            name='ck_excerpt_times_segment_only'
        ),
        Index('ix_excerpt_project_segment', 'project_id', 'segment_id'),
        Index('ix_excerpt_project_dataset_value', 'project_id', 'dataset_value_id'),
        # The whole-shape predicate MUST exclude both sub-shapes: a time-range
        # excerpt also has NULL offsets, so the pre-slab-5 predicate
        # (`start_offset IS NULL` alone) would treat it as THE whole-segment
        # excerpt and refuse a second time excerpt on the same clip (§8j.0.2).
        Index('ix_excerpt_segment_whole', 'segment_id',
              unique=True,
              sqlite_where=text('segment_id IS NOT NULL AND start_offset IS NULL AND start_time IS NULL')),
        Index('ix_excerpt_segment_range', 'segment_id', 'start_offset', 'end_offset',
              unique=True, sqlite_where=text('segment_id IS NOT NULL AND start_offset IS NOT NULL')),
        Index('ix_excerpt_segment_time_range', 'segment_id', 'start_time', 'end_time',
              unique=True, sqlite_where=text('segment_id IS NOT NULL AND start_time IS NOT NULL')),
    )


# ── Excerpt-shape predicates (slab 5, §8j.0.2) ──────────────────────────────
# "Which excerpts count as X" is decided HERE, once. Before slab 5 the whole-
# segment decision was an inline `start_offset IS NULL` in eight places; the
# moment `start_time` exists that predicate matches TWO shapes, so every
# inline copy silently changes meaning. Route through these — never re-inline.

def whole_segment_excerpt_filter():
    """Shape-EXACT: the one whole-segment excerpt a segment may carry.

    Mirrors ix_excerpt_segment_whole's predicate. Used by the create/bulk
    duplicate guards and anything implementing the quote TOGGLE semantics
    (the workbench `s` verb toggles exactly this shape — its unquote must
    never find-and-delete a time-range excerpt).
    """
    return and_(
        Excerpt.segment_id.isnot(None),
        Excerpt.start_offset.is_(None),
        Excerpt.start_time.is_(None),
    )


def segment_has_any_quote_filter():
    """Shape-AGNOSTIC quote flag: whole-segment OR time-range.

    Used by DISPLAY surfaces (Content `is_quoted`, the coded-segments CSV
    "Is Quoted", Excel's "Quoted" flag): a clip quoted only by a sub-range IS
    quoted in the researcher sense. Char-range excerpts are deliberately
    EXCLUDED — they never marked a segment quoted pre-slab-5, and widening
    the flag to them would silently change every conversation/document
    surface (D32).
    """
    return and_(
        Excerpt.segment_id.isnot(None),
        Excerpt.start_offset.is_(None),
    )
