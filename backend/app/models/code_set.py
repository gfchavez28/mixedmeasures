"""CodeSet — a mutually exclusive group of codes read as ONE variable (queue row 48).

Content analysis codes VARIABLES: a *stance* variable with four values is one
nominal judgement per unit, not four independent yes/no judgements. MM's native
grain is the grounded-theory one — per code, independently, presence/absence — so
a four-valued variable reports four binary α figures plus a pooled number that
appears in no content-analysis textbook. A code set is the data model that makes
the single α askable, and the interface that enforces one-and-only-one.

🔴 **THIS IS THE OPPOSITE OF `CodeEquivalenceGroup`, WHICH IT OTHERWISE MIRRORS.**

    |               | CodeEquivalenceGroup        | CodeSet                       |
    |---------------|-----------------------------|-------------------------------|
    | Members       | synonyms — one meaning      | alternatives — many meanings  |
    | Resolution    | collapse to ONE effective   | keep distinct, pick ONE/unit  |
    | Effect on α   | two labels now AGREE        | a k-valued variable gets ONE α|
    | Per unit      | any number may apply        | exactly one member, or none   |

Reusing that table with a `kind` discriminator was rejected: two opposite
resolution rules in one table is `models/memo.py`'s #780 shape. A flag on
`CodeCategory` was rejected too — a filing structure and a measurement instrument
are different objects and will not stay aligned (#806's overloading shape).

**They COMPOSE, and the order is fixed.** A member may itself sit in an
equivalence group ("Neg" ≡ "Negative"). The effective-code resolver runs FIRST;
set membership is then read on the EFFECTIVE code. `services/code_sets.py` is the
only place that rule is implemented, and it carries the refusal that stops a code
joining a set through a door where the composition would silently drop it.

`exhaustive` is NOT cosmetic — it changes the DENOMINATOR. See
`services/code_sets.py` and the internal design notes.
"""
from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from ..database import Base


class CodeSet(Base):
    """A named group of codes of which a unit takes at most one."""

    __tablename__ = "code_sets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The Track J uuid spine: a re-export → re-merge of an already-reconciled
    # project must match its sets across copies rather than duplicating them.
    # Fresh-stamped on import-as-new, preserved on merge/overwrite — handled by
    # `_build_entity(fresh_uuid=...)`.
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    label = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)

    # 🔴 EXHAUSTIVE CHANGES THE DENOMINATOR, AND THE DEFAULT IS `False`.
    #
    #   False → a unit with no member chosen took a real value, "none of these".
    #           It enters the α matrix under a reserved sentinel.
    #   True  → a unit with no member chosen is MISSING DATA. It is `None` in the
    #           matrix and the coverage gauge owes it.
    #
    # `False` is the default deliberately: a half-built codebook is the common
    # state, and defaulting to `True` would silently reclassify every not-yet-coded
    # unit as missing — turning a partially-coded round into a statistic over
    # whatever fraction somebody happened to reach.
    exhaustive = Column(Boolean, default=False, nullable=False, server_default="0")

    sequence_order = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    project = relationship("Project", back_populates="code_sets")
    # passive_deletes=True: trust the DB-level `ON DELETE SET NULL` on
    # Code.code_set_id and do NOT let the unit of work issue pre-delete UPDATEs
    # that nullify codes already moved elsewhere — the `merge_groups` foot-gun
    # (the internal design notes foot-gun #1), inherited from CodeEquivalenceGroup because
    # this table has the same delete-with-live-members shape.
    codes = relationship("Code", back_populates="code_set", passive_deletes=True)
