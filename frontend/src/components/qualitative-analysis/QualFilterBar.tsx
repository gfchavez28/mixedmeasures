import { useState, useCallback, useEffect, useRef } from 'react'
import { X, Check, ChevronDown } from 'lucide-react'
import { SELECTED_SEGMENT } from '@/lib/selection'
import type { DemographicFilter } from '@/lib/api'
import {
  NO_PARTICIPANT_MATCHES_VALUES, PARTICIPANT_FILTER_RULE, filterApplied, givenFilterNote,
  type FilterValues, type ParticipantFilterState,
} from '@/lib/participant-filter'

/**
 * The analysis page's *Filters* panel — CONTROLLED since #1537 (D122–D124, 1.6.0).
 *
 * It holds no filter of its own: the page decides what is applied (`participantFilterState`)
 * and holds the chosen values (`useQualitativeAnalysis`'s `filterChoice`), because this panel
 * mounts only while *Filters* is open. Before, the values were its local state and an effect
 * rewrote the applied list from them on every mount and every change of the list — so
 * reopening the panel cleared the researcher's filter, a filter from a link or a saved analysis
 * was cleared the moment the panel opened, and a saved analysis loaded while it was open was
 * overwritten with the panel's own choice. It writes only on a researcher's act.
 */
interface QualFilterBarProps {
  options: readonly DemographicFilter[]
  state: ParticipantFilterState
  /** A researcher chose or removed a value — the page resolves and applies it. */
  onChooseValues: (values: FilterValues) => void
  /** *Clear all* / *Clear filter*. */
  onClear: () => void
}

const NO_VALUES: FilterValues = {}
const EMPTY_SET: ReadonlySet<string> = new Set()

function FilterDropdown({
  label,
  options,
  selectedValues,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  selectedValues: ReadonlySet<string>
  onChange: (values: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const activeCount = selectedValues.size

  return (
    <div className="relative" ref={ref}>
      {/* #1537 D127 — the trigger says whether its list is open, and its count is part of a
          name with a space in it ("Group, 1 chosen"), not glued on ("Group1", #908's shape). */}
      <button
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs border rounded-md hover:bg-mm-surface-hover transition-colors ${
          activeCount > 0 ? SELECTED_SEGMENT : 'border-mm-border-medium text-mm-text-secondary'
        }`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={activeCount > 0 ? `${label}, ${activeCount} chosen` : label}
      >
        {label}
        {activeCount > 0 && (
          <span className="bg-mm-blue/20 text-mm-blue-text text-[11px] rounded-full px-1.5 py-0.5 leading-none" aria-hidden="true">
            {activeCount}
          </span>
        )}
        <ChevronDown className="w-3 h-3" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-mm-surface border rounded-lg shadow-lg z-50 min-w-[200px] max-h-64 overflow-y-auto py-1">
          {options.map(opt => {
            const selected = selectedValues.has(opt.value)
            return (
              <button
                key={opt.value}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-mm-surface-hover text-left"
                // #1537 D127 — a chosen value was a check icon only.
                aria-pressed={selected}
                onClick={() => {
                  const next = new Set(selectedValues)
                  if (selected) next.delete(opt.value)
                  else next.add(opt.value)
                  onChange(next)
                }}
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                  selected ? 'bg-mm-blue-fill border-mm-blue-fill' : 'border-mm-border-medium'
                }`} aria-hidden="true">
                  {selected && <Check className="w-3 h-3 text-mm-on-fill" />}
                </span>
                <span className="truncate">{opt.label}</span>
              </button>
            )
          })}
          {options.length === 0 && (
            <p className="text-xs text-mm-text-faint px-3 py-2">No options available</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function QualFilterBar({ options, state, onChooseValues, onClear }: QualFilterBarProps) {
  // The values shown are the page's: a list with no values behind it (D124) shows none.
  const values = state.kind === 'values' || state.kind === 'nobody' ? state.values : NO_VALUES

  const handleChange = useCallback((subtype: string) => (vals: Set<string>) => {
    onChooseValues({ ...values, [subtype]: vals })
  }, [onChooseValues, values])

  if (options.length === 0) return null

  return (
    <div>
      <div className="space-y-2">
        {options.map(filter => (
          <FilterDropdown
            key={filter.subtype}
            label={filter.label}
            options={filter.values.map(v => ({
              value: v.value,
              label: `${v.value} (${v.count})`,
            }))}
            selectedValues={values[filter.subtype] ?? EMPTY_SET}
            onChange={handleChange(filter.subtype)}
          />
        ))}
      </div>

      {/* #1538 D125 — values no participant holds together. The status region is ALWAYS
          mounted (and never display:none) so the sentence is announced when it appears — a
          region that mounts with its text, or is unhidden with it, is not reliably read. Empty,
          it has no height and no margin. */}
      <p
        role="status"
        className={state.kind === 'nobody' ? 'mt-2 text-xs text-mm-text-secondary leading-snug px-1' : undefined}
        data-testid="participant-filter-nobody"
      >
        {state.kind === 'nobody' ? NO_PARTICIPANT_MATCHES_VALUES : null}
      </p>

      {(state.kind === 'values' || state.kind === 'nobody') && (
        <button
          className="mt-2 inline-flex items-center gap-1 text-xs text-mm-text-muted hover:text-mm-text px-1.5 py-1"
          onClick={onClear}
        >
          <X className="w-3 h-3" aria-hidden="true" />
          Clear all
        </button>
      )}

      {/* #1537 D124 — a list no chosen values produced (a link, a reload, a saved analysis) is
          SAID, never cleared: opening this panel used to drop it. */}
      {state.kind === 'given' && (
        <div className="mt-2 px-1 space-y-1" data-testid="participant-filter-given">
          <p className="text-xs text-mm-text-secondary leading-snug">{givenFilterNote(state.ids.length)}</p>
          <button
            className="inline-flex items-center gap-1 text-xs text-mm-text-muted hover:text-mm-text px-1.5 py-1 -ml-1.5"
            onClick={onClear}
          >
            <X className="w-3 h-3" aria-hidden="true" />
            Clear filter
          </button>
        </div>
      )}

      {/* #1536 (D119): what the filter counts, while one is applied — the server's rule, said. */}
      {filterApplied(state) && (
        <p className="mt-2 text-xs text-mm-text-muted leading-snug px-1" data-testid="participant-filter-rule">
          {PARTICIPANT_FILTER_RULE}
        </p>
      )}
    </div>
  )
}
