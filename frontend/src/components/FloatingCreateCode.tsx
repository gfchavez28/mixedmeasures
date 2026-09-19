import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { codesApi, categoriesApi, serverDetailMessage, type Code, type CodeCategory } from '@/lib/api'
import { useProjectCodeNames } from '@/hooks/useProjectCodeNames'
import type { ListLoad } from '@/lib/list-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { computeFloatingPosition, type FloatingCoords } from '@/lib/floating-utils'
import { CreatableCombobox } from '@/components/ui/creatable-combobox'
import { buildCategoryOptions } from '@/lib/category-options'
import { CATEGORY_COLORS } from './ColorSwatchPicker'

export type { FloatingCoords } from '@/lib/floating-utils'

interface FloatingCreateCodeProps {
  position: FloatingCoords
  projectId: number
  categories: CodeCategory[]
  /**
   * #963 — whether `categories` is an ANSWER. REQUIRED, so each of the four
   * coding workbenches that mount this has to decide; every one of them passed
   * `categoriesData?.categories ?? []`, which is `[]` before the list answers,
   * and `create_category` refuses no duplicate name — so the picker offered
   * *New category "X"* for a category that already existed, under the words
   * "No categories yet".
   */
  categoriesLoad: ListLoad
  onCreated: (code: Code) => void
  onClose: () => void
  /** Prefill the name (in-vivo coding, #526) — selected on focus so typing replaces it. */
  initialName?: string
}

export default function FloatingCreateCode({
  position,
  projectId,
  categories,
  categoriesLoad,
  onCreated,
  onClose,
  initialName,
}: FloatingCreateCodeProps) {
  const [name, setName] = useState(initialName ?? '')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  // Stable ref for onClose so effects don't re-attach listeners on every render
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  /**
   * #963 — this dialog refused no duplicate name. It reaches all FOUR coding
   * workbenches (the `c` verb and the context menus), which is why it is the
   * highest-traffic of the three surfaces that had no check.
   */
  const { duplicateOf } = useProjectCodeNames(projectId)
  const duplicate = duplicateOf(name)

  const createMutation = useMutation({
    mutationFn: () =>
      codesApi.create(projectId, {
        name: name.trim(),
        description: description.trim() || undefined,
        category_id: categoryId ?? undefined,
      }),
    onSuccess: (code) => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
      onCreated(code)
    },
    /**
     * ⚠️ **This had NO error arm at all** — a failed create closed nothing, said
     * nothing and left the coder looking at a dialog that appeared to do nothing.
     * It matters more now that the server refuses a duplicate: the refusal is the
     * one this dialog's own check may not have made (the hint is advisory and says
     * nothing while the code list is unanswered), so its words have to arrive.
     */
    onError: (err) => {
      toast.error(serverDetailMessage(err) ?? 'Failed to create code')
    },
  })

  const createCategoryMutation = useMutation({
    mutationFn: (name: string) =>
      categoriesApi.create(projectId, {
        name,
        // Auto-assign a colour on quick-create (recolour later in the codebook).
        color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length],
      }),
    onSuccess: (newCat) => {
      queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
      setCategoryId(newCat.id)
    },
  })

  const categoryOptions = useMemo(() => buildCategoryOptions(categories), [categories])

  // Focus input on mount — delay enough for Radix ContextMenu to finish closing.
  // A prefilled (in-vivo) name is select-all'd so typing replaces it.
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      if (initialName) inputRef.current?.select()
    }, 100)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only focus
  }, [])

  // Click outside to close — uses ref so listener is attached once
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onCloseRef.current()
      }
    }
    // Delay to avoid catching the triggering context menu click
    const timer = setTimeout(() => document.addEventListener('mousedown', handle), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handle)
    }
  }, [])

  // Escape to close
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', handle, true)
    return () => document.removeEventListener('keydown', handle, true)
  }, [])

  const handleSubmit = () => {
    if (!name.trim() || duplicate || createMutation.isPending) return
    createMutation.mutate()
  }

  const style = useMemo(
    () => computeFloatingPosition(position, 300, 320),
    [position],
  )

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Create code"
      className="fixed z-50 w-[300px] bg-mm-surface border border-mm-border-medium rounded-lg shadow-xl animate-in fade-in-0 zoom-in-95 duration-150"
      style={{ top: style.top, left: style.left }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-mm-border-subtle">
        <span className="text-sm font-medium text-mm-text">New Code</span>
        <button
          className="text-mm-text-muted hover:text-mm-text"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <div>
          <label className="text-xs text-mm-text-secondary mb-1 block">Name</label>
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="Code name"
            className="h-8 text-sm"
            autoComplete="off"
            aria-invalid={duplicate ? true : undefined}
            aria-describedby={duplicate ? 'floating-create-code-duplicate' : undefined}
          />
          {duplicate && (
            <p id="floating-create-code-duplicate" className="text-xs text-mm-text-muted mt-1">
              A code named “{duplicate.name}” already exists.
            </p>
          )}
        </div>

        <div>
          <label className="text-xs text-mm-text-secondary mb-1 block">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Brief description..."
            className="w-full text-sm border rounded-md px-3 py-1.5 bg-mm-surface text-mm-text placeholder:text-mm-text-faint focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            rows={2}
          />
        </div>

        <div>
          <label className="text-xs text-mm-text-secondary mb-1 block">Category</label>
          <CreatableCombobox
            options={categoryOptions}
            optionsLoad={categoriesLoad}
            optionsNoun="categories"
            value={categoryId}
            onSelect={setCategoryId}
            onCreate={(label) => createCategoryMutation.mutate(label)}
            creating={createCategoryMutation.isPending}
            allowClear
            clearLabel="No category"
            createPrefix="New category"
            searchPlaceholder="Search or create category…"
            emptyText="No categories yet"
            triggerAriaLabel="Category"
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            className="flex-1"
            disabled={!name.trim() || !!duplicate || createMutation.isPending}
            onClick={handleSubmit}
          >
            {createMutation.isPending ? 'Creating...' : 'Create'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <span className="text-[10px] text-mm-text-faint ml-auto">
            <kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded font-mono">Enter</kbd>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
