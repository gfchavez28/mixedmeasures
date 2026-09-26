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
from ..database import SessionLocal, engine, get_db
from ..models.user import User
from ..models.audit import AuditEntry
from ..models.project import Project
from ..schemas.backup import (
    BackupInfo,
    BackupStatus,
    RestorePreview,
    SafetyCopyInfo,
    SafetyCopyPageResponse,
)
from ..services.backup import (
    MANUAL_BACKUP_MAX_COUNT,
    BackupNameError,
    DatabaseBusyError,
    RestoreError,
    create_backup,
    cleanup_old_backups,
    find_backup,
    get_backup_status,
    list_backups,
    restore_from_backup,
    validate_backup,
)
from ..services.data_repairs import run_data_repairs
from ..services.restore_gate import RestoreRefused, db_gate
from ..services.safety_copies import (
    SafetyCopyNameError,
    find_safety_copy,
    list_safety_copies,
)

import asyncio

import json

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/backup", tags=["backup"])

#: The ceiling on an UPLOADED backup only. A backup this app made is restored in
#: place (`/archives/{filename}/restore`) and is not bounded by it — which is the
#: whole of #971: `create_backup` has no size limit, so before that endpoint
#: existed an instance could write archives it could not read back through its own
#: UI. The limit stays for a file arriving from another machine, where the bytes
#: genuinely have to cross the wire, and it is NAMED on the Settings screen rather
#: than discovered from a 413 after the transfer.
MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 500MB


def _get_paths() -> tuple[Path, Path, Path, Path]:
    """Return (db_path, docs_dir, media_dir, backup_dir)."""
    db_path = Path(get_settings().mm_database_path)
    return db_path, get_documents_dir(), get_media_dir(), get_backup_dir()


#: What a researcher is told when a backup could not be written for a reason other
#: than a busy database. It used to end "Check server logs for details." — there is
#: no server log a desktop user can reach, and a full disk is the likeliest cause.
BACKUP_WRITE_FAILED = (
    "The backup could not be written. The most common cause is a full disk: check "
    "that there is free space, then try again."
)


def _busy_backup_refusal(e: DatabaseBusyError, *, nothing: str) -> HTTPException:
    """#1025: a backup that cannot be complete is refused, not written.

    409, not 500: nothing is broken, and the same request succeeds once the lock is
    released. ⚠️ **Since #1044 the cause is another PROGRAM, never this app's own
    work** — the backup API reads past an export, import or merge, and this app never
    locks the database exclusively. The sentence said "most likely an import, an
    export or a merge" for one day, when it was true.
    """
    return HTTPException(409, (
        f"The backup was not taken: another program kept the database locked for the "
        f"{e.waited_seconds:.0f} seconds it waited. {nothing} If another program has "
        f"the Mixed Measures database open, close it, then try again."
    ))


