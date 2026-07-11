import { useState, useRef, useEffect, type CSSProperties } from 'react'
import type { DatasetColumn, DatasetValueCell, RecodeDefinitionSummary } from '@/lib/api'
import { useTheme } from '@/lib/theme-context'

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
  const mappedValue = lowerMap.get(valueText.trim().toLowerCase())

  if (mappedValue === undefined) {
    return { display: valueText, isNumeric: false, numericValue: null, isExcluded: false, maxValue: 0 }
  }

  if (activeDef.recode_type === 'scale_map' || activeDef.recode_type === 'reverse') {
    const numVal = Number(mappedValue)
    const maxVal = Math.max(...Object.values(activeDef.mapping).map(Number).filter(n => !isNaN(n)))
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
    if (!answer) return
    const val = editValue.trim() || null
    onSave(answer.id, val)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.shiftKey && qType === 'open_text')) {
      e.preventDefault()
      doSave()
      onEnterNav()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      doSave()
      onTabNav(e.shiftKey ? 'prev' : 'next')
    }
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────
  if (isEditing && isManual) {
    const commonProps = {
      onKeyDown: handleKeyDown,
      onBlur: () => doSave(),
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
            aria-label="Edit cell value"
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

  // Open text: always expandable on click (column is narrow, so even short text benefits)
  if (qType === 'open_text') {
    const text = display || ''
    const hasContent = text.length > 0
    return (
      <td
        className={`px-3 py-2 text-sm max-w-[200px]${selectionRing} ${hasContent ? 'cursor-pointer hover:bg-mm-surface-hover' : (isManual ? 'cursor-pointer hover:bg-mm-surface-hover' : '')}`}
        onClick={() => handleClick(hasContent ? () => onOpenText(column.column_text, text) : (isManual ? onStartEdit : undefined))}
        title={hasContent ? 'Click to expand' : undefined}
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
