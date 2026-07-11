"""Project portability API — export/import projects and codebooks."""

import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import get_documents_dir, get_media_dir, get_settings
from ..database import get_db
from ..models.audit import AuditEntry
from ..models.project import Project
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
    MergeDivergenceError,
    build_merge_coder_preview,
    build_merge_code_preview,
    export_project,
    import_project,
    validate_project_file,
)
from .helpers import (
    _get_project_or_404,
    apply_project_owner_filter,
    read_upload_with_limit,
)

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
    # Appended LAST + bare default (tests CLAUDE.md: direct-call positional
    # args must not shift; a Query() default would leak its sentinel).
    include_media: bool = True,
):
    """Export a project as a .mmproject ZIP file.

    include_media=False produces a media-less archive (canvas images still
    travel — they are canvas content): transcripts/coding/documents only,
    with recordings re-attachable after import. The archive-then-trim flow
    for large video projects is a media-INCLUSIVE export to external
    storage, then Remove Recording locally.
    """
    project = _get_project_or_404(db, project_id, user.id)
    docs_dir, media_dir = _get_data_dirs()
    try:
        buf = export_project(db, project_id, docs_dir, media_dir, include_media=include_media)
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
        details=json.dumps({"filename": filename, "include_media": include_media}),
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


# ── Project duplicate (#464) ────────────────────────────────────────────

