import { Fragment } from 'react'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import type { ComparisonRow, GroupStat } from '@/lib/api'
import { formatP, formatPValue, getSignificanceStars } from '@/lib/chart-data'
import PostHocTable from '@/components/analysis/PostHocTable'

interface GroupComparisonTableProps {
  groups: string[]
  rows: ComparisonRow[]
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  nonparametric?: boolean
  postHocExpanded?: boolean
  onPostHocToggle?: () => void
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function pColor(p: number): string {
  if (p < 0.05) return 'text-emerald-600 dark:text-emerald-400'
  if (p < 0.10) return 'text-amber-600 dark:text-amber-400'
  return 'text-mm-text'
}

function effectSizeBadge(d: number, type: string, label?: string | null): { bg: string; label: string } {
  // If the backend provides a label, use label-driven coloring
  if (label) {
    switch (label) {
      case 'large': return { bg: 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300', label: 'large' }
      case 'medium': return { bg: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300', label: 'medium' }
      case 'small': return { bg: 'bg-mm-bg text-mm-text-muted', label: 'small' }
      default: return { bg: 'bg-mm-bg text-mm-text-faint', label: '' }
    }
  }
  // Fallback to threshold-based
  const abs = Math.abs(d)
  if (type === 'cohens_d') {
    if (abs >= 0.8) return { bg: 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300', label: 'large' }
    if (abs >= 0.5) return { bg: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300', label: 'medium' }
    if (abs >= 0.2) return { bg: 'bg-mm-bg text-mm-text-muted', label: 'small' }
    return { bg: 'bg-mm-bg text-mm-text-faint', label: '' }
  }
  // eta_squared, epsilon_squared, rank_biserial_r — use label if available
  if (type === 'rank_biserial_r') {
    if (abs >= 0.5) return { bg: 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300', label: 'large' }
    if (abs >= 0.3) return { bg: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300', label: 'medium' }
    if (abs >= 0.1) return { bg: 'bg-mm-bg text-mm-text-muted', label: 'small' }
    return { bg: 'bg-mm-bg text-mm-text-faint', label: '' }
  }
  // eta_squared / epsilon_squared
  if (abs >= 0.14) return { bg: 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300', label: 'large' }
  if (abs >= 0.06) return { bg: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300', label: 'medium' }
  if (abs >= 0.01) return { bg: 'bg-mm-bg text-mm-text-muted', label: 'small' }
  return { bg: 'bg-mm-bg text-mm-text-faint', label: '' }
}

// ── Component ───────────────────────────────────────────────────────────────

export default function GroupComparisonTable({
  groups,
  rows,
  sigLevels,
  nonparametric,
  postHocExpanded,
  onPostHocToggle,
}: GroupComparisonTableProps) {
  const numGroups = groups.length
  const isTwoGroup = numGroups === 2

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-mm-text-faint text-sm">
        No comparison data available.
      </div>
    )
  }

  const firstTest = rows.find(r => r.test)?.test
  let testTypeLabel = ''
  if (nonparametric) {
    testTypeLabel = isTwoGroup ? 'Mann-Whitney U test' : 'Kruskal-Wallis H test'
  } else if (firstTest?.test_type === 'independent_t_test') {
    testTypeLabel = "Welch's t-test (unequal variances)"
  } else if (firstTest?.test_type === 'one_way_anova') {
    testTypeLabel = 'One-way ANOVA'
  }

  // Sub-column count per group
  const groupSubCols = nonparametric ? 2 : 3

  return (
    <div>
      <ScrollableTable>
        <table className="border-collapse text-[13px] w-full" aria-label="Group comparison statistics">
          <caption className="sr-only">Group comparison: per-group n, mean, and standard deviation with the significance test and effect size for each variable.</caption>
          <thead>
            {/* Header row 1: group names */}
            <tr>
              <th
                className="px-3 py-2 text-left font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface sticky left-0 z-10"
                rowSpan={2}
                style={{ minWidth: 160 }}
              >
                Variable
              </th>
              {groups.map(g => (
                <th
                  key={g}
                  scope="colgroup"
                  className="px-2 py-1.5 text-center font-medium text-mm-text border-b border-mm-border-subtle bg-mm-surface"
                  colSpan={groupSubCols}
                >
                  {g}
                </th>
              ))}
              {isTwoGroup ? (
                <th
                  scope="colgroup"
                  className="px-2 py-1.5 text-center font-medium text-mm-text-muted border-b border-mm-border-subtle bg-mm-surface"
                  colSpan={3}
                >
                  Difference
                </th>
              ) : (
                <th
                  scope="colgroup"
                  className="px-2 py-1.5 text-center font-medium text-mm-text-muted border-b border-mm-border-subtle bg-mm-surface"
                  colSpan={3}
                >
                  Test
                </th>
              )}
            </tr>
            {/* Header row 2: sub-columns */}
            <tr>
              {groups.map(g => (
                <GroupSubHeaders key={g} nonparametric={nonparametric} />
              ))}
              {nonparametric ? (
                <>
                  <SubHeader label={isTwoGroup ? 'U' : 'H'} />
                  <SubHeader label="p" />
                  <SubHeader label={isTwoGroup ? 'r' : '\u03B5\u00B2'} />
                </>
              ) : isTwoGroup ? (
                <>
                  <SubHeader label={'\u0394'} />
                  <SubHeader label="p" />
                  <SubHeader label="d" />
                </>
              ) : (
                <>
                  <SubHeader label="F/t" />
                  <SubHeader label="p" />
                  <SubHeader label={'\u03C9\u00B2'} />
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const test = row.test
              const hasPostHoc = !nonparametric && test?.test_type === 'one_way_anova'
                && test?.post_hoc?.comparisons && test.p < 0.05

              return (
                <Fragment key={`${row.source_id}-${row.source_type}`}>
                  <tr className={idx % 2 === 0 ? 'bg-mm-bg' : 'bg-mm-surface'}>
                    {/* Variable label — sticky row header */}
                    <th
                      scope="row"
                      className="px-3 py-2 text-mm-text font-medium whitespace-nowrap border-r border-mm-border-subtle sticky left-0 z-10 text-left"
                      style={{ background: 'inherit' }}
                      title={row.full_label}
                    >
                      <div className="truncate max-w-[200px]">{row.label}</div>
                    </th>

                    {/* Per-group stats */}
                    {groups.map(g => {
                      const stat = row.group_stats.find(s => s.group === g)
                      return <GroupStatCells key={g} stat={stat} nonparametric={nonparametric} />
                    })}

                    {/* Test results */}
                    {nonparametric ? (
                      <NonParametricTestCells row={row} isTwoGroup={isTwoGroup} sigLevels={sigLevels} />
                    ) : isTwoGroup ? (
                      <TwoGroupTestCells row={row} groups={groups} sigLevels={sigLevels} />
                    ) : (
                      <MultiGroupTestCells row={row} sigLevels={sigLevels} />
                    )}
                  </tr>

                  {/* Post-hoc expandable row */}
                  {hasPostHoc && (
                    <tr className={idx % 2 === 0 ? 'bg-mm-bg' : 'bg-mm-surface'}>
                      <td colSpan={1 + numGroups * groupSubCols + 3} className="p-0">
                        <PostHocTable
                          comparisons={test!.post_hoc!.comparisons}
                          variableName={row.label}
                          sigLevels={sigLevels}
                          expanded={postHocExpanded ?? true}
                          onToggle={onPostHocToggle ?? (() => {})}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </ScrollableTable>

      {/* Footer */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mm-text-faint">
        {sigLevels.show_05 && <span>* p &lt; .05</span>}
        {sigLevels.show_01 && <span>** p &lt; .01</span>}
        {sigLevels.show_001 && <span>*** p &lt; .001</span>}
        {testTypeLabel && (
          <>
            <span className="text-mm-border-medium">|</span>
            <span>{testTypeLabel}</span>
          </>
        )}
        <span className="text-mm-border-medium">|</span>
        <span>Hover cells for details</span>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SubHeader({ label }: { label: string }) {
  return (
    <th scope="col" className="px-2 py-1 text-center text-[11px] font-normal text-mm-text-faint border-b-2 border-mm-border-subtle bg-mm-surface">
      {label}
    </th>
  )
}

function GroupSubHeaders({ nonparametric }: { nonparametric?: boolean }) {
  if (nonparametric) {
    return (
      <>
        <th scope="col" className="px-2 py-1 text-center text-[11px] font-normal text-mm-text-faint border-b-2 border-mm-border-subtle bg-mm-surface">n</th>
        <th scope="col" className="px-2 py-1 text-center text-[11px] font-normal text-mm-text-faint border-b-2 border-mm-border-subtle bg-mm-surface">Mdn</th>
      </>
    )
  }
  return (
    <>
      <th scope="col" className="px-2 py-1 text-center text-[11px] font-normal text-mm-text-faint border-b-2 border-mm-border-subtle bg-mm-surface">n</th>
      <th scope="col" className="px-2 py-1 text-center text-[11px] font-normal text-mm-text-faint border-b-2 border-mm-border-subtle bg-mm-surface">M</th>
      <th scope="col" className="px-2 py-1 text-center text-[11px] font-normal text-mm-text-faint border-b-2 border-mm-border-subtle bg-mm-surface">SD</th>
    </>
  )
}

function GroupStatCells({ stat, nonparametric }: { stat: GroupStat | undefined; nonparametric?: boolean }) {
  const emptyCols = nonparametric ? 2 : 3
  if (!stat || stat.n === 0) {
    return (
      <>
        {Array.from({ length: emptyCols }).map((_, i) => (
          <td key={i} className="px-2 py-2 text-center text-mm-text-faint tabular-nums">&mdash;</td>
        ))}
      </>
    )
  }
  if (nonparametric) {
    return (
      <>
        <td className="px-2 py-2 text-center text-mm-text-muted tabular-nums" title={`n = ${stat.n}`}>{stat.n}</td>
        <td className="px-2 py-2 text-center text-mm-text tabular-nums" title={`Mdn = ${stat.median ?? '—'}`}>
          {stat.median != null ? stat.median.toFixed(2) : '—'}
        </td>
      </>
    )
  }
  return (
    <>
      <td className="px-2 py-2 text-center text-mm-text-muted tabular-nums" title={`n = ${stat.n}`}>{stat.n}</td>
      <td
        className="px-2 py-2 text-center text-mm-text tabular-nums"
        title={stat.ci_lower != null && stat.ci_upper != null ? `M = ${stat.mean}, 95% CI [${stat.ci_lower}, ${stat.ci_upper}]` : `M = ${stat.mean}`}
      >
        {stat.mean.toFixed(2)}
      </td>
      <td className="px-2 py-2 text-center text-mm-text-muted tabular-nums" title={`SD = ${stat.sd}`}>{stat.sd.toFixed(2)}</td>
    </>
  )
}

function TwoGroupTestCells({ row, groups, sigLevels }: { row: ComparisonRow; groups: string[]; sigLevels: GroupComparisonTableProps['sigLevels'] }) {
  const test = row.test
  if (!test) {
    return (
      <>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
      </>
    )
  }

  const g1 = row.group_stats.find(s => s.group === groups[0])
  const g2 = row.group_stats.find(s => s.group === groups[1])
  const delta = g1 && g2 ? (g1.mean - g2.mean) : 0
  const stars = getSignificanceStars(test.p, sigLevels)
  const badge = effectSizeBadge(test.effect_size, test.effect_size_type, test.effect_size_label)

  const ciStr = test.effect_size_ci_lower != null && test.effect_size_ci_upper != null
    ? `, 95% CI [${test.effect_size_ci_lower.toFixed(2)}, ${test.effect_size_ci_upper.toFixed(2)}]`
    : ''

  return (
    <>
      <td
        className="px-2 py-2 text-center tabular-nums text-mm-text"
        title={`\u0394 = ${delta.toFixed(2)}`}
      >
        {delta.toFixed(2)}
      </td>
      <td
        className={`px-2 py-2 text-center tabular-nums font-medium ${pColor(test.p)}`}
        title={`t(${test.df.toFixed(1)}) = ${test.statistic.toFixed(2)}, ${formatPValue(test.p)}`}
      >
        {formatP(test.p)}{stars && <sup className="ml-0.5 text-[0.7em]">{stars}</sup>}
      </td>
      <td
        className="px-2 py-2 text-center tabular-nums"
        title={`Cohen's d = ${test.effect_size.toFixed(3)}${ciStr}`}
      >
        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${badge.bg}`}>
          {test.effect_size.toFixed(2)}
        </span>
      </td>
    </>
  )
}

function MultiGroupTestCells({ row, sigLevels }: { row: ComparisonRow; sigLevels: GroupComparisonTableProps['sigLevels'] }) {
  const test = row.test
  if (!test) {
    return (
      <>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
      </>
    )
  }

  const stars = getSignificanceStars(test.p, sigLevels)
  const omegaSq = test.omega_squared
  const displayEs = omegaSq != null ? omegaSq : test.effect_size
  const badge = effectSizeBadge(displayEs, test.effect_size_type, test.effect_size_label)
  const statLabel = test.test_type === 'one_way_anova'
    ? `F(${test.df.toFixed(0)}${test.df2 != null ? ', ' + test.df2.toFixed(0) : ''})`
    : `t(${test.df.toFixed(1)})`

  const esTooltip = omegaSq != null
    ? `\u03C9\u00B2 = ${omegaSq.toFixed(3)}, \u03B7\u00B2 = ${test.effect_size.toFixed(3)}`
    : `\u03B7\u00B2 = ${test.effect_size.toFixed(3)}`

  return (
    <>
      <td
        className="px-2 py-2 text-center tabular-nums text-mm-text"
        title={`${statLabel} = ${test.statistic.toFixed(2)}`}
      >
        {test.statistic.toFixed(2)}
      </td>
      <td
        className={`px-2 py-2 text-center tabular-nums font-medium ${pColor(test.p)}`}
        title={`${statLabel} = ${test.statistic.toFixed(2)}, ${formatPValue(test.p)}`}
      >
        {formatP(test.p)}{stars && <sup className="ml-0.5 text-[0.7em]">{stars}</sup>}
      </td>
      <td
        className="px-2 py-2 text-center tabular-nums"
        title={esTooltip}
      >
        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${badge.bg}`}>
          {displayEs.toFixed(2)}
        </span>
      </td>
    </>
  )
}

function NonParametricTestCells({ row, isTwoGroup, sigLevels }: { row: ComparisonRow; isTwoGroup: boolean; sigLevels: GroupComparisonTableProps['sigLevels'] }) {
  const test = row.test
  if (!test) {
    return (
      <>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
        <td className="px-2 py-2 text-center text-mm-text-faint">&mdash;</td>
      </>
    )
  }

  const stars = getSignificanceStars(test.p, sigLevels)
  const badge = effectSizeBadge(test.effect_size, test.effect_size_type, test.effect_size_label)
  const statLabel = isTwoGroup ? 'U' : `H(${test.df.toFixed(0)})`
  // \u03B5\u00B2 (epsilon-squared) \u2014 must match the column header (#430); the backend
  // computes Tomczak & Tomczak (2014) epsilon-squared for Kruskal-Wallis.
  const esLabel = isTwoGroup ? 'r' : '\u03B5\u00B2'

  return (
    <>
      <td
        className="px-2 py-2 text-center tabular-nums text-mm-text"
        title={`${statLabel} = ${test.statistic.toFixed(2)}`}
      >
        {test.statistic.toFixed(2)}
      </td>
      <td
        className={`px-2 py-2 text-center tabular-nums font-medium ${pColor(test.p)}`}
        title={`${statLabel} = ${test.statistic.toFixed(2)}, ${formatPValue(test.p)}`}
      >
        {formatP(test.p)}{stars && <sup className="ml-0.5 text-[0.7em]">{stars}</sup>}
      </td>
      <td
        className="px-2 py-2 text-center tabular-nums"
        title={`${esLabel} = ${test.effect_size.toFixed(3)}`}
      >
        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${badge.bg}`}>
          {test.effect_size.toFixed(2)}
        </span>
      </td>
    </>
  )
}
