import { DISPLAY_PRECISION, mergeFormatting } from '@/lib/chart-data'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { useChartColors } from '@/lib/theme-context'
import type { SummaryStatsRow, ChartFormatting } from '@/lib/chart-data'

interface SummaryStatsTableProps {
  data: SummaryStatsRow[]
  showCI?: boolean
  formatting?: Partial<ChartFormatting>
  metricType?: string
  proportionLabel?: string
}

function fmtNum(v: number | null): string {
  if (v == null) return '—'
  return v.toFixed(DISPLAY_PRECISION)
}

export default function SummaryStatsTable({
  data,
  showCI = false,
  formatting: fmtProp,
  metricType,
  proportionLabel,
}: SummaryStatsTableProps) {
  const fmt = mergeFormatting(fmtProp)
  const colors = useChartColors()

  // Determine which optional columns have data
  const hasSD = data.some(r => r.sd != null)
  const hasSE = data.some(r => r.se != null)
  const hasMin = data.some(r => r.min != null)
  const hasMax = data.some(r => r.max != null)
  const hasMedian = data.some(r => r.median != null)
  const hasCI = showCI && data.some(r => r.ciLower != null && r.ciUpper != null)

  // Dynamic value column header based on metric type
  const valueHeader = metricType === 'proportion'
    ? (proportionLabel ? `% ${proportionLabel}` : '% Responding')
    : metricType === 'domain_aggregate' ? 'Score' : 'Mean'

  if (data.length === 0) return null

  return (
    <ScrollableTable role="table" aria-label="Summary statistics table">
      <table className="border-collapse text-xs w-full">
        <thead className="sticky top-0 bg-mm-surface z-10">
          <tr>
            <th
              scope="col"
              className="text-left px-3 py-2 font-medium border-b border-r"
              style={{ fontSize: fmt.labelFontSize, color: colors.text, minWidth: 180 }}
            >
              Variable
            </th>
            <th
              scope="col"
              className="text-center px-2 py-2 font-medium border-b"
              style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 50 }}
            >
              n
            </th>
            <th
              scope="col"
              className="text-center px-2 py-2 font-medium border-b max-w-[120px] truncate"
              style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 60 }}
              title={valueHeader}
            >
              {valueHeader}
            </th>
            {hasSD && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 50 }}
              >
                SD
              </th>
            )}
            {hasSE && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 50 }}
              >
                SE
              </th>
            )}
            {hasMin && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 50 }}
              >
                Min
              </th>
            )}
            {hasMax && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 50 }}
              >
                Max
              </th>
            )}
            {hasMedian && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 60 }}
              >
                Median
              </th>
            )}
            {hasCI && (
              <th
                scope="col"
                className="text-center px-2 py-2 font-medium border-b"
                style={{ fontSize: fmt.axisFontSize - 1, color: colors.text, minWidth: 100 }}
              >
                95% CI
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map(row => (
            <tr key={row.metricId}>
              <th
                scope="row"
                className="text-left px-3 py-2 font-medium border-r"
                style={{ fontSize: fmt.labelFontSize, color: colors.textDark }}
                title={row.fullLabel || row.label}
              >
                {row.label}
              </th>
              <td
                className="text-center px-2 py-2 tabular-nums"
                style={{ fontSize: fmt.labelFontSize, color: colors.text }}
              >
                {row.n}
              </td>
              <td
                className="text-center px-2 py-2 tabular-nums font-semibold"
                style={{ fontSize: fmt.labelFontSize, color: colors.textDark }}
              >
                {fmtNum(row.mean)}
              </td>
              {hasSD && (
                <td
                  className="text-center px-2 py-2 tabular-nums"
                  style={{ fontSize: fmt.labelFontSize, color: colors.text }}
                >
                  {fmtNum(row.sd)}
                </td>
              )}
              {hasSE && (
                <td
                  className="text-center px-2 py-2 tabular-nums"
                  style={{ fontSize: fmt.labelFontSize, color: colors.text }}
                >
                  {fmtNum(row.se)}
                </td>
              )}
              {hasMin && (
                <td
                  className="text-center px-2 py-2 tabular-nums"
                  style={{ fontSize: fmt.labelFontSize, color: colors.text }}
                >
                  {fmtNum(row.min)}
                </td>
              )}
              {hasMax && (
                <td
                  className="text-center px-2 py-2 tabular-nums"
                  style={{ fontSize: fmt.labelFontSize, color: colors.text }}
                >
                  {fmtNum(row.max)}
                </td>
              )}
              {hasMedian && (
                <td
                  className="text-center px-2 py-2 tabular-nums"
                  style={{ fontSize: fmt.labelFontSize, color: colors.text }}
                >
                  {fmtNum(row.median)}
                </td>
              )}
              {hasCI && (
                <td
                  className="text-center px-2 py-2 tabular-nums"
                  style={{ fontSize: fmt.labelFontSize, color: colors.textMuted }}
                >
                  {row.ciLower != null && row.ciUpper != null
                    ? `[${row.ciLower.toFixed(DISPLAY_PRECISION)}, ${row.ciUpper.toFixed(DISPLAY_PRECISION)}]`
                    : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
  )
}
