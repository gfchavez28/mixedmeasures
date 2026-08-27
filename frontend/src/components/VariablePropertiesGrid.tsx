import { useCallback, useMemo, useRef, useState } from 'react'
import { Tags, SlidersHorizontal } from 'lucide-react'
import type { DatasetColumn } from '@/lib/api/datasets'
import { columnDisplayLabel } from '@/lib/dataset-column-label'
import { SELECTED_ROW } from '@/lib/selection'
import { TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import { ScrollableTable } from '@/components/ui/ScrollableTable'

/**
 * The Variables view's properties grid — variables as ROWS, properties as
 * COLUMNS (design note Decision E, slab 2).
 *
 * This is the shape SPSS's Variable View has and the reason it teaches the
 * model: with Values and Missing side by side across forty-one variables, "a
 * value label is a dictionary and a recode is a rule" stops being something you
 * have to be told. The page's previous sidebar showed one property (the name)
 * for one variable at a time, which is the same one-at-a-time framing that made
 * the area hard to learn.
 *
 * ⚠️ **It DISPLAYS; the detail panel EDITS — deliberately.** Name, label and
 * type are already editable in the panel below, with Enter advancing to the
 * next variable in the same field. Adding inline editors here would make a
 * THIRD name editor and a THIRD type editor, which is precisely the
 * substrate debt (§10.1) this redesign exists to retire. Values and Missing get
 * buttons because their editor is a dialog either way.
 *
 * ## Accessibility
 *
 * `role="grid"` sits on the element that OWNS the rows (#701b) — the `<table>`,
 * not the scroll container. Cells use **roving tabindex** with real Arrow /
 * Home / End handling, following the crosswalk grid rather than the virtualised
 * listboxes: these rows are not virtualised, so the focused DOM node survives
 * and `aria-activedescendant` would be the wrong tool (#436/#484 vs #756).
 *
 * ⚠️ **NO `aria-setsize` / `aria-posinset`, and that is a DECISION (#758/#772).**
 * A dataset is capped at 500 columns and every row is rendered, so the DOM holds
 * the whole set and a screen reader derives the count correctly on its own.
 * Adding them by analogy with the virtualised listboxes would be the inverse
 * error. If this grid is ever virtualised, they become REQUIRED — see
 * `lib/listbox-aria.ts`.
 */

/** Column order is the reading order of an SPSS Variable View row. */
const HEADERS = ['Name', 'Label', 'Type', 'Values', 'Missing', 'Rule in effect'] as const
const COL_COUNT = HEADERS.length

/** What the Values cell says without opening anything. */
function valuesSummary(column: DatasetColumn): string {
  const labels = column.scale_labels ?? []
  if (labels.length === 0) return '—'
  const preview = labels.slice(0, 2).join(', ')
  return labels.length > 2 ? `${preview}, +${labels.length - 2}` : preview
}

/**
 * What the Missing cell says. The three states are the backend's three, and
 * they are load-bearing: `null` = the recognized-N/A defaults, `[]` = a real
 * declaration that NOTHING is missing, rules = those rules (#592/#609c).
 * Keying on length would collapse the first two into one.
 */
function missingSummary(column: DatasetColumn): string {
  const rules = column.missing_values
  if (rules == null) return 'Automatic'
  if (rules.length === 0) return 'Nothing'
  return `${rules.length} rule${rules.length === 1 ? '' : 's'}`
}

/** What the Rule cell says — the fact that makes labels and recodes two layers. */
function ruleSummary(column: DatasetColumn): { text: string; remaps: boolean } {
  const primary = column.primary_recode
  if (!primary) return { text: '—', remaps: false }
  return { text: primary.name, remaps: primary.remaps_codes }
}

export default function VariablePropertiesGrid({
  columns,
  selectedColumnId,
  onSelectColumn,
  onEditValues,
  maxHeight,
}: {
  columns: DatasetColumn[]
  selectedColumnId: number | null
  onSelectColumn: (columnId: number) => void
  /** Opens the value-labels + missing editor for one variable. */
  onEditValues: (column: DatasetColumn) => void
  maxHeight?: string
}) {
  // Roving tabindex: exactly one cell in the grid is tabbable at a time.
  const [focusCell, setFocusCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const gridRef = useRef<HTMLTableElement>(null)

  const rowCount = columns.length
  // Clamp at render — the column set can shrink under us (a delete elsewhere),
  // and a coordinate past the end would leave the grid with no tab stop at all.
  const active = useMemo(() => ({
    row: Math.min(focusCell.row, Math.max(0, rowCount - 1)),
    col: Math.min(focusCell.col, COL_COUNT - 1),
  }), [focusCell, rowCount])

  const moveFocus = useCallback((row: number, col: number) => {
    const next = {
      row: Math.max(0, Math.min(row, rowCount - 1)),
      col: Math.max(0, Math.min(col, COL_COUNT - 1)),
    }
    setFocusCell(next)
    // Focus follows the roving index; the node exists because nothing here is
    // virtualised (see the header docstring).
    queueMicrotask(() => {
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-cell="${next.row}-${next.col}"]`)
        ?.focus()
    })
  }, [rowCount])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // A control inside a cell owns its own activation keys; only navigation is
    // ours (the `focusedElementOwnsKey` rule, applied locally).
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); moveFocus(active.row, active.col + 1); break
      case 'ArrowLeft': e.preventDefault(); moveFocus(active.row, active.col - 1); break
      case 'ArrowDown': e.preventDefault(); moveFocus(active.row + 1, active.col); break
      case 'ArrowUp': e.preventDefault(); moveFocus(active.row - 1, active.col); break
      case 'Home':
        e.preventDefault()
        moveFocus(e.ctrlKey ? 0 : active.row, 0)
        break
      case 'End':
        e.preventDefault()
        moveFocus(e.ctrlKey ? rowCount - 1 : active.row, COL_COUNT - 1)
        break
      default: return
    }
  }, [active, moveFocus, rowCount])

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    tabIndex: row === active.row && col === active.col ? 0 : -1,
    onFocus: () => setFocusCell({ row, col }),
  })

  return (
    <ScrollableTable maxHeight={maxHeight}>
      <table
        ref={gridRef}
        role="grid"
        aria-label="Variable properties"
        aria-rowcount={rowCount + 1}
        className="w-full text-sm border-collapse"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr role="row">
            {HEADERS.map(h => (
              <th
                key={h}
                scope="col"
                className="text-left px-3 py-2 text-xs font-medium text-mm-text-secondary bg-mm-bg border-b sticky top-0 z-20"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((column, row) => {
            const isSelected = column.id === selectedColumnId
            const rule = ruleSummary(column)
            return (
              <tr
                key={column.id}
                role="row"
                aria-selected={isSelected}
                data-column-id={column.id}
                onClick={() => onSelectColumn(column.id)}
                className={`border-b cursor-pointer ${
                  isSelected ? SELECTED_ROW : 'hover:bg-mm-surface-hover'
                }`}
              >
                {/* 🔴 The Name cell shows the FIELD, not the resolved identity.
                    It used to render `columnDisplayLabel`, whose fallback is
                    "short name, else label" — so on any dataset without short
                    names (an ordinary CSV/Excel import) Name and Label printed
                    the SAME string on every row, and two of six columns said
                    nothing.

                    ⚠️ **A properties grid shows FIELDS; every other surface
                    shows an IDENTITY.** This is SPSS's Variable View — its whole
                    job is to report the fields as they stand, and an empty short
                    name is a true and useful thing to report: it is what "Use
                    label as short name" in the panel below exists to fill. The
                    aria-labels on this row's buttons keep using
                    `columnDisplayLabel`, because those are NAMES for a control
                    and must never be a dash. */}
                <td role="gridcell" {...cellProps(row, 0)}
                    className="px-3 py-1.5 font-medium text-mm-text truncate max-w-[180px]">
                  {column.column_name?.trim()
                    ? column.column_name
                    : <span className="text-mm-text-faint font-normal" title="No short name — the label is used to identify this variable">—</span>}
                </td>
                <td role="gridcell" {...cellProps(row, 1)}
                    className="px-3 py-1.5 text-mm-text-secondary truncate max-w-[280px]">
                  {column.column_text}
                </td>
                <td role="gridcell" {...cellProps(row, 2)} className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                    TYPE_BADGE_CLASSES[column.column_type] || 'bg-mm-bg text-mm-text-muted'
                  }`}>
                    {column.column_type}
                  </span>
                </td>
                <td role="gridcell" {...cellProps(row, 3)} className="px-3 py-1.5">
                  <button
                    onClick={e => { e.stopPropagation(); onEditValues(column) }}
                    className="flex items-center gap-1 text-left text-mm-text-secondary hover:text-mm-blue max-w-[200px]"
                    // The visible text is a SUMMARY; the name says which
                    // variable it belongs to, because a browse-mode reader meets
                    // this button with no row context (#785).
                    aria-label={`Value labels for ${columnDisplayLabel(column)}`}
                    tabIndex={-1}
                  >
                    <Tags className="w-3 h-3 flex-none" aria-hidden="true" />
                    <span className="truncate">{valuesSummary(column)}</span>
                  </button>
                </td>
                <td role="gridcell" {...cellProps(row, 4)} className="px-3 py-1.5">
                  <button
                    onClick={e => { e.stopPropagation(); onEditValues(column) }}
                    className="text-left text-mm-text-secondary hover:text-mm-blue"
                    aria-label={`Missing values for ${columnDisplayLabel(column)}`}
                    tabIndex={-1}
                  >
                    {missingSummary(column)}
                  </button>
                </td>
                <td role="gridcell" {...cellProps(row, 5)}
                    className="px-3 py-1.5 text-mm-text-secondary">
                  <span className="flex items-center gap-1.5">
                    {rule.text !== '—' && (
                      <SlidersHorizontal className="w-3 h-3 flex-none text-mm-text-faint"
                                         aria-hidden="true" />
                    )}
                    <span className="truncate max-w-[180px]">{rule.text}</span>
                    {rule.remaps && (
                      // Stated as what the RULE does, never as a safety verdict —
                      // `remaps_codes` is a shape test and is blind to a
                      // label-keyed flip (see the schema's own warning).
                      <span className="text-[11px] px-1 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 flex-none">
                        re-maps codes
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </ScrollableTable>
  )
}
