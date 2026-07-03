import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, X, ChevronDown, Filter, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  datasetsApi,
  recodeApi,
  type ProjectColumnInfo,
  type SubgroupFilter,
  type TextCodingColumn,
} from '@/lib/api'
import { FILTERABLE_TYPES } from '@/lib/dataset-constants'

interface SubgroupFilterPanelProps {
  projectId: number
  focalColumnIds: number[]
  textColumns: TextCodingColumn[]
  filters: SubgroupFilter[]
  onFiltersChange: (filters: SubgroupFilter[]) => void
  matchCount: { records: number; comments: number } | null
}

function getOperatorsForType(columnType: string): { value: string; label: string }[] {
  if (['demographic', 'nominal', 'binary'].includes(columnType)) {
    return [
      { value: 'in', label: 'is one of' },
      { value: 'equals', label: 'equals' },
    ]
  }
  if (columnType === 'ordinal') {
    return [
      { value: 'in', label: 'is one of' },
      { value: 'equals', label: 'equals' },
      { value: 'gte', label: '>=' },
      { value: 'lte', label: '<=' },
    ]
  }
  if (columnType === 'numeric') {
    return [
      { value: 'gte', label: '>=' },
      { value: 'lte', label: '<=' },
      { value: 'above_mean', label: 'above mean' },
      { value: 'below_mean', label: 'below mean' },
    ]
  }
  return [{ value: 'in', label: 'is one of' }]
}

function isCategoricalOperator(op: string) { return ['equals', 'in'].includes(op) }
function isValueOperator(op: string) { return ['gte', 'lte'].includes(op) }

