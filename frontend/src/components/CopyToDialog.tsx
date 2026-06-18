import { useState, useEffect } from 'react'
import { type DatasetColumn } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { TypeBadge } from '@/components/TypeBadge'

const RECODE_DISALLOWED_TYPES = new Set(['open_text'])

// ── Copy-to Dialog ───────────────────────────────────────────────────────────

export function CopyToDialog({
  open,
  onClose,
  columns,
  currentColumnId,
  definitionName,
  onCopy,
  isCopying,
}: {
  open: boolean
  onClose: () => void
  columns: DatasetColumn[]
  currentColumnId: number
  definitionName: string
  onCopy: (ids: number[]) => void
  isCopying: boolean
}) {
  const currentQ = columns.find(q => q.id === currentColumnId)
  const currentScaleLabels = currentQ?.scale_labels

  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Pre-select columns with matching scale_labels
  useEffect(() => {
    if (!open) return
    const preSelected = new Set<number>()
    if (currentScaleLabels) {
      const currentLabelsKey = JSON.stringify(currentScaleLabels.map(l => l.toLowerCase()))
      for (const q of columns) {
        if (q.id === currentColumnId) continue
        if (q.scale_labels) {
          const labelsKey = JSON.stringify(q.scale_labels.map(l => l.toLowerCase()))
          if (labelsKey === currentLabelsKey) {
            preSelected.add(q.id)
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset selection when dialog opens
    setSelected(preSelected)
  }, [open, currentColumnId, currentScaleLabels, columns])

  const toggleColumn = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const otherColumns = columns.filter(q => q.id !== currentColumnId && !RECODE_DISALLOWED_TYPES.has(q.column_type))
  const selectableColumns = otherColumns.filter(q => !q.recode_definitions?.some(d => d.name === definitionName))

  const selectAll = () => {
    setSelected(new Set(selectableColumns.map(q => q.id)))
  }
  const deselectAll = () => setSelected(new Set())

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Copy "{definitionName}" to other columns</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-xs text-mm-text-muted">
          <button onClick={selectAll} className="hover:text-blue-600 underline">Select all</button>
          <span>/</span>
          <button onClick={deselectAll} className="hover:text-blue-600 underline">Deselect all</button>
          <span className="ml-auto">{selected.size} of {selectableColumns.length} selected</span>
        </div>
        <div className="space-y-1 mt-1 overflow-y-auto flex-1 min-h-0">
          {otherColumns.map(q => {
            const hasExisting = q.recode_definitions?.some(d => d.name === definitionName)
            return (
              <label
                key={q.id}
                className={`flex items-start gap-2 p-2 rounded hover:bg-mm-surface-hover text-sm ${hasExisting ? 'opacity-50' : 'cursor-pointer'}`}
              >
                <Checkbox
                  checked={selected.has(q.id)}
                  onCheckedChange={() => toggleColumn(q.id)}
                  disabled={hasExisting}
                  className="mt-0.5 shrink-0"
                />
                <span className="flex-grow min-w-0">
                  {q.column_code && (
                    <span className="font-mono text-xs text-mm-text-muted mr-1">{q.column_code}:</span>
                  )}
                  {q.column_text}
                </span>
                <TypeBadge type={q.column_type} />
                {hasExisting && <span className="text-xs text-mm-text-faint shrink-0">exists</span>}
              </label>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => onCopy([...selected])}
            disabled={selected.size === 0 || isCopying}
          >
            {isCopying ? 'Copying...' : `Copy to ${selected.size} column${selected.size !== 1 ? 's' : ''}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
