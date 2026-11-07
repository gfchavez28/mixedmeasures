"""Shared helper functions for router modules."""

from fastapi import HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.project import Project
from ..models.user import User
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.observation import Observation
from ..models.dataset import Dataset, DatasetColumn, TEXT_CODEABLE_TYPES

# 50 MB file upload limit
MAX_UPLOAD_SIZE = 50 * 1024 * 1024

# The columns Text Coding offers — `models/dataset.py::TEXT_CODEABLE_TYPES`, as the
# list these routers pass to `.in_()`. One definition, so the coding import (a
# service) and the text-coding routers cannot disagree about what is codeable.
TEXT_TYPES = sorted(TEXT_CODEABLE_TYPES, key=lambda t: t.value)


def visible_segment_filter(*, from_parent: bool = False):
    """Return filter conditions for visible (non-soft-deleted) segments.

    A segment is hidden when it has been merged into another OR split into parts.

    ``from_parent=True`` (#1463, D62) returns the SAME rule written so SQLite cannot
    use an index for it — one ``coalesce(merged_into_id, split_into_id) IS NULL``,
    which is NULL exactly when both are. Pass it from a query that also scopes the
    segment's PARENT (a project's documents or observations). SQLite has no statistics
    here and prices ``split_into_id IS NULL`` as selective, so with the default form it
    starts from ``ix_segments_split_into_id`` — every visible segment on the INSTALL —
    and probes each for the parent: 1.45 s per count on 1.2M turns, encrypted, for a
    project with no documents at all. Written this way the parent's index is the only
    way in, and the same count takes about 1 ms (EXPLAIN QUERY PLAN, measured).
    ⚠️ The default stays as it is: its ~59 callers' plans were not swept, and flipping
    the seam would move every one of them.
    """
    if from_parent:
        return (func.coalesce(Segment.merged_into_id, Segment.split_into_id).is_(None),)
    return (Segment.merged_into_id == None, Segment.split_into_id == None)


async def read_upload_with_limit(file: UploadFile, max_size: int = MAX_UPLOAD_SIZE) -> bytes:
    """Read an uploaded file with a size limit to prevent memory exhaustion."""
    content = await file.read(max_size + 1)
    if len(content) > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {max_size // (1024 * 1024)} MB.",
        )
    return content


def apply_project_owner_filter(query, user_id: int):
    """Apply the multi-tenant ownership predicate to a Project-selecting query.

    THE single place the ``Project.user_id`` filter is expressed (#553). Every
    ownership decision — ``_get_project_or_404`` below, and the uuid-keyed
    project lookups in ``project_portability`` that can't go through it —
    routes here, so the gate's semantics can never diverge across call sites.
    A no-op in local-roster mode (``MM_MULTIUSER_AUTH_ENABLED`` off, default).
    """
    from ..config import get_settings
    if get_settings().mm_multiuser_auth_enabled:
        query = query.filter(Project.user_id == user_id)
    return query


def _get_project_or_404(db: Session, project_id: int, user_id: int) -> Project:
    """Load project by ID, enforcing ownership only in multi-tenant (cloud) mode.

    Local-roster mode (``MM_MULTIUSER_AUTH_ENABLED`` off, the default) shares all
    projects across the coder roster — ``user_id`` is ``created_by`` metadata, not
    an access gate (Track J · J1). Cloud/multi-tenant mode (flag on) keeps per-user
    isolation. All project access MUST still go through this helper.
    """
    query = apply_project_owner_filter(
        db.query(Project).filter(Project.id == project_id), user_id
    )
    project = query.first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _get_observation_or_404(
    db: Session, project_id: int, observation_id: int, user_id: int
) -> Observation:
    """Load an observation, folding the ownership gate in (REQUIRED user_id —
    do not add a user-less overload; the signature is what stops a new endpoint
    from forgetting, #553).

    Lives here rather than in observations.py so the media router can gate an
    observation too (the recording-reuse endpoints cross both source types, and
    observations.py already imports FROM media.py — the other direction would be
    a cycle). The name is what tests/test_ownership_gate_sweep.py's AST scan
    matches, so moving the definition does not weaken the guard.
    """
    _get_project_or_404(db, project_id, user_id)
    observation = db.query(Observation).filter(
        Observation.id == observation_id,
        Observation.project_id == project_id,
    ).first()
    if not observation:
        raise HTTPException(status_code=404, detail="Observation not found")
    return observation


