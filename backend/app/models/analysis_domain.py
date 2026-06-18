"""AnalysisDomain and AnalysisDomainMember models for grouping columns into analytical constructs."""

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class AnalysisDomain(Base):
    """A researcher-defined construct (e.g., 'Psychological Safety') grouping columns."""
    __tablename__ = "analysis_domains"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    color = Column(String(7), nullable=True)  # hex color e.g. '#3b82f6'
    sequence_order = Column(Integer, nullable=True)
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="analysis_domains")
    members = relationship(
        "AnalysisDomainMember",
        back_populates="domain",
        cascade="all, delete-orphan",
        order_by="AnalysisDomainMember.sequence_order",
    )


class AnalysisDomainMember(Base):
    """Membership: links a domain to a column."""
    __tablename__ = "analysis_domain_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    domain_id = Column(Integer, ForeignKey("analysis_domains.id", ondelete="CASCADE"), nullable=False, index=True)
    member_type = Column(String(20), nullable=False)  # "column"
    member_id = Column(Integer, nullable=False)  # polymorphic — no formal FK
    sequence_order = Column(Integer, nullable=True)
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("domain_id", "member_type", "member_id", name="uq_domain_member"),
    )

    # Relationships
    domain = relationship("AnalysisDomain", back_populates="members")
