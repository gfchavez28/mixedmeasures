"""Backup and restore service for Mixed Measures.

Handles .mmbackup ZIP creation (database + documents), validation,
restore, and status reporting. These functions have no SQLAlchemy
dependency — they read the DB via raw DBAPI connections obtained from
``database.open_raw_connection`` (which supplies the SQLCipher key when
encryption is enabled), so backups work in both plaintext and encrypted modes.
"""

import errno
import json
import logging
import os
import re
import shutil
import tempfile
import time
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterator

try:  # POSIX. Windows has no `flock`, and needs none here — see `_restore_lock`.
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

from ..database import (
    DatabaseBusyError,  # noqa: F401 — re-exported: every backup caller handles it
    classify_revision,
    database_file_revision,
    open_raw_connection,
    snapshot_database_file,
    upgrade_database_file,
)
from ..models.conversation import VIDEO_FORMATS
from ..startup_errors import FatalStartupError
from .archive_safety import MAX_ARCHIVE_EXPANDED_BYTES, assert_expanded_size_within_limit
from .restore_gate import RestoreRefused
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


class RestoreNotStarted(RuntimeError):
    """The restore stopped before it REPLACED anything (#1036 d).

    Two moments: the copy of the current data that a restore takes first could not
    be written, or the backup could not be unpacked into staging (a full disk, a
    damaged member). Both used to reach the researcher as *"Restore failed partway
    … restore that backup"* — telling them to undo a change that had not happened.
    The message says what stopped it and that the data is as it was.

    `pre_restore_filename` is set when the copy WAS written before the stop, so the
    sentence can say where that copy is (on a full disk it is the space to free).
    """

    def __init__(self, message: str, pre_restore_filename: str | None = None):
        super().__init__(message)
        self.pre_restore_filename = pre_restore_filename


class BackupSettingsError(FatalStartupError):
    """`MM_AUTO_BACKUP_INTERVAL_HOURS` or `MM_AUTO_BACKUP_MAX_COUNT` holds a value that
    cannot mean anything (#1043). Shown verbatim in the packaged app's crash dialog
    (`FatalStartupError`), so it is written as the fix. Neither variable is set by
    the desktop app; they are for a server or Docker install."""


def check_backup_settings(interval_hours: int, max_count: int) -> None:
    """Refuse, at startup, the two schedule values that have no meaning (#1043).

    - **A negative interval.** The loop slept `hours * 3600` seconds, so a negative
      value (and 0, before 0 meant *off*) backed up in a tight loop: MEASURED, 640
      backups in a few seconds, each one rotating another out.
    - **Keeping fewer than one.** The rotation keeps the newest `max_count`, so 0
      deleted every automatic backup the moment it was written — "Backup now"
      included — and a negative count kept an arbitrary few.

    `0` hours is NOT refused: it turns automatic backups off, the meaning the
    neighbouring `MM_INACTIVITY_TIMEOUT_MINUTES=0` already gives 0.
    """
    if interval_hours < 0:
        raise BackupSettingsError(
            f"MM_AUTO_BACKUP_INTERVAL_HOURS is set to {interval_hours}, which is not a number "
            "of hours. Set it to how many hours apart automatic backups are taken (the "
            "default is 4), or to 0 to turn them off, then start Mixed Measures again."
        )
    if max_count < 1:
        raise BackupSettingsError(
            f"MM_AUTO_BACKUP_MAX_COUNT is set to {max_count}, so every automatic backup "
            "would be deleted as soon as it was written. Set it to how many automatic "
            "backups to keep (the default is 5, and it must be at least 1), then start "
            "Mixed Measures again."
        )


# ── Staging: what a writer leaves behind when it is stopped (#1080) ─────────
#
# Every file or folder a backup, a restore or a validation writes BEFORE its
# result is complete is HIDDEN (a leading dot) and ends `.partial`, and it lives in
# a folder the app owns — the backup folder, or beside the database for a
# restore's staged database. Never OS temp: a quit on Windows is `taskkill /F`,
# and a SIGKILL runs no `finally`, so whatever a writer had in OS temp stayed there
# for good — MEASURED (#1080): a `kill -9` 4.5 s into an on-quit backup left a
# 205 MB copy of the database in `/tmp` and a 12.8 MB `.partial` in the backup
# folder, and nothing ever removed either. OS temp is also commonly a size-capped
# tmpfs (RAM) on Linux, which is why the restore already kept its media out of it.
#
# A staging name can never be a backup's (`_BACKUP_NAME_RE`), a safety copy's or a
# pre-migration copy's, so the lists cannot see one; `sweep_abandoned_staging`
# removes the ones nobody is writing any more.

