import api from './client'
import { downloadBlob, extractFilename } from './download'

// ── Types ──────────────────────────────────────────────────────────────

export interface ProjectSummary {
  conversation_count: number
  dataset_count: number
  document_count: number
  code_count: number
  category_count: number
  memo_count: number
  participant_count: number
  excerpt_count: number
}

export interface ProjectExportManifest {
  format_version: number
  format_type: string
  app_version: string
  created_at: string
  project_name: string
  project_summary: ProjectSummary
  /** Track J · J3-1: stable identity; null on files exported before J3-1. */
  project_uuid: string | null
}

/** Track J · J3-1: a local project that shares the incoming file's project_uuid. */
export interface ExistingProjectInfo {
  id: number
  name: string
}

/** Track J · J3-2: a local roster coder an incoming coder could map onto. */
export interface MergeCoderMatch {
  id: number
  username: string
  archived: boolean
  local_app_count: number
}

/** Track J · J3-2: one coder in an incoming merge file + its local match candidate. */
export interface MergeCoderPreview {
  original_id: number
  username: string
  coder_type: string
  archived: boolean
  file_app_count: number
  local_match: MergeCoderMatch | null
}

/** Track J · J3-2b: a local code a divergent file code could collapse onto / link with.
 * `similarity` is NAME character similarity (0–1), NOT coding overlap; `confident` = ≥0.70. */
export interface MergeCodeCandidate {
  code_id: number
  name: string
  description: string | null
  usage: number
  similarity: number
  confident: boolean
}

/** Track J · J3-2b: a code in the file that isn't in your codebook (divergent), with
 * file-side usage + ranked local candidates so the UI can reconcile it. */
export interface MergeCodePreview {
  uuid: string
  name: string
  description: string | null
  color: string | null
  category_name: string | null
  file_app_count: number
  candidates: MergeCodeCandidate[]
}

export interface ImportValidationResult {
  manifest: ProjectExportManifest
  warnings: string[]
  /** Track J · J3-1: set when a local copy already exists → offer overwrite vs new vs merge. */
  existing_project: ExistingProjectInfo | null
  /** Track J · J3-2: the file's coders + local match candidates (set only when a merge is possible). */
  merge_coders: MergeCoderPreview[] | null
  /** Track J · J3-2b: divergent codes (uuid not local) + ranked reconcile candidates.
   * `[]` when the codebook is shared-frozen; null when no merge is possible. */
  merge_codes_preview: MergeCodePreview[] | null
}

/** Track J · J3-1/J3-2 import mode: new project, overwrite a copy, or merge codings in. */
export type ProjectImportMode = 'new' | 'overwrite' | 'merge'

/** Track J · J3-2: one coder-mapping decision (keyed by the file coder's original_id). */
export type CoderMappingDecision =
  | { action: 'match'; target_user_id: number; unarchive?: boolean }
  | { action: 'create'; new_username?: string }

export type CoderMapping = Record<string, CoderMappingDecision>

/** Track J · J3-2b: how a divergent code reconciles (keyed by the file code's uuid).
 * `collapse` = re-point its codings onto a local code (no new code); `link` = keep it +
 * group it with a local code (one effective code for stats); `new` = add it standalone. */
export type CodeMappingDecision =
  | { action: 'collapse'; target_code_id: number }
  | { action: 'link'; target_code_id: number; combined_label?: string }
  | { action: 'new' }

export type CodeMapping = Record<string, CodeMappingDecision>

/** Track J · J3-2: what a merge did (returned on import_mode='merge'). */
export interface MergeReport {
  sources_matched: number
  applications_added: number
  duplicates_skipped: number
  coders_created: number
  coders_matched: number
  /** Track J · J3-2b: divergent-code reconciliation outcomes. */
  codes_collapsed: number
  codes_linked: number
  codes_created: number
}

/** Track J · J3-2c: structured 409 body when a merge is refused for divergence. */
export interface MergeDivergenceDetail {
  error: 'merge_divergence'
  kind: 'segmentation' | 'codebook'
  diverged_sources?: { name: string; file_segments: number; local_segments: number }[]
  diverged_codes?: string[]
}

export interface ProjectImportResult {
  project_id: number
  project_name: string
  /** Track J · J3-2: populated only for import_mode='merge'. */
  merge_report: MergeReport | null
}

