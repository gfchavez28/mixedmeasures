from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class Speaker(Base):
    """Distinct speaker within a project (facilitator or participant)."""
    __tablename__ = "speakers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    original_label = Column(String(255), nullable=True)  # Original label from CSV
    is_facilitator = Column(Integer, default=0, nullable=False)  # 1 = facilitator, 0 = participant
    color_index = Column(Integer, default=0, nullable=False)  # Color index for visual distinction
    color = Column(String(7), nullable=True)  # Custom hex color (e.g. #3b82f6), overrides color_index
    participant_id = Column(Integer, ForeignKey("participants.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="speakers")
    participant = relationship("Participant", back_populates="speakers")
    segments = relationship("Segment", back_populates="speaker")

    __table_args__ = (
        Index("ix_speakers_project_facilitator", "project_id", "is_facilitator"),
    )
