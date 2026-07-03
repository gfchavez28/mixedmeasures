import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Keyboard-accessible creatable combobox (#462). A single primitive used both as a
 * standalone popover (`CreatableCombobox`) and as inline content (`CreatableComboList`)
 * inside an already-open popover/menu. Type to filter, arrows to move, Enter to pick,
 * and — when `onCreate` is supplied — typing a non-matching name offers a "create" row.
 */
export interface ComboOption {
  value: number
  label: string
  /** Optional swatch colour. Pass the key to render a dot (even null → neutral dot). */
  color?: string | null
  /** Indentation level for hierarchical options (e.g. nested categories). */
  depth?: number
}

type Row =
  | { kind: 'clear' }
  | { kind: 'option'; option: ComboOption }
  | { kind: 'create'; label: string }

export interface CreatableComboListProps {
  options: ComboOption[]
  value: number | null
  onSelect: (value: number | null) => void
  /** When provided, typing a non-matching name offers a "create" row. */
  onCreate?: (label: string) => void
  creating?: boolean
  allowClear?: boolean
  clearLabel?: string
  /** Prefix for the create row, e.g. "New category". */
  createPrefix?: string
  searchPlaceholder?: string
  emptyText?: string
  autoFocus?: boolean
  /** Escape / completed-action dismissal (used by the popover wrapper). */
  onDismiss?: () => void
}

export function CreatableComboList({
  options,
  value,
  onSelect,
  onCreate,
  creating,
  allowClear,
  clearLabel = 'None',
  createPrefix = 'Create',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  autoFocus,
  onDismiss,
}: CreatableComboListProps) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const q = query.trim()
  const qLower = q.toLowerCase()
  const filtered = useMemo(
    () => options.filter(o => o.label.toLowerCase().includes(qLower)),
    [options, qLower],
  )
  const exact = q.length > 0 && options.some(o => o.label.toLowerCase() === qLower)
  const showCreate = !!onCreate && q.length > 0 && !exact

  const rows: Row[] = useMemo(() => {
    const r: Row[] = []
    if (allowClear) r.push({ kind: 'clear' })
    for (const option of filtered) r.push({ kind: 'option', option })
    if (showCreate) r.push({ kind: 'create', label: q })
    return r
  }, [allowClear, filtered, showCreate, q])

  // Clamp at render rather than via a state-syncing effect (avoids cascading renders):
  // the row set shrinks as the query filters, so the stored highlight may overrun it.
  const activeIndex = rows.length === 0 ? -1 : Math.min(highlight, rows.length - 1)

  // Scroll the highlighted row into view during arrow-nav.
  useEffect(() => {
    if (activeIndex < 0) return
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const commit = (row: Row | undefined) => {
    if (!row) return
    if (row.kind === 'clear') onSelect(null)
    else if (row.kind === 'option') onSelect(row.option.value)
    else if (row.kind === 'create') onCreate?.(row.label)
    onDismiss?.()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Don't leak typing/navigation to coding-workbench chord shortcuts or parent dialogs.
    e.stopPropagation()
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(Math.min(activeIndex + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(rows[activeIndex]) }
    else if (e.key === 'Escape') { e.preventDefault(); onDismiss?.() }
  }

  return (
    <div className="space-y-1">
      <Input
        value={query}
        onChange={e => { setQuery(e.target.value); setHighlight(0) }}
        onKeyDown={onKeyDown}
        placeholder={searchPlaceholder}
        className="h-7 text-xs"
        autoFocus={autoFocus}
        aria-label={searchPlaceholder}
      />
      <div ref={listRef} className="max-h-48 overflow-y-auto" role="listbox">
        {rows.length === 0 && (
          <p className="text-xs text-mm-text-muted py-2 text-center">{emptyText}</p>
        )}
        {rows.map((row, i) => {
          const active = i === activeIndex
          if (row.kind === 'clear') {
            return (
              <button
                key="__clear"
                type="button"
                role="option"
                aria-selected={value === null}
                className={cn(
                  'w-full text-left px-2 py-1.5 text-sm rounded flex items-center gap-2 hover:bg-mm-surface-hover',
                  active && 'bg-mm-surface-hover',
                )}
                onClick={() => commit(row)}
                onMouseEnter={() => setHighlight(i)}
              >
                {value === null
                  ? <Check className="w-3 h-3 text-green-600 flex-shrink-0" />
                  : <span className="w-3 flex-shrink-0" />}
                <span className="text-mm-text-muted">{clearLabel}</span>
              </button>
            )
          }
          if (row.kind === 'create') {
            return (
              <button
                key="__create"
                type="button"
                role="option"
                aria-selected={false}
                disabled={creating}
                className={cn(
                  'w-full text-left px-2 py-1.5 text-sm rounded flex items-center gap-2 text-mm-accent font-medium hover:bg-mm-surface-hover',
                  active && 'bg-mm-surface-hover',
                )}
                onClick={() => commit(row)}
                onMouseEnter={() => setHighlight(i)}
              >
                <Plus className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{createPrefix} &ldquo;{row.label}&rdquo;</span>
              </button>
            )
          }
          const o = row.option
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={value === o.value}
              className={cn(
                'w-full text-left px-2 py-1.5 text-sm rounded flex items-center gap-2 hover:bg-mm-surface-hover',
                active && 'bg-mm-surface-hover',
              )}
              style={{ paddingLeft: o.depth ? `${8 + o.depth * 16}px` : undefined }}
              onClick={() => commit(row)}
              onMouseEnter={() => setHighlight(i)}
            >
              {value === o.value
                ? <Check className="w-3 h-3 text-green-600 flex-shrink-0" />
                : <span className="w-3 flex-shrink-0" />}
              {o.color !== undefined && (
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: o.color || '#9ca3af' }}
                />
              )}
              <span className="truncate">{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export interface CreatableComboboxProps extends Omit<CreatableComboListProps, 'autoFocus' | 'onDismiss'> {
  triggerClassName?: string
  triggerAriaLabel?: string
}

export function CreatableCombobox({
  options,
  value,
  onSelect,
  onCreate,
  creating,
  allowClear,
  clearLabel = 'None',
  createPrefix,
  searchPlaceholder,
  emptyText,
  triggerClassName,
  triggerAriaLabel,
}: CreatableComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = value != null ? options.find(o => o.value === value) ?? null : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerAriaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'w-full text-left text-sm px-2 py-1.5 border rounded-md hover:bg-mm-surface-hover flex items-center gap-2',
            triggerClassName,
          )}
        >
          {selected ? (
            <>
              {selected.color !== undefined && (
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: selected.color || '#9ca3af' }}
                />
              )}
              <span className="truncate flex-1">{selected.label}</span>
            </>
          ) : (
            <span className="text-mm-text-muted flex-1">{clearLabel}</span>
          )}
          <ChevronsUpDown className="w-3.5 h-3.5 text-mm-text-muted flex-shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-1" align="start">
        <CreatableComboList
          options={options}
          value={value}
          onSelect={onSelect}
          onCreate={onCreate}
          creating={creating}
          allowClear={allowClear}
          clearLabel={clearLabel}
          createPrefix={createPrefix}
          searchPlaceholder={searchPlaceholder}
          emptyText={emptyText}
          autoFocus
          onDismiss={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
