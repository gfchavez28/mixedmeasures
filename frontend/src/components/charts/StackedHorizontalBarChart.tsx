import { useMemo, useRef, useState, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import type { LabelProps } from 'recharts'
import { DISPLAY_PRECISION, mergeFormatting, computeYAxisWidth, wrapLabel } from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import type { StackedBarData, DivergingStackedBarData, ChartFormatting, VariableNMode, SortOrder } from '@/lib/chart-data'
import type { RechartsTooltipProps, RechartsPayloadEntry, ChartDataRow } from '@/lib/chart-types'

interface StackedHorizontalBarChartProps {
  data: StackedBarData
  mode: '100%' | 'count'
  sortOrder?: SortOrder
  showVariableN?: VariableNMode
  chartN?: number
  formatting?: Partial<ChartFormatting>
  divergingData?: DivergingStackedBarData | null
}

function CustomTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  // Hide tooltip for separator rows
  if (payload[0]?.payload._metricId === -1) return null
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {payload.map((entry: RechartsPayloadEntry) => (
        <div key={entry.name} className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-sm flex-shrink-0"
            style={{ backgroundColor: entry.fill }}
          />
          <span className="text-mm-text-secondary">{entry.name}:</span>
          <span className="font-medium">
            {(entry.payload[`_count_${entry.name}`] as number) ?? entry.value}
            {entry.payload[`_pct_${entry.name}`] != null && (
              <span className="text-mm-text-faint ml-1">
                ({(entry.payload[`_pct_${entry.name}`] as number).toFixed(DISPLAY_PRECISION)}%)
              </span>
            )}
          </span>
        </div>
      ))}
      {payload[0]?.payload._totalN != null && (
        <div className="text-mm-text-faint mt-1 pt-1 border-t">n = {payload[0].payload._totalN as number}</div>
      )}
    </div>
  )
}

function DivergingTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  if (payload[0]?.payload._metricId === -1) return null
  const row = payload[0]?.payload
  if (!row) return null
  // Collect all unique labels from the rendered payload (dedupe center halves)
  const seenLabels = new Set<string>()
  const items: { label: string; pct: number; count: number; fill: string }[] = []
  for (const entry of payload) {
    // Strip _left/_right suffix for center label deduplication
    let displayName = entry.name as string
    if (displayName.endsWith('_left') || displayName.endsWith('_right')) {
      displayName = displayName.replace(/_left$|_right$/, '')
    }
    if (seenLabels.has(displayName)) continue
    seenLabels.add(displayName)
    items.push({
      label: displayName,
      pct: (row[`_pct_${displayName}`] as number) ?? Math.abs(Number(entry.value) || 0),
      count: (row[`_count_${displayName}`] as number) ?? 0,
      fill: entry.fill ?? '',
    })
  }
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {items.map(item => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: item.fill }} />
          <span className="text-mm-text-secondary">{item.label}:</span>
          <span className="font-medium">
            {item.count}
            <span className="text-mm-text-faint ml-1">({item.pct.toFixed(DISPLAY_PRECISION)}%)</span>
          </span>
        </div>
      ))}
      {row._totalN != null && (
        <div className="text-mm-text-faint mt-1 pt-1 border-t">n = {row._totalN as number}</div>
      )}
    </div>
  )
}

export default function StackedHorizontalBarChart({
  data,
  mode,
  sortOrder: _sortOrder = 'none',
  showVariableN = 'off',
  chartN,
  formatting: fmtProp,
  divergingData,
}: StackedHorizontalBarChartProps) {
  const fmt = mergeFormatting(fmtProp)

  // ── Diverging rendering path ──────────────────────────────────────────
  if (divergingData) {
    return (
      <DivergingRenderer
        data={divergingData}
        showVariableN={showVariableN}
        chartN={chartN}
        fmt={fmt}
      />
    )
  }

  // ── Standard stacked bar rendering ────────────────────────────────────
  return (
    <StandardRenderer
      data={data}
      mode={mode}
      showVariableN={showVariableN}
      chartN={chartN}
      fmt={fmt}
    />
  )
}

// ── Standard (non-diverging) renderer ───────────────────────────────────────

