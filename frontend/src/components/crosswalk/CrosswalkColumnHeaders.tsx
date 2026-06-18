/**
 * CrosswalkColumnHeaders — the dataset column labels that anchor the grid.
 *
 * Sits above the first bracket with `padding-left: 220px` to skip over the
 * bracket label gutter, then renders one label per active dataset using the
 * shared `--crosswalk-cols` CSS custom property so the headers align exactly
 * with the cells in every row below. Layout rules:
 * the internal design notes (CSS-grid `--crosswalk-cols` + 220px label gutter).
 *
 * **Filter-aware visibility, filter-UNaware counts:** the headers only render
 * columns for currently-active datasets (driven by `useDatasetToggles` →
 * `isActive`), but each label shows the **total** column count for its
 * dataset, not a count filtered by assignment state or search. The researcher
 * needs a stable dataset-scale reference ("Board — 44 cols") that doesn't
 * drift as they build up variable groups. See `computeDatasetColumnCounts`
 * in `buildGrid.ts` for the filter-unaware count source.
 *
 * **Color stability across toggling:** each header gets a small per-dataset
 * accent dot (see `dataset-color.ts`). The accent is computed from the
 * dataset ID's position in the *full* project list (allDatasetIds), NOT in
 * the filtered active list. Toggling a dataset off and back on preserves
 * its color. The accent is a peripheral cue; the dataset name remains the
 * primary identifier.
 *
 * **Discoverability prominence (Fix B):** the original styling
 * (`text-[11px] text-mm-text-muted` on a dashed border) read as decorative
 * chrome rather than informational anchor — researchers were missing the
 * sticky header entirely and trying to identify cells by other means.
 * Bumped to `text-xs` (12px), full text color, solid border.
 *
 * Sticky positioning keeps the labels visible while the researcher scrolls
 * through many brackets.
 */

import { getDatasetAccent } from './dataset-color'
import { DatasetDotButton } from './DatasetDotButton'

interface ActiveDataset {
  dataset_id: number
  dataset_name: string
  dataset_color: string | null
}

interface CrosswalkColumnHeadersProps {
  /** Active datasets in the order they appear in the grid. Pass the
   * filtered list from `useDatasetToggles().isActive(...)` applied to the
   * project's full dataset list. */
  activeDatasets: ActiveDataset[]
  /** Total column counts per dataset (filter-unaware). */
  columnCounts: Map<number, number>
  /** Full project dataset IDs (filter-unaware). Used to compute stable
   * per-dataset accent colors that don't shift when toggling. */
  allDatasetIds: number[]
  /** Per-dataset muted predicate. When true, dot renders as a hollow
   * ring at low opacity. Click any dot to toggle this dataset across all
   * crosswalk surfaces. */
  isMuted?: (datasetId: number) => boolean
  /** Click handler for the dot — toggles per-dataset muted state. Both
   * column-header dots and cell dots route through the same toggle so
   * they stay in sync. */
  onToggleMute?: (datasetId: number) => void
  /** Right-click handler for the dot — sets the dataset's stored color.
   * Pass null to reset to the auto-assigned palette color. */
  onColorChange?: (datasetId: number, color: string | null) => void
}

export function CrosswalkColumnHeaders({
  activeDatasets,
  columnCounts,
  allDatasetIds,
  isMuted,
  onToggleMute,
  onColorChange,
}: CrosswalkColumnHeadersProps) {
  if (activeDatasets.length === 0) return null

  return (
    <div
      data-testid="crosswalk-column-headers"
      className="sticky top-0 z-10 pl-[220px] mb-3 pb-2 border-b border-mm-border-subtle bg-mm-bg/95 backdrop-blur-sm"
    >
      <div
        role="row"
        aria-label="Dataset column headers"
        className="grid gap-[var(--crosswalk-gap)] px-3"
        style={{
          gridTemplateColumns: 'var(--crosswalk-cols)',
          // #355: match EquivalenceRow's gap CSS var so the equivalence
          // indicator's gap-center calc works regardless of which container
          // sets the var first. Fallback in calc() keeps it correct if
          // both layers drop it.
          ['--crosswalk-gap' as string]: '0.625rem',
        }}
      >
        {activeDatasets.map(ds => {
          const count = columnCounts.get(ds.dataset_id) ?? 0
          const accentColor = getDatasetAccent(ds.dataset_id, allDatasetIds, ds.dataset_color)
          const muted = isMuted?.(ds.dataset_id) ?? false
          return (
            <div
              key={ds.dataset_id}
              role="columnheader"
              data-dataset-id={ds.dataset_id}
              className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-mm-text"
            >
              <DatasetDotButton
                datasetId={ds.dataset_id}
                datasetName={ds.dataset_name}
                color={accentColor}
                muted={muted}
                storedColor={ds.dataset_color}
                onToggleMute={onToggleMute ? () => onToggleMute(ds.dataset_id) : undefined}
                onColorChange={
                  onColorChange ? (c) => onColorChange(ds.dataset_id, c) : undefined
                }
              />
              <span className="truncate" title={ds.dataset_name}>
                {ds.dataset_name}
              </span>
              <span className="flex-none inline-flex items-center px-1.5 py-0.5 rounded-full bg-mm-surface text-[10px] font-medium text-mm-text-muted normal-case tracking-normal ml-1">
                {count} col{count === 1 ? '' : 's'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
