import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { X, Check, ChevronDown } from 'lucide-react'
import { SELECTED_SEGMENT } from '@/lib/selection'
import { useQuery } from '@tanstack/react-query'
import { codeAnalysisApi, type DemographicFilter } from '@/lib/api'

interface QualFilterBarProps {
  projectId: number
  participantIds: number[]
  onParticipantIdsChange: (ids: number[]) => void
}

function FilterDropdown({
  label,
  options,
  selectedValues,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  selectedValues: Set<string>
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
      <button
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs border rounded-md hover:bg-mm-surface-hover transition-colors ${
          activeCount > 0 ? SELECTED_SEGMENT : 'border-mm-border-medium text-mm-text-secondary'
        }`}
        onClick={() => setOpen(o => !o)}
      >
        {label}
        {activeCount > 0 && (
          <span className="bg-mm-blue/20 text-mm-blue-text text-[11px] rounded-full px-1.5 py-0.5 leading-none">
            {activeCount}
          </span>
        )}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-mm-surface border rounded-lg shadow-lg z-50 min-w-[200px] max-h-64 overflow-y-auto py-1">
          {options.map(opt => {
            const selected = selectedValues.has(opt.value)
            return (
              <button
                key={opt.value}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-mm-surface-hover text-left"
                onClick={() => {
                  const next = new Set(selectedValues)
                  if (selected) next.delete(opt.value)
                  else next.add(opt.value)
                  onChange(next)
                }}
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                  selected ? 'bg-mm-blue border-mm-blue' : 'border-mm-border-medium'
                }`}>
                  {selected && <Check className="w-3 h-3 text-white" />}
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

export default function QualFilterBar({
  projectId,
  participantIds,
  onParticipantIdsChange,
}: QualFilterBarProps) {
  const [demoSelections, setDemoSelections] = useState<Record<string, Set<string>>>({})

  const { data: demoFilterData } = useQuery({
    queryKey: ['demographic-filters', projectId],
    queryFn: () => codeAnalysisApi.demographicFilters(projectId),
    enabled: !!projectId,
  })

  const demographicFilters: DemographicFilter[] = useMemo(() => demoFilterData?.filters ?? [], [demoFilterData?.filters])

  // Compute participant IDs from demographic selections
  useEffect(() => {
    const activeSubtypes = Object.entries(demoSelections).filter(([, vals]) => vals.size > 0)
    if (activeSubtypes.length === 0) {
      if (participantIds.length > 0) onParticipantIdsChange([])
      return
    }

    const perSubtype: Set<number>[] = activeSubtypes.map(([subtype, selectedVals]) => {
      const filter = demographicFilters.find(f => f.subtype === subtype)
      if (!filter) return new Set<number>()
      const union = new Set<number>()
      for (const val of filter.values) {
        if (selectedVals.has(val.value)) {
          for (const pid of val.participant_ids) union.add(pid)
        }
      }
      return union
    })

    let result = perSubtype[0]
    for (let i = 1; i < perSubtype.length; i++) {
      const next = new Set<number>()
      for (const pid of result) {
        if (perSubtype[i].has(pid)) next.add(pid)
      }
      result = next
    }

    const sorted = Array.from(result).sort((a, b) => a - b)
    const prevStr = participantIds.join(',')
    const nextStr = sorted.join(',')
    if (prevStr !== nextStr) {
      onParticipantIdsChange(sorted)
    }
  }, [demoSelections, demographicFilters, onParticipantIdsChange, participantIds])

  const handleDemoChange = useCallback((subtype: string) => (vals: Set<string>) => {
    setDemoSelections(prev => ({ ...prev, [subtype]: vals }))
  }, [])

  const totalActiveFilters = Object.values(demoSelections).reduce((sum, s) => sum + s.size, 0)

  const clearAll = useCallback(() => {
    setDemoSelections({})
  }, [])

  if (demographicFilters.length === 0) return null

  return (
    <div className="space-y-2">
      {demographicFilters.map(filter => (
        <FilterDropdown
          key={filter.subtype}
          label={filter.label}
          options={filter.values.map(v => ({
            value: v.value,
            label: `${v.value} (${v.count})`,
          }))}
          selectedValues={demoSelections[filter.subtype] || new Set()}
          onChange={handleDemoChange(filter.subtype)}
        />
      ))}

      {totalActiveFilters > 0 && (
        <button
          className="inline-flex items-center gap-1 text-xs text-mm-text-muted hover:text-mm-text px-1.5 py-1"
          onClick={clearAll}
        >
          <X className="w-3 h-3" />
          Clear all
        </button>
      )}
    </div>
  )
}