function StandardRenderer({
  data,
  mode,
  showVariableN,
  chartN,
  fmt,
}: {
  data: StackedBarData
  mode: '100%' | 'count'
  showVariableN: VariableNMode
  chartN?: number
  fmt: ChartFormatting
}) {
  const { rows, responseLabels, colors } = data
  const chartTheme = useChartColors()
  const isGrouped = useMemo(() => rows.some(r => r.groupLabel), [rows])

  const chartData = useMemo(() => {
    const processed = rows.map(row => {
      const entry: ChartDataRow = {
        label: row.label,
        _fullLabel: row.fullLabel,
        _metricLabel: row.metricLabel,
        _groupColor: row.groupColor,
        _totalN: row.totalN,
        _metricId: row.metricId,
        _groupLabel: row.groupLabel,
        _isGroupEnd: row.isGroupEnd,
      }
      for (const seg of row.segments) {
        entry[seg.label] = mode === '100%' ? seg.percentage : seg.count
        entry[`_count_${seg.label}`] = seg.count
        entry[`_pct_${seg.label}`] = seg.percentage
      }
      return entry
    })

    if (isGrouped) {
      const withSeparators: typeof processed = []
      for (let i = 0; i < processed.length; i++) {
        withSeparators.push(processed[i])
        if (processed[i]._isGroupEnd && i < processed.length - 1) {
          const separator: ChartDataRow = {
            label: ` ‎${i}`,
            _totalN: 0,
            _metricId: -1,
          }
          for (const rl of responseLabels) {
            separator[rl] = 0
            separator[`_count_${rl}`] = 0
            separator[`_pct_${rl}`] = 0
          }
          withSeparators.push(separator)
        }
      }
      return withSeparators
    }

    return processed
  }, [rows, mode, responseLabels, isGrouped])

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number>(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const overrideWidth = computeYAxisWidth(containerWidth, fmt.dataWidth)

  const yAxisWidth = useMemo(() => {
    if (overrideWidth != null) return overrideWidth
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map((d) => ((d._metricLabel || d.label) as string).length))
    return Math.min(350, Math.max(120, longest * 7))
  }, [chartData, overrideWidth])

  const maxCharsPerLine = useMemo(() => {
    const charWidth = fmt.labelFontSize * 0.6
    return Math.max(10, Math.floor((yAxisWidth - 8) / charWidth))
  }, [yAxisWidth, fmt.labelFontSize])

  const groupIndicatorHeight = isGrouped ? (fmt.labelFontSize - 1) + 6 : 0
  const rowHeight = Math.max(36, Math.max(...chartData.map((d) => {
    const label = (d._metricLabel || d.label) as string
    return wrapLabel(label, maxCharsPerLine).length
  })) * (fmt.labelFontSize + 4) + 8 + groupIndicatorHeight)
  const chartHeight = Math.max(300, chartData.length * rowHeight)

  if (chartData.length === 0 || responseLabels.length === 0) return null

  return (
    <div ref={containerRef} role="img" aria-label="Stacked horizontal bar chart">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 40, bottom: 4, left: 0 }}
        >
          <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: fmt.axisFontSize, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={{ stroke: chartTheme.axis }}
            domain={mode === '100%' ? [0, 100] : undefined}
            label={
              mode === '100%'
                ? { value: '%', position: 'insideBottomRight', offset: -4, fontSize: fmt.axisFontSize - 1, fill: chartTheme.textMuted }
                : undefined
            }
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={(props: Record<string, unknown>) => <StackedYAxisTick {...(props as StackedYAxisTickProps)} chartData={chartData} showVariableN={showVariableN} chartN={chartN} fmt={fmt} maxCharsPerLine={maxCharsPerLine} isGrouped={isGrouped} colors={chartTheme} />}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={false}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            content={() => (
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '12px', fontSize: fmt.labelFontSize - 1, color: chartTheme.text, paddingTop: 8 }}>
                {responseLabels.map(label => (
                  <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors[label], flexShrink: 0 }} />
                    {label}
                  </span>
                ))}
              </div>
            )}
          />
          {responseLabels.map(label => (
            <Bar
              key={label}
              dataKey={label}
              stackId="stack"
              fill={colors[label]}
              barSize={fmt.barSize}
              isAnimationActive={false}
              label={fmt.dataLabels === 'none' ? false : (props: LabelProps) => {
                const { x, y, width, height, index } = props as unknown as { x: number; y: number; width: number; height: number; index: number }
                const row = chartData[index]
                if (!row || row._metricId === -1) return null
                if (width < 40) return null
                const val = mode === '100%'
                  ? row[`_pct_${label}`] as number | undefined
                  : row[`_count_${label}`] as number | undefined
                if (val == null || val === 0) return null
                const cx = x + width / 2
                const cy = y + height / 2
                const valSuffix = mode === '100%' ? '%' : ''
                const precision = mode === '100%' ? DISPLAY_PRECISION : 0
                return (
                  <text
                    x={cx}
                    y={cy + 4}
                    textAnchor="middle"
                    fill="#fff"
                    style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
                    aria-hidden="true"
                  >
                    {val.toFixed(precision)}{valSuffix}
                  </text>
                )
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Diverging renderer ──────────────────────────────────────────────────────

function DivergingRenderer({
  data,
  showVariableN,
  chartN,
  fmt,
}: {
  data: DivergingStackedBarData
  showVariableN: VariableNMode
  chartN?: number
  fmt: ChartFormatting
}) {
  const { rows, responseLabels, leftLabels, rightLabels, centerLabel, centerMode, colors, maxExtent, hasMixedScales } = data
  const chartTheme = useChartColors()
  const isGrouped = useMemo(() => rows.some(r => r.groupLabel), [rows])

  const chartData = useMemo(() => {
    const processed = rows.map(row => {
      const entry: ChartDataRow = {
        label: row.label,
        _fullLabel: row.fullLabel,
        _metricLabel: row.metricLabel,
        _groupColor: row.groupColor,
        _totalN: row.totalN,
        _metricId: row.metricId,
        _groupLabel: row.groupLabel,
        _isGroupEnd: row.isGroupEnd,
      }
      // Copy all segment values (already signed)
      for (const [key, val] of Object.entries(row.segments)) {
        entry[key] = val
      }
      // Add unsigned counts and percentages for tooltip
      for (const [key, val] of Object.entries(row.counts)) {
        entry[`_count_${key}`] = val
      }
      for (const [key, val] of Object.entries(row.percentages)) {
        entry[`_pct_${key}`] = val
      }
      return entry
    })

    if (isGrouped) {
      // Collect all segment keys from first row for separator population
      const segmentKeys = processed.length > 0
        ? Object.keys(processed[0]).filter(k => !k.startsWith('_') && k !== 'label')
        : []
      const withSeparators: typeof processed = []
      for (let i = 0; i < processed.length; i++) {
        withSeparators.push(processed[i])
        if (processed[i]._isGroupEnd && i < processed.length - 1) {
          const separator: ChartDataRow = {
            label: ` ‎${i}`,
            _totalN: 0,
            _metricId: -1,
          }
          for (const key of segmentKeys) {
            separator[key] = 0
          }
          withSeparators.push(separator)
        }
      }
      return withSeparators
    }
    return processed
  }, [rows, isGrouped])

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number>(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const overrideWidth = computeYAxisWidth(containerWidth, fmt.dataWidth)

  const yAxisWidth = useMemo(() => {
    if (overrideWidth != null) return overrideWidth
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map((d) => ((d._metricLabel || d.label) as string).length))
    return Math.min(350, Math.max(120, longest * 7))
  }, [chartData, overrideWidth])

  const maxCharsPerLine = useMemo(() => {
    const charWidth = fmt.labelFontSize * 0.6
    return Math.max(10, Math.floor((yAxisWidth - 8) / charWidth))
  }, [yAxisWidth, fmt.labelFontSize])

  const groupIndicatorHeight = isGrouped ? (fmt.labelFontSize - 1) + 6 : 0
  const rowHeight = Math.max(36, Math.max(1, ...chartData.map((d) => {
    const label = (d._metricLabel || d.label) as string
    return wrapLabel(label, maxCharsPerLine).length
  })) * (fmt.labelFontSize + 4) + 8 + groupIndicatorHeight)
  const chartHeight = Math.max(300, chartData.length * rowHeight)

  if (chartData.length === 0 || responseLabels.length === 0) return null

  // Build bar definitions: left stack (negative), center halves, right stack (positive)
  // Left bars use stackId "left", right bars use stackId "right"
  const barDefs: { dataKey: string; stackId: string; fill: string; displayLabel: string }[] = []

  // Left labels (already reversed = outside-in) → stacked left
  for (const label of leftLabels) {
    barDefs.push({ dataKey: label, stackId: 'stack', fill: colors[label], displayLabel: label })
  }
  // Center halves
  if (centerLabel && centerMode === 'center') {
    barDefs.push({ dataKey: `${centerLabel}_left`, stackId: 'stack', fill: colors[centerLabel], displayLabel: centerLabel })
    barDefs.push({ dataKey: `${centerLabel}_right`, stackId: 'stack', fill: colors[centerLabel], displayLabel: centerLabel })
  }
  // Right labels
  for (const label of rightLabels) {
    barDefs.push({ dataKey: label, stackId: 'stack', fill: colors[label], displayLabel: label })
  }

  return (
    <div ref={containerRef} role="img" aria-label="Diverging stacked bar chart">
      {hasMixedScales && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-400">
          Variables have different response scales — diverging center may not align across rows
        </div>
      )}
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 40, bottom: 4, left: 0 }}
          stackOffset="sign"
        >
          <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: fmt.axisFontSize, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={{ stroke: chartTheme.axis }}
            domain={[-maxExtent, maxExtent]}
            tickFormatter={(v: number) => `${Math.abs(v).toFixed(0)}%`}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={(props: Record<string, unknown>) => <StackedYAxisTick {...(props as StackedYAxisTickProps)} chartData={chartData} showVariableN={showVariableN} chartN={chartN} fmt={fmt} maxCharsPerLine={maxCharsPerLine} isGrouped={isGrouped} colors={chartTheme} />}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={false}
          />
          <Tooltip content={<DivergingTooltip />} />
          <ReferenceLine x={0} stroke={chartTheme.axis} strokeWidth={1.5} />
          <Legend
            content={() => (
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '12px', fontSize: fmt.labelFontSize - 1, color: chartTheme.text, paddingTop: 8 }}>
                {responseLabels.map(label => (
                  <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors[label], flexShrink: 0 }} />
                    {label}
                  </span>
                ))}
              </div>
            )}
          />
          {barDefs.map(def => (
            <Bar
              key={def.dataKey}
              dataKey={def.dataKey}
              stackId={def.stackId}
              fill={def.fill}
              barSize={fmt.barSize}
              isAnimationActive={false}
              label={fmt.dataLabels === 'none' ? false : (props: LabelProps) => {
                const { x, y, width, height, index } = props as unknown as { x: number; y: number; width: number; height: number; index: number }
                const row = chartData[index]
                if (!row || row._metricId === -1) return null
                if (Math.abs(width) < 40) return null
                // Show absolute percentage
                const displayLabel = def.displayLabel
                const pct = row[`_pct_${displayLabel}`] as number | undefined
                if (pct == null || pct === 0) return null
                // Don't duplicate label for split center
                if (def.dataKey.endsWith('_left')) return null
                const cx = x + width / 2
                const cy = y + height / 2
                return (
                  <text
                    x={cx}
                    y={cy + 4}
                    textAnchor="middle"
                    fill="#fff"
                    style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
                    aria-hidden="true"
                  >
                    {pct.toFixed(DISPLAY_PRECISION)}%
                  </text>
                )
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Shared Y-axis tick component ────────────────────────────────────────────

interface StackedYAxisTickProps {
  x: number
  y: number
  payload: { value: string | number }
  chartData: ChartDataRow[]
  showVariableN: VariableNMode
  chartN?: number
  fmt: ChartFormatting
  maxCharsPerLine: number
  isGrouped: boolean
  colors: { text: string; textMuted: string; [key: string]: string }
  [key: string]: unknown
}

function StackedYAxisTick(props: StackedYAxisTickProps) {
  const { x, y, payload, chartData, showVariableN, chartN, fmt, maxCharsPerLine, isGrouped, colors } = props
  const row = chartData.find((d) => d.label === payload.value)
  if (row?._metricId === -1) return <g aria-hidden="true" />
  const fullLabel = (row?._fullLabel as string) || String(payload.value)
  const n = row?._totalN as number | undefined
  const showN = showVariableN === 'all' ||
    (showVariableN === 'differing' && n != null && n !== chartN)

  const groupLabel = row?._groupLabel as string | undefined
  const groupColor = row?._groupColor as string | undefined
  const metricLabel = row?._metricLabel as string | undefined

  if (isGrouped && groupLabel && metricLabel) {
    const lines = wrapLabel(metricLabel, maxCharsPerLine)
    const lineHeight = fmt.labelFontSize + 2
    const groupFontSize = fmt.labelFontSize - 1
    const groupLineHeight = groupFontSize + 4
    const isGroupFirst = fullLabel.startsWith(groupLabel)
    const metricBlockHeight = lines.length * lineHeight
    const totalHeight = metricBlockHeight + groupLineHeight
    const blockStartY = y - totalHeight / 2

    if (isGroupFirst) {
      const groupY = blockStartY + groupFontSize / 2 + 2
      const metricStartY = blockStartY + groupLineHeight
      return (
        <g>
          <title>{fullLabel}</title>
          <circle cx={x - 4} cy={groupY} r={3} fill={groupColor || colors.textMuted} />
          <text x={x - 12} y={groupY} textAnchor="end" fill={groupColor || colors.textMuted} style={{ fontSize: groupFontSize, fontStyle: 'italic' }} dominantBaseline="central">
            {groupLabel.length > maxCharsPerLine ? groupLabel.slice(0, maxCharsPerLine - 3) + '...' : groupLabel}
          </text>
          {lines.map((line: string, i: number) => (
            <text key={i} x={x} y={metricStartY + i * lineHeight + lineHeight / 2} textAnchor="end" fill={colors.text} style={{ fontSize: fmt.labelFontSize }} dominantBaseline="central">{line}</text>
          ))}
          {showN && n != null && (
            <text x={x} y={metricStartY + lines.length * lineHeight + lineHeight / 2} textAnchor="end" fill={colors.textMuted} style={{ fontSize: fmt.dataLabelFontSize }} dominantBaseline="central">(n={n})</text>
          )}
        </g>
      )
    }

    const metricStartY = blockStartY
    const groupY = blockStartY + metricBlockHeight + groupFontSize / 2 + 2
    return (
      <g>
        <title>{fullLabel}</title>
        {lines.map((line: string, i: number) => (
          <text key={i} x={x} y={metricStartY + i * lineHeight + lineHeight / 2} textAnchor="end" fill={colors.text} style={{ fontSize: fmt.labelFontSize }} dominantBaseline="central">{line}</text>
        ))}
        <circle cx={x - 4} cy={groupY} r={3} fill={groupColor || colors.textMuted} />
        <text x={x - 12} y={groupY} textAnchor="end" fill={groupColor || colors.textMuted} style={{ fontSize: groupFontSize, fontStyle: 'italic' }} dominantBaseline="central">
          {groupLabel.length > maxCharsPerLine ? groupLabel.slice(0, maxCharsPerLine - 3) + '...' : groupLabel}
        </text>
        {showN && n != null && (
          <text x={x} y={groupY + groupLineHeight} textAnchor="end" fill={colors.textMuted} style={{ fontSize: fmt.dataLabelFontSize }} dominantBaseline="central">(n={n})</text>
        )}
      </g>
    )
  }

  // Ungrouped fallback
  const label = payload.value as string
  const lines = wrapLabel(label, maxCharsPerLine)
  const lineHeight = fmt.labelFontSize + 2
  const startY = y - ((lines.length - 1) * lineHeight) / 2
  return (
    <g>
      <title>{fullLabel}</title>
      {lines.map((line: string, i: number) => (
        <text key={i} x={x} y={startY + i * lineHeight} textAnchor="end" fill={colors.text} style={{ fontSize: fmt.labelFontSize }} dominantBaseline="central">{line}</text>
      ))}
      {showN && n != null && (
        <text x={x} y={startY + lines.length * lineHeight} textAnchor="end" fill={colors.textMuted} style={{ fontSize: fmt.dataLabelFontSize }} dominantBaseline="central">(n={n})</text>
      )}
    </g>
  )
}