async def _stream_upload_to_temp(file: UploadFile, max_size: int = MAX_UPLOAD_SIZE) -> Path:
    """Stream an uploaded backup to a staging file with a size limit.

    Returns the staging path. Caller is responsible for cleanup.

    🔴 **Staged in the BACKUP FOLDER, not OS temp.** `restore_from_backup` already
    refuses to put its media payload in OS temp — *"commonly size-capped tmpfs"* —
    and then this function streamed the entire uploaded archive there, which on a
    typical Linux desktop means half a gigabyte of RAM. The backup folder is also
    the filesystem the restore writes into, so staging there is the same disk the
    operation needs anyway. The name cannot match `_BACKUP_NAME_RE` (leading dot,
    `.partial` suffix), so a crash mid-upload cannot leave something the backup
    list will offer to restore — the failure that left an unreadable
    `tmpouivnp8v.mmbackup` on the developer's own machine.
    """
    _, _, _, backup_dir = _get_paths()
    backup_dir.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".upload_", suffix=".partial", dir=str(backup_dir))
    try:
        total = 0
        with os.fdopen(tmp_fd, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                total += len(chunk)
                if total > max_size:
                    raise HTTPException(413, (
                        f"This file is larger than {max_size // (1024*1024)} MB, which is the "
                        "limit for a backup sent from another computer. A backup this copy of "
                        "Mixed Measures made itself can be restored from Backup history with "
                        "no size limit."
                    ))
                f.write(chunk)
        return Path(tmp_path)
    except BaseException:
        # One arm, not two identical ones: every exit that is not a return must
        # remove the staging file, and a cancelled request raises BaseException.
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
        # Counts toward the auto rotation → same policy: video excluded.
        info = await asyncio.to_thread(
            create_backup, db_path, docs_dir, media_dir, backup_dir, "auto",
            False,  # include_video
        )
        await asyncio.to_thread(
            cleanup_old_backups, backup_dir, "auto", settings.auto_backup_max_count,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except DatabaseBusyError as e:
        raise _busy_backup_refusal(e, nothing="Nothing was saved.")
    except Exception as e:
        logger.error("Manual backup failed: %s", e)
        raise HTTPException(500, BACKUP_WRITE_FAILED)

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


def _backup_or_error(backup_dir: Path, filename: str) -> Path:
    try:
        return find_backup(backup_dir, filename)
    except BackupNameError:
        raise HTTPException(400, "That is not a backup file.")
    except FileNotFoundError:
        raise HTTPException(404, "That backup no longer exists.")


@router.get("/archives/{filename}")
def backup_download(
    filename: str,
    user: User = Depends(get_current_user),
):
    """Download a backup already in the backup folder (#971).

    The folder is not reachable from the app, and on the desktop build it sits
    under the OS's per-user application data — so without this the only way to get
    a copy of an existing backup onto another machine is to find the folder in a
    file manager. The name is ASCII by construction (`_BACKUP_NAME_RE`), so it is
    safe in Content-Disposition as it stands.
    """
    _, _, _, backup_dir = _get_paths()
    path = _backup_or_error(backup_dir, filename)
    return FileResponse(
        path=str(path),
        media_type="application/octet-stream",
        filename=path.name,
    )


@router.post("/archives/{filename}/validate", response_model=RestorePreview)
def backup_validate_local(
    filename: str,
    user: User = Depends(get_current_user),
):
    """Preview a backup already in the backup folder, without uploading it (#971).

    ⚠️ **This door is required, not a convenience.** A restore is confirmed from
    the preview — what it contains, when it was taken, whether video was excluded
    — so a restore path whose preview still had to go through a 500 MB upload
    would hit the same wall one step earlier.

    `def`, not `async def`: `validate_backup` opens the archive, extracts the
    database and runs an integrity check, all blocking (#837).
    """
    _, _, _, backup_dir = _get_paths()
    path = _backup_or_error(backup_dir, filename)
    try:
        return validate_backup(path)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/archives/{filename}/restore")
def backup_restore_local(
    filename: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Restore from a backup already in the backup folder (#971).

    🔴 **The defect this closes is that the app could write backups it could not
    read back.** `create_backup` has no size cap; restore accepted only an
    UPLOAD, capped at 500 MB — and the complete backup, the one a careful
    researcher takes by hand before something risky, is the likeliest to exceed
    it, because the automatic ones exclude video to stay small. Restoring in place
    has no ceiling at all: nothing crosses the wire, and nothing is copied.

    🔴 **It also makes the app's own disaster-recovery instruction followable.**
    When a restore fails partway, `RestoreError` tells the researcher their data
    was saved to a named backup and to *"restore that file from the backups
    folder"* — an instruction for which, until this endpoint, there was no
    mechanism. That sentence fires at the single worst moment there is.

    `def`, not `async def`: the whole restore is blocking file I/O (#837).
    """
    _, _, _, backup_dir = _get_paths()
    # Refused BEFORE the gate: "that is not a backup" must not first stop every
    # other request and tear down the connection pool.
    path = _backup_or_error(backup_dir, filename)
    return _restore_in_place(
        path, db=db, user_id=user.id,
        audit_details={"filename": path.name, "source": "backup_folder"},
    )


def _restore_in_place(zip_path: Path, *, db: Session, user_id: int, audit_details: dict) -> dict:
    """The restore both doors run, inside the database gate (#1024).

    🔴 **The order is the fix.** Take the gate (no new request is admitted, and every
    one already running finishes) → write the audit row → close this request's
    session → dispose the pool → swap the files → dispose AGAIN. The gate is what
    keeps a connection from being opened against the old file during the restore;
    the second dispose is for a door the gate does not know about, because after a
    swap a connection opened before it answers with the replaced database — silently,
    on POSIX, and for as long as it stays pooled.

    ⚠️ **Nothing may open the ENGINE between the first dispose and the swap.**
    `restore_from_backup` reads through raw connections of its own
    (`open_raw_connection`), each closed before it returns — including the
    migration that brings an older backup to this version (#1026), which runs on
    the STAGED file before the swap, so what is swapped in is already current.

    After the swap, still inside the gate, the restored database gets the same
    data repairs startup gives every database it opens (#1026) — otherwise a backup
    from before a repair shipped would stay unrepaired until the next relaunch.

    A synchronous function: the local door is a `def` endpoint and the upload door
    hands this to a worker thread, so the wait for the gate never blocks the event
    loop — which is what lets the requests it refuses be answered at all.
    """
    db_path, docs_dir, media_dir, backup_dir = _get_paths()
    try:
        with db_gate.exclusive():
            # Audited before the restore, into the database about to be replaced.
            # `source` tells the two doors apart in a trail that would otherwise
            # show the same action twice.
            db.add(AuditEntry(
                user_id=user_id,
                action="restore_started",
                entity_type="system",
                details=json.dumps(audit_details),
            ))
            db.commit()
            db.close()
            engine.dispose()
            try:
                pre_restore_info = restore_from_backup(
                    zip_path, db_path, docs_dir, media_dir, backup_dir
                )
            finally:
                # Whether the swap finished or failed partway, the file may have
                # changed under the pool.
                engine.dispose()
            # On the NEW file (the pool was just emptied), before anyone else is let
            # in. Never raises: the files are already swapped, and the restore must
            # still report that it succeeded.
            run_data_repairs(SessionLocal)
        return {
            "status": "restored",
            "pre_restore_backup": pre_restore_info.filename,
            # So the finished screen can say WHEN the undo point was taken, in the
            # words Backup history uses for it, rather than print a filename.
            "pre_restore_taken_at": pre_restore_info.created_at,
        }
    except RestoreRefused as e:
        # Nothing was changed: another restore holds the gate, or other work did
        # not finish in time. 409, not 503 — the request was understood and it is
        # the state of THIS install that refuses it.
        raise HTTPException(409, str(e))
    except DatabaseBusyError as e:
        # #1025: the pre-restore backup is taken before anything is staged or
        # swapped, and it is complete or refused — only another program's lock
        # can refuse it (#1044).
        raise HTTPException(409, (
            f"The restore did not start: another program kept the database locked for "
            f"the {e.waited_seconds:.0f} seconds it waited, so the backup of your current "
            f"data that a restore takes first could not be made. Nothing was changed. "
            f"If another program has the Mixed Measures database open, close it, then "
            f"try again."
        ))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RestoreError as e:
        # #550: name the escape hatch rather than pointing at server logs — and
        # since #971 that instruction is one a researcher can actually follow,
        # from the same Backup history list they started in.
        logger.error("Restore failed: %s", e)
        raise HTTPException(500, (
            "Restore failed partway. Your previous data was saved as "
            f"'{e.pre_restore_filename}' before the restore began — restore that "
            "backup from Backup history to return to the prior state."
        ))
    except Exception as e:
        logger.error("Restore failed: %s", e)
        raise HTTPException(500, "Restore failed. Check server logs for details.")


@router.delete("/archives/{filename}", status_code=204)
def backup_delete(
    filename: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Permanently delete one backup.

    Only the `auto` rotation deletes anything on its own — `manual` and
    `pre_restore` accumulate for the life of the install, and `pre_withdrawal` is
    kept deliberately (it is the only recovery point for an irreversible removal
    of a real person's data). Without this the folder can only ever grow, and it
    is not reachable from the app to prune by hand.
    """
    _, _, _, backup_dir = _get_paths()
    path = _backup_or_error(backup_dir, filename)
    try:
        size = path.stat().st_size
        path.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "That backup no longer exists.")
    except OSError as e:
        # Windows refuses to delete a file another program has open.
        logger.warning("Could not delete backup %s: %s", path.name, e)
        raise HTTPException(
            409,
            "The backup could not be deleted. If it is open in another program, "
            "close it and try again.",
        )

    db.add(AuditEntry(
        user_id=user.id,
        action="backup_deleted",
        entity_type="system",
        details=json.dumps({"filename": path.name, "size_bytes": size}),
    ))
    db.commit()


#: How many safety copies one request returns by default (#978). It bounds the
#: ARCHIVES OPENED as well as the rows rendered — a manifest read is a zip open,
#: and the developer's own folder holds 1,954 copies, measured at 1.37 s and
#: ~3,900 tab stops when every row was returned. Generous enough that a real
#: working folder is never truncated; the totals beside the page stay true either
#: way, and the client can ask for all of them.
SAFETY_COPY_PAGE_SIZE = 50


@router.get("/safety-copies", response_model=SafetyCopyPageResponse)
def safety_copy_list(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # Appended LAST + bare default (direct-call positional safety, per the
    # backend test conventions): a `Query(...)` default leaks its sentinel object
    # into direct-call endpoint tests.
    limit: int | None = SAFETY_COPY_PAGE_SIZE,
):
    """List the copies of projects taken before a merge or an overwrite (#919).

    Returns the newest `limit` copies with the TRUE totals beside them (#978);
    `limit=0` or a negative value means every copy.

    `def`, not `async def`: it opens each returned copy's archive to read its
    manifest, which is blocking file I/O (#837).
    """
    _, _, _, backup_dir = _get_paths()
    page = list_safety_copies(backup_dir, limit=limit if limit and limit > 0 else None)
    # Every project's identity, not only this user's: the question is whether the
    # project still exists here at all, which is what makes a copy the only one.
    # Bounded by the number of projects, so no id list reaches `.in_()`.
    present = {u for (u,) in db.query(Project.project_uuid) if u}
    return SafetyCopyPageResponse(
        copies=[
            SafetyCopyInfo(
                filename=c.filename,
                act=c.act,
                taken_at=c.taken_at,
                size_bytes=c.size_bytes,
                project_name=c.project_name,
                project_in_app=(c.project_uuid in present) if c.project_uuid else None,
                readable=c.readable,
            )
            for c in page.copies
        ],
        total_count=page.total_count,
        total_bytes=page.total_bytes,
        truncated=page.truncated,
    )


def _safety_copy_or_error(backup_dir: Path, filename: str) -> Path:
    try:
        return find_safety_copy(backup_dir, filename)
    except SafetyCopyNameError:
        raise HTTPException(400, "That is not a safety copy.")
    except FileNotFoundError:
        raise HTTPException(404, "That safety copy no longer exists.")


@router.get("/safety-copies/{filename}")
def safety_copy_download(
    filename: str,
    user: User = Depends(get_current_user),
):
    """Download a safety copy, so it can be brought back through Import.

    The backup folder is not shown anywhere in the app, and on the desktop build
    it is under the OS's per-user application data — without this the recovery
    instruction names a file nobody can reach. The name is ASCII by construction
    (`_NAME_RE`), so it is safe in Content-Disposition as it stands.
    """
    _, _, _, backup_dir = _get_paths()
    path = _safety_copy_or_error(backup_dir, filename)
    return FileResponse(
        path=str(path),
        media_type="application/octet-stream",
        filename=path.name,
    )


@router.delete("/safety-copies/{filename}", status_code=204)
def safety_copy_delete(
    filename: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Permanently delete one safety copy. Nothing deletes them automatically."""
    _, _, _, backup_dir = _get_paths()
    path = _safety_copy_or_error(backup_dir, filename)
    try:
        size = path.stat().st_size
        path.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "That safety copy no longer exists.")
    except OSError as e:
        # Windows refuses to delete a file another program has open.
        logger.warning("Could not delete safety copy %s: %s", path.name, e)
        raise HTTPException(
            409,
            "The safety copy could not be deleted. If it is open in another "
            "program, close it and try again.",
        )

    db.add(AuditEntry(
        user_id=user.id,
        action="safety_copy_deleted",
        entity_type="system",
        details=json.dumps({"filename": path.name, "size_bytes": size}),
    ))
    db.commit()


@router.post("/create")
def backup_create(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # Appended LAST + bare default (direct-call positional safety).
    include_video: bool = True,
):
    """Create a manual backup and stream it as a download.

    Manual downloads default to a FULL backup including video; pass
    include_video=false for a lighter archive (the auto rotation is always
    video-less — slab 5 policy).

    `def`, not `async def` (#1025): the body awaits nothing, so as `async` it ran
    the whole backup — and, since #1025, its wait for a busy database — ON the event
    loop, and no other request was answered until it finished.
    """
    db_path, docs_dir, media_dir, backup_dir = _get_paths()

    try:
        info = create_backup(
            db_path, docs_dir, media_dir, backup_dir, "manual", include_video=include_video
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except DatabaseBusyError as e:
        raise _busy_backup_refusal(e, nothing="Nothing was saved or downloaded.")
    except Exception as e:
        logger.error("Backup creation failed: %s", e)
        raise HTTPException(500, BACKUP_WRITE_FAILED)

    # #982: this type never rotated, and its server copy is a DUPLICATE — the file
    # is streamed to the researcher's downloads below, and this is the one type
    # that includes video by default. Rotating AFTER the create is safe: the
    # rotation keeps the newest `MANUAL_BACKUP_MAX_COUNT`, which always includes
    # the archive this response is about to stream.
    try:
        cleanup_old_backups(backup_dir, "manual", MANUAL_BACKUP_MAX_COUNT)
    except Exception as e:
        # Never fail a backup over failing to delete an older one.
        logger.warning("Could not rotate old manual backups: %s", e)

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

    Creates a pre-restore safety backup, then replaces the database, documents and
    media — through `_restore_in_place`, the same gated routine as the local door.

    `async` only for the upload: the restore itself runs in a worker thread. It used
    to run ON the event loop, which froze every other request for the whole restore
    and protected nothing — sync endpoints already in the threadpool, and the
    consensus sweep's thread, kept their connections to the old file (#1024).
    """
    tmp_path = await _stream_upload_to_temp(file)
    try:
        return await asyncio.to_thread(
            _restore_in_place, tmp_path, db=db, user_id=user.id,
            audit_details={"filename": file.filename, "source": "upload"},
        )
    finally:
        if tmp_path.exists():
            os.unlink(tmp_path)
