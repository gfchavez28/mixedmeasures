import { undefinedTooltip } from '@/lib/stat-format'
import type { UndefinedComparisonGroup } from '@/lib/qual-comparison'

/**
 * #1421 — names each comparison group that has no share, with the server's reason.
 *
 * Shared by the table and the bar chart, and rendered INSIDE each so the exported
 * PNG (captured from `data-chart-capture-root`) carries it too. Visible text, so the
 * reason is not left to a `title` that neither a keyboard nor a screen reader reaches.
 */
export function QualComparisonUndefinedNote({ groups }: { groups: UndefinedComparisonGroup[] }) {
  if (groups.length === 0) return null
  return (
    <div className="pb-1.5 text-[11px] text-mm-text-muted" data-undefined-statistic="">
      {groups.map(g => (
        <p key={g.group}>
          <span className="font-medium">{g.group}:</span> {undefinedTooltip(g.reason)}
        </p>
      ))}
    </div>
  )
}
