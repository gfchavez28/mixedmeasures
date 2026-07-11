"""Shared helper functions for router modules."""

from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..models.project import Project
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.dataset import Dataset, DatasetColumn, ColumnType

# 50 MB file upload limit
MAX_UPLOAD_SIZE = 50 * 1024 * 1024

TEXT_TYPES = [ColumnType.OPEN_TEXT]


def visible_segment_filter():
    """Return filter conditions for visible (non-soft-deleted) segments.

    A segment is hidden when it has been merged into another OR split into parts.
    """
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


def _verify_conversation_ownership(db: Session, conversation_id: int, user_id: int) -> Conversation:
    """Load conversation and verify its project belongs to user."""
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    _get_project_or_404(db, conversation.project_id, user_id)
    return conversation


def _verify_segment_ownership(db: Session, segment_id: int, user_id: int) -> Segment:
    """Load segment and verify its parent project belongs to user."""
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
    return segment


def parse_int_list(value: str | None) -> list[int] | None:
    """Parse comma-separated int string into list, or None."""
    if not value:
        return None
    try:
        return [int(x.strip()) for x in value.split(",") if x.strip()]
    except ValueError:
        return None


def _parse_ids(raw: str | None) -> list[int]:
    """Parse comma-separated IDs from query param."""
    if not raw:
        return []
    return [int(x) for x in raw.split(",") if x.strip().isdigit()]


import re
import unicodedata

def sanitize_csv_filename(name: str) -> str:
    """Sanitize a user-supplied string for use in a Content-Disposition filename.

    Must return ASCII: header values are encoded latin-1 at the ASGI layer, so
    any non-latin-1 character (CJK, Cyrillic, Greek...) raises UnicodeEncodeError
    at response time and 500s the export. Accented Latin folds to its base letter
    (NFKD); anything else non-ASCII is dropped before the word-character filter.
    """
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    safe = re.sub(r'[^\w\-.]', '_', folded, flags=re.ASCII)[:80]
    return safe if safe.strip('_.') else "project"


def sanitize_content_disposition(name: str) -> str:
    """Sanitize a string for safe use in Content-Disposition headers.

    Strips control characters (\\r, \\n, \\0) that could enable header injection,
    then applies the standard filename sanitization.
    """
    cleaned = name.replace('\r', '').replace('\n', '').replace('\0', '')
    return sanitize_csv_filename(cleaned)


def _fmt_p(p: float) -> str:
    """Format p-value: <.001 or leading-zero stripped 3-decimal."""
    if p < 0.001:
        return "<.001"
    s = f"{p:.3f}"
    if s.startswith("0."):
        return s[1:]
    return s


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
