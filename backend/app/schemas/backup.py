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


class RestorePreview(BaseModel):
    manifest: BackupManifest
    warnings: list[str]
