import api from './client'
import { downloadFromApi } from './download'

export interface ProjectBackupSummary {
  name: string
  conversation_count: number
  dataset_count: number
  document_count: number
  /** Observations track (v1.3.0). Backups written before v1.3.0 carry no such
   * key, but the backend model defaults it to 0, so the wire always has it. */
  observation_count: number
}

export interface BackupManifest {
  format_version: number
  app_version: string
  created_at: string
  backup_type: string
  db_size_bytes: number
  document_count: number
  /** Recordings in the ZIP (audio + any included video). */
  media_file_count: number
  /** #551: video recordings were excluded when this backup was created (the
   * periodic auto-backup policy) — the restore preview and post-restore toast
   * must SAY so, or a cross-machine restore reads as a codec failure. */
  video_excluded: boolean
  video_files_excluded: number
  project_summaries: ProjectBackupSummary[]
}

export interface BackupStatus {
  last_backup_at: string | null
  backup_count: number
  total_size_bytes: number
  is_stale: boolean
  /** #357: ISO timestamp of when the next automatic backup is expected to run
   * (computed as last_backup_at + interval). Null when no backups exist yet.
   * Used by TopRail freshness label + Settings page countdown. */
  next_backup_at: string | null
}

export interface BackupInfo {
  filename: string
  created_at: string
  size_bytes: number
  backup_type: string
}

export interface RestorePreview {
  manifest: BackupManifest
  warnings: string[]
}

/** Which in-place import a safety copy precedes. `merge_or_overwrite` is a copy
 * written before 1.5.2, when a merge's copy was also named for an overwrite. */
export type SafetyCopyAct = 'merge' | 'overwrite' | 'merge_or_overwrite'

/** #919: a full copy of a project, taken before a merge or an overwrite. A
 * `.mmproject`, so it comes back through Import — never through Restore. */
export interface SafetyCopyInfo {
  filename: string
  act: SafetyCopyAct
  /** ISO 8601 with an explicit UTC offset. */
  taken_at: string
  size_bytes: number
  /** From the copy's own manifest; null when the file cannot be read. */
  project_name: string | null
  /** Whether a project with this copy's identity is in the app now. `false` is
   * the case to warn about: the file may be that project's only copy. `null`
   * when the copy's identity cannot be read. */
  project_in_app: boolean | null
  /** False when the archive cannot be read — it may be damaged. */
  readable: boolean
}

export const backupApi = {
  status: () =>
    api.get<BackupStatus>('/backup/status').then(r => r.data),

  list: () =>
    api.get<BackupInfo[]>('/backup/list').then(r => r.data),

  /** Manual download backup. includeVideo=false for a lighter archive —
   * the auto rotation is always video-less (slab 5 policy). */
  create: (includeVideo: boolean = true) =>
    api.post('/backup/create', null, {
      params: { include_video: includeVideo },
      responseType: 'blob',
      timeout: 300_000,
    })
      .then(r => ({
        blob: r.data as Blob,
        filename: (r.headers['content-disposition']?.match(/filename="?([^"]+)"?/)?.[1])
          || `mixedmeasures_backup.mmbackup`,
      })),

  /** #357: trigger an auto-prefix snapshot without download. Counts toward
   * the same 5-backup auto rotation. Returns the refreshed BackupStatus so
   * the UI can re-render without waiting for the polling tick. */
  now: () =>
    api.post<BackupStatus>('/backup/now', null, { timeout: 120_000 }).then(r => r.data),

  validate: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post<RestorePreview>('/backup/validate', fd, {
      timeout: 120_000,
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  restore: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post<{ status: string; pre_restore_backup: string }>('/backup/restore', fd, {
      timeout: 300_000,
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  /** #919: every safety copy in the backup folder, newest first. */
  listSafetyCopies: () =>
    api.get<SafetyCopyInfo[]>('/backup/safety-copies').then(r => r.data),

  /** Save a safety copy to the researcher's downloads so it can be imported.
   * Goes through `downloadFromApi` — it carries the export budget, uses the
   * server's filename, and reports its own failure (it never rejects). */
  downloadSafetyCopy: (filename: string) =>
    downloadFromApi(
      `/backup/safety-copies/${encodeURIComponent(filename)}`,
      filename,
      { label: 'The safety copy download' },
    ),

  deleteSafetyCopy: (filename: string) =>
    api.delete(`/backup/safety-copies/${encodeURIComponent(filename)}`).then(() => undefined),
}
