import { Link, useLocation } from 'react-router'
import { Table2, ListTree } from 'lucide-react'
import { dataViewPath, variableViewPath } from '@/lib/dataset-routes'
import { SELECTION_TEXT_FLOOR } from '@/lib/selection'

/**
 * The Data / Variables switch for one dataset.
 *
 * ⚠️ **A `<nav>` of links, NOT `components/ui/tabs.tsx`.** Activating one of
 * these changes the URL and swaps a lazily-loaded route; `role="tab"` promises
 * a `tabpanel` that this control shows and hides within the same document,
 * which is not what happens. The ARIA pattern for "activating navigates" is a
 * list of links, and `TopRail` already establishes that shape here —
 * `<nav>` + `<Link>` + `aria-current="page"` on the active one. Radix `Tabs`
 * stays correct for a real in-page tabset (`ColumnPicker` uses it that way).
 *
 * `aria-current="page"` is the ONLY thing announcing which view you are in —
 * the tint is not available to a screen reader — so it must never be dropped
 * for a purely visual "active" class.
 *
 * ⚠️ **The active tab paints `text-mm-blue-text`, never the raw `text-mm-blue`
 * hue, and it carries `SELECTION_TEXT_FLOOR` (#852).** `--mm-blue` is a FILL
 * colour; on its own 10% tint over `--mm-surface` it measures **3.35:1 light /
 * 4.35:1 dark** as text — which is what shipped, and what Lighthouse caught at
 * 3.34 / 4.38. `--mm-blue-text` on the same tint is **5.88 / 6.93**. The floor
 * is for the COUNT, which paints `--mm-text-muted` on that tint: **4.96 / 4.33**
 * raw, **6.26 / 7.16** raised. Both clear AA now.
 *
 * ⚠️ **The tint alpha deliberately stayed at `/10` — do not "upgrade" this to
 * `SELECTED_SEGMENT`.** Measured at that recipe's alphas (0.20 light / 0.30
 * dark) the same pairs read 5.22 / 5.00 and 4.40 / **3.12** — a heavier tint
 * that LOWERS contrast and puts the count back below AA. `SELECTED_SEGMENT` is
 * the segmented-control/row/card recipe; a small tinted chip is
 * `bg-mm-blue/1x` + `text-mm-blue-text`, which ~40 other sites already use.
 * What was single-sourced here is the FLOOR, which is the part that generalises.
 *
 * ⚠️ **The count belongs to the tab it describes.** Both views render a
 * readout in the same toolbar band, and giving Variables its own count is what
 * makes the two views read as two views OF ONE THING rather than two pages.
 * Passed in rather than fetched: both callers already hold their columns query,
 * and a second fetch here would be a third consumer of a payload two components
 * already have.
 */
export default function DatasetTabs({
  projectId,
  datasetId,
  variableCount,
}: {
  projectId: number | string
  datasetId: number | string
  /** Variables in this dataset; omitted while the columns query is loading. */
  variableCount?: number
}) {
  const { pathname } = useLocation()
  // The Variables view owns exactly one path; anything else under this dataset
  // is the Data view. Keyed on the SUFFIX rather than an equality test so a
  // future sub-route of Variables still highlights the right tab.
  const onVariables = pathname.endsWith('/variables')

  const tabs = [
    {
      label: 'Data',
      to: dataViewPath(projectId, datasetId),
      icon: Table2,
      active: !onVariables,
      count: undefined as number | undefined,
    },
    {
      label: 'Variables',
      to: variableViewPath(projectId, datasetId),
      icon: ListTree,
      active: onVariables,
      count: variableCount,
    },
  ]

  return (
    <nav aria-label="Dataset views" className="flex items-center gap-1">
      {tabs.map(tab => (
        <Link
          key={tab.label}
          to={tab.to}
          aria-current={tab.active ? 'page' : undefined}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            tab.active
              ? `bg-mm-blue/10 text-mm-blue-text font-medium ${SELECTION_TEXT_FLOOR}`
              : 'text-mm-text-secondary hover:text-mm-text hover:bg-mm-surface-hover'
          }`}
        >
          <tab.icon className="w-3.5 h-3.5" aria-hidden="true" />
          {tab.label}
          {/* Explicit space: JSX strips the newline between these two children,
              so without it the accessible name reads "Variables41". */}
          {tab.count !== undefined && ' '}
          {tab.count !== undefined && (
            <span className="font-mono tabular-nums text-xs text-mm-text-muted">
              {tab.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  )
}
