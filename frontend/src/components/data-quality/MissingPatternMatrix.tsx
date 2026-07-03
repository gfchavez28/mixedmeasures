import { useMemo } from 'react'
import { Info } from 'lucide-react'
import type { MissingPatternsResponse } from '@/lib/api'

interface MissingPatternMatrixProps {
  data: MissingPatternsResponse
}

export default function MissingPatternMatrix({ data }: MissingPatternMatrixProps) {
  const { patterns, column_labels, column_ids, total_rows, n_unique_patterns, truncated } = data

  const useShortLabels = column_labels.length > 15
  const useVertical = column_labels.length > 8

  const displayLabels = useMemo(() => {
    if (useShortLabels) {
      return column_labels.map((_, i) => `V${i + 1}`)
    }
    return column_labels
  }, [column_labels, useShortLabels])

  // Per-column missing count for bottom summary
  const perColMissing = useMemo(() => {
    const counts = new Array(column_ids.length).fill(0)
    for (const row of patterns) {
      for (let j = 0; j < row.pattern.length; j++) {
        if (row.pattern[j]) counts[j] += row.count
      }
    }
    return counts.map(c =>
      total_rows > 0 ? Math.round((c / total_rows) * 100) : 0
    )
  }, [patterns, column_ids.length, total_rows])

  if (patterns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-mm-text-faint text-sm">
        No missing data patterns found.
      </div>
    )
  }

  return (
    <div>
      {truncated && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md bg-mm-blue/12 border border-mm-blue/30 text-mm-blue-text text-xs">
          <Info className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Showing top {patterns.length} of {n_unique_patterns} unique patterns.</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="px-2 py-1.5 text-center font-medium text-mm-text-muted border-b border-mm-border-subtle bg-mm-surface" style={{ minWidth: 32 }}>
                #
              </th>
              {displayLabels.map((label, j) => (
                <th
                  key={j}
                  className="px-1 py-1.5 text-center font-medium text-mm-text-muted border-b border-mm-border-subtle bg-mm-surface"
                  style={useVertical ? { writingMode: 'vertical-lr', transform: 'rotate(180deg)', minWidth: 24, maxHeight: 100 } : { minWidth: 36, maxWidth: 80 }}
                  title={column_labels[j]}
                >
                  <div className={useVertical ? '' : 'truncate'}>{label}</div>
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium text-mm-text-muted border-b border-mm-border-subtle bg-mm-surface border-l" style={{ minWidth: 48 }}>
                N
              </th>
              <th className="px-2 py-1.5 text-right font-medium text-mm-text-muted border-b border-mm-border-subtle bg-mm-surface" style={{ minWidth: 48 }}>
                %
              </th>
            </tr>
          </thead>
          <tbody>
            {patterns.map((row, idx) => (
              <tr key={idx}>
                <td className="px-2 py-1 text-center text-mm-text-faint tabular-nums border-r border-mm-border-subtle">
                  {idx + 1}
                </td>
                {row.pattern.map((isMissing, j) => (
                  <td
                    key={j}
                    className={`px-1 py-1 border border-mm-border-subtle ${
                      isMissing
                        ? 'bg-red-400/70 dark:bg-red-500/50'
                        : 'bg-mm-blue/10'
                    }`}
                    title={`${column_labels[j]}: ${isMissing ? 'Missing' : 'Observed'}`}
                    aria-label={`${column_labels[j]}: ${isMissing ? 'Missing' : 'Observed'}`}
                    style={{ minWidth: useVertical ? 24 : 36, height: 20 }}
                  />
                ))}
                <td className="px-2 py-1 text-right text-mm-text tabular-nums border-l border-mm-border-subtle font-medium">
                  {row.count}
                </td>
                <td className="px-2 py-1 text-right text-mm-text-muted tabular-nums">
                  {row.pct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
          {/* Bottom summary row: per-variable % missing */}
          <tfoot>
            <tr className="border-t-2 border-mm-border-subtle">
              <td className="px-2 py-1.5 text-center text-mm-text-faint text-[10px] border-r border-mm-border-subtle">
                %
              </td>
              {perColMissing.map((pct, j) => (
                <td
                  key={j}
                  className="px-1 py-1.5 text-center text-[10px] text-mm-text-muted tabular-nums border border-mm-border-subtle"
                  title={`${column_labels[j]}: ${pct}% missing`}
                >
                  {pct}
                </td>
              ))}
              <td className="px-2 py-1.5 border-l border-mm-border-subtle" />
              <td className="px-2 py-1.5" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Legend for short labels */}
      {useShortLabels && (
        <div className="mt-3 text-[10px] text-mm-text-faint space-y-0.5">
          <div className="font-medium text-mm-text-muted mb-1">Variable Legend</div>
          {column_labels.map((label, i) => (
            <div key={i}>V{i + 1} = {label}</div>
          ))}
        </div>
      )}

      {/* Color legend */}
      <div className="mt-3 flex items-center gap-4 text-[11px] text-mm-text-faint">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-red-400/70 dark:bg-red-500/50 border border-mm-border-subtle" />
          <span>Missing</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-mm-blue/10 border border-mm-border-subtle" />
          <span>Observed</span>
        </div>
      </div>
    </div>
  )
}
