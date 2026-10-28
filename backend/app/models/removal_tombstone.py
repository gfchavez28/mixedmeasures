"""#1190 — what a withdrawal removed, remembered so nothing brings it back.

A row names ONE removed thing by its Track J ``uuid`` (the identity a merge
matches on), or a withdrawn person by a hash of their identifier (the key
participant linking matches on). It holds no words.

🔴 **Keyed on the PROJECT'S UUID, deliberately with no foreign key.** An
overwrite import deletes the project tree and re-creates it under the same
identity, and a deleted project can be re-imported from an old copy as a
coding copy: a tombstone that went with the project would be gone exactly when
an older copy arrives. (Contrast `audit_entries`, #1230, whose id-keyed rows
leaked into the next project given the id — a uuid is never reused.)
"""

from sqlalchemy import Column, DateTime, Index, Integer, String
from sqlalchemy.sql import func

from ..database import Base


class RemovalTombstone(Base):
    __tablename__ = "removal_tombstones"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_uuid = Column(String(36), nullable=False)
    #: participant · speaker · dataset_row · excerpt · note · segment_blanked ·
    #: participant_reinstated (D12: NOT a removal — the vocabulary is
    #: `services/tombstones.ENTITY_TYPES`)
    entity_type = Column(String(32), nullable=False)
    entity_uuid = Column(String(36), nullable=True)
    #: participant tombstones only — `services/tombstones.identifier_hash`.
    identifier_hash = Column(String(64), nullable=True)
    #: "withdrawal" (what a withdrawal removed) or "reinstated" (D12's confirmed
    #: re-use of a withdrawn identifier).
    reason = Column(String(16), nullable=False, default="withdrawal")
    created_at = Column(DateTime, default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_removal_tombstones_project", "project_uuid", "entity_type"),
    )
