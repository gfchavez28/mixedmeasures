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
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

from ..database import (
    DatabaseBusyError,  # noqa: F401 — re-exported: every backup caller handles it
    classify_revision,
    database_file_revision,
    open_raw_connection,
    snapshot_database_file,
    upgrade_database_file,
)
from ..models.conversation import VIDEO_FORMATS
from .archive_safety import assert_expanded_size_within_limit
from ..schemas.backup import (
    BackupInfo,
    BackupManifest,
    BackupStatus,
    ProjectBackupSummary,
    RestorePreview,
)

logger = logging.getLogger(__name__)

APP_VERSION = "1.5.6"
MANIFEST_FORMAT_VERSION = 1
STALE_HOURS = 24


class RestoreError(RuntimeError):
    """Restore failed AFTER the pre-restore safety backup was created.

    Carries the safety backup's filename so the failure surface can point the
    user at recovery instead of leaving it in the server log (#550 — disaster
    recovery is the worst moment for a silent escape hatch).
    """

    def __init__(self, message: str, pre_restore_filename: str):
        super().__init__(message)
        self.pre_restore_filename = pre_restore_filename


def _reseat_keep_dir(keep_dir: Path, media_dir: Path) -> None:
    """Move every file in the video keep-dir back to its path under media_dir.

    The keep-dir holds the ONLY copy of local video the backup being restored
    doesn't carry, so this is written to never lose bytes (#550):

    * never overwrites — a file already at the destination wins (by design,
      paths the backup provides defer to the backup) and the kept copy stays
      in the keep-dir rather than being deleted;
    * never raises — a failed move leaves the file in the keep-dir for the
      NEXT run's entry re-seat (this helper runs on the success path, the
      failure path, and on entry when a crashed run left the dir behind);
    * removes the keep-dir only once it is fully emptied.
    """
    if not keep_dir.exists():
        return
    left_behind = 0
    for root, _dirs, files in os.walk(keep_dir):
        for f in files:
            src = Path(root) / f
            rel = src.relative_to(keep_dir)
            dst = media_dir / rel
            try:
                if dst.exists():
                    left_behind += 1
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
            except OSError as e:
                left_behind += 1
                logger.error("Could not re-seat preserved media %s: %s", rel, e)
    if left_behind:
        logger.error(
            "%d preserved media file(s) could not be re-seated and remain in %s "
            "— they will be retried on the next restore",
            left_behind, keep_dir,
        )
    else:
        shutil.rmtree(str(keep_dir), ignore_errors=True)


#: How long a backup waits for a LOCKED database before it refuses (#1025), per
#: caller. A refusal writes nothing, and each caller says what was not done. Since
#: #1044 the copy is SQLite's backup API, which reads a snapshot past any export,
#: import or merge — so only a lock another program holds EXCLUSIVELY is waited on,
#: and these budgets are the fallback for that rare case, not the common path.
#:
#: - The default is for a researcher waiting on a button (Backup now, Download
#:   Backup, the backups before a restore, a withdrawal and an update).
#: - The 4-hourly backup holds a restore-gate slot while it waits, so its wait must
#:   stay well under `restore_gate.RESTORE_DRAIN_TIMEOUT_SECONDS` (60 s), or a
#:   restore asked for meanwhile is refused. A refused one is retried after
#:   `AUTO_BACKUP_BUSY_RETRY_SECONDS`, not four hours later.
#: - The on-quit backup has seconds at most: on macOS and Linux the desktop shell
#:   kills the backend 5 s after asking it to stop (`electron/backend-process.js`).
BACKUP_BUSY_WAIT_SECONDS = 20.0
AUTO_BACKUP_BUSY_WAIT_SECONDS = 30.0
AUTO_BACKUP_BUSY_RETRY_SECONDS = 300.0
SHUTDOWN_BACKUP_BUSY_WAIT_SECONDS = 3.0


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
            obs_count = conn.execute(
                "SELECT COUNT(*) FROM observations WHERE project_id = ?", (pid,)
            ).fetchone()[0]
            summaries.append(ProjectBackupSummary(
                name=pname,
                conversation_count=conv_count,
                dataset_count=ds_count,
                document_count=doc_count,
                observation_count=obs_count,
            ))
        return summaries
    except Exception:
        return []
    finally:
        conn.close()


