"""StatisticalTest model for supplementary statistical analyses."""

from sqlalchemy import (
    CheckConstraint, Column, Integer, String, DateTime, Text, Boolean, ForeignKey, Index,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class StatisticalTest(Base):
    """A researcher-defined statistical test (Cronbach's alpha, t-test, ANOVA)."""
    __tablename__ = "statistical_tests"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    test_type = Column(String(50), nullable=False)  # cronbachs_alpha, independent_t_test, one_way_anova
    config = Column(Text, nullable=False, default="{}", server_default="{}")  # JSON
    target_type = Column(String(50), nullable=False)  # analysis_domain, metric_definition
    target_id = Column(Integer, nullable=False)  # polymorphic — no formal FK
    result_data = Column(Text, nullable=True)  # JSON
    valid_n = Column(Integer, nullable=True)
    stale = Column(Boolean, nullable=False, default=True, server_default="1")
    computed_at = Column(DateTime, nullable=True)
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="statistical_tests")

    __table_args__ = (
        CheckConstraint(
            "target_type IN ('analysis_domain', 'metric_definition')",
            name="ck_statistical_test_target_type",
        ),
        Index("ix_statistical_tests_project", "project_id"),
        Index("ix_statistical_tests_target", "target_type", "target_id"),
    )
