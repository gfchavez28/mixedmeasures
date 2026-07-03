import { useMemo } from 'react'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import type { AnalysisCrossTabResponse } from '@/lib/api'
import { resolveHeatmapColors, DISPLAY_PRECISION, mergeFormatting, formatPValue } from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import type { ChartFormatting } from '@/lib/chart-data'

interface AnalysisCrossTabTableProps {
  data: AnalysisCrossTabResponse
  display?: string       // 'count' | 'row_pct' | 'col_pct' | 'total_pct'
  scaleOrder?: string    // 'original' | 'reversed'
  formatting?: Partial<ChartFormatting>
}

export default function AnalysisCrossTabTable({
  data,
  display = 'count',
  scaleOrder = 'original',
  formatting: fmtProp,
}: AnalysisCrossTabTableProps) {
  const fmt = mergeFormatting(fmtProp)
  const colors = useChartColors()
  const rawHeatmap = resolveHeatmapColors(fmt.heatmapPreset)
  // Diverging preset produces hue=0/saturation=0 (grayscale) — fall back to green
  const heatmap = (rawHeatmap.hue === 0 && rawHeatmap.saturation === 0)
    ? resolveHeatmapColors('green')
    : rawHeatmap

  // Optionally reverse row/col order
  const rowValues = useMemo(
    () => scaleOrder === 'reversed' ? [...data.row_values].reverse() : data.row_values,
    [data.row_values, scaleOrder],
  )
  const colValues = useMemo(
    () => scaleOrder === 'reversed' ? [...data.col_values].reverse() : data.col_values,
    [data.col_values, scaleOrder],
  )

  // Build index map for accessing the original matrix with reversed order
  const rowIndexMap = useMemo(
    () => rowValues.map(v => data.row_values.indexOf(v)),
    [rowValues, data.row_values],
  )
  const colIndexMap = useMemo(
    () => colValues.map(v => data.col_values.indexOf(v)),
    [colValues, data.col_values],
  )

  // Reorder totals
  const rowTotals = useMemo(
    () => rowIndexMap.map(i => data.row_totals[i]),
    [rowIndexMap, data.row_totals],
  )
  const colTotals = useMemo(
    () => colIndexMap.map(i => data.col_totals[i]),
    [colIndexMap, data.col_totals],
  )

  // Get cell value based on display mode
  const getCellValue = (ri: number, ci: number): number => {
    const cell = data.matrix[rowIndexMap[ri]][colIndexMap[ci]]
    switch (display) {
      case 'row_pct': return cell.row_pct
      case 'col_pct': return cell.col_pct
      case 'total_pct': return cell.total_pct
      default: return cell.count
    }
  }

  const isPercent = display !== 'count'

  // Compute max value for heatmap intensity
  const maxValue = useMemo(() => {
    let max = 0
    for (let ri = 0; ri < rowValues.length; ri++) {
      for (let ci = 0; ci < colValues.length; ci++) {
        const v = getCellValue(ri, ci)
        if (v > max) max = v
      }
    }
    return max
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowValues, colValues, display, data.matrix, rowIndexMap, colIndexMap])

  const cellStyle = (value: number): { backgroundColor: string; color: string } => {
    if (maxValue === 0) return { backgroundColor: 'transparent', color: '#1a1a1a' }
    const intensity = value / maxValue
    const L = 95 - intensity * 60
    return {
      backgroundColor: `hsl(${heatmap.hue}, ${heatmap.saturation}%, ${L}%)`,
      color: L < 55 ? '#ffffff' : '#1a1a1a',
    }
  }

  const formatCell = (value: number): string => {
    if (isPercent) return `${value.toFixed(DISPLAY_PRECISION)}%`
    return String(value)
  }

  // Chi-square APA format
  const chiSquareText = useMemo(() => {
    if (!data.chi_square) return null
    const { statistic, df, p_value, cramers_v } = data.chi_square
    return `χ²(${df}) = ${statistic.toFixed(2)}, ${formatPValue(p_value)}, V = ${cramers_v.toFixed(2)}`
  }, [data.chi_square])

  const grandTotal = data.n_shared

  return (
    <div>
      <div className="text-xs text-mm-text-muted mb-2">
        n = {grandTotal} record{grandTotal !== 1 ? 's' : ''}
      </div>

      <ScrollableTable>
        <table
          role="table"
          className="text-xs border-collapse"
          style={{ fontSize: fmt.axisFontSize }}
          aria-label={`Cross-tabulation of ${data.row_column_label} by ${data.col_column_label}`}
        >
          <caption className="sr-only">
            Cross-tabulation of {data.row_column_label} (rows) by {data.col_column_label} (columns), with cell counts and row/column totals.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium border-b border-r bg-mm-bg"
                style={{ color: colors.text }}
              >
                {data.row_column_label}
              </th>
              {colValues.map(col => (
                <th
                  key={col}
                  scope="col"
                  className="px-3 py-2 text-center font-medium border-b bg-mm-bg whitespace-nowrap"
                  style={{ color: colors.text }}
                >
                  {col}
                </th>
              ))}
              <th
                scope="col"
                className="px-3 py-2 text-center font-semibold border-b border-l bg-mm-surface whitespace-nowrap"
                style={{ color: colors.textDark }}
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rowValues.map((row, ri) => (
              <tr key={row}>
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-medium border-r whitespace-nowrap"
                  style={{ color: colors.text }}
                >
                  {row}
                </th>
                {colValues.map((_col, ci) => {
                  const value = getCellValue(ri, ci)
                  return (
                    <td
                      key={ci}
                      className="px-3 py-2 text-center tabular-nums"
                      style={cellStyle(value)}
                    >
                      {formatCell(value)}
                    </td>
                  )
                })}
                <td className="px-3 py-2 text-center font-medium border-l bg-mm-bg tabular-nums">
                  {rowTotals[ri]}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-semibold border-r bg-mm-surface">
                Total
              </th>
              {colTotals.map((total, ci) => (
                <td key={ci} className="px-3 py-2 text-center font-medium bg-mm-bg tabular-nums">
                  {total}
                </td>
              ))}
              <td className="px-3 py-2 text-center font-semibold border-l bg-mm-surface tabular-nums">
                {grandTotal}
              </td>
            </tr>
          </tfoot>
        </table>
      </ScrollableTable>

      {chiSquareText && (
        <div className="text-xs text-mm-text-muted mt-2 italic">
          {chiSquareText}
        </div>
      )}
    </div>
  )
}
