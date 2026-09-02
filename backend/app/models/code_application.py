from sqlalchemy import Column, Integer, String, Text, DateTime, Float, ForeignKey, Index, CheckConstraint, text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class CodeApplication(Base):
    """Join table tracking which codes are applied to segments or comment responses.

    Invariant: Exactly one of segment_id, dataset_value_id must be NOT NULL.
    Enforced by CHECK constraint ck_code_application_exactly_one_target.
    """
    __tablename__ = "code_applications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    segment_id = Column(Integer, ForeignKey("segments.id", ondelete="CASCADE"), nullable=True, index=True)
    dataset_value_id = Column(Integer, ForeignKey("dataset_values.id", ondelete="CASCADE"), nullable=True, index=True)
    code_id = Column(Integer, ForeignKey("codes.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attribution = Column(String(255), nullable=True)
    # Provenance reserve (Track J · J1): hand-applied vs consensus-derived vs ai-suggested
    origin = Column(String(20), nullable=False, default="human", server_default="human")
    origin_context = Column(Text, nullable=True)  # D15 consultation / provenance home
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # ── Magnitude coding (#35) ────────────────────────────────────────────────
    # This coder's RATING of this code on this target, on the scale declared by
    # `Code.magnitude_{min,max,step,labels}`. Rides the per-`(target, code, coder)`
    # grain the unique indexes below already enforce, which is why the feature
    # needs no new table: "how much" is a property of one coder's application.
    #
    # 🔴 NULLABLE, AND NULL MEANS *UNRATED* — NEVER ZERO. MAXQDA default-stamps a
    # weight of 0 onto every coded segment, which makes "not rated" and "rated
    # zero" indistinguishable; on a −1…+1 scale zero is a real neutral, so that
    # conflation destroys data. Never give this column a default, never write 0 to
    # mean "skipped", and never test it with a bare falsy check — a real measured
    # zero must survive (the #689 / falsy-zero class).
    #
    # ⚠️ Values are validated against the code's scale in
    # `services/magnitude.py::validate_value`, in the SERVICE — the import and
    # portability paths reach this column without passing any router (#589).
    magnitude = Column(Float, nullable=True)

    # ── Merge disagreement flag (#35, decided 2026-09-01) ────────────────────
    # When a MERGE matches this application (same target, code and coder) in a
    # colleague's copy and the copy carries a DIFFERENT rating, the target's
    # `magnitude` is KEPT and the incoming value lands HERE, so reconciliation
    # can surface "your other copy rated this 5" and the coder can adjudicate.
    # NULL = no unresolved conflict. Cleared the moment the coder re-rates (or
    # unrates) the application — that act IS the adjudication.
    #
    # ⚠️ The OTHER number, not a bit: a flag alone would tell the coder there
    # was a disagreement and nothing about what it was, which is the piece of
    # information the merge is the last place to have seen.
    # ⚠️ No coder identity leaks through it: a match is on (target, code,
    # CODER), so the value is the same coder's own other copy.
    magnitude_conflict = Column(Float, nullable=True)

    # Relationships
    segment = relationship("Segment", back_populates="code_applications")
    dataset_value = relationship("DatasetValue", back_populates="code_applications")
    code = relationship("Code", back_populates="applications")

    __table_args__ = (
        CheckConstraint(
            '(segment_id IS NOT NULL AND dataset_value_id IS NULL) OR '
            '(segment_id IS NULL AND dataset_value_id IS NOT NULL)',
            name='ck_code_application_exactly_one_target'
        ),
        # Per-coder uniqueness (Track J · J2-A): one application per
        # (target, code, CODER). Widened from (target, code) so each coder has an
        # independent layer over the same material. NULL user_id (legacy, pre-J1)
        # rows are distinct in SQLite unique indexes; D7 backfill (NULL → an
        # "Unattributed" coder) is deferred to the layer-aware-counts slab (J2-2).
        Index("ix_code_applications_seg_code_user_unique", "segment_id", "code_id", "user_id",
              unique=True, sqlite_where=text("segment_id IS NOT NULL")),
        Index("ix_code_applications_value_code_user_unique", "dataset_value_id", "code_id", "user_id",
              unique=True, sqlite_where=text("dataset_value_id IS NOT NULL")),
        # Partial index over the consensus layer (Track J · J2-5). `origin` leads
        # every consensus query but was unindexed; consensus is a minority of rows
        # so a partial index is cheap. Non-unique (many rows share 'consensus').
        Index("ix_code_applications_consensus", "origin",
              sqlite_where=text("origin='consensus'")),
    )
