import { useState, useMemo, useCallback, memo } from 'react'
import { getDivergingCellStyle, jitterOffset } from '@/lib/chart-data'
import { useTheme } from '@/lib/theme-context'
import type { ScatterPair, CorrelationCell } from '@/lib/api'
import ScatterPlotModal from './ScatterPlotModal'
import { ScrollableTable } from '@/components/ui/ScrollableTable'

interface ScatterMatrixProps {
  labels: string[]
  fullLabels: string[]
  pairs: ScatterPair[]
  /** Correlation matrix for upper triangle display */
  correlationMatrix?: CorrelationCell[][]
  showRegLine: boolean
  showJitter: boolean
  isLoading?: boolean
}

const MiniScatter = memo(function MiniScatter({
  pair,
  size,
  showRegLine,
  showJitter,
  onClick,
}: {
  pair: ScatterPair
  size: number
  showRegLine: boolean
  showJitter: boolean
  onClick: (pair: ScatterPair) => void
}) {
  const handleClick = useCallback(() => onClick(pair), [onClick, pair])
  const padding = 8
  const inner = size - padding * 2

  // Compute ranges
  const xMin = Math.min(...pair.x)
  const xMax = Math.max(...pair.x)
  const yMin = Math.min(...pair.y)
  const yMax = Math.max(...pair.y)
  const xRange = xMax - xMin || 1
  const yRange = yMax - yMin || 1

  const scaleX = (v: number) => padding + ((v - xMin) / xRange) * inner
  const scaleY = (v: number) => size - padding - ((v - yMin) / yRange) * inner

  return (
    <svg
      width={size}
      height={size}
      className="cursor-pointer focus:outline-2 focus:outline-[hsl(var(--mm-accent))] focus:outline-offset-[-2px] rounded-sm"
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() } }}
      tabIndex={0}
      role="button"
      aria-label={`Scatter: ${pair.x_label} vs ${pair.y_label}, r = ${pair.regression.r.toFixed(2)}, n = ${pair.n}. Press Enter to expand.`}
    >
      {/* Background */}
      <rect width={size} height={size} className="fill-mm-bg" rx={2} />

      {/* Data points */}
      {pair.x.map((xVal, i) => {
        const jx = showJitter ? jitterOffset(pair.record_ids[i]) * (xRange * 0.15) : 0
        const jy = showJitter ? jitterOffset(pair.record_ids[i] * 7) * (yRange * 0.15) : 0
        return (
          <circle
            key={i}
            cx={scaleX(xVal + jx)}
            cy={scaleY(pair.y[i] + jy)}
            r={2}
            className="fill-[hsl(var(--mm-accent))]"
            opacity={0.6}
          />
        )
      })}

      {/* Regression line */}
      {showRegLine && pair.n >= 3 && (
        <line
          x1={scaleX(xMin)}
          y1={scaleY(pair.regression.intercept + pair.regression.slope * xMin)}
          x2={scaleX(xMax)}
          y2={scaleY(pair.regression.intercept + pair.regression.slope * xMax)}
          className="stroke-mm-text"
          strokeWidth={1}
          strokeDasharray="3,2"
          opacity={0.5}
        />
      )}

      {/* R value in corner */}
      {showRegLine && (
        <text
          x={size - padding - 2}
          y={padding + 8}
          textAnchor="end"
          className="fill-mm-text-muted"
          fontSize={9}
          fontFamily="var(--font-mono, monospace)"
        >
          {pair.regression.r >= 0 ? '' : ''}{pair.regression.r.toFixed(2).replace(/^0/, '').replace(/^-0/, '-')}
        </text>
      )}
    </svg>
  )
})

