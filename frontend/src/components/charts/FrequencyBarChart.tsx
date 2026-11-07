import { useMemo, useRef, useState, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import type { MetricDefinitionResponse } from '@/lib/api'
import { metricDisplayLabel } from '@/lib/metric-label'
import {
  DISPLAY_PRECISION,
  mergeFormatting,
  computeYAxisWidth,
  wrapLabel,
  shapeFrequencyBars,
  shapeGroupedFrequencyBars,
  buildUnifiedLabels,
  frequencyUndefined,
  frequencyUndefinedReason,
  undefinedGroupsNote,
  getGroupValues,
  sortGroupValues,
  isGroupedMetrics,
  resolveFrequencyBarColors,
  resolveGroupColors,
  resolveGroupTextColors,
} from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import { NO_VALUE, undefinedTooltip } from '@/lib/stat-format'
import { pooledNLabel } from '@/lib/aggregate-basis'
import type { LabelProps } from 'recharts'
import type { BarDatum, ChartFormatting, VariableNMode, GroupedFrequencySection, SortOrder } from '@/lib/chart-data'
import type { RechartsTooltipProps, RechartsPayloadEntry, ChartDataRow } from '@/lib/chart-types'
import { ChartFigure } from './ChartFigure'
import { barRowLabel } from './bar-row-label'

interface FrequencyBarChartProps {
  metrics: MetricDefinitionResponse[]
  display?: 'count' | 'percentage'
  sortOrder?: SortOrder
  showVariableN?: VariableNMode
  chartN?: number
  formatting?: Partial<ChartFormatting>
  hiddenLabels?: string[]
  reverseScale?: boolean
  labelMap?: Map<number, string>
  hiddenGroupValues?: string[]
}

function CustomTooltip({ active, payload }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as unknown as BarDatum
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs">
      <div className="font-medium mb-1 text-mm-text">{d.label}</div>
      {d.percentage != null && <div>Percentage: {d.percentage.toFixed(DISPLAY_PRECISION)}%</div>}
      {d.count != null && <div>Count: {d.count}</div>}
      {d.n != null && <div className="text-mm-text-muted">n = {d.n}</div>}
    </div>
  )
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
            {(entry.payload[`_count_${entry.name}`] as number) ?? entry.value}
            {entry.payload[`_pct_${entry.name}`] != null && (
              <span className="text-mm-text-faint ml-1">
                ({(entry.payload[`_pct_${entry.name}`] as number).toFixed(DISPLAY_PRECISION)}%)
              </span>
            )}
          </span>
          {entry.payload[`_n_${entry.name}`] != null && (
            <span className="text-mm-text-faint ml-1">
              n={entry.payload[`_n_${entry.name}`] as number}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function SingleFrequencyChart({
  metric,
  barData,
  display,
  showVariableN,
  chartN,
  responseColors,
  fmt,
  sectionLabel,
  fullLabel,
  responseLabels,
}: {
  metric: MetricDefinitionResponse
  barData: BarDatum[]
  display: 'count' | 'percentage'
  showVariableN: VariableNMode
  chartN?: number
  responseColors: Record<string, string>
  fmt: ChartFormatting
  sectionLabel: string
  fullLabel: string
  responseLabels: string[]
}) {
  const sorted = useMemo(() => {
    // Build lookup from barData
    const barMap = new Map(barData.map(d => [d.label, d]))

    // Order bars by unified responseLabels
    const ordered: (BarDatum & { displayValue: number | null })[] = []
    // A category nobody chose is a real 0 — but a variable NOBODY ANSWERED has
    // no share at all (#1412): its bars carry `value: null` and draw nothing.
    // The count stays a real 0.
    const shown = (d: BarDatum) => display === 'count' ? (d.count ?? 0) : (d.value == null ? null : (d.percentage ?? d.value))
    for (const label of responseLabels) {
      const d = barMap.get(label)
      if (d) ordered.push({ ...d, displayValue: shown(d) })
    }
    // Append any bars not in responseLabels (edge case)
    for (const d of barData) {
      if (!responseLabels.includes(d.label)) {
        ordered.push({ ...d, displayValue: shown(d) })
      }
    }
    return ordered
  }, [barData, display, responseLabels])

  const colors = useChartColors()

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
    if (sorted.length === 0) return 120
    const longest = Math.max(...sorted.map(d => d.label.length))
    return Math.min(200, Math.max(100, longest * 7))
  }, [sorted, overrideWidth])

  const maxCharsPerLine = useMemo(() => {
    const charWidth = (fmt.labelFontSize - 1) * 0.6
    return Math.max(10, Math.floor((yAxisWidth - 8) / charWidth))
  }, [yAxisWidth, fmt.labelFontSize])

  const rowHeight = Math.max(32, Math.max(...sorted.map(d => wrapLabel(d.label, maxCharsPerLine).length)) * (fmt.labelFontSize + 3) + 8)
  const chartHeight = Math.max(180, sorted.length * rowHeight)
  const n = metric.results[0]?.valid_n
  const showN = showVariableN === 'all' ||
    (showVariableN === 'differing' && n != null && n !== chartN)
  // #1330 (D54): a variable group's pooled frequency counts ANSWERS, several per
  // record — say so from the payload's `record_count` (absent before 1.5.9).
  const recordCount = (metric.results[0]?.result_data as { record_count?: unknown } | undefined)
    ?.record_count
  const nText = n != null && metric.input_source_type === 'dataset_domain'
    && typeof recordCount === 'number'
    ? pooledNLabel(n, recordCount)
    : n
  // #1412 — nobody answered: say so beside the name, in text (the PNG and a
  // reader both get it), rather than drawing a 0% per option. An undeclared
  // variable has no options at all then, and used to VANISH from the chart.
  const undef = metric.results[0] != null && frequencyUndefined(metric.results[0])
  const undefinedNote = undef && (display === 'percentage' || sorted.length === 0)
    ? `${NO_VALUE} ${undefinedTooltip(frequencyUndefinedReason(metric.results[0]))}`
    : null

  if (sorted.length === 0 && !undefinedNote) return null

  return (
    <div className="mb-4" ref={containerRef}>
      <div className="flex items-baseline gap-2 mb-1 px-1">
        <span className="text-sm font-medium truncate" title={fullLabel} style={{ color: colors.textDark }}>
          {sectionLabel}
        </span>
        {showN && n != null && (
          <span className="text-xs" style={{ color: colors.textMuted }}>
            (n={nText})
          </span>
        )}
        {undefinedNote && (
          <span data-undefined-statistic="" className="text-xs" style={{ color: colors.textMuted }}>
            {undefinedNote}
          </span>
        )}
      </div>
      {sorted.length > 0 && (
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={sorted}
          margin={{ top: 2, right: fmt.dataLabels === 'none' ? 30 : 70, bottom: 2, left: 0 }}
        >
          <CartesianGrid stroke={colors.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: fmt.axisFontSize - 1, fill: colors.text }}
            axisLine={{ stroke: colors.axis }}
            tickLine={{ stroke: colors.axis }}
            domain={display === 'percentage' ? [0, 100] : undefined}
            tickFormatter={display === 'percentage' ? (v: number) => `${v}%` : undefined}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={(props: Record<string, unknown>) => {
              const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
              const label = payload.value as string
              const lines = wrapLabel(label, maxCharsPerLine)
              const lineHeight = (fmt.labelFontSize - 1) + 2
              const startY = y - ((lines.length - 1) * lineHeight) / 2
              return (
                <g>
                  <title>{label}</title>
                  {lines.map((line, i) => (
                    <text
                      key={i}
                      x={x}
                      y={startY + i * lineHeight}
                      textAnchor="end"
                      fill={colors.text}
                      style={{ fontSize: fmt.labelFontSize - 1 }}
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
          <Tooltip content={<CustomTooltip />} />
          <Bar
            dataKey="displayValue"
            radius={[0, 2, 2, 0]}
            barSize={fmt.barSize - 4}
            // #1314: the label reads its own row — never `sorted[index]` (bar-row-label.ts).
            label={fmt.dataLabels === 'none' ? false : barRowLabel<(typeof sorted)[number]>((entry, { x, y, width, height }) => {
              const val = entry.displayValue
              if (val == null) return null // #1412: no share, no label — the header says why
              const barEnd = x + width
              const cy = y + height / 2
              const valSuffix = display === 'percentage' ? '%' : ''
              const precision = display === 'percentage' ? DISPLAY_PRECISION : 0

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
                    {val.toFixed(precision)}{valSuffix}
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
                  {val.toFixed(precision)}{valSuffix}
                </text>
              )
            })}
          >
            {sorted.map(entry => (
              <Cell
                key={entry.label}
                fill={responseColors[entry.label] || '#3b82f6'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      )}
    </div>
  )
}

function GroupedSingleFrequencyChart({
  section,
  groupValues,
  groupColors,
  groupTextColors,
  display,
  showVariableN,
  chartN,
  fmt,
  responseLabels: responseLabelsFromParent,
}: {
  section: GroupedFrequencySection
  groupValues: string[]
  groupColors: Record<string, string>
  groupTextColors: Record<string, string>
  display: 'count' | 'percentage'
  showVariableN: VariableNMode
  chartN?: number
  fmt: ChartFormatting
  responseLabels: string[]
}) {
  const chartData = useMemo(() => {
    if (responseLabelsFromParent.length === 0) return []

    const labels = responseLabelsFromParent

    return labels.map(label => {
      const entry: ChartDataRow = { label }
      for (const gv of groupValues) {
        const group = section.groups.find(g => g.groupValue === gv)
        const bar = group?.bars.find(b => b.label === label)
        // #1412 — three cases, and only the last is a number: a group with no
        // result for this variable (absent) and a group nobody answered (0/0)
        // draw NOTHING; a group with answers that chose none of this option is
        // a real 0. Never `?? 0` across all three.
        const absent = !group || (group.bars.length === 0 && !group.undefinedStatistic)
        const pct = absent || group.undefinedStatistic ? null : (bar?.percentage ?? 0)
        const count = absent ? null : (bar?.count ?? 0)
        entry[gv] = display === 'count' ? count : pct
        entry[`_count_${gv}`] = count
        entry[`_pct_${gv}`] = pct
        entry[`_n_${gv}`] = bar?.n ?? 0
      }
      return entry
    })
  }, [section, groupValues, display, responseLabelsFromParent])

  // #1412 — the groups nobody answered, said once in text beside the name.
  const undefinedNote = display === 'percentage'
    ? undefinedGroupsNote(section.groups
      .filter(g => g.undefinedStatistic && groupValues.includes(g.groupValue))
      .map(g => ({ group: g.groupValue, reason: g.undefinedReason })))
    : null

  const colors = useChartColors()

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
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map(d => (d.label as string).length))
    return Math.min(200, Math.max(100, longest * 7))
  }, [chartData, overrideWidth])

  const maxCharsPerLine = useMemo(() => {
    const charWidth = (fmt.labelFontSize - 1) * 0.6
    return Math.max(10, Math.floor((yAxisWidth - 8) / charWidth))
  }, [yAxisWidth, fmt.labelFontSize])

  const barSize = Math.max(12, fmt.barSize - 8)
  const rowHeight = Math.max(barSize * groupValues.length + 16, Math.max(...chartData.map(d => wrapLabel(d.label as string, maxCharsPerLine).length)) * (fmt.labelFontSize + 3) + 8)
  const chartHeight = Math.max(180, chartData.length * rowHeight)

  // Show per-group n in header
  const groupNs = groupValues.map(gv => {
    const group = section.groups.find(g => g.groupValue === gv)
    return group?.bars[0]?.n
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
        {undefinedNote && (
          <span data-undefined-statistic="" className="text-xs" style={{ color: colors.textMuted }}>
            {undefinedNote}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 2, right: fmt.dataLabels === 'none' ? 30 : 70, bottom: 2, left: 0 }}
        >
          <CartesianGrid stroke={colors.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: fmt.axisFontSize - 1, fill: colors.text }}
            axisLine={{ stroke: colors.axis }}
            tickLine={{ stroke: colors.axis }}
            domain={display === 'percentage' ? [0, 100] : undefined}
            tickFormatter={display === 'percentage' ? (v: number) => `${v}%` : undefined}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={(props: Record<string, unknown>) => {
              const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
              const label = payload.value as string
              const lines = wrapLabel(label, maxCharsPerLine)
              const lineHeight = (fmt.labelFontSize - 1) + 2
              const startY = y - ((lines.length - 1) * lineHeight) / 2
              return (
                <g>
                  <title>{label}</title>
                  {lines.map((line, i) => (
                    <text
                      key={i}
                      x={x}
                      y={startY + i * lineHeight}
                      textAnchor="end"
                      fill={colors.text}
                      style={{ fontSize: fmt.labelFontSize - 1 }}
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
                const valSuffix = display === 'percentage' ? '%' : ''
                const precision = display === 'percentage' ? DISPLAY_PRECISION : 0

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
                      {value.toFixed(precision)}{valSuffix}
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
                    {value.toFixed(precision)}{valSuffix}
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

export default function FrequencyBarChart({
  metrics,
  display = 'percentage',
  sortOrder = 'none',
  showVariableN = 'off',
  chartN,
  formatting: fmtProp,
  hiddenLabels,
  reverseScale,
  labelMap,
  hiddenGroupValues,
}: FrequencyBarChartProps) {
  const fmt = mergeFormatting(fmtProp)

  const isGrouped = useMemo(
    () => isGroupedMetrics(metrics),
    [metrics],
  )

  // Unified label ordering for ungrouped frequency bars
  const unifiedLabels = useMemo(() => {
    if (isGrouped) return []
    const shapeOpts = (hiddenLabels?.length || reverseScale)
      ? { hiddenLabels, reverseScale }
      : undefined
    return buildUnifiedLabels(metrics, shapeOpts)
  }, [metrics, hiddenLabels, reverseScale, isGrouped])

  // Resolve per-response colors from palette + custom overrides.
  // #417: numeric-valued frequency bars render in a single color (distinguished
  // by axis position, not hue) unless the user picked an explicit palette/custom
  // colors — see resolveFrequencyBarColors.
  const responseColors = useMemo(
    () => resolveFrequencyBarColors(unifiedLabels, fmt.colorPalette, fmt.customColors ?? {}),
    [unifiedLabels, fmt.colorPalette, fmt.customColors],
  )

  // Ungrouped sections
  const sections = useMemo(() => {
    if (isGrouped) return []
    const shapeOpts = (hiddenLabels?.length || reverseScale)
      ? { hiddenLabels, reverseScale }
      : undefined
    return metrics
      .filter(m => m.results.length > 0)
      .map(m => {
        const fl = metricDisplayLabel(m)
        return {
          metric: m,
          barData: shapeFrequencyBars(m, shapeOpts),
          sectionLabel: labelMap?.get(m.id) ?? fl,
          fullLabel: fl,
        }
      })
  }, [metrics, hiddenLabels, reverseScale, isGrouped, labelMap])

  // Grouped sections
  const groupValues = useMemo(() => {
    if (!isGrouped) return []
    const all = getGroupValues(metrics)
    const filtered = hiddenGroupValues?.length ? all.filter(gv => !hiddenGroupValues.includes(gv)) : all
    return sortGroupValues(filtered, sortOrder, metrics)
  }, [metrics, isGrouped, hiddenGroupValues, sortOrder])

  const groupColors = useMemo(
    () => resolveGroupColors(groupValues, fmt.colorPalette),
    [groupValues, fmt.colorPalette],
  )

  const groupTextColors = useMemo(
    () => resolveGroupTextColors(groupValues, fmt.colorPalette),
    [groupValues, fmt.colorPalette],
  )

  const groupedSections = useMemo(() => {
    if (!isGrouped) return []
    const shapeOpts = (hiddenLabels?.length || reverseScale)
      ? { hiddenLabels, reverseScale }
      : undefined
    return metrics
      .filter(m => m.results.length > 0)
      .map(m => ({
        section: shapeGroupedFrequencyBars(m, groupValues, shapeOpts, labelMap),
        responseLabels: buildUnifiedLabels([m], shapeOpts),
      }))
  }, [metrics, groupValues, hiddenLabels, reverseScale, isGrouped, labelMap])

  if (!isGrouped && sections.length === 0) return null
  if (isGrouped && groupedSections.length === 0) return null

  if (isGrouped) {
    return (
      <ChartFigure label={`Grouped frequency bar charts by ${groupValues.join(', ')}`}>
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
        {groupedSections.map(({ section, responseLabels: rl }) => (
          <GroupedSingleFrequencyChart
            key={section.metricId}
            section={section}
            groupValues={groupValues}
            groupColors={groupColors}
            groupTextColors={groupTextColors}
            display={display}
            showVariableN={showVariableN}
            chartN={chartN}
            fmt={fmt}
            responseLabels={rl}
          />
        ))}
      </ChartFigure>
    )
  }

  return (
    <ChartFigure label="Frequency bar charts">
      {sections.map(({ metric, barData, sectionLabel, fullLabel }) => (
        <SingleFrequencyChart
          key={metric.id}
          metric={metric}
          barData={barData}
          display={display}
          showVariableN={showVariableN}
          chartN={chartN}
          responseColors={responseColors}
          fmt={fmt}
          sectionLabel={sectionLabel}
          fullLabel={fullLabel}
          responseLabels={unifiedLabels}
        />
      ))}
    </ChartFigure>
  )
}
