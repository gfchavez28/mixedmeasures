import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ErrorBar,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
  type LabelProps,
} from 'recharts'
import {
  DISPLAY_PRECISION,
  mergeFormatting,
  wrapLabel,
  resolveChartColors,
  resolveGroupColors,
  computeLogDomain,
} from '@/lib/chart-data'
import type { ChartColorPalette } from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import type {
  BarDatum,
  GroupedFrequencySection,
  GroupedScalarSection,
  ChartFormatting,
  VariableNMode,
  SortOrder,
} from '@/lib/chart-data'
import type { RechartsTooltipProps, RechartsPayloadEntry, ChartDataRow } from '@/lib/chart-types'

interface VerticalBarChartProps {
  frequencyData?: BarDatum[]
  groupedFrequencyData?: GroupedFrequencySection
  groupedScalarData?: GroupedScalarSection[]
  scalarData?: BarDatum[]
  display?: string
  sortOrder?: SortOrder
  showVariableN?: VariableNMode
  showCI?: boolean
  chartN?: number
  formatting?: Partial<ChartFormatting>
  metricType?: string
  responseLabels?: string[]
  groupValues?: string[]
  axisTransform?: 'linear' | 'log'
}

function VBarTooltip({ active, payload }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{(d._fullLabel as string) || (d.label as string)}</div>
      {payload.filter((e: RechartsPayloadEntry) => !String(e.dataKey).startsWith('_')).map((entry: RechartsPayloadEntry) => (
        <div key={entry.name} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: entry.fill || entry.color }} />
          <span className="font-medium">
            {typeof entry.value === 'number' ? entry.value.toFixed(DISPLAY_PRECISION) : entry.value}
            {typeof d._suffix === 'string' && <span className="text-mm-text-faint ml-0.5">{d._suffix}</span>}
          </span>
        </div>
      ))}
      {d.n != null && <div className="text-mm-text-faint mt-1 pt-1 border-t">n = {d.n as number}</div>}
    </div>
  )
}

