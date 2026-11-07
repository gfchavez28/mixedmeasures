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
import type { TooltipContentProps, BarRectangleItem } from 'recharts'
import { useChartColors } from '@/lib/theme-context'
import { resolveGroupColors } from '@/lib/chart-data'
import { NO_VALUE } from '@/lib/stat-format'
import { comparisonBarRows, undefinedComparisonGroups } from '@/lib/qual-comparison'
import { comparisonMethodNote } from '@/lib/comparison-basis'
import { QualComparisonUndefinedNote } from './QualComparisonUndefinedNote'
import type { DemographicComparisonResponse } from '@/lib/api'
import type { ChartDataRow } from '@/lib/chart-types'
import { ChartFigure } from '@/components/charts/ChartFigure'
import { barClickRow } from '@/components/charts/bar-row-label'

interface QualComparisonBarProps {
  data: DemographicComparisonResponse
  colorPalette?: string
  onCodeClick?: (codeId: number) => void
}

export function ComparisonTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      {payload.map((entry) => {
        // #1421: null when the group has no share — `(—)`, never "(0.0%)"; the
        // note under the chart names the group and the reason.
        const propVal = entry?.payload?.[`_prop_${entry.name}`] as number | null | undefined
        return (
          <div key={entry.name} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: entry.fill }}
            />
            <span className="text-mm-text-secondary">{entry.name}:</span>
            <span className="font-medium">
              {entry.value}
              <span className="text-mm-text-faint ml-1">
                ({propVal != null ? `${(propVal * 100).toFixed(1)}%` : NO_VALUE})
              </span>
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

  const chartData = useMemo(() => comparisonBarRows(entries, groups), [entries, groups])
  const undefinedGroups = useMemo(() => undefinedComparisonGroups(data), [data])
  const methodNote = useMemo(() => comparisonMethodNote(data), [data])

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
    <ChartFigure label="Code comparison bar chart by demographic group">
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
              onClick={(clicked: BarRectangleItem) => {
                // #1314: the clicked bar's own row — never `chartData[index]`, which recharts
                // numbers past a group's unused code (bar-row-label.ts).
                const codeId = barClickRow<ChartDataRow>(clicked)?._codeId as number | undefined
                if (onCodeClick && codeId != null) onCodeClick(codeId)
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <QualComparisonUndefinedNote groups={undefinedGroups} />
      {/* #1323: the bars are counts in the result's UNIT — said inside the figure so
          its PNG (Canvas, export) carries it. */}
      {methodNote && <p className="pt-1 text-[11px] text-mm-text-muted">{methodNote}</p>}
    </ChartFigure>
  )
}
