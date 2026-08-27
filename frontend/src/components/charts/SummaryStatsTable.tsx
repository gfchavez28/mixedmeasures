import { mergeFormatting } from '@/lib/chart-data'
import { formatDescriptive } from '@/lib/stat-format'
import { ciLabel, ciCaveat } from '@/lib/ci-label'
import {
  aggregateBasisCaveat, aggregateBasisLabel, aggregateNLabel, aggregateNCaveat,
  pooledNLabel, pooledNCaveat,
} from '@/lib/aggregate-basis'
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

/**
 * #823(e): descriptives, not data labels. `DISPLAY_PRECISION` (1 dp) is right
 * for the percentages and chart labels it exists for and wrong here — it
 * rendered every SE in a 43,000-respondent survey as `0.0`, and three SDs that
 * differ as `1.0`. See `formatDescriptive` for the measurements.
 */
const fmtNum = formatDescriptive

/** The #693 fields, under the names `lib/aggregate-basis.ts` reads. */
function toBasisFields(row: SummaryStatsRow) {
  return {
    member_count: row.memberCount,
    member_n_min: row.memberNMin,
    member_n_max: row.memberNMax,
  }
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
  // #715: the header names the interval for the whole column, so take the method from
  // the first row that actually has an interval. A table renders one metric type at a
  // time (see `metricType` below), so these agree in practice; reading the FIRST
  // CI-bearing row rather than `data[0]` keeps that true even when a leading metric
  // has too few items to produce one.
  const ciMethod = data.find(r => r.ciLower != null && r.ciUpper != null)?.ciMethod

  // Dynamic value column header based on metric type
  const valueHeader = metricType === 'proportion'
    ? (proportionLabel ? `% ${proportionLabel}` : '% Responding')
    : metricType === 'domain_aggregate' ? 'Score' : 'Mean'

  // #693: what the Score column IS. Taken from the payload, never from
  // `metricType` — a second aggregation (POMP) would make that inference wrong
  // while still reading as `domain_aggregate`. Same rule as `ciMethod` above.
  const basis = data.find(r => r.aggregationBasis != null)?.aggregationBasis
  const basisLabel = aggregateBasisLabel(basis)
  const basisCaveat = aggregateBasisCaveat(basis)

  if (data.length === 0) return null

  return (
    <>
    <ScrollableTable>
      <table className="border-collapse text-xs w-full" aria-label="Summary statistics">
        <caption className="sr-only">
          Descriptive summary statistics for each variable (sample size and distribution measures).
          {basisCaveat ? ` ${basisCaveat}` : ''}
        </caption>
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
                title={ciCaveat(ciMethod)}
              >
                {ciLabel(ciMethod)}
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
                title={
                  aggregateNCaveat(toBasisFields(row), row.n)
                  ?? (row.pooledAcrossDomain ? pooledNCaveat(row.n, row.memberCount) : undefined)
                }
              >
                {/* #693: a scale score's `n` is the SUM of its items'
                    respondent counts, and a sum reads as a respondent count
                    beside a mean. State the unit and the spread instead; the
                    pooled figure stays in the tooltip.
                    #823(e): a MEAN over a variable group pools values the same
                    way, and there is no better figure to show — so that one
                    states its UNIT rather than replacing the number. */}
                {aggregateNLabel(toBasisFields(row))
                  ?? (row.pooledAcrossDomain ? pooledNLabel(row.n) : row.n)}
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
                    ? `[${fmtNum(row.ciLower)}, ${fmtNum(row.ciUpper)}]`
                    : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
    {/* #693: the aggregate names itself, in the words the R export already
        uses, and says that measurement equivalence was asserted rather than
        tested. The R comment block has always been honest; a researcher who
        never generates the script saw nothing. Rendered as a visible note
        (not only a tooltip) because it qualifies every number in the table. */}
    {basisLabel && (
      <p className="text-[11px] text-mm-text-muted mt-1.5 px-1" style={{ fontSize: fmt.axisFontSize - 2 }}>
        Score = {basisLabel}. Mixed Measures does not test whether the items share a scale.
      </p>
    )}
    </>
  )
}
