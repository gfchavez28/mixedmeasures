from sqlalchemy import Boolean, Column, Float, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from uuid import uuid4
from ..database import Base


class Observation(Base):
    """A recording coded on its OWN timeline, with no transcript — the third
    ``Segment`` parent (Conversation | Document | Observation), added for the
    Observations track. A media file IS the material here: coders mark time
    ranges ("clips") directly on the timeline and code those, rather than coding
    a transcript. The whole coding spine (CodeApplication, Excerpt, Note, Memo,
    Track J) is Segment-keyed, so it inherits observation segments for free.

    "recording" = the attached media file; "Observation" = this source type.
    """
    __tablename__ = "observations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    # Track J · J3-2-0 spine: stable cross-instance identity for merge matching.
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # D18 — the unit-provenance discriminant, and the whole reliability posture
    # of an Observation turns on it. NULL = OPEN (each coder marks their own
    # clips); a timestamp = FROZEN (the team agreed the clips before coding).
    # Mirrors Project.codebook_frozen_at (Track J · J3-1), deliberately: this is
    # the same soft-lock idea applied to cuts instead of codes.
    #
    #   FROZEN -> every coder codes the SAME clips, so agreement is just "did we
    #             apply the same codes?" => consensus, reconciliation and ordinary
    #             kappa work via the engines that already ship. NO observational
    #             tool on the market has this workflow.
    #   OPEN   -> each coder's clips are their own, so a clip has one voter and
    #             consensus is meaningless; the reliability question is about the
    #             BOUNDARIES => unitizing-alpha (+ time-binned / event-matched
    #             kappa for parity with BORIS/NVivo/Observer XT).
    #
    # Read LIVE by services/coding_layers.py::consensus_eligible_segment_clause —
    # never denormalized onto Segment, so freezing can't strand clips on a stale
    # flag.
    segmentation_frozen_at = Column(DateTime, nullable=True)

    # Media block — mirrors Conversation's 6 columns EXACTLY so routers/media.py
    # can own an Observation's recording without format-branching. `media_type`
    # derives from VIDEO_FORMATS at the router seam (audio OR video, same as a
    # conversation). `media_offset_seconds` is definitionally 0 for an
    # Observation (the media IS the timeline — a nonzero offset would shear
    # coverage against duration); it exists only so the shared media endpoints
    # write/clear all six columns uniformly, and the PATCH /offset endpoint is
    # deliberately NOT mounted for observations.
    media_filename = Column(String(500), nullable=True)
    media_format = Column(String(10), nullable=True)  # "mp3"/"wav"/… audio; VIDEO_FORMATS video
    media_type = Column(String(10), nullable=True)     # "audio" | "video"
    media_duration_seconds = Column(Float, nullable=True)
    media_offset_seconds = Column(Float, nullable=False, default=0.0)
    media_is_vbr = Column(Boolean, nullable=True)

    # Relationships
    project = relationship("Project", back_populates="observations")
    segments = relationship(
        "Segment", back_populates="observation",
        cascade="all, delete-orphan", order_by="Segment.sequence_order",
    )
    notes = relationship("Note", back_populates="observation", cascade="all, delete-orphan")
