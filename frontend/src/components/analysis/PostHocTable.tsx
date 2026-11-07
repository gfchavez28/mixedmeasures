import { useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatP, getSignificanceStars } from '@/lib/chart-data'
import { columnSort } from '@/lib/column-sort'
import { SortableColumnHeader } from '@/components/ui/sortable-column-header'

interface PostHocComparison {
  group_a: string
  group_b: string
  mean_diff: number
  p: number
  ci_lower: number
  ci_upper: number
}

interface PostHocTableProps {
  comparisons: PostHocComparison[]
  variableName: string
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  expanded: boolean
  onToggle: () => void
}

function pColor(p: number): string {
  if (p < 0.05) return 'text-emerald-600 dark:text-emerald-400'
  if (p < 0.10) return 'text-amber-600 dark:text-amber-400'
  return 'text-mm-text'
}

export default function PostHocTable({
  comparisons,
  variableName,
  sigLevels,
  expanded,
  onToggle,
}: PostHocTableProps) {
  const [sortAsc, setSortAsc] = useState(true)
  const tableId = useId()

  const sorted = useMemo(() => {
    const copy = [...comparisons]
    copy.sort((a, b) => sortAsc ? a.p - b.p : b.p - a.p)
    return copy
  }, [comparisons, sortAsc])

  const sigCount = comparisons.filter(c => c.p < 0.05).length

  return (
    <div className="pl-4 pr-2 py-1.5">
      <button
        className="flex items-center gap-1.5 text-[11px] text-mm-text-muted hover:text-mm-text transition-colors"
        onClick={onToggle}
        aria-expanded={expanded}
        // #853 — the id is `useId()`, never the variable NAME. MM labels
        // routinely contain spaces ("Trust scale A (Depends = middle)"), an id
        // with ASCII whitespace is invalid HTML, and `aria-controls` is an
        // ID-LIST attribute — so the value parsed as six tokens, none of which
        // resolved. A reader was told the button controls something and could
        // not reach it.
        //
        // ⚠️ And only while the table EXISTS. `aria-controls` pointing at an
        // unmounted element is the same `aria-valid-attr-value` failure by
        // another route, which this entry's own history records TWICE (the
        // dangling `rctab-*` idrefs, and `ColumnPicker`'s unmounted
        // `TabsContent`). Fixing the id alone would have left the third
        // instance live in the collapsed state, which is the state this
        // disclosure spends most of its life in.
        aria-controls={expanded ? tableId : undefined}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>Tukey HSD post-hoc ({sigCount} of {comparisons.length} pairs significant)</span>
      </button>

      {expanded && (
        <table
          id={tableId}
          className="mt-1.5 border-collapse text-[11px] w-full"
          aria-label={`Tukey HSD post-hoc comparisons for ${variableName}`}
        >
          <caption className="sr-only">
            Tukey HSD post-hoc pairwise comparisons for {variableName}: group A, group B, mean difference, p-value, and 95% confidence interval for each pair of groups.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-normal text-mm-text-faint">Group A</th>
              <th scope="col" className="px-2 py-1 text-left font-normal text-mm-text-faint">Group B</th>
              <th scope="col" className="px-2 py-1 text-right font-normal text-mm-text-faint">&Delta;</th>
              {/* #1465 (D128/D129) \u2014 the shared header: a real button (this was an
                  `onClick` on the `<th>`, mouse-only), named "p" with the arrow
                  hidden, the order in `aria-sort`. Its "Click to toggle sort
                  order" title went with the click. */}
              <SortableColumnHeader
                label="p"
                sort={columnSort(true, sortAsc ? 'asc' : 'desc')}
                onSort={() => setSortAsc(v => !v)}
                className="px-2 py-1 text-right font-normal text-mm-text-faint select-none"
              />
              <th scope="col" className="px-2 py-1 text-right font-normal text-mm-text-faint">95% CI</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(comp => {
              const stars = getSignificanceStars(comp.p, sigLevels)
              return (
                <tr key={`${comp.group_a}-${comp.group_b}`} className="hover:bg-mm-surface-hover">
                  <td className="px-2 py-1 text-mm-text-secondary">{comp.group_a}</td>
                  <td className="px-2 py-1 text-mm-text-secondary">{comp.group_b}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-mm-text">{comp.mean_diff.toFixed(2)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums font-medium ${pColor(comp.p)}`}>
                    {formatP(comp.p)}{stars && <sup className="ml-0.5 text-[0.65em]">{stars}</sup>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-mm-text-muted">
                    [{comp.ci_lower.toFixed(2)}, {comp.ci_upper.toFixed(2)}]
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="px-2 pt-1.5 text-[10px] text-mm-text-faint italic">
                Tukey HSD post-hoc comparisons
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}
