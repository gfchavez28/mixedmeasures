from sqlalchemy import Column, Integer, String, DateTime, Enum, Text, JSON, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
import uuid
from ..database import Base


class ProjectStatus(str, enum.Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    status = Column(Enum(ProjectStatus, values_callable=lambda x: [e.value for e in x]), default=ProjectStatus.ACTIVE, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)
    category_level_names = Column(JSON, nullable=True)
    # Stable cross-instance identity (Track J · J1 reserve; enables the J3 round-trip/merge)
    project_uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid.uuid4()))
    # Track J · J3-1: "Freeze Codebook" soft-lock. NULL = unfrozen; a timestamp = frozen-at
    # (the "when" the audit log anchors to). Soft discipline only — the backend records it
    # and it travels in .mmproject export; the warn-on-mutate is a frontend affordance.
    codebook_frozen_at = Column(DateTime, nullable=True)

    # Relationships
    # NOTE: CASCADE means deleting a user deletes their projects. For cloud/multi-tenant
    # deployment, consider changing to SET NULL to preserve data when deactivating users.
    user = relationship("User", back_populates="projects")
    documents = relationship("Document", back_populates="project", cascade="all, delete-orphan")
    conversations = relationship("Conversation", back_populates="project", cascade="all, delete-orphan")
    codes = relationship("Code", back_populates="project", cascade="all, delete-orphan")
    categories = relationship("CodeCategory", back_populates="project", cascade="all, delete-orphan")
    memos = relationship("Memo", back_populates="project", cascade="all, delete-orphan")
    speakers = relationship("Speaker", back_populates="project", cascade="all, delete-orphan")
    participants = relationship("Participant", back_populates="project", cascade="all, delete-orphan")
    datasets = relationship("Dataset", back_populates="project", cascade="all, delete-orphan")
    equivalence_groups = relationship("EquivalenceGroup", back_populates="project", cascade="all, delete-orphan")
    code_equivalence_groups = relationship("CodeEquivalenceGroup", back_populates="project", cascade="all, delete-orphan")
    analysis_domains = relationship("AnalysisDomain", back_populates="project", cascade="all, delete-orphan")
    metric_definitions = relationship("MetricDefinition", back_populates="project", cascade="all, delete-orphan")
    material_collections = relationship("MaterialCollection", back_populates="project", cascade="all, delete-orphan")
    statistical_tests = relationship("StatisticalTest", back_populates="project", cascade="all, delete-orphan")
    text_coding_config = relationship("TextCodingConfig", back_populates="project",
                                       uselist=False, cascade="all, delete-orphan")
    excerpts = relationship("Excerpt", back_populates="project", cascade="all, delete-orphan")
    scratchpad_entries = relationship("ScratchpadEntry", back_populates="project", cascade="all, delete-orphan")
    quote_board_config = relationship("QuoteBoardConfig", back_populates="project",
                                       uselist=False, cascade="all, delete-orphan")
    canvases = relationship("Canvas", back_populates="project", cascade="all, delete-orphan")
