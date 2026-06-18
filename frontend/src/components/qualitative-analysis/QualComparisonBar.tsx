import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { useChartColors } from '@/lib/theme-context'
import { resolveGroupColors } from '@/lib/chart-data'
import type { DemographicComparisonResponse } from '@/lib/api'
import type { ChartDataRow } from '@/lib/chart-types'

interface QualComparisonBarProps {
  data: DemographicComparisonResponse
  colorPalette?: string
  onCodeClick?: (codeId: number) => void
}

function ComparisonTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {payload.map((entry) => {
        const propVal = entry?.payload?.[`_prop_${entry.name}`] as number | undefined
        return (
          <div key={entry.name} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: entry.fill }}
            />
            <span className="text-mm-text-secondary">{entry.name}:</span>
            <span className="font-medium">
              {entry.value}
              {propVal != null && (
                <span className="text-mm-text-faint ml-1">
                  ({(propVal * 100).toFixed(1)}%)
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function QualComparisonBar({
  data,
  colorPalette = 'default',
  onCodeClick,
}: QualComparisonBarProps) {
  const chartTheme = useChartColors()
  const { groups, codes: entries } = data

  const groupColors = useMemo(() => resolveGroupColors(groups, colorPalette), [groups, colorPalette])

  const chartData = useMemo(() => {
    return entries.map(entry => {
      const row: ChartDataRow = {
        label: entry.code_name.length > 28
          ? entry.code_name.slice(0, 25) + '\u2026'
          : entry.code_name,
        _fullLabel: entry.code_name,
        _codeId: entry.code_id,
      }
      for (const g of groups) {
        const stats = entry.by_group[g]
        row[g] = stats?.count ?? 0
        row[`_prop_${g}`] = stats?.proportion ?? 0
      }
      return row
    })
  }, [entries, groups])

  const yAxisWidth = useMemo(() => {
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map(d => (d.label as string).length))
    return Math.min(220, Math.max(100, longest * 7))
  }, [chartData])

  if (chartData.length === 0 || groups.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No comparison data available.</div>
  }

  const rowHeight = 24 + groups.length * 8
  const chartHeight = Math.max(300, chartData.length * rowHeight + 60)

  return (
    <div role="img" aria-label="Code comparison bar chart by demographic group">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 40, bottom: 4, left: 0 }}
        >
          <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={{ stroke: chartTheme.axis }}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={{ fontSize: 11, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={false}
          />
          <Tooltip content={<ComparisonTooltip />} />
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
                {groups.map(g => (
                  <span key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      backgroundColor: groupColors[g],
                      flexShrink: 0,
                    }} />
                    {g}
                  </span>
                ))}
              </div>
            )}
          />
          {groups.map(g => (
            <Bar
              key={g}
              dataKey={g}
              fill={groupColors[g]}
              barSize={16}
              cursor={onCodeClick ? 'pointer' : undefined}
              onClick={(_data: unknown, index: number) => {
                if (onCodeClick && chartData[index]) {
                  onCodeClick(chartData[index]._codeId as number)
                }
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
