"""Backup and restore service for Mixed Measures.

Handles .mmbackup ZIP creation (database + documents), validation,
restore, and status reporting. These functions have no SQLAlchemy
dependency — they read the DB via raw DBAPI connections obtained from
``database.open_raw_connection`` (which supplies the SQLCipher key when
encryption is enabled), so backups work in both plaintext and encrypted modes.
"""

import json
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

from ..database import open_raw_connection
from ..schemas.backup import (
    BackupInfo,
    BackupManifest,
    BackupStatus,
    ProjectBackupSummary,
    RestorePreview,
)

logger = logging.getLogger(__name__)

APP_VERSION = "1.0.1"
MANIFEST_FORMAT_VERSION = 1
STALE_HOURS = 24


def checkpoint_wal(db_path: Path) -> None:
    """Checkpoint WAL so the .db file is self-contained."""
    conn = open_raw_connection(db_path)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()


def _read_project_summaries(db_path: Path) -> list[ProjectBackupSummary]:
    """Read project summaries via a temporary raw (keyed-if-encrypted) connection."""
    conn = open_raw_connection(db_path)
    try:
        cursor = conn.execute("SELECT id, name FROM projects ORDER BY name")
        projects = cursor.fetchall()

        summaries = []
        for pid, pname in projects:
            conv_count = conn.execute(
                "SELECT COUNT(*) FROM conversations WHERE project_id = ?", (pid,)
            ).fetchone()[0]
            ds_count = conn.execute(
                "SELECT COUNT(*) FROM datasets WHERE project_id = ?", (pid,)
            ).fetchone()[0]
            doc_count = conn.execute(
                "SELECT COUNT(*) FROM documents WHERE project_id = ?", (pid,)
            ).fetchone()[0]
            summaries.append(ProjectBackupSummary(
                name=pname,
                conversation_count=conv_count,
                dataset_count=ds_count,
                document_count=doc_count,
            ))
        return summaries
    except Exception:
        return []
    finally:
        conn.close()


VALID_BACKUP_TYPES = {"manual", "auto", "pre_restore"}


def _assert_backup_db_readable(db_path: Path) -> None:
    """Open an extracted backup DB with the current (keyed-if-encrypted)
    connection and verify it both decrypts and passes a structural integrity
    check. Raises ValueError with a DISTINCT message for the two failure modes.

    Under SQLCipher a wrong key never fails the ``PRAGMA key`` itself — it
    surfaces only on the first page read — so when the key can't decrypt the
    file, ``PRAGMA integrity_check`` *raises* here rather than returning a row.
    That covers a backup from another machine, one made by an unencrypted build
    (``open_raw_connection`` keys by the CURRENT setting, not the backup's), and
    a non-SQLite/corrupt header. A decryptable-but-damaged DB instead opens and
    returns a non-``ok`` integrity result. The two are reported differently so
    the user can tell "this isn't my backup / wrong key" from "this is corrupt".
    """
    conn = open_raw_connection(db_path)
    try:
        try:
            result = conn.execute("PRAGMA integrity_check").fetchone()
        except Exception as e:
            raise ValueError(
                "This backup's database could not be opened. It may be from "
                "another computer, created by an unencrypted version of the app, "
                "or corrupted."
            ) from e
        if not result or result[0] != "ok":
            detail = result[0] if result else "unknown"
            raise ValueError(
                f"This backup's database failed its integrity check ({detail}). "
                "The file appears to be corrupted."
            )
    finally:
        conn.close()


