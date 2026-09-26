from typing import Literal

from pydantic import BaseModel


class ProjectBackupSummary(BaseModel):
    name: str
    conversation_count: int
    dataset_count: int
    document_count: int
    # Observations track (v1.3.0). The default is LOAD-BEARING, not tidiness:
    # `validate_backup` parses a stored `manifest.json` straight into this model
    # (`BackupManifest(**manifest_data)`), so a pre-1.3.0 backup carries no such
    # key and a required field would make every existing backup fail validation
    # — i.e. unrestorable. 0 is also semantically TRUE for those backups: the
    # entity did not exist when they were written. Same reasoning as
    # `media_file_count` / `video_excluded` below.
    observation_count: int = 0


class BackupManifest(BaseModel):
    format_version: int
    app_version: str
    created_at: str
    backup_type: str
    db_size_bytes: int
    document_count: int
    media_file_count: int = 0
    # Video V1 slab 5: periodic auto-backups exclude video recordings (the
    # 4h × 5-rotation would multiply multi-GB projects onto the researcher's
    # disk). Defaults keep pre-video backups parsing unchanged.
    video_excluded: bool = False
    video_files_excluded: int = 0
    project_summaries: list[ProjectBackupSummary]


class BackupStatus(BaseModel):
    last_backup_at: str | None
    backup_count: int
    total_size_bytes: int
    is_stale: bool
    # #357: when the next automatic backup is expected to run. Computed as
    # `last_backup_at + auto_backup_interval_hours` — the value the auto-loop
    # would target. Null when no backups exist yet. Used by the TopRail
    # freshness label + Settings backup section to give researchers a
    # countdown ("Next auto at 4:30 PM") instead of an opaque amber dot.
    next_backup_at: str | None = None


class BackupInfo(BaseModel):
    filename: str
    created_at: str
    size_bytes: int
    backup_type: str


class SafetyCopyInfo(BaseModel):
    """A copy of a project taken before a merge or an overwrite (#919).

    It is a `.mmproject`, not a `.mmbackup`: it comes back through Import, never
    through Restore, which is why it has its own list rather than a row in
    `BackupInfo`'s.
    """
    filename: str
    # Which in-place import the copy precedes. `merge_or_overwrite` is an older
    # build's `pre-overwrite` file, which before 1.5.2 also named a merge's copy.
    act: Literal["merge", "overwrite", "merge_or_overwrite"]
    taken_at: str  # ISO 8601 with an explicit UTC offset (#408)
    size_bytes: int
    # From the copy's own manifest, never looked up by id: a project id can be
    # reused, and the project may no longer exist. None when unreadable.
    project_name: str | None
    # Whether a project with this copy's identity is in the app now. None when
    # the copy's identity cannot be read. False is the case to warn about: the
    # file may be the only copy of that project anywhere.
    project_in_app: bool | None
    # False when the archive or its manifest cannot be read — such a copy is
    # still listed, because it still takes disk space, and it may be damaged.
    readable: bool


class SafetyCopyPageResponse(BaseModel):
    """A bounded page of safety copies plus the totals over all of them (#978).

    The totals are NOT `len(copies)` / their summed sizes: the disclosure states
    the count and the disk cost before it is opened, and that summary must stay
    true when the page below it is shorter than the folder.
    """
    copies: list[SafetyCopyInfo]
    total_count: int
    total_bytes: int
    # True when the folder holds more than this page. The client renders a way to
    # ask for the rest rather than silently showing a prefix.
    truncated: bool


class RestorePreview(BaseModel):
    manifest: BackupManifest
    warnings: list[str]