STAGING_SUFFIX = ".partial"

#: SQLite's companion files, which a staged database can leave beside itself when
#: its writer is killed mid-copy (`snapshot_database_file` writes through SQLite).
_SQLITE_SIDE_FILES = ("-journal", "-wal", "-shm")

#: How long a staging entry must have gone UNTOUCHED before the sweep calls it
#: abandoned. A writer that is alive modifies its file continuously — the snapshot
#: and the ZIP are written in one pass, and the longest pause is a lock wait of
#: `BACKUP_BUSY_WAIT_SECONDS` — so an hour is far past any live writer. It matters
#: because a writer can be alive in ANOTHER process: after an update relaunches the
#: desktop app, the old backend may still be finishing its on-quit backup while the
#: new one starts and sweeps.
STAGING_ABANDONED_AFTER_SECONDS = 3600.0


def _staging_dir(folder: Path, label: str) -> Path:
    """A new hidden staging folder inside `folder`, named for what it stages."""
    folder.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f".{label}.", suffix=STAGING_SUFFIX, dir=str(folder)))


def is_staging_name(name: str) -> bool:
    """Whether a name in the backup folder is a writer's staging entry."""
    if not name.startswith("."):
        return False
    return any(name.endswith(STAGING_SUFFIX + side) for side in ("",) + _SQLITE_SIDE_FILES)


def _newest_mtime(path: Path) -> float:
    """The last time anything in a staging entry was written."""
    newest = path.lstat().st_mtime
    if path.is_dir() and not path.is_symlink():
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                try:
                    newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
                except OSError:
                    continue  # removed while we looked
    return newest


def _entry_size(path: Path) -> int:
    if path.is_dir() and not path.is_symlink():
        total = 0
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.lstat(os.path.join(root, name)).st_size
                except OSError:
                    continue
        return total
    return path.lstat().st_size


def sweep_abandoned_staging(
    folder: Path,
    *,
    prefix: str = ".",
    older_than_seconds: float = STAGING_ABANDONED_AFTER_SECONDS,
    now: float | None = None,
) -> int:
    """Remove the staging entries an interrupted writer left in `folder` (#1080).

    Returns how many were removed. **Never raises** — it runs at startup and before
    every automatic backup, and housekeeping must not stop either.

    🔴 **Only names a writer of this app stages under** (`is_staging_name`, further
    narrowed by `prefix`), and only once nothing in the entry has been written for
    `older_than_seconds`. The backup folder is the app's own; beside the database
    the caller narrows `prefix` to the restore's own staging name, because that
    folder can be anyone's (in development it is `backend/`).

    Each removal is logged by name and size.
    """
    try:
        if not folder.is_dir():
            return 0
        now = time.time() if now is None else now
        removed = 0
        for path in folder.iterdir():
            name = path.name
            if not name.startswith(prefix) or not is_staging_name(name):
                continue
            try:
                if now - _newest_mtime(path) < older_than_seconds:
                    continue  # possibly a writer that is still running
                size = _entry_size(path)
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            except OSError as e:
                logger.warning("Could not remove the abandoned staging entry %s: %s", name, e)
                continue
            removed += 1
            logger.info(
                "Removed %s (%.1f MB), left behind by a backup or restore that did not finish",
                name, size / 1e6,
            )
        return removed
    except Exception as e:  # never let housekeeping stop startup or a backup
        logger.warning("Could not sweep abandoned staging in %s: %s", folder, e)
        return 0


#: The fixed staging names a restore uses beside the data folder. The video keep
#: folder holds the ONLY copy of recordings a restore moved aside; the two stage
#: folders hold copies extracted from the backup being restored.
VIDEO_KEEP_DIR_NAME = ".video_keep_restore_tmp"
MEDIA_STAGE_DIR_NAME = ".media_restore_stage_tmp"
DOCS_STAGE_DIR_NAME = ".documents_restore_stage_tmp"


def _restore_db_staging_label(db_path: Path) -> str:
    return f"{db_path.name}.restore"


