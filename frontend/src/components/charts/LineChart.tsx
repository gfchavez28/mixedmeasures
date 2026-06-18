import { useMemo } from 'react'
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ErrorBar,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import {
  DISPLAY_PRECISION,
  mergeFormatting,
  wrapLabel,
  resolveGroupColors,
  LINE_DASH_PATTERNS,
  computeLogDomain,
} from '@/lib/chart-data'
import { useChartColors } from '@/lib/theme-context'
import type {
  LineChartData,
  ChartFormatting,
  VariableNMode,
} from '@/lib/chart-data'
import type { RechartsTooltipProps, RechartsPayloadEntry, ChartDataRow } from '@/lib/chart-types'

const DOT_SHAPES = [
  'circle',
  'square',
  'diamond',
  'triangle',
] as const

function CustomDot({ cx, cy, fill, shape, size }: { cx: number; cy: number; fill: string; shape: typeof DOT_SHAPES[number]; size: number }) {
  const r = size
  switch (shape) {
    case 'square':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={fill} />
    case 'diamond':
      return <polygon points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`} fill={fill} />
    case 'triangle':
      return <polygon points={`${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}`} fill={fill} />
    default:
      return <circle cx={cx} cy={cy} r={r} fill={fill} />
  }
}

interface LineChartComponentProps {
  data: LineChartData
  showCI?: boolean
  showErrorBand?: boolean
  lineStyle?: 'connected' | 'markers'
  showVariableN?: VariableNMode
  showGroupN?: boolean
  chartN?: number
  groupNs?: Record<string, number>
  formatting?: Partial<ChartFormatting>
  metricType?: string
  axisTransform?: 'linear' | 'log'
}

function LineTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {payload
        .filter((entry: RechartsPayloadEntry) => entry.dataKey && !String(entry.dataKey).startsWith('_band_'))
        .map((entry: RechartsPayloadEntry) => {
          const point = entry.payload
          const groupKey = entry.dataKey
          const n = (point[`_n_${groupKey}`] ?? point._n) as number | undefined
          const ciLower = (point[`_ciLower_${groupKey}`] ?? point._ciLower) as number | undefined
          const ciUpper = (point[`_ciUpper_${groupKey}`] ?? point._ciUpper) as number | undefined
          return (
            <div key={entry.name} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color || entry.stroke }} />
              <span className="text-mm-text-secondary">{entry.name}:</span>
              <span className="font-medium">
                {typeof entry.value === 'number' ? entry.value.toFixed(DISPLAY_PRECISION) : entry.value}
              </span>
              {n != null && <span className="text-mm-text-faint">(n={n})</span>}
              {ciLower != null && ciUpper != null && (
                <span className="text-mm-text-faint">[{ciLower.toFixed(DISPLAY_PRECISION)}, {ciUpper.toFixed(DISPLAY_PRECISION)}]</span>
              )}
            </div>
          )
        })}
    </div>
  )
}

export default function LineChartComponent({
  data,
  showCI = false,
  showErrorBand = false,
  lineStyle = 'connected',
  showVariableN: _showVariableN = 'off',
  showGroupN = false,
  chartN: _chartN,
  groupNs,
  formatting: fmtProp,
  metricType,
  axisTransform = 'linear',
}: LineChartComponentProps) {
  const fmt = mergeFormatting(fmtProp)
  const colors = useChartColors()
  const { series, xLabels } = data
  const isLog = axisTransform === 'log'
  const isGrouped = series.length > 1 || (series.length === 1 && series[0].groupValue != null)

  const groupValues = useMemo(() =>
    series.filter(s => s.groupValue != null).map(s => s.groupValue as string),
  [series])

  const groupColors = useMemo(
    () => isGrouped ? resolveGroupColors(groupValues, fmt.colorPalette) : {},
    [isGrouped, groupValues, fmt.colorPalette],
  )

  // Build recharts-compatible flat data: one entry per X label
  const chartData = useMemo(() => {
    return xLabels.map((label, i) => {
      const entry: ChartDataRow = { label, _fullLabel: label }

      if (!isGrouped) {
        const point = series[0]?.points[i]
        if (point) {
          entry.value = point.value
          entry._n = point.n
          entry._ciLower = point.ciLower
          entry._ciUpper = point.ciUpper
          if (point.ciLower != null && point.ciUpper != null) {
            entry._ciError = [point.value - point.ciLower, point.ciUpper - point.value]
            entry._band_value = [point.ciLower, point.ciUpper]
          }
        }
      } else {
        for (const s of series) {
          const gv = s.groupValue!
          const point = s.points[i]
          if (point) {
            entry[gv] = point.value
            entry[`_n_${gv}`] = point.n
            entry[`_ciLower_${gv}`] = point.ciLower
            entry[`_ciUpper_${gv}`] = point.ciUpper
            if (point.ciLower != null && point.ciUpper != null) {
              entry[`_ciError_${gv}`] = [point.value - point.ciLower, point.ciUpper - point.value]
              entry[`_band_${gv}`] = [point.ciLower, point.ciUpper]
            }
          }
        }
      }
      return entry
    })
  }, [xLabels, series, isGrouped])

  // Log scale: collect all positive values for domain computation
  const logDomain = useMemo(() => {
    if (!isLog) return null
    const values: number[] = []
    for (const s of series) {
      for (const p of s.points) {
        if (p.value > 0) values.push(p.value)
      }
    }
    return computeLogDomain(values)
  }, [isLog, series])

  const logExcludedCount = useMemo(() => {
    if (!isLog) return 0
    let count = 0
    for (const s of series) {
      for (const p of s.points) {
        if (p.value <= 0) count++
      }
    }
    return count
  }, [isLog, series])

  const yDomain = isLog && logDomain
    ? logDomain
    : fmt.xAxisMin != null || fmt.xAxisMax != null
      ? [fmt.xAxisMin ?? 'auto', fmt.xAxisMax ?? 'auto'] as [number | 'auto', number | 'auto']
      : undefined

  const suffix = metricType === 'mean' || metricType === 'domain_aggregate' ? '' : '%'
  const markersOnly = lineStyle === 'markers'

  return (
    <div role="img" aria-label="Line chart">
      {isLog && logExcludedCount > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 mb-2">
          {logExcludedCount} value{logExcludedCount > 1 ? 's' : ''} ≤ 0 excluded from log scale
        </div>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={chartData} margin={{ top: 20, right: 30, bottom: 80, left: 20 }}>
          <CartesianGrid stroke={colors.grid} />
          <XAxis
            dataKey="label"
            tick={(props: Record<string, unknown>) => {
              const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
              const lines = wrapLabel(payload.value, 20, 2)
              return (
                <g transform={`translate(${x},${y})`}>
                  <title>{payload.value}</title>
                  {lines.map((line: string, i: number) => (
                    <text key={i} x={0} y={10 + i * (fmt.axisFontSize + 2)} textAnchor="end" transform="rotate(-35)" fill={colors.text} style={{ fontSize: fmt.axisFontSize }}>
                      {line}
                    </text>
                  ))}
                </g>
              )
            }}
            axisLine={{ stroke: colors.axis }}
            tickLine={false}
            interval={0}
          />
          <YAxis
            tick={{ fontSize: fmt.axisFontSize, fill: colors.text }}
            axisLine={{ stroke: colors.axis }}
            domain={yDomain}
            tickFormatter={v => `${v}${suffix}`}
            {...(isLog && logDomain ? { scale: 'log', allowDataOverflow: true } : {})}
          />
          <Tooltip content={<LineTooltip />} />

          {fmt.referenceLine != null && (
            <ReferenceLine y={fmt.referenceLine} stroke={colors.textMuted} strokeDasharray="3 3" />
          )}

          {/* Error bands (rendered before lines so they appear behind) */}
          {showCI && showErrorBand && !isGrouped && (
            <Area
              dataKey="_band_value"
              type="linear"
              fill={series[0]?.points[0]?.color || '#3b82f6'}
              fillOpacity={0.12}
              stroke="none"
              isAnimationActive={false}
            />
          )}
          {showCI && showErrorBand && isGrouped && groupValues.map(gv => (
            <Area
              key={`band_${gv}`}
              dataKey={`_band_${gv}`}
              type="linear"
              fill={groupColors[gv]}
              fillOpacity={0.12}
              stroke="none"
              isAnimationActive={false}
            />
          ))}

          {/* Lines */}
          {!isGrouped && (
            <Line
              dataKey="value"
              type="linear"
              stroke={series[0]?.points[0]?.color || '#3b82f6'}
              strokeWidth={markersOnly ? 0 : 2}
              dot={(props: Record<string, unknown>) => {
                const { cx, cy } = props as { cx: number; cy: number }
                return <CustomDot cx={cx} cy={cy} fill={series[0]?.points[0]?.color || '#3b82f6'} shape="circle" size={fmt.pointSize} />
              }}
              activeDot={{ r: fmt.pointSize + 2 }}
              isAnimationActive={false}
            >
              {showCI && !showErrorBand && (
                <ErrorBar dataKey="_ciError" width={4} strokeWidth={1.5} stroke={colors.textDark} />
              )}
            </Line>
          )}
          {isGrouped && groupValues.map((gv, gi) => (
            <Line
              key={gv}
              dataKey={gv}
              name={gv}
              type="linear"
              stroke={groupColors[gv]}
              strokeWidth={markersOnly ? 0 : 2}
              strokeDasharray={LINE_DASH_PATTERNS[gi % LINE_DASH_PATTERNS.length]}
              dot={(props: Record<string, unknown>) => {
                const { cx, cy } = props as { cx: number; cy: number }
                return <CustomDot cx={cx} cy={cy} fill={groupColors[gv]} shape={DOT_SHAPES[gi % DOT_SHAPES.length]} size={fmt.pointSize} />
              }}
              activeDot={{ r: fmt.pointSize + 2 }}
              isAnimationActive={false}
            >
              {showCI && !showErrorBand && (
                <ErrorBar dataKey={`_ciError_${gv}`} width={4} strokeWidth={1.5} stroke={colors.textDark} />
              )}
            </Line>
          ))}

          {isGrouped && (
            <Legend
              content={() => (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '12px', fontSize: fmt.labelFontSize - 1, color: colors.text, paddingTop: 8 }}>
                  {groupValues.map((gv, gi) => (
                    <span key={gv} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 12, height: 2, backgroundColor: groupColors[gv], flexShrink: 0 }} />
                      <CustomDot cx={0} cy={0} fill={groupColors[gv]} shape={DOT_SHAPES[gi % DOT_SHAPES.length]} size={4} />
                      {gv}
                      {showGroupN && groupNs?.[gv] != null && (
                        <span style={{ color: colors.textMuted }}>(n={groupNs[gv]})</span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      {isLog && (
        <div className="text-[11px] text-mm-text-faint mt-1 text-right">Log scale</div>
      )}

      {/* sr-only data table */}
      <table className="sr-only">
        <caption>Line chart data</caption>
        <thead>
          <tr>
            <th>Variable</th>
            {isGrouped ? groupValues.map(gv => <th key={gv}>{gv}</th>) : <th>Value</th>}
          </tr>
        </thead>
        <tbody>
          {chartData.map((d: ChartDataRow, i: number) => (
            <tr key={i}>
              <td>{d.label as string}</td>
              {isGrouped
                ? groupValues.map(gv => <td key={gv}>{(d[gv] as number | undefined)?.toFixed(DISPLAY_PRECISION) ?? '-'}</td>)
                : <td>{(d.value as number | undefined)?.toFixed(DISPLAY_PRECISION) ?? '-'}</td>
              }
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