def _verify_conversation_ownership(db: Session, conversation_id: int, user_id: int) -> Conversation:
    """Load conversation and verify its project belongs to user."""
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    _get_project_or_404(db, conversation.project_id, user_id)
    return conversation


def _verify_segment_ownership(db: Session, segment_id: int, user_id: int) -> Segment:
    """Load segment and verify its parent project belongs to user.

    FAILS CLOSED: a segment whose parent this function does not recognise is
    REFUSED, never returned. Every ``Segment`` parent must have a branch here —
    the old two-branch form fell through to an unconditional ``return segment``,
    so a third-parent segment was handed back with no ownership check at all.
    """
    segment = db.query(Segment).filter(Segment.id == segment_id).first()
    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")
    if segment.conversation_id:
        conv = db.query(Conversation).filter(Conversation.id == segment.conversation_id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
        _get_project_or_404(db, conv.project_id, user_id)
    elif segment.document_id:
        doc = db.query(Document).filter(Document.id == segment.document_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        _get_project_or_404(db, doc.project_id, user_id)
    elif segment.observation_id:
        obs = db.query(Observation).filter(Observation.id == segment.observation_id).first()
        if not obs:
            raise HTTPException(status_code=404, detail="Observation not found")
        _get_project_or_404(db, obs.project_id, user_id)
    else:
        # Unreachable while ck_segment_exactly_one_parent holds. If it is ever
        # reached, a parent was added without a branch above — refuse rather than
        # hand back an unowned row.
        raise HTTPException(status_code=404, detail="Segment has no valid parent")
    return segment


def parse_int_list(value: str | None) -> list[int] | None:
    """Parse comma-separated int string into list, or None."""
    if not value:
        return None
    try:
        return [int(x.strip()) for x in value.split(",") if x.strip()]
    except ValueError:
        return None


def parse_source_ids(raw: str | None) -> list[int] | None:
    """A SOURCE-list query param that keeps "absent" apart from "present and empty".

    ``None`` (the param was not sent) is every source of that kind; ``""`` (sent
    empty) is NONE of that kind. `parse_int_list` folds ``""`` into ``None``, which
    turned a selection of one kind back into every source of the others — a
    text-only selection counted every conversation (#1297), one interview selected
    counted every document and clip in the co-occurrence (#1527 D84). The client
    side of the rule is `lib/qual-comparison.ts::comparisonSourceParams`.
    """
    return None if raw is None else (parse_int_list(raw) or [])


def _parse_ids(raw: str | None) -> list[int]:
    """Parse comma-separated IDs from query param."""
    if not raw:
        return []
    return [int(x) for x in raw.split(",") if x.strip().isdigit()]


import re
import unicodedata

def sanitize_csv_filename(name: str, fallback: str = "project") -> str:
    """Sanitize a user-supplied string for use in a Content-Disposition filename.

    Must return ASCII: header values are encoded latin-1 at the ASGI layer, so
    any non-latin-1 character (CJK, Cyrillic, Greek...) raises UnicodeEncodeError
    at response time and 500s the export. Accented Latin folds to its base letter
    (NFKD); anything else non-ASCII is dropped before the word-character filter.
    A name with nothing left becomes ``fallback``.
    """
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    safe = re.sub(r'[^\w\-.]', '_', folded, flags=re.ASCII)[:80]
    return safe if safe.strip('_.') else fallback


def sanitize_content_disposition(name: str, fallback: str = "project") -> str:
    """Sanitize a string for safe use in Content-Disposition headers.

    Strips control characters (\\r, \\n, \\0) that could enable header injection,
    then applies the standard filename sanitization.
    """
    cleaned = name.replace('\r', '').replace('\n', '').replace('\0', '')
    return sanitize_csv_filename(cleaned, fallback)


def coder_scope_names(db: Session, coder_ids: list[int]) -> list[str]:
    """The coders a scoped file holds, by name, in the order asked. A coder
    with no row (a stale id) reads as its number rather than vanishing."""
    names = dict(db.query(User.id, User.username).filter(User.id.in_(coder_ids)).all())
    return [names.get(cid) or str(cid) for cid in coder_ids]


def coder_scope_filename_suffix(db: Session, coder_ids: list[int] | None) -> str:
    """#1530 D97 (1.5.9) — a server file asked for some coders' coding only ends
    ``_coder-<name>`` (before its extension), so the file says whose coding it
    holds wherever it travels; ``""`` when no scope was asked (every coder — the
    file's name exactly as before).

    Each name goes through `sanitize_content_disposition` (ASCII, #792); one with
    nothing left after it (a wholly non-Latin name) is the coder's id instead,
    never the sanitiser's ``project`` fallback, which would name the wrong thing.
    """
    if not coder_ids:
        return ""
    parts = [
        sanitize_content_disposition(name, fallback=str(cid))
        for cid, name in zip(coder_ids, coder_scope_names(db, coder_ids))
    ]
    return "_coder-" + "-".join(parts)


def _fmt_p(p: float | None) -> str:
    """Format p-value: <.001 or leading-zero stripped 3-decimal.

    ``None`` renders as an empty cell rather than raising — see ``_fmt_stat``.
    """
    if p is None:
        return ""
    if p < 0.001:
        return "<.001"
    s = f"{p:.3f}"
    if s.startswith("0."):
        return s[1:]
    return s


def _fmt_stat(value: float | None, digits: int = 2) -> str:
    """Format a numeric export cell; a value that is not computable is BLANK.

    Export writers reach for a bare ``f"{v:.2f}"``, which turns a null statistic
    into a ``TypeError`` at download time — a 500 on the response, not an empty
    cell, and only for the researcher whose data happened to hit the degenerate
    case. The response schemas are moving toward nullable statistics (#689
    replaces eight ``0.0``-for-undefined returns with ``None``, precisely because
    a numeric zero reads as "no effect"), so the formatter has to answer for
    ``None`` before the services start producing it.

    Blank is the right rendering: a spreadsheet shows an empty cell, and no
    reader mistakes it for a measurement.
    """
    if value is None:
        return ""
    return f"{value:.{digits}f}"


ALLOWED_ENCODINGS = {"utf-8", "utf-8-sig", "latin-1", "iso-8859-1", "cp1252", "ascii"}


def validate_encoding(encoding: str) -> None:
    if encoding.lower().strip() not in ALLOWED_ENCODINGS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported encoding '{encoding}'. Allowed: {', '.join(sorted(ALLOWED_ENCODINGS))}",
        )


def _validate_column_in_project(db: Session, column_id: int, project_id: int) -> None:
    exists = (
        db.query(DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id == column_id, Dataset.project_id == project_id)
        .first()
    )
    if not exists:
        raise HTTPException(status_code=404, detail=f"Column {column_id} not found in project")


def _get_dataset_or_404(
    db: Session, project_id: int, dataset_id: int, user_id: int,
) -> Dataset:
    """Load a dataset, gating on project ownership first (#553).

    ``user_id`` is REQUIRED, not optional: this helper is the only thing ~27
    dataset endpoints call, and every one of them used to reach the rows
    without the per-user gate ever firing under ``MM_MULTIUSER_AUTH_ENABLED``.
    Folding the gate in (rather than adding it at each call site) means a NEW
    dataset endpoint cannot forget it — the signature won't let it.
    """
    _get_project_or_404(db, project_id, user_id)
    dataset = (
        db.query(Dataset)
        .filter(
            Dataset.id == dataset_id,
            Dataset.project_id == project_id,
        )
        .first()
    )
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset
