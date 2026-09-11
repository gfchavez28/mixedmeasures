import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { toast } from 'sonner'
import type { DatasetColumn, DatasetValueCell, RecodeDefinitionSummary } from '@/lib/api'
import { useTheme } from '@/lib/theme-context'
import { reflectReverseValue } from '@/lib/recode-utils'
import { resolveRangeOutput } from '@/lib/recode-ranges'
import { columnDisplayLabel } from '@/lib/dataset-column-label'

// ── Ordinal color helper ─────────────────────────────────────────────────────

function ordinalBgStyle(valueNumeric: number, maxValue: number, isDark: boolean): CSSProperties {
  if (maxValue <= 0) return {}
  const intensity = Math.max(0, Math.min(1, valueNumeric / maxValue))
  if (isDark) {
    const lightness = 15 + intensity * 25
    const textColor = lightness > 35 ? '#ffffff' : '#e2e8f0'
    return { backgroundColor: `hsl(217, 70%, ${lightness}%)`, color: textColor }
  }
  // Light fills stay in the 65–95% lightness range, where near-black text
  // passes AA at every step; white text never does on these fills (#424
  // measured 2.4–3.0:1 against the 4.5:1 minimum).
  const lightness = 95 - intensity * 30
  return { backgroundColor: `hsl(217, 70%, ${lightness}%)`, color: 'hsl(var(--mm-text))' }
}

// ── Display value computation ────────────────────────────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
export function computeDisplayValue(
  answer: DatasetValueCell | undefined,
  _column: DatasetColumn,
  activeDef: RecodeDefinitionSummary | null,
): { display: string | null; isNumeric: boolean; numericValue: number | null; isExcluded: boolean; maxValue: number; titleText?: string } {
  if (!answer || (answer.value_text === null && answer.value_numeric === null)) {
    return { display: null, isNumeric: false, numericValue: null, isExcluded: false, maxValue: 0 }
  }

  const valueText = answer.value_text || ''

  // No active definition: show raw
  if (!activeDef) {
    return {
      display: valueText || (answer.value_numeric !== null ? String(answer.value_numeric) : null),
      isNumeric: false,
      numericValue: null,
      isExcluded: false,
      maxValue: 0,
    }
  }

  // Check if excluded
  const excludeValues = activeDef.exclude_values || []
  const lowerExcludes = new Set(excludeValues.map(v => v.toLowerCase()))
  if (valueText && lowerExcludes.has(valueText.trim().toLowerCase())) {
    return { display: valueText, isNumeric: false, numericValue: null, isExcluded: true, maxValue: 0 }
  }

  // Apply mapping
  const lowerMap = new Map(
    Object.entries(activeDef.mapping).map(([k, v]) => [k.toLowerCase(), v])
  )
  // #823(d): the RANGE channel, second — an explicit key beats a band, exactly
  // as `plan_definition_over_column` orders them. Without this the grid renders
  // a banded cell as unmapped plain text while `value_numeric` holds the band's
  // code: the #578 display-vs-storage drift, on the surface a researcher checks
  // a recode against. ⚠️ The exclude check above still runs FIRST, mirroring the
  // backend's null-set-before-everything rule; this client cannot evaluate the
  // column's full missing declaration and deliberately does not try (#600).
  const mappedValue = lowerMap.get(valueText.trim().toLowerCase())
    ?? (activeDef.recode_type === 'reverse'
      ? undefined
      : resolveRangeOutput(valueText, activeDef.ranges))

  if (mappedValue === undefined) {
    return { display: valueText, isNumeric: false, numericValue: null, isExcluded: false, maxValue: 0 }
  }

  if (activeDef.recode_type === 'scale_map' || activeDef.recode_type === 'reverse') {
    // #578: a REVERSE mapping stores FORWARD codes; the score is the reflection
    // (offset − code), exactly what the backend writes to value_numeric. Reflect
    // here too or the grid would show the raw code while every analysis uses the
    // reversed one. scale_map is verbatim.
    // #600: reflect using the server's authoritative offset — it excludes
    // missing/excluded mapping keys, which this client cannot identify.
    const numVal = activeDef.recode_type === 'reverse'
      ? reflectReverseValue(Number(mappedValue), activeDef.mapping, activeDef.reverse_offset)
      : Number(mappedValue)
    // #823(d): the scale's top must include BAND outputs, or a rule built
    // entirely from ranges has an empty `mapping` and `Math.max(...[])` is
    // -Infinity. `ordinalBgStyle` guards `<= 0` so that is not a crash — it
    // silently drops the intensity tint for exactly the rules that produce a
    // small ordered set of codes, which is where it reads best.
    const scaleOutputs = [
      ...Object.values(activeDef.mapping),
      ...(activeDef.ranges ?? []).map(r => r.output),
    ].map(Number).filter(n => !isNaN(n))
    const maxVal = scaleOutputs.length > 0 ? Math.max(...scaleOutputs) : 0
    // #561: the .sav dedupe suffix (#541a) bakes the code into the label —
    // "Agree (1)" — and appending our own annotation renders "Agree (1) (1)".
    // Skip the annotation ONLY when the label's trailing (N) equals the
    // displayed numeric; if they differ (e.g. a REVERSE shows "Agree (1) (5)")
    // the annotation is information and stays. Display-side by design — the
    // adapter suffix is load-bearing across the three-owner invariant.
    const trailing = valueText.match(/\((-?\d+(?:\.\d+)?)\)\s*$/)
    const alreadyAnnotated = trailing !== null && Number(trailing[1]) === numVal
    return {
      display: alreadyAnnotated ? valueText : `${valueText} (${numVal})`,
      isNumeric: true,
      numericValue: numVal,
      isExcluded: false,
      maxValue: maxVal,
      // #528: the compact "2 (4)" gives no cue which number is which — spell it
      // out where there's room (the hover tooltip).
      titleText: `raw ${valueText} → recoded ${numVal}${activeDef.recode_type === 'reverse' ? ' (reversed)' : ''}`,
    }
  }

  if (activeDef.recode_type === 'category_group') {
    return {
      display: String(mappedValue),
      isNumeric: false,
      numericValue: null,
      isExcluded: false,
      maxValue: 0,
    }
  }

  return { display: valueText, isNumeric: false, numericValue: null, isExcluded: false, maxValue: 0 }
}

