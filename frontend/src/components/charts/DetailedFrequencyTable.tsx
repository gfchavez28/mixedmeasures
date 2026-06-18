import { useMemo } from 'react'
import {
  shapeFrequencyTable,
  isGroupedMetrics,
  getGroupValues,
  resolveGroupColors,
  mergeFormatting,
  type FrequencyTableMetric,
} from '@/lib/chart-data'
import type { MetricDefinitionResponse } from '@/lib/api'
import type { ChartFormatting, SortOrder } from '@/lib/chart-data'

interface DetailedFrequencyTableProps {
  metrics: MetricDefinitionResponse[]
  formatting?: Partial<ChartFormatting>
  labelMap?: Map<number, string>
  reverseScale?: boolean
  hiddenLabels?: string[]
  hiddenGroupValues?: string[]
  sortOrder?: SortOrder
}

function MetricTable({
  metric,
  formatting,
  showCumulative,
}: {
  metric: FrequencyTableMetric
  formatting: ReturnType<typeof mergeFormatting>
  showCumulative: boolean
}) {
  return (
    <table
      className="w-full border-collapse text-sm"
      style={{ fontSize: formatting.axisFontSize }}
    >
      <caption className="text-left font-medium text-mm-text pb-1.5" style={{ fontSize: formatting.labelFontSize }}>
        {metric.fullLabel || metric.label}
      </caption>
      <thead>
        <tr className="border-b-2 border-mm-border-medium">
          <th scope="col" className="text-left py-1.5 px-2 font-medium text-mm-text-secondary">Label</th>
          <th scope="col" className="text-right py-1.5 px-2 font-medium text-mm-text-secondary tabular-nums">Count</th>
          <th scope="col" className="text-right py-1.5 px-2 font-medium text-mm-text-secondary tabular-nums">Percent</th>
          <th scope="col" className="text-right py-1.5 px-2 font-medium text-mm-text-secondary tabular-nums">Valid %</th>
          {showCumulative && (
            <>
              <th scope="col" className="text-right py-1.5 px-2 font-medium text-mm-text-secondary tabular-nums">Cum. #</th>
              <th scope="col" className="text-right py-1.5 px-2 font-medium text-mm-text-secondary tabular-nums">Cum. %</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {metric.rows.map((row, i) => (
          <tr key={i} className="border-b border-mm-border-subtle hover:bg-mm-surface-hover">
            <th scope="row" className="text-left py-1 px-2 font-normal text-mm-text">{row.label}</th>
            <td className="text-right py-1 px-2 tabular-nums">{row.count}</td>
            <td className="text-right py-1 px-2 tabular-nums">{row.percent.toFixed(1)}%</td>
            <td className="text-right py-1 px-2 tabular-nums">{row.validPercent.toFixed(1)}%</td>
            {showCumulative && (
              <>
                <td className="text-right py-1 px-2 tabular-nums">{row.cumulativeCount}</td>
                <td className="text-right py-1 px-2 tabular-nums">{row.cumulativeValidPercent.toFixed(1)}%</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-mm-border-medium font-medium">
          <th scope="row" className="text-left py-1 px-2 text-mm-text-secondary">Total (valid)</th>
          <td className="text-right py-1 px-2 tabular-nums">{metric.totalValid}</td>
          <td className="text-right py-1 px-2 tabular-nums">
            {metric.totalAll > 0 ? ((metric.totalValid / metric.totalAll) * 100).toFixed(1) : '100.0'}%
          </td>
          <td className="text-right py-1 px-2 tabular-nums">100.0%</td>
          {showCumulative && (
            <>
              <td className="text-right py-1 px-2 tabular-nums">{metric.totalValid}</td>
              <td className="text-right py-1 px-2 tabular-nums">100.0%</td>
            </>
          )}
        </tr>
        {metric.totalMissing > 0 && (
          <tr className="text-mm-text-faint">
            <th scope="row" className="text-left py-1 px-2 font-normal italic">Missing</th>
            <td className="text-right py-1 px-2 tabular-nums">{metric.totalMissing}</td>
            <td className="text-right py-1 px-2 tabular-nums">
              {metric.totalAll > 0 ? ((metric.totalMissing / metric.totalAll) * 100).toFixed(1) : '0.0'}%
            </td>
            <td className="text-right py-1 px-2 tabular-nums" colSpan={showCumulative ? 3 : 1}>—</td>
          </tr>
        )}
        {metric.totalMissing > 0 && (
          <tr className="font-medium border-t border-mm-border-subtle">
            <th scope="row" className="text-left py-1 px-2 text-mm-text-secondary">Total</th>
            <td className="text-right py-1 px-2 tabular-nums">{metric.totalAll}</td>
            <td className="text-right py-1 px-2 tabular-nums">100.0%</td>
            <td className="text-right py-1 px-2 tabular-nums" colSpan={showCumulative ? 3 : 1}>—</td>
          </tr>
        )}
      </tfoot>
    </table>
  )
}

export default function DetailedFrequencyTable({
  metrics,
  formatting: fmtProp,
  labelMap,
  reverseScale = false,
  hiddenLabels = [],
  hiddenGroupValues = [],
  sortOrder = 'none',
}: DetailedFrequencyTableProps) {
  const fmt = mergeFormatting(fmtProp)
  const showCumulative = sortOrder === 'none' || sortOrder === 'custom'

  const isGrouped = isGroupedMetrics(metrics)
  const allGroupValues = useMemo(() => isGrouped ? getGroupValues(metrics) : [], [isGrouped, metrics])
  const visibleGroupValues = useMemo(
    () => allGroupValues.filter(gv => !hiddenGroupValues.includes(gv)),
    [allGroupValues, hiddenGroupValues],
  )
  const groupColors = useMemo(
    () => isGrouped ? resolveGroupColors(visibleGroupValues, fmt.colorPalette) : {},
    [isGrouped, visibleGroupValues, fmt.colorPalette],
  )

  const shapeOpts = useMemo(() => ({
    reverseScale: reverseScale || undefined,
    hiddenLabels: hiddenLabels.length > 0 ? hiddenLabels : undefined,
  }), [reverseScale, hiddenLabels])

  // Ungrouped: one call
  const ungroupedTables: FrequencyTableMetric[] = useMemo(() => {
    if (isGrouped) return []
    return shapeFrequencyTable(metrics, labelMap, shapeOpts)
  }, [isGrouped, metrics, labelMap, shapeOpts])

  // Grouped: one call per visible group value
  const groupedSections = useMemo(() => {
    if (!isGrouped) return []
    return visibleGroupValues.map(gv => ({
      groupValue: gv,
      tables: shapeFrequencyTable(metrics, labelMap, { ...shapeOpts, groupValue: gv }),
    }))
  }, [isGrouped, metrics, labelMap, shapeOpts, visibleGroupValues])

  if (!isGrouped) {
    return (
      <div className="space-y-4 p-4" role="region" aria-label="Frequency tables">
        {ungroupedTables.map((q, i) => (
          <MetricTable key={i} metric={q} formatting={fmt} showCumulative={showCumulative} />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4" role="region" aria-label="Grouped frequency tables">
      {groupedSections.map(({ groupValue, tables }) => (
        <div key={groupValue}>
          <div className="flex items-center gap-2 mb-2 pb-1 border-b border-mm-border-subtle">
            <span
              className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: groupColors[groupValue] || '#6b7280' }}
            />
            <span className="text-sm font-semibold text-mm-text">{groupValue}</span>
          </div>
          <div className="space-y-4">
            {tables.map((q, i) => (
              <MetricTable key={i} metric={q} formatting={fmt} showCumulative={showCumulative} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
