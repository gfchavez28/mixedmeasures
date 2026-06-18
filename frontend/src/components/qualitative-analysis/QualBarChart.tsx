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
  Cell,
  ResponsiveContainer,
} from 'recharts'
import type { TooltipContentProps, LabelProps } from 'recharts'
import { useChartColors } from '@/lib/theme-context'
import type { SourceFrequenciesResponse } from '@/lib/api'
import type { QualValueMode, QualDenominatorMode, QualSortOrder } from '@/lib/qual-analysis-types'
import type { DataLabelPosition } from '@/lib/chart-data'
import type { ChartDataRow } from '@/lib/chart-types'
import { shapeQualBarData, computeCellValue, QUAL_GROUP_COLORS } from './qual-chart-data'

interface QualBarChartProps {
  data: SourceFrequenciesResponse
  valueMode: QualValueMode
  denominatorMode: QualDenominatorMode
  sortOrder: QualSortOrder
  groupBy?: string | null
  labelFontSize?: number
  dataFontSize?: number
  dataLabels?: DataLabelPosition
  onCodeClick?: (codeId: number) => void
}

function CustomTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  const isPercent = row?._isPercent

  if (row?._isGrouped) {
    return (
      <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
        <div className="font-medium mb-1 text-mm-text">{row._fullLabel ?? label}</div>
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
      </div>
    )
  }

  return (
    <div className="bg-mm-surface border rounded shadow-xs px-3 py-2 text-xs max-w-xs">
      <div className="font-medium mb-1 text-mm-text">{row?._fullLabel ?? label}</div>
      <div className="text-mm-text-secondary">
        {isPercent
          ? `${((payload[0]?.value as number) * 100).toFixed(1)}%`
          : `${row?.count} segment${row?.count !== 1 ? 's' : ''}`}
      </div>
    </div>
  )
}