#: ⚠️ `pre_withdrawal` (#702(3)) is deliberately NOT wired into any
#: `cleanup_old_backups` rotation. Every other type is either user-initiated or
#: rotates on a schedule; this one is the ONLY recovery point for an irreversible
#: removal of a real person's data, taken on a request the researcher will have
#: recorded. Rotating it away after five more operations would silently delete
#: the safety net while the operation it protects stays done. Withdrawals are
#: rare, so the disk cost of keeping them is the right trade.
#: 🔴 `shutdown` is its OWN type, and separating it from `auto` is the whole of
#: #920's remaining half (2026-09-20). Both are automatic snapshots, so the hook
#: reused `auto` — and thereby shared its 5-deep rotation, which means **a quit
#: spends one of five recovery points**. Quitting and reopening five times empties
#: the window without anyone touching a migration or a project.
#:
#: MEASURED TWICE. #920 recorded five edits in ~100 seconds emptying it in
#: development. It then happened again during the fix: five edits to files under
#: `backend/app/` between 07:52 and 07:54 on 2026-09-20 cycled the `--reload`
#: server five times, and the developer's five real snapshots — 2026-09-19 17:39
#: through 2026-09-20 02:07 — were replaced by five copies of the same database
#: taken **82 seconds apart**. 718 MB written; the recovery window went from ~9
#: hours to 82 seconds.
#:
#: ⚠️ **A "has anything changed?" skip was written, measured and REFUTED.** The
#: obvious signal is whether the database is newer than the last backup, and it
#: cannot work: on the live install the `-wal` was 4 seconds NEWER than the backup
#: that had just been taken, because the next startup touches it — so the check
#: never skips. (A pure read does not move it; something in startup does. Which
#: component was not chased, because the answer does not change the design.) The
#: two backups exist for DIFFERENT reasons, so they get different rotations — no
#: detection, and nothing can be skipped that was needed.
VALID_BACKUP_TYPES = {"manual", "auto", "shutdown", "pre_restore", "pre_withdrawal"}

#: How many end-of-session snapshots to keep. Deliberately small and deliberately
#: NOT an env knob: its job is "where you left off last time", which two covers,
#: and every quit writes a full copy of the database. The 4-hourly `auto`
#: rotation, which spans the working day, is the one that answers "a bad day" and
#: it is the one `MM_AUTO_BACKUP_MAX_COUNT` tunes.
SHUTDOWN_BACKUP_MAX_COUNT = 2

#: How many *Download Backup* archives to keep server-side (#982, developer's
#: call 2026-09-20). This type never rotated at all, and it is the only one whose
#: server copy is a DUPLICATE: the file was already streamed to the researcher's
#: downloads, and it is the one type that includes video by default, so each click
#: left a second full copy of the whole install on disk forever.
#:
#: **Not zero**, which is the tempting reading of "it is a duplicate": a manual
#: backup is the one taken deliberately before something risky, and #971 exists so
#: that backup can be restored from inside the app without hunting for the file.
#: Two keeps that possible with one level of slack.
MANUAL_BACKUP_MAX_COUNT = 2

# `{type}_{YYYYMMDD}_{HHMMSS}[-{n}].mmbackup`. Anchored, and no `/`, `\` or `..`
# can match, which is what makes a filename arriving from a URL safe to join onto
# the backup folder (`find_backup`) — the same construction `safety_copies._NAME_RE`
# uses, and for the same reason.
#
# 🔴 **Listing by this pattern, never by `glob("*.mmbackup")` (#971).** `create_backup`
# staged its ZIP as `tempfile.mkstemp(suffix=".mmbackup", dir=backup_dir)` and moved it
# into place, so an interrupted write left a `tmpXXXXXXXX.mmbackup` behind — and the
# glob listed it. MEASURED on the developer's own folder 2026-09-20: an 88.1 MB
# `tmpouivnp8v.mmbackup` from 2026-09-07 that is a `BadZipFile`, reported by
# `list_backups` as a backup of type `"tmpouivnp8v"` and counted by
# `get_backup_status` into both `backup_count` and `total_size_bytes`. Worse than
# cosmetic: `get_backup_status` takes `backups[0]` by mtime as `last_backup_at`, so a
# fresher orphan would have set the freshness line and silenced the stale warning on
# the strength of a truncated file. The write path below now makes such a file
# impossible; the pattern is what keeps the ones already on disk out of the list.
# The longest type alternative must come first — `pre_restore` and `pre_withdrawal`
# share a prefix, and Python's alternation takes the first that matches.
_BACKUP_NAME_RE = re.compile(
    r"^(?P<type>" + "|".join(sorted((re.escape(t) for t in VALID_BACKUP_TYPES), key=len, reverse=True)) + r")"
    r"_(?P<date>\d{8})_(?P<time>\d{6})(?:-(?P<n>\d+))?\.mmbackup$"
)


