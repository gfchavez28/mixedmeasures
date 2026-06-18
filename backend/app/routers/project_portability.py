"""Project portability API — export/import projects and codebooks."""

import json
import logging
import os
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import get_documents_dir, get_media_dir
from ..database import get_db
from ..models.audit import AuditEntry
from ..models.user import User
from ..schemas.project_portability import (
    CodebookImportResult,
    ImportValidationResult,
    ProjectImportResult,
)
from ..services.codebook_exchange import (
    export_codebook_native,
    export_codebook_qdc,
    import_codebook_native,
    import_codebook_qdc,
)
from ..services.project_portability import (
    MAX_UPLOAD_SIZE,
    export_project,
    import_project,
    validate_project_file,
)
from .helpers import _get_project_or_404, read_upload_with_limit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/projects", tags=["project-portability"])


def _get_data_dirs() -> tuple[Path, Path]:
    """Return (docs_dir, media_dir)."""
    return get_documents_dir(), get_media_dir()


def _slugify(name: str) -> str:
    """Sanitize a project name for use in filenames."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return slug[:60] or "project"


async def _stream_upload_to_temp(
    file: UploadFile, suffix: str = ".mmproject",
) -> Path:
    """Stream uploaded file to a temp file with size limit.

    Returns the temp file path. Caller is responsible for cleanup.
    """
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        total = 0
        with os.fdopen(tmp_fd, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        413,
                        f"File too large (max {MAX_UPLOAD_SIZE // (1024 * 1024)}MB)",
                    )
                f.write(chunk)
        return Path(tmp_path)
    except HTTPException:
        os.unlink(tmp_path)
        raise
    except Exception:
        os.unlink(tmp_path)
        raise


# ── Project export ──────────────────────────────────────────────────────

@router.get("/{project_id}/export-project")
async def export_project_endpoint(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Export a project as a .mmproject ZIP file."""
    project = _get_project_or_404(db, project_id, user.id)
    docs_dir, media_dir = _get_data_dirs()
    try:
        buf = export_project(db, project_id, docs_dir, media_dir)
    except ValueError as e:
        raise HTTPException(404, str(e))
    slug = _slugify(project.name)
    from datetime import datetime, timezone
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"{slug}_{date_str}.mmproject"

    # Audit
    audit = AuditEntry(
        user_id=user.id,
        action="project_export",
        entity_type="project",
        entity_id=project_id,
        project_id=project_id,
        details=json.dumps({"filename": filename}),
    )
    db.add(audit)
    db.commit()

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ── Project import ──────────────────────────────────────────────────────

@router.post("/validate-import", response_model=ImportValidationResult)
async def validate_import_endpoint(
    file: UploadFile,
    user: User = Depends(get_current_user),
):
    """Validate an uploaded .mmproject file and return a preview."""
    tmp_path = await _stream_upload_to_temp(file)
    try:
        result = validate_project_file(tmp_path)
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        if tmp_path.exists():
            os.unlink(tmp_path)


@router.post("/import-project", response_model=ProjectImportResult)
async def import_project_endpoint(
    file: UploadFile,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import an .mmproject file, creating a new project."""
    docs_dir, media_dir = _get_data_dirs()
    tmp_path = await _stream_upload_to_temp(file)
    try:
        new_id, project_name = import_project(db, tmp_path, docs_dir, media_dir, user_id=user.id)

        # Audit
        audit = AuditEntry(
            user_id=user.id,
            action="project_import",
            entity_type="project",
            entity_id=new_id,
            project_id=new_id,
            details=json.dumps({
                "project_name": project_name,
                "source_filename": file.filename,
            }),
        )
        db.add(audit)
        db.commit()

        return ProjectImportResult(
            project_id=new_id,
            project_name=project_name,
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(400, str(e))
    except Exception as e:
        db.rollback()
        logger.error("Project import failed: %s", e, exc_info=True)
        raise HTTPException(500, "Project import failed. Check server logs for details.")
    finally:
        if tmp_path.exists():
            os.unlink(tmp_path)


# ── Codebook export ─────────────────────────────────────────────────────

@router.get("/{project_id}/export-codebook")
async def export_codebook_endpoint(
    project_id: int,
    format: str = "native",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Export a project's codebook as .mmcodebook (JSON) or .qdc (XML)."""
    project = _get_project_or_404(db, project_id, user.id)

    slug = _slugify(project.name)

    if format == "qdc":
        try:
            xml_content = export_codebook_qdc(db, project_id)
        except ValueError as e:
            raise HTTPException(404, str(e))

        filename = f"{slug}_codebook.qdc"
        audit = AuditEntry(
            user_id=user.id,
            action="codebook_export",
            entity_type="project",
            entity_id=project_id,
            project_id=project_id,
            details=json.dumps({"format": "qdc", "filename": filename}),
        )
        db.add(audit)
        db.commit()

        return Response(
            content=xml_content,
            media_type="application/xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )
    else:
        try:
            codebook_data = export_codebook_native(db, project_id)
        except ValueError as e:
            raise HTTPException(404, str(e))

        filename = f"{slug}_codebook.mmcodebook"
        audit = AuditEntry(
            user_id=user.id,
            action="codebook_export",
            entity_type="project",
            entity_id=project_id,
            project_id=project_id,
            details=json.dumps({"format": "native", "filename": filename}),
        )
        db.add(audit)
        db.commit()

        content = json.dumps(codebook_data, indent=2)
        return Response(
            content=content,
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )


# ── Codebook import ─────────────────────────────────────────────────────

@router.post("/{project_id}/import-codebook", response_model=CodebookImportResult)
async def import_codebook_endpoint(
    project_id: int,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import a codebook file (.mmcodebook or .qdc) into a project."""
    content = await read_upload_with_limit(file, 10 * 1024 * 1024)
    content_str = content.decode("utf-8")

    # Detect format by content (XML vs JSON)
    is_xml = content_str.lstrip().startswith("<?xml") or content_str.lstrip().startswith("<")

    try:
        if is_xml:
            counts = import_codebook_qdc(db, project_id, content_str)
            fmt = "qdc"
        else:
            data = json.loads(content_str)
            counts = import_codebook_native(db, project_id, data)
            fmt = "native"
    except (ValueError, json.JSONDecodeError) as e:
        db.rollback()
        raise HTTPException(400, str(e))
    except Exception as e:
        db.rollback()
        logger.error("Codebook import failed: %s", e, exc_info=True)
        raise HTTPException(500, "Codebook import failed. Check server logs for details.")

    # Audit
    audit = AuditEntry(
        user_id=user.id,
        action="codebook_import",
        entity_type="project",
        entity_id=project_id,
        project_id=project_id,
        details=json.dumps({
            "format": fmt,
            "filename": file.filename,
            **counts,
        }),
    )
    db.add(audit)
    db.commit()

    return CodebookImportResult(**counts)
