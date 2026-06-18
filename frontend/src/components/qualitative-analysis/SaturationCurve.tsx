import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { useChartColors } from '@/lib/theme-context'
import type { SaturationResponse } from '@/lib/api'
import type { RechartsTooltipProps } from '@/lib/chart-types'

interface SaturationCurveProps {
  data: SaturationResponse
}

function SaturationTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload as unknown as SaturationResponse['points'][number] | undefined
  if (!point) return null
  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{label}</div>
      <div className="space-y-0.5 text-mm-text-secondary">
        <div>Cumulative codes: <span className="font-medium text-mm-text">{point.cumulative_unique_codes}</span></div>
        <div>New codes: <span className="font-medium text-mm-text">{point.new_codes_this_source}</span></div>
        {point.new_code_names.length > 0 && (
          <div className="text-mm-text-faint">{point.new_code_names.join(', ')}</div>
        )}
      </div>
    </div>
  )
}

export default function SaturationCurve({ data }: SaturationCurveProps) {
  const chartTheme = useChartColors()

  const chartData = useMemo(() => {
    return data.points.map((pt, i) => ({
      ...pt,
      index: i + 1,
      label: pt.source_label.length > 20
        ? pt.source_label.slice(0, 17) + '\u2026'
        : pt.source_label,
    }))
  }, [data.points])

  if (chartData.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No saturation data available.</div>
  }

  const maxCodes = data.total_unique_codes

  return (
    <div>
      <div role="img" aria-label="Saturation curve showing cumulative unique codes by source">
        <ResponsiveContainer width="100%" height={360}>
          <LineChart
            data={chartData}
            margin={{ top: 8, right: 24, bottom: 40, left: 8 }}
          >
            <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: chartTheme.text }}
              axisLine={{ stroke: chartTheme.axis }}
              tickLine={{ stroke: chartTheme.axis }}
              angle={-45}
              textAnchor="end"
              height={60}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 11, fill: chartTheme.text }}
              axisLine={{ stroke: chartTheme.axis }}
              tickLine={{ stroke: chartTheme.axis }}
              domain={[0, maxCodes + 1]}
              allowDecimals={false}
              label={{
                value: 'Unique Codes',
                angle: -90,
                position: 'insideLeft',
                offset: 0,
                style: { fontSize: 11, fill: chartTheme.textMuted },
              }}
            />
            <Tooltip content={<SaturationTooltip />} />
            <ReferenceLine
              y={maxCodes}
              stroke={chartTheme.textMuted}
              strokeDasharray="5 5"
              label={{
                value: `Total: ${maxCodes}`,
                position: 'right',
                style: { fontSize: 10, fill: chartTheme.textMuted },
              }}
            />
            <Line
              type="monotone"
              dataKey="cumulative_unique_codes"
              stroke={chartTheme.accent}
              strokeWidth={2}
              dot={{ fill: chartTheme.accent, r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 text-xs text-mm-text-muted space-y-1">
        <p>
          {data.total_sources} source{data.total_sources !== 1 ? 's' : ''} analyzed.{' '}
          {data.total_unique_codes} unique {data.category_level ? 'categories' : 'codes'} found.
        </p>
        {chartData.length >= 2 && chartData[chartData.length - 1].new_codes_this_source === 0 && (
          <p className="text-emerald-600 dark:text-emerald-400">
            No new codes in the last source — potential saturation reached.
          </p>
        )}
      </div>
    </div>
  )
}
