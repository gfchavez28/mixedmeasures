import { useMemo } from 'react'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import type { HeatmapData, HeatmapCell, ChartFormatting, VariableNMode } from '@/lib/chart-data'
import { DISPLAY_PRECISION, mergeFormatting, resolveHeatmapColors } from '@/lib/chart-data'
import { useChartColors, useTheme } from '@/lib/theme-context'
import { getHslTextColor } from '@/lib/utils'

interface HeatmapTableProps {
  data: HeatmapData
  display?: 'percentage' | 'count'
  scaling?: 'relative' | 'absolute'
  showVariableN?: VariableNMode
  chartN?: number
  formatting?: Partial<ChartFormatting>
}

function getCellStyle(
  cell: HeatmapCell | null,
  rowMax: number,
  scaling: string,
  hue: number,
  saturation: number,
  isDark: boolean,
): React.CSSProperties {
  if (!cell) return {}

  const pct = cell.percentage
  let normalized: number
  if (scaling === 'absolute') {
    normalized = pct / 100
  } else {
    normalized = rowMax > 0 ? pct / rowMax : 0
  }

  const neutralL = isDark ? 16 : 96
  const deepL = isDark ? 22 : 28
  const L = neutralL - normalized * (neutralL - deepL)

  return {
    backgroundColor: `hsl(${hue}, ${saturation}%, ${L}%)`,
    color: getHslTextColor(hue, saturation, L),
  }
}

export default function HeatmapTable({
  data,
  display = 'percentage',
  scaling = 'relative',
  showVariableN = 'off',
  chartN,
  formatting: fmtProp,
}: HeatmapTableProps) {
  const fmt = mergeFormatting(fmtProp)
  const { isDark } = useTheme()
  const colors = useChartColors()
  const heatmapColors = resolveHeatmapColors(fmt.heatmapPreset)
  // Determine whether to show the n column at all
  const showNColumn = showVariableN !== 'off' && (
    showVariableN === 'all' ||
    data.rows.some(r => r.totalN !== chartN)
  )

  // When dataWidth is set, compute label column width as the remaining % after data area
  const labelColumnWidth = fmt.dataWidth !== 'auto'
    ? `${100 - (parseInt(fmt.dataWidth, 10) || 75)}%`
    : undefined
  const rowMaxes = useMemo(() => {
    return data.rows.map(row => {
      let max = 0
      for (const cell of row.cells) {
        if (cell && cell.percentage > max) max = cell.percentage
      }
      return max
    })
  }, [data.rows])

  if (data.columnLabels.length === 0 || data.rows.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-mm-text-faint text-sm">
        No heatmap data available for the current selection.
      </div>
    )
  }

  return (
    <ScrollableTable>
      <table className="border-collapse text-xs w-full" aria-label="Frequency distribution heatmap" style={labelColumnWidth ? { tableLayout: 'fixed' } : undefined}>
        <thead className="sticky top-0 bg-mm-surface z-10">
          <tr>
            <th
              scope="col"
              className="text-left px-3 py-2 font-medium border-b border-r"
              style={{
                fontSize: fmt.labelFontSize,
                color: colors.text,
                minWidth: labelColumnWidth ? undefined : 180,
                width: labelColumnWidth,
                wordBreak: labelColumnWidth ? 'break-word' : undefined,
              }}
            >
              Metric
            </th>
            {data.columnLabels.map(label => (
              <th
                key={label}
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 60 }}
              >
                {label}
              </th>
            ))}
            {showNColumn && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b border-l"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.textMuted }}
              >
                n
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <tr
              key={row.groupLabel ? `${row.metricId}-${row.groupLabel}` : String(row.metricId)}
              className={row.isGroupEnd && ri < data.rows.length - 1 ? 'border-b-2 border-mm-border-medium' : undefined}
            >
              <th
                scope="row"
                className="text-left px-3 py-2 font-medium border-r"
                style={{
                  fontSize: fmt.labelFontSize,
                  color: colors.textDark,
                  wordBreak: labelColumnWidth ? 'break-word' : undefined,
                }}
                title={row.fullLabel || row.label}
                aria-description={row.groupLabel ? `Group: ${row.groupLabel}, n=${row.totalN}` : undefined}
              >
                {row.metricLabel && row.groupLabel ? (
                  <>
                    <div>{row.metricLabel}</div>
                    <div
                      style={{
                        fontSize: fmt.labelFontSize - 1,
                        color: row.groupColor || colors.textMuted,
                        fontStyle: 'italic',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        marginTop: 1,
                      }}
                      title={row.groupLabel}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: row.groupColor || colors.textMuted,
                          flexShrink: 0,
                          display: 'inline-block',
                        }}
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.groupLabel}
                      </span>
                    </div>
                  </>
                ) : (
                  row.label
                )}
              </th>
              {row.cells.map((cell, ci) => {
                const style = getCellStyle(cell, rowMaxes[ri], scaling, heatmapColors.hue, heatmapColors.saturation, isDark)
                const displayVal = cell
                  ? display === 'count'
                    ? cell.count
                    : `${cell.percentage.toFixed(DISPLAY_PRECISION)}%`
                  : '—'
                const titleText = cell
                  ? `${cell.percentage.toFixed(DISPLAY_PRECISION)}% (n=${cell.count})`
                  : 'No data'
                return (
                  <td
                    key={data.columnLabels[ci]}
                    className="text-center px-2 py-2 tabular-nums"
                    style={{ ...style, fontSize: fmt.labelFontSize, fontWeight: 600 }}
                    title={titleText}
                  >
                    {displayVal}
                  </td>
                )
              })}
              {showNColumn && (
                <td
                  className="text-center px-2 py-2 border-l"
                  style={{ fontSize: fmt.axisFontSize - 1, color: colors.textMuted }}
                  aria-label={`Sample size: ${row.totalN}`}
                >
                  {row.totalN}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
  )
}
