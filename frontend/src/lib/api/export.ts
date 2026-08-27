import api from './client'
import { downloadFromApi } from './download'
import type { CodeAnalysisFilterParams } from './code-analysis'

// Export options type
export interface ExportOptions {
  coded_data?: boolean
  matrix?: boolean
  cooccurrence?: boolean
  codebook?: boolean
  memos?: boolean
  notes?: boolean
  quotes?: boolean
  summaries?: boolean
  audit?: boolean
}

// API functions - Export
export const exportApi = {
  excel: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/excel`, 'export.xlsx', {
      label: 'The Excel export',
    }),
  excelWithOptions: (projectId: number, options: ExportOptions) => {
    const params = new URLSearchParams()
    Object.entries(options).forEach(([key, value]) => {
      params.append(`include_${key}`, String(value))
    })
    return downloadFromApi(`/projects/${projectId}/export/excel?${params}`, 'export.xlsx', {
      label: 'The Excel export',
    })
  },
  csv: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/csv`, 'export.csv', {
      label: 'The CSV export',
    }),
  datasetsExcel: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/datasets-excel`, 'datasets.xlsx', {
      label: 'The datasets Excel export',
    }),
  codebook: (projectId: number) =>
    api.get(`/projects/${projectId}/export/codebook`).then(res => res.data),
  codeFrequencies: (projectId: number, params?: CodeAnalysisFilterParams) => {
    const searchParams = new URLSearchParams()
    if (params?.code_ids) searchParams.append('code_ids', params.code_ids)
    if (params?.exclude_facilitator !== undefined) searchParams.append('exclude_facilitator', String(params.exclude_facilitator))
    if (params?.conversation_ids) searchParams.append('conversation_ids', params.conversation_ids)
    if (params?.participant_ids) searchParams.append('participant_ids', params.participant_ids)
    if (params?.source) searchParams.append('source', params.source)
    // #499: carry the active coder/layer/document/observation scope — the CSV
    // must show the numbers on screen, not a silently-unfiltered variant.
    if (params?.document_ids) searchParams.append('document_ids', params.document_ids)
    if (params?.observation_ids) searchParams.append('observation_ids', params.observation_ids)
    if (params?.coder_ids) searchParams.append('coder_ids', params.coder_ids)
    if (params?.layer_scope) searchParams.append('layer_scope', params.layer_scope)
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${projectId}/export/code-frequencies${qs ? '?' + qs : ''}`, 'code-frequencies.csv')
  },
  codedSegments: (projectId: number, params?: CodeAnalysisFilterParams) => {
    const searchParams = new URLSearchParams()
    if (params?.code_ids) searchParams.append('code_ids', params.code_ids)
    if (params?.exclude_facilitator !== undefined) searchParams.append('exclude_facilitator', String(params.exclude_facilitator))
    if (params?.conversation_ids) searchParams.append('conversation_ids', params.conversation_ids)
    if (params?.participant_ids) searchParams.append('participant_ids', params.participant_ids)
    if (params?.source) searchParams.append('source', params.source)
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${projectId}/export/coded-segments${qs ? '?' + qs : ''}`, 'coded-segments.csv')
  },
  codeCooccurrence: (projectId: number, params?: CodeAnalysisFilterParams) => {
    const searchParams = new URLSearchParams()
    if (params?.code_ids) searchParams.append('code_ids', params.code_ids)
    if (params?.exclude_facilitator !== undefined) searchParams.append('exclude_facilitator', String(params.exclude_facilitator))
    if (params?.conversation_ids) searchParams.append('conversation_ids', params.conversation_ids)
    if (params?.participant_ids) searchParams.append('participant_ids', params.participant_ids)
    if (params?.source) searchParams.append('source', params.source)
    // #512 (the #499 sibling): carry the active coder/layer/document/observation
    // scope — the CSV must show the matrix on screen, not a silently-unfiltered variant.
    if (params?.document_ids) searchParams.append('document_ids', params.document_ids)
    if (params?.observation_ids) searchParams.append('observation_ids', params.observation_ids)
    if (params?.coder_ids) searchParams.append('coder_ids', params.coder_ids)
    if (params?.layer_scope) searchParams.append('layer_scope', params.layer_scope)
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${projectId}/export/code-cooccurrence${qs ? '?' + qs : ''}`, 'code-cooccurrence.csv')
  },
  /**
   * #820 — the R export is a download like every other one.
   *
   * It used to be the only export that called `api.get` directly, which cost it
   * three things at once: the API client's **30 s** default (the server takes
   * 85.6 s on a real survey), the app's toast system (the caller met the
   * failure with a native `window.alert`), and the server's own filename — the
   * caller invented `r_data_export.zip`, the anti-pattern `namedBlob`'s
   * docstring describes (#743).
   */
  rData: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/r-data`, 'r_data_export.zip', {
      label: 'The R data export',
    }),
  sourceFrequenciesCsv: (projectId: number, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    return downloadFromApi(`/projects/${projectId}/code-analysis/source-frequencies/csv${qs ? '?' + qs : ''}`, 'source-frequencies.csv')
  },
  demographicComparisonCsv: (projectId: number, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    return downloadFromApi(`/projects/${projectId}/code-analysis/demographic-comparison/csv${qs ? '?' + qs : ''}`, 'demographic-comparison.csv')
  },
}
