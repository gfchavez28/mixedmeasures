import { useMemo, useRef, useState, useEffect } from 'react'
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ErrorBar,
  ReferenceLine,
} from 'recharts'
import type { LabelProps } from 'recharts'
import { DISPLAY_PRECISION, mergeFormatting, computeYAxisWidth, wrapLabel, resolveColorPalette, computeLogDomain } from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import type { BarDatum, ChartFormatting, VariableNMode, SortOrder } from '@/lib/chart-data'

interface HorizontalBarChartProps {
  data: BarDatum[]
  sortOrder?: SortOrder
  showPercentage?: boolean
  fixedDimensions?: { width: number; height: number }
  isAnimationActive?: boolean
  showVariableN?: VariableNMode
  chartN?: number
  showCI?: boolean
  formatting?: Partial<ChartFormatting>
  metricType?: string
  lineOverlay?: boolean
  axisTransform?: 'linear' | 'log'
}

function CustomTooltip({ active, payload, isLog }: { active?: boolean; payload?: { payload: BarDatum & { _ciLower?: number; _ciUpper?: number } }[]; isLog?: boolean }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as BarDatum & { _ciLower?: number; _ciUpper?: number }
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs">
      <div className="font-medium mb-1 text-mm-text">{d.label}</div>
      {d.percentage != null && <div>Percentage: {d.percentage.toFixed(DISPLAY_PRECISION)}%</div>}
      {d.count != null && <div>Count: {d.count}</div>}
      {isLog && d.value > 0 && (
        <div className="text-mm-text-muted">log₁₀ = {Math.log10(d.value).toFixed(2)}</div>
      )}
      {d._ciLower != null && d._ciUpper != null && (
        <div className="text-mm-text-muted">95% CI: [{d._ciLower.toFixed(DISPLAY_PRECISION)}, {d._ciUpper.toFixed(DISPLAY_PRECISION)}]</div>
      )}
      {d.n != null && <div className="text-mm-text-muted">n = {d.n}</div>}
    </div>
  )
}

