/**
 * The joint display's REPORT view (D176; mockup `8-report-view.html`) — layout A's shape, read
 * only: the side-by-side table with every construct open, exactly as the export writes it.
 *
 * 🔴 **It renders `lib/joint-display-report.ts::buildJointDisplayReport`'s table — the one the
 * Markdown, HTML and Word exports print** (D176.2), so the preview and the file cannot say
 * different things. Its cells are plain text, as Word's are.
 *
 * What it keeps (D176):
 * - **No editable control** beyond the construct links (D176's build note): each construct name
 *   is a button, *Edit “…” in Compact view* (*Open …* on a read-only surface), that switches to
 *   Compact with that construct open (D176.6).
 * - **Working signals stay OUTSIDE the report page** (D176.5): drift is a strip above the table.
 * - **A real `<table>` with a caption and `th scope`**, in `ScrollableTable` — it scrolls sideways
 *   in a window too narrow for it; the node view widens it past the writing column while shown
 *   (`useReportBreakout`).
 */
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import type { JointDisplayReport } from '@/lib/joint-display-report'

interface ReportViewProps {
  report: JointDisplayReport
  /** The constructs whose numbers moved since their meta-inference was written (D168.5). */
  drifted: string[]
  isEditable: boolean
  onOpenConstruct: (rowKey: string) => void
}

export default function ReportView({ report, drifted, isEditable, onOpenConstruct }: ReportViewProps) {
  if (report.message) {
    return (
      <div className="text-sm">
        <p className="font-semibold text-mm-text">{report.title}</p>
        <p className="text-mm-text-muted">{report.message}</p>
      </div>
    )
  }
  const width = report.headers.length
  return (
    <div className="space-y-2">
      {drifted.length > 0 && (
        <p className="rounded-md border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          Numbers moved since the meta-inference was written: {drifted.join(', ')}. Open the construct in
          Compact view to review it. This line is not part of the report.
        </p>
      )}
      {/* A tab stop of its own, so the arrow keys scroll it: its cells are text, and from a focused
          construct link the arrows scroll nothing inside the editor (driven 2026-11-12f). */}
      <ScrollableTable tabIndex={0} role="region" aria-label={`Report table: ${report.title}`}>
        <table className="w-full border-collapse text-[12.5px] leading-snug">
          <caption className="caption-top pb-2 text-left text-sm font-semibold text-mm-text">{report.title}</caption>
          <thead>
            <tr className="border-y border-mm-border-medium bg-mm-surface-hover text-left text-[11.5px] text-mm-text-secondary">
              {report.headers.map(h => (
                <th key={h} scope="col" className="px-2.5 py-2 align-bottom font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r, i) => r.kind === 'construct' ? (
              <tr key={`${r.rowKey}-${i}`} className="border-b border-mm-border-subtle">
                <th scope="row" className="px-2.5 py-2 text-left align-top font-semibold text-mm-text min-w-[9rem]">
                  <button
                    type="button"
                    className="text-left hover:underline text-mm-blue-text"
                    aria-label={`${isEditable ? 'Edit' : 'Open'} “${r.construct}” in Compact view`}
                    onClick={() => onOpenConstruct(r.rowKey)}
                  >
                    {r.construct}
                  </button>
                </th>
                {r.cells.map((c, j) => (
                  <td key={j} className="px-2.5 py-2 align-top text-mm-text min-w-[10rem]">{c}</td>
                ))}
              </tr>
            ) : (
              <tr key={`${r.rowKey}-beside-${i}`} className="border-b border-mm-border-subtle bg-mm-surface-hover">
                <td colSpan={width} className="px-2.5 py-1.5 text-mm-text-secondary">{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>
      <p className="text-[11px] leading-snug text-mm-text-muted">{report.note}</p>
      {report.appendix.map((a, i) => (
        <div key={`${i}:${a.title}`} className="space-y-1 pt-1">
          <ScrollableTable tabIndex={0} role="region" aria-label={`Table: ${a.title}`}>
            <table className="border-collapse text-[12px]">
              <caption className="caption-top pb-1 text-left text-xs font-semibold text-mm-text">{a.title}</caption>
              <thead>
                <tr className="border-b border-mm-border-medium text-left text-mm-text-secondary">
                  {a.table.headers.map((h, j) => <th key={j} scope="col" className="px-2 py-1 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {a.table.rows.map((row, j) => (
                  <tr key={j} className="border-b border-mm-border-subtle">
                    {row.map((c, k) => <td key={k} className="px-2 py-1 text-mm-text">{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
          {a.table.note && <p className="text-[11px] text-mm-text-muted">{a.table.note}</p>}
        </div>
      ))}
    </div>
  )
}
