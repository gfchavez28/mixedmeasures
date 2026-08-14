/**
 * Reusable code→label row editor (#575/#576/#577) — shared by the retro
 * `ValueLabelsDialog` and the import-wizard value-labels authoring control.
 * Controlled: the parent owns the rows + column-type state.
 */
import { useCallback, useEffect, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import SegmentedControl from '@/components/ui/segmented-control'

export interface ValueLabelRow {
  code: string   // kept as string for the input; validated numeric on save
  label: string
}

export interface ValueLabelValidation {
  ok: boolean
  msg: string
  payload?: { value: number; label: string }[]
  /** Index (into the ROWS array) of the first failing row, when one row is at
   *  fault — drives `aria-invalid`/`aria-describedby` on its inputs (#610). */
  badRow?: number
}

/**
 * Has the researcher actually begun AUTHORING labels?
 *
 * "Touched" means a LABEL was typed — never that a code exists. Codes are
 * SEEDED from the column's observed values, so keying on them makes every
 * seeded column read as touched. That mistake has now been made twice: once in
 * `ValueLabelsDialog`'s Apply gating (fixed, and it had locked out the
 * missing-only case entirely) and once in this file's own error announcement,
 * which fired on mount while Apply sat enabled — the same dialog telling the
 * researcher off for work they had not done yet (#637).
 *
 * It lives here, beside the validator, so the two can never drift again.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure predicate, unit-tested + shared with the dialog
export function labelRowsTouched(rows: ValueLabelRow[]): boolean {
  return rows.some(r => r.label.trim() !== '')
}

/**
 * Validate the code↔label rows and build the API payload. Blank rows are
 * ignored; every non-blank row needs a numeric code + a label; codes and labels
 * must each be unique (mirrors the backend `ApplyValueLabelsRequest` schema).
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure validator, unit-tested + shared with the wizard
export function buildValueLabelPayload(rows: ValueLabelRow[]): ValueLabelValidation {
  const filled = rows
    .map((r, i) => [r, i] as const)
    .filter(([r]) => r.code.trim() !== '' || r.label.trim() !== '')
  if (filled.length === 0) return { ok: false, msg: 'Add at least one label.' }
  const codes = new Set<number>()
  const labels = new Set<string>()
  for (const [r, i] of filled) {
    if (r.label.trim() === '') return { ok: false, msg: 'Every code needs a label.', badRow: i }
    const n = Number(r.code)
    if (r.code.trim() === '' || !Number.isFinite(n)) {
      return { ok: false, msg: `"${r.code}" is not a number.`, badRow: i }
    }
    if (codes.has(n)) return { ok: false, msg: 'Each code may appear only once.', badRow: i }
    codes.add(n)
    const label = r.label.trim().toLowerCase()
    if (labels.has(label)) return { ok: false, msg: 'Each label must be distinct.', badRow: i }
    labels.add(label)
  }
  return {
    ok: true,
    msg: '',
    payload: filled.map(([r]) => ({ value: Number(r.code), label: r.label.trim() })),
  }
}

export function ValueLabelRows({
  rows,
  onRowsChange,
  colType,
  onColTypeChange,
  validation,
  showTypeToggle = true,
  idPrefix = 'vl',
  showError,
}: {
  rows: ValueLabelRow[]
  onRowsChange: (rows: ValueLabelRow[]) => void
  colType: 'ordinal' | 'nominal'
  onColTypeChange: (t: 'ordinal' | 'nominal') => void
  validation: ValueLabelValidation
  showTypeToggle?: boolean
  idPrefix?: string
  /**
   * Whether an invalid state should be ANNOUNCED (#637). Optional because the
   * two consumers legitimately disagree, and only the parent knows which it is:
   *
   * - The **import wizard** opens this popover from "Add value labels…", so
   *   labelling IS the task and its Apply is `disabled={!validation.ok}` — the
   *   message must show immediately, or the button is disabled with no reason.
   * - The **retro dialog** treats labels as optional (the missing-values section
   *   is a valid reason to be here), so it passes its own `labelsTouched` and
   *   stays silent until a label is actually typed.
   *
   * Defaults to the historical heuristic, which is right for the wizard.
   */
  showError?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  // #610: keep focus in the editor when the focused Remove button unmounts.
  const pendingFocus = useRef<number | null>(null)

  const setRow = useCallback((i: number, patch: Partial<ValueLabelRow>) => {
    onRowsChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }, [rows, onRowsChange])
  const addRow = useCallback(() => onRowsChange([...rows, { code: '', label: '' }]), [rows, onRowsChange])
  const removeRow = useCallback((i: number) => {
    pendingFocus.current = i
    onRowsChange(rows.filter((_, j) => j !== i))
  }, [rows, onRowsChange])

  useEffect(() => {
    if (pendingFocus.current === null) return
    const i = pendingFocus.current
    pendingFocus.current = null
    const c = containerRef.current
    if (!c) return
    const removes = c.querySelectorAll<HTMLButtonElement>('[data-row-remove]')
    const target = removes.length
      ? removes[Math.min(i, removes.length - 1)]
      : c.querySelector<HTMLButtonElement>(`[data-testid="${idPrefix}-add-code"]`)
    target?.focus()
  })

  const errId = `${idPrefix}-labels-error`
  const rowAria = (i: number) =>
    validation.badRow === i
      ? { 'aria-invalid': true as const, 'aria-describedby': errId }
      : {}

  return (
    <div ref={containerRef}>
      {showTypeToggle && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-mm-text-muted">Type</span>
          {/* #610: the house SegmentedControl — roving tabindex + arrow keys,
              instead of the old two-independently-tabbable-radios hand-roll. */}
          <SegmentedControl<'ordinal' | 'nominal'>
            options={[
              { value: 'ordinal', label: 'Ordered scale' },
              { value: 'nominal', label: 'Categories' },
            ]}
            value={colType}
            onChange={onColTypeChange}
            ariaLabel="Column type"
            idPrefix={`${idPrefix}-type`}
          />
        </div>
      )}

      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Value labels: each numeric code and the label shown for it.</caption>
          <thead>
            <tr className="text-xs text-mm-text-muted">
              <th scope="col" className="text-left py-1 pr-2 w-24">Code</th>
              <th scope="col" className="text-left py-1 px-2">Label</th>
              <th scope="col" className="w-8"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <Input
                    type="number"
                    aria-label={`Code for row ${i + 1}`}
                    {...rowAria(i)}
                    value={r.code}
                    onChange={e => setRow(i, { code: e.target.value })}
                    className="h-8 text-sm"
                  />
                </td>
                <td className="py-1 px-2">
                  <Input
                    aria-label={`Label for code ${r.code || i + 1}`}
                    {...rowAria(i)}
                    value={r.label}
                    placeholder="e.g. Not at all"
                    onChange={e => setRow(i, { label: e.target.value })}
                    className="h-8 text-sm"
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    data-row-remove={i}
                    onClick={() => removeRow(i)}
                    aria-label={`Remove row ${i + 1}`}
                    className="p-1.5 -m-1.5 rounded text-mm-text-faint hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button variant="ghost" size="sm" onClick={addRow} className="mt-1 h-7 text-xs" data-testid={`${idPrefix}-add-code`}>
          <Plus className="w-3 h-3 mr-1" aria-hidden="true" /> Add code
        </Button>
      </div>

      {!validation.ok && (showError ?? rows.some(r => r.code || r.label)) && (
        <p id={errId} role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          {validation.msg}
        </p>
      )}
    </div>
  )
}
