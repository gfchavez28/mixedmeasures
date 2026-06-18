"""MetricDefinition and ComputedResult models for the Computed Metrics Engine."""

from sqlalchemy import (
    CheckConstraint, Column, Integer, String, DateTime, Text, Boolean, ForeignKey,
    Index, UniqueConstraint, text,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class MetricDefinition(Base):
    """A researcher-defined metric (frequency distribution, proportion, mean, domain aggregate)."""
    __tablename__ = "metric_definitions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    metric_type = Column(String(50), nullable=False)  # frequency_distribution, proportion, mean, domain_aggregate
    config = Column(Text, nullable=False)  # JSON: metric-specific configuration
    input_source_type = Column(String(50), nullable=False)  # dataset_column, dataset_domain
    input_source_id = Column(Integer, nullable=False)  # polymorphic — no formal FK
    grouping_column_id = Column(
        Integer,
        ForeignKey("dataset_columns.id", ondelete="SET NULL"),
        nullable=True,
    )
    grouping_column_id_2 = Column(
        Integer,
        ForeignKey("dataset_columns.id", ondelete="SET NULL"),
        nullable=True,
    )
    grouping_mode = Column(String(20), nullable=True)  # 'column' (default) or 'dataset'
    exclude_values = Column(Text, nullable=True)  # JSON: ["N/A", "Prefer not to say", ...]
    sequence_order = Column(Integer, nullable=False, default=0)
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)
    # Staleness flag — hooks to auto-set this deferred to Phase 2g
    stale = Column(Boolean, nullable=False, default=False, server_default="0")
    last_accessed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="metric_definitions")
    grouping_column = relationship("DatasetColumn", foreign_keys=[grouping_column_id])
    grouping_column_2 = relationship("DatasetColumn", foreign_keys=[grouping_column_id_2])
    results = relationship(
        "ComputedResult",
        back_populates="metric_definition",
        cascade="all, delete-orphan",
        order_by="ComputedResult.group_value",
    )
    row_scores = relationship(
        "RowScore",
        back_populates="metric_definition",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        CheckConstraint(
            "input_source_type IN ('dataset_column', 'dataset_domain')",
            name="ck_metric_definition_source_type",
        ),
        Index("ix_metric_definitions_project", "project_id"),
        Index("ix_metric_definitions_grouping_column", "grouping_column_id"),
        Index(
            "ix_metric_definitions_project_source",
            "project_id", "input_source_type", "input_source_id",
        ),
    )

    @property
    def result_type(self) -> str:
        """Derived result type: 'distribution', 'comparison', or 'scalar'."""
        if self.metric_type == "frequency_distribution":
            return "distribution"
        if self.grouping_column_id is not None or self.grouping_column_id_2 is not None or self.grouping_mode == "dataset":
            return "comparison"
        return "scalar"


class ComputedResult(Base):
    """A single computed result for a metric definition, optionally grouped."""
    __tablename__ = "computed_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    metric_definition_id = Column(
        Integer,
        ForeignKey("metric_definitions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    group_value = Column(String(255), nullable=True)
    result_data = Column(Text, nullable=False)  # JSON: metric-type-specific result
    valid_n = Column(Integer, nullable=False)
    total_n = Column(Integer, nullable=False)
    computed_at = Column(DateTime, default=func.now(), nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    metric_definition = relationship("MetricDefinition", back_populates="results")

    __table_args__ = (
        UniqueConstraint("metric_definition_id", "group_value", name="uq_computed_results_def_group"),
        # At most one UNGROUPED result (group_value IS NULL) per metric. The
        # UniqueConstraint above does NOT enforce this — SQLite treats NULLs as
        # distinct — so this partial unique index is a real constraint, not just
        # an index. Load-bearing for the crosswalk's ungrouped scale-score lookup
        # (see the internal design notes). Declared here so create_all() (tests)
        # matches the production schema (migration-created uq_computed_results_ungrouped).
        Index(
            "uq_computed_results_ungrouped",
            "metric_definition_id",
            unique=True,
            sqlite_where=text("group_value IS NULL"),
            postgresql_where=text("group_value IS NULL"),
        ),
    )