export default function HorizontalBarChart({
  data,
  sortOrder: _sortOrder = 'desc',
  fixedDimensions,
  isAnimationActive = true,
  showVariableN = 'off',
  chartN,
  showCI = false,
  formatting: fmtProp,
  metricType,
  lineOverlay = false,
  axisTransform = 'linear',
}: HorizontalBarChartProps) {
  const fmt = mergeFormatting(fmtProp)
  const colors = useChartColors()
  const fallbackPalette = useMemo(() => resolveColorPalette(fmt.colorPalette), [fmt.colorPalette])
  const suffix = metricType === 'mean' || metricType === 'domain_aggregate' ? '' : '%'
  const sorted = useMemo(() => {
    // Variable ordering is handled upstream by orderedMetrics; just add CI error range
    return data.map(d => {
      const hasCI = showCI && d.ciLower != null && d.ciUpper != null
      return {
        ...d,
        _ciLower: d.ciLower,
        _ciUpper: d.ciUpper,
        errorRange: hasCI ? [d.value - d.ciLower!, d.ciUpper! - d.value] : undefined,
      }
    })
  }, [data, showCI])

  // Log scale: filter non-positive values and compute domain
  const isLog = axisTransform === 'log'
  const logFiltered = useMemo(() => {
    if (!isLog) return sorted
    return sorted.filter(d => d.value > 0)
  }, [sorted, isLog])
  const logExcludedCount = isLog ? sorted.length - logFiltered.length : 0
  const logDomain = useMemo(() => {
    if (!isLog) return null
    return computeLogDomain(logFiltered.map(d => d.value))
  }, [isLog, logFiltered])

  const chartData = isLog ? logFiltered : sorted

  // Container measurement for data-width mode
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number>(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let rafId: number | null = null
    const ro = new ResizeObserver(entries => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        for (const entry of entries) setContainerWidth(entry.contentRect.width)
      })
    })
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [])

  const overrideWidth = computeYAxisWidth(containerWidth, fmt.dataWidth)

  const yAxisWidth = useMemo(() => {
    if (overrideWidth != null) return overrideWidth
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map(d => d.label.length))
    return Math.min(350, Math.max(120, longest * 7))
  }, [chartData, overrideWidth])

  // Max characters per line for label wrapping (approximate: 1 char ≈ 0.6 * fontSize)
  const maxCharsPerLine = useMemo(() => {
    const charWidth = fmt.labelFontSize * 0.6
    return Math.max(10, Math.floor((yAxisWidth - 8) / charWidth))
  }, [yAxisWidth, fmt.labelFontSize])

  // Compute XAxis domain, accounting for CI upper bounds and explicit axis range
  const xDomainMin = isLog && logDomain ? logDomain[0] : fmt.xAxisMin
  const xDomainMax = useMemo(() => {
    if (isLog && logDomain) return logDomain[1]
    if (fmt.xAxisMax != null) return fmt.xAxisMax
    if (!showCI) return undefined  // let recharts auto-compute
    let max = 0
    for (const d of chartData) {
      if (d.value > max) max = d.value
      if (d._ciUpper != null && d._ciUpper > max) max = d._ciUpper
    }
    return max > 0 ? Math.ceil(max * 1.05) : undefined  // 5% padding
  }, [chartData, showCI, fmt.xAxisMax, isLog, logDomain])

  // Row height increases when labels wrap to multiple lines
  const rowHeight = Math.max(36, Math.max(...chartData.map(d => wrapLabel(d.label, maxCharsPerLine).length)) * (fmt.labelFontSize + 4) + 8)
  const chartHeight = Math.max(300, chartData.length * rowHeight)

  if (chartData.length === 0) return null

  const barChart = (
    <ComposedChart
      layout="vertical"
      data={chartData}
      margin={{ top: 4, right: fmt.dataLabels === 'none' ? 40 : 70, bottom: 4, left: 0 }}
      {...(fixedDimensions ? { width: fixedDimensions.width, height: fixedDimensions.height } : {})}
    >
      <CartesianGrid stroke={colors.grid} horizontal={false} />
      <XAxis
        type="number"
        tick={{ fontSize: fmt.axisFontSize, fill: colors.text }}
        axisLine={{ stroke: colors.axis }}
        tickLine={{ stroke: colors.axis }}
        tickFormatter={(v: number) => `${v}${suffix}`}
        domain={xDomainMax != null || xDomainMin != null ? [xDomainMin ?? 0, xDomainMax ?? 'auto'] : undefined}
        {...(isLog && logDomain ? { scale: 'log', allowDataOverflow: true } : {})}
      />
      <YAxis
        type="category"
        dataKey="label"
        width={yAxisWidth}
        tick={(props: Record<string, unknown>) => {
          const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
          const label = payload.value
          const fullLabel = chartData.find(d => d.label === label)?.fullLabel || label
          const lines = wrapLabel(label, maxCharsPerLine)
          const lineHeight = fmt.labelFontSize + 2
          const startY = y - ((lines.length - 1) * lineHeight) / 2
          return (
            <g>
              <title>{fullLabel}</title>
              {lines.map((line, i) => (
                <text
                  key={i}
                  x={x}
                  y={startY + i * lineHeight}
                  textAnchor="end"
                  fill={colors.text}
                  style={{ fontSize: fmt.labelFontSize }}
                  dominantBaseline="central"
                >
                  {line}
                </text>
              ))}
            </g>
          )
        }}
        axisLine={{ stroke: colors.axis }}
        tickLine={false}
      />
      <Tooltip content={<CustomTooltip isLog={isLog} />} />
      {fmt.referenceLine != null && (
        <ReferenceLine
          x={fmt.referenceLine}
          stroke={colors.reference}
          strokeDasharray="4 3"
          strokeWidth={1.5}
          label={{ value: String(fmt.referenceLine), fontSize: fmt.dataLabelFontSize, fill: colors.textMuted, position: 'top' }}
        />
      )}
      <Bar
        dataKey="value"
        radius={[0, 2, 2, 0]}
        barSize={fmt.barSize}
        isAnimationActive={isAnimationActive}
        label={(props: LabelProps) => {
          const { x, y, width, height, index } = props as unknown as { x: number; y: number; width: number; height: number; index: number }
          const entry = chartData[index]
          if (!entry) return null

          const showDataLabel = fmt.dataLabels !== 'none'
          const showN = showVariableN !== 'off' && entry.n != null && !(showVariableN === 'differing' && entry.n === chartN)

          if (!showDataLabel && !showN) return null

          const barEnd = x + width
          const cy = y + height / 2

          if (fmt.dataLabels === 'inside') {
            // Data label inside bar, question N outside
            return (
              <g aria-hidden="true">
                {showDataLabel && width > 40 && (
                  <text
                    x={barEnd - 6}
                    y={cy + 4}
                    textAnchor="end"
                    fill="#fff"
                    style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
                  >
                    {entry.value.toFixed(DISPLAY_PRECISION)}{suffix}
                  </text>
                )}
                {showN && (
                  <text
                    x={barEnd + 4}
                    y={cy + 4}
                    fill={colors.textMuted}
                    style={{ fontSize: fmt.dataLabelFontSize }}
                  >
                    (n={entry.n})
                  </text>
                )}
              </g>
            )
          }

          // Outside (default) or none — data label right of bar, question N after
          const dataLabelText = showDataLabel ? `${entry.value.toFixed(DISPLAY_PRECISION)}${suffix}` : ''
          const dataLabelWidth = showDataLabel ? dataLabelText.length * fmt.dataLabelFontSize * 0.6 + 4 : 0

          return (
            <g aria-hidden="true">
              {showDataLabel && (
                <text
                  x={barEnd + 4}
                  y={cy + 4}
                  fill={colors.text}
                  style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
                >
                  {dataLabelText}
                </text>
              )}
              {showN && (
                <text
                  x={barEnd + 4 + dataLabelWidth}
                  y={cy + 4}
                  fill={colors.textMuted}
                  style={{ fontSize: fmt.dataLabelFontSize }}
                >
                  (n={entry.n})
                </text>
              )}
            </g>
          )
        }}
      >
        {chartData.map((entry, i) => (
          <Cell
            key={entry.label}
            fill={entry.color || fallbackPalette[i % fallbackPalette.length]}
          />
        ))}
        {showCI && (
          <ErrorBar
            dataKey="errorRange"
            direction="x"
            width={3}
            stroke={colors.reference}
            strokeWidth={1.5}
          />
        )}
      </Bar>
      {lineOverlay && (
        <Line
          dataKey="value"
          type="linear"
          stroke={colors.lineOverlay}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      )}
    </ComposedChart>
  )

  return (
    <div ref={containerRef} role="img" aria-label="Horizontal bar chart">
      {isLog && logExcludedCount > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 mb-2">
          {logExcludedCount} value{logExcludedCount > 1 ? 's' : ''} ≤ 0 excluded from log scale
        </div>
      )}
      {fixedDimensions ? barChart : (
        <ResponsiveContainer width="100%" height={chartHeight}>
          {barChart}
        </ResponsiveContainer>
      )}
      {isLog && (
        <div className="text-[11px] text-mm-text-faint mt-1 text-right">Log scale</div>
      )}
    </div>
  )
}
