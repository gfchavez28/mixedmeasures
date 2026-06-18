import { useState, useMemo } from 'react'
import type { VariableMissingSummary } from '@/lib/api'
import { TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'

type SortField = 'pct_missing' | 'name' | 'dataset' | 'n_missing' | 'n_total' | 'n_empty' | 'n_na'

interface MissingSummaryTableProps {
  variables: VariableMissingSummary[]
  totalCells: number
  totalMissing: number
  overallPctMissing: number
  sortBy?: SortField
  onSortChange?: (field: SortField) => void
}

function severityClass(pct: number): string {
  if (pct === 0) return ''
  if (pct < 5) return 'bg-emerald-50 dark:bg-emerald-950/20'
  if (pct < 10) return 'bg-yellow-50 dark:bg-yellow-950/20'
  if (pct < 20) return 'bg-orange-50 dark:bg-orange-950/20'
  return 'bg-red-50 dark:bg-red-950/20'
}

export default function MissingSummaryTable({
  variables,
  totalCells,
  totalMissing,
  overallPctMissing,
  sortBy: externalSort,
  onSortChange,
}: MissingSummaryTableProps) {
  const [internalSort, setInternalSort] = useState<SortField>('pct_missing')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sortBy = externalSort || internalSort

  const handleSort = (field: SortField) => {
    if (field === sortBy) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      if (onSortChange) onSortChange(field)
      else setInternalSort(field)
      setSortDir(field === 'name' || field === 'dataset' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    const arr = [...variables]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return dir * a.variable_name.localeCompare(b.variable_name)
        case 'dataset':
          return dir * a.dataset_name.localeCompare(b.dataset_name)
        case 'n_total':
          return dir * (a.n_total - b.n_total)
        case 'n_missing':
          return dir * (a.n_missing - b.n_missing)
        case 'pct_missing':
          return dir * (a.pct_missing - b.pct_missing)
        case 'n_empty':
          return dir * (a.n_empty - b.n_empty)
        case 'n_na':
          return dir * (a.n_na - b.n_na)
        default:
          return 0
      }
    })
    return arr
  }, [variables, sortBy, sortDir])

  const arrow = sortDir === 'asc' ? '\u2191' : '\u2193'

  return (
    <div className="overflow-x-auto border rounded-lg">
      <table className="border-collapse text-[13px] w-full">
        <thead>
          <tr>
            {/* Variable — sticky */}
            <th
              className="px-3 py-2 text-left font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface sticky left-0 z-10 cursor-pointer select-none"
              style={{ minWidth: 160 }}
              onClick={() => handleSort('name')}
              aria-sort={sortBy === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Variable {sortBy === 'name' && arrow}
            </th>
            <th
              className="px-3 py-2 text-left font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface cursor-pointer select-none"
              onClick={() => handleSort('dataset')}
              aria-sort={sortBy === 'dataset' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              Dataset {sortBy === 'dataset' && arrow}
            </th>
            <th className="px-3 py-2 text-center font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface">
              Type
            </th>
            <th
              className="px-3 py-2 text-right font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface cursor-pointer select-none"
              onClick={() => handleSort('n_total')}
              aria-sort={sortBy === 'n_total' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              N Total {sortBy === 'n_total' && arrow}
            </th>
            <th className="px-3 py-2 text-right font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface">
              N Valid
            </th>
            <th
              className="px-3 py-2 text-right font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface cursor-pointer select-none"
              onClick={() => handleSort('n_missing')}
              aria-sort={sortBy === 'n_missing' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              N Missing {sortBy === 'n_missing' && arrow}
            </th>
            <th
              className="px-3 py-2 text-right font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface cursor-pointer select-none"
              onClick={() => handleSort('pct_missing')}
              aria-sort={sortBy === 'pct_missing' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              % Missing {sortBy === 'pct_missing' && arrow}
            </th>
            <th
              className="px-3 py-2 text-right font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface cursor-pointer select-none"
              onClick={() => handleSort('n_empty')}
              aria-sort={sortBy === 'n_empty' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              N Empty {sortBy === 'n_empty' && arrow}
            </th>
            <th
              className="px-3 py-2 text-right font-medium text-mm-text-muted border-b-2 border-mm-border-subtle bg-mm-surface cursor-pointer select-none"
              onClick={() => handleSort('n_na')}
              aria-sort={sortBy === 'n_na' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              N NA {sortBy === 'n_na' && arrow}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v, idx) => (
            <tr key={v.column_id} className={idx % 2 === 0 ? 'bg-mm-bg' : 'bg-mm-surface'}>
              <td
                className="px-3 py-2 text-mm-text font-medium whitespace-nowrap border-r border-mm-border-subtle sticky left-0 z-10"
                style={{ background: 'inherit' }}
                title={v.full_label}
              >
                <div className="truncate max-w-[200px]">{v.variable_name}</div>
              </td>
              <td className="px-3 py-2 text-mm-text-muted text-xs whitespace-nowrap">
                {v.dataset_name}
              </td>
              <td className="px-3 py-2 text-center">
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${TYPE_BADGE_CLASSES[v.column_type] || 'bg-mm-bg text-mm-text-muted'}`}>
                  {v.column_type}
                </span>
              </td>
              <td className="px-3 py-2 text-right text-mm-text tabular-nums">{v.n_total}</td>
              <td className="px-3 py-2 text-right text-mm-text tabular-nums">{v.n_valid}</td>
              <td className="px-3 py-2 text-right text-mm-text tabular-nums">{v.n_missing}</td>
              <td className={`px-3 py-2 text-right text-mm-text tabular-nums font-medium ${severityClass(v.pct_missing)}`}>
                {v.pct_missing.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right text-mm-text-muted tabular-nums">{v.n_empty}</td>
              <td className="px-3 py-2 text-right text-mm-text-muted tabular-nums">{v.n_na}</td>
            </tr>
          ))}
        </tbody>
        {/* Summary footer */}
        <tfoot>
          <tr className="border-t-2 border-mm-border-subtle bg-mm-surface font-medium">
            <td className="px-3 py-2 text-mm-text sticky left-0 z-10 bg-mm-surface">Total</td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-right text-mm-text tabular-nums">{totalCells}</td>
            <td className="px-3 py-2 text-right text-mm-text tabular-nums">{totalCells - totalMissing}</td>
            <td className="px-3 py-2 text-right text-mm-text tabular-nums">{totalMissing}</td>
            <td className={`px-3 py-2 text-right text-mm-text tabular-nums ${severityClass(overallPctMissing)}`}>
              {overallPctMissing.toFixed(1)}%
            </td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2" />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