def create_backup(
    db_path: Path,
    docs_dir: Path,
    media_dir: Path,
    backup_dir: Path,
    backup_type: str = "manual",
) -> BackupInfo:
    """Create a .mmbackup ZIP containing the database and documents.

    Returns BackupInfo on success. Raises on failure.
    """
    if backup_type not in VALID_BACKUP_TYPES:
        raise ValueError(f"Invalid backup type: {backup_type}")

    if not db_path.exists() or db_path.stat().st_size == 0:
        raise FileNotFoundError("No database found to back up")

    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_filename = f"{backup_type}_{timestamp}.mmbackup"
    backup_path = backup_dir / backup_filename

    # Checkpoint WAL for a self-contained copy
    checkpoint_wal(db_path)

    # Copy DB to a temp file (avoid locking the live DB during ZIP write)
    tmp_dir = tempfile.mkdtemp()
    tmp_db = Path(tmp_dir) / "database.db"
    try:
        shutil.copy2(str(db_path), str(tmp_db))
        db_size = tmp_db.stat().st_size

        # Count documents
        doc_count = 0
        doc_files: list[tuple[str, Path]] = []
        if docs_dir.exists():
            for root, _dirs, files in os.walk(docs_dir):
                for f in files:
                    file_path = Path(root) / f
                    arcname = "documents/" + str(file_path.relative_to(docs_dir))
                    doc_files.append((arcname, file_path))
                    doc_count += 1

        # Count media files
        media_count = 0
        media_files: list[tuple[str, Path]] = []
        if media_dir.exists():
            for root, _dirs, files in os.walk(media_dir):
                for f in files:
                    file_path = Path(root) / f
                    arcname = "media/" + str(file_path.relative_to(media_dir))
                    media_files.append((arcname, file_path))
                    media_count += 1

        # Build manifest
        project_summaries = _read_project_summaries(tmp_db)
        manifest = BackupManifest(
            format_version=MANIFEST_FORMAT_VERSION,
            app_version=APP_VERSION,
            created_at=datetime.now(timezone.utc).isoformat(),
            backup_type=backup_type,
            db_size_bytes=db_size,
            document_count=doc_count,
            media_file_count=media_count,
            project_summaries=project_summaries,
        )

        # Write ZIP to a temp file first, then move to final location
        tmp_zip_fd, tmp_zip_path = tempfile.mkstemp(suffix=".mmbackup", dir=str(backup_dir))
        os.close(tmp_zip_fd)
        try:
            with zipfile.ZipFile(tmp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("manifest.json", json.dumps(manifest.model_dump(), indent=2))
                zf.write(str(tmp_db), "database.db")
                for arcname, file_path in doc_files:
                    zf.write(str(file_path), arcname)
                for arcname, file_path in media_files:
                    zf.write(str(file_path), arcname)
            shutil.move(tmp_zip_path, str(backup_path))
        except Exception:
            if os.path.exists(tmp_zip_path):
                os.unlink(tmp_zip_path)
            raise

        size = backup_path.stat().st_size
        logger.info("Backup created: %s (%d bytes)", backup_filename, size)

        return BackupInfo(
            filename=backup_filename,
            created_at=manifest.created_at,
            size_bytes=size,
            backup_type=backup_type,
        )
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def validate_backup(zip_path: Path) -> RestorePreview:
    """Validate a .mmbackup ZIP and return a restore preview.

    Raises ValueError for invalid backups.
    """
    if not zip_path.exists():
        raise ValueError("Backup file not found")

    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            names = zf.namelist()

            if "manifest.json" not in names:
                raise ValueError("Invalid backup: missing manifest.json")
            if "database.db" not in names:
                raise ValueError("Invalid backup: missing database.db")

            # Zip-slip prevention
            for name in names:
                if name.startswith("/") or ".." in name:
                    raise ValueError(f"Invalid backup: suspicious path '{name}'")

            manifest_data = json.loads(zf.read("manifest.json"))
            manifest = BackupManifest(**manifest_data)

            warnings: list[str] = []
            if manifest.format_version != MANIFEST_FORMAT_VERSION:
                warnings.append(
                    f"Backup format version {manifest.format_version} "
                    f"differs from current ({MANIFEST_FORMAT_VERSION})"
                )
            if manifest.app_version != APP_VERSION:
                warnings.append(
                    f"Backup was created with app version {manifest.app_version} "
                    f"(current: {APP_VERSION})"
                )

            # Decrypt/readability + integrity probe on the actual DB. Runs here
            # (not only at restore) so it fails fast — restore_from_backup calls
            # validate_backup BEFORE the pre-restore safety backup, so a foreign
            # / wrong-key / corrupt backup is rejected without wasting a backup
            # or mutating anything, and the preview endpoint warns the user too.
            # The member name is the fixed "database.db" (zip-slip-safe).
            probe_dir = tempfile.mkdtemp()
            try:
                zf.extract("database.db", probe_dir)
                _assert_backup_db_readable(Path(probe_dir) / "database.db")
            finally:
                shutil.rmtree(probe_dir, ignore_errors=True)

            return RestorePreview(manifest=manifest, warnings=warnings)
    except zipfile.BadZipFile:
        raise ValueError("Invalid backup: not a valid ZIP file")


def restore_from_backup(
    zip_path: Path,
    db_path: Path,
    docs_dir: Path,
    media_dir: Path,
    backup_dir: Path,
) -> BackupInfo:
    """Restore from a .mmbackup ZIP.

    Creates a pre-restore safety backup first, then replaces the DB
    and documents directory. Returns the pre-restore backup info.
    """
    # Validate first
    validate_backup(zip_path)

    # Create pre-restore safety backup (includes media files)
    pre_restore_info = create_backup(db_path, docs_dir, media_dir, backup_dir, "pre_restore")
    logger.info("Pre-restore backup created: %s", pre_restore_info.filename)

    tmp_dir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            # Zip-slip prevention during extraction
            for member in zf.namelist():
                if member.startswith("/") or ".." in member:
                    raise ValueError(f"Suspicious path in backup: {member}")

            # Extract database to temp and re-verify it decrypts + passes
            # integrity on the EXACT file we're about to install. validate_backup
            # already probed a separate extraction before the pre-restore backup
            # (so a bad backup is normally rejected before reaching here); this is
            # defense-in-depth against the file changing between the two steps.
            zf.extract("database.db", tmp_dir)
            tmp_db = Path(tmp_dir) / "database.db"
            _assert_backup_db_readable(tmp_db)

            # Extract documents to temp
            tmp_docs = Path(tmp_dir) / "documents"
            doc_members = [m for m in zf.namelist() if m.startswith("documents/")]
            for member in doc_members:
                zf.extract(member, tmp_dir)

            # Replace database (atomic-ish on same filesystem)
            shutil.move(str(tmp_db), str(db_path))

            # Remove WAL/SHM files that belong to the old DB
            for suffix in (".db-wal", ".db-shm"):
                wal_path = db_path.with_suffix(suffix)
                if wal_path.exists():
                    wal_path.unlink()

            # Replace documents directory
            if docs_dir.exists():
                shutil.rmtree(str(docs_dir))
            if tmp_docs.exists():
                shutil.move(str(tmp_docs), str(docs_dir))
            else:
                docs_dir.mkdir(parents=True, exist_ok=True)

            # Extract media to temp
            tmp_media = Path(tmp_dir) / "media"
            media_members = [m for m in zf.namelist() if m.startswith("media/")]
            for member in media_members:
                zf.extract(member, tmp_dir)

            # Replace media directory
            if media_dir.exists():
                shutil.rmtree(str(media_dir))
            if tmp_media.exists():
                shutil.move(str(tmp_media), str(media_dir))
            else:
                media_dir.mkdir(parents=True, exist_ok=True)

        logger.info("Restore complete from backup")
        return pre_restore_info

    except Exception as e:
        logger.error(
            "Restore failed: %s. Pre-restore backup: %s",
            e, pre_restore_info.filename,
        )
        raise


def get_backup_status(backup_dir: Path, interval_hours: float | None = None) -> BackupStatus:
    """Get backup status summary.

    #357: when `interval_hours` is provided (auto-backup cadence), computes
    `next_backup_at = last_backup_at + interval_hours`. Manual "Backup now"
    actions advance `last_backup_at` (the file's mtime), so the next status
    query naturally reports a refreshed `next_backup_at` — no module-level
    state needed; the disk is the source of truth.

    The lifespan loop's actual sleep schedule is independent of this
    calculation (it sleeps from process start), so after a manual backup
    the displayed `next_backup_at` may be slightly out of sync with when
    the loop actually wakes. The auto-loop just creates a new backup
    whenever it wakes, which is strictly safer than under-backing-up.
    """
    if not backup_dir.exists():
        return BackupStatus(
            last_backup_at=None,
            backup_count=0,
            total_size_bytes=0,
            is_stale=True,
            next_backup_at=None,
        )

    backups = sorted(backup_dir.glob("*.mmbackup"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not backups:
        return BackupStatus(
            last_backup_at=None,
            backup_count=0,
            total_size_bytes=0,
            is_stale=True,
            next_backup_at=None,
        )

    latest = backups[0]
    latest_mtime = datetime.fromtimestamp(latest.stat().st_mtime, tz=timezone.utc)
    total_size = sum(b.stat().st_size for b in backups)
    is_stale = (datetime.now(timezone.utc) - latest_mtime) > timedelta(hours=STALE_HOURS)

    next_backup_at: str | None = None
    if interval_hours is not None and interval_hours > 0:
        next_backup_at = (latest_mtime + timedelta(hours=interval_hours)).isoformat()

    return BackupStatus(
        last_backup_at=latest_mtime.isoformat(),
        backup_count=len(backups),
        total_size_bytes=total_size,
        is_stale=is_stale,
        next_backup_at=next_backup_at,
    )


def list_backups(backup_dir: Path) -> list[BackupInfo]:
    """List all .mmbackup files with metadata."""
    if not backup_dir.exists():
        return []

    backups = sorted(backup_dir.glob("*.mmbackup"), key=lambda p: p.stat().st_mtime, reverse=True)
    result = []
    for b in backups:
        # Parse backup type from filename (e.g. "manual_20260314_143000.mmbackup")
        stem = b.stem
        parts = stem.split("_", 1)
        backup_type = parts[0] if parts else "unknown"
        mtime = datetime.fromtimestamp(b.stat().st_mtime, tz=timezone.utc)

        result.append(BackupInfo(
            filename=b.name,
            created_at=mtime.isoformat(),
            size_bytes=b.stat().st_size,
            backup_type=backup_type,
        ))
    return result


def cleanup_old_backups(backup_dir: Path, backup_type: str, max_count: int = 5) -> int:
    """Keep max_count most recent backups of given type, delete older ones.

    Returns the number of deleted backups.
    """
    if not backup_dir.exists():
        return 0

    pattern = f"{backup_type}_*.mmbackup"
    backups = sorted(backup_dir.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    deleted = 0
    for old in backups[max_count:]:
        old.unlink(missing_ok=True)
        deleted += 1
    return deleted
