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
  /** Every FILE under `documents/` — each document's extracted images included — so
   * not a count of documents (#1160: "Documents 69" sat over projects totalling 4).
   * The per-project `document_count`s are the documents. Not shown in the preview. */
  document_count: number
  /** Every FILE under `media/` — recordings, but also canvas images and any upload
   * still in flight when the backup was taken — so NOT a count of recordings
   * (#1160). `RestorePreview.recording_count` is. Older builds read it as written,
   * which is why its meaning stays. */
  media_file_count: number
  /** #551: video recordings were excluded when this backup was created (the
   * periodic auto-backup policy) — the restore preview and post-restore toast
   * must SAY so, or a cross-machine restore reads as a codec failure. */
  video_excluded: boolean
  video_files_excluded: number
  project_summaries: ProjectBackupSummary[]
  /** #1039 (k): the project list could not be read when the backup was made, so
   * `project_summaries` is empty for THAT reason. The server always sends it
   * (older manifests default to false), so an empty list with this false is
   * never read as "no projects" either — an older backup's failure looks the same. */
  project_summaries_unavailable: boolean
}

export interface BackupStatus {
  last_backup_at: string | null
  backup_count: number
  total_size_bytes: number
  is_stale: boolean
  /** #357: ISO timestamp of when the next automatic backup will be taken — #1186:
   * the server's own schedule (the newest automatic backup + the interval, never in
   * the past). Null only when automatic backups are off. Used by the TopRail
   * freshness label + Settings page countdown. */
  next_backup_at: string | null
  /** #1043: THIS install's automatic schedule, so the Settings sentences state it
   * rather than assume the defaults. `0` hours = automatic backups are OFF. Null
   * only from a server that predates the field. */
  auto_backup_interval_hours: number | null
  auto_backup_max_count: number | null
}

export interface BackupInfo {
  filename: string
  created_at: string
  size_bytes: number
  backup_type: string
}

/** #971: the largest backup that can be sent from another computer. A backup THIS
 * copy made is restored in place and is not bounded by it — which is the defect:
 * creation has no cap, so an instance could write archives it could not read back.
 * Mirrors `routers/backup.py::MAX_UPLOAD_SIZE`; the client's copy exists so the
 * refusal arrives before half a gigabyte crosses the wire, never as the authority. */
export const MAX_BACKUP_UPLOAD_BYTES = 500 * 1024 * 1024

export interface RestorePreview {
  manifest: BackupManifest
  warnings: string[]
  /** #1160: the recordings the archive carries, counted by the server from its
   * members at preview (`media/{project}/{owner}/original.*`) — true for every
   * backup ever written, where the manifest's `media_file_count` counts files. */
  recording_count: number
}

/**
 * #1140 — which side of the database swap a failed restore stopped on.
 *
 * - `not-started` — nothing was changed: the backup did not read, it was gone,
 *   another program held the database, the disk was full. A second press is safe
 *   and the session is the one the database knows, so the page need not be held.
 * - `partway` — the data was replaced in part; the way back is the "Before a
 *   restore" backup, whose time rides `preRestoreTakenAt` when the server knew it.
 * - `unknown` — no header (an unanticipated 500, a 503, no answer at all), read as
 *   `partway` by every caller: the cautious side, since a restore may have begun.
 */
export type RestoreFailureSide = 'not-started' | 'partway' | 'unknown'

/**
 * The ONE reader of a restore failure's outcome headers (`routers/backup.py`'s
 * `X-MM-Restore-Outcome` and `X-MM-Pre-Restore-Taken-At`). Duck-typed like
 * `serverDetailMessage`. The names are LOWER-case because `client.ts` builds
 * `response.headers` by iterating a `Headers`, which yields lower-case names (the
 * Fetch spec); a request that never answered has no headers and reads `unknown`.
 */
