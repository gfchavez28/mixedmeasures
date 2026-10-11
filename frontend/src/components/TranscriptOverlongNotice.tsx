import { TriangleAlert } from 'lucide-react'
import type { OverlongRecords } from '@/lib/api'
import { plural } from '@/lib/format'

/**
 * #1127 — transcript rows with MORE values than the file has column headings.
 *
 * A comma inside a turn's text that nobody wrapped in quotation marks splits the row
 * there: the rest of the turn lands in the next column along, and past the last
 * column it is not imported at all — "Well, I think so, yes" imported as "Well", and
 * nothing said so. The import still reads the file as written (the dataset doors'
 * #985 rule), so the job here is to say so BEFORE the import, by line.
 *
 * ⚠️ Its own words, not `OverlongRecordsNotice`'s: that one speaks of answers,
 * records and fixing them afterwards in the Data view, none of which a transcript has.
 */
export function TranscriptOverlongNotice({ files }: {
  files: { name: string; report: OverlongRecords | undefined }[]
}) {
  const affected = files.filter(f => f.report && f.report.count > 0)
  if (affected.length === 0) return null
  return (
    <div
      role="note"
      className="flex items-start gap-2 p-3 rounded-lg text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
    >
      <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-2 min-w-0">
        <p>
          <strong className="font-medium">
            Some rows have more values than the file has column headings.
          </strong>{' '}
          Usually the text contains a comma that was not wrapped in quotation marks. From that
          comma on, the row&rsquo;s values land in the next column along, and anything past the
          last column is not imported &mdash; so that turn&rsquo;s text would be cut short.
          Correct the file and choose it again, or import it as it is.
        </p>
        {affected.map(({ name, report }) => {
          const r = report as OverlongRecords
          const more = r.count - r.examples.length
          return (
            <div key={name} className="min-w-0">
              <p className="font-medium break-words">
                {affected.length > 1 || files.length > 1 ? `${name}: ` : ''}
                {r.count.toLocaleString()} {plural(r.count, 'row', 'rows')}
              </p>
              <ul className="space-y-0.5">
                {r.examples.map(e => (
                  <li key={e.line}>
                    Line {e.line.toLocaleString()} &mdash; {e.cells} values for {r.header_width}{' '}
                    {plural(r.header_width, 'column', 'columns')}
                  </li>
                ))}
              </ul>
              {more > 0 && <p>&hellip;and {more.toLocaleString()} more.</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
