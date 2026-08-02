/**
 * Missing-values row editor (#592 slab 4) — declare which of a column's values
 * are NOT real answers.
 *
 * Deliberately a SIBLING of `ValueLabelRows`, not a column inside it. Value
 * labels and missing values are separate concerns and SPSS/jamovi keep them
 * side by side for a concrete reason: declaring `-99 THRU -1` missing on a
 * continuous `age` column must not turn `age` into an ordered scale (#592 C5),
 * and a range is not a code-with-a-label, so it has no row to tick a checkbox
 * on. A per-row "missing" checkbox on the labels editor structurally cannot
 * express either case.
 *
 * The backend contract has THREE states, and `MissingValuesSection` gives each
 * one an explicit UI (#609 — SPSS's own missing dialog is the same three-way
 * radio): `null` = the recognized-N/A defaults apply ("Automatic"), `[]` =
 * nothing is missing (a REAL declaration — "Prefer not to say" counts as
 * data), a rule list = these rules REPLACE the defaults ("These values").
 * Clearing every row under "These values" is a disabled-Apply hint, never a
 * silent revert to the defaults.
 *
 * The rules this produces are the wire shape verbatim (`MissingValueRule`), so
 * nothing translates between here and the backend predicate.
 */
import { useCallback, useEffect, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import SegmentedControl from '@/components/ui/segmented-control'
import type { MissingValueRule } from '@/lib/api/datasets'

/** A row is one rule mid-edit; codes/bounds stay strings for the inputs.
 *  A range's `label` has no input (it is backend display metadata — ranges
 *  never label-match cells) but MUST round-trip: dropping it silently deleted
 *  an API-authored label on the next save and flagged a phantom change
 *  (#612). Degenerate ranges normalize to discrete server-side, where the
 *  label is first-class. */
export type MissingRow =
  | { kind: 'value'; code: string; label: string }
  | { kind: 'range'; lo: string; hi: string; label: string }

export interface MissingRulesValidation {
  ok: boolean
  msg: string
  /** null when nothing is declared at all — distinct from `[]` ("nothing is
   *  missing"), which is a real declaration. The caller decides which to send. */
  rules: MissingValueRule[] | null
  /** Index (into the ROWS array) of the first failing row, when one row is at
   *  fault — drives `aria-invalid`/`aria-describedby` on its inputs (#610). */
  badRow?: number
}

/** The three backend states, as an explicit UI mode (#609). */
export type MissingMode = 'automatic' | 'none' | 'custom'

const isBlank = (r: MissingRow) =>
  r.kind === 'value'
    ? r.code.trim() === '' && r.label.trim() === ''
    : r.lo.trim() === '' && r.hi.trim() === ''

/**
 * Validate the rows and build the wire payload. Blank rows are ignored so an
 * empty editor is "no declaration", not an error.
 *
 * Mirrors `services/missing_values._validate_rule`: a range needs at least one
 * bound, bounds must be finite numbers (±Infinity is not JSON-compliant and
 * would 500 the response), and lo <= hi.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure validator, unit-tested + shared with the wizard
export function buildMissingRules(rows: MissingRow[]): MissingRulesValidation {
  const rules: MissingValueRule[] = []
  const seen = new Set<string>()
  let any = false

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (isBlank(r)) continue
    any = true
    if (r.kind === 'value') {
      const code = r.code.trim()
      if (code === '') {
        return { ok: false, msg: 'Every missing value needs a code.', rules: null, badRow: i }
      }
      if (seen.has(code)) {
        return { ok: false, msg: `"${code}" is listed twice.`, rules: null, badRow: i }
      }
      seen.add(code)
      const label = r.label.trim()
      rules.push(label ? { value: code, label } : { value: code })
    } else {
      const loRaw = r.lo.trim()
      const hiRaw = r.hi.trim()
      // Each bound may be blank = unbounded (SPSS's LO THRU / THRU HI), but not both.
      const lo = loRaw === '' ? null : Number(loRaw)
      const hi = hiRaw === '' ? null : Number(hiRaw)
      if (lo === null && hi === null) {
        return { ok: false, msg: 'A range needs a low or a high value.', rules: null, badRow: i }
      }
      if ((lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi))) {
        return { ok: false, msg: 'Range bounds must be numbers.', rules: null, badRow: i }
      }
      if (lo !== null && hi !== null && lo > hi) {
        return { ok: false, msg: `Range ${lo} to ${hi} is backwards.`, rules: null, badRow: i }
      }
      const label = r.label.trim()
      rules.push(label ? { lo, hi, label } : { lo, hi })
    }
  }
  if (!any) return { ok: true, msg: '', rules: null }
  return { ok: true, msg: '', rules }
}

/** Seed editor rows from a column's stored declaration. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function rulesToRows(rules: MissingValueRule[] | null | undefined): MissingRow[] {
  if (!rules) return []
  return rules.map((r): MissingRow =>
    'value' in r
      ? { kind: 'value', code: String(r.value), label: r.label ?? '' }
      : {
          kind: 'range',
          lo: r.lo === null ? '' : String(r.lo),
          hi: r.hi === null ? '' : String(r.hi),
          label: r.label ?? '',
        }
  )
}

/** Which UI mode a stored declaration is in (#609). */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function deriveMissingMode(rules: MissingValueRule[] | null | undefined): MissingMode {
  if (rules == null) return 'automatic'
  return rules.length === 0 ? 'none' : 'custom'
}

/**
 * The mode-aware payload (#609): Automatic → `null`, Nothing missing → `[]`,
 * These values → the validated rows. All-blank rows under "These values" is
 * NOT a silent un-declare — it is a disabled Apply with a hint (`msg` empty so
 * the section shows guidance, never an amber alert, for a state the researcher
 * simply hasn't finished).
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function buildMissingPayload(mode: MissingMode, rows: MissingRow[]): MissingRulesValidation {
  if (mode === 'automatic') return { ok: true, msg: '', rules: null }
  if (mode === 'none') return { ok: true, msg: '', rules: [] }
  const res = buildMissingRules(rows)
  if (res.ok && res.rules === null) return { ok: false, msg: '', rules: null }
  return res
}

const ruleEqual = (a: MissingValueRule, b: MissingValueRule): boolean => {
  if ('value' in a || 'value' in b) {
    if (!('value' in a) || !('value' in b)) return false
    return a.value === b.value && (a.label ?? '') === (b.label ?? '')
  }
  return a.lo === b.lo && a.hi === b.hi && (a.label ?? '') === (b.label ?? '')
}

/**
 * Field-wise declaration equality (#609): `null` (defaults) only equals `null`;
 * `[]` only equals `[]`. Replaces the raw-JSON.stringify compare, which was
 * key-order and float-format fragile (a wire rule `{label, value}` vs a built
 * `{value, label}` would flag a phantom change and re-fire the PUT).
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function missingRulesEqual(
  a: MissingValueRule[] | null | undefined,
  b: MissingValueRule[] | null,
): boolean {
  if (a == null || b === null) return a == null && b === null
  return a.length === b.length && a.every((r, i) => ruleEqual(r, b[i]))
}

export function MissingValueRows({
  rows,
  onRowsChange,
  validation,
  idPrefix = 'mv',
}: {
  rows: MissingRow[]
  onRowsChange: (rows: MissingRow[]) => void
  validation: MissingRulesValidation
  idPrefix?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  // #610: removing a row unmounts the focused Remove button and focus falls to
  // <body> (inside a Radix dialog the next Tab restarts from the trap edge).
  // Hand focus to the row that takes the removed one's place, else Add value.
  const pendingFocus = useRef<number | null>(null)

  const setRow = useCallback((i: number, patch: Partial<MissingRow>) => {
    onRowsChange(rows.map((r, j) => (j === i ? ({ ...r, ...patch } as MissingRow) : r)))
  }, [rows, onRowsChange])
  const addValue = useCallback(
    () => onRowsChange([...rows, { kind: 'value', code: '', label: '' }]),
    [rows, onRowsChange])
  const addRange = useCallback(
    () => onRowsChange([...rows, { kind: 'range', lo: '', hi: '', label: '' }]),
    [rows, onRowsChange])
  const removeRow = useCallback(
    (i: number) => {
      pendingFocus.current = i
      onRowsChange(rows.filter((_, j) => j !== i))
    },
    [rows, onRowsChange])

  useEffect(() => {
    if (pendingFocus.current === null) return
    const i = pendingFocus.current
    pendingFocus.current = null
    const c = containerRef.current
    if (!c) return
    const removes = c.querySelectorAll<HTMLButtonElement>('[data-row-remove]')
    const target = removes.length
      ? removes[Math.min(i, removes.length - 1)]
      : c.querySelector<HTMLButtonElement>(`[data-testid="${idPrefix}-add-value"]`)
    target?.focus()
  })

  const errId = `${idPrefix}-rules-error`
  const rowAria = (i: number) =>
    validation.badRow === i
      ? { 'aria-invalid': true as const, 'aria-describedby': errId }
      : {}

  return (
    <div ref={containerRef} data-testid={`${idPrefix}-section`}>
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.kind === 'value' ? (
                  <>
                    <td className="py-1 pr-2 w-20 text-xs text-mm-text-muted">Value</td>
                    <td className="py-1 pr-2 w-24">
                      <Input
                        aria-label={`Missing value code for row ${i + 1}`}
                        {...rowAria(i)}
                        value={r.code}
                        placeholder="99"
                        onChange={e => setRow(i, { code: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <Input
                        aria-label={`Label for missing value ${r.code || i + 1}`}
                        {...rowAria(i)}
                        value={r.label}
                        placeholder="e.g. Refused (optional)"
                        onChange={e => setRow(i, { label: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-1 pr-2 w-20 text-xs text-mm-text-muted">Range</td>
                    <td className="py-1 pr-2 w-24">
                      <Input
                        type="number"
                        aria-label={`Range low bound for row ${i + 1}`}
                        {...rowAria(i)}
                        value={r.lo}
                        placeholder="-99"
                        onChange={e => setRow(i, { lo: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-mm-text-muted">to</span>
                        <Input
                          type="number"
                          aria-label={`Range high bound for row ${i + 1}`}
                          {...rowAria(i)}
                          value={r.hi}
                          placeholder="-1"
                          onChange={e => setRow(i, { hi: e.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>
                    </td>
                  </>
                )}
                <td className="py-1 w-8">
                  <button
                    type="button"
                    data-row-remove={i}
                    onClick={() => removeRow(i)}
                    aria-label={`Remove missing row ${i + 1}`}
                    className="p-1.5 -m-1.5 rounded text-mm-border-medium hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex gap-1 mt-1">
        <Button variant="ghost" size="sm" onClick={addValue}
                className="h-7 text-xs" data-testid={`${idPrefix}-add-value`}>
          <Plus className="w-3 h-3 mr-1" aria-hidden="true" /> Add value
        </Button>
        <Button variant="ghost" size="sm" onClick={addRange}
                className="h-7 text-xs" data-testid={`${idPrefix}-add-range`}>
          <Plus className="w-3 h-3 mr-1" aria-hidden="true" /> Add range
        </Button>
      </div>

      {validation.msg !== '' && (
        <p id={errId} role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          {validation.msg}
        </p>
      )}
    </div>
  )
}

/**
 * The whole missing-values block: the tri-state mode control + the per-mode
 * body (#609). Controlled — the parent owns mode + rows — so the dialog, the
 * future import-wizard entry (§K.3), and the Variable View grid all reuse it.
 */
export function MissingValuesSection({
  mode,
  onModeChange,
  rows,
  onRowsChange,
  validation,
  idPrefix = 'mv',
}: {
  mode: MissingMode
  onModeChange: (m: MissingMode) => void
  rows: MissingRow[]
  onRowsChange: (rows: MissingRow[]) => void
  validation: MissingRulesValidation
  idPrefix?: string
}) {
  const handleMode = (m: MissingMode) => {
    onModeChange(m)
    // Entering "These values" with no rows: give the researcher an input to
    // type into rather than an empty table + two Add buttons.
    if (m === 'custom' && rows.length === 0) {
      onRowsChange([{ kind: 'value', code: '', label: '' }])
    }
  }
  const allBlank = rows.every(isBlank)

  return (
    <div>
      <SegmentedControl<MissingMode>
        options={[
          { value: 'automatic', label: 'Automatic' },
          { value: 'none', label: 'Nothing missing' },
          { value: 'custom', label: 'These values' },
        ]}
        value={mode}
        onChange={handleMode}
        ariaLabel="How missing values are decided"
        idPrefix={`${idPrefix}-mode`}
      />
      {mode === 'automatic' && (
        <p className="text-xs text-mm-text-faint mt-1.5">
          Responses like “N/A” and “Prefer not to say” are recognised
          automatically.
        </p>
      )}
      {mode === 'none' && (
        <p className="text-xs text-mm-text-faint mt-1.5">
          Every response counts as data — even “N/A” and “Prefer not to say”.
        </p>
      )}
      {mode === 'custom' && (
        <div className="mt-1.5">
          <MissingValueRows
            rows={rows}
            onRowsChange={onRowsChange}
            validation={validation}
            idPrefix={idPrefix}
          />
          <p className="text-xs text-mm-text-faint mt-1">
            {allBlank
              ? 'Add a value or range, or switch back to “Automatic”.'
              : 'These replace the automatic rules — anything not listed counts as data.'}
          </p>
        </div>
      )}
    </div>
  )
}
