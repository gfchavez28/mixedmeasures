import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
  ResponsiveContainer,
} from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { useChartColors } from '@/lib/theme-context'
import type { SourceFrequenciesResponse } from '@/lib/api'
import type { QualOrientation, QualSortOrder, QualValueMode, QualDenominatorMode } from '@/lib/qual-analysis-types'
import type { DataLabelPosition } from '@/lib/chart-data'
import type { ChartDataRow } from '@/lib/chart-types'
import { shapeQualStackedBarData } from './qual-chart-data'

interface QualStackedBarProps {
  data: SourceFrequenciesResponse
  orientation: QualOrientation
  sortOrder: QualSortOrder
  valueMode?: QualValueMode
  denominatorMode?: QualDenominatorMode
  labelFontSize?: number
  dataFontSize?: number
  dataLabels?: DataLabelPosition
  onBarClick?: (id: number) => void
}

function CustomTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  const isPercent = row?._isPercent
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-sm flex-shrink-0"
            style={{ backgroundColor: entry.fill }}
          />
          <span className="text-mm-text-secondary">{entry.name}:</span>
          <span className="font-medium">
            {isPercent ? `${((entry.value as number) * 100).toFixed(1)}%` : entry.value}
          </span>
        </div>
      ))}
      {row?._total != null && (
        <div className="text-mm-text-faint mt-1 pt-1 border-t">
          Total: {isPercent ? `${(row._total * 100).toFixed(1)}%` : row._total}
        </div>
      )}
    </div>
  )
}

export default function QualStackedBar({
  data,
  orientation,
  sortOrder,
  valueMode = 'count',
  denominatorMode = 'total',
  labelFontSize,
  dataFontSize,
  dataLabels = 'none',
  onBarClick,
}: QualStackedBarProps) {
  const chartTheme = useChartColors()
  const stackedData = useMemo(
    () => shapeQualStackedBarData(data, orientation, sortOrder, valueMode, denominatorMode),
    [data, orientation, sortOrder, valueMode, denominatorMode],
  )

  const { rows, segmentLabels, colors } = stackedData

  const chartData = useMemo(() => {
    return rows.map(row => {
      const entry: ChartDataRow = {
        label: row.label.length > 28 ? row.label.slice(0, 25) + '\u2026' : row.label,
        _fullLabel: row.label,
        _id: row.id,
        _total: row.total,
        _isPercent: valueMode !== 'count',
      }
      for (const seg of segmentLabels) {
        entry[seg] = row.segments[seg] ?? 0
      }
      return entry
    })
  }, [rows, segmentLabels, valueMode])

  const yAxisWidth = useMemo(() => {
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map(d => (d.label as string).length))
    return Math.min(220, Math.max(100, longest * 7))
  }, [chartData])

  if (chartData.length === 0 || segmentLabels.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No data available.</div>
  }

  const rowHeight = 32
  const chartHeight = Math.max(300, chartData.length * rowHeight + 60)

  return (
    <div role="img" aria-label="Stacked bar chart">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 40, bottom: 4, left: 0 }}
        >
          <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: labelFontSize ?? 11, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={{ stroke: chartTheme.axis }}
            tickFormatter={valueMode !== 'count' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={{ fontSize: labelFontSize ?? 11, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={false}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            content={() => (
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '12px',
                fontSize: 11,
                color: chartTheme.text,
                paddingTop: 8,
              }}>
                {segmentLabels.map(label => (
                  <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      backgroundColor: colors[label],
                      flexShrink: 0,
                    }} />
                    {label.length > 24 ? label.slice(0, 21) + '\u2026' : label}
                  </span>
                ))}
              </div>
            )}
          />
          {segmentLabels.map(label => (
            <Bar
              key={label}
              dataKey={label}
              stackId="stack"
              fill={colors[label]}
              barSize={20}
              isAnimationActive={false}
              cursor={onBarClick ? 'pointer' : undefined}
              onClick={(_data: unknown, index: number) => {
                if (onBarClick && chartData[index]) {
                  onBarClick(chartData[index]._id as number)
                }
              }}
            >
              {dataLabels === 'inside' && (
                <LabelList
                  dataKey={label}
                  position="center"
                  style={{ fontSize: dataFontSize ?? 10, fill: '#fff', fontWeight: 500 }}
                  formatter={(v: unknown) => {
                    const n = Number(v)
                    if (!n) return ''
                    return valueMode !== 'count' ? `${(n * 100).toFixed(0)}%` : String(n)
                  }}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
