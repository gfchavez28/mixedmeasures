from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Index, CheckConstraint, text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


class Note(Base):
    """Annotation note attached to a conversation segment, dataset comment, or document segment.

    For conversation notes: conversation_id is set, segment_id optionally set.
    For comment notes: dataset_value_id is set, conversation_id is NULL.
    For document notes: document_id is set, segment_id optionally set.
    Comment/document notes must be created via db.add(), not via relationship append.
    Comment/document notes use Note.id for display ordering (sequence_number is set to 0).

    Optionally linked to an excerpt via excerpt_id (one note per excerpt).

    Invariant: At least one of conversation_id, dataset_value_id, document_id must be NOT NULL.
    """
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True, index=True)
    segment_id = Column(Integer, ForeignKey("segments.id", ondelete="SET NULL"), nullable=True, index=True)
    dataset_value_id = Column(Integer, ForeignKey("dataset_values.id", ondelete="CASCADE"), nullable=True, index=True)
    document_id = Column(Integer, ForeignKey("documents.id", ondelete="CASCADE"), nullable=True, index=True)
    excerpt_id = Column(Integer, ForeignKey("excerpt.id", ondelete="SET NULL"), nullable=True)
    content = Column(Text, nullable=False)
    sequence_number = Column(Integer, nullable=False)
    is_archived = Column(Boolean, default=False, nullable=False)
    # Track J · J3-2-0b: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    conversation = relationship("Conversation", back_populates="attached_notes")
    document = relationship("Document", back_populates="notes")
    segment = relationship("Segment", back_populates="attached_notes")
    dataset_value = relationship("DatasetValue", back_populates="attached_notes")
    excerpt = relationship("Excerpt", back_populates="note")

    __table_args__ = (
        CheckConstraint(
            'conversation_id IS NOT NULL OR dataset_value_id IS NOT NULL OR document_id IS NOT NULL',
            name='ck_note_at_least_one_parent'
        ),
        Index('ix_notes_excerpt_unique', 'excerpt_id',
              unique=True, sqlite_where=text('excerpt_id IS NOT NULL')),
        Index('ix_notes_conversation_seq', 'conversation_id', 'sequence_number'),
    )