function UpperTriangleCell({
  cell,
  size,
}: {
  cell: CorrelationCell | undefined
  size: number
}) {
  const { isDark } = useTheme()
  if (!cell) return <div style={{ width: size, height: size }} className="bg-mm-bg" />

  const style = getDivergingCellStyle(cell.r, isDark)
  const rStr = cell.r.toFixed(2).replace(/^0/, '').replace(/^-0/, '-')

  return (
    <div
      style={{ width: size, height: size, ...style }}
      className="flex items-center justify-center text-sm font-mono tabular-nums rounded-sm"
      title={`r = ${cell.r.toFixed(2)}, p = ${cell.p < 0.001 ? '<.001' : cell.p.toFixed(3)}, n = ${cell.n}`}
    >
      {rStr}
    </div>
  )
}

export default function ScatterMatrix({
  labels,
  fullLabels,
  pairs,
  correlationMatrix,
  showRegLine,
  showJitter,
  isLoading,
}: ScatterMatrixProps) {
  const [expandedPair, setExpandedPair] = useState<ScatterPair | null>(null)
  const k = labels.length

  // Build pair lookup: [i][j] → pair
  const pairMap = useMemo(() => {
    const map = new Map<string, ScatterPair>()
    for (const p of pairs) {
      map.set(`${p.x_index},${p.y_index}`, p)
    }
    return map
  }, [pairs])

  const cellSize = useMemo(() => {
    // Scale cells to fit available width, minimum 120px
    return Math.max(120, Math.min(160, Math.floor(800 / k)))
  }, [k])

  const handleCellClick = useCallback((pair: ScatterPair) => {
    setExpandedPair(pair)
  }, [])

  if (k < 2) return null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-mm-text-faint text-sm gap-2">
        <div className="animate-spin w-4 h-4 border-2 border-mm-accent border-t-transparent rounded-full" />
        Loading scatter data...
      </div>
    )
  }

  return (
    <>
      <ScrollableTable role="group" aria-label="Scatter matrix">
        <div
          className="inline-grid gap-px bg-mm-border-subtle"
          style={{ gridTemplateColumns: `repeat(${k}, ${cellSize}px)` }}
        >
          {Array.from({ length: k }, (_, i) =>
            Array.from({ length: k }, (_, j) => {
              const key = `${i}-${j}`

              // Diagonal: variable label
              if (i === j) {
                return (
                  <div
                    key={key}
                    className="flex items-center justify-center bg-mm-surface p-1 text-center"
                    style={{ width: cellSize, height: cellSize }}
                    aria-label={fullLabels[i]}
                    title={fullLabels[i]}
                  >
                    <span className="text-[11px] font-medium text-mm-text leading-tight line-clamp-3 break-words">
                      {labels[i]}
                    </span>
                  </div>
                )
              }

              // Upper triangle: r value with heatmap color
              if (j > i) {
                const cell = correlationMatrix?.[i]?.[j]
                return (
                  <div key={key} role="gridcell" aria-label={cell ? `r = ${cell.r.toFixed(2)}` : ''}>
                    <UpperTriangleCell cell={cell} size={cellSize} />
                  </div>
                )
              }

              // Lower triangle: scatterplot
              const pair = pairMap.get(`${j},${i}`) ?? pairMap.get(`${i},${j}`)
              if (!pair) {
                return (
                  <div
                    key={key}
                    className="bg-mm-surface flex items-center justify-center"
                    style={{ width: cellSize, height: cellSize }}
                  >
                    <span className="text-[10px] text-mm-text-faint">n/a</span>
                  </div>
                )
              }

              return (
                <div key={key} role="gridcell" aria-label={`Scatter: ${fullLabels[i]} vs ${fullLabels[j]}, r = ${pair.regression.r.toFixed(2)}, n = ${pair.n}`}>
                  <MiniScatter
                    pair={pair}
                    size={cellSize}
                    showRegLine={showRegLine}
                    showJitter={showJitter}
                    onClick={handleCellClick}
                  />
                </div>
              )
            })
          )}
        </div>
      </ScrollableTable>

      {/* Expanded modal */}
      {expandedPair && (
        <ScatterPlotModal
          pair={expandedPair}
          showRegLine={showRegLine}
          showJitter={showJitter}
          onClose={() => setExpandedPair(null)}
        />
      )}
    </>
  )
}
