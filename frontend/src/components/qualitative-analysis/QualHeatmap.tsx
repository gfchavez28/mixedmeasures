import { useMemo, useCallback } from 'react'
import { useTheme } from '@/lib/theme-context'
import { getCodeColor } from '@/lib/utils'
import type { SourceFrequenciesResponse } from '@/lib/api'
import type { QualValueMode, QualDenominatorMode, QualOrientation, QualSortOrder } from '@/lib/qual-analysis-types'
import { getValueModeLabel } from './qual-chart-data'
import {
  shapeQualHeatmapData,
  formatCellValue,
  getHeatmapCellStyle,
  type QualHeatmapData,
} from './qual-chart-data'

interface QualHeatmapProps {
  data: SourceFrequenciesResponse
  valueMode: QualValueMode
  denominatorMode: QualDenominatorMode
  orientation: QualOrientation
  sortOrder: QualSortOrder
  showSummaryRow: boolean
  showRowN?: boolean
  heatmapPreset?: string
  labelFontSize?: number
  dataFontSize?: number
  onCellClick?: (rowId: number, columnId: number) => void
}

export default function QualHeatmap({
  data,
  valueMode,
  denominatorMode,
  orientation,
  sortOrder,
  showSummaryRow,
  showRowN = true,
  heatmapPreset = 'green',
  labelFontSize,
  dataFontSize,
  onCellClick,
}: QualHeatmapProps) {
  const { isDark } = useTheme()

  const heatmapData: QualHeatmapData = useMemo(
    () => shapeQualHeatmapData(data, valueMode, denominatorMode, orientation, sortOrder),
    [data, valueMode, denominatorMode, orientation, sortOrder],
  )

  const { rows, columnLabels, columnIds, maxValue } = heatmapData

  // Pre-compute code colors for row headers
  const codeColorMap = useMemo(() => {
    const map = new Map<number, string>()
    for (const code of data.codes) {
      map.set(code.id, getCodeColor(code))
    }
    return map
  }, [data.codes])

  // Use abbreviated labels when too many columns
  const useAbbreviatedLabels = columnLabels.length > 15
  const displayLabels = useMemo(() => {
    if (!useAbbreviatedLabels) return columnLabels
    return columnLabels.map((_, i) => `C${i + 1}`)
  }, [columnLabels, useAbbreviatedLabels])

  // Summary row
  const summaryRow = useMemo(() => {
    if (!showSummaryRow || rows.length === 0) return null
    const totals: number[] = new Array(columnIds.length).fill(0)
    for (const row of rows) {
      for (let j = 0; j < row.cells.length; j++) {
        totals[j] += row.cells[j].rawCount
      }
    }
    return totals
  }, [showSummaryRow, rows, columnIds.length])

  const handleCellKeyDown = useCallback((e: React.KeyboardEvent, rowId: number, colId: number) => {
    if ((e.key === 'Enter' || e.key === ' ') && onCellClick) {
      e.preventDefault()
      onCellClick(rowId, colId)
    }
  }, [onCellClick])

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-mm-text-muted">
        No data available for the current selection.
      </div>
    )
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: columnLabels.length <= 15 ? 'fixed' : undefined, fontSize: dataFontSize ?? 12 }} aria-label={`Qualitative heatmap showing ${getValueModeLabel(valueMode).toLowerCase()} by ${orientation === 'sources-rows' ? 'source' : 'code'}`}>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-mm-surface px-3 py-2 border-b border-r text-left font-medium" style={{ minWidth: 140, width: columnLabels.length <= 15 ? 180 : undefined }}>
                {orientation === 'sources-rows' ? 'Source' : 'Code'}
              </th>
              {displayLabels.map((label, j) => (
                <th
                  scope="col"
                  key={columnIds[j]}
                  className="border-b font-medium text-center"
                  style={
                    useAbbreviatedLabels
                      ? { minWidth: 36, maxWidth: 36, padding: '4px 4px' }
                      : { minWidth: 60, padding: '8px 4px' }
                  }
                  title={columnLabels[j]}
                >
                  {useAbbreviatedLabels ? (
                    <span className="whitespace-nowrap text-xs">{label}</span>
                  ) : (
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap" title={columnLabels[j]}>
                      {label}
                    </span>
                  )}
                </th>
              ))}
              {showRowN && (
                <th scope="col" className="px-2 py-1.5 border-b font-medium text-center text-mm-text-muted" style={{ minWidth: 48, width: columnLabels.length <= 15 ? 56 : undefined }}>
                  N
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.sourceType}-${row.id}`}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-mm-surface px-3 py-1.5 border-r font-medium text-left whitespace-nowrap"
                  title={row.label}
                  style={labelFontSize ? { fontSize: labelFontSize } : undefined}
                >
                  {row.sourceType === 'code' && (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: codeColorMap.get(row.id) ?? '#6b7280' }}
                      />
                      {row.label.length > 24 ? row.label.slice(0, 21) + '\u2026' : row.label}
                    </span>
                  )}
                  {row.sourceType !== 'code' && (
                    <span className="truncate block max-w-[180px]">
                      {row.label}
                    </span>
                  )}
                </th>
                {row.cells.map((cell, j) => (
                  <td
                    key={columnIds[j]}
                    className="px-1 py-1 text-center tabular-nums cursor-pointer hover:ring-1 hover:ring-mm-blue hover:ring-inset"
                    style={getHeatmapCellStyle(cell.displayValue, maxValue, isDark, heatmapPreset)}
                    title={`${row.label} \u00D7 ${cell.columnLabel}: ${cell.rawCount} segment${cell.rawCount !== 1 ? 's' : ''}${cell.wordCount > 0 ? `, ${cell.wordCount} words` : ''}`}
                    tabIndex={0}
                    role="gridcell"
                    aria-label={`${row.label}, ${cell.columnLabel}: ${formatCellValue(cell.displayValue, valueMode)}. Press Enter to view.`}
                    onClick={() => onCellClick?.(row.id, cell.columnId)}
                    onKeyDown={e => handleCellKeyDown(e, row.id, cell.columnId)}
                  >
                    {cell.rawCount > 0 ? formatCellValue(cell.displayValue, valueMode) : '\u2013'}
                  </td>
                ))}
                {showRowN && (
                  <td className="px-2 py-1 text-center tabular-nums text-mm-text-muted font-medium">
                    {row.totalN}
                  </td>
                )}
              </tr>
            ))}

            {/* Summary row */}
            {summaryRow && (
              <tr className="bg-mm-surface font-medium">
                <th scope="row" className="sticky left-0 z-10 bg-mm-surface px-3 py-1.5 border-r text-left">
                  Total
                </th>
                {summaryRow.map((total, j) => (
                  <td key={columnIds[j]} className="px-1 py-1 text-center tabular-nums">
                    {total > 0 ? total : '\u2013'}
                  </td>
                ))}
                {showRowN && (
                  <td className="px-2 py-1 text-center tabular-nums">
                    {summaryRow.reduce((a, b) => a + b, 0)}
                  </td>
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Legend (abbreviated labels) */}
      {useAbbreviatedLabels && (
        <div className="mt-3 text-xs text-mm-text-muted space-y-0.5">
          <p className="font-medium text-mm-text-secondary mb-1">Legend</p>
          {columnLabels.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="font-mono text-mm-text-faint w-6">C{i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
