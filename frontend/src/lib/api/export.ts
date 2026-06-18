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
  summaries?: boolean
  audit?: boolean
}

// API functions - Export
export const exportApi = {
  excel: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/excel`, 'export.xlsx'),
  excelWithOptions: (projectId: number, options: ExportOptions) => {
    const params = new URLSearchParams()
    Object.entries(options).forEach(([key, value]) => {
      params.append(`include_${key}`, String(value))
    })
    return downloadFromApi(`/projects/${projectId}/export/excel?${params}`, 'export.xlsx')
  },
  csv: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/csv`, 'export.csv'),
  datasetsExcel: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/datasets-excel`, 'datasets.xlsx'),
  codebook: (projectId: number) =>
    api.get(`/projects/${projectId}/export/codebook`).then(res => res.data),
  codeFrequencies: (projectId: number, params?: CodeAnalysisFilterParams) => {
    const searchParams = new URLSearchParams()
    if (params?.code_ids) searchParams.append('code_ids', params.code_ids)
    if (params?.exclude_facilitator !== undefined) searchParams.append('exclude_facilitator', String(params.exclude_facilitator))
    if (params?.conversation_ids) searchParams.append('conversation_ids', params.conversation_ids)
    if (params?.participant_ids) searchParams.append('participant_ids', params.participant_ids)
    if (params?.source) searchParams.append('source', params.source)
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
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${projectId}/export/code-cooccurrence${qs ? '?' + qs : ''}`, 'code-cooccurrence.csv')
  },
  rData: async (projectId: number) => {
    const response = await api.get(`/projects/${projectId}/export/r-data`, {
      responseType: 'blob',
    })
    return response.data as Blob
  },
  sourceFrequenciesCsv: (projectId: number, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    return downloadFromApi(`/projects/${projectId}/code-analysis/source-frequencies/csv${qs ? '?' + qs : ''}`, 'source-frequencies.csv')
  },
  demographicComparisonCsv: (projectId: number, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    return downloadFromApi(`/projects/${projectId}/code-analysis/demographic-comparison/csv${qs ? '?' + qs : ''}`, 'demographic-comparison.csv')
  },
}
