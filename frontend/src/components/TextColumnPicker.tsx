import { useState, useMemo, useEffect } from 'react'
import { ChevronDown, ChevronRight, MessageSquareText, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { TextCodingColumn } from '@/lib/api'

interface TextCodingColumnPickerProps {
  columns: TextCodingColumn[]
  selectedColumnIds: number[]
  onSelectionChange: (ids: number[]) => void
  onSwitchToRecordView?: () => void
}

export default function TextCodingColumnPicker({
  columns,
  selectedColumnIds,
  onSelectionChange,
  onSwitchToRecordView,
}: TextCodingColumnPickerProps) {
  const [open, setOpen] = useState(false)

  const byDataset = useMemo(() => {
    const map = new Map<number, { name: string; columns: TextCodingColumn[] }>()
    for (const col of columns) {
      if (!map.has(col.dataset_id)) {
        map.set(col.dataset_id, { name: col.dataset_name, columns: [] })
      }
      map.get(col.dataset_id)!.columns.push(col)
    }
    return map
  }, [columns])

  const [expandedDatasets, setExpandedDatasets] = useState<Set<number>>(() => {
    const ds = new Set<number>()
    for (const col of columns) {
      if (selectedColumnIds.includes(col.column_id)) ds.add(col.dataset_id)
    }
    // If none selected, expand all
    if (ds.size === 0) for (const id of byDataset.keys()) ds.add(id)
    return ds
  })

  // Expand datasets containing newly selected columns (e.g., when config loads async)
  useEffect(() => {
    if (selectedColumnIds.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- expand datasets for async-loaded selected columns
    setExpandedDatasets(prev => {
      const next = new Set(prev)
      let changed = false
      for (const col of columns) {
        if (selectedColumnIds.includes(col.column_id) && !next.has(col.dataset_id)) {
          next.add(col.dataset_id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedColumnIds, columns])

  const toggleDataset = (dsId: number) => {
    setExpandedDatasets(prev => {
      const next = new Set(prev)
      if (next.has(dsId)) next.delete(dsId)
      else next.add(dsId)
      return next
    })
  }

  const toggleColumn = (colId: number) => {
    if (selectedColumnIds.includes(colId)) {
      onSelectionChange(selectedColumnIds.filter(id => id !== colId))
    } else {
      onSelectionChange([...selectedColumnIds, colId])
    }
  }

  const selectedCount = selectedColumnIds.length
  const label = selectedCount === 0
    ? 'Select columns'
    : selectedCount === 1
      ? columns.find(c => c.column_id === selectedColumnIds[0])?.column_name || '1 column'
      : `${selectedCount} columns`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 max-w-[240px]" aria-label={`Select text columns: ${label}`}>
          <MessageSquareText className="w-4 h-4 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-2 border-b">
          <p className="text-xs text-muted-foreground font-medium">Focal text columns</p>
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {Array.from(byDataset.entries()).map(([dsId, { name, columns: dsCols }]) => (
            <div key={dsId}>
              <button
                className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm font-medium text-left hover:bg-accent rounded"
                onClick={() => toggleDataset(dsId)}
                aria-expanded={expandedDatasets.has(dsId)}
              >
                {expandedDatasets.has(dsId) ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                )}
                {name}
              </button>
              {expandedDatasets.has(dsId) && (
                <div className="ml-4">
                  {dsCols.map(col => (
                    <label
                      key={col.column_id}
                      className="flex items-start gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-accent rounded"
                    >
                      <input
                        type="checkbox"
                        checked={selectedColumnIds.includes(col.column_id)}
                        onChange={() => toggleColumn(col.column_id)}
                        className="mt-0.5 rounded border-mm-border-medium"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{col.column_name || col.column_text}</div>
                        <div className="text-xs text-muted-foreground">
                          {col.non_empty_rows}/{col.total_rows} responded
                          {col.coded_rows > 0 && ` · ${col.coded_rows} coded`}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {selectedCount >= 3 && (
          <div className="p-2 border-t bg-amber-50 dark:bg-amber-900/30 flex items-start gap-2">
            <TriangleAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-800 dark:text-amber-200">
              Viewing many text columns? Try{' '}
              {onSwitchToRecordView ? (
                <button
                  className="underline font-medium"
                  onClick={() => {
                    onSwitchToRecordView()
                    setOpen(false)
                  }}
                >
                  By Record view
                </button>
              ) : (
                <span className="font-medium">By Record view</span>
              )}{' '}
              for a per-person overview.
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
