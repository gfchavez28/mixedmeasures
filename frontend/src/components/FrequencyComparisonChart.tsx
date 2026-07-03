import type { FrequencySet } from '@/lib/api'

interface FrequencyComparisonChartProps {
  filtered: FrequencySet
  overall: FrequencySet | null
  filterDescription: string
}

export default function FrequencyComparisonChart({
  filtered,
  overall,
  filterDescription,
}: FrequencyComparisonChartProps) {
  if (filtered.frequencies.length === 0) {
    return (
      <div className="text-center py-8 text-mm-text-muted text-sm">
        No codes applied to matching comments.
      </div>
    )
  }

  const maxPct = Math.max(
    ...filtered.frequencies.map(f => f.percentage),
    ...(overall?.frequencies.map(f => f.percentage) || [0]),
    1,
  )

  // Build lookup for overall by code_id
  const overallMap = new Map<number, number>()
  if (overall) {
    for (const f of overall.frequencies) {
      overallMap.set(f.code_id, f.percentage)
    }
  }

  return (
    <div className="border rounded-lg bg-mm-surface p-4" role="img" aria-label={`Frequency comparison: ${filterDescription}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Code Frequencies</h3>
        <span className="text-xs text-mm-text-muted">
          {filtered.text_count} text{filtered.text_count !== 1 ? 's' : ''} from {filtered.row_count} record{filtered.row_count !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="space-y-2">
        {filtered.frequencies.map(f => {
          const overallPct = overallMap.get(f.code_id) ?? 0
          const delta = overall ? f.percentage - overallPct : null

          return (
            <div key={f.code_id} className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-sm flex-shrink-0"
                style={{ backgroundColor: f.code_color || '#6b7280' }}
              />
              <span className="text-sm w-32 truncate flex-shrink-0">{f.code_name}</span>
              <div className="flex-1 flex flex-col gap-0.5">
                {/* Filtered bar */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-mm-bg rounded-full h-4 overflow-hidden">
                    <div
                      className="h-full bg-mm-blue rounded-full transition-all"
                      style={{ width: `${(f.percentage / maxPct) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums w-14 text-right font-medium">{f.percentage.toFixed(1)}%</span>
                </div>
                {/* Overall bar (if comparing) */}
                {overall && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-mm-bg rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-mm-border-medium rounded-full transition-all"
                        style={{ width: `${(overallPct / maxPct) * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] tabular-nums w-14 text-right text-mm-text-faint">{overallPct.toFixed(1)}%</span>
                  </div>
                )}
              </div>
              {delta !== null && (
                <span className={`text-xs tabular-nums w-12 text-right font-medium ${
                  delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-500' : 'text-mm-text-faint'
                }`}>
                  {delta > 0 ? '+' : ''}{delta.toFixed(1)}pp
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      {overall && (
        <div className="flex items-center gap-4 mt-3 pt-2 border-t text-xs text-mm-text-muted">
          <span className="flex items-center gap-1">
            <span className="w-3 h-1.5 bg-mm-blue rounded-full" /> Filtered
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-1.5 bg-mm-border-medium rounded-full" /> Overall
          </span>
        </div>
      )}

      {/* Screen reader data table */}
      <table className="sr-only">
        <caption>Code frequency comparison</caption>
        <thead>
          <tr>
            <th>Code</th>
            <th>Filtered %</th>
            {overall && <th>Overall %</th>}
            {overall && <th>Difference</th>}
          </tr>
        </thead>
        <tbody>
          {filtered.frequencies.map(f => {
            const op = overallMap.get(f.code_id) ?? 0
            return (
              <tr key={f.code_id}>
                <td>{f.code_name}</td>
                <td>{f.percentage.toFixed(1)}%</td>
                {overall && <td>{op.toFixed(1)}%</td>}
                {overall && <td>{(f.percentage - op).toFixed(1)}pp</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