export default function QualBarChart({
  data,
  valueMode,
  denominatorMode,
  sortOrder,
  groupBy,
  labelFontSize = 12,
  dataFontSize = 12,
  dataLabels = 'outside',
  onCodeClick,
}: QualBarChartProps) {
  const chartTheme = useChartColors()
  const isPercent = valueMode !== 'count'

  // ── Grouped mode data ──
  const groupedResult = useMemo(() => {
    if (!groupBy || !data.group_by) return null

    const groupNameSet = new Set<string>()
    for (const src of data.sources) {
      if (src.groups) {
        for (const gn of Object.keys(src.groups)) groupNameSet.add(gn)
      }
    }
    const groupNames = Array.from(groupNameSet).sort()
    if (groupNames.length === 0) return null

    const chartData = data.codes.map(code => {
      const entry: ChartDataRow = {
        label: code.name.length > 28 ? code.name.slice(0, 25) + '\u2026' : code.name,
        _fullLabel: code.name,
        _codeId: code.id,
        _isPercent: isPercent,
        _isGrouped: true,
      }
      for (const gn of groupNames) {
        let count = 0
        let wordCount = 0
        let totalSegments = 0
        let totalWordCount = 0
        let codedSegments = 0
        for (const src of data.sources) {
          const gd = src.groups?.[gn]
          if (gd) {
            const ce = gd.code_counts?.[String(code.id)]
            if (ce) {
              count += ce.count
              wordCount += ce.word_count
            }
            totalSegments += gd.total_segments
            totalWordCount += gd.total_word_count
            codedSegments += gd.coded_segments
          }
        }
        entry[gn] = computeCellValue(count, wordCount, totalSegments, totalWordCount, codedSegments, valueMode, denominatorMode)
      }
      return entry
    })

    return { chartData, groupNames }
  }, [data, groupBy, valueMode, denominatorMode, isPercent])

  // ── Simple mode data ──
  const simpleChartData = useMemo(() => {
    const bars = shapeQualBarData(data, valueMode, denominatorMode, sortOrder)
    return bars.map(b => ({
      label: b.label,
      value: b.value,
      count: b.count,
      _fullLabel: b.fullLabel,
      _codeId: b.codeId,
      _color: b.color,
      _isPercent: isPercent,
    }))
  }, [data, valueMode, denominatorMode, sortOrder, isPercent])

  const isGrouped = !!groupedResult
  const chartData: ChartDataRow[] = isGrouped ? groupedResult.chartData : simpleChartData

  const yAxisWidth = useMemo(() => {
    if (chartData.length === 0) return 120
    const longest = Math.max(...chartData.map(d => (d.label as string).length))
    return Math.min(220, Math.max(100, longest * 7))
  }, [chartData])

  if (chartData.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No data available.</div>
  }

  const groupCount = isGrouped ? groupedResult.groupNames.length : 1
  const rowHeight = isGrouped ? Math.max(44, groupCount * 20 + 16) : 32
  const chartHeight = Math.max(300, chartData.length * rowHeight + 60)

  return (
    <div role="img" aria-label="Horizontal bar chart">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: dataLabels !== 'none' ? 70 : 40, bottom: 4, left: 0 }}
        >
          <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: labelFontSize, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={{ stroke: chartTheme.axis }}
            tickFormatter={isPercent ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={yAxisWidth}
            tick={{ fontSize: labelFontSize, fill: chartTheme.text }}
            axisLine={{ stroke: chartTheme.axis }}
            tickLine={false}
          />
          <Tooltip content={<CustomTooltip />} />

          {isGrouped ? (
            <>
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
                    {groupedResult!.groupNames.map((gn, i) => (
                      <span key={gn} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          backgroundColor: QUAL_GROUP_COLORS[i % QUAL_GROUP_COLORS.length],
                          flexShrink: 0,
                        }} />
                        {gn.length > 24 ? gn.slice(0, 21) + '\u2026' : gn}
                      </span>
                    ))}
                  </div>
                )}
              />
              {groupedResult!.groupNames.map((gn, i) => (
                <Bar
                  key={gn}
                  dataKey={gn}
                  fill={QUAL_GROUP_COLORS[i % QUAL_GROUP_COLORS.length]}
                  radius={[0, 2, 2, 0]}
                  barSize={18}
                  isAnimationActive={false}
                  cursor={onCodeClick ? 'pointer' : undefined}
                  onClick={(_data: unknown, index: number) => {
                    if (onCodeClick && chartData[index]) {
                      onCodeClick(chartData[index]._codeId as number)
                    }
                  }}
                >
                  {dataLabels === 'inside' && (
                    <LabelList
                      dataKey={gn}
                      position="center"
                      style={{ fontSize: dataFontSize, fill: '#fff', fontWeight: 500 }}
                      formatter={(v: unknown) => {
                        const n = Number(v)
                        if (!n) return ''
                        return isPercent ? `${(n * 100).toFixed(0)}%` : String(n)
                      }}
                    />
                  )}
                  {dataLabels === 'outside' && (
                    <LabelList
                      dataKey={gn}
                      position="right"
                      style={{ fontSize: dataFontSize, fill: chartTheme.text, fontWeight: 500 }}
                      formatter={(v: unknown) => {
                        const n = Number(v)
                        if (!n) return ''
                        return isPercent ? `${(n * 100).toFixed(1)}%` : String(n)
                      }}
                    />
                  )}
                </Bar>
              ))}
            </>
          ) : (
            <Bar
              dataKey="value"
              radius={[0, 2, 2, 0]}
              barSize={20}
              isAnimationActive={false}
              cursor={onCodeClick ? 'pointer' : undefined}
              onClick={(_data: unknown, index: number) => {
                if (onCodeClick && simpleChartData[index]) {
                  onCodeClick(simpleChartData[index]._codeId)
                }
              }}
              label={(props: LabelProps) => {
                const { x, y, width, height, index } = props as unknown as { x: number; y: number; width: number; height: number; index: number }
                if (dataLabels === 'none') return null
                const entry = simpleChartData[index]
                if (!entry || entry.value === 0) return null

                const barEnd = x + width
                const cy = y + height / 2
                const displayValue = isPercent
                  ? `${(entry.value * 100).toFixed(1)}%`
                  : String(entry.count)

                if (dataLabels === 'inside') {
                  if (width < 40) return null
                  return (
                    <text
                      x={barEnd - 6}
                      y={cy + 4}
                      textAnchor="end"
                      fill="#fff"
                      style={{ fontSize: dataFontSize, fontWeight: 500 }}
                      aria-hidden="true"
                    >
                      {displayValue}
                    </text>
                  )
                }

                // outside
                return (
                  <text
                    x={barEnd + 4}
                    y={cy + 4}
                    fill={chartTheme.text}
                    style={{ fontSize: dataFontSize, fontWeight: 500 }}
                    aria-hidden="true"
                  >
                    {displayValue}
                  </text>
                )
              }}
            >
              {simpleChartData.map((entry, i) => (
                <Cell key={i} fill={entry._color} />
              ))}
            </Bar>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