#: The lock a restore holds from its first step to its last, beside the keep folder
#: (#1142). It is never deleted — removing a lock file lets two processes lock two
#: different files of the same name. It is not a staging name, so no sweep removes
#: it, and it sits outside `documents/` and `media/`, so no backup carries it.
RESTORE_LOCK_NAME = ".restore_in_progress.lock"

#: What `_restore_lock` found.
LOCK_HELD = "held"                # this process holds it
LOCK_TAKEN = "taken"              # another process does: a restore is running there
LOCK_UNSUPPORTED = "unsupported"  # no `flock` on this platform (Windows)
LOCK_FAILED = "failed"            # the lock file, or the lock, could not be had

#: The answer to a restore while another PROCESS is restoring the same data. Since
#: #1141 a second launch starts no second engine, so the way here is a restore still
#: finishing in the engine of an app that was closed while it ran — on macOS and Linux
#: the shell never force-stops it (#1142). Closing this app first matters: a restore
#: that finishes swaps the database out from under every engine but its own.
RESTORING_ELSEWHERE_MESSAGE = (
    "The restore did not start: a restore begun before Mixed Measures was last closed "
    "is still finishing in the background. Nothing was changed. Close Mixed Measures, "
    "wait a few minutes for that restore to finish, then open it again."
)


@contextmanager
def _restore_lock(data_parent: Path) -> Iterator[str]:
    """Hold the cross-process restore lock for a block, if it can be had (#1142).

    The restore gate (`services/restore_gate.py`) is per PROCESS. On macOS and Linux
    the shell never force-stops the backend after a quit (#1142), so a restore can
    outlive its app, and a relaunched backend then runs beside it on the same data
    folder. That backend's startup `recover_interrupted_restore` put the recordings
    the restore had just set aside back into `media/` moments before the restore tore
    `media/` down — the ONLY copy of each, gone (executed 2026-10-08; new in 1.5.6,
    whose #1080 added the startup re-seat). A second restore started there would
    re-seat the same keep folder and clear the running restore's fixed-name stage
    folders on entry. So a restore holds this lock throughout, and both refuse to
    touch either while another process holds it.

    🔴 **`flock`, never `fcntl.lockf` / `F_SETLK`.** A POSIX record lock belongs to the
    PROCESS and is dropped when ANY descriptor on the file is closed (#1044's
    mechanism), so any later code that opened and closed this file mid-restore would
    silently release it. A `flock` lock belongs to this open file description: it is
    released when this block closes it, or when the process dies — so a restore that
    was KILLED leaves no lock behind, and the next start still puts its recordings
    back (#1080's point).

    Yields `LOCK_HELD`, `LOCK_TAKEN`, `LOCK_UNSUPPORTED` (Windows has no `flock` and
    needs none: a quit there is `taskkill /F`, so no restore outlives its app) or
    `LOCK_FAILED` (the file or the lock could not be had — logged). Each caller
    decides what the last two mean for it. Raises nothing of its own.
    """
    if fcntl is None:
        yield LOCK_UNSUPPORTED
        return
    try:
        data_parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(data_parent / RESTORE_LOCK_NAME), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as e:
        logger.warning("Could not open the restore lock in %s: %s", data_parent, e)
        yield LOCK_FAILED
        return
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            state = LOCK_TAKEN
        except OSError as e:
            logger.warning("Could not take the restore lock in %s: %s", data_parent, e)
            state = LOCK_FAILED
        else:
            state = LOCK_HELD
        yield state
    finally:
        os.close(fd)  # releases the lock, when this block held it


