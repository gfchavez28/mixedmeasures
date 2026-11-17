import api from './client'
import { downloadFromApi } from './download'
import type { CodeAnalysisFilterParams } from './code-analysis'
import type { CodedSegmentsParams, QualCsvParams } from '@/lib/qual-comparison'

// Export options type
export interface ExportOptions {
  coded_data?: boolean
  matrix?: boolean
  cooccurrence?: boolean
  codebook?: boolean
  memos?: boolean
  notes?: boolean
  quotes?: boolean
  /**
   * The *Sources* sheet. 🔴 #1534 D109 (1.5.9): this key was `summaries` and sent
   * `include_summaries`, which the route stopped reading when #895 renamed the sheet
   * (v1.5.2) — unticking the box left the sheet in every workbook since. Each key here is
   * sent as `include_<key>`, so it must be the route's own name (`request-contract.test.ts`).
   */
  sources?: boolean
  audit?: boolean
}

/**
 * #1530 D98 (1.5.9) — a coder scope (`coder_ids`, comma-separated user ids) narrows a file to
 * those coders' coding; absent = every coder, the file exactly as before. The Export dialog
 * passes the viewer's own id while blind mode WITHHOLDS (`useBlindMode`), because blind mode is
 * client state and the server narrows only what a request asks it to.
 */
function withCoderScope(path: string, coderIds: string | undefined): string {
  if (!coderIds) return path
  return `${path}${path.includes('?') ? '&' : '?'}coder_ids=${encodeURIComponent(coderIds)}`
}

// API functions - Export
export const exportApi = {
  excel: (projectId: number) =>
    downloadFromApi(`/projects/${projectId}/export/excel`, 'export.xlsx', {
      label: 'The Excel export',
    }),
  excelWithOptions: (projectId: number, options: ExportOptions, coderIds?: string) => {
    const params = new URLSearchParams()
    Object.entries(options).forEach(([key, value]) => {
      params.append(`include_${key}`, String(value))
    })
    return downloadFromApi(withCoderScope(`/projects/${projectId}/export/excel?${params}`, coderIds), 'export.xlsx', {
      label: 'The Excel export',
    })
  },
  csv: (projectId: number, coderIds?: string) =>
    downloadFromApi(withCoderScope(`/projects/${projectId}/export/csv`, coderIds), 'export.csv', {
      label: 'The CSV export',
    }),
  /** #1608 — `coderIds` (sent while blind) leaves the participant table's rating columns out. */
  datasetsExcel: (projectId: number, coderIds?: string) =>
    downloadFromApi(`/projects/${projectId}/export/datasets-excel${coderIds ? `?coder_ids=${encodeURIComponent(coderIds)}` : ''}`, 'datasets.xlsx', {
      label: 'The datasets Excel export',
    }),
  codebook: (projectId: number) =>
    api.get(`/projects/${projectId}/export/codebook`).then(res => res.data),
  // #1528 D87 (1.5.9): no `codeFrequencies` — the Frequencies CSV is written in the browser
  // from the summary table's own read (`lib/code-frequencies-export.ts`); its server route is gone.
  /**
   * `params` from `lib/qual-comparison.ts::codedSegmentsFileRequest` (the analysis page) or a bare
   * coder scope (the Export dialog, which sends no source list: every passage).
   *
   * 🔴 #1535 D111 (1.5.9): a source list is sent whenever it is PRESENT — `''` is "none of this
   * kind" — and the document and clip lists are forwarded at all (they were dropped, so one
   * selected document exported every passage). `source` is no longer sent: the route never
   * declared it. #1530 D98: the coder scope rides along. Only the route's own names are sent
   * (an allow-list, so a wider object cannot smuggle `layer_scope` — the file is the human layer
   * by J2-B, and a machine layer there is #1060's).
   */
  codedSegments: (projectId: number, params?: CodedSegmentsParams) => {
    const searchParams = new URLSearchParams()
    for (const key of [
      'code_ids', 'exclude_facilitator', 'conversation_ids', 'document_ids', 'observation_ids',
      'participant_ids', 'coder_ids',
    ] as const) {
      const value = params?.[key]
      if (value !== undefined) searchParams.append(key, value)
    }
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${projectId}/export/coded-segments${qs ? '?' + qs : ''}`, 'coded-segments.csv')
  },
  /** `participantFilterLabel` (#1545) rides beside the matrix's READ params, never inside them:
   *  `CodeAnalysisFilterParams` is also what the reads send, and they declare no such name. */
  codeCooccurrence: (projectId: number, params?: CodeAnalysisFilterParams, participantFilterLabel?: string | null) => {
    const searchParams = new URLSearchParams()
    if (params?.code_ids) searchParams.append('code_ids', params.code_ids)
    if (params?.exclude_facilitator !== undefined) searchParams.append('exclude_facilitator', String(params.exclude_facilitator))
    if (params?.participant_ids) searchParams.append('participant_ids', params.participant_ids)
    if (params?.source) searchParams.append('source', params.source)
    // #1527 D84: a source list is sent whenever it is PRESENT — `''` means "none of this
    // kind" (`lib/qual-comparison.ts::cooccurrenceFilterParams`), and dropping it as
    // falsy turned one selected interview back into every document and clip.
    for (const key of ['conversation_ids', 'text_column_ids', 'document_ids', 'observation_ids'] as const) {
      if (params?.[key] !== undefined) searchParams.append(key, params[key]!)
    }
    // #512 (the #499 sibling): carry the active coder/layer scope — the CSV must show the
    // matrix on screen, not a silently-unfiltered variant. #1527 D86: and its level.
    if (params?.coder_ids) searchParams.append('coder_ids', params.coder_ids)
    if (params?.layer_scope) searchParams.append('layer_scope', params.layer_scope)
    if (params?.level) searchParams.append('level', params.level)
    if (params?.participant_ids && participantFilterLabel) {
      searchParams.append('participant_filter_label', participantFilterLabel)
    }
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
  rData: (projectId: number, coderIds?: string) =>
    downloadFromApi(withCoderScope(`/projects/${projectId}/export/r-data`, coderIds), 'r_data_export.zip', {
      label: 'The R data export',
    }),
  /** `params` from `lib/qual-comparison.ts::sourceDataCsvParams` — a source list is sent PRESENT
   *  and empty (`''`) for none of that kind (#1528 D88); `URLSearchParams` keeps an empty value. */
  // #1534 D110: `QualCsvParams` (the routes' own names) — a `Record<string, string>` hid every
  // key from `request-contract.test.ts`. The builders set only defined values; the cast is
  // URLSearchParams' own init type.
  sourceFrequenciesCsv: (projectId: number, params: QualCsvParams) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString()
    return downloadFromApi(`/projects/${projectId}/code-analysis/source-frequencies/csv${qs ? '?' + qs : ''}`, 'source-frequencies.csv')
  },
  demographicComparisonCsv: (projectId: number, params: QualCsvParams) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString()
    return downloadFromApi(`/projects/${projectId}/code-analysis/demographic-comparison/csv${qs ? '?' + qs : ''}`, 'demographic-comparison.csv')
  },
}
