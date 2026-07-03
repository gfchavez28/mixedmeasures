from sqlalchemy import Column, Integer, DateTime, ForeignKey, Index, CheckConstraint, text
from sqlalchemy.sql import func
from ..database import Base


class ConsensusStaleTarget(Base):
    """A target whose derived consensus layer needs recompute (Track J · J2-3, Slab 5).

    Write-side staleness, mirroring ``staleness.py``'s role for metrics. Cheap
    single-target apply/remove recompute the consensus inline and never mark;
    bulk / cascade mutations (segment merge/split/unmerge, code merge,
    equivalence-group edits) instead record a marker here and let a background
    sweep drain it — keeping those mutations off a potentially large synchronous
    rebuild (DEC-C / ADJ-3: write-side, never recompute-on-read).

    One row per stale target (segment XOR dataset value, like ``CodeApplication``);
    the partial unique indexes make marking idempotent so repeated marks coalesce.
    ``project_id`` lets the sweep scope a drain and survives target deletion via
    CASCADE.
    """
    __tablename__ = "consensus_stale_targets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    segment_id = Column(Integer, ForeignKey("segments.id", ondelete="CASCADE"), nullable=True)
    dataset_value_id = Column(Integer, ForeignKey("dataset_values.id", ondelete="CASCADE"), nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            '(segment_id IS NOT NULL AND dataset_value_id IS NULL) OR '
            '(segment_id IS NULL AND dataset_value_id IS NOT NULL)',
            name='ck_consensus_stale_target_exactly_one_target'
        ),
        Index("ix_consensus_stale_target_segment_unique", "segment_id",
              unique=True, sqlite_where=text("segment_id IS NOT NULL")),
        Index("ix_consensus_stale_target_value_unique", "dataset_value_id",
              unique=True, sqlite_where=text("dataset_value_id IS NOT NULL")),
    )