def recover_interrupted_restore(db_path: Path, media_dir: Path) -> None:
    """At startup, put back what a restore that was STOPPED partway left aside (#1080).

    🔴 **The recordings first.** A restore moves the local video the backup does not
    carry into `.video_keep_restore_tmp` before it swaps the media folder, and only
    the next RESTORE put them back — so after a restore killed in that window the
    researcher's videos sat in a hidden folder and their conversations showed no
    recording until they happened to restore again. They are re-seated here on every
    start, by the same never-overwrite, never-delete routine (#550).

    🔴 **Only when no other process is restoring (#1142).** A restore that outlived
    its app still owns the keep folder and the staging: re-seated mid-restore, its
    recordings were deleted with `media/` a moment later. So this takes the restore
    lock first, and leaves everything while another process holds it — or when the
    lock cannot be had at all, the safe side, since the next restore re-seats on
    entry (1.5.5's behaviour). Windows has no lock to take and no restore that
    outlives its app, so there it runs as before.

    Then the restore's staged copy of a backup's database, beside the live one, once
    it is abandoned. ⚠️ The media and document stage folders are deliberately LEFT:
    after a stop between the media teardown and the install they hold the only
    unpacked copy of the backup's media, and the next restore clears them on entry.

    Never raises.
    """
    with _restore_lock(media_dir.parent) as lock:
        if lock == LOCK_TAKEN:
            logger.warning(
                "A restore is still running in another Mixed Measures process; the "
                "recordings it set aside and its staging are left to it"
            )
            return
        if lock == LOCK_FAILED:
            logger.warning(
                "Could not tell whether a restore is running elsewhere, so any recordings "
                "a stopped restore set aside are left for the next restore to put back"
            )
            return
        try:
            _reseat_keep_dir(media_dir.parent / VIDEO_KEEP_DIR_NAME, media_dir)
        except Exception as e:  # pragma: no cover - _reseat_keep_dir never raises
            logger.error("Could not re-seat recordings a stopped restore set aside: %s", e)
        sweep_abandoned_staging(
            db_path.parent if str(db_path.parent) else Path("."),
            prefix=f".{_restore_db_staging_label(db_path)}.",
        )


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
#:   ⚠️ **This budget is the LOCK WAIT only** (#1080). The snapshot and the ZIP come
#:   after it and were never inside it: 6.84 s for the whole on-quit backup of a
#:   205 MB database, at the old compression. `BACKUP_COMPRESS_LEVEL` is what makes
#:   the rest fit; a backup the kill still interrupts writes nothing a list can see,
#:   rotates nothing out, and leaves only staging the next start sweeps.
#:   (On Windows the shell's quit is `taskkill /F`, so no on-quit backup is taken
#:   there at all — the 4-hourly one is that platform's cover.)
BACKUP_BUSY_WAIT_SECONDS = 20.0
AUTO_BACKUP_BUSY_WAIT_SECONDS = 30.0
AUTO_BACKUP_BUSY_RETRY_SECONDS = 300.0
SHUTDOWN_BACKUP_BUSY_WAIT_SECONDS = 3.0

#: zlib level for the database and documents in every `.mmbackup` (#1080). Level 1,
#: not the default 6: MEASURED 2026-10-04 on a backup-API copy of a 469 MB working
#: database, level 6 took 11.42 s for a 94 MB archive and level 1 took 4.11 s for
#: 101 MB — 2.8× faster for 7% more disk. Every backup holds something while it
#: compresses: the on-quit one races the shell's kill, and the 4-hourly one holds a
#: restore-gate slot, so a restore asked for meanwhile waits. Recordings are STORED
#: either way (already-compressed containers).
BACKUP_COMPRESS_LEVEL = 1


def _read_project_summaries(db_path: Path) -> list[ProjectBackupSummary] | None:
    """Read project summaries via a temporary raw (keyed-if-encrypted) connection.

    Returns ``None`` when the list could not be read — never ``[]`` (#1039 k).
    ⚠️ An empty list is a real answer (an install with no projects); a failure
    recorded as one made the restore preview show no *Projects* section at all,
    which reads as "this backup holds nothing", and hid the one warning sign a
    damaged or partly migrated snapshot gives at backup time. The caller records
    the failure on the manifest (`project_summaries_unavailable`).
    """
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
        logger.warning(
            "The backup's project list could not be read from %s; the backup is written "
            "without it and its manifest says so", db_path, exc_info=True,
        )
        return None
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
# ⚠️ `re.ASCII` and `\Z` (#1039 f): a plain `\d` also matches Arabic-Indic and other
# Unicode digits, and `$` matches BEFORE a trailing newline, so
# `auto_20260101_000000.mmbackup\n` was a well-formed name to this pattern.
_BACKUP_NAME_RE = re.compile(
    r"^(?P<type>" + "|".join(sorted((re.escape(t) for t in VALID_BACKUP_TYPES), key=len, reverse=True)) + r")"
    r"_(?P<date>\d{8})_(?P<time>\d{6})(?:-(?P<n>\d+))?\.mmbackup\Z",
    re.ASCII,
)


