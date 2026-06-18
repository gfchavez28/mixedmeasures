import { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { getCorrCellStyle, getSignificanceStars, formatP, formatPValue, type ChartFormatting } from '@/lib/chart-data'
import { useTheme } from '@/lib/theme-context'
import type { CorrelationCell } from '@/lib/api'

type CellFormat = 'r_stars' | 'r_p' | 'r_only'

interface CorrelationMatrixProps {
  labels: string[]
  fullLabels: string[]
  matrix: CorrelationCell[][]
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  bonferroni: boolean
  adjustedAlpha?: number | null
  cellFormat: CellFormat
  formatting?: Partial<ChartFormatting>
  heatmapPreset?: string
}

function formatR(r: number): string {
  if (r === 1) return '1'
  if (r === -1) return '-1'
  // Remove leading zero: .72 / -.72
  const s = r.toFixed(2)
  if (s.startsWith('0.')) return s.slice(1)
  if (s.startsWith('-0.')) return '-' + s.slice(2)
  return s
}

function formatCellContent(cell: CorrelationCell, format: CellFormat, sigLevels: CorrelationMatrixProps['sigLevels']): React.ReactNode {
  const rStr = formatR(cell.r)
  const stars = getSignificanceStars(cell.p, sigLevels)

  switch (format) {
    case 'r_p':
      return <>{rStr} <span className="text-[0.7em] opacity-70">({cell.p < 0.001 ? '<.001' : cell.p.toFixed(3).replace(/^0/, '')})</span></>
    case 'r_only':
      return <>{rStr}</>
    case 'r_stars':
    default:
      return <>{rStr}{stars && <sup className="ml-0.5 text-[0.7em]">{stars}</sup>}</>
  }
}

export default function CorrelationMatrixTable({
  labels,
  fullLabels,
  matrix,
  sigLevels,
  bonferroni,
  adjustedAlpha,
  cellFormat,
  formatting,
  heatmapPreset,
}: CorrelationMatrixProps) {
  const { isDark } = useTheme()
  const k = labels.length
  const effectivePreset = heatmapPreset || 'diverging_blue_red'

  // Detect varying N
  const { minN, maxN, varyingN } = useMemo(() => {
    let min = Infinity
    let max = 0
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const n = matrix[i]?.[j]?.n ?? 0
        if (n > 0) {
          min = Math.min(min, n)
          max = Math.max(max, n)
        }
      }
    }
    if (min === Infinity) min = 0
    return { minN: min, maxN: max, varyingN: min !== max && min > 0 }
  }, [matrix, k])

  const cellFontSize = formatting?.axisFontSize ?? 13

  if (k < 2) {
    return (
      <div className="flex items-center justify-center p-8 text-mm-text-faint text-sm">
        Select 2 or more variables to see the correlation matrix.
      </div>
    )
  }

  return (
    <div>
      {/* Varying N warning */}
      {varyingN && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs">
          <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Pairwise deletion applied. Sample sizes vary from {minN} to {maxN} across pairs. Hover cells for per-pair n.</span>
        </div>
      )}

      {/* Bonferroni note */}
      {bonferroni && adjustedAlpha != null && (
        <div className="mb-3 px-3 py-1.5 rounded-md bg-mm-bg border border-mm-border-subtle text-xs text-mm-text-muted">
          Bonferroni adjusted &alpha; = {adjustedAlpha.toFixed(4)} for {k * (k - 1) / 2} comparisons
        </div>
      )}

      {/* Matrix table */}
      <ScrollableTable>
        <table className="border-collapse" style={{ fontSize: cellFontSize }}>
          <thead>
            <tr>
              <th className="p-0" />
              {labels.map((label, j) => (
                <th
                  key={j}
                  scope="col"
                  className="px-2 py-1.5 text-center font-medium text-mm-text-muted border-b border-mm-border-subtle"
                  style={{ maxWidth: 100, fontSize: cellFontSize - 1 }}
                  title={fullLabels[j]}
                >
                  <div className="truncate">{label}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((rowLabel, i) => (
              <tr key={i}>
                <th
                  scope="row"
                  className="px-2 py-1.5 text-right font-medium text-mm-text-muted border-r border-mm-border-subtle whitespace-nowrap"
                  style={{ fontSize: cellFontSize - 1 }}
                  title={fullLabels[i]}
                >
                  <div className="truncate max-w-[120px] ml-auto">{rowLabel}</div>
                </th>
                {labels.map((_colLabel, j) => {
                  const cell = matrix[i]?.[j]

                  // Upper triangle: empty
                  if (j > i) {
                    return <td key={j} className="border border-mm-border-subtle bg-mm-bg" />
                  }

                  // Diagonal
                  if (i === j) {
                    return (
                      <td
                        key={j}
                        className="px-2 py-1.5 text-center font-semibold border border-mm-border-subtle bg-mm-bg text-mm-text-muted"
                        aria-label={`${fullLabels[i]}: r = 1`}
                      >
                        1
                      </td>
                    )
                  }

                  // Lower triangle: correlation cell
                  if (!cell) {
                    return <td key={j} className="border border-mm-border-subtle" />
                  }

                  const style = getCorrCellStyle(cell.r, isDark, effectivePreset)

                  return (
                    <td
                      key={j}
                      className="px-2 py-1.5 text-center border border-mm-border-subtle transition-transform hover:scale-105 cursor-default tabular-nums"
                      style={{ ...style, minWidth: 52 }}
                      title={`r = ${cell.r.toFixed(2)}, ${formatPValue(cell.p)}, n = ${cell.n}`}
                      aria-label={`${fullLabels[i]} and ${fullLabels[j]}: r = ${cell.r.toFixed(2)}, p ${cell.p < 0.001 ? 'less than .001' : '= ' + formatP(cell.p)}, n = ${cell.n}`}
                    >
                      {formatCellContent(cell, cellFormat, sigLevels)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>

      {/* Footer legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mm-text-faint">
        {sigLevels.show_05 && <span>* p &lt; .05</span>}
        {sigLevels.show_01 && <span>** p &lt; .01</span>}
        {sigLevels.show_001 && <span>*** p &lt; .001</span>}
        <span className="text-mm-border-medium">|</span>
        <span>Hover cells for details</span>
      </div>
    </div>
  )
}
