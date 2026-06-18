import { useState, useCallback, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { codesApi } from '@/lib/api'
import type { CodebookTreeResponse } from '@/lib/api'
import CategoryTreePicker from './CategoryTreePicker'

interface CreateCodePanelProps {
  projectId: number
  treeData: CodebookTreeResponse
  onCreated?: (sel: string) => void
  onClose: () => void
  onHoverCategory?: (categoryId: number | null) => void
  onLabelChange?: (label: string) => void
}

export default function CreateCodePanel({
  projectId,
  treeData,
  onCreated,
  onClose,
  onHoverCategory,
  onLabelChange,
}: CreateCodePanelProps) {
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)

  const createMut = useMutation({
    mutationFn: (data: { name: string; description?: string; category_id?: number }) =>
      codesApi.create(projectId, data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      toast.success(`Created code "${created.name}"`)
      onCreated?.(`code:${created.id}`)
      onClose()
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      const detail = err.response?.data?.detail
      toast.error(detail || 'Failed to create code')
    },
  })

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) return
    const data: { name: string; description?: string; category_id?: number } = { name: trimmed }
    if (description.trim()) data.description = description.trim()
    if (categoryId !== null) data.category_id = categoryId
    createMut.mutate(data)
  }, [name, description, categoryId, createMut])

  // Report name changes for spotlight label
  useEffect(() => {
    onLabelChange?.(name)
  }, [name, onLabelChange])

  // Clean up hover on unmount
  useEffect(() => {
    return () => onHoverCategory?.(null)
  }, [onHoverCategory])

  return (
    <div
      className="absolute top-6 right-6 z-40 w-72 bg-mm-surface border border-mm-border-subtle rounded-lg shadow-lg"
      role="dialog"
      aria-modal="false"
      aria-label="Create code"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <h3 className="text-sm font-medium text-mm-text">Create Code</h3>
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
            placeholder="Code name..."
            autoFocus
            className="h-8 text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-mm-text-muted block mb-1">Description (optional)</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does this code capture?"
            className="w-full text-xs rounded-md border border-mm-border-subtle bg-mm-bg text-mm-text p-2 focus:outline-none focus:ring-1 focus:ring-mm-blue/50 resize-y min-h-[48px]"
          />
        </div>

        <div>
          <label className="text-xs text-mm-text-muted block mb-1">Category (optional)</label>
          <CategoryTreePicker
            treeData={treeData}
            value={categoryId}
            onChange={setCategoryId}
            onHover={onHoverCategory}
            noneLabel="No category"
          />
          <p className="text-[10px] text-mm-text-faint mt-1">
            Hover a category to preview placement on the view.
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