def parse_backup_name(filename: str) -> re.Match | None:
    """The match for a well-formed backup filename, or None. The ONE place a
    `.mmbackup` name is recognised, so the writer, the list and the resolver
    cannot disagree about what counts as one."""
    return _BACKUP_NAME_RE.match(filename)


def backup_files(backup_dir: Path) -> list[Path]:
    """Every well-formed backup in the folder, newest first.

    Newest is decided by the NAME, with the modification time only as a
    tiebreaker: the name is written in the same call as the file, while copying
    the folder to another machine rewrites every mtime (`safety_copies._taken_at`
    makes the same choice for the same reason).

    🔴 **Within one second the `-n` tail is compared NUMERICALLY, and an absent
    tail is 1 — the first file of that second, not the last.** A plain string
    tiebreaker is wrong twice over: `.` (0x2E) sorts above `-` (0x2D), so the
    UNTAILED name read as the newest of its second, and `-10` would read as older
    than `-2`. That is not cosmetic here — `cleanup_old_backups` keeps the newest
    N *by this order*, so with several backups of one type in one second **the
    rotation deleted the archive that had just been created**, and the response
    then streamed a file that no longer existed. Caught by a guard, not in the
    wild: it needs `max_count + 1` backups of one type inside one second.
    """
    if not backup_dir.is_dir():
        return []
    found: list[tuple[str, int, str, Path]] = []
    for path in backup_dir.iterdir():
        match = _BACKUP_NAME_RE.match(path.name)
        if match is None:
            continue
        try:
            if not path.is_file():
                continue
        except OSError:
            continue
        found.append((match["date"] + match["time"], int(match["n"] or 1), path.name, path))
    found.sort(key=lambda row: row[:3], reverse=True)
    return [row[3] for row in found]


class BackupNameError(ValueError):
    """A filename that is not a backup's. Distinct from `FileNotFoundError`,
    which is a well-formed name with no file behind it."""


def find_backup(backup_dir: Path, filename: str) -> Path:
    """Resolve a filename from a request to a backup on disk (#971).

    Raises `BackupNameError` for anything that is not a backup's name — including
    every `.mmproject`, so this can never be used to reach a safety copy or the
    raw pre-migration database copies that share the folder — and
    `FileNotFoundError` when no such backup exists.
    """
    if _BACKUP_NAME_RE.match(filename) is None:
        raise BackupNameError(f"Not a backup: {filename!r}")
    path = backup_dir / filename
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise FileNotFoundError(filename)
    if resolved.parent != backup_dir.resolve() or not resolved.is_file():
        raise FileNotFoundError(filename)
    return resolved


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


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version or ""))


def _unreadable_version_message(backup_version: str, revision: str | None) -> str:
    """The refusal for a backup whose database this build cannot read (#1026).

    Said at PREVIEW, before the pre-restore backup is taken. Accepted, such a
    backup made the NEXT launch fatal (`Can't locate revision`) — and the one
    backup that could undo it could only be restored from inside the app that
    no longer started.
    """
    if _version_tuple(backup_version) > _version_tuple(APP_VERSION):
        return (
            f"This backup was made by Mixed Measures {backup_version}, which is newer than "
            f"this version ({APP_VERSION}). This version cannot read its data, so it cannot "
            f"restore it. Nothing has been changed. Restore it with Mixed Measures "
            f"{backup_version} or later."
        )
    recorded = f"database version {revision}" if revision else "it records no database version"
    return (
        f"This backup's data is in a form this version of Mixed Measures ({APP_VERSION}) "
        f"cannot read ({recorded}), so it cannot be restored here. Nothing has been "
        "changed. Restore it with the version of Mixed Measures that made it, or a later one."
    )