export interface CodebookImportResult {
  categories_created: number
  categories_skipped: number
  codes_created: number
  codes_skipped: number
  codes_uncategorized: number
}

// ── API ────────────────────────────────────────────────────────────────

/** Export-dialog include-media default (slab 5 / Q3 decision): media travels
 * by default up to this total; above it the toggle defaults OFF (the archive
 * would balloon) and the user opts in explicitly. */
export const EXPORT_MEDIA_DEFAULT_LIMIT_BYTES = 1024 * 1024 * 1024 // 1 GB

export function defaultIncludeMedia(mediaBytes: number | undefined): boolean {
  if (mediaBytes === undefined) return true // storage unknown → historical behavior
  return mediaBytes <= EXPORT_MEDIA_DEFAULT_LIMIT_BYTES
}

export const projectPortabilityApi = {
  /** Export a project as .mmproject (triggers browser download).
   * includeMedia=false produces a media-less archive — transcripts/coding/
   * documents travel, recordings are re-attachable after import (slab 5). */
  exportProject: async (projectId: number, includeMedia: boolean = true) => {
    const res = await api.get(`/projects/${projectId}/export-project`, {
      params: { include_media: includeMedia },
      responseType: 'blob',
      timeout: 300_000,
    })
    const filename = extractFilename(res.headers, `project_export.mmproject`)
    downloadBlob(res.data as Blob, filename)
  },

  /** Duplicate a project server-side (export → re-import as a new copy). #464 */
  duplicateProject: async (projectId: number): Promise<ProjectImportResult> => {
    const res = await api.post<ProjectImportResult>(`/projects/${projectId}/duplicate`, undefined, {
      timeout: 300_000,
    })
    return res.data
  },

  /** Validate an .mmproject file before import. */
  validateImport: async (file: File): Promise<ImportValidationResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await api.post<ImportValidationResult>('/projects/validate-import', fd, {
      timeout: 120_000,
    })
    return res.data
  },

  /**
   * Import an .mmproject file.
   * Track J · J3-1: `mode: 'overwrite'` + `targetProjectId` replaces an existing local
   * copy in place (preserving its stable identity); the default `'new'` creates a fresh
   * project. Track J · J3-2: `mode: 'merge'` + `targetProjectId` merges a colleague's
   * codings into the matching project, with an optional `coderMapping` (the D8 confirm
   * decisions). A divergent merge rejects with a 409 whose body is `MergeDivergenceDetail`.
   */
  importProject: async (
    file: File,
    opts?: {
      mode?: ProjectImportMode
      targetProjectId?: number
      coderMapping?: CoderMapping
      codeMapping?: CodeMapping
    },
  ): Promise<ProjectImportResult> => {
    const mode = opts?.mode ?? 'new'
    const fd = new FormData()
    fd.append('file', file)
    fd.append('import_mode', mode)
    if ((mode === 'overwrite' || mode === 'merge') && opts?.targetProjectId != null) {
      fd.append('target_project_id', String(opts.targetProjectId))
    }
    if (mode === 'merge' && opts?.coderMapping) {
      fd.append('coder_mapping', JSON.stringify(opts.coderMapping))
    }
    if (mode === 'merge' && opts?.codeMapping) {
      fd.append('code_mapping', JSON.stringify(opts.codeMapping))
    }
    const res = await api.post<ProjectImportResult>('/projects/import-project', fd, {
      timeout: 300_000,
    })
    return res.data
  },

  /** Export a project's codebook (triggers browser download). */
  exportCodebook: async (projectId: number, format: 'native' | 'qdc' = 'native') => {
    const res = await api.get(`/projects/${projectId}/export-codebook`, {
      params: { format },
      responseType: 'blob',
      timeout: 60_000,
    })
    const ext = format === 'qdc' ? 'qdc' : 'mmcodebook'
    const filename = extractFilename(res.headers, `codebook.${ext}`)
    downloadBlob(res.data as Blob, filename)
  },

  /** Import a codebook file (.mmcodebook or .qdc) into a project. */
  importCodebook: async (projectId: number, file: File): Promise<CodebookImportResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await api.post<CodebookImportResult>(
      `/projects/${projectId}/import-codebook`, fd, {
      timeout: 120_000,
    })
    return res.data
  },
}