// ── EditableCell component ───────────────────────────────────────────────────

interface EditableCellProps {
  answer: DatasetValueCell | undefined
  column: DatasetColumn
  activeDef: RecodeDefinitionSummary | null
  isSelected: boolean
  isEditing: boolean
  onSelect: () => void
  onStartEdit: () => void
  onSave: (answerId: number, value: string | null) => void
  onCancel: () => void
  onTabNav: (direction: 'next' | 'prev') => void
  onEnterNav: () => void
  onOpenText: (questionText: string, fullText: string) => void
}

export default function EditableCell({
  answer,
  column,
  activeDef,
  isSelected,
  isEditing,
  onSelect,
  onStartEdit,
  onSave,
  onCancel,
  onTabNav,
  onEnterNav,
  onOpenText,
}: EditableCellProps) {
  const { isDark } = useTheme()
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  const isManual = column.source === 'manual'
  const isComputed = column.source === 'computed'
  const computedTint = isComputed ? ' bg-violet-50/30 dark:bg-violet-950/20' : ''
  const selectionRing = isSelected && !isEditing ? ' ring-2 ring-ring/50' : ''
  const qType = column.column_type

  // Initialize edit value when entering edit mode
  useEffect(() => {
    if (isEditing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset edit value and focus input on edit start
      setEditValue(answer?.value_text || '')
      // Focus input on next tick
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        if (inputRef.current instanceof HTMLInputElement || inputRef.current instanceof HTMLTextAreaElement) {
          inputRef.current.select()
        }
      })
    }
  }, [isEditing, answer?.value_text])

  const doSave = () => {
    // 🔴 #897 — this used to `return` in silence, and that silence is the whole
    // reason the defect lasted: a cell is addressed by its `DatasetValue.id`
    // (`PATCH …/values/{value_id}`, no create), so a row that arrived without
    // one swallowed every keystroke with no toast, no error and no request. The
    // backend now materialises a cell on every row-creating path, so this branch
    // should be UNREACHABLE — which is exactly why it must SAY something if it
    // is ever reached again, rather than quietly losing the researcher's typing
    // for another few months.
    if (!answer) {
      toast.error(
        'This cell could not be saved because the record has no entry for this '
        + 'variable yet. Reload the page; if it happens again, please report it.'
      )
      return
    }
    const val = editValue.trim() || null
    onSave(answer.id, val)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 🔴 **The editor CONSUMES its own keys — `stopPropagation`, not just
    // `preventDefault` (#927).** `DatasetView` keeps a `window` keydown listener
    // for Escape and (since #927) F2/Enter, and React 18 flushes a discrete
    // event's state updates before the event finishes bubbling to `window` — so
    // by the time that listener ran, `editingCell` was ALREADY null and its
    // `!editingCell` guard was satisfied by the very keystroke that had just
    // cleared it. Measured live, both directions:
    //
    //   * Escape cancelled the edit AND deselected the cell in one press, so
    //     the selected-not-editing state was unreachable on a manual column —
    //     which would have made F2 dead code on exactly the columns it is for.
    //   * Enter on the LAST row leaves `editingCell` null (there is no cell
    //     below), so the same keystroke would have re-opened the editor.
    //
    // ⚠️ Not `defaultPrevented` on the listener side: that is the right signal
    // for a Radix overlay handling its own navigation (#784), but here the
    // handler is OURS and the key never had any business leaving the editor.
    if (e.key === 'Enter' && !(e.shiftKey && qType === 'open_text')) {
      e.preventDefault()
      e.stopPropagation()
      doSave()
      onEnterNav()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      doSave()
      onTabNav(e.shiftKey ? 'prev' : 'next')
    }
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────
  if (isEditing && isManual) {
    // #914: every editor names the VARIABLE it edits. Measured in Chrome's
    // tree: the ordinal editor announced as a bare `combobox` with only its
    // value, and the number and text inputs carried no name at all — a
    // screen-reader user typing into a cell could not tell which column they
    // were in. The row is already announced by its `<th scope="row">`, so the
    // column is the half the editor must supply. One label, the shared
    // `columnDisplayLabel`, so the name matches the header's.
    const commonProps = {
      onKeyDown: handleKeyDown,
      onBlur: () => doSave(),
      'aria-label': `Edit ${columnDisplayLabel(column)}`,
    }

    if (qType === 'ordinal' || qType === 'binary') {
      const labels = qType === 'binary'
        ? ['Yes', 'No']
        : (column.scale_labels || [])
      return (
        <td className="px-1 py-1">
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full h-8 text-sm border rounded px-1 focus:outline-none focus:ring-2 focus:ring-ring"
            {...commonProps}
          >
            <option value="">—</option>
            {labels.map(label => (
              <option key={label} value={label}>{label}</option>
            ))}
          </select>
        </td>
      )
    }

    if (qType === 'open_text') {
      return (
        <td className="px-1 py-1">
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full min-h-[60px] text-sm border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            {...commonProps}
          />
        </td>
      )
    }

    if (qType === 'numeric' || qType === 'percentage') {
      return (
        <td className="px-1 py-1">
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="number"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full h-8 text-sm border rounded px-2 text-center focus:outline-none focus:ring-2 focus:ring-ring"
            step="any"
            min={column.numeric_min ?? undefined}
            max={column.numeric_max ?? undefined}
            {...commonProps}
          />
        </td>
      )
    }

    // Default: text input (nominal, multi_select)
    return (
      <td className="px-1 py-1">
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className="w-full h-8 text-sm border rounded px-2 text-center focus:outline-none focus:ring-2 focus:ring-ring"
          {...commonProps}
        />
      </td>
    )
  }

  // ── Display mode ───────────────────────────────────────────────────────────
  const { display, isNumeric, numericValue, isExcluded, maxValue, titleText } = computeDisplayValue(answer, column, activeDef)

  // Click handler: select cell, and for manual/editable cells also start edit
  const handleClick = (editAction?: () => void) => {
    onSelect()
    editAction?.()
  }

  // Manual empty cell: dashed border placeholder
  if (isManual && display === null) {
    return (
      <td
        className={`px-3 py-2 text-center text-mm-text-faint border border-dashed border-mm-border-subtle cursor-pointer hover:bg-mm-surface-hover transition-colors${selectionRing}`}
        onClick={() => handleClick(onStartEdit)}
      >
        &mdash;
      </td>
    )
  }

  // Imported empty cell
  if (display === null) {
    return (
      <td
        className={`px-3 py-2 text-center text-mm-text-faint${selectionRing}`}
        onClick={onSelect}
      >
        &mdash;
      </td>
    )
  }

  // Excluded value
  if (isExcluded) {
    return (
      <td
        className={`px-3 py-2 text-sm text-center text-mm-text-faint italic overflow-hidden text-ellipsis whitespace-nowrap${computedTint}${selectionRing} ${isManual ? 'cursor-pointer hover:bg-mm-surface-hover' : ''}`}
        onClick={() => handleClick(isManual ? onStartEdit : undefined)}
        title={display || undefined}
      >
        {display}
      </td>
    )
  }

  // Numeric with gradient
  if (isNumeric && numericValue !== null) {
    return (
      <td
        className={`px-3 py-2 text-sm text-center font-mono tabular-nums overflow-hidden text-ellipsis whitespace-nowrap${computedTint}${selectionRing} ${isManual ? 'cursor-pointer hover:brightness-95' : ''}`}
        style={ordinalBgStyle(numericValue, maxValue, isDark)}
        onClick={() => handleClick(isManual ? onStartEdit : undefined)}
        title={titleText ?? (display || undefined)}
      >
        {display}
      </td>
    )
  }

  // Open text — and the ONE branch where the click does something different
  // depending on whether the cell is the researcher's to edit.
  //
  // 🔴 **#927: this branch used to send EVERY filled cell to the viewer**, so a
  // manual open-text cell was editable exactly once. Click an empty one and the
  // editor opened; type into it, and from then on the click opened a read-only
  // dialog whose only control is Close — with no F2, no double-click, no
  // context-menu item and no undo entry for a cell edit. A typo in a hand-typed
  // note was permanent short of deleting the record.
  //
  // Invisible until row 47 because an `open_text` column could only arrive from
  // a FILE, so it was `imported`, so it was never editable and "expand to read"
  // was the only sensible click. A hand-authored one is the new case.
  //
  // ⚠️ The viewer is KEPT for cells that are not editable — that is where it
  // earns its place (a 200px column of survey prose). For an editable cell the
  // EDITOR is the full-text view: a resizable `min-h-[60px]` textarea holding
  // the whole value, with Escape to cancel. Nothing is lost, and the `title`
  // carries the untruncated text on hover exactly as the other branches do.
  if (qType === 'open_text') {
    const text = display || ''
    const hasContent = text.length > 0
    return (
      <td
        className={`px-3 py-2 text-sm max-w-[200px]${selectionRing} ${isManual || hasContent ? 'cursor-pointer hover:bg-mm-surface-hover' : ''}`}
        onClick={() => handleClick(
          isManual ? onStartEdit : (hasContent ? () => onOpenText(column.column_text, text) : undefined),
        )}
        // ⚠️ A title is a CLAIM about the act (#912's rule, one channel over):
        // "Click to expand" on a cell whose click now opens the editor would be
        // false. An editable cell shows its own value, which is what the
        // researcher wants from hover on a truncated cell anyway.
        title={isManual ? (text || undefined) : (hasContent ? 'Click to expand' : undefined)}
      >
        <span className="block truncate">{text}</span>
      </td>
    )
  }

  // Default display
  const computedLabel = column.source === 'computed' ? `Computed: ${display || 'empty'}` : undefined
  return (
    <td
      className={`px-3 py-2 text-sm text-center overflow-hidden text-ellipsis whitespace-nowrap${computedTint}${selectionRing} ${isManual ? 'cursor-pointer hover:bg-mm-surface-hover' : ''}`}
      onClick={() => handleClick(isManual ? onStartEdit : undefined)}
      title={display || undefined}
      aria-label={computedLabel}
    >
      {display}
    </td>
  )
}