export default function SubgroupFilterPanel({
  projectId,
  focalColumnIds,
  textColumns,
  filters,
  onFiltersChange,
  matchCount,
}: SubgroupFilterPanelProps) {
  const focalDatasetIds = useMemo(() => {
    const ids = new Set<number>()
    for (const cc of textColumns) {
      if (focalColumnIds.includes(cc.column_id)) ids.add(cc.dataset_id)
    }
    return Array.from(ids)
  }, [textColumns, focalColumnIds])

  const { data: allColumnsData } = useQuery({
    queryKey: ['project-columns', projectId],
    queryFn: () => datasetsApi.allColumns(projectId),
    enabled: !!projectId,
  })

  const filterColumns = useMemo(() => {
    if (!allColumnsData) return []
    return allColumnsData.columns.filter(q => {
      if (!focalDatasetIds.includes(q.dataset_id)) return false
      return FILTERABLE_TYPES.includes(q.column_type)
    })
  }, [allColumnsData, focalDatasetIds])

  const groupedColumns = useMemo(() => {
    const demographics = filterColumns.filter(c => c.column_type === 'demographic')
    const scaleColumns = filterColumns.filter(c => c.column_type !== 'demographic')
    return { demographics, scaleColumns }
  }, [filterColumns])

  const [showAddFilter, setShowAddFilter] = useState(false)

  const addFilter = (colId: number) => {
    const col = filterColumns.find(c => c.id === colId)
    if (!col) return
    const ops = getOperatorsForType(col.column_type)
    const defaultOp = ops[0]?.value || 'in'
    onFiltersChange([...filters, {
      column_id: colId,
      operator: defaultOp,
      values: isCategoricalOperator(defaultOp) ? [] : undefined,
      value: isValueOperator(defaultOp) ? '' : undefined,
    }])
    setShowAddFilter(false)
  }

  const updateFilter = (idx: number, update: Partial<SubgroupFilter>) => {
    const next = [...filters]
    next[idx] = { ...next[idx], ...update }
    onFiltersChange(next)
  }

  const removeFilter = (idx: number) => {
    onFiltersChange(filters.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-2" role="form" aria-label="Subgroup filters">
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-2" role="list" aria-label="Active filters">
          {filters.map((f, idx) => {
            const col = filterColumns.find(c => c.id === f.column_id)
            return (
              <FilterPill
                key={`${f.column_id}-${idx}`}
                projectId={projectId}
                filter={f}
                column={col || null}
                onChange={(update) => updateFilter(idx, update)}
                onRemove={() => removeFilter(idx)}
              />
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            className="text-xs gap-1"
            onClick={() => setShowAddFilter(!showAddFilter)}
          >
            <Plus className="w-3 h-3" />
            Add condition
          </Button>
          {showAddFilter && (
            <ColumnPickerDropdown
              demographics={groupedColumns.demographics}
              scaleColumns={groupedColumns.scaleColumns}
              onSelect={addFilter}
              onClose={() => setShowAddFilter(false)}
            />
          )}
        </div>

        {filters.length > 0 && (
          <button
            className="text-xs text-mm-text-muted hover:text-mm-text flex items-center gap-1"
            onClick={() => onFiltersChange([])}
          >
            <X className="w-3 h-3" />
            Clear all
          </button>
        )}

        {matchCount && filters.length > 0 && (
          <span className="text-xs text-mm-text-muted ml-2" aria-live="polite">
            {matchCount.records} record{matchCount.records !== 1 ? 's' : ''}, {matchCount.comments} text{matchCount.comments !== 1 ? 's' : ''} match
          </span>
        )}
      </div>
    </div>
  )
}


function ColumnPickerDropdown({
  demographics,
  scaleColumns,
  onSelect,
  onClose,
}: {
  demographics: ProjectColumnInfo[]
  scaleColumns: ProjectColumnInfo[]
  onSelect: (colId: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Filter variables"
      className="absolute top-full left-0 mt-1 bg-mm-surface border rounded-lg shadow-lg z-50 min-w-[240px] max-h-64 overflow-y-auto py-1"
    >
      {demographics.length > 0 && (
        <>
          <div className="px-3 py-1 text-[11px] font-semibold text-mm-text-faint uppercase tracking-wide" role="presentation">Demographics</div>
          {demographics.map(c => (
            <button
              key={c.id}
              role="option"
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-mm-surface-hover truncate"
              onClick={() => onSelect(c.id)}
            >
              {c.column_name || c.column_text}
              <span className="text-mm-text-faint ml-1 text-xs">({c.dataset_name})</span>
            </button>
          ))}
        </>
      )}
      {scaleColumns.length > 0 && (
        <>
          <div className="px-3 py-1 text-[11px] font-semibold text-mm-text-faint uppercase tracking-wide mt-1" role="presentation">Variables</div>
          {scaleColumns.map(c => (
            <button
              key={c.id}
              role="option"
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-mm-surface-hover truncate"
              onClick={() => onSelect(c.id)}
            >
              {c.column_name || c.column_text}
              <span className="text-mm-text-faint ml-1 text-xs">({c.dataset_name})</span>
            </button>
          ))}
        </>
      )}
      {demographics.length === 0 && scaleColumns.length === 0 && (
        <p className="text-xs text-mm-text-faint px-3 py-2">No filter columns available</p>
      )}
    </div>
  )
}


function FilterPill({
  projectId,
  filter,
  column,
  onChange,
  onRemove,
}: {
  projectId: number
  filter: SubgroupFilter
  column: ProjectColumnInfo | null
  onChange: (update: Partial<SubgroupFilter>) => void
  onRemove: () => void
}) {
  const [showValues, setShowValues] = useState(false)
  const valuesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showValues) return
    const handler = (e: MouseEvent) => {
      if (valuesRef.current && !valuesRef.current.contains(e.target as Node)) setShowValues(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showValues])

  const colName = column ? (column.column_name || column.column_text) : `Column ${filter.column_id}`
  const operators = column ? getOperatorsForType(column.column_type) : []
  const opLabel = operators.find(o => o.value === filter.operator)?.label || filter.operator

  let valueSummary = ''
  if (isCategoricalOperator(filter.operator) && filter.values) {
    valueSummary = filter.values.length > 0
      ? filter.values.length === 1 ? filter.values[0] : `${filter.values.length} selected`
      : 'select...'
  } else if (isValueOperator(filter.operator) && filter.value !== undefined) {
    valueSummary = String(filter.value || 'value...')
  }

  return (
    <div
      role="listitem"
      className="inline-flex items-center gap-1 border rounded-md px-2 py-1 bg-mm-blue/12 border-mm-blue/30 text-xs"
      aria-label={`Filter: ${colName} ${opLabel} ${valueSummary}`}
    >
      <Filter className="w-3 h-3 text-mm-blue flex-shrink-0" />
      <span className="font-medium text-mm-blue-text">{colName}</span>

      <select
        className="bg-transparent text-mm-blue-text border-none text-xs cursor-pointer focus:outline-none"
        aria-label={`Operator for ${colName}`}
        value={filter.operator}
        onChange={e => {
          const newOp = e.target.value
          onChange({
            operator: newOp,
            values: isCategoricalOperator(newOp) ? [] : undefined,
            value: isValueOperator(newOp) ? '' : undefined,
          })
        }}
      >
        {operators.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>

      {isCategoricalOperator(filter.operator) && (
        <div className="relative" ref={valuesRef}>
          <button
            className="text-mm-blue-text hover:text-mm-blue flex items-center gap-0.5"
            onClick={() => setShowValues(!showValues)}
          >
            {valueSummary}
            <ChevronDown className="w-3 h-3" />
          </button>
          {showValues && column && (
            <ValueSelector
              projectId={projectId}
              column={column}
              selectedValues={filter.values || []}
              onChange={vals => onChange({ values: vals })}
            />
          )}
        </div>
      )}

      {isValueOperator(filter.operator) && (
        <input
          type="number"
          className="w-16 bg-mm-surface border border-mm-blue/30 rounded px-1 text-xs"
          aria-label={`Value for ${colName} ${opLabel}`}
          value={filter.value || ''}
          onChange={e => onChange({ value: e.target.value })}
          placeholder="value"
        />
      )}

      <button
        className="text-mm-blue hover:text-mm-blue-text ml-0.5"
        onClick={onRemove}
        aria-label={`Remove filter: ${colName}`}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}


function ValueSelector({
  projectId,
  column,
  selectedValues,
  onChange,
}: {
  projectId: number
  column: ProjectColumnInfo
  selectedValues: string[]
  onChange: (values: string[]) => void
}) {
  const { data: freqData } = useQuery({
    queryKey: ['column-frequencies', projectId, column.dataset_id, column.id],
    queryFn: () => recodeApi.getFrequencies(projectId, column.dataset_id, column.id),
    enabled: column.id > 0,
  })

  const distinctValues = useMemo(() => {
    if (!freqData?.frequencies) return []
    return freqData.frequencies
      .map(f => f.value_text)
      .filter(Boolean) as string[]
  }, [freqData])

  const selectedSet = new Set(selectedValues)

  return (
    <div role="listbox" aria-label="Filter values" aria-multiselectable="true" className="absolute top-full left-0 mt-1 bg-mm-surface border rounded-lg shadow-lg z-50 min-w-[180px] max-h-48 overflow-y-auto py-1">
      {distinctValues.map((val: string) => {
        const checked = selectedSet.has(val)
        return (
          <button
            key={val}
            role="option"
            aria-selected={checked}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-mm-surface-hover text-left"
            onClick={() => {
              if (checked) {
                onChange(selectedValues.filter(v => v !== val))
              } else {
                onChange([...selectedValues, val])
              }
            }}
          >
            <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
              checked ? 'bg-mm-blue border-mm-blue' : 'border-mm-border-medium'
            }`}>
              {checked && <Check className="w-3 h-3 text-white" />}
            </span>
            <span className="truncate">{val}</span>
          </button>
        )
      })}
      {distinctValues.length === 0 && (
        <p className="text-xs text-mm-text-faint px-3 py-2">Loading values...</p>
      )}
    </div>
  )
}