def _backup_schema(db_file: Path, backup_version: str) -> str:
    """`"current"` or `"older"` for a backup this build can restore; raises
    ValueError, with the sentence to show, for one it cannot (#1026)."""
    try:
        revision = database_file_revision(db_file)
    except Exception as e:  # unreadable: `_assert_backup_db_readable` normally says so first
        raise ValueError("This backup's database could not be opened.") from e
    status = classify_revision(revision)
    if status == "unknown":
        raise ValueError(_unreadable_version_message(backup_version, revision))
    return status


def _bring_to_this_version(db_file: Path, backup_version: str) -> None:
    """Migrate a STAGED backup database to this build's head before it is swapped
    in (#1026). An older backup used to be installed as it was: every page reading
    a newer column then failed (`no such column: codes.code_set_id`) until the app
    was relaunched. Migrating here, not after the swap, keeps the restore's
    destructive phase renames-only (#550) — a migration that fails leaves
    everything as it was.

    ⚠️ No `-wal` can be left beside the migrated file to lose in the move: the
    migration engine is `NullPool`, and `database_file_revision` below opens and
    closes one more connection, so the file's last connection has closed (which
    checkpoints and removes the WAL) before this returns. Measured 2026-09-24:
    baseline → head, 27 revisions, 0.73 s, no `-wal` left.
    """
    if _backup_schema(db_file, backup_version) == "current":
        return
    try:
        upgrade_database_file(db_file)
    except Exception as e:
        logger.error("Could not upgrade the backup's database: %s", e)
        raise ValueError(
            "This backup's data could not be upgraded to this version of Mixed Measures "
            f"({e}). Nothing has been changed."
        ) from e
    if _backup_schema(db_file, backup_version) != "current":
        raise ValueError(
            "This backup's data could not be upgraded to this version of Mixed Measures. "
            "Nothing has been changed."
        )


