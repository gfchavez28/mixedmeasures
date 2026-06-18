import { useMemo } from 'react'
import type { DumbbellData, ChartFormatting, VariableNMode } from '@/lib/chart-data'
import { DISPLAY_PRECISION, mergeFormatting, resolveGroupColors, resolveGroupTextColors, computeLogDomain } from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'

interface DumbbellChartProps {
  data: DumbbellData
  xAxisMax?: number
  showLegend?: boolean
  showGroupN?: boolean
  showVariableN?: VariableNMode
  chartN?: number
  groupNs?: Record<string, number>
  hasVaryingGroupN?: Record<string, boolean>
  showCI?: boolean
  formatting?: Partial<ChartFormatting>
  metricType?: string
  axisTransform?: 'linear' | 'log'
}

const LEFT_MARGIN = 220
const RIGHT_MARGIN = 50
const BASE_ROW_HEIGHT = 48
const GROUPED_ROW_HEIGHT = 56
const BASE_TOP_PADDING = 40
const LEGEND_ROW_HEIGHT = 20
const BOTTOM_PADDING = 40
const AXIS_Y_OFFSET = 20

function Diamond({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) {
  const points = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
  return <polygon points={points} fill={fill} />
}

function DotShape({ shape, cx, cy, r, fill }: { shape: number; cx: number; cy: number; r: number; fill: string }) {
  if (shape === 1) return <Diamond cx={cx} cy={cy} r={r} fill={fill} />
  if (shape === 2) return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={fill} />
  if (shape === 3) {
    // Triangle
    const points = `${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}`
    return <polygon points={points} fill={fill} />
  }
  return <circle cx={cx} cy={cy} r={r} fill={fill} />
}

/**
 * Compute vertical jitter offsets for dots that overlap on the x-axis.
 * Dots within `threshold` pixels of each other are grouped into clusters
 * and spread symmetrically around the row centerline.
 */
function computeJitterOffsets(
  pixelXs: number[],
  threshold: number,
  step: number,
): number[] {
  const offsets = new Array(pixelXs.length).fill(0)
  const assigned = new Set<number>()

  for (let i = 0; i < pixelXs.length; i++) {
    if (assigned.has(i)) continue
    // Build cluster: all dots within threshold of any cluster member
    const cluster = [i]
    assigned.add(i)
    for (let j = i + 1; j < pixelXs.length; j++) {
      if (assigned.has(j)) continue
      if (cluster.some(ci => Math.abs(pixelXs[j] - pixelXs[ci]) < threshold)) {
        cluster.push(j)
        assigned.add(j)
      }
    }
    if (cluster.length <= 1) continue
    const totalSpan = (cluster.length - 1) * step
    cluster.forEach((idx, pos) => {
      offsets[idx] = -totalSpan / 2 + pos * step
    })
  }
  return offsets
}

export default function DumbbellChart({
  data,
  xAxisMax: xAxisMaxProp,
  showLegend = true,
  showGroupN = false,
  showVariableN = 'off',
  chartN,
  groupNs,
  hasVaryingGroupN,
  showCI = false,
  formatting: fmtProp,
  metricType,
  axisTransform = 'linear',
}: DumbbellChartProps) {
  const fmt = mergeFormatting(fmtProp)
  const colors = useChartColors()
  const suffix = metricType === 'mean' || metricType === 'domain_aggregate' ? '' : '%'
  const DOT_RADIUS = fmt.pointSize + 1 // pointSize=5 → DOT_RADIUS=6 (original default)
  const { rows, groupValues } = data
  const groupColors = useMemo(
    () => resolveGroupColors(groupValues, fmt.colorPalette),
    [groupValues, fmt.colorPalette],
  )

  const groupTextColors = useMemo(
    () => resolveGroupTextColors(groupValues, fmt.colorPalette),
    [groupValues, fmt.colorPalette],
  )

  const isLog = axisTransform === 'log'

  // Use taller rows when dots need jitter (multiple groups)
  const hasGroupedDots = rows.some(r => r.dots.length > 1)
  const rowHeight = hasGroupedDots ? GROUPED_ROW_HEIGHT : BASE_ROW_HEIGHT

  // Log scale: compute domain from all positive dot values
  const logDomain = useMemo(() => {
    if (!isLog) return null
    const values: number[] = []
    for (const row of rows) {
      for (const dot of row.dots) {
        if (dot.value > 0) values.push(dot.value)
      }
    }
    return computeLogDomain(values)
  }, [isLog, rows])

  const logExcludedCount = useMemo(() => {
    if (!isLog) return 0
    let count = 0
    for (const row of rows) {
      for (const dot of row.dots) {
        if (dot.value <= 0) count++
      }
    }
    return count
  }, [isLog, rows])

  // Filter rows where ALL dots are non-positive in log mode
  const filteredRows = useMemo(() => {
    if (!isLog) return rows
    return rows.filter(r => r.dots.some(d => d.value > 0))
  }, [isLog, rows])

  const xMin = isLog && logDomain ? logDomain[0] : (fmt.xAxisMin ?? 0)

  const xMax = useMemo(() => {
    if (isLog && logDomain) return logDomain[1]
    if (fmt.xAxisMax != null) return fmt.xAxisMax
    if (xAxisMaxProp != null) return xAxisMaxProp
    let max = 0
    for (const row of rows) {
      for (const dot of row.dots) {
        if (dot.value > max) max = dot.value
        if (showCI && dot.ciUpper != null && dot.ciUpper > max) max = dot.ciUpper
      }
    }
    return Math.ceil(max / 10) * 10 || 100
  }, [rows, xAxisMaxProp, showCI, fmt.xAxisMax, isLog, logDomain])

  const chartWidth = 700
  const plotWidth = chartWidth - LEFT_MARGIN - RIGHT_MARGIN

  // ── Legend row layout ──────────────────────────────────────────────
  const legendRows = useMemo(() => {
    if (!showLegend || groupValues.length === 0) return []
    const legendFontSize = fmt.labelFontSize - 1
    const charWidth = legendFontSize * 0.6
    const dotWidth = fmt.pointSize * 2
    const itemGap = 16

    const items = groupValues.map((gv, gi) => {
      const nSuffix = showGroupN && groupNs?.[gv] != null
        ? ` (n=${groupNs[gv]}${hasVaryingGroupN?.[gv] ? '*' : ''})`
        : ''
      const fullText = gv + nSuffix
      const textWidth = fullText.length * charWidth
      const totalWidth = dotWidth + 10 + textWidth + itemGap
      return { gv, gi, fullText, totalWidth }
    })

    // Bin items into rows that fit within plotWidth
    const binned: typeof items[] = []
    let currentRow: typeof items = []
    let currentWidth = 0
    for (const item of items) {
      if (currentRow.length > 0 && currentWidth + item.totalWidth > plotWidth) {
        binned.push(currentRow)
        currentRow = [item]
        currentWidth = item.totalWidth
      } else {
        currentRow.push(item)
        currentWidth += item.totalWidth
      }
    }
    if (currentRow.length > 0) binned.push(currentRow)
    return binned
  }, [showLegend, groupValues, showGroupN, groupNs, hasVaryingGroupN, fmt.labelFontSize, fmt.pointSize, plotWidth])

  const topPadding = legendRows.length > 0 ? BASE_TOP_PADDING + (legendRows.length - 1) * LEGEND_ROW_HEIGHT : BASE_TOP_PADDING
  const chartHeight = Math.max(200, filteredRows.length * rowHeight + topPadding + BOTTOM_PADDING)
  const plotTop = topPadding
  const plotBottom = chartHeight - BOTTOM_PADDING

  const xScale = useMemo(() => {
    if (isLog && xMin > 0 && xMax > xMin) {
      const logMin = Math.log10(xMin)
      const logMax = Math.log10(xMax)
      const logRange = logMax - logMin || 1
      return (v: number) => LEFT_MARGIN + ((Math.log10(Math.max(v, xMin)) - logMin) / logRange) * plotWidth
    }
    const xRange = xMax - xMin
    return (v: number) => LEFT_MARGIN + ((v - xMin) / (xRange || 1)) * plotWidth
  }, [isLog, xMin, xMax, plotWidth])

  const ticks = useMemo(() => {
    if (isLog && xMin > 0) {
      // Log ticks: powers of 10 and midpoints
      const logMin = Math.floor(Math.log10(xMin))
      const logMax = Math.ceil(Math.log10(xMax))
      const arr: number[] = []
      for (let p = logMin; p <= logMax; p++) {
        const val = Math.pow(10, p)
        if (val >= xMin && val <= xMax) arr.push(val)
        // Add midpoint (5 * 10^p) for readability
        const mid = 5 * Math.pow(10, p - 1)
        if (mid >= xMin && mid <= xMax && !arr.includes(mid)) arr.push(mid)
      }
      arr.sort((a, b) => a - b)
      if (arr.length === 0) arr.push(xMin, xMax)
      return arr
    }
    const range = xMax - xMin
    const step = range <= 20 ? 5 : range <= 50 ? 10 : 20
    const arr: number[] = []
    const start = Math.ceil(xMin / step) * step
    for (let t = start; t <= xMax; t += step) arr.push(t)
    if (arr.length === 0 || arr[0] !== xMin) arr.unshift(xMin)
    return arr
  }, [xMax, xMin, isLog])

  if (filteredRows.length === 0) return null

  return (
    <div role="img" aria-label="Dumbbell comparison chart">
      {isLog && logExcludedCount > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 mb-2">
          {logExcludedCount} value{logExcludedCount > 1 ? 's' : ''} ≤ 0 excluded from log scale
        </div>
      )}
      <svg
        width="100%"
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        style={{ maxWidth: chartWidth, fontSize: fmt.labelFontSize }}
      >
        <title>Dumbbell comparison chart</title>

        {/* Legend — wraps to multiple rows when items overflow */}
        {legendRows.length > 0 && (() => {
          const legendFontSize = fmt.labelFontSize - 1
          return (
            <g transform={`translate(${LEFT_MARGIN}, 12)`}>
              {legendRows.map((rowItems, rowIdx) => {
                let xOff = 0
                return (
                  <g key={rowIdx} transform={`translate(0, ${rowIdx * LEGEND_ROW_HEIGHT})`}>
                    {rowItems.map(item => {
                      const color = groupColors[item.gv]
                      const x = xOff
                      xOff += item.totalWidth
                      return (
                        <g key={item.gv} transform={`translate(${x}, 0)`}>
                          <DotShape shape={item.gi} cx={6} cy={6} r={fmt.pointSize} fill={color} />
                          <text x={16} y={10} fill={groupTextColors[item.gv]} style={{ fontSize: legendFontSize }}>
                            {item.fullText}
                          </text>
                        </g>
                      )
                    })}
                  </g>
                )
              })}
            </g>
          )
        })()}

        {/* Grid lines */}
        {ticks.map(t => (
          <line
            key={t}
            x1={xScale(t)}
            y1={plotTop}
            x2={xScale(t)}
            y2={plotBottom}
            stroke={colors.grid}
            strokeWidth={1}
          />
        ))}

        {/* X axis */}
        <line
          x1={LEFT_MARGIN}
          y1={plotBottom}
          x2={LEFT_MARGIN + plotWidth}
          y2={plotBottom}
          stroke={colors.axis}
          strokeWidth={1}
        />
        {ticks.map(t => (
          <text
            key={t}
            x={xScale(t)}
            y={plotBottom + AXIS_Y_OFFSET}
            textAnchor="middle"
            fill={colors.text}
            style={{ fontSize: fmt.axisFontSize - 1 }}
          >
            {t}{suffix}
          </text>
        ))}

        {/* Reference line */}
        {fmt.referenceLine != null && (
          <g>
            <line
              x1={xScale(fmt.referenceLine)}
              y1={plotTop}
              x2={xScale(fmt.referenceLine)}
              y2={plotBottom}
              stroke={colors.reference}
              strokeWidth={1.5}
              strokeDasharray="4,3"
            />
            <text
              x={xScale(fmt.referenceLine)}
              y={plotTop - 4}
              textAnchor="middle"
              fill={colors.textMuted}
              style={{ fontSize: fmt.dataLabelFontSize }}
            >
              {fmt.referenceLine}
            </text>
          </g>
        )}

        {/* Rows */}
        {filteredRows.map((row, ri) => {
          const y = plotTop + ri * rowHeight + rowHeight / 2
          const dotValues = row.dots.map(d => d.value)
          const minVal = Math.min(...dotValues)
          const maxVal = Math.max(...dotValues)

          // Compute jitter offsets for overlapping dots
          const pixelXs = row.dots.map(d => xScale(d.value))
          const jitterStep = DOT_RADIUS + 4
          const jitterOffsets = computeJitterOffsets(pixelXs, DOT_RADIUS * 2, jitterStep)
          const isJittered = jitterOffsets.some(o => o !== 0)

          return (
            <g key={row.metricId}>
              {/* Row label */}
              <text
                x={LEFT_MARGIN - 12}
                y={y + 4}
                textAnchor="end"
                fill={colors.text}
                style={{ fontSize: fmt.labelFontSize }}
              >
                {row.label.length > 35 && <title>{row.fullLabel || row.label}</title>}
                {row.label.length > 35 ? row.label.slice(0, 32) + '...' : row.label}
              </text>

              {/* Connecting line — stays on row centerline */}
              {row.dots.length > 1 && minVal !== maxVal && (
                <line
                  x1={xScale(minVal)}
                  y1={y}
                  x2={xScale(maxVal)}
                  y2={y}
                  stroke={colors.axis}
                  strokeWidth={2}
                />
              )}

              {/* Dots */}
              {row.dots.map((dot, di) => {
                const gi = groupValues.indexOf(dot.groupValue)
                const color = groupColors[dot.groupValue]
                const cx = xScale(dot.value)
                const dy = y + jitterOffsets[di]
                const refN = groupNs?.[dot.groupValue] ?? chartN
                // Suppress per-question n when jittered (too cluttered; n is in tooltip + legend)
                const showN = !isJittered && (showVariableN === 'all' ||
                  (showVariableN === 'differing' && refN != null && dot.n !== refN))
                const hasCI = showCI && dot.ciLower != null && dot.ciUpper != null
                const logSuffix = isLog && dot.value > 0 ? `, log₁₀ = ${Math.log10(dot.value).toFixed(2)}` : ''
                const ciTitle = hasCI
                  ? `${dot.groupValue}: ${dot.value.toFixed(DISPLAY_PRECISION)}${suffix}${logSuffix}, 95% CI: [${dot.ciLower!.toFixed(DISPLAY_PRECISION)}${suffix}, ${dot.ciUpper!.toFixed(DISPLAY_PRECISION)}${suffix}], n = ${dot.n}`
                  : `${dot.groupValue}: ${dot.value.toFixed(DISPLAY_PRECISION)}${suffix}${logSuffix}, n = ${dot.n}`

                // Label positioning: when jittered, spread labels to avoid collisions
                // Top dot → label above, bottom dot → label below, middle → right side
                let labelX = cx
                let labelY = dy - DOT_RADIUS - 6
                let labelAnchor: 'middle' | 'start' = 'middle'
                if (isJittered && row.dots.length > 1) {
                  if (jitterOffsets[di] === Math.min(...jitterOffsets)) {
                    // Topmost dot: label above
                    labelY = dy - DOT_RADIUS - 6
                  } else if (jitterOffsets[di] === Math.max(...jitterOffsets)) {
                    // Bottommost dot: label below
                    labelY = dy + DOT_RADIUS + fmt.dataLabelFontSize
                  } else {
                    // Middle dot: label to the right
                    labelX = cx + DOT_RADIUS + 4
                    labelY = dy + fmt.dataLabelFontSize / 3
                    labelAnchor = 'start'
                  }
                }

                return (
                  <g key={dot.groupValue}>
                    <title>{ciTitle}</title>
                    {/* CI whisker lines — follow jittered y */}
                    {hasCI && (
                      <g aria-label={`95% confidence interval: ${dot.ciLower!.toFixed(DISPLAY_PRECISION)} to ${dot.ciUpper!.toFixed(DISPLAY_PRECISION)}`}>
                        <line
                          x1={xScale(dot.ciLower!)} y1={dy}
                          x2={xScale(dot.ciUpper!)} y2={dy}
                          stroke={colors.reference} strokeWidth={1.5} strokeDasharray="3,2"
                        />
                        <line
                          x1={xScale(dot.ciLower!)} y1={dy - 3}
                          x2={xScale(dot.ciLower!)} y2={dy + 3}
                          stroke={colors.reference} strokeWidth={1.5}
                        />
                        <line
                          x1={xScale(dot.ciUpper!)} y1={dy - 3}
                          x2={xScale(dot.ciUpper!)} y2={dy + 3}
                          stroke={colors.reference} strokeWidth={1.5}
                        />
                      </g>
                    )}
                    <DotShape shape={gi} cx={cx} cy={dy} r={DOT_RADIUS} fill={color} />
                    <text
                      x={labelX}
                      y={labelY}
                      textAnchor={labelAnchor}
                      fill={colors.textDark}
                      style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 600 }}
                    >
                      {dot.value.toFixed(DISPLAY_PRECISION)}{suffix}
                    </text>
                    {showN && (
                      <text
                        x={cx}
                        y={dy + DOT_RADIUS + 10}
                        textAnchor="middle"
                        fill={colors.textMuted}
                        style={{ fontSize: fmt.dataLabelFontSize - 2 }}
                      >
                        n={dot.n}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      {isLog && (
        <div className="text-[11px] text-mm-text-faint mt-1 text-right">Log scale</div>
      )}
    </div>
  )
}
