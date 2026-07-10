import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useListKeyboardNav } from '@/hooks/useListKeyboardNav'
import {
  type DatasetColumn,
  type ManualColumnCreate,
  type ManualColumnUpdate,
  type ComputedColumnCreate,
  type ComputedColumnUpdate,
  type ComputedPreviewResponse,
  type ComputedPreviewRow,
} from '@/lib/api'
import { datasetsApi } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'

// ── Manual question type options ─────────────────────────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
export const MANUAL_COLUMN_TYPES = [
  { value: 'ordinal', label: 'Ordinal' },
  { value: 'nominal', label: 'Categorical' },
  { value: 'binary', label: 'Yes/No' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'open_text', label: 'Open Text' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'identifier', label: 'Identifier' }, // #414: participant/row ID codes
]

const COMPUTED_TYPE_OPTIONS = [
  { value: 'numeric', label: 'Numeric' },
  { value: 'nominal', label: 'Categorical' },
  { value: 'ordinal', label: 'Ordinal' },
  { value: 'binary', label: 'Yes/No' },
  { value: 'percentage', label: 'Percentage' },
]

// ── Add/Edit Column Dialog ───────────────────────────────────────────────────

export function ColumnFormDialog({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  submitError,
  initial,
  title,
  mode = 'manual',
  projectId,
  datasetId,
  availableColumns,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: ManualColumnCreate | ManualColumnUpdate | ComputedColumnCreate | ComputedColumnUpdate) => void
  isSubmitting: boolean
  submitError: string | null
  initial?: DatasetColumn | null
  title: string
  mode?: 'manual' | 'computed'
  projectId?: number
  datasetId?: number
  availableColumns?: DatasetColumn[]
}) {
  const [formLabel, setFormLabel] = useState(initial?.column_text || '')
  const [formType, setFormType] = useState(initial?.column_type || (mode === 'computed' ? 'numeric' : 'ordinal'))
  const [formCode, setFormCode] = useState(initial?.column_code || '')
  const [formGroup, setFormGroup] = useState(initial?.group_code || '')
  const [formGroupLabel, setFormGroupLabel] = useState(initial?.group_label || '')
  const [formScaleLabels, setFormScaleLabels] = useState(
    initial?.scale_labels ? initial.scale_labels.join('\n') : ''
  )
  const [formNumericMin, setFormNumericMin] = useState(
    initial?.numeric_min != null ? String(initial.numeric_min) : ''
  )
  const [formNumericMax, setFormNumericMax] = useState(
    initial?.numeric_max != null ? String(initial.numeric_max) : ''
  )
  const [formNumericFormat, setFormNumericFormat] = useState(initial?.numeric_format || '')

  // Computed column state
  const [formExpression, setFormExpression] = useState(initial?.expression || '')
  const [preview, setPreview] = useState<ComputedPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  const formulaRef = useRef<HTMLTextAreaElement>(null)

  const insertAtCursor = useCallback((text: string) => {
    const el = formulaRef.current
    if (!el) { setFormExpression(prev => prev + text); return }
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = formExpression.slice(0, start) + text + formExpression.slice(end)
    setFormExpression(next)
    setAcOpen(false)
    setAcFilter('')
    setAcFocusedIndex(0)
    requestAnimationFrame(() => {
      el.focus()
      const cursor = start + text.length
      el.setSelectionRange(cursor, cursor)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setAcFocusedIndex is a stable useState setter declared below this callback; adding it is a TDZ error and its omission never causes staleness
  }, [formExpression])

  // ── Autocomplete state ──────────────────────────────────────────────
  const [acOpen, setAcOpen] = useState(false)
  const [acFilter, setAcFilter] = useState('')
  const [acBracketStart, setAcBracketStart] = useState(-1)

  const acColumns = useMemo(() => {
    if (!availableColumns) return []
    const cols = availableColumns.filter(c => c.id !== initial?.id)
    if (!acFilter) return cols
    const term = acFilter.toLowerCase()
    return cols.filter(c =>
      (c.column_code && c.column_code.toLowerCase().includes(term)) ||
      c.column_text.toLowerCase().includes(term)
    )
  }, [availableColumns, initial?.id, acFilter])

  const acSelectColumn = useCallback((index: number) => {
    const col = acColumns[index]
    if (!col) return
    const ref = col.column_code || col.column_text
    const el = formulaRef.current!
    const before = formExpression.slice(0, acBracketStart)
    const after = formExpression.slice(el.selectionStart)
    const insert = `[${ref}]`
    setFormExpression(before + insert + after)
    setAcOpen(false)
    setAcFilter('')
    requestAnimationFrame(() => {
      el.focus()
      const cursor = acBracketStart + insert.length
      el.setSelectionRange(cursor, cursor)
    })
  }, [acColumns, acBracketStart, formExpression])

  const { focusedIndex: acFocusedIndex, setFocusedIndex: setAcFocusedIndex, getItemProps: acGetItemProps, containerRef: acListRef } = useListKeyboardNav({
    itemCount: acColumns.length,
    onSelect: acSelectColumn,
    enabled: acOpen,
  })

  const handleFormulaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!availableColumns?.length) return

    if (!acOpen) {
      if (e.key === '[') {
        setAcOpen(true)
        setAcFilter('')
        setAcFocusedIndex(0)
        setAcBracketStart(e.currentTarget.selectionStart)
      }
      return
    }

    // Autocomplete is open — delegate arrow/enter/space to hook logic
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAcFocusedIndex(prev => Math.min(prev + 1, acColumns.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAcFocusedIndex(prev => Math.max(prev - 1, 0))
    } else if ((e.key === 'Enter' || e.key === 'Tab') && acColumns.length > 0) {
      e.preventDefault()
      acSelectColumn(acFocusedIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAcOpen(false)
      setAcFilter('')
    } else if (e.key === ']') {
      setAcOpen(false)
      setAcFilter('')
    }
  }, [acOpen, acColumns, acFocusedIndex, acSelectColumn, setAcFocusedIndex, availableColumns])

  const handleFormulaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setFormExpression(val)
    if (acOpen && acBracketStart >= 0) {
      const cursor = e.target.selectionStart
      const typed = val.slice(acBracketStart + 1, cursor)
      if (typed.includes(']') || cursor <= acBracketStart) {
        setAcOpen(false)
        setAcFilter('')
      } else {
        setAcFilter(typed)
        setAcFocusedIndex(0)
      }
    }
  }, [acOpen, acBracketStart, setAcFocusedIndex])

  const resetForm = useCallback(() => {
    setFormLabel(initial?.column_text || '')
    setFormType(initial?.column_type || (mode === 'computed' ? 'numeric' : 'ordinal'))
    setFormCode(initial?.column_code || '')
    setFormGroup(initial?.group_code || '')
    setFormGroupLabel(initial?.group_label || '')
    setFormScaleLabels(initial?.scale_labels ? initial.scale_labels.join('\n') : '')
    setFormNumericMin(initial?.numeric_min != null ? String(initial.numeric_min) : '')
    setFormNumericMax(initial?.numeric_max != null ? String(initial.numeric_max) : '')
    setFormNumericFormat(initial?.numeric_format || '')
    setFormExpression(initial?.expression || '')
    setPreview(null)
    setPreviewLoading(false)
  }, [initial, mode])

  // Sync form state when dialog opens (programmatic open doesn't fire Radix onOpenChange)
  useEffect(() => {
    if (open) resetForm()
  }, [open, resetForm])

  const handleOpenChange = (o: boolean) => {
    if (o) resetForm()
    onOpenChange(o)
  }

  // Debounced preview for computed mode
  useEffect(() => {
    if (mode !== 'computed' || !projectId || !datasetId) return
    if (!formExpression.trim()) {
      setPreview(null)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setPreviewLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await datasetsApi.previewComputedColumn(projectId, datasetId, {
          column_text: formLabel || 'Preview',
          expression: formExpression,
          column_type: formType,
        })
        setPreview(res)
      } catch {
        setPreview({ valid: false, error: 'Network error', warnings: [], preview_rows: [] })
      } finally {
        setPreviewLoading(false)
      }
    }, 500)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [formExpression, mode, projectId, datasetId, formLabel, formType])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'computed') {
      const data: ComputedColumnCreate = {
        column_text: formLabel.trim(),
        expression: formExpression.trim(),
        column_type: formType,
        column_code: formCode.trim() || null,
      }
      onSubmit(data)
      return
    }
    const data: ManualColumnCreate = {
      column_text: formLabel.trim(),
      column_type: formType,
      column_code: formCode.trim() || null,
      group_code: formGroup.trim() || null,
      group_label: formGroupLabel.trim() || null,
      scale_labels: formType === 'ordinal'
        ? formScaleLabels.split('\n').map(s => s.trim()).filter(Boolean)
        : null,
      numeric_min: (formType === 'numeric' || formType === 'percentage') && formNumericMin
        ? parseFloat(formNumericMin) : null,
      numeric_max: (formType === 'numeric' || formType === 'percentage') && formNumericMax
        ? parseFloat(formNumericMax) : null,
      numeric_format: (formType === 'numeric' || formType === 'percentage') && formNumericFormat
        ? formNumericFormat : null,
    }
    onSubmit(data)
  }

  const scaleLabelsArr = formScaleLabels.split('\n').map(s => s.trim()).filter(Boolean)

  const isDisabled = isSubmitting || !formLabel.trim() ||
    (mode === 'manual' && formType === 'ordinal' && scaleLabelsArr.length < 2) ||
    (mode === 'computed' && !formExpression.trim())

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={`${mode === 'computed' ? 'max-w-lg' : 'max-w-md'} max-h-[85vh] overflow-y-auto`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="col-name">Column label</Label>
            <Input
              id="col-name"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder={mode === 'computed' ? 'e.g., Score Gain' : 'e.g., Observation notes'}
              required
              autoFocus={!initial || mode === 'computed'}
              readOnly={!!initial && mode !== 'computed'}
              className={initial && mode !== 'computed' ? 'text-mm-text-muted bg-mm-bg cursor-default' : ''}
            />
            {initial && mode !== 'computed' && (
              <p className="text-[11px] text-mm-text-faint mt-0.5">Edit from column header</p>
            )}
          </div>

          {mode === 'computed' ? (
            /* ── Computed column fields ── */
            <>
              <div className="relative">
                <Label htmlFor="col-expr">Formula</Label>
                <Textarea
                  id="col-expr"
                  ref={formulaRef}
                  value={formExpression}
                  onChange={handleFormulaChange}
                  onKeyDown={handleFormulaKeyDown}
                  placeholder='Type [ to browse columns, or e.g. [Q001] - [Q002]'
                  rows={3}
                  className="font-mono text-sm"
                  aria-describedby="formula-status"
                  onBlur={() => setTimeout(() => setAcOpen(false), 150)}
                />

                {/* Autocomplete dropdown */}
                {acOpen && acColumns.length > 0 && (
                  <div className="absolute left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow-md overflow-hidden">
                    <div ref={acListRef as React.RefObject<HTMLDivElement>} role="listbox" className="max-h-40 overflow-y-auto">
                      {acColumns.map((c, i) => {
                        const ref = c.column_code || c.column_text
                        const itemProps = acGetItemProps(i)
                        return (
                          <button
                            key={c.id}
                            type="button"
                            role="option"
                            aria-selected={itemProps['aria-selected']}
                            data-focused={itemProps['data-focused']}
                            className={`flex items-baseline gap-2 w-full text-left px-2 py-1 text-xs ${
                              acFocusedIndex === i ? 'bg-accent text-accent-foreground' : 'hover:bg-mm-surface-hover'
                            }`}
                            title={c.column_text}
                            onMouseEnter={itemProps.onMouseEnter}
                            onMouseDown={(e) => { e.preventDefault(); acSelectColumn(i) }}
                          >
                            <span className="font-mono text-violet-600 dark:text-violet-400 shrink-0">{ref}</span>
                            {c.column_code && (
                              <span className="text-mm-text-muted truncate">{c.column_text}</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div id="formula-status" aria-live="polite" className="mt-1.5 min-h-[20px]">
                  {previewLoading && (
                    <span className="text-xs text-mm-text-muted flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Validating...
                    </span>
                  )}
                  {!previewLoading && preview?.valid && (
                    <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Valid
                      {preview.warnings.length > 0 && (
                        <span className="text-amber-600 dark:text-amber-400 ml-1">
                          ({preview.warnings.length} warning{preview.warnings.length > 1 ? 's' : ''})
                        </span>
                      )}
                    </span>
                  )}
                  {!previewLoading && preview && !preview.valid && (
                    <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> {preview.error}
                    </span>
                  )}
                </div>
              </div>

              {/* Preview table */}
              {preview?.valid && preview.preview_rows.length > 0 && (
                <div className="border rounded-md overflow-hidden max-h-40">
                  <table className="text-xs w-full table-fixed">
                    <thead>
                      <tr className="bg-mm-bg border-b">
                        {Object.keys(preview.preview_rows[0].source_values).map(name => (
                          <th key={name} className="px-2 py-1 text-left font-medium text-mm-text-muted truncate max-w-[120px]" title={name}>{name}</th>
                        ))}
                        <th className="px-2 py-1 text-left font-medium text-violet-600 dark:text-violet-400 border-l w-[60px]">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.preview_rows.map((row: ComputedPreviewRow) => (
                        <tr key={row.row_id} className="border-b last:border-0">
                          {Object.values(row.source_values).map((v: string | null, i: number) => (
                            <td key={i} className="px-2 py-0.5 text-mm-text-secondary truncate max-w-[120px]" title={v ?? 'null'}>{v ?? 'null'}</td>
                          ))}
                          <td className="px-2 py-0.5 font-mono border-l text-violet-700 dark:text-violet-300 w-[60px]">
                            {row.result_text ?? 'null'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* R code preview */}
              {preview?.valid && preview.r_expression && (
                <div>
                  <p className="text-[10px] text-mm-text-muted mb-0.5">R equivalent:</p>
                  <code className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 block bg-mm-bg rounded px-2 py-1 break-all">
                    {preview.r_expression}
                  </code>
                </div>
              )}

              {/* Syntax reference */}
              <details className="text-xs text-mm-text-muted">
                <summary className="cursor-pointer hover:text-mm-text select-none">Formula reference</summary>
                <div className="mt-1 space-y-0.5 text-[10px] pl-2">
                  <p><code className="bg-mm-bg px-0.5 rounded">[Column]</code> &mdash; column reference (by code or name)</p>
                  <p><code className="bg-mm-bg px-0.5 rounded">+ - * /</code> &mdash; arithmetic</p>
                  <p><code className="bg-mm-bg px-0.5 rounded">== != &lt; &gt; &lt;= &gt;=</code> &mdash; comparison</p>
                  <p><code className="bg-mm-bg px-0.5 rounded">AND OR NOT</code> &mdash; boolean logic</p>
                  <p><code className="bg-mm-bg px-0.5 rounded">IF(cond, then, else)</code> &mdash; conditional</p>
                  <p><code className="bg-mm-bg px-0.5 rounded">MEAN() SUM() MIN() MAX() COUNT_VALID()</code> &mdash; row aggregates</p>
                  <p><code className="bg-mm-bg px-0.5 rounded">ABS() ROUND() IS_MISSING() COALESCE()</code> &mdash; helpers</p>
                </div>
              </details>

              {/* Available columns */}
              {availableColumns && availableColumns.filter(c => c.id !== initial?.id).length > 0 && (
                <details className="text-xs text-mm-text-muted">
                  <summary className="cursor-pointer hover:text-mm-text select-none">
                    Available columns ({availableColumns.filter(c => c.id !== initial?.id).length})
                  </summary>
                  <div className="mt-1 max-h-36 overflow-y-auto pl-1">
                    {availableColumns
                      .filter(c => c.id !== initial?.id)
                      .map(c => {
                        const ref = c.column_code || c.column_text
                        return (
                          <button
                            key={c.id}
                            type="button"
                            className="flex items-baseline gap-1.5 w-full text-left px-1 py-0.5 rounded hover:bg-mm-surface-hover text-[11px]"
                            title={c.column_text}
                            onClick={() => insertAtCursor(`[${ref}]`)}
                          >
                            <span className="font-mono text-violet-600 dark:text-violet-400 shrink-0">{ref}</span>
                            {c.column_code && (
                              <span className="text-mm-text-muted truncate">{c.column_text}</span>
                            )}
                          </button>
                        )
                      })}
                  </div>
                </details>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="col-code-c">Column code</Label>
                  <Input
                    id="col-code-c"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value)}
                    placeholder="Auto (C1...)"
                  />
                </div>
                <div>
                  <Label htmlFor="col-type-c">Result type</Label>
                  <Select value={formType} onValueChange={setFormType}>
                    <SelectTrigger id="col-type-c">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMPUTED_TYPE_OPTIONS.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          ) : (
            /* ── Manual column fields ── */
            <>
              <div>
                <Label htmlFor="col-type">Type</Label>
                <Select value={formType} onValueChange={setFormType}>
                  <SelectTrigger id="col-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MANUAL_COLUMN_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="col-code">Column code</Label>
                  <Input
                    id="col-code"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value)}
                    placeholder="Auto (M001...)"
                  />
                </div>
                <div>
                  <Label htmlFor="col-group">Group</Label>
                  <Input
                    id="col-group"
                    value={formGroup}
                    onChange={(e) => setFormGroup(e.target.value)}
                    placeholder="Optional"
                  />
                </div>
              </div>

              {formGroup && (
                <div>
                  <Label htmlFor="col-group-label">Group label</Label>
                  <Input
                    id="col-group-label"
                    value={formGroupLabel}
                    onChange={(e) => setFormGroupLabel(e.target.value)}
                    placeholder="Optional group label"
                  />
                </div>
              )}

              {formType === 'ordinal' && (
                <div>
                  <Label htmlFor="col-scale">Value labels (one per line, min 2)</Label>
                  <Textarea
                    id="col-scale"
                    value={formScaleLabels}
                    onChange={(e) => setFormScaleLabels(e.target.value)}
                    placeholder="Strongly Disagree&#10;Disagree&#10;Neutral&#10;Agree&#10;Strongly Agree"
                    rows={5}
                  />
                  {scaleLabelsArr.length > 0 && scaleLabelsArr.length < 2 && (
                    <p className="text-xs text-red-500 mt-1">Need at least 2 labels</p>
                  )}
                </div>
              )}

              {(formType === 'numeric' || formType === 'percentage') && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label htmlFor="col-min">Min</Label>
                    <Input
                      id="col-min"
                      type="number"
                      value={formNumericMin}
                      onChange={(e) => setFormNumericMin(e.target.value)}
                      step="any"
                    />
                  </div>
                  <div>
                    <Label htmlFor="col-max">Max</Label>
                    <Input
                      id="col-max"
                      type="number"
                      value={formNumericMax}
                      onChange={(e) => setFormNumericMax(e.target.value)}
                      step="any"
                    />
                  </div>
                  <div>
                    <Label htmlFor="col-fmt">Format</Label>
                    <Select value={formNumericFormat} onValueChange={setFormNumericFormat}>
                      <SelectTrigger id="col-fmt">
                        <SelectValue placeholder="Any" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="integer">Integer</SelectItem>
                        <SelectItem value="decimal">Decimal</SelectItem>
                        <SelectItem value="percentage">Percentage</SelectItem>
                        <SelectItem value="currency">Currency</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </>
          )}

          {submitError && (
            <p className="text-sm text-red-600">{submitError}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isDisabled}>
              {isSubmitting ? 'Saving...' : (initial ? 'Save Changes' : (mode === 'computed' ? 'Create Computed Column' : 'Add Column'))}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