export function restoreFailureOutcome(err: unknown): {
  side: RestoreFailureSide
  preRestoreTakenAt: string | null
} {
  const headers = (err as { response?: { headers?: Record<string, string> } } | null)
    ?.response?.headers
  const outcome = headers?.['x-mm-restore-outcome']
  if (outcome === 'not-started') return { side: 'not-started', preRestoreTakenAt: null }
  if (outcome === 'partway') {
    return { side: 'partway', preRestoreTakenAt: headers?.['x-mm-pre-restore-taken-at'] ?? null }
  }
  return { side: 'unknown', preRestoreTakenAt: null }
}

/** What a finished restore reports: the backup of the data it replaced, which is
 * the way back if the wrong backup was restored. */
export interface RestoreResult {
  status: string
  pre_restore_backup: string
  /** ISO 8601 with an explicit UTC offset. */
  pre_restore_taken_at: string
}

/** Which in-place import a safety copy precedes. `merge_or_overwrite` is a copy
 * written before 1.5.2, when a merge's copy was also named for an overwrite. */
export type SafetyCopyAct = 'merge' | 'overwrite' | 'merge_or_overwrite'

/** #978: a bounded page of safety copies with the totals over ALL of them.
 *
 * 🔴 The totals are NOT derivable from `copies`. The disclosure's label announces
 * the count and the disk cost before the list is opened — stating the cost before
 * it is paid is the good half of #919 — so a shorter page must not make that
 * summary false. Measured before the bound: 1,954 rows, 3,941 tab stops, and 1.37 s
 * spent opening every archive on each Settings mount. */
export interface SafetyCopyPage {
  copies: SafetyCopyInfo[]
  total_count: number
  total_bytes: number
  /** The folder holds more than this page. */
  truncated: boolean
}

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
   * the same automatic rotation (`MM_AUTO_BACKUP_MAX_COUNT`, 5 by default), and
   * postpones the next automatic backup by an interval (#1186). Returns the refreshed
   * BackupStatus so the UI can re-render without waiting for the polling tick. */
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

  /** ⚠️ NO timeout on either restore door (#1024). Giving up on the request does
   * not stop the restore — the server carries on and swaps the files — so a
   * timeout only made the screen say "failed" about a restore still running, and
   * invited a second one. The server answers when the restore ends, and the
   * backend is on loopback: if it dies, the request fails at once, not never. */
  restore: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post<RestoreResult>('/backup/restore', fd, {
      timeout: 0,
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  /** #971: preview a backup already in the backup folder, without uploading it.
   * Required beside `restoreLocal`, not a convenience — a restore is confirmed
   * from its preview, so a preview that still needed an upload would meet the
   * same 500 MB wall one step earlier. Blocking on the server (it extracts the
   * database and runs an integrity check), hence the wide budget. */
  validateLocal: (filename: string) =>
    api.post<RestorePreview>(`/backup/archives/${encodeURIComponent(filename)}/validate`, null, {
      timeout: 120_000,
    }).then(r => r.data),

  /** #971: restore from a backup already in the backup folder. Nothing crosses
   * the wire and nothing is copied, so no size limit applies — and, like
   * `restore`, no timeout. */
  restoreLocal: (filename: string) =>
    api.post<RestoreResult>(
      `/backup/archives/${encodeURIComponent(filename)}/restore`, null, { timeout: 0 },
    ).then(r => r.data),

  /** Save an existing backup to the researcher's downloads — the only way to get
   * one onto another machine, since the folder is not reachable from the app. */
  downloadArchive: (filename: string) =>
    downloadFromApi(
      `/backup/archives/${encodeURIComponent(filename)}`,
      filename,
      { label: 'The backup download' },
    ),

  /** Only the `auto` and `shutdown` rotations delete anything on their own, so
   * without this the folder can only grow. */
  deleteArchive: (filename: string) =>
    api.delete(`/backup/archives/${encodeURIComponent(filename)}`).then(() => undefined),

  /** #919/#978: the newest safety copies, with the totals over the whole folder. */
  listSafetyCopies: (limit?: number) =>
    api.get<SafetyCopyPage>('/backup/safety-copies', {
      params: limit === undefined ? undefined : { limit },
    }).then(r => r.data),

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
