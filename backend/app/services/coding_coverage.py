"""Per-source / per-project coder coverage (Track J · Group A — #1/#3/#13).

"Who actually coded here?" — the distinct REAL coders who applied ≥1 non-universal,
non-consensus code to a source (conversation / document / dataset column) or anywhere
in a project. Derived from CODINGS, never the roster: ``GET /auth/coders`` is
instance-global (every non-archived coder on the install, not who touched THIS
project), so deriving project/source membership from it is the #444 trap.

Coverage uses the same "real coding by a real coder" population as IRR / consensus
voters — non-universal code, non-consensus origin, real (non-null) user, non-system
``coder_type`` — with ONE deliberate difference: it INCLUDES archived coders
(flagged), because a departed colleague's past coding is part of "who coded this."
(Consensus voting EXCLUDES archived per DEC-F; coverage is an awareness/display
surface, not a vote.) System coders (the consensus user + the merged-legacy
"Unattributed" bucket) and legacy null-applier rows never count as a coder.

**Scope note.** Per-SOURCE coverage applies ``visible_segment_filter()`` so the
picklist mirrors the workbench's visible segments. The per-PROJECT count/list scope
by ``Code.project_id`` — every ``CodeApplication`` references a project-scoped
``Code``, so one group-by covers conversations, documents, AND dataset values
uniformly — and do NOT apply the visible filter (a coder who only coded a
since-merged segment still "participated"). The two can differ only by such
hidden-only coders (negligible), a deliberate definitional choice.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..auth import SYSTEM_CODER_TYPES
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.dataset import DatasetValue
from ..models.segment import Segment
from ..models.user import User
from ..routers.helpers import visible_segment_filter
from .coding_layers import non_consensus_filter


@dataclass(frozen=True)
class CoderCoverage:
    """A coder with ≥1 real coding in scope (one per distinct user)."""

    user_id: int
    username: str
    display_color: str | None
    archived: bool


def _real_coding_filters():
    """Clauses defining "a real coder's real coding" (shared by every coverage query).

    Requires a ``User`` join (``coder_type``) and a ``Code`` join (``is_universal``).
    Mirrors the IRR/consensus voter population EXCEPT it does not exclude archived
    coders — coverage shows who coded, including departed colleagues.
    """
    return [
        Code.is_universal == False,  # noqa: E712
        non_consensus_filter(),
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
    ]


def _rows_to_coverage(rows) -> list[CoderCoverage]:
    return [
        CoderCoverage(user_id=r[0], username=r[1], display_color=r[2], archived=bool(r[3]))
        for r in rows
    ]


def source_coder_coverage(
    db: Session,
    project_id: int,
    *,
    conversation_id: int | None = None,
    document_id: int | None = None,
    text_column_ids: list[int] | None = None,
) -> list[CoderCoverage]:
    """Distinct coders with ≥1 real coding on ONE source (conversation | document |
    text columns). Active coders first, then archived; each alphabetical. Returns []
    when no source selector is given.
    """
    q = (
        db.query(User.id, User.username, User.display_color, User.archived)
        .join(CodeApplication, CodeApplication.user_id == User.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(Code.project_id == project_id, *_real_coding_filters())
    )
    if conversation_id is not None or document_id is not None:
        q = q.join(Segment, CodeApplication.segment_id == Segment.id).filter(*visible_segment_filter())
        q = q.filter(
            Segment.conversation_id == conversation_id
            if conversation_id is not None
            else Segment.document_id == document_id
        )
    elif text_column_ids:
        q = q.join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id).filter(
            DatasetValue.column_id.in_(text_column_ids)
        )
    else:
        return []
    rows = q.distinct().order_by(User.archived, User.username).all()
    return _rows_to_coverage(rows)


def project_coder_coverage(db: Session, project_id: int) -> list[CoderCoverage]:
    """Distinct coders with ≥1 real coding ANYWHERE in the project (active first)."""
    rows = (
        db.query(User.id, User.username, User.display_color, User.archived)
        .join(CodeApplication, CodeApplication.user_id == User.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(Code.project_id == project_id, *_real_coding_filters())
        .distinct()
        .order_by(User.archived, User.username)
        .all()
    )
    return _rows_to_coverage(rows)


def project_coder_counts(db: Session, project_ids: list[int]) -> dict[int, int]:
    """Batch: distinct real-coder count per project (the Dashboard card badge, #1).

    Grouped by ``Code.project_id`` — one query across every project, covering
    conversations, documents, and dataset values uniformly.
    """
    if not project_ids:
        return {}
    rows = (
        db.query(Code.project_id, func.count(func.distinct(CodeApplication.user_id)))
        .join(CodeApplication, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(Code.project_id.in_(project_ids), *_real_coding_filters())
        .group_by(Code.project_id)
        .all()
    )
    return {pid: count for pid, count in rows}
