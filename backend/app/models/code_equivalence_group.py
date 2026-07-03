"""CodeEquivalenceGroup — codes that mean the same thing (the 'effective code' seam).

Track J · J2-3. Mirrors `EquivalenceGroup` (cross-dataset column equivalence) for
codes: agreement / consensus is computed on an *effective code*, so two coders who
applied "Positive" and "POSITIVE" (grouped) count as agreeing. Membership is a
single nullable FK on `Code` (`Code.code_equivalence_group_id`, mirroring
`Code.category_id`) — a code belongs to at most one group, so the resolver returns
exactly one effective code.

`canonical_code_id` is a plain int (NOT a formal FK): a FK to `codes` would create
a `codes` ↔ `code_equivalence_groups` cycle that is fragile under SQLite
`create_all`. The effective-code resolver validates it against the live member set
(falling back to the lowest member `code_id`), so a stale canonical is harmless.
"""
from uuid import uuid4

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class CodeEquivalenceGroup(Base):
    """A named group of codes treated as one effective code for agreement/consensus."""
    __tablename__ = "code_equivalence_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    # Track J · J3-2b: stable per-group identity so a re-export → re-merge of an
    # already-reconciled project matches its equivalence groups across copies instead
    # of duplicating them (the rest of the coded spine got uuids in J3-2-0/0b; this
    # extends it to the reconciliation substrate). Fresh-stamped on import-as-new,
    # preserved on merge/overwrite — handled by _build_entity(fresh_uuid=...).
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    label = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    sequence_order = Column(Integer, nullable=True)
    # The canonical "effective code" the consensus layer writes for this group.
    # Null → the resolver falls back to the lowest member code_id. App-validated
    # against the live member set (no FK — see module docstring).
    canonical_code_id = Column(Integer, nullable=True)
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="code_equivalence_groups")
    # passive_deletes=True: trust the DB-level `ON DELETE SET NULL` on
    # Code.code_equivalence_group_id; do NOT let the unit of work issue
    # pre-delete UPDATEs that nullify codes already moved elsewhere (the
    # merge_groups foot-gun — the internal design notes foot-gun #1).
    codes = relationship(
        "Code",
        back_populates="code_equivalence_group",
        passive_deletes=True,
    )
