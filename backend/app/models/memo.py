from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


#: The entities a memo can hang off — THE vocabulary, declared once (#780).
#:
#: ⚠️ **`Memo.entity_id` carries no ForeignKey**, so nothing at the database
#: level relates this list to anything. That is what makes every consumer that
#: re-declares it a silent-corruption risk rather than an inconvenience: a type
#: one of them has not heard of is copied verbatim by the `.mmproject` import
#: and points at whatever row happens to own that id locally.
#:
#: It was declared FIVE times before this constant existed — the schema regex,
#: `MEMO_ENTITY_REMAP`, two validation chains and this file's own comments — and
#: three of them disagreed. Adding a memo-able entity means adding it HERE, and
#: `routers/memos.py` then fails at import until it has an ownership rule.
#:
#: ⚠️ Not to be confused with `log_action(entity_type=…)`, the audit log's own
#: unrelated vocabulary (`code_application`, `speaker`, `blind_mode`, …).
MEMO_ENTITY_TYPES: tuple[str, ...] = (
    "project",
    "conversation",
    "observation",
    "document",
    "code",
    "code_category",
    "analysis",
    "dataset",
    "dataset_row",
    "dataset_column",
    "canvas",
)


class Memo(Base):
    """Analytical reflections attached to one of `MEMO_ENTITY_TYPES`.

    ⚠️ The list is deliberately NOT repeated here — this docstring said
    *"project, conversation, code, or code category"* and the column comment
    below said five types, while the real vocabulary had grown to eleven. A
    prose enumeration beside a constant is a count, and counts rot.
    """
    __tablename__ = "memos"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    numeric_id = Column(Integer, nullable=False)  # Human-friendly ID per project (M-1, M-2, etc.)
    entity_type = Column(String(50), nullable=False)  # one of MEMO_ENTITY_TYPES, above
    entity_id = Column(Integer, nullable=False)
    title = Column(String(255), nullable=True)
    content = Column(Text, nullable=False, default="")
    is_archived = Column(Boolean, default=False, nullable=False)
    # Track J · J3-2-0b: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    project = relationship("Project", back_populates="memos")

    __table_args__ = (
        Index("ix_memos_entity", "entity_type", "entity_id"),
    )
