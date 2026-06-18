import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { useTheme } from '@/lib/theme-context'
import type { VariableMissingSummary } from '@/lib/api'

interface MissingBarChartProps {
  variables: VariableMissingSummary[]
  sortBy?: 'pct_missing' | 'name' | 'dataset'
}

function severityColor(pct: number, isDark: boolean): string {
  if (pct === 0) return isDark ? '#4b5563' : '#d1d5db'
  if (pct < 5) return isDark ? '#059669' : '#34d399'
  if (pct < 10) return isDark ? '#d97706' : '#fbbf24'
  if (pct < 20) return isDark ? '#ea580c' : '#fb923c'
  return isDark ? '#dc2626' : '#f87171'
}

export default function MissingBarChart({ variables, sortBy = 'pct_missing' }: MissingBarChartProps) {
  const { isDark } = useTheme()

  const sorted = useMemo(() => {
    const arr = [...variables]
    switch (sortBy) {
      case 'pct_missing':
        arr.sort((a, b) => b.pct_missing - a.pct_missing)
        break
      case 'name':
        arr.sort((a, b) => a.variable_name.localeCompare(b.variable_name))
        break
      case 'dataset':
        arr.sort((a, b) => a.dataset_name.localeCompare(b.dataset_name) || b.pct_missing - a.pct_missing)
        break
    }
    return arr
  }, [variables, sortBy])

  const data = useMemo(() =>
    sorted.map(v => ({
      name: v.variable_name,
      fullLabel: v.full_label,
      pct: v.pct_missing,
      n_missing: v.n_missing,
      n_total: v.n_total,
      dataset: v.dataset_name,
    })),
    [sorted]
  )

  const height = Math.max(300, data.length * 28)

  const textColor = isDark ? '#a1a1aa' : '#71717a'
  const gridColor = isDark ? '#27272a' : '#e4e4e7'
  const refLineColor = isDark ? '#52525b' : '#a1a1aa'

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 20, right: 24, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          tick={{ fontSize: 11, fill: textColor }}
          tickFormatter={(v: number) => `${v}%`}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          tick={{ fontSize: 11, fill: textColor }}
          tickFormatter={(v: string) => v.length > 20 ? v.slice(0, 18) + '\u2026' : v}
        />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null
            const d = payload[0].payload
            return (
              <div className="bg-mm-surface border rounded-lg shadow-lg px-3 py-2 text-xs space-y-0.5">
                <div className="font-medium text-mm-text">{d.fullLabel}</div>
                <div className="text-mm-text-muted">{d.dataset}</div>
                <div className="text-mm-text tabular-nums">
                  {d.n_missing} / {d.n_total} ({d.pct.toFixed(1)}%)
                </div>
              </div>
            )
          }}
        />

        {/* Reference lines */}
        <ReferenceLine x={5} stroke={refLineColor} strokeDasharray="4 4" label={{ value: '5%', position: 'top', fontSize: 9, fill: refLineColor }} />
        <ReferenceLine x={10} stroke={refLineColor} strokeDasharray="4 4" label={{ value: '10%', position: 'top', fontSize: 9, fill: refLineColor }} />
        <ReferenceLine x={20} stroke={refLineColor} strokeDasharray="4 4" label={{ value: '20%', position: 'top', fontSize: 9, fill: refLineColor }} />

        <Bar dataKey="pct" radius={[0, 3, 3, 0]} maxBarSize={20}>
          {data.map((entry, idx) => (
            <Cell key={idx} fill={severityColor(entry.pct, isDark)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
