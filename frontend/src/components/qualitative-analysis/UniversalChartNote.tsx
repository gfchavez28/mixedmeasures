import { universalChartNote } from '@/lib/universal-share'

/**
 * #1529 D92 (1.5.9) — the one note under a *Proportion · Coded only* chart naming the universal
 * rows it left off (`qual-chart-data.ts::codedShareAxis`). Rendered INSIDE each chart component —
 * the heatmap, the bar and the stacked bar — so the analysis view, its PNG and the Canvas embed
 * (whose capture root is inside `InlineChartRenderer`) all carry it, as the summary table's note
 * does. Nothing when nothing was left off.
 */
export function UniversalChartNote({ leftOut }: { leftOut: readonly string[] }) {
  const note = universalChartNote(leftOut)
  return note ? <p className="text-xs text-mm-text-muted mt-2">{note}</p> : null
}
