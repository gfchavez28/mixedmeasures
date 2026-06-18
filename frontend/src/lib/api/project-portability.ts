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
}

export interface ImportValidationResult {
  manifest: ProjectExportManifest
  warnings: string[]
}

export interface ProjectImportResult {
  project_id: number
  project_name: string
}

export interface CodebookImportResult {
  categories_created: number
  categories_skipped: number
  codes_created: number
  codes_skipped: number
  codes_uncategorized: number
}

// ── API ────────────────────────────────────────────────────────────────

export const projectPortabilityApi = {
  /** Export a project as .mmproject (triggers browser download). */
  exportProject: async (projectId: number) => {
    const res = await api.get(`/projects/${projectId}/export-project`, {
      responseType: 'blob',
      timeout: 120_000,
    })
    const filename = extractFilename(res.headers, `project_export.mmproject`)
    downloadBlob(res.data as Blob, filename)
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

  /** Import an .mmproject file, creating a new project. */
  importProject: async (file: File): Promise<ProjectImportResult> => {
    const fd = new FormData()
    fd.append('file', file)
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
