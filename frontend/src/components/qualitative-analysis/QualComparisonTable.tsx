import { Fragment, useMemo, useState } from 'react'
import { formatP, formatPValue, getSignificanceStars } from '@/lib/chart-data'
import { NO_VALUE, undefinedTooltip } from '@/lib/stat-format'
import { undefinedComparisonGroups } from '@/lib/qual-comparison'
import {
  COMPARISON_UNIT_PASSAGE,
  cannotReachSignificance, comparisonMethodNote, deltaIntervalSpoken, deltaIntervalTitle, deltaIntervalVisual,
  describeOmittedTest, unitCount,
} from '@/lib/comparison-basis'
import { columnSort, type SortDir } from '@/lib/column-sort'
import { SortableColumnHeader } from '@/components/ui/sortable-column-header'
import { QualComparisonUndefinedNote } from './QualComparisonUndefinedNote'
import type {
  DemographicComparisonResponse,
  CodeComparisonEntry,
  GroupCodeStats,
  StatTestResult,
} from '@/lib/api'

interface QualComparisonTableProps {
  data: DemographicComparisonResponse
  showEffectSize?: boolean
  onCodeClick?: (codeId: number) => void
}

type SortKey = 'code' | 'category' | 'delta' | 'p' | 'effect' | 'count'

