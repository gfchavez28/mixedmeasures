from sqlalchemy import Column, Integer, String, DateTime, Float, Text, ForeignKey, Index, CheckConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


class Segment(Base):
    """Atomic unit of codable text — a single utterance (conversation) or text chunk (document)."""
    __tablename__ = "segments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True, index=True)
    speaker_id = Column(Integer, ForeignKey("speakers.id", ondelete="SET NULL"), nullable=True, index=True)
    sequence_order = Column(Integer, nullable=False)  # Order within conversation
    start_time = Column(Float, nullable=True)  # Seconds from conversation start
    end_time = Column(Float, nullable=True)
    text = Column(Text, nullable=False)
    word_count = Column(Integer, nullable=True)
    original_speaker_label = Column(String(255), nullable=True)
    document_id = Column(Integer, ForeignKey("documents.id", ondelete="CASCADE"), nullable=True, index=True)
    page_number = Column(Integer, nullable=True)    # page in source PDF (1-based), null for non-PDF
    heading_level = Column(Integer, nullable=True)   # 1-6 if segment was derived from a heading, else null
    group_id = Column(Integer, ForeignKey("segment_groups.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Quoting (Issue 118) — deprecated column, kept for migration compat
    is_starred = Column(Integer, default=0, nullable=False)

    # Merge tracking for soft-delete undo (Issue 100)
    # When merged_into_id is not null, this segment is soft-deleted (merged into another)
    merged_into_id = Column(Integer, ForeignKey("segments.id", ondelete="SET NULL"), nullable=True, index=True)
    # 1 if this segment was created by merging others (allows unmerge)
    is_merge_result = Column(Integer, default=0, nullable=False)

    # Split tracking for soft-delete undo (mirrors merge pattern)
    # When split_into_id is not null, this segment is soft-deleted (split into parts)
    split_into_id = Column(Integer, ForeignKey("segments.id", ondelete="SET NULL"), nullable=True, index=True)
    # 1 if this segment was created by splitting another (allows unsplit/rejoin)
    is_split_result = Column(Integer, default=0, nullable=False)

    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))

    # Relationships
    conversation = relationship("Conversation", back_populates="segments")
    document = relationship("Document", back_populates="segments")
    speaker = relationship("Speaker", back_populates="segments")
    group = relationship("SegmentGroup", back_populates="segments")
    code_applications = relationship("CodeApplication", back_populates="segment", cascade="all, delete-orphan")
    attached_notes = relationship("Note", back_populates="segment")
    excerpts = relationship("Excerpt", back_populates="segment", cascade="all, delete-orphan")

    # Self-referencing relationship for merge tracking
    original_segments = relationship(
        "Segment",
        foreign_keys=[merged_into_id],
        backref="merged_into",
        remote_side="Segment.id"
    )

    # Self-referencing relationship for split tracking
    split_original_segments = relationship(
        "Segment",
        foreign_keys=[split_into_id],
        backref="split_into",
        remote_side="Segment.id"
    )

    __table_args__ = (
        CheckConstraint(
            '(conversation_id IS NOT NULL AND document_id IS NULL) OR '
            '(conversation_id IS NULL AND document_id IS NOT NULL)',
            name='ck_segment_exactly_one_parent'
        ),
        Index("ix_segments_conversation_sequence", "conversation_id", "sequence_order"),
        Index("ix_segments_conversation_starred", "conversation_id", "is_starred"),
        Index("ix_segments_document_sequence", "document_id", "sequence_order"),
    )
