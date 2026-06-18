import { Fragment, useMemo, useState } from 'react'
import { formatP, getSignificanceStars } from '@/lib/chart-data'
import type {
  DemographicComparisonResponse,
  CodeComparisonEntry,
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
type SortDir = 'asc' | 'desc'

const SIG_LEVELS = { show_05: true, show_01: true, show_001: true }

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
  const { groups, group_totals, codes: entries } = data
  const is2Group = groups.length === 2
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

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null
    return <span className="ml-0.5 text-mm-text-faint">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
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
          return dir * ((a.test?.p_value ?? 1) - (b.test?.p_value ?? 1))
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
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <thead>
            {/* Group header row for multi-group */}
            {!is2Group && (
              <tr className="bg-mm-bg">
                <ThCell colSpan={2} className="border-b border-r" />
                {groups.map(g => (
                  <th
                    key={g}
                    scope="col"
                    colSpan={2}
                    className="px-2 py-1.5 border-b border-r text-center font-medium"
                    title={`n = ${group_totals[g]?.total_segments ?? 0} segments`}
                  >
                    {g}
                    <span className="text-mm-text-faint font-normal ml-1">
                      (n={group_totals[g]?.total_segments ?? 0})
                    </span>
                  </th>
                ))}
                <th scope="col" colSpan={showEffectSize ? 4 : 3} className="px-2 py-1.5 border-b text-center font-medium">
                  Test
                </th>
              </tr>
            )}
            <tr className="bg-mm-bg">
              <SortableTh field="code" label="Code" current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[120px] border-b border-r" />
              <SortableTh field="category" label="Category" current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[80px] border-b border-r" />
              {is2Group ? (
                <>
                  {groups.map(g => (
                    <th
                      key={g}
                      scope="col"
                      colSpan={2}
                      className="px-2 py-1.5 border-b border-r text-center font-medium"
                      title={`n = ${group_totals[g]?.total_segments ?? 0} segments`}
                    >
                      {g}
                      <span className="text-mm-text-faint font-normal ml-1">
                        (n={group_totals[g]?.total_segments ?? 0})
                      </span>
                    </th>
                  ))}
                  <SortableTh field="delta" label={'\u0394 Prop'} current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right border-b border-r" />
                  <SortableTh field="p" label="p" current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right border-b border-r" />
                  <th scope="col" className="px-2 py-1.5 border-b border-r text-center font-medium">Sig</th>
                  {showEffectSize && (
                    <SortableTh field="effect" label="Effect" current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-center border-b" />
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
                  <th scope="col" className="px-2 py-1.5 border-b border-r text-right font-medium">{'\u03C7\u00B2'}</th>
                  <SortableTh field="p" label="p" current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right border-b border-r" />
                  <th scope="col" className="px-2 py-1.5 border-b border-r text-center font-medium">Sig</th>
                  {showEffectSize && (
                    <SortableTh field="effect" label="Effect" current={sortKey} dir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-center border-b" />
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
                onCodeClick={onCodeClick}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Method note */}
      <p className="text-xs text-mm-text-faint mt-2">
        {is2Group
          ? `Test: Fisher\u2019s exact test. \u0394 Prop = ${groups[0]} \u2212 ${groups[1]}.`
          : `Test: ${entries[0]?.test?.method === 'fisher_exact' ? "Fisher\u2019s exact" : 'Chi-square'} test.`
        }
        {' '}Significance: * p&lt;.05, ** p&lt;.01, *** p&lt;.001.
      </p>
    </div>
  )
}

function ComparisonRow({
  entry,
  groups,
  is2Group,
  showEffectSize,
  onCodeClick,
}: {
  entry: CodeComparisonEntry
  groups: string[]
  is2Group: boolean
  showEffectSize?: boolean
  onCodeClick?: (codeId: number) => void
}) {
  const p = entry.test?.p_value
  const stars = p != null ? getSignificanceStars(p, SIG_LEVELS) : ''

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
                <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
                  {stats ? `${(stats.proportion * 100).toFixed(1)}%` : '\u2013'}
                </td>
              </Fragment>
            )
          })}
          <td className="px-2 py-1.5 border-b border-r text-right tabular-nums font-medium">
            {entry.delta_proportion != null
              ? `${entry.delta_proportion >= 0 ? '+' : ''}${(entry.delta_proportion * 100).toFixed(1)}pp`
              : '\u2013'
            }
          </td>
          <td className={`px-2 py-1.5 border-b border-r text-right tabular-nums ${pColor(p)} ${pBgColor(p)}`}>
            {p != null ? formatP(p) : '\u2013'}
          </td>
          <td className="px-2 py-1.5 border-b border-r text-center">
            {stars && <span className="font-bold text-emerald-600 dark:text-emerald-400">{stars}</span>}
          </td>
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
                <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
                  {stats ? `${(stats.proportion * 100).toFixed(1)}%` : '\u2013'}
                </td>
              </Fragment>
            )
          })}
          <td className="px-2 py-1.5 border-b border-r text-right tabular-nums">
            {entry.test?.statistic != null ? entry.test.statistic.toFixed(2) : '\u2013'}
          </td>
          <td className={`px-2 py-1.5 border-b border-r text-right tabular-nums ${pColor(p)} ${pBgColor(p)}`}>
            {p != null ? formatP(p) : '\u2013'}
          </td>
          <td className="px-2 py-1.5 border-b border-r text-center">
            {stars && <span className="font-bold text-emerald-600 dark:text-emerald-400">{stars}</span>}
          </td>
          {showEffectSize && (
            <EffectSizeCell test={entry.test} />
          )}
        </>
      )}
    </tr>
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

function SortableTh({
  field,
  label,
  current,
  dir,
  onSort,
  indicator,
  className = '',
}: {
  field: SortKey
  label: string
  current: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
  indicator: (key: SortKey) => React.ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`px-2 py-1.5 font-medium cursor-pointer select-none hover:bg-mm-surface-hover transition-colors ${className}`}
      onClick={() => onSort(field)}
      aria-sort={current === field ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {label}
      {indicator(field)}
    </th>
  )
}
