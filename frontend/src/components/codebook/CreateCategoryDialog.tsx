import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { categoriesApi } from '@/lib/api'
import type { CodebookTreeResponse } from '@/lib/api'
import { CATEGORY_COLORS, ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import CategoryTreePicker from './CategoryTreePicker'

interface CreateCategoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  treeData: CodebookTreeResponse
  onCreated?: (sel: string) => void
}

export default function CreateCategoryDialog({
  open,
  onOpenChange,
  projectId,
  treeData,
  onCreated,
}: CreateCategoryDialogProps) {
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [color, setColor] = useState(CATEGORY_COLORS[0])
  const [parentId, setParentId] = useState<number | null>(null)

  const resetForm = useCallback(() => {
    setName('')
    setColor(CATEGORY_COLORS[0])
    setParentId(null)
  }, [])

  const createMut = useMutation({
    mutationFn: (data: { name: string; color?: string; parent_id?: number | null }) =>
      categoriesApi.create(projectId, data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
      queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      toast.success(`Created category "${created.name}"`)
      resetForm()
      onOpenChange(false)
      onCreated?.(`cat:${created.id}`)
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      const detail = err.response?.data?.detail
      toast.error(detail || 'Failed to create category')
    },
  })

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) return
    const data: { name: string; color?: string; parent_id?: number | null } = {
      name: trimmed,
      color,
      parent_id: parentId,
    }
    createMut.mutate(data)
  }, [name, color, parentId, createMut])

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) resetForm()
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Category</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
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

          <div>
            <label className="text-xs text-mm-text-muted block mb-1">Parent (optional)</label>
            <CategoryTreePicker
              treeData={treeData}
              value={parentId}
              onChange={setParentId}
              noneLabel="Root level"
              maxDepth={3}
            />
            <p className="text-[10px] text-mm-text-faint mt-1">
              Max 4 levels deep. Categories at depth 3 cannot have children.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!name.trim() || createMut.isPending}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