@router.post("/{project_id}/duplicate", response_model=ProjectImportResult)
async def duplicate_project_endpoint(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Duplicate a project in place.

    Exports the project to an in-memory .mmproject, then re-imports it as a
    brand-new project (import_mode="new" → fresh project_uuid + entity uuids, so
    the copy is fully independent and can itself be exported/merged later). The
    copy's name gets a guaranteed-unique " (copy)" / " (copy N)" suffix so it never
    shares a name with the original or an earlier copy in the project list.
    """
    project = _get_project_or_404(db, project_id, user.id)
    docs_dir, media_dir = _get_data_dirs()

    try:
        buf = export_project(db, project_id, docs_dir, media_dir)
    except ValueError as e:
        raise HTTPException(404, str(e))

    # import_project takes a path; spill the in-memory ZIP to a temp file.
    tmp_fd, tmp_name = tempfile.mkstemp(suffix=".mmproject")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(tmp_fd, "wb") as f:
            f.write(buf.getvalue())
        new_id, project_name = import_project(
            db, tmp_path, docs_dir, media_dir, user_id=user.id, import_mode="new",
        )

        # Distinguish the copy in the project list with a GUARANTEED-UNIQUE name:
        # "X (copy)", then "X (copy 2)" / "(copy 3)" / … if those already exist
        # (scoped to this user's projects). Without the collision loop, duplicating
        # the same project twice produced two identically-named "X (copy)" rows.
        new_project = db.query(Project).filter(Project.id == new_id).first()
        if new_project is not None:
            base = f"{project.name} (copy)"
            name = base
            suffix = 2
            while (
                db.query(Project)
                .filter(
                    Project.user_id == user.id,
                    Project.name == name,
                    Project.id != new_id,
                )
                .first()
            ):
                name = f"{project.name} (copy {suffix})"
                suffix += 1
            new_project.name = name
            project_name = name

        audit = AuditEntry(
            user_id=user.id,
            action="project_duplicate",
            entity_type="project",
            entity_id=new_id,
            project_id=new_id,
            details=json.dumps({"source_project_id": project_id, "project_name": project_name}),
        )
        db.add(audit)
        db.commit()

        return ProjectImportResult(
            project_id=new_id,
            project_name=project_name,
            merge_report=None,
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(400, str(e))
    except Exception as e:
        db.rollback()
        logger.error("Project duplicate failed: %s", e, exc_info=True)
        raise HTTPException(500, "Project duplicate failed. Check server logs for details.")
    finally:
        if tmp_path.exists():
            os.unlink(tmp_path)


# ── Project import ──────────────────────────────────────────────────────

def _find_existing_project_by_uuid(db: Session, project_uuid: str, user: User) -> Project | None:
    """Track J · J3-1: a local project sharing this stable identity, scoped to the
    same visibility as list_projects (all roster projects locally; own projects only
    under multi-tenant auth)."""
    q = apply_project_owner_filter(
        db.query(Project).filter(Project.project_uuid == project_uuid), user.id
    )
    return q.first()


@router.post("/validate-import", response_model=ImportValidationResult)
async def validate_import_endpoint(
    file: UploadFile,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Validate an uploaded .mmproject file and return a preview.

    Track J · J3-1: also reports `existing_project` when a local project already
    shares the file's stable project_uuid, so the UI can offer "overwrite my copy"
    vs "import as a new copy".
    """
    tmp_path = await _stream_upload_to_temp(file)
    try:
        result = validate_project_file(tmp_path)
        existing_project = None
        merge_coders = None
        merge_codes_preview = None
        incoming_uuid = result["manifest"].get("project_uuid")
        if incoming_uuid:
            match = _find_existing_project_by_uuid(db, incoming_uuid, user)
            if match:
                existing_project = {"id": match.id, "name": match.name}
                # Track J · J3-2: a merge is possible — surface the file's coders +
                # their local match candidates so the UI can confirm the mapping (D8).
                merge_coders = build_merge_coder_preview(db, tmp_path)
                # Track J · J3-2b: + the divergent codes (if any) with ranked local
                # reconcile candidates, so the UI can show the reconcile step BEFORE
                # attempting the merge (no failed-merge round-trip). Empty when the
                # codebook is shared-frozen.
                merge_codes_preview = build_merge_code_preview(db, tmp_path, match.id)
        return {
            **result,
            "existing_project": existing_project,
            "merge_coders": merge_coders,
            "merge_codes_preview": merge_codes_preview,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        if tmp_path.exists():
            os.unlink(tmp_path)


@router.post("/import-project", response_model=ProjectImportResult)
async def import_project_endpoint(
    file: UploadFile,
    import_mode: str = Form("new"),
    target_project_id: int | None = Form(None),
    coder_mapping: str | None = Form(None),
    code_mapping: str | None = Form(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import an .mmproject file.

    import_mode="new" (default) creates a new project. import_mode="overwrite" (Track
    J · J3-1) replaces `target_project_id` — an existing local copy that shares the
    file's stable identity — preserving its project_uuid (the single-device round-trip).
    import_mode="merge" (Track J · J3-2) merges a colleague's codings into
    `target_project_id` (matched by stable identity); `coder_mapping` is the optional
    JSON-encoded D8 confirm decisions (file coder original_id -> {action,...}).
    """
    docs_dir, media_dir = _get_data_dirs()

    if import_mode in ("overwrite", "merge"):
        # Ownership/visibility gate up front (mirrors list_projects + validate-import).
        # This is the real authz boundary — the service trusts target_project_id, so
        # without this a holder of a colleague's file could write into someone else's
        # project under multi-tenant auth.
        if target_project_id is None:
            raise HTTPException(400, f"{import_mode.capitalize()} import requires target_project_id.")
        target = apply_project_owner_filter(
            db.query(Project).filter(Project.id == target_project_id), user.id
        )
        if target.first() is None:
            raise HTTPException(404, "Target project not found.")

    parsed_mapping: dict | None = None
    if coder_mapping:
        try:
            parsed_mapping = json.loads(coder_mapping)
            if not isinstance(parsed_mapping, dict):
                raise ValueError("coder_mapping must be a JSON object")
        except (json.JSONDecodeError, ValueError):
            raise HTTPException(400, "Invalid coder_mapping (expected a JSON object).")

    parsed_code_mapping: dict | None = None
    if code_mapping:
        try:
            parsed_code_mapping = json.loads(code_mapping)
            if not isinstance(parsed_code_mapping, dict):
                raise ValueError("code_mapping must be a JSON object")
        except (json.JSONDecodeError, ValueError):
            raise HTTPException(400, "Invalid code_mapping (expected a JSON object).")

    tmp_path = await _stream_upload_to_temp(file)
    merge_report: dict | None = {} if import_mode == "merge" else None
    try:
        new_id, project_name = import_project(
            db, tmp_path, docs_dir, media_dir, user_id=user.id,
            import_mode=import_mode, target_project_id=target_project_id,
            coder_mapping=parsed_mapping, code_mapping=parsed_code_mapping, report=merge_report,
        )

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
                "import_mode": import_mode,
                "overwrote_project_id": target_project_id if import_mode == "overwrite" else None,
                "merged_into_project_id": target_project_id if import_mode == "merge" else None,
                "merge_report": merge_report,
            }),
        )
        db.add(audit)
        db.commit()

        # J3-1 overwrite: imported files were written under the NEW project id; the
        # deleted target's files still sit under its OLD id. Clean them up post-commit.
        # (Merge writes into the SAME project id, so no stale-dir cleanup — overwrite only.)
        if import_mode == "overwrite" and target_project_id is not None and target_project_id != new_id:
            for base in (get_documents_dir(), get_media_dir()):
                old_dir = base / str(target_project_id)
                try:
                    if old_dir.is_dir():
                        shutil.rmtree(old_dir)
                except Exception:
                    logger.warning("Failed to clean up overwritten project files at %s", old_dir)

        return ProjectImportResult(
            project_id=new_id,
            project_name=project_name,
            merge_report=merge_report,
        )
    except MergeDivergenceError as e:
        # Track J · J3-2c: structured refusal (per-source / per-code diff) for the UI.
        db.rollback()
        raise HTTPException(409, detail=e.payload)
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
    # #553: this was the one endpoint in the router with NO ownership gate at
    # all — it passed project_id straight to the import service, so under
    # multi-tenant auth a file holder could inject codes into any project.
    _get_project_or_404(db, project_id, user.id)
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
