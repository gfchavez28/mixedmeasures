import { useRef, useEffect, useCallback, useId } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { scratchpadApi } from '@/lib/api'
import { toast } from 'sonner'

interface ScratchpadPopoverProps {
  projectId: number
  contextHint: string
  unsortedCount: number
  draft: string
  onDraftChange: (value: string) => void
  onClose: () => void
  zIndex?: number
}

export default function ScratchpadPopover({ projectId, contextHint, unsortedCount, draft, onDraftChange, onClose, zIndex }: ScratchpadPopoverProps) {
  const queryClient = useQueryClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const originId = useId()

  // Focus trap: Tab wraps within popover, Escape closes, restore focus on unmount
  useFocusTrap(containerRef, onClose)

  // Auto-focus textarea on mount
  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  const createMutation = useMutation({
    mutationFn: () => scratchpadApi.create(projectId, {
      content: draft.trim(),
      context_hint: contextHint || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scratchpad', projectId] })
      toast.success('Jotted down')
      onDraftChange('')
      onClose()
    },
    onError: () => {
      toast.error('Failed to save')
    },
  })

  const handleSave = useCallback(() => {
    if (!draft.trim()) return
    createMutation.mutate()
  }, [draft, createMutation])

  // Ctrl+Enter to save
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    }
  }, [handleSave])

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Quick jot"
      className="fixed bg-mm-surface border border-mm-border-subtle shadow-xl rounded-lg p-3 space-y-2"
      style={{ width: 320, top: 52, right: 16, zIndex: zIndex ?? 50 }}
    >
      {/* Context hint */}
      {/* #1002 — the origin STORED with the note, said as one: a bare grey
          "Conversations › Interview 3" read to a screen reader as an unlabelled
          fragment above the text box. `title` carries the whole trail when a long
          name is truncated. */}
      {contextHint && (
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            id={originId}
            className="text-[10px] text-mm-text-muted bg-mm-bg rounded px-1.5 py-0.5 truncate max-w-[280px]"
            title={contextHint}
          >
            From {contextHint}
          </span>
        </div>
      )}

      {/* #1134 — the text box takes focus on open, so a reader never met the
          "From …" line above it; it is the box's description now (run 8's
          "a hint on screen but attached to nothing"). */}
      <Textarea
        ref={textareaRef}
        aria-describedby={contextHint ? originId : undefined}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What are you noticing?"
        className="text-sm min-h-[80px] resize-none bg-mm-bg"
        rows={3}
      />

      <div className="flex items-center justify-between">
        {unsortedCount > 0 ? (
          <span className="text-[10px] text-mm-text-muted">
            {unsortedCount} unsorted
          </span>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!draft.trim() || createMutation.isPending}
          onClick={handleSave}
        >
          {createMutation.isPending ? (
            <LoaderCircle className="h-3 w-3 animate-spin mr-1" />
          ) : null}
          Save
          <kbd className="ml-1.5 text-[9px] opacity-50">Ctrl+Enter</kbd>
        </Button>
      </div>
    </div>
  )
}
