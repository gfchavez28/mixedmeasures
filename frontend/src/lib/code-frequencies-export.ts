/**
 * #1528 D87 (1.5.9) — the Frequencies CSV, written in the browser from the Descriptives summary
 * table's own read.
 *
 * It was a server file (`GET …/export/code-frequencies`, now deleted) built on a different
 * payload from the table's, so it wrote zeros from the Text source and counted outside the
 * selection. Now the doors — the analysis page's header *Export CSV*, its *Exports › Frequencies
 * CSV*, and the Export dialog's *Code Frequencies (CSV)* — fetch `POST …/source-frequencies` with
 * the request `lib/qual-comparison.ts::codeFrequenciesFileRequest` builds, and the file is
 * `qual-summary-columns.ts::codeSummaryCsv` over the answer: the table's rows.
 *
 * Never rejects: a fire-and-forget door (`onClick={…}`) needs no error handling, as with
 * `downloadFromApi`, whose failure wording it shares (`reportExportFailure`).
 */
import { codeAnalysisApi, downloadBlob, EXPORT_TIMEOUT_MS, reportExportFailure } from '@/lib/api'
import type { SourceFrequenciesRequest } from '@/lib/api'
import { safeFilename } from '@/lib/filename'
import { codeSummaryCsv } from '@/components/qualitative-analysis/qual-summary-columns'

/** `<project>_code_frequencies_<YYYYMMDD>.csv` — the server file's name, kept; local date. */
export function codeFrequenciesFilename(projectName: string | undefined, now: Date = new Date()): string {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const stem = projectName ? `${projectName}_code_frequencies_${ymd}` : `code_frequencies_${ymd}`
  return `${safeFilename(stem, { fallback: `code_frequencies_${ymd}` })}.csv`
}

export async function exportCodeFrequenciesCsv(
  projectId: number,
  opts: {
    request: SourceFrequenciesRequest
    /** Per Category (the request's `aggregation: 'category'`) or Per Code. */
    categoryMode: boolean
    /** `qual-summary-columns.ts::frequencyFileScope` — `null` when nothing narrows it. */
    scope: string | null
    projectName: string | undefined
  },
): Promise<void> {
  try {
    // #820's budget: the read IS the export now, and its cost is the project's.
    const data = await codeAnalysisApi.sourceFrequencies(projectId, opts.request, { timeout: EXPORT_TIMEOUT_MS })
    const csv = codeSummaryCsv(data, { categoryMode: opts.categoryMode, scope: opts.scope })
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), codeFrequenciesFilename(opts.projectName))
  } catch (err) {
    reportExportFailure(err, 'The frequencies export')
  }
}
