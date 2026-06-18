"""RowScore model — per-row metric scores for export to R/SPSS."""

from sqlalchemy import (
    Column, Integer, Float, DateTime, ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class RowScore(Base):
    """A single row's score for a metric definition.

    Stores one row per (metric_definition, dataset_row) pair.
    score=NULL means the row was excluded or had insufficient data
    (maps to NA in R/SPSS exports).
    """
    __tablename__ = "row_scores"

    id = Column(Integer, primary_key=True, autoincrement=True)
    metric_definition_id = Column(
        Integer,
        ForeignKey("metric_definitions.id", ondelete="CASCADE"),
        nullable=False,
    )
    dataset_row_id = Column(
        Integer,
        ForeignKey("dataset_rows.id", ondelete="CASCADE"),
        nullable=False,
    )
    score = Column(Float, nullable=True)
    computed_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    metric_definition = relationship("MetricDefinition", back_populates="row_scores")
    dataset_row = relationship("DatasetRow", back_populates="row_scores")

    __table_args__ = (
        Index("ix_row_scores_metric", "metric_definition_id"),
        UniqueConstraint(
            "metric_definition_id", "dataset_row_id",
            name="uq_row_scores_metric_row",
        ),
        Index("ix_row_scores_row", "dataset_row_id"),
    )
