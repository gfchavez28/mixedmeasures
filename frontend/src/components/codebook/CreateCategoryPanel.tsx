import { useState, useCallback, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { categoriesApi } from '@/lib/api'
import type { CodebookTreeResponse } from '@/lib/api'
import { CATEGORY_COLORS, ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import CategoryTreePicker from './CategoryTreePicker'

interface CreateCategoryPanelProps {
  projectId: number
  treeData: CodebookTreeResponse
  onCreated?: (sel: string) => void
  onClose: () => void
  onHoverCategory?: (categoryId: number | null) => void
  onLabelChange?: (label: string) => void
  onColorChange?: (color: string) => void
}

export default function CreateCategoryPanel({
  projectId,
  treeData,
  onCreated,
  onClose,
  onHoverCategory,
  onLabelChange,
  onColorChange,
}: CreateCategoryPanelProps) {
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [color, setColor] = useState(CATEGORY_COLORS[0])
  const [parentId, setParentId] = useState<number | null>(null)

  const createMut = useMutation({
    mutationFn: (data: { name: string; color?: string; parent_id?: number | null }) =>
      categoriesApi.create(projectId, data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
      queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      toast.success(`Created category "${created.name}"`)
      onCreated?.(`cat:${created.id}`)
      onClose()
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      const detail = err.response?.data?.detail
      toast.error(detail || 'Failed to create category')
    },
  })

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) return
    createMut.mutate({ name: trimmed, color, parent_id: parentId })
  }, [name, color, parentId, createMut])

  // Report name changes for spotlight label
  useEffect(() => {
    onLabelChange?.(name)
  }, [name, onLabelChange])

  // Report color changes for spotlight color
  useEffect(() => {
    onColorChange?.(color)
  }, [color, onColorChange])

  // Clean up hover on unmount
  useEffect(() => {
    return () => onHoverCategory?.(null)
  }, [onHoverCategory])

  return (
    <div
      className="absolute top-6 right-6 z-40 w-72 bg-mm-surface border border-mm-border-subtle rounded-lg shadow-lg"
      role="dialog"
      aria-modal="false"
      aria-label="Create category"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <h3 className="text-sm font-medium text-mm-text">Create Category</h3>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-mm-text-faint hover:text-mm-text-secondary transition-colors"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3 pb-3 space-y-2.5">
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
            onHover={onHoverCategory}
            noneLabel="Root level"
            maxDepth={3}
          />
          <p className="text-[10px] text-mm-text-faint mt-1">
            Hover a parent to preview placement. Max 4 levels deep.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!name.trim() || createMut.isPending}
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  )
}