function effectSizeBadge(value: number, type: string): { bg: string; label: string } {
  const abs = Math.abs(value)
  if (type === 'cramers_v') {
    if (abs >= 0.5) return { bg: 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300', label: 'large' }
    if (abs >= 0.3) return { bg: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300', label: 'medium' }
    if (abs >= 0.1) return { bg: 'bg-mm-bg text-mm-text-muted', label: 'small' }
    return { bg: 'bg-mm-bg text-mm-text-faint', label: '' }
  }
  // odds_ratio
  if (abs >= 4.0) return { bg: 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300', label: 'large' }
  if (abs >= 2.5) return { bg: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300', label: 'medium' }
  if (abs >= 1.5) return { bg: 'bg-mm-bg text-mm-text-muted', label: 'small' }
  return { bg: 'bg-mm-bg text-mm-text-faint', label: '' }
}

const SIG_LEVELS = { show_05: true, show_01: true, show_001: true }

/** The p this table shows: the adjusted one (#1323); the raw p only for a payload
 *  from before the basis existed. 1 when there is no test (sorts last). */
function shownP(test: StatTestResult | null | undefined): number {
  if (!test) return 1
  return test.p_adjusted ?? test.p_value
}

function pColor(p: number | undefined): string {
  if (p == null) return ''
  if (p < 0.05) return 'text-emerald-600 dark:text-emerald-400'
  if (p < 0.10) return 'text-amber-600 dark:text-amber-400'
  return 'text-mm-text-faint'
}

function pBgColor(p: number | undefined): string {
  if (p == null) return ''
  if (p < 0.01) return 'bg-emerald-50 dark:bg-emerald-950/30'
  if (p < 0.05) return 'bg-emerald-50/50 dark:bg-emerald-950/20'
  if (p < 0.10) return 'bg-amber-50/50 dark:bg-amber-950/20'
  return ''
}

export default function QualComparisonTable({
  data,
  showEffectSize = true,
  onCodeClick,
}: QualComparisonTableProps) {
  const { groups, group_totals, codes: allEntries } = data
  const is2Group = groups.length === 2
  // #1323: the n is in the result's unit, named — "n=5 participants" — never a bare
  // number a reader takes for passages (or the reverse).
  const groupN = (g: string) => {
    const t = group_totals[g]
    if (!t) return '0'
    return data.basis ? unitCount(data.basis.unit, t.n) : unitCount(COMPARISON_UNIT_PASSAGE, t.total_segments)
  }
  const methodNote = comparisonMethodNote(data)
  // #1323 D8: three or more groups take the Freeman–Halton EXACT test, which has no
  // χ² statistic — a χ² column would be "–" in every row under a header naming a
  // test that did not run. Shown only when some result carries a statistic.
  const hasStatistic = allEntries.some(e => e.test?.statistic != null)

  /**
   * #830(g): a code applied NOWHERE is not a row of this table by default.
   *
   * Measured on the Ferncrest corpus: 32 rows, 20 of them reading `– – – 0`,
   * on a 12-code result. The payload is the whole codebook, which is right —
   * the server cannot know whether a researcher wants to see what went unused
   * — but the default reading of a comparison table is "how do these groups
   * differ", and two thirds of it answering "not at all, about a code nobody
   * applied" is what makes the twelve real rows hard to find.
   *
   * ⚠️ The count is STATED and the rows stay one click away. An unused code IS
   * a finding for some questions ("did anyone use my new code?"), so this
   * hides them, never drops them — the Batch B rule that a bound chosen for
   * readability must not silently decide relevance.
   */
  const [showEmpty, setShowEmpty] = useState(false)
  const emptyCount = useMemo(
    () => allEntries.filter(e => Object.values(e.by_group).every(s => (s?.count ?? 0) === 0)).length,
    [allEntries],
  )
  // ⚠️ If EVERY code is unused, hiding them leaves a table with a header and
  // nothing under it, which reads as a broken screen rather than an answer.
  const hidingWouldEmptyTheTable = emptyCount === allEntries.length
  const hideEmpty = !showEmpty && !hidingWouldEmptyTheTable && emptyCount > 0
  const entries = useMemo(
    () => (hideEmpty
      ? allEntries.filter(e => !Object.values(e.by_group).every(s => (s?.count ?? 0) === 0))
      : allEntries),
    [allEntries, hideEmpty],
  )
  // #1421: groups with no segments in the material compared — named once, here.
  const undefinedGroups = useMemo(() => undefinedComparisonGroups(data), [data])
  const [sortKey, setSortKey] = useState<SortKey>(is2Group ? 'delta' : 'p')
  const [sortDir, setSortDir] = useState<SortDir>(is2Group ? 'desc' : 'asc')

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'code' || key === 'category' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    const copy = [...entries]
    const dir = sortDir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      switch (sortKey) {
        case 'code':
          return dir * a.code_name.localeCompare(b.code_name)
        case 'category':
          return dir * (a.category_name ?? '').localeCompare(b.category_name ?? '')
        case 'delta':
          return dir * (Math.abs(a.delta_proportion ?? 0) - Math.abs(b.delta_proportion ?? 0))
        case 'p':
          return dir * (shownP(a.test) - shownP(b.test))
        case 'effect':
          return dir * (Math.abs(a.test?.effect_size ?? 0) - Math.abs(b.test?.effect_size ?? 0))
        case 'count': {
          const aTotal = groups.reduce((sum, g) => sum + (a.by_group[g]?.count ?? 0), 0)
          const bTotal = groups.reduce((sum, g) => sum + (b.by_group[g]?.count ?? 0), 0)
          return dir * (aTotal - bTotal)
        }
        default:
          return 0
      }
    })
    return copy
  }, [entries, sortKey, sortDir, groups])

  if (entries.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No comparison data available.</div>
  }

  return (
    <div>
      {/* #830(g): the hidden rows are DECLARED, never quietly dropped. */}
      {emptyCount > 0 && !hidingWouldEmptyTheTable && (
        <div className="flex items-center gap-2 pb-1.5 text-[11px] text-mm-text-muted">
          <span>
            {showEmpty
              ? `Showing all ${allEntries.length} codes, including ${emptyCount} applied to nothing in this comparison.`
              : `${emptyCount} of ${allEntries.length} codes were applied to nothing here and are hidden.`}
          </span>
          <button
            type="button"
            className="underline hover:text-mm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mm-blue rounded"
            onClick={() => setShowEmpty(v => !v)}
          >
            {showEmpty ? 'Hide unused codes' : 'Show them'}
          </button>
        </div>
      )}
      <QualComparisonUndefinedNote groups={undefinedGroups} />
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <caption className="sr-only">
            Code frequencies compared across demographic groups.
            {hideEmpty ? ` ${emptyCount} codes applied to nothing in this comparison are hidden.` : ''}
          </caption>
          <thead>
            {/* Group header row for multi-group */}
            {!is2Group && (
              <tr className="bg-mm-bg">
                <ThCell colSpan={2} className="border-b border-r" />
                {groups.map(g => (
                  <GroupTh key={g} group={g} n={groupN(g)} passages={group_totals[g]?.total_segments ?? 0} />
                ))}
                <th scope="col" colSpan={2 + (hasStatistic ? 1 : 0) + (showEffectSize ? 1 : 0)} className="px-2 py-1.5 border-b text-center font-medium">
                  Test
                </th>
              </tr>
            )}
            <tr className="bg-mm-bg">
              <SortableTh field="code" label="Code" current={sortKey} dir={sortDir} onSort={handleSort} className="text-left min-w-[120px] border-b border-r" />
              <SortableTh field="category" label="Category" current={sortKey} dir={sortDir} onSort={handleSort} className="text-left min-w-[80px] border-b border-r" />
              {is2Group ? (
                <>
                  {groups.map(g => (
                    <GroupTh key={g} group={g} n={groupN(g)} passages={group_totals[g]?.total_segments ?? 0} />
                  ))}
                  <SortableTh field="delta" label={'\u0394 Prop'} current={sortKey} dir={sortDir} onSort={handleSort} className="text-right border-b border-r" />
                  <SortableTh field="p" label="p" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right border-b border-r" />
                  <th scope="col" className="px-2 py-1.5 border-b border-r text-center font-medium">Sig</th>
                  {showEffectSize && (
                    <SortableTh field="effect" label="Effect" current={sortKey} dir={sortDir} onSort={handleSort} className="text-center border-b" />
                  )}
                </>
              ) : (
                <>
                  {groups.map(g => (
                    <Fragment key={g}>
                      <th scope="col" className="px-2 py-1.5 border-b border-r text-right font-medium">Count</th>
                      <th scope="col" className="px-2 py-1.5 border-b border-r text-right font-medium">Prop</th>
                    </Fragment>
                  ))}
                  {hasStatistic && (
                    <th scope="col" className="px-2 py-1.5 border-b border-r text-right font-medium">{'\u03C7\u00B2'}</th>
                  )}
                  <SortableTh field="p" label="p" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right border-b border-r" />
                  <th scope="col" className="px-2 py-1.5 border-b border-r text-center font-medium">Sig</th>
                  {showEffectSize && (
                    <SortableTh field="effect" label="Effect" current={sortKey} dir={sortDir} onSort={handleSort} className="text-center border-b" />
                  )}
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map(entry => (
              <ComparisonRow
                key={entry.code_id}
                entry={entry}
                groups={groups}
                is2Group={is2Group}
                showEffectSize={showEffectSize}
                showStatistic={hasStatistic}
                onCodeClick={onCodeClick}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Method note \u2014 #1323: every word of it read from the payload's basis. The
          old note printed "Chi-square test." when no test had run (the rider). */}
      <p className="text-xs text-mm-text-faint mt-2">
        {methodNote ?? 'Method not stated by this result.'}
        {is2Group ? ` \u0394 Prop = ${groups[0]} \u2212 ${groups[1]}.` : ''}
        {data.basis && !data.basis.test_omitted_reason ? ' Significance: * p<.05, ** p<.01, *** p<.001 (adjusted).' : ''}
      </p>
    </div>
  )
}

function ComparisonRow({
  entry,
  groups,
  is2Group,
  showEffectSize,
  showStatistic,
  onCodeClick,
}: {
  entry: CodeComparisonEntry
  groups: string[]
  is2Group: boolean
  showEffectSize?: boolean
  showStatistic: boolean
  onCodeClick?: (codeId: number) => void
}) {
  // #1323: the p shown, coloured and starred is the ADJUSTED one; the raw p is in
  // the cell's description. An old payload with no adjusted p shows the raw one.
  const p = entry.test ? shownP(entry.test) : undefined
  const stars = p != null && entry.test?.significant ? getSignificanceStars(p, SIG_LEVELS) : ''
  const pTitle = entry.test
    ? `${formatPValue(entry.test.p_value)} before adjustment`
    : describeOmittedTest(entry.test_omitted_reason) ?? undefined
  const unreachable = cannotReachSignificance(entry.test)
  const sigCell = (
    <td className="px-2 py-1.5 border-b border-r text-center">
      {stars && <span className="font-bold text-emerald-600 dark:text-emerald-400">{stars}</span>}
      {unreachable && (
        <span
          className="text-[10px] text-mm-text-faint"
          title="With these group sizes this code cannot reach p < .05 after the adjustment, whatever the data."
        >
          {'can\u2019t reach'}
        </span>
      )}
    </td>
  )

  return (
    <tr
      className="hover:bg-mm-surface-hover cursor-pointer transition-colors"
      onClick={() => onCodeClick?.(entry.code_id)}
    >
      <td className="px-2 py-1.5 border-b border-r whitespace-nowrap">
        {entry.code_name}
      </td>
      <td className="px-2 py-1.5 border-b border-r text-mm-text-muted">
        {entry.category_name ?? '\u2013'}
      </td>
      {is2Group ? (
        <>
          {groups.map(g => {
            const stats = entry.by_group[g]
            return (
              <Fragment key={g}>
                <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
                  {stats?.count ?? 0}
                </td>
                <ProportionCell stats={stats} />
              </Fragment>
            )
          })}
          <td
            className="px-2 py-1.5 border-b border-r text-right tabular-nums font-medium"
            title={deltaIntervalTitle(entry.delta_ci) ?? undefined}
          >
            {/* #1421: \u0394 is null only when a group has no share \u2014 the note above says which. */}
            {entry.delta_proportion != null ? (
              <span className="inline-flex flex-col items-end">
                <span>{`${entry.delta_proportion >= 0 ? '+' : ''}${(entry.delta_proportion * 100).toFixed(1)}pp`}</span>
                {/* D3: the interval rides INSIDE the cell, on a second line \u2014 a new column
                    would push content off a 640\u00d7360 viewport (#717/#718; IrrMatrix's rule).
                    The bracket form is for the eye; the reader hears the spoken one. */}
                {/* `whitespace-nowrap`: in a narrow Canvas embed the bracket broke mid-range
                    ("[-50.5," over "79.2]" — DRIVEN 2026-10-31b); the table scrolls instead. */}
                {entry.delta_ci && (
                  <span className="text-[11px] font-normal text-mm-text-faint leading-tight whitespace-nowrap">
                    <span aria-hidden="true">{deltaIntervalVisual(entry.delta_ci)}</span>
                    <span className="sr-only"> {deltaIntervalSpoken(entry.delta_ci)}</span>
                  </span>
                )}
              </span>
            ) : NO_VALUE}
          </td>
          <td className={`px-2 py-1.5 border-b border-r text-right tabular-nums ${pColor(p)} ${pBgColor(p)}`} title={pTitle}>
            {p != null ? formatP(p) : '\u2013'}
          </td>
          {sigCell}
          {showEffectSize && (
            <EffectSizeCell test={entry.test} />
          )}
        </>
      ) : (
        <>
          {groups.map(g => {
            const stats = entry.by_group[g]
            return (
              <Fragment key={g}>
                <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
                  {stats?.count ?? 0}
                </td>
                <ProportionCell stats={stats} />
              </Fragment>
            )
          })}
          {showStatistic && (
            <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
              {entry.test?.statistic != null ? entry.test.statistic.toFixed(2) : '\u2013'}
            </td>
          )}
          <td className={`px-2 py-1.5 border-b border-r text-right tabular-nums ${pColor(p)} ${pBgColor(p)}`} title={pTitle}>
            {p != null ? formatP(p) : '\u2013'}
          </td>
          {sigCell}
          {showEffectSize && (
            <EffectSizeCell test={entry.test} />
          )}
        </>
      )}
    </tr>
  )
}

/**
 * #1421 — a group's share of its segments, or `—` when the server sent none.
 *
 * ⚠️ `proportion != null`, never truthiness: a group WITH segments that never used
 * this code is a real 0.0% and must print as one.
 */
function ProportionCell({ stats }: { stats: GroupCodeStats | undefined }) {
  if (stats?.proportion != null) {
    return (
      <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
        {`${(stats.proportion * 100).toFixed(1)}%`}
      </td>
    )
  }
  return (
    <td
      className="px-2 py-1.5 border-b border-r text-right tabular-nums text-mm-text-faint"
      title={stats ? undefinedTooltip(stats.undefined_reason) : undefined}
    >
      {stats ? NO_VALUE : '–'}
    </td>
  )
}

function EffectSizeCell({ test }: { test: StatTestResult | null }) {
  if (!test?.effect_size || !test.effect_size_label) {
    return <td className="px-2 py-1.5 border-b text-center text-mm-text-faint">{'\u2013'}</td>
  }
  const badge = effectSizeBadge(test.effect_size, test.effect_size_label)
  const label = test.effect_size_label === 'odds_ratio' ? 'OR' : "Cram\u00E9r\u2019s V"
  return (
    <td
      className="px-2 py-1.5 border-b text-center tabular-nums"
      title={`${label} = ${test.effect_size.toFixed(4)}`}
    >
      <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${badge.bg}`}>
        {test.effect_size.toFixed(2)}
      </span>
    </td>
  )
}

function ThCell({ colSpan, className, children }: { colSpan?: number; className?: string; children?: React.ReactNode }) {
  return (
    <th scope="col" colSpan={colSpan} className={`px-2 py-1.5 font-medium ${className ?? ''}`}>
      {children}
    </th>
  )
}

/**
 * #1465 — a sort header is the shared `SortableColumnHeader` (a real button in
 * the `<th>`). This was an `onClick` on the `<th>` from the table's first commit
 * (2026-02-25) until 1.6.0, so the table could not be re-sorted by keyboard.
 */
function SortableTh({
  field,
  label,
  current,
  dir,
  onSort,
  className = '',
}: {
  field: SortKey
  label: string
  current: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}) {
  return (
    <SortableColumnHeader
      label={label}
      sort={columnSort(current === field, dir)}
      onSort={() => onSort(field)}
      className={`px-2 py-1.5 font-medium select-none ${className}`}
    />
  )
}

/**
 * A group's column header: its name, then its *n* in the result's unit.
 *
 * 🔴 #1465 (D130) — the space between them is a text node in the `<th>`'s OWN
 * child list. A margin draws a gap and the name computes without one
 * ("Clinical Services(n=0)"); a space typed INSIDE the span is trimmed away by
 * the name computation (measured for #908 on `RatingSweep`'s chips).
 */
function GroupTh({ group, n, passages }: { group: string; n: string; passages: number }) {
  return (
    <th
      scope="col"
      colSpan={2}
      className="px-2 py-1.5 border-b border-r text-center font-medium"
      title={`n = ${n} with material here (${unitCount(COMPARISON_UNIT_PASSAGE, passages)})`}
    >
      {group}
      {' '}
      <span className="text-mm-text-faint font-normal">(n={n})</span>
    </th>
  )
}
