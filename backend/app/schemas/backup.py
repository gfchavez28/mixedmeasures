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
    # #1039 (k): the project list could not be read when the backup was made, so
    # `project_summaries` is empty for that reason and not because the install
    # held no projects. Defaults to False so every older manifest parses — and an
    # older backup's silent failure cannot be told from a real empty install, so
    # the preview never claims "no projects" from an empty list either.
    # ⚠️ No MANIFEST_FORMAT_VERSION bump: `validate_backup` warns on ANY version
    # difference, so a bump would put a warning on every backup taken before it.
    project_summaries_unavailable: bool = False


class BackupStatus(BaseModel):
    last_backup_at: str | None
    backup_count: int
    total_size_bytes: int
    is_stale: bool
    # #357: when the next automatic backup will be taken. #1186: from
    # `services.backup.next_automatic_backup_at`, the function the auto-loop itself
    # sleeps by — the newest AUTOMATIC backup's taken time + the interval, never in
    # the past, and the loop's own wait while it settles. Null only when automatic
    # backups are off (it was null with no backups, and the newest of ANY type +
    # the interval otherwise, while the loop slept from launch). Used by the TopRail
    # freshness label + Settings backup section.
    next_backup_at: str | None = None
    # #1043: THIS install's automatic schedule, so the Settings screen states it
    # rather than writing "every 4 hours, keeping the 5 most recent" into its
    # sentences. `0` hours = automatic backups are OFF. None only where the
    # caller did not pass the settings (a direct service call).
    auto_backup_interval_hours: int | None = None
    auto_backup_max_count: int | None = None


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
    #: Recordings the archive carries, counted from its members at preview (#1160) —
    #: unlike `manifest.media_file_count`, which counts every file under `media/`.
    recording_count: int = 0
