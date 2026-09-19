"""The safety copies taken before an in-place import — how they are named, written,
listed and removed (#919).

A merge or an overwrite writes a full `.mmproject` of the target project into the
backup folder before it changes anything (`project_portability._safety_export_before_overwrite`).
Until #919 nothing listed those files, nothing rotated them, and the recovery
instruction ("import that file") named a file in a folder the app never shows — on
the desktop build it sits under the OS's per-user application data. This module is
the ONE place that knows what a safety copy is, so the writer and the list cannot
disagree about it.

🔴 **Nothing here deletes a copy on its own.** Rotation is deliberately undecided:
five `.mmbackup`s are five snapshots of ONE database, while five safety copies may be
five DIFFERENT projects, so a count- or age-based rule could delete the only copy of
a project someone removed. The researcher sees each copy and decides.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# The act a safety copy precedes. The writer REFUSES any other prefix, so a third
# in-place import has to be added here — which is what puts it in the list too.
SAFETY_COPY_PREFIXES = ("pre-merge", "pre-overwrite")

SAFETY_COPY_SUFFIX = ".mmproject"

# `{prefix}_{project_id}_{YYYYMMDD}_{HHMMSS}[-{n}].mmproject`. The `-n` tail exists
# only to keep two copies of one project taken in the same second from sharing a
# name (see `write_safety_copy`). Anchored, and no `/`, `\` or `..` can match, which
# is what makes a filename from a URL safe to join onto the backup folder.
_NAME_RE = re.compile(
    r"^(?P<prefix>" + "|".join(re.escape(p) for p in SAFETY_COPY_PREFIXES) + r")"
    r"_(?P<project_id>\d+)_(?P<date>\d{8})_(?P<time>\d{6})(?:-(?P<n>\d+))?"
    + re.escape(SAFETY_COPY_SUFFIX) + r"$"
)

# Until 1.5.2 a MERGE's copy was also named `pre-overwrite` (#919's sibling, fixed
# 2026-09-09), so an older build's `pre-overwrite` file may precede either act.
# Saying "before an overwrite" of a merge's copy repeats the contradiction the
# rename was made to remove.
_FIRST_VERSION_NAMING_MERGES = (1, 5, 2)

# A manifest is a few hundred bytes. Refuse to read a large one rather than let a
# damaged or hostile archive make the listing slow.
_MAX_MANIFEST_BYTES = 1024 * 1024

ACT_MERGE = "merge"
ACT_OVERWRITE = "overwrite"
ACT_MERGE_OR_OVERWRITE = "merge_or_overwrite"


class SafetyCopyNameError(ValueError):
    """A filename that is not a safety copy's. Distinct from `FileNotFoundError`,
    which is a well-formed name with no file behind it."""


@dataclass(frozen=True)
class SafetyCopy:
    filename: str
    act: str
    taken_at: str
    size_bytes: int
    project_name: str | None
    project_uuid: str | None
    readable: bool


def safety_copy_filename(prefix: str, project_id: int, now: datetime) -> str:
    """The name a new safety copy is written under. Refuses an unknown prefix."""
    if prefix not in SAFETY_COPY_PREFIXES:
        raise ValueError(
            f"Unknown safety copy prefix {prefix!r}; add it to SAFETY_COPY_PREFIXES "
            "so the Settings list can see the files it names."
        )
    ts = now.astimezone(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{project_id}_{ts}{SAFETY_COPY_SUFFIX}"


def write_safety_copy(backup_dir: Path, filename: str, payload: io.BytesIO) -> Path:
    """Write a safety copy so that a file carrying a safety copy's name is COMPLETE.

    The bytes go to a hidden `.partial` name first and are renamed into place only
    once they are all on disk. Written straight to the final name, a full disk or a
    crash mid-write left a truncated archive that the list would present as a
    recovery point. The partial name cannot match `_NAME_RE`, so the list never
    shows one, and it is removed if the write fails.

    ⚠️ **Never overwrites an existing copy.** Two copies of one project in the same
    second would otherwise share a name and the second would destroy the first —
    and the first is the older state, i.e. the one being protected. A `-2`, `-3`, …
    tail keeps both.
    """
    if not _NAME_RE.match(filename):
        raise SafetyCopyNameError(f"Not a safety copy filename: {filename!r}")
    backup_dir.mkdir(parents=True, exist_ok=True)

    stem = filename[: -len(SAFETY_COPY_SUFFIX)]
    final = backup_dir / filename
    n = 2
    while final.exists():
        final = backup_dir / f"{stem}-{n}{SAFETY_COPY_SUFFIX}"
        n += 1

    partial = backup_dir / f".{final.name}.partial"
    try:
        with open(partial, "wb") as fh:
            # getbuffer(), not getvalue(): the export already holds the whole
            # project in memory, recordings included, and getvalue() copies it.
            fh.write(payload.getbuffer())
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(partial, final)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return final


def _parse_version(value: object) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    m = re.match(r"^\s*v?(\d+)\.(\d+)\.(\d+)", value)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _read_manifest(path: Path) -> dict | None:
    """The copy's manifest, or None when it cannot be read. Never raises."""
    try:
        with zipfile.ZipFile(path) as zf:
            info = zf.getinfo("manifest.json")
            if info.file_size > _MAX_MANIFEST_BYTES:
                return None
            data = json.loads(zf.read(info))
        return data if isinstance(data, dict) else None
    except (OSError, zipfile.BadZipFile, KeyError, ValueError, RuntimeError):
        # ValueError covers JSONDecodeError and UnicodeDecodeError; RuntimeError is
        # what zipfile raises for an encrypted member.
        return None


