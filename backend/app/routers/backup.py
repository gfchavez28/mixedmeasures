"""Backup and restore API endpoints."""

import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import get_settings, get_documents_dir, get_media_dir, get_backup_dir
from ..database import engine, get_db
from ..models.user import User
from ..models.audit import AuditEntry
from ..schemas.backup import BackupInfo, BackupStatus, RestorePreview
from ..services.backup import (
    create_backup,
    cleanup_old_backups,
    get_backup_status,
    list_backups,
    restore_from_backup,
    validate_backup,
)

import asyncio

import json

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/backup", tags=["backup"])

MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 500MB


def _get_paths() -> tuple[Path, Path, Path, Path]:
    """Return (db_path, docs_dir, media_dir, backup_dir)."""
    db_path = Path(get_settings().mm_database_path)
    return db_path, get_documents_dir(), get_media_dir(), get_backup_dir()


async def _stream_upload_to_temp(file: UploadFile, max_size: int = MAX_UPLOAD_SIZE) -> Path:
    """Stream uploaded file to a temp file with size limit.

    Returns the temp file path. Caller is responsible for cleanup.
    """
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mmbackup")
    try:
        total = 0
        with os.fdopen(tmp_fd, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                total += len(chunk)
                if total > max_size:
                    raise HTTPException(413, f"File too large (max {max_size // (1024*1024)}MB)")
                f.write(chunk)
        return Path(tmp_path)
    except HTTPException:
        os.unlink(tmp_path)
        raise
    except Exception:
        os.unlink(tmp_path)
        raise


@router.get("/status", response_model=BackupStatus)
async def backup_status(user: User = Depends(get_current_user)):
    """Get backup status summary. #357: now includes `next_backup_at`
    computed as `last_backup_at + auto_backup_interval_hours` so the UI
    can render a freshness label instead of a stale-only amber dot."""
    _, _, _, backup_dir = _get_paths()
    interval = get_settings().auto_backup_interval_hours
    return get_backup_status(backup_dir, interval_hours=interval)


@router.post("/now", response_model=BackupStatus)
async def backup_now(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """#357: trigger an auto-prefix backup synchronously without download.

    Distinct from `POST /create` (which creates + streams a file response
    for the share-with-someone-else flow). This endpoint creates a snapshot
    that counts toward the same 5-backup auto rotation — researchers can
    use it as "give me a fresh insurance snapshot before a big change".

    Returns the updated `BackupStatus` so the frontend can immediately
    re-render the freshness label without waiting for the next polling
    tick.
    """
    db_path, docs_dir, media_dir, backup_dir = _get_paths()
    settings = get_settings()

    try:
        # Run the synchronous backup machinery in a worker thread so we
        # don't block the event loop — matches the lifespan loop's pattern.
        info = await asyncio.to_thread(
            create_backup, db_path, docs_dir, media_dir, backup_dir, "auto",
        )
        await asyncio.to_thread(
            cleanup_old_backups, backup_dir, "auto", settings.auto_backup_max_count,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        logger.error("Manual backup failed: %s", e)
        raise HTTPException(500, "Backup creation failed. Check server logs for details.")

    # Audit log so manual snapshots are distinguishable in the trail
    # from auto-scheduled ones.
    audit = AuditEntry(
        user_id=user.id,
        action="backup_now",
        entity_type="system",
        details=json.dumps({"filename": info.filename, "size_bytes": info.size_bytes}),
    )
    db.add(audit)
    db.commit()

    return get_backup_status(backup_dir, interval_hours=settings.auto_backup_interval_hours)


@router.get("/list", response_model=list[BackupInfo])
async def backup_list(user: User = Depends(get_current_user)):
    """List all backups."""
    _, _, _, backup_dir = _get_paths()
    return list_backups(backup_dir)


@router.post("/create")
async def backup_create(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a manual backup and stream it as a download."""
    db_path, docs_dir, media_dir, backup_dir = _get_paths()

    try:
        info = create_backup(db_path, docs_dir, media_dir, backup_dir, "manual")
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        logger.error("Backup creation failed: %s", e)
        raise HTTPException(500, "Backup creation failed. Check server logs for details.")

    # Audit log
    audit = AuditEntry(
        user_id=user.id,
        action="backup_created",
        entity_type="system",
        details=json.dumps({"filename": info.filename, "size_bytes": info.size_bytes}),
    )
    db.add(audit)
    db.commit()

    backup_path = backup_dir / info.filename
    timestamp = info.created_at.replace(":", "").replace("-", "")[:15]
    download_name = f"mixedmeasures_backup_{timestamp}.mmbackup"

    return FileResponse(
        path=str(backup_path),
        media_type="application/octet-stream",
        filename=download_name,
    )


@router.post("/validate", response_model=RestorePreview)
async def backup_validate(
    file: UploadFile,
    user: User = Depends(get_current_user),
):
    """Validate an uploaded .mmbackup file and return a restore preview."""
    tmp_path = await _stream_upload_to_temp(file)
    try:
        preview = validate_backup(tmp_path)
        return preview
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        os.unlink(tmp_path)


@router.post("/restore")
async def backup_restore(
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Restore from an uploaded .mmbackup file.

    Creates a pre-restore safety backup, then replaces the DB and documents.
    After restore, the engine pool is disposed so subsequent requests
    connect to the new database.
    """
    db_path, docs_dir, media_dir, backup_dir = _get_paths()
    tmp_path = await _stream_upload_to_temp(file)

    try:
        # Audit before restore (goes into the current DB which will be replaced)
        audit = AuditEntry(
            user_id=user.id,
            action="restore_started",
            entity_type="system",
            details=json.dumps({"filename": file.filename}),
        )
        db.add(audit)
        db.commit()

        # Close session and dispose all pooled connections before replacing DB file
        db.close()
        engine.dispose()

        pre_restore_info = restore_from_backup(tmp_path, db_path, docs_dir, media_dir, backup_dir)

        return {
            "status": "restored",
            "pre_restore_backup": pre_restore_info.filename,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        logger.error("Restore failed: %s", e)
        raise HTTPException(500, "Restore failed. Check server logs for details.")
    finally:
        if tmp_path.exists():
            os.unlink(tmp_path)