def create_backup(
    db_path: Path,
    docs_dir: Path,
    media_dir: Path,
    backup_dir: Path,
    backup_type: str = "manual",
    include_video: bool = True,
    *,
    busy_wait_seconds: float = BACKUP_BUSY_WAIT_SECONDS,
) -> BackupInfo:
    """Create a .mmbackup ZIP containing the database and documents.

    include_video=False (the periodic auto-backup policy — video V1 slab 5)
    skips video recordings: the 4h × 5-rotation would otherwise multiply a
    multi-GB video project onto the researcher's disk. Transcripts, coding,
    the DB, documents, and audio stay protected; recordings are re-attachable
    and restore preserves any local video files the backup lacks.

    🔴 **A backup holds everything committed, or it is not written (#1025, #1044).**
    It used to copy the database FILE after a checkpoint whose answer it ignored, so a
    backup taken while an export, import or merge held the database lacked recent
    work and still passed validation. It now copies through SQLite's backup API
    (`database.snapshot_database_file`), which captures that work without waiting for
    it; `DatabaseBusyError` is raised, having written nothing, only when another
    program holds the database locked for all of `busy_wait_seconds`.

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
    # Never overwrite an existing backup. Two backups of one type in the same
    # second (a "Backup now" as the shutdown backup fires) would otherwise share
    # a name, and `shutil.move` onto an existing path replaces it silently — so
    # the older snapshot, i.e. the one further back in the recovery window, is
    # the one destroyed. `write_safety_copy` solved this for the sibling writer
    # in #919; this is the same fix in the same folder.
    #
    # 🔴 **The tail is the largest one in use PLUS ONE, never the first free slot.**
    # First-free re-issues a number the moment a rotation deletes one, so a NEWER
    # file ends up carrying a LOWER tail than an older one — and `backup_files`
    # then orders them wrongly, which is how the rotation came to delete the
    # archive that had just been written. This is `create_manual_row`'s rule
    # (§5d: *"the next identifier follows the largest existing NUMBER, never the
    # row count — `count + 1` re-issues a live identifier the first time a record
    # is deleted"*) reached independently in a second place.
    # ⚠️ The scan is UNCONDITIONAL — `if backup_path.exists()` around it is the
    # same defect one level up, and the guard caught it: once a rotation deletes
    # the untailed file, the base name is free again, so the next backup takes it
    # and is immediately the OLDEST of its second.
    stamp = timestamp.replace("_", "")
    taken = [
        int(m["n"] or 1)
        for p in (backup_dir.iterdir() if backup_dir.is_dir() else [])
        if (m := _BACKUP_NAME_RE.match(p.name)) is not None
        and m["type"] == backup_type
        and m["date"] + m["time"] == stamp
    ]
    if taken:
        backup_filename = f"{backup_type}_{timestamp}-{max(taken) + 1}.mmbackup"
        backup_path = backup_dir / backup_filename

    # Snapshot the DB to a temp file first, so the database is read only for the copy
    # and never for the ZIP write — complete, or refused before anything is written.
    tmp_dir = tempfile.mkdtemp()
    tmp_db = Path(tmp_dir) / "database.db"
    try:
        snapshot_database_file(db_path, tmp_db, busy_wait_seconds=busy_wait_seconds)
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

        # Count media files (optionally excluding video recordings)
        media_count = 0
        video_excluded_count = 0
        media_files: list[tuple[str, Path]] = []
        if media_dir.exists():
            for root, _dirs, files in os.walk(media_dir):
                for f in files:
                    file_path = Path(root) / f
                    if not include_video and file_path.suffix.lstrip(".").lower() in VIDEO_FORMATS:
                        video_excluded_count += 1
                        continue
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
            video_excluded=not include_video,
            video_files_excluded=video_excluded_count,
            project_summaries=project_summaries,
        )

        # Write the ZIP beside its destination, then move it into place, so a
        # file CARRYING A BACKUP'S NAME is always complete.
        #
        # 🔴 The staging name must not end in `.mmbackup` (#971). It used to —
        # `mkstemp(suffix=".mmbackup", …)` — so an interrupted write left a
        # `tmpXXXXXXXX.mmbackup` that the old `glob("*.mmbackup")` listing
        # presented as a backup; one such orphan (88.1 MB, unreadable) was
        # measured on the developer's own machine. A leading dot and a `.partial`
        # suffix cannot match `_BACKUP_NAME_RE`, which is the same construction
        # `write_safety_copy` uses. Same filesystem as the destination, so the
        # move is a rename rather than a multi-GB copy.
        tmp_zip_fd, tmp_zip_path = tempfile.mkstemp(
            prefix=f".{backup_filename}.", suffix=".partial", dir=str(backup_dir)
        )
        os.close(tmp_zip_fd)
        try:
            with zipfile.ZipFile(tmp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("manifest.json", json.dumps(manifest.model_dump(), indent=2))
                zf.write(str(tmp_db), "database.db")
                for arcname, file_path in doc_files:
                    zf.write(str(file_path), arcname)
                for arcname, file_path in media_files:
                    # Recordings are already-compressed containers — deflate
                    # wastes CPU for ~0 gain (video V1 slab 5).
                    zf.write(str(file_path), arcname, compress_type=zipfile.ZIP_STORED)
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

            # Zip-slip prevention. ⚠️ This path is NOT vulnerable the way
            # `project_portability.py`'s was (#688): restore extracts with
            # `zf.extract()`, which applies CPython's own member sanitisation
            # (`os.path.splitdrive` strips the drive on Windows, `..`/absolute
            # components are stripped), so a `C:/evil.txt` member lands at
            # `dest/evil.txt` rather than escaping. The scan below is therefore
            # belt-and-braces here, and is deliberately left in place: the safety
            # rests on WHICH zipfile API is called, not on this check, so if restore
            # is ever moved onto `zf.open()`/`writestr` for streaming — exactly what
            # made the sibling exploitable — this becomes the only defence and must
            # be swapped for `archive_safety.assert_member_within`.
            for name in names:
                if name.startswith("/") or ".." in name:
                    raise ValueError(f"Invalid backup: suspicious path '{name}'")

            # #696: the archive is bounded; its expansion was not. Refuse here, at
            # validate time, so a bomb is rejected BEFORE the pre-restore safety
            # backup is taken and before anything is staged.
            assert_expanded_size_within_limit(zf)

            manifest_data = json.loads(zf.read("manifest.json"))
            manifest = BackupManifest(**manifest_data)

            warnings: list[str] = []
            if manifest.format_version != MANIFEST_FORMAT_VERSION:
                warnings.append(
                    f"Backup format version {manifest.format_version} "
                    f"differs from current ({MANIFEST_FORMAT_VERSION})"
                )
            # #551: video-excluded backups (the periodic auto-backup policy)
            # must SAY so before the user commits — restoring one on a machine
            # without the original files leaves video conversations pointing
            # at recordings that don't exist. On the same machine, restore
            # preserves local video untouched (slab 5), so this is a heads-up
            # there and a real warning on a new machine.
            # ⚠️ Only when something WAS left out: every automatic backup sets the
            # flag, so a project with no video read "0 video recordings were
            # excluded … re-attach each conversation's recording" before every
            # restore (seen driving #1024) — a warning with nothing behind it,
            # which trains the reader to skip the one that has.
            if manifest.video_excluded and manifest.video_files_excluded > 0:
                n = manifest.video_files_excluded
                count = f"{n} video recording{'s were' if n != 1 else ' was'}"
                warnings.append(
                    f"This backup does not include video recordings ({count} "
                    "excluded when it was created). Video files already on this "
                    "computer are preserved; on a different computer, re-attach "
                    "each conversation's recording after restoring."
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
                probe_db = Path(probe_dir) / "database.db"
                _assert_backup_db_readable(probe_db)
                # #1026: which build's data is this? Decided from the database
                # itself — every backup ever written records its revision there,
                # none in its manifest. A version this build cannot read is refused
                # HERE, before the pre-restore backup and before anything is staged.
                # (This replaced a warning that fired on ANY app-version difference,
                # including releases with no schema change between them.)
                if _backup_schema(probe_db, manifest.app_version) == "older":
                    warnings.append(
                        "This backup was made by an earlier version of Mixed Measures "
                        f"({manifest.app_version}). Its data will be upgraded to this "
                        f"version ({APP_VERSION}) as it is restored; the backup file "
                        "itself is not changed."
                    )
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

    Creates a pre-restore safety backup first, then replaces the DB,
    documents, and media. Returns the pre-restore backup info.

    Failure-safety shape (#550): the WHOLE payload is extracted to staging
    before anything is mutated — media into a SIBLING of media_dir (same
    filesystem → the install move is a rename; multi-GB payloads never land
    in OS temp, which is commonly size-capped tmpfs) — so an extraction
    failure aborts with nothing changed, and the destructive phase is
    renames/rmtrees only. Local video the backup doesn't carry is moved to a
    sibling keep-dir and re-seated via ``_reseat_keep_dir`` on success, on
    failure, AND on entry (a crashed run's leftover keep-dir holds the only
    copy — it is re-seated, never deleted). A failure after the safety
    backup exists raises ``RestoreError`` naming it, so callers can point
    the user at recovery instead of a bare 500.
    """
    # Validate first — which also refuses a backup this build cannot read (#1026).
    preview = validate_backup(zip_path)

    # Create pre-restore safety backup (includes media files)
    pre_restore_info = create_backup(db_path, docs_dir, media_dir, backup_dir, "pre_restore")
    logger.info("Pre-restore backup created: %s", pre_restore_info.filename)

    media_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp_video_keep = media_dir.parent / ".video_keep_restore_tmp"
    # A leftover keep-dir means a prior restore crashed after moving video
    # out — it may hold the ONLY copy of those recordings. Re-seat it before
    # doing anything else; NEVER delete it wholesale (#550: the old entry
    # rmtree here is what turned a failed restore + retry into data loss).
    _reseat_keep_dir(tmp_video_keep, media_dir)

    # Media staging: sibling of media_dir. A leftover stage dir holds only
    # COPIES extracted from some backup (unlike the keep-dir), so clearing
    # it on entry is safe.
    media_stage = media_dir.parent / ".media_restore_stage_tmp"
    if media_stage.exists():
        shutil.rmtree(str(media_stage), ignore_errors=True)

    tmp_dir = tempfile.mkdtemp()  # db + documents staging (small payloads)
    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            # Zip-slip prevention during extraction (see validate_backup for why
            # this path is safe by virtue of `zf.extract`, and what would change
            # that). Re-run here rather than trusting validate_backup — restore is
            # reachable independently.
            for member in zf.namelist():
                if member.startswith("/") or ".." in member:
                    raise ValueError(f"Suspicious path in backup: {member}")

            # #696: re-check the expansion cap on the destructive path too. The
            # staging design (#550) already makes an ENOSPC abort cleanly with the
            # install untouched — but "aborts cleanly after filling the disk" is
            # still exhaustion, and this refuses before writing a byte.
            assert_expanded_size_within_limit(zf)

            # ---- Staging phase: extract EVERYTHING before mutating anything.
            # An ENOSPC/IO failure here (the likeliest failure on a multi-GB
            # restore) aborts with the install untouched.

            # Extract database to temp and re-verify it decrypts + passes
            # integrity on the EXACT file we're about to install. validate_backup
            # already probed a separate extraction before the pre-restore backup
            # (so a bad backup is normally rejected before reaching here); this is
            # defense-in-depth against the file changing between the two steps.
            zf.extract("database.db", tmp_dir)
            tmp_db = Path(tmp_dir) / "database.db"
            _assert_backup_db_readable(tmp_db)
            # #1026: the file swapped in must be one this build's models can read.
            _bring_to_this_version(tmp_db, preview.manifest.app_version)

            # Extract documents to temp
            tmp_docs = Path(tmp_dir) / "documents"
            doc_members = [m for m in zf.namelist() if m.startswith("documents/")]
            for member in doc_members:
                zf.extract(member, tmp_dir)

            # Extract media to the sibling staging dir
            media_members = [m for m in zf.namelist() if m.startswith("media/")]
            for member in media_members:
                zf.extract(member, media_stage)
            tmp_media = media_stage / "media"

        # ---- Destructive phase: renames and rmtrees only from here on.

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

        # Preserve local video recordings the backup does not carry
        # (video V1 slab 5: auto-backups exclude video, so a restore must
        # never DELETE video bytes the backup deliberately left out).
        # Files at paths the backup DOES provide defer to the backup.
        preserved_video: list[tuple[Path, Path]] = []  # (relative, absolute)
        backup_media_paths = {m[len("media/"):] for m in media_members}
        if media_dir.exists():
            for root, _dirs, files in os.walk(media_dir):
                for f in files:
                    file_path = Path(root) / f
                    if file_path.suffix.lstrip(".").lower() not in VIDEO_FORMATS:
                        continue
                    rel = file_path.relative_to(media_dir)
                    if str(rel).replace(os.sep, "/") not in backup_media_paths:
                        preserved_video.append((rel, file_path))
        # Keep-dir is a SIBLING of media_dir (same filesystem → instant
        # renames; /tmp may be tmpfs, where multi-GB moves would burn RAM).
        for rel, file_path in preserved_video:
            keep_path = tmp_video_keep / rel
            keep_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(file_path), str(keep_path))

        # Replace media directory
        if media_dir.exists():
            shutil.rmtree(str(media_dir))
        if tmp_media.exists():
            shutil.move(str(tmp_media), str(media_dir))
        else:
            media_dir.mkdir(parents=True, exist_ok=True)

        # Re-seat the preserved video files at their original paths
        if preserved_video:
            logger.info(
                "Restore preserving %d local video file(s) not present in the backup",
                len(preserved_video),
            )
        _reseat_keep_dir(tmp_video_keep, media_dir)

        logger.info("Restore complete from backup")
        return pre_restore_info

    except Exception as e:
        # Put any moved-out video back where it came from, best-effort —
        # whatever cannot move back stays in the keep-dir, which the next
        # run's entry re-seat retries instead of deleting (#550).
        _reseat_keep_dir(tmp_video_keep, media_dir)
        logger.error(
            "Restore failed: %s. Pre-restore backup: %s",
            e, pre_restore_info.filename,
        )
        if isinstance(e, ValueError):
            raise  # validation-shaped errors keep their 400 semantics
        raise RestoreError(
            f"Restore failed partway ({e}). Your previous data was saved to "
            f"backup '{pre_restore_info.filename}' before the restore began.",
            pre_restore_info.filename,
        ) from e
    finally:
        # create_backup cleans its temp dir; restore historically did NOT — a
        # failed restore leaked the full extracted payload into OS temp. The
        # stage dir holds only copies, so unconditional cleanup is safe.
        shutil.rmtree(tmp_dir, ignore_errors=True)
        shutil.rmtree(str(media_stage), ignore_errors=True)


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

    # By NAME, never `glob("*.mmbackup")` (#971): the glob counted a truncated
    # staging orphan into `backup_count` and `total_size_bytes`, and — because
    # `last_backup_at` is just the newest file's mtime — a fresh orphan would
    # have reported the install as freshly backed up and cleared `is_stale`.
    backups = backup_files(backup_dir)
    if not backups:
        return BackupStatus(
            last_backup_at=None,
            backup_count=0,
            total_size_bytes=0,
            is_stale=True,
            next_backup_at=None,
        )

    # Freshness stays keyed on the MODIFICATION TIME, deliberately: this line
    # answers "when did THIS machine last take a backup", which is what the stale
    # dot is about. `backup_files` orders by name, so the newest is re-chosen by
    # mtime here rather than taking its first element. Only MEMBERSHIP changed.
    latest_mtime = max(
        datetime.fromtimestamp(b.stat().st_mtime, tz=timezone.utc) for b in backups
    )
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
    """Every backup in the folder with its metadata, newest first.

    🔴 **The type comes from the NAME PATTERN, never from `stem.split("_", 1)`
    (#971).** Two of the four types contain an underscore, so the split reported
    `pre_restore_20260919_120000.mmbackup` as type `"pre"` — and `pre_withdrawal`
    identically, making the two indistinguishable. The Settings label map has had
    a `pre_restore` key since it was written that could never match. That was
    cosmetic while the list was read-only; a row now carries a **Restore** button,
    so the label is what a researcher chooses a snapshot by, and "pre" is not a
    basis for choosing. A name that does not parse is not listed at all.
    """
    result = []
    for b in backup_files(backup_dir):
        match = parse_backup_name(b.name)
        assert match is not None  # backup_files only yields names that parse
        try:
            stat = b.stat()
        except OSError:
            continue  # removed between the directory read and the stat
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)

        result.append(BackupInfo(
            filename=b.name,
            created_at=mtime.isoformat(),
            size_bytes=stat.st_size,
            backup_type=match["type"],
        ))
    return result


