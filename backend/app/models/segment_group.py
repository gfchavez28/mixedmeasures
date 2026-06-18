from sqlalchemy import Column, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class SegmentGroup(Base):
    """Groups adjacent segments together for unified coding."""
    __tablename__ = "segment_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    segments = relationship("Segment", back_populates="group", order_by="Segment.sequence_order")
