"""Single source of truth for the "coded segment" derived count (invariant J-A).

The quantity "coded (participant) segments" is shown on many surfaces — the
CodingWorkbench gauge, the conversations/documents list cards, the project
overview, and the recent-* cards. Historically each surface re-expressed the
same three-dimension predicate by hand, kept aligned only by comments
(#211 → #218 → #351 → #352). The document surfaces silently omitted the
universal-code exclusion (#398): a document segment coded ONLY with a universal
marker ("Unclear" / "Unsubstantive/Artifact") counted as coded, while the
conversation equivalent did not — the same segment read differently on two
screens.

A "coded participant segment" is defined by THREE filter dimensions, owned here:

  1. Visibility   — not merged/split (soft-deleted). `visible_segment_filter()`.
  2. Participant  — facilitator turns excluded; speaker-less segments
                    (documents, untagged conversation turns) ARE participants.
                    This is a no-op for documents (they have no speaker), so the
                    document call sites pass ``participant_only=False`` to skip
                    the needless Speaker outerjoin.
  3. Substantive  — at least one NON-universal code applied
                    (``Code.is_universal == False``). Universal codes are the
                    reserved (uncoded)/(double-coded)/Unclear/Unsubstantive
                    markers; applying only those does not make a segment "coded".

ALL count surfaces MUST route through this module. ``test_coding_counts.py``
asserts the helpers agree across surfaces and that the document path now applies
the substantive dimension (the #398 regression guard).

Note: ``CodeApplication`` is polymorphic (``segment_id`` XOR ``dataset_value_id``).
The inner join ``CodeApplication.segment_id == Segment.id`` naturally excludes
dataset-value applications, so no explicit ``segment_id IS NOT NULL`` is needed.
"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Query, Session
from sqlalchemy.sql.schema import Column

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.segment import Segment
from ..models.speaker import Speaker
from ..routers.helpers import visible_segment_filter


def _participant_predicate():
    """Facilitator turns excluded; speaker-less segments count as participants."""
    return (Speaker.is_facilitator == 0) | (Segment.speaker_id == None)  # noqa: E711


def _apply_participant_join(query: Query, *, participant_only: bool) -> Query:
    if participant_only:
        query = query.outerjoin(Speaker, Speaker.id == Segment.speaker_id).filter(
            _participant_predicate()
        )
    return query


# --------------------------------------------------------------------------- #
# Coded-segment counts (visibility + [participant] + substantive)
# --------------------------------------------------------------------------- #

def coded_segment_counts(
    db: Session,
    parent_col: Column,
    parent_ids: Iterable[int],
    *,
    participant_only: bool = True,
) -> dict[int, int]:
    """Map ``{parent_id: coded-segment count}`` grouped by ``parent_col``.

    ``parent_col`` is ``Segment.conversation_id`` or ``Segment.document_id``.
    Parents with zero coded segments are omitted from the dict (callers use
    ``.get(id, 0)``). Pass ``participant_only=False`` for document sources.
    """
    ids = list(parent_ids)
    if not ids:
        return {}
    query = (
        db.query(parent_col, func.count(func.distinct(CodeApplication.segment_id)))
        .select_from(Segment)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .filter(
            parent_col.in_(ids),
            *visible_segment_filter(),
            Code.is_universal == False,  # noqa: E712
        )
    )
    query = _apply_participant_join(query, participant_only=participant_only)
    return dict(query.group_by(parent_col).all())


def coded_segment_count(
    db: Session,
    parent_col: Column,
    parent_id: int,
    *,
    participant_only: bool = True,
) -> int:
    """Scalar coded-segment count for a single conversation/document."""
    return coded_segment_counts(
        db, parent_col, [parent_id], participant_only=participant_only
    ).get(parent_id, 0)


def coded_segment_count_for_project(
    db: Session,
    project_id: int,
    *,
    source: str,
) -> int:
    """Project-wide coded participant-segment count for one source type.

    ``source`` is ``"conversation"`` or ``"document"``. Joins through the parent
    table (so it does not materialize a parent-id list) — used by the overview
    totals. Documents skip the participant dimension (no speakers).
    """
    query = (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .select_from(Segment)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Code, Code.id == CodeApplication.code_id)
    )
    if source == "conversation":
        query = query.join(
            Conversation, Segment.conversation_id == Conversation.id
        ).filter(
            Conversation.project_id == project_id,
            *visible_segment_filter(),
            Code.is_universal == False,  # noqa: E712
        )
        query = _apply_participant_join(query, participant_only=True)
    elif source == "document":
        query = query.join(Document, Segment.document_id == Document.id).filter(
            Document.project_id == project_id,
            *visible_segment_filter(),
            Code.is_universal == False,  # noqa: E712
        )
    else:
        raise ValueError(f"source must be 'conversation' or 'document', got {source!r}")
    return query.scalar() or 0


# --------------------------------------------------------------------------- #
# Participant segment-count denominators (visibility + participant)
# --------------------------------------------------------------------------- #

def participant_segment_counts(
    db: Session,
    parent_col: Column,
    parent_ids: Iterable[int],
) -> dict[int, int]:
    """Map ``{parent_id: visible participant-segment count}`` (the gauge denominator)."""
    ids = list(parent_ids)
    if not ids:
        return {}
    query = (
        db.query(parent_col, func.count(Segment.id))
        .outerjoin(Speaker, Speaker.id == Segment.speaker_id)
        .filter(
            parent_col.in_(ids),
            *visible_segment_filter(),
            _participant_predicate(),
        )
    )
    return dict(query.group_by(parent_col).all())


def participant_segment_count(db: Session, parent_col: Column, parent_id: int) -> int:
    """Scalar visible participant-segment count for a single conversation/document."""
    return participant_segment_counts(db, parent_col, [parent_id]).get(parent_id, 0)
