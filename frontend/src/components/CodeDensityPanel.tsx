import type { CodeDensityResponse } from '@/lib/api'

interface CodeDensityPanelProps {
  data: CodeDensityResponse | null
  loading: boolean
}

export default function CodeDensityPanel({ data, loading }: CodeDensityPanelProps) {
  if (loading) {
    return <div className="text-center py-6 text-mm-text-muted text-sm">Loading...</div>
  }
  if (!data) return null

  const maxAvg = Math.max(
    data.overall.avg_codes_per_text,
    ...data.groups.map(g => g.avg_codes_per_text),
    1,
  )

  return (
    <div className="border rounded-lg bg-mm-surface p-4" role="region" aria-label="Code density">
      <h3 className="text-sm font-medium mb-3">Code Density</h3>

      <div className="flex items-center gap-3 mb-4">
        <span className="text-2xl font-bold tabular-nums">{data.overall.avg_codes_per_text.toFixed(1)}</span>
        <div className="text-xs text-mm-text-muted">
          <div>avg codes per text</div>
          <div>{data.overall.text_count} text{data.overall.text_count !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {data.groups.length > 0 && (
        <div className="space-y-1.5">
          {data.groups.map(g => (
            <div key={g.group_value} className="flex items-center gap-2">
              <span className="text-xs w-24 truncate flex-shrink-0 text-mm-text-secondary" title={g.group_value}>
                {g.group_value}
              </span>
              <div className="flex-1 bg-mm-bg rounded-full h-3 overflow-hidden" role="meter" aria-valuenow={g.avg_codes_per_text} aria-valuemin={0} aria-valuemax={maxAvg} aria-label={`${g.group_value}: ${g.avg_codes_per_text.toFixed(1)} avg codes`}>
                <div
                  className="h-full bg-violet-400 rounded-full transition-all"
                  style={{ width: `${(g.avg_codes_per_text / maxAvg) * 100}%` }}
                />
              </div>
              <span className="text-xs tabular-nums w-8 text-right font-medium">{g.avg_codes_per_text.toFixed(1)}</span>
              <span className="text-[11px] text-mm-text-faint w-6 text-right">n={g.text_count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