/** Tooltip for grouped modes — shows group values with individual n */
function GroupedVBarTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {payload.filter((e: RechartsPayloadEntry) => !String(e.dataKey).startsWith('_')).map((entry: RechartsPayloadEntry) => {
        const d = entry.payload
        const n = d[`_n_${entry.dataKey}`] as number | undefined
        return (
          <div key={entry.dataKey} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: entry.fill || entry.color }} />
            <span>
              <span className="font-medium">{entry.name}: </span>
              {typeof entry.value === 'number' ? entry.value.toFixed(DISPLAY_PRECISION) : entry.value}
              {n != null && <span className="text-mm-text-faint ml-1">(n={n})</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Data label renderer for vertical bars (labels above/inside bars) */
function makeVerticalDataLabel(
  fmt: ChartFormatting,
  suffix: string,
  colors: ChartColorPalette,
): false | ((props: LabelProps) => React.ReactElement | null) {
  if (fmt.dataLabels === 'none') return false
  return (props: LabelProps) => {
    const { x, y, width, height, index, value } = props as { x: number; y: number; width: number; height: number; index: number; value: number | string | null }
    if (value == null || index == null) return null
    const cx = x + width / 2

    if (fmt.dataLabels === 'inside') {
      if (height < 30) return null
      return (
        <text
          x={cx}
          y={y + height / 2 + 4}
          textAnchor="middle"
          fill="#fff"
          style={{ fontSize: fmt.dataLabelFontSize, fontWeight: 500 }}
          aria-hidden="true"
        >
          {typeof value === 'number' ? value.toFixed(DISPLAY_PRECISION) : value}{suffix}
        </text>
      )
    }

    // outside (above bar)
    return (
      <text
        x={cx}
        y={y - 6}
        textAnchor="middle"
        fill={colors.text}
        style={{ fontSize: fmt.dataLabelFontSize }}
        aria-hidden="true"
      >
        {typeof value === 'number' ? value.toFixed(DISPLAY_PRECISION) : value}{suffix}
      </text>
    )
  }
}

/** X-axis tick renderer with label wrapping, full-text title, and optional N display */
function renderXTick(
  props: Record<string, unknown>,
  fmt: ChartFormatting,
  colors: ChartColorPalette,
  opts?: {
    chartData?: ChartDataRow[]
    showVariableN?: VariableNMode
    chartN?: number
  },
) {
  const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
  const lines = wrapLabel(payload.value, 20, 2)
  const fullLabel = (opts?.chartData?.find((d) => d.label === payload.value)?._fullLabel as string) || payload.value

  let nLine: React.ReactNode = null
  if (opts?.showVariableN && opts.showVariableN !== 'off' && opts.chartData) {
    const d = opts.chartData.find((dd) => dd.label === payload.value)
    const n = d?.n as number | undefined
    const show = opts.showVariableN === 'all' || (opts.showVariableN === 'differing' && n != null && n !== opts.chartN)
    if (show && n != null) {
      nLine = (
        <text x={0} y={10 + lines.length * (fmt.axisFontSize + 2) + 2} textAnchor="end" transform="rotate(-35)" fill={colors.textMuted} style={{ fontSize: fmt.axisFontSize - 1 }}>
          (n={n})
        </text>
      )
    }
  }

  return (
    <g transform={`translate(${x},${y})`}>
      <title>{fullLabel}</title>
      {lines.map((line: string, i: number) => (
        <text key={i} x={0} y={10 + i * (fmt.axisFontSize + 2)} textAnchor="end" transform="rotate(-35)" fill={colors.text} style={{ fontSize: fmt.axisFontSize }}>
          {line}
        </text>
      ))}
      {nLine}
    </g>
  )
}

export default function VerticalBarChart({
  frequencyData,
  groupedFrequencyData,
  groupedScalarData,
  scalarData,
  display = 'percentage',
  sortOrder: _sortOrder = 'none',
  showVariableN = 'off',
  showCI = false,
  chartN,
  formatting: fmtProp,
  metricType,
  responseLabels = [],
  groupValues = [],
  axisTransform = 'linear',
}: VerticalBarChartProps) {
  const fmt = mergeFormatting(fmtProp)
  const colors = useChartColors()
  const suffix = metricType === 'mean' || metricType === 'domain_aggregate' ? '' : '%'
  const topMargin = fmt.dataLabels === 'outside' ? 30 : 20

  // Determine which data mode to use
  const mode = useMemo(() => {
    if (frequencyData) return 'freq' as const
    if (groupedFrequencyData) return 'grouped_freq' as const
    if (groupedScalarData) return 'grouped_scalar' as const
    if (scalarData) return 'scalar' as const
    return null
  }, [frequencyData, groupedFrequencyData, groupedScalarData, scalarData])

  const isLog = axisTransform === 'log'

  // Shared Y-axis domain builder (value axis)
  const buildYDomain = (isPercentage: boolean, values?: number[]) => {
    if (isLog && values) {
      const logDom = computeLogDomain(values)
      return logDom ?? undefined
    }
    if (fmt.xAxisMin != null || fmt.xAxisMax != null) {
      return [fmt.xAxisMin ?? 'auto', fmt.xAxisMax ?? 'auto'] as [number | 'auto', number | 'auto']
    }
    return isPercentage ? [0, 100] as [number, number] : undefined
  }

  // ── Frequency mode (single question) ────────────────────────────────
  if (mode === 'freq' && frequencyData) {
    const barColors = resolveChartColors(
      frequencyData.map(d => d.label),
      fmt.colorPalette,
      fmt.customColors,
    )
    const chartData = frequencyData.map(d => ({
      label: d.label,
      _fullLabel: d.label,
      value: display === 'count' ? (d.count ?? 0) : d.value,
      n: d.n,
      _suffix: display === 'count' ? '' : '%',
      fill: barColors[d.label] || '#3b82f6',
      _ciError: showCI && d.ciLower != null && d.ciUpper != null
        ? [d.value - d.ciLower, d.ciUpper - d.value]
        : undefined,
    }))
    const yDomain = buildYDomain(display !== 'count')
    const dataLabel = makeVerticalDataLabel(fmt, display === 'count' ? '' : '%', colors)

    return (
      <div role="img" aria-label="Vertical bar chart">
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: topMargin, right: 20, bottom: 80, left: 20 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={(props: Record<string, unknown>) => renderXTick(props, fmt, colors, { chartData, showVariableN, chartN })}
              axisLine={{ stroke: colors.axis }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: fmt.axisFontSize, fill: colors.text }}
              axisLine={{ stroke: colors.axis }}
              domain={yDomain}
            />
            <Tooltip content={<VBarTooltip />} />
            {fmt.referenceLine != null && (
              <ReferenceLine y={fmt.referenceLine} stroke={colors.textMuted} strokeDasharray="3 3" />
            )}
            <Bar dataKey="value" barSize={fmt.barSize} isAnimationActive={false} label={dataLabel}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.fill} />
              ))}
              {showCI && (
                <ErrorBar dataKey="_ciError" width={4} strokeWidth={1.5} stroke={colors.textDark} />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  // ── Scalar ungrouped ────────────────────────────────────────────────
  if (mode === 'scalar' && scalarData) {
    const allData = scalarData.map(d => ({
      label: d.label,
      _fullLabel: d.fullLabel || d.label,
      value: d.value,
      n: d.n,
      _suffix: suffix,
      fill: d.color || '#3b82f6',
      _ciError: showCI && d.ciLower != null && d.ciUpper != null
        ? [d.value - d.ciLower, d.ciUpper - d.value]
        : undefined,
    }))
    const chartData = isLog ? allData.filter(d => d.value > 0) : allData
    const logExcluded = allData.length - chartData.length
    const yDomain = buildYDomain(false, chartData.map(d => d.value))
    const dataLabel = makeVerticalDataLabel(fmt, suffix, colors)

    return (
      <div role="img" aria-label="Vertical bar chart">
        {isLog && logExcluded > 0 && (
          <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 dark:text-amber-400 dark:bg-amber-950/30 dark:border-amber-800 rounded px-2 py-1 mb-2">
            {logExcluded} value{logExcluded > 1 ? 's' : ''} ≤ 0 excluded from log scale
          </div>
        )}
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: topMargin, right: 20, bottom: 80, left: 20 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={(props: Record<string, unknown>) => renderXTick(props, fmt, colors, { chartData, showVariableN, chartN })}
              axisLine={{ stroke: colors.axis }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: fmt.axisFontSize, fill: colors.text }}
              axisLine={{ stroke: colors.axis }}
              domain={yDomain}
              {...(isLog && yDomain ? { scale: 'log', allowDataOverflow: true } : {})}
            />
            <Tooltip content={<VBarTooltip />} />
            {fmt.referenceLine != null && (
              <ReferenceLine y={fmt.referenceLine} stroke={colors.textMuted} strokeDasharray="3 3" />
            )}
            <Bar dataKey="value" barSize={fmt.barSize} isAnimationActive={false} label={dataLabel}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.fill} />
              ))}
              {showCI && (
                <ErrorBar dataKey="_ciError" width={4} strokeWidth={1.5} stroke={colors.textDark} />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {isLog && (
          <div className="text-[11px] text-mm-text-faint mt-1 text-right">Log scale</div>
        )}
      </div>
    )
  }

  // ── Grouped scalar ──────────────────────────────────────────────────
  if (mode === 'grouped_scalar' && groupedScalarData && groupValues.length > 0) {
    const groupColors = resolveGroupColors(groupValues, fmt.colorPalette)
    const allValues: number[] = []
    const chartData = groupedScalarData.map(section => {
      const entry: ChartDataRow = {
        label: section.metricName,
        _fullLabel: section.metricFullLabel || section.metricName,
      }
      for (const g of section.groups) {
        entry[g.groupValue] = g.value
        entry[`_n_${g.groupValue}`] = g.n
        if (showCI && g.ciLower != null && g.ciUpper != null) {
          entry[`_ciError_${g.groupValue}`] = [g.value - g.ciLower, g.ciUpper - g.value]
        }
        if (isLog && g.value > 0) allValues.push(g.value)
        else if (!isLog) allValues.push(g.value)
      }
      return entry
    })
    const logExcludedScalar = isLog ? groupedScalarData.reduce((acc, s) => acc + s.groups.filter(g => g.value <= 0).length, 0) : 0
    const yDomain = buildYDomain(false, isLog ? allValues : undefined)

    return (
      <div role="img" aria-label="Vertical grouped bar chart">
        {isLog && logExcludedScalar > 0 && (
          <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 dark:text-amber-400 dark:bg-amber-950/30 dark:border-amber-800 rounded px-2 py-1 mb-2">
            {logExcludedScalar} value{logExcludedScalar > 1 ? 's' : ''} ≤ 0 excluded from log scale
          </div>
        )}
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: topMargin, right: 20, bottom: 80, left: 20 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={(props: Record<string, unknown>) => renderXTick(props, fmt, colors, { chartData, showVariableN, chartN })}
              axisLine={{ stroke: colors.axis }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: fmt.axisFontSize, fill: colors.text }}
              axisLine={{ stroke: colors.axis }}
              domain={yDomain}
              {...(isLog && yDomain ? { scale: 'log', allowDataOverflow: true } : {})}
            />
            <Tooltip content={<GroupedVBarTooltip />} />
            <Legend
              content={() => (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '12px', fontSize: fmt.labelFontSize - 1, color: colors.text, paddingTop: 8 }}>
                  {groupValues.map(gv => (
                    <span key={gv} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: groupColors[gv], flexShrink: 0 }} />
                      {gv}
                    </span>
                  ))}
                </div>
              )}
            />
            {fmt.referenceLine != null && (
              <ReferenceLine y={fmt.referenceLine} stroke={colors.textMuted} strokeDasharray="3 3" />
            )}
            {groupValues.map(gv => (
              <Bar key={gv} dataKey={gv} fill={groupColors[gv]} barSize={fmt.barSize} isAnimationActive={false}>
                {showCI && <ErrorBar dataKey={`_ciError_${gv}`} width={4} strokeWidth={1.5} stroke={colors.textDark} />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
        {isLog && (
          <div className="text-[11px] text-mm-text-faint mt-1 text-right">Log scale</div>
        )}
      </div>
    )
  }

  // ── Grouped frequency ───────────────────────────────────────────────
  if (mode === 'grouped_freq' && groupedFrequencyData) {
    const groupColors = resolveGroupColors(groupValues, fmt.colorPalette)
    const labels = (groupedFrequencyData.groups[0]?.bars?.length ?? 0) > 0
      ? groupedFrequencyData.groups[0].bars.map(b => b.label)
      : responseLabels
    const chartData = labels.map(label => {
      const entry: ChartDataRow = { label, _fullLabel: label }
      for (const g of groupedFrequencyData.groups) {
        const bar = g.bars.find(b => b.label === label)
        entry[g.groupValue] = display === 'count' ? (bar?.count ?? 0) : (bar?.value ?? 0)
        entry[`_n_${g.groupValue}`] = bar?.n
      }
      return entry
    })
    const yDomain = buildYDomain(display !== 'count')

    return (
      <div role="img" aria-label="Vertical grouped frequency bar chart">
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: topMargin, right: 20, bottom: 80, left: 20 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={(props: Record<string, unknown>) => renderXTick(props, fmt, colors)}
              axisLine={{ stroke: colors.axis }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: fmt.axisFontSize, fill: colors.text }}
              axisLine={{ stroke: colors.axis }}
              domain={yDomain}
            />
            <Tooltip content={<GroupedVBarTooltip />} />
            <Legend
              content={() => (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '12px', fontSize: fmt.labelFontSize - 1, color: colors.text, paddingTop: 8 }}>
                  {groupValues.map(gv => (
                    <span key={gv} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: groupColors[gv], flexShrink: 0 }} />
                      {gv}
                    </span>
                  ))}
                </div>
              )}
            />
            {fmt.referenceLine != null && (
              <ReferenceLine y={fmt.referenceLine} stroke={colors.textMuted} strokeDasharray="3 3" />
            )}
            {groupValues.map(gv => (
              <Bar key={gv} dataKey={gv} fill={groupColors[gv]} barSize={fmt.barSize} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  return null
}
