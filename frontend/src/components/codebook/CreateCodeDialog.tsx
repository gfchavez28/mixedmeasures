import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { codesApi } from '@/lib/api'
import type { CodebookTreeResponse } from '@/lib/api'
import CategoryTreePicker from './CategoryTreePicker'

interface CreateCodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  treeData: CodebookTreeResponse
  onCreated?: (sel: string) => void
}

export default function CreateCodeDialog({
  open,
  onOpenChange,
  projectId,
  treeData,
  onCreated,
}: CreateCodeDialogProps) {
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)

  const resetForm = useCallback(() => {
    setName('')
    setDescription('')
    setCategoryId(null)
  }, [])

  const createMut = useMutation({
    mutationFn: (data: { name: string; description?: string; category_id?: number }) =>
      codesApi.create(projectId, data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      queryClient.invalidateQueries({ queryKey: ['codebook-tree', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      toast.success(`Created code "${created.name}"`)
      resetForm()
      onOpenChange(false)
      onCreated?.(`code:${created.id}`)
    },
    onError: () => {
      toast.error('Failed to create code')
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
          <DialogTitle>Create Code</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
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
              className="w-full text-xs rounded-md border border-mm-border-subtle bg-mm-bg text-mm-text p-2 focus:outline-none focus:ring-1 focus:ring-mm-blue/50 resize-y min-h-[60px]"
            />
          </div>

          <div>
            <label className="text-xs text-mm-text-muted block mb-1">Category (optional)</label>
            <CategoryTreePicker
              treeData={treeData}
              value={categoryId}
              onChange={setCategoryId}
              noneLabel="No category"
            />
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