def _act(prefix: str, manifest: dict | None) -> str:
    if prefix == "pre-merge":
        return ACT_MERGE
    version = _parse_version(manifest.get("app_version")) if manifest else None
    if version is not None and version >= _FIRST_VERSION_NAMING_MERGES:
        return ACT_OVERWRITE
    return ACT_MERGE_OR_OVERWRITE


def _taken_at(match: re.Match, path: Path) -> datetime:
    """When the copy was taken, in UTC. The NAME is the record — it is written in
    the same call as the file — and the modification time is only a fallback,
    because copying the folder elsewhere changes it."""
    try:
        stamp = datetime.strptime(match["date"] + match["time"], "%Y%m%d%H%M%S")
        return stamp.replace(tzinfo=timezone.utc)
    except ValueError:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        return mtime.replace(microsecond=0)


def list_safety_copies(backup_dir: Path) -> list[SafetyCopy]:
    """Every safety copy in the backup folder, newest first.

    A copy whose archive cannot be read is still LISTED (`readable=False`) — it
    takes disk space, and hiding it is the defect this list exists to fix.
    """
    if not backup_dir.is_dir():
        return []

    found: list[tuple[datetime, SafetyCopy]] = []
    for path in backup_dir.iterdir():
        match = _NAME_RE.match(path.name)
        if match is None:
            continue
        try:
            if not path.is_file():
                continue
            size = path.stat().st_size
            taken_at = _taken_at(match, path)
        except OSError:
            # Removed between the directory read and the stat.
            continue
        manifest = _read_manifest(path)
        name = manifest.get("project_name") if manifest else None
        uuid = manifest.get("project_uuid") if manifest else None
        found.append((taken_at, SafetyCopy(
            filename=path.name,
            act=_act(match["prefix"], manifest),
            taken_at=taken_at.isoformat(),
            size_bytes=size,
            project_name=name if isinstance(name, str) and name.strip() else None,
            project_uuid=uuid if isinstance(uuid, str) and uuid else None,
            readable=manifest is not None,
        )))
    found.sort(key=lambda pair: (pair[0], pair[1].filename), reverse=True)
    return [copy for _, copy in found]


def find_safety_copy(backup_dir: Path, filename: str) -> Path:
    """Resolve a filename from a request to a safety copy on disk.

    Raises `SafetyCopyNameError` for anything that is not a safety copy's name —
    including every `.mmbackup`, so this can never be used to reach the rotated
    database backups — and `FileNotFoundError` when no such copy exists.
    """
    if not _NAME_RE.match(filename):
        raise SafetyCopyNameError(f"Not a safety copy: {filename!r}")
    path = backup_dir / filename
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise FileNotFoundError(filename)
    if resolved.parent != backup_dir.resolve() or not resolved.is_file():
        raise FileNotFoundError(filename)
    return resolved
