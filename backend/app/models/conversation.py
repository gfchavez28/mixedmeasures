from sqlalchemy import Boolean, Column, Float, Integer, String, DateTime, Enum, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
import enum
from ..database import Base


class ConversationStatus(str, enum.Enum):
    IMPORTED = "imported"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


# Formats stored with media_type='video' (the format seam lives in
# routers/media.py::_detect_format; this membership set is hosted here so
# services — backup video-exclusion, storage accounting — can consume it
# without importing router modules).
VIDEO_FORMATS = frozenset({"mp4", "mov", "webm"})


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    subject_id = Column(String(100), nullable=True)  # Anonymized identifier for research subject
    conversation_date = Column(DateTime, nullable=True)  # Date the conversation took place (any type: interview, focus group, meeting)
    status = Column(Enum(ConversationStatus, values_callable=lambda x: [e.value for e in x]), default=ConversationStatus.IMPORTED, nullable=False)
    summary = Column(Text, nullable=True)
    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    # #1639 (r2-1): a deleted row's id is never handed to the next row — a joint display
    # (and every other stored reference) names rows by id with no FK. Migration
    # `c3a7e1f9b5d8` makes the same table; `schema_diff_harness` compares.
    __table_args__ = {"sqlite_autoincrement": True}
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Media (audio/video) fields — E3 audio playback alongside transcripts
    media_filename = Column(String(500), nullable=True)
    media_format = Column(String(10), nullable=True)  # "mp3", "m4a", "wav" audio; VIDEO_FORMATS video
    media_type = Column(String(10), nullable=True)  # "audio" | "video"
    media_duration_seconds = Column(Float, nullable=True)
    media_offset_seconds = Column(Float, nullable=False, default=0.0)
    media_is_vbr = Column(Boolean, nullable=True)

    # Relationships
    project = relationship("Project", back_populates="conversations")
    # #1035: passive — the database's ON DELETE CASCADE removes what is not loaded
    # (project.py explains; never on a SET NULL relationship).
    segments = relationship("Segment", back_populates="conversation", cascade="all, delete-orphan", passive_deletes=True, order_by="Segment.sequence_order")
    attached_notes = relationship("Note", back_populates="conversation", cascade="all, delete-orphan", passive_deletes=True, order_by="Note.sequence_number")
