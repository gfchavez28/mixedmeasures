import { Link } from 'react-router'
import { TriangleAlert } from 'lucide-react'
import type { OverlongRecord, OverlongRecords } from '@/lib/api'
import { plural } from '@/lib/format'

/**
 * #985 — a record with MORE values than the file has column headings.
 *
 * The signature of a quoting fault: an answer holding a comma nobody wrapped in
 * quotes, so every later value in that row lands one column along and the last
 * is dropped. The import used to do that in silence. It still imports the file
 * as written — refusing a whole file over one bad row was ruled out — so the job
 * here is to say so BEFORE the researcher imports, by line (what their editor or
 * spreadsheet shows), and AFTER, with a link to each record so it can be fixed.
 *
 * ⚠️ One component for both wizards and both moments, so the words cannot drift
 * between them: `stage` picks the tense, `newDataset` whether a record NUMBER
 * means anything (an appended row gets the dataset's next number, not its place
 * in the file, so the append names lines only).
 */

/** "Line 3 (record 2)" for an import, "Line 3" for an append. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function overlongPlace(e: OverlongRecord, newDataset: boolean): string {
  return newDataset ? `Line ${e.line} (record ${e.record})` : `Line ${e.line}`
}

interface Props {
  report: OverlongRecords | undefined
  stage: 'before' | 'after'
  /** True for an import: the record number is the new dataset's. */
  newDataset: boolean
  /** After an import: the dataset's Data view, so each record can link to its row. */
  datasetPath?: string
  /** The one-line suffix for the multi-file result list. */
  compact?: boolean
}

export function OverlongRecordsNotice({ report, stage, newDataset, datasetPath, compact = false }: Props) {
  if (!report || report.count <= 0) return null
  const n = report.count

  if (compact) {
    return (
      <span className="text-amber-700 dark:text-amber-400">
        {' · '}{n.toLocaleString()} {plural(n, 'row', 'rows')} with extra values
      </span>
    )
  }

  const more = n - report.examples.length
  const verb = newDataset ? 'import' : 'append'

  return (
    <div
      role="note"
      className="flex items-start gap-2 p-3 rounded-lg text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
    >
      <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-1.5 min-w-0">
        {stage === 'before' ? (
          <p>
            <strong className="font-medium">
              {n.toLocaleString()} {plural(n, 'row in this file has', 'rows in this file have')} more
              values than there are column headings.
            </strong>{' '}
            Usually an answer contains a comma that was not wrapped in quotes. From there on, the
            row&rsquo;s values land in the next column along, and the values past the last column are
            dropped. Correct the file and choose it again, or {verb} it as it is and fix{' '}
            {plural(n, 'that record', 'those records')} afterwards.
          </p>
        ) : (
          <p>
            <strong className="font-medium">
              {n.toLocaleString()} {plural(n, 'record had', 'records had')} more values than there
              are column headings
            </strong>
            , so some of {plural(n, 'its', 'their')} values are in the wrong columns. Open{' '}
            {plural(n, 'it', 'each one')} to correct it.
          </p>
        )}
        <ul className="space-y-0.5">
          {report.examples.map(e => (
            <li key={e.line}>
              {stage === 'after' && datasetPath && e.row_id != null ? (
                <Link to={`${datasetPath}?row=${e.row_id}`} className="font-medium underline hover:no-underline">
                  {overlongPlace(e, newDataset)}
                </Link>
              ) : (
                overlongPlace(e, newDataset)
              )}
              {' — '}{e.cells} values for {report.header_width} {plural(report.header_width, 'column', 'columns')}
            </li>
          ))}
        </ul>
        {more > 0 && <p>…and {more.toLocaleString()} more.</p>}
      </div>
    </div>
  )
}