def cleanup_old_backups(backup_dir: Path, backup_type: str, max_count: int = 5) -> int:
    """Keep the `max_count` most recent backups of one type, delete the rest.

    Returns the number actually deleted.

    Recency is decided by the NAME rather than the modification time. Copying a
    backup folder to a new machine rewrites every mtime, in arbitrary order — so
    an mtime rotation on a restored folder keeps five arbitrary snapshots rather
    than the five newest, and deletes recovery points it believes are the oldest.
    The name carries the UTC stamp written in the same call as the file.

    ⚠️ **A file that will not delete is SKIPPED, not raised through.** Windows
    refuses to unlink a file another process holds open — including the archive a
    restore is reading right now, which is reachable since #971 made the app's own
    backups restorable in place. The caller is the 4-hourly loop and the
    shutdown hook; an exception there aborts the rotation and (at shutdown) the
    logged failure is the last thing that happens. Leaving one extra file is the
    harmless direction.
    """
    if backup_type not in VALID_BACKUP_TYPES:
        raise ValueError(f"Invalid backup type: {backup_type}")
    if not backup_dir.exists():
        return 0

    backups = [
        p for p in backup_files(backup_dir)
        if (m := parse_backup_name(p.name)) is not None and m["type"] == backup_type
    ]
    deleted = 0
    for old in backups[max_count:]:
        try:
            old.unlink(missing_ok=True)
        except OSError as e:
            logger.warning("Could not rotate away backup %s: %s", old.name, e)
            continue
        deleted += 1
    return deleted
