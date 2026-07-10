import api from './client'

export interface ProjectBackupSummary {
  name: string
  conversation_count: number
  dataset_count: number
  document_count: number
}

export interface BackupManifest {
  format_version: number
  app_version: string
  created_at: string
  backup_type: string
  db_size_bytes: number
  document_count: number
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
}
