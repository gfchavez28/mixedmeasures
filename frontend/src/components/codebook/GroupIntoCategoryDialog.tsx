import { useState, useMemo, useCallback, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CATEGORY_COLORS, ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import type { CodebookTreeResponse, CodebookCategoryNode } from '@/lib/api'
import type { SelectionAnalysis } from './codebook-selection'

interface GroupIntoCategoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  analysis: SelectionAnalysis
  treeData: CodebookTreeResponse
  onConfirm: (data: { name: string; color: string }) => void
  isPending?: boolean
}

function detectPlacement(
  analysis: SelectionAnalysis,
  treeData: CodebookTreeResponse,
): string {
  // Find parent of each selected item
  const parents = new Set<string>()

  // For codes: parent = their category_id
  for (const code of analysis.codes) {
    if (code.isUniversal) continue
    parents.add(code.categoryId !== null ? String(code.categoryId) : '_root')
  }

  // For categories: parent = their parent_id from tree
  const catParentMap = new Map<number, number | null>()
  function walk(nodes: CodebookCategoryNode[]) {
    for (const cat of nodes) {
      catParentMap.set(cat.id, cat.parent_id)
      walk(cat.children)
    }
  }
  walk(treeData.tree)

  for (const cat of analysis.categories) {
    const parentId = catParentMap.get(cat.id)
    parents.add(parentId !== null && parentId !== undefined ? String(parentId) : '_root')
  }

  if (parents.size === 1) {
    const parentKey = Array.from(parents)[0]
    if (parentKey === '_root') return 'New category will be created at root level'
    // Find parent name
    function findName(nodes: CodebookCategoryNode[]): string | null {
      for (const cat of nodes) {
        if (String(cat.id) === parentKey) return cat.name
        const found = findName(cat.children)
        if (found) return found
      }
      return null
    }
    const name = findName(treeData.tree)
    return name ? `New category will be created under ${name}` : 'New category will be created at root level'
  }

  return 'New category will be created at root level'
}

export default function GroupIntoCategoryDialog({
  open,
  onOpenChange,
  analysis,
  treeData,
  onConfirm,
  isPending,
}: GroupIntoCategoryDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(CATEGORY_COLORS[0])

  /* eslint-disable react-hooks/set-state-in-effect -- reset form state when dialog opens */
  useEffect(() => {
    if (open) {
      setName('')
      setColor(CATEGORY_COLORS[0])
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  const placement = useMemo(
    () => detectPlacement(analysis, treeData),
    [analysis, treeData],
  )

  const nonUniversalCodes = analysis.codes.filter(c => !c.isUniversal)
  const codeCount = nonUniversalCodes.length
  const catCount = analysis.categories.length

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) return
    onConfirm({ name: trimmed, color })
  }, [name, color, onConfirm])

  const summaryParts: string[] = []
  if (codeCount > 0) summaryParts.push(`${codeCount} code${codeCount !== 1 ? 's' : ''}`)
  if (catCount > 0) summaryParts.push(`${catCount} categor${catCount !== 1 ? 'ies' : 'y'}`)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Group into new category</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-mm-text-muted">
            Create a new category and move {summaryParts.join(' and ')} into it.
          </p>

          <div>
            <label className="text-xs text-mm-text-muted block mb-1">Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) handleSubmit() }}
              placeholder="Category name..."
              autoFocus
              className="h-8 text-sm"
            />
          </div>

          <div>
            <label className="text-xs text-mm-text-muted block mb-1">Color</label>
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>

          <div className="rounded-md bg-mm-bg border border-mm-border-subtle p-2.5 text-xs text-mm-text-faint">
            {placement}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!name.trim() || isPending}
          >
            {isPending ? 'Creating\u2026' : 'Create & Group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
