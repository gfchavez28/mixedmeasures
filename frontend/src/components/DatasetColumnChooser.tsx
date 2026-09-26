/**
 * #973 (c) — choosing which columns to import, for a file the cell cap refuses.
 *
 * 🔴 **This is a RECOVERY step, not a new stage of every import.** It appears
 * only when a file is over `MAX_DATASET_CELLS`, because before it such a file
 * was a dead end: every reader on the dataset path refuses before it has a
 * column list (`.xlsx` on declared dimensions, `.sav` on metadata, the CSV
 * preview by bailing mid-stream), so the researcher was told to "remove columns
 * you do not need" and shown none of them. Making it a step of every import
 * would put friction on the 99% of files that fit, to fix the 1% that do not.
 *
 * ⚠️ **The budget arithmetic is the SERVER'S.** `cells`, `max_cells` and the row
 * count all ride the `/columns` payload; this component multiplies the row count
 * by how many columns are ticked and compares. It holds no copy of the
 * threshold, so it cannot predict a refusal at a number the server would not
 * refuse at (#974's rule).
 *
 * ⚠️ **A `.sav` file reports its row count as -1 when SPSS recorded it as
 * unknown (#539).** The budget is then unknowable before the read, so the live
 * counter is withheld rather than guessed and the researcher is told why.
 */
import { useId, useMemo } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { DatasetColumnsResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface DatasetColumnChooserProps {
  fileName: string
  summary: DatasetColumnsResponse
  /** Ticked columns, as ORIGINAL indices. Order follows the file. */
  selected: Set<number>
  onToggle: (columnIndex: number) => void
  onSelectAll: () => void
  onSelectNone: () => void
  onContinue: () => void
  onCancel: () => void
  busy?: boolean
}

/** How many columns fit at this row count, or null when rows are unknown.
 *
 *  ⚠️ Deliberately NOT exported: a non-component export in a component file
 *  breaks Fast Refresh (`react-refresh/only-export-components`), and this is
 *  covered through what the component RENDERS, which is the claim that matters. */
function columnsThatFit(summary: DatasetColumnsResponse): number | null {
  if (summary.total_rows <= 0) return null
  return Math.floor(summary.max_cells / summary.total_rows)
}

export function DatasetColumnChooser({
  fileName,
  summary,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  onContinue,
  onCancel,
  busy = false,
}: DatasetColumnChooserProps) {
  const headingId = useId()
  const budgetId = useId()

  const rowsKnown = summary.total_rows >= 0
  const selectedCells = rowsKnown ? summary.total_rows * selected.size : null
  const overBudget = selectedCells !== null && selectedCells > summary.max_cells
  const fits = columnsThatFit(summary)

  const budget = useMemo(() => {
    if (!rowsKnown) {
      // #539: SPSS may legally record its row count as unknown. Say so rather
      // than show a number that is not one.
      return `This file does not declare how many records it has, so the size cannot be checked before importing. Choosing fewer columns makes it more likely to fit.`
    }
    return `${summary.total_rows.toLocaleString()} records × ${selected.size.toLocaleString()} ${
      selected.size === 1 ? 'column' : 'columns'
    } = ${(selectedCells as number).toLocaleString()} of ${summary.max_cells.toLocaleString()} values`
  }, [rowsKnown, summary.total_rows, summary.max_cells, selected.size, selectedCells])

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-base font-semibold">
          Choose the columns to import from {fileName}
        </h2>
        <p className="mt-1 text-sm text-mm-text-muted">
          {rowsKnown && fits !== null ? (
            <>
              This file has {summary.columns.length.toLocaleString()} columns and{' '}
              {summary.total_rows.toLocaleString()} records — more than one import can
              hold. At this many records you can import up to{' '}
              <strong>{fits.toLocaleString()} columns</strong>. The rest stay in the
              file; you can import them separately later.
            </>
          ) : (
            <>
              This file has {summary.columns.length.toLocaleString()} columns. Pick the
              ones you need — the rest stay in the file.
            </>
          )}
        </p>
      </div>

      <div
        id={budgetId}
        role="status"
        className={cn(
          'rounded-md border px-3 py-2 text-sm',
          overBudget
            ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400'
            : 'border-border bg-mm-bg text-mm-text',
        )}
      >
        <span className="flex items-center gap-2">
          {overBudget ? (
            <AlertTriangle className="h-4 w-4 flex-none" aria-hidden="true" />
          ) : (
            <Check className="h-4 w-4 flex-none text-mm-green-text" aria-hidden="true" />
          )}
          <span className="min-w-0">{budget}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onSelectAll} disabled={busy}>
          Select all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onSelectNone} disabled={busy}>
          Clear
        </Button>
        <span className="text-sm text-mm-text-muted">
          {selected.size.toLocaleString()} of {summary.columns.length.toLocaleString()} selected
        </span>
      </div>

      <ul
        aria-label={`Columns in ${fileName}`}
        aria-describedby={budgetId}
        className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border border-border"
      >
        {summary.columns.map(col => {
          const isOn = selected.has(col.column_index)
          return (
            <li key={col.column_index} className="px-3 py-2">
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={isOn}
                  onCheckedChange={() => onToggle(col.column_index)}
                  disabled={busy}
                  aria-label={col.column_name || `Column ${col.column_index + 1}`}
                  className="mt-0.5 flex-none"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {col.column_name || (
                      <em className="text-mm-text-muted">
                        (column {col.column_index + 1}, no name)
                      </em>
                    )}
                  </span>
                  {col.sample_values.length > 0 && (
                    // The names in a survey export are often codes, so the first
                    // few values are what actually tell Q014 from Q015.
                    <span className="block truncate text-xs text-mm-text-faint">
                      {col.sample_values.join(' · ')}
                    </span>
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onContinue}
          disabled={busy || selected.size === 0 || overBudget}
        >
          {busy ? 'Reading the selected columns…' : 'Continue'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          <X className="mr-1 h-4 w-4" aria-hidden="true" />
          Choose a different file
        </Button>
      </div>
    </section>
  )
}
