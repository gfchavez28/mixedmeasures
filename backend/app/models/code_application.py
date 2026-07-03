from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Index, CheckConstraint, text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class CodeApplication(Base):
    """Join table tracking which codes are applied to segments or comment responses.

    Invariant: Exactly one of segment_id, dataset_value_id must be NOT NULL.
    Enforced by CHECK constraint ck_code_application_exactly_one_target.
    """
    __tablename__ = "code_applications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    segment_id = Column(Integer, ForeignKey("segments.id", ondelete="CASCADE"), nullable=True, index=True)
    dataset_value_id = Column(Integer, ForeignKey("dataset_values.id", ondelete="CASCADE"), nullable=True, index=True)
    code_id = Column(Integer, ForeignKey("codes.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attribution = Column(String(255), nullable=True)
    # Provenance reserve (Track J · J1): hand-applied vs consensus-derived vs ai-suggested
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)  # D15 consultation / provenance home
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    segment = relationship("Segment", back_populates="code_applications")
    dataset_value = relationship("DatasetValue", back_populates="code_applications")
    code = relationship("Code", back_populates="applications")

    __table_args__ = (
        CheckConstraint(
            '(segment_id IS NOT NULL AND dataset_value_id IS NULL) OR '
            '(segment_id IS NULL AND dataset_value_id IS NOT NULL)',
            name='ck_code_application_exactly_one_target'
        ),
        # Per-coder uniqueness (Track J · J2-A): one application per
        # (target, code, CODER). Widened from (target, code) so each coder has an
        # independent layer over the same material. NULL user_id (legacy, pre-J1)
        # rows are distinct in SQLite unique indexes; D7 backfill (NULL → an
        # "Unattributed" coder) is deferred to the layer-aware-counts slab (J2-2).
        Index("ix_code_applications_seg_code_user_unique", "segment_id", "code_id", "user_id",
              unique=True, sqlite_where=text("segment_id IS NOT NULL")),
        Index("ix_code_applications_value_code_user_unique", "dataset_value_id", "code_id", "user_id",
              unique=True, sqlite_where=text("dataset_value_id IS NOT NULL")),
        # Partial index over the consensus layer (Track J · J2-5). `origin` leads
        # every consensus query but was unindexed; consensus is a minority of rows
        # so a partial index is cheap. Non-unique (many rows share 'consensus').
        Index("ix_code_applications_consensus", "origin",
              sqlite_where=text("origin='consensus'")),
    )
