import { useMemo, useRef, useState, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ErrorBar,
  ReferenceLine,
} from 'recharts'
import {
  DISPLAY_PRECISION,
  mergeFormatting,
  computeYAxisWidth,
  wrapLabel,
  resolveGroupColors,
  resolveGroupTextColors,
  computeLogDomain,
} from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import type { LabelProps } from 'recharts'
import type { GroupedScalarSection, ChartFormatting, VariableNMode, SortOrder } from '@/lib/chart-data'
import type { RechartsTooltipProps, RechartsPayloadEntry, ChartDataRow } from '@/lib/chart-types'

interface GroupedScalarBarChartProps {
  sections: GroupedScalarSection[]
  groupValues: string[]
  sortOrder?: SortOrder
  showVariableN?: VariableNMode
  chartN?: number
  showCI?: boolean
  formatting?: Partial<ChartFormatting>
  metricType?: string
  axisTransform?: 'linear' | 'log'
}

function GroupedTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
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
            {Number(entry.value).toFixed(DISPLAY_PRECISION)}
            {(entry.payload[`_suffix`] as string) || ''}
          </span>
          {entry.payload[`_n_${entry.name}`] != null && (
            <span className="text-mm-text-faint ml-1">
              n={entry.payload[`_n_${entry.name}`] as number}
            </span>
          )}
          {entry.payload[`_ciLower_${entry.name}`] != null && entry.payload[`_ciUpper_${entry.name}`] != null && (
            <span className="text-mm-text-faint ml-1">
              [{(entry.payload[`_ciLower_${entry.name}`] as number).toFixed(DISPLAY_PRECISION)}, {(entry.payload[`_ciUpper_${entry.name}`] as number).toFixed(DISPLAY_PRECISION)}]
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function SingleGroupedScalarChart({
  section,
  groupValues,
  groupColors,
  groupTextColors,
  showVariableN,
  chartN,
  showCI,
  fmt,
  suffix,
  axisTransform = 'linear',
}: {
  section: GroupedScalarSection
  groupValues: string[]
  groupColors: Record<string, string>
  groupTextColors: Record<string, string>
  showVariableN: VariableNMode
  chartN?: number
  showCI: boolean
  fmt: ChartFormatting
  suffix: string
  axisTransform?: 'linear' | 'log'
}) {
  const isLog = axisTransform === 'log'
  const colors = useChartColors()
  const chartData = useMemo(() => {
    if (section.groups.length === 0) return []

    // Single row per metric, with one bar per group
    const entry: ChartDataRow = { label: section.metricName, _suffix: suffix }
    for (const gv of groupValues) {
      const g = section.groups.find(gr => gr.groupValue === gv)
      entry[gv] = g?.value ?? 0
      entry[`_n_${gv}`] = g?.n ?? 0
      entry[`_ciLower_${gv}`] = g?.ciLower ?? undefined
      entry[`_ciUpper_${gv}`] = g?.ciUpper ?? undefined
      if (showCI && g?.ciLower != null && g?.ciUpper != null) {
        entry[`_error_${gv}`] = [g.value - g.ciLower, g.ciUpper - g.value]
      }
    }
    return [entry]
  }, [section, groupValues, showCI, suffix])

  // Container measurement for data-width mode
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
    return Math.min(350, Math.max(120, section.metricName.length * 7))
  }, [section.metricName, overrideWidth])

  const maxCharsPerLine = useMemo(() => {
    const charWidth = fmt.labelFontSize * 0.6
    return Math.max(10, Math.floor((yAxisWidth - 8) / charWidth))
  }, [yAxisWidth, fmt.labelFontSize])

  // Compute XAxis domain accounting for CI, explicit axis range, and log scale
  const logDomain = useMemo(() => {
    if (!isLog) return null
    const values = section.groups.filter(g => g.value > 0).map(g => g.value)
    return computeLogDomain(values)
  }, [isLog, section])

  const xDomainMin = isLog && logDomain ? logDomain[0] : fmt.xAxisMin
  const xDomainMax = useMemo(() => {
    if (isLog && logDomain) return logDomain[1]
    if (fmt.xAxisMax != null) return fmt.xAxisMax
    let max = 0
    for (const g of section.groups) {
      if (g.value > max) max = g.value
      if (showCI && g.ciUpper != null && g.ciUpper > max) max = g.ciUpper
    }
    return max > 0 ? Math.ceil(max * 1.05) : undefined
  }, [section, showCI, fmt.xAxisMax, isLog, logDomain])

  const barSize = Math.max(12, fmt.barSize - 4)
  const rowHeight = Math.max(barSize * groupValues.length + 16, wrapLabel(section.metricName, maxCharsPerLine).length * (fmt.labelFontSize + 4) + 8)
  const chartHeight = Math.max(80, rowHeight)

  // Show per-group n in header
  const groupNs = groupValues.map(gv => {
    const g = section.groups.find(gr => gr.groupValue === gv)
    return g?.n
  })
  const showN = showVariableN === 'all' ||
    (showVariableN === 'differing' && groupNs.some(n => n != null && n !== chartN))

  if (chartData.length === 0) return null

  return (
    <div className="mb-4" ref={containerRef}>
      <div className="flex items-baseline gap-2 mb-1 px-1">
        <span className="text-sm font-medium truncate" title={section.metricFullLabel ?? section.metricName} style={{ color: colors.textDark }}>
          {section.metricName}
        </span>
        {showN && (
          <span className="text-xs" style={{ color: colors.textMuted }}>
            ({groupValues.map((gv, i) => (
              <span key={gv}>
                {i > 0 && ', '}
                <span style={{ color: groupTextColors[gv] }}>{gv}</span>: n={groupNs[i] ?? 0}
              </span>
            ))})
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 2, right: fmt.dataLabels === 'none' ? 40 : 70, bottom: 2, left: 0 }}
        >
          <CartesianGrid stroke={colors.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: fmt.axisFontSize - 1, fill: colors.text }}
            axisLine={{ stroke: colors.axis }}
            tickLine={{ stroke: colors.axis }}
            domain={xDomainMax != null || xDomainMin != null ? [xDomainMin ?? 0, xDomainMax ?? 'auto'] : undefined}
            tickFormatter={suffix ? (v: number) => `${v}${suffix}` : undefined}
            {...(isLog && logDomain ? { scale: 'log', allowDataOverflow: true } : {})}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={(props: Record<string, unknown>) => {
              const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
              const label = payload.value
              const fullLabel = section.metricFullLabel || label
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
          <Tooltip content={<GroupedTooltip />} />
          {fmt.referenceLine != null && (
            <ReferenceLine
              x={fmt.referenceLine}
              stroke={colors.reference}
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{ value: String(fmt.referenceLine), fontSize: fmt.dataLabelFontSize, fill: colors.textMuted, position: 'top' }}
            />
          )}
          {groupValues.map(gv => (
            <Bar
              key={gv}
              dataKey={gv}
              fill={groupColors[gv]}
              radius={[0, 2, 2, 0]}
              barSize={barSize}
              label={fmt.dataLabels === 'none' ? false : (props: LabelProps) => {
                const { x, y, width, height, value } = props as unknown as { x: number; y: number; width: number; height: number; value: number }
                if (value == null) return null
                const barEnd = x + width
                const cy = y + height / 2

                if (fmt.dataLabels === 'inside') {
                  if (width <= 40) return null
                  return (
                    <text
                      x={barEnd - 6}
                      y={cy + 4}
                      textAnchor="end"
                      fill="#fff"
                      style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
                      aria-hidden="true"
                    >
                      {value.toFixed(DISPLAY_PRECISION)}{suffix}
                    </text>
                  )
                }

                return (
                  <text
                    x={barEnd + 4}
                    y={cy + 4}
                    fill={colors.text}
                    style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
                    aria-hidden="true"
                  >
                    {value.toFixed(DISPLAY_PRECISION)}{suffix}
                  </text>
                )
              }}
            >
              {showCI && <ErrorBar dataKey={`_error_${gv}`} direction="x" width={3} stroke={colors.reference} strokeWidth={1.5} />}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function GroupedScalarBarChart({
  sections,
  groupValues,
  sortOrder: _sortOrder = 'none',
  showVariableN = 'off',
  chartN,
  showCI = false,
  formatting: fmtProp,
  metricType,
  axisTransform = 'linear',
}: GroupedScalarBarChartProps) {
  const fmt = mergeFormatting(fmtProp)
  const suffix = metricType === 'mean' || metricType === 'domain_aggregate' ? '' : '%'

  const groupColors = useMemo(
    () => resolveGroupColors(groupValues, fmt.colorPalette),
    [groupValues, fmt.colorPalette],
  )

  const groupTextColors = useMemo(
    () => resolveGroupTextColors(groupValues, fmt.colorPalette),
    [groupValues, fmt.colorPalette],
  )

  // Variable ordering is handled upstream by orderedMetrics
  const orderedSections = sections

  if (orderedSections.length === 0) return null

  return (
    <div role="img" aria-label={`Grouped bar charts by ${groupValues.join(', ')}`}>
      {/* Shared group legend */}
      <div className="flex items-center gap-3 px-1 mb-3">
        {groupValues.map(gv => (
          <div key={gv} className="flex items-center gap-1.5 text-xs">
            <span
              className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: groupColors[gv] }}
            />
            <span style={{ color: groupTextColors[gv] }}>{gv}</span>
          </div>
        ))}
      </div>
      {orderedSections.map(section => (
        <SingleGroupedScalarChart
          key={section.metricId}
          section={section}
          groupValues={groupValues}
          groupColors={groupColors}
          groupTextColors={groupTextColors}
          showVariableN={showVariableN}
          chartN={chartN}
          showCI={showCI}
          fmt={fmt}
          suffix={suffix}
          axisTransform={axisTransform}
        />
      ))}
    </div>
  )
}