def parse_backup_name(filename: str) -> re.Match | None:
    """The match for a well-formed backup filename, or None. The ONE place a
    `.mmbackup` name is recognised, so the writer, the list and the resolver
    cannot disagree about what counts as one."""
    return _BACKUP_NAME_RE.match(filename)


def _taken_at(match: re.Match, path: Path) -> str:
    """When a backup was taken: the UTC stamp in its NAME (#1039 f).

    `BackupInfo.created_at` used to be the file's modification time, so after the
    backup folder was copied to another computer every row of Backup history said
    it was taken at the moment of the copy — while the ORDER of the rows already
    came from the name. The name is written in the same call as the file, and the
    restore's "Before a restore … from <time>" sentence states the same instant, so
    the two now agree to the second. The mtime is only the fallback for a name
    whose digits are not a real date.
    """
    try:
        stamp = datetime.strptime(match["date"] + match["time"], "%Y%m%d%H%M%S")
        return stamp.replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        return mtime.replace(microsecond=0).isoformat()


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
    # One instant for the name, the manifest and the returned `created_at`, so the
    # list, the preview and the restore's sentences all state the same time.
    taken_utc = datetime.now(timezone.utc).replace(microsecond=0)
    timestamp = taken_utc.strftime("%Y%m%d_%H%M%S")
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

    # Snapshot the DB to a staged file first, so the database is read only for the
    # copy and never for the ZIP write — complete, or refused before anything is
    # written.
    #
    # 🔴 **Everything this backup writes before it is complete lives in ONE hidden
    # staging folder INSIDE the backup folder (#1080)** — the snapshot and the ZIP
    # alike. The snapshot used to go to OS temp (#1044), where a writer killed
    # mid-backup (a Windows quit is `taskkill /F`; a SIGKILL runs no `finally`) left
    # a full copy of the database for good: 205 MB measured, keyed when the install
    # is encrypted but outside the folder the researcher chose. Here it is swept with
    # the rest (`sweep_abandoned_staging`), and the ZIP's move into place is a rename
    # on one filesystem.
    staging = _staging_dir(backup_dir, backup_filename)
    tmp_db = staging / "database.db"
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
            created_at=taken_utc.isoformat(),
            backup_type=backup_type,
            db_size_bytes=db_size,
            document_count=doc_count,
            media_file_count=media_count,
            video_excluded=not include_video,
            video_files_excluded=video_excluded_count,
            project_summaries=project_summaries or [],
            project_summaries_unavailable=project_summaries is None,
        )

        # Write the ZIP in staging, then rename it into place, so a file CARRYING A
        # BACKUP'S NAME is always complete.
        #
        # 🔴 The staging name must not end in `.mmbackup` (#971). It used to —
        # `mkstemp(suffix=".mmbackup", …)` — so an interrupted write left a
        # `tmpXXXXXXXX.mmbackup` that the old `glob("*.mmbackup")` listing
        # presented as a backup; one such orphan (88.1 MB, unreadable) was
        # measured on the developer's own machine. Inside a hidden `.partial`
        # folder nothing can mistake it for one, and `_BACKUP_NAME_RE` cannot
        # match the folder.
        tmp_zip = staging / "archive.zip.partial"
        with zipfile.ZipFile(
            tmp_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=BACKUP_COMPRESS_LEVEL
        ) as zf:
            zf.writestr("manifest.json", json.dumps(manifest.model_dump(), indent=2))
            zf.write(str(tmp_db), "database.db")
            for arcname, file_path in doc_files:
                zf.write(str(file_path), arcname)
            for arcname, file_path in media_files:
                # Recordings are already-compressed containers — deflate
                # wastes CPU for ~0 gain (video V1 slab 5).
                zf.write(str(file_path), arcname, compress_type=zipfile.ZIP_STORED)
        os.replace(tmp_zip, backup_path)

        size = backup_path.stat().st_size
        logger.info("Backup created: %s (%d bytes)", backup_filename, size)

        return BackupInfo(
            filename=backup_filename,
            created_at=manifest.created_at,
            size_bytes=size,
            backup_type=backup_type,
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _format_size(n: int) -> str:
    """Bytes in the words the Settings screen uses for sizes."""
    for unit, size in (("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if n >= size:
            return f"{n / size:.1f} {unit}"
    return f"{n} bytes"


def validate_backup(
    zip_path: Path,
    *,
    expansion_limit: int | None = MAX_ARCHIVE_EXPANDED_BYTES,
    free_bytes: int | None = None,
) -> RestorePreview:
    """Validate a .mmbackup ZIP and return a restore preview.

    Raises ValueError for invalid backups.

    `expansion_limit` (#1036 a): the zip-bomb cap on what the archive declares it
    unpacks to. It is for a file that arrived from OUTSIDE — an upload, already
    bounded at 500 MB on the wire. A backup in this app's own folder passes `None`:
    this app wrote it, `create_backup` has no ceiling, and the 20 GB cap refused
    exactly the backups that carry recordings — the full ones a researcher downloads
    before something risky, and the "Before a restore" copy a failed restore tells
    them to restore.

    `free_bytes`: the free space where a restore would unpack. When the archive
    declares more than that, the preview says so (a warning, never a refusal: the
    figure is the archive's own claim, and a restore that runs out stops before it
    replaces anything).
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
            # backup is taken and before anything is staged. Only for a file from
            # outside (#1036 a — see the docstring).
            if expansion_limit is not None:
                expanded = assert_expanded_size_within_limit(zf, limit=expansion_limit)
            else:
                expanded = sum(i.file_size for i in zf.infolist())

            manifest_data = json.loads(zf.read("manifest.json"))
            manifest = BackupManifest(**manifest_data)

            warnings: list[str] = []
            if free_bytes is not None and expanded > free_bytes:
                warnings.append(
                    f"Restoring this backup unpacks about {_format_size(expanded)}, and this "
                    f"computer has {_format_size(free_bytes)} free. A restore that runs out of "
                    "space stops before it replaces anything, so free some space first."
                )
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
            # Staged beside the archive, never in OS temp (#1080): it is a full copy
            # of the backup's database, and both doors keep the archive in the
            # backup folder, where an abandoned probe is swept.
            probe_dir = _staging_dir(zip_path.parent, "validate")
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
    *,
    expansion_limit: int | None = MAX_ARCHIVE_EXPANDED_BYTES,
) -> BackupInfo:
    """Restore from a .mmbackup ZIP.

    Creates a pre-restore safety backup first, then replaces the DB,
    documents, and media. Returns the pre-restore backup info.

    Failure-safety shape (#550): the WHOLE payload is extracted to staging
    before anything is mutated, and every stage is a SIBLING of what it replaces
    — the database beside the live database, the documents beside `docs_dir`,
    the media beside `media_dir` — so each install is a rename on one filesystem
    and nothing lands in OS temp, which is commonly size-capped tmpfs. An
    extraction failure aborts with nothing changed, and the destructive phase is
    renames/rmtrees only. Local video the backup doesn't carry is moved to a
    sibling keep-dir and re-seated via ``_reseat_keep_dir`` on success, on
    failure, on entry AND at startup (a crashed run's leftover keep-dir holds the
    only copy — it is re-seated, never deleted).

    Failures say WHICH side of the swap they are on: before it,
    ``RestoreNotStarted`` (nothing was changed, #1036 d); after it,
    ``RestoreError`` naming the pre-restore backup, so callers can point the user
    at recovery instead of a bare 500.

    🔴 **The whole restore holds `_restore_lock` (#1142).** The restore gate keeps a
    second restore out of THIS process; the lock keeps one out of another process on
    the same data — and keeps that process's startup re-seat away from this restore's
    keep folder. While another process holds it, this raises `RestoreRefused`
    (`"restoring_elsewhere"`, a 409 at the router) before reading anything. Where no
    lock can be had (Windows, or a filesystem that refuses one) the restore runs as
    it always did: refusing would make the disaster-recovery path depend on a lock.

    `expansion_limit`: see `validate_backup` — `None` for a backup in this app's
    own folder (#1036 a).
    """
    with _restore_lock(media_dir.parent) as lock:
        if lock == LOCK_TAKEN:
            raise RestoreRefused(RESTORING_ELSEWHERE_MESSAGE, "restoring_elsewhere")
        return _restore_holding_the_lock(
            zip_path, db_path, docs_dir, media_dir, backup_dir,
            expansion_limit=expansion_limit,
        )


def _restore_holding_the_lock(
    zip_path: Path,
    db_path: Path,
    docs_dir: Path,
    media_dir: Path,
    backup_dir: Path,
    *,
    expansion_limit: int | None,
) -> BackupInfo:
    """`restore_from_backup`'s body, run while the restore lock is held (or cannot be)."""
    # Validate first — which also refuses a backup this build cannot read (#1026).
    preview = validate_backup(zip_path, expansion_limit=expansion_limit)

    # Create pre-restore safety backup (includes media files).
    # Busy and missing keep their own meanings at the router; anything else here is
    # a backup that could not be WRITTEN, before the restore touched anything.
    try:
        pre_restore_info = create_backup(db_path, docs_dir, media_dir, backup_dir, "pre_restore")
    except (DatabaseBusyError, FileNotFoundError):
        raise
    except Exception as e:
        logger.error("Restore not started: the pre-restore backup failed: %s", e)
        cause = (
            "there is not enough free disk space"
            if isinstance(e, OSError) and e.errno == errno.ENOSPC
            else f"it could not be written ({e})"
        )
        raise RestoreNotStarted(
            "The restore did not start: the copy of your current data that a restore "
            f"saves first could not be made, because {cause}. Nothing was changed. "
            "Free some disk space, then try again."
        ) from e
    logger.info("Pre-restore backup created: %s", pre_restore_info.filename)

    media_dir.parent.mkdir(parents=True, exist_ok=True)
    docs_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp_video_keep = media_dir.parent / VIDEO_KEEP_DIR_NAME
    # A leftover keep-dir means a prior restore crashed after moving video
    # out — it may hold the ONLY copy of those recordings. Re-seat it before
    # doing anything else; NEVER delete it wholesale (#550: the old entry
    # rmtree here is what turned a failed restore + retry into data loss).
    _reseat_keep_dir(tmp_video_keep, media_dir)

    # Media and document staging: siblings of what they replace. A leftover stage
    # dir holds only COPIES extracted from some backup (unlike the keep-dir), so
    # clearing it on entry is safe.
    media_stage = media_dir.parent / MEDIA_STAGE_DIR_NAME
    docs_stage = docs_dir.parent / DOCS_STAGE_DIR_NAME
    for stage in (media_stage, docs_stage):
        if stage.exists():
            shutil.rmtree(str(stage), ignore_errors=True)

    # 🔴 The database stages BESIDE THE LIVE DATABASE (#1036 b), never in OS temp.
    # From OS temp, `shutil.move` was a rename only when temp shared the filesystem
    # AND the platform renamed over an existing file; on Windows `os.rename` refuses
    # an existing destination, so it fell back to a COPY over the live file — the
    # install's database rewritten in place, and a quit or a full disk partway left
    # it malformed. Beside it, the swap is `os.replace`: one atomic rename on every
    # platform. The migration that brings an older backup up to date (#1026) runs on
    # this staged file too, so its transient space is on the database's own disk.
    db_stage = _staging_dir(
        db_path.parent if str(db_path.parent) else Path("."),
        _restore_db_staging_label(db_path),
    )
    replacing = False
    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            # Zip-slip prevention during extraction (see validate_backup for why
            # this path is safe by virtue of `zf.extract`, and what would change
            # that). Re-run here rather than trusting validate_backup — restore is
            # reachable independently.
            for member in zf.namelist():
                if member.startswith("/") or ".." in member:
                    raise ValueError(f"Suspicious path in backup: {member}")

            # #696: re-check the expansion cap on the destructive path too, for a
            # file from outside. The staging design (#550) already makes an ENOSPC
            # abort cleanly with the install untouched — but "aborts cleanly after
            # filling the disk" is still exhaustion, and this refuses before
            # writing a byte.
            if expansion_limit is not None:
                assert_expanded_size_within_limit(zf, limit=expansion_limit)

            # ---- Staging phase: extract EVERYTHING before mutating anything.
            # An ENOSPC/IO failure here (the likeliest failure on a multi-GB
            # restore) aborts with the install untouched.

            # Extract the database and re-verify it decrypts + passes integrity on
            # the EXACT file we're about to install. validate_backup already probed
            # a separate extraction before the pre-restore backup (so a bad backup
            # is normally rejected before reaching here); this is defense-in-depth
            # against the file changing between the two steps.
            zf.extract("database.db", db_stage)
            staged_db = db_stage / "database.db"
            _assert_backup_db_readable(staged_db)
            # #1026: the file swapped in must be one this build's models can read.
            _bring_to_this_version(staged_db, preview.manifest.app_version)

            # Extract documents to their sibling staging dir
            doc_members = [m for m in zf.namelist() if m.startswith("documents/")]
            for member in doc_members:
                zf.extract(member, docs_stage)
            tmp_docs = docs_stage / "documents"

            # Extract media to the sibling staging dir
            media_members = [m for m in zf.namelist() if m.startswith("media/")]
            for member in media_members:
                zf.extract(member, media_stage)
            tmp_media = media_stage / "media"

        # ---- Destructive phase: renames and rmtrees only from here on.
        replacing = True

        # The old database's companion files go FIRST. Left beside the new file, a
        # `-wal` would be replayed into it on the next open — another database's
        # pages. None should exist (every connection was closed, and the last close
        # checkpoints and removes them), and what one held is in the pre-restore
        # backup, which reads through the WAL. Named by appending, never
        # `with_suffix`, which only worked for a database whose name ends `.db`.
        for side in _SQLITE_SIDE_FILES:
            Path(f"{db_path}{side}").unlink(missing_ok=True)

        # Replace the database: one atomic rename, on every platform (#1036 b).
        os.replace(staged_db, db_path)

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
            "Restore failed (%s): %s. Pre-restore backup: %s",
            "partway" if replacing else "before replacing anything",
            e, pre_restore_info.filename,
        )
        if isinstance(e, ValueError):
            raise  # validation-shaped errors keep their 400 semantics
        if not replacing:
            # #1036 d: a corrupt member or a full disk while UNPACKING used to be
            # reported as "failed partway … restore that backup" — an instruction to
            # undo a change that had not happened.
            cause = (
                "the disk ran out of space while the backup was being unpacked"
                if isinstance(e, OSError) and e.errno == errno.ENOSPC
                else f"the backup could not be unpacked ({e})"
            )
            raise RestoreNotStarted(
                f"The restore stopped before replacing anything: {cause}. Nothing was "
                "changed. The copy of your data it saved first is in Backup history as "
                "the latest “Before a restore” backup, and can be deleted if you do not "
                "need it.",
                pre_restore_info.filename,
            ) from e
        raise RestoreError(
            f"Restore failed partway ({e}). Your previous data was saved to "
            f"backup '{pre_restore_info.filename}' before the restore began.",
            pre_restore_info.filename,
        ) from e
    finally:
        # Restore historically did not clean up — a failed restore leaked the full
        # extracted payload into OS temp. Every stage holds only copies (the staged
        # database is gone once it is swapped in), so unconditional cleanup is safe.
        shutil.rmtree(db_stage, ignore_errors=True)
        shutil.rmtree(str(docs_stage), ignore_errors=True)
        shutil.rmtree(str(media_stage), ignore_errors=True)


def get_backup_status(
    backup_dir: Path,
    interval_hours: int | None = None,
    max_count: int | None = None,
) -> BackupStatus:
    """Get backup status summary.

    #357: when `interval_hours` is provided (auto-backup cadence), computes
    `next_backup_at = last_backup_at + interval_hours`. Manual "Backup now"
    actions advance `last_backup_at` (the file's mtime), so the next status
    query naturally reports a refreshed `next_backup_at` — no module-level
    state needed; the disk is the source of truth.

    #1043: both schedule values ride the status as given, so the Settings screen
    states THIS install's schedule — "every 4 hours, keeping 5" was written into
    its sentences, and `0` (automatic backups off) would have read as on.

    The lifespan loop's actual sleep schedule is independent of this
    calculation (it sleeps from process start), so after a manual backup
    the displayed `next_backup_at` may be slightly out of sync with when
    the loop actually wakes. The auto-loop just creates a new backup
    whenever it wakes, which is strictly safer than under-backing-up.
    """
    schedule = {"auto_backup_interval_hours": interval_hours, "auto_backup_max_count": max_count}
    if not backup_dir.exists():
        return BackupStatus(
            last_backup_at=None,
            backup_count=0,
            total_size_bytes=0,
            is_stale=True,
            next_backup_at=None,
            **schedule,
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
            **schedule,
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
        **schedule,
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
            taken_at = _taken_at(match, b)
        except OSError:
            continue  # removed between the directory read and the stat

        result.append(BackupInfo(
            filename=b.name,
            created_at=taken_at,
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
