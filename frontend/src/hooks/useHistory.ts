import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { serverDetailMessage } from '@/lib/api'

/**
 * A failed history action toasts the SERVER'S reason when it gave one.
 *
 * Every refusal this codebase writes is guidance ("Restore it before rating
 * it"), and a bare "Action failed" over it was the worst available message —
 * the coder had been told exactly what to do and never saw it. #868 (b) made
 * this visible: the rating strip's commit runs through `execute`, and a refused
 * rating read as a broken save.
 *
 * 🔴 **ALL THREE detail shapes, via the one reader (#871).** The first fix read
 * only a STRING detail, so a 422 validation error and a structured 409 both
 * still toasted the fallback — measured on the Variables view, where changing
 * the type of a variable that carries a recode rule showed "Action failed" over
 * the server's *"Cannot change type: columns have recode definitions."*
 *
 * ⚠️ **`serverDetailMessage`, NOT `extractApiError`** — the latter falls back to
 * the thrown Error's own `message`, which would put "network down" (or any raw
 * JS error text) in front of a coder. Here the rule is *the server's words or
 * our own wording*, never the transport's.
 */
function failureToast(fallback: string, e: unknown): void {
  toast.error(serverDetailMessage(e) ?? fallback)
}

export interface HistoryAction {
  type: 'code_apply' | 'code_remove' | 'note_create' | 'note_associate' | 'note_delete' | 'segment_merge' | 'segment_split' | 'segment_edit' | 'quote_create' | 'quote_delete' | 'segment_group' | 'column_name_edit' | 'column_text_edit' | 'column_swap_name_label' | 'column_type_change' | 'text_code_apply' | 'text_code_remove' | 'text_note_create' | 'text_note_delete' | 'canvas_theme_create' | 'canvas_theme_delete' | 'canvas_relationship_create' | 'canvas_relationship_delete' | 'computed_column_create' | 'computed_column_update' | 'clip_create' | 'clip_edit' | 'clip_delete' | 'clip_split' | 'clip_merge'
  description: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

interface UseHistoryReturn {
  execute: (action: HistoryAction) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
  lastAction: HistoryAction | null
}

const MAX_HISTORY_SIZE = 50

export function useHistory(): UseHistoryReturn {
  const [past, setPast] = useState<HistoryAction[]>([])
  const [future, setFuture] = useState<HistoryAction[]>([])
  const pendingRef = useRef(false)

  const execute = useCallback(async (action: HistoryAction) => {
    if (pendingRef.current) return
    pendingRef.current = true
    try {
      await action.redo()
      setPast(prev => {
        const newPast = [...prev, action]
        if (newPast.length > MAX_HISTORY_SIZE) {
          return newPast.slice(-MAX_HISTORY_SIZE)
        }
        return newPast
      })
      setFuture([])
    } catch (e) {
      failureToast('Action failed', e)
    } finally {
      pendingRef.current = false
    }
  }, [])

  const undo = useCallback(async () => {
    if (pendingRef.current) return
    if (past.length === 0) return
    pendingRef.current = true
    try {
      const action = past[past.length - 1]
      await action.undo()
      setPast(prev => prev.slice(0, -1))
      setFuture(prev => [action, ...prev])
    } catch (e) {
      failureToast('Undo failed', e)
    } finally {
      pendingRef.current = false
    }
  }, [past])

  const redo = useCallback(async () => {
    if (pendingRef.current) return
    if (future.length === 0) return
    pendingRef.current = true
    try {
      const action = future[0]
      await action.redo()
      setFuture(prev => prev.slice(1))
      setPast(prev => [...prev, action])
    } catch (e) {
      failureToast('Redo failed', e)
    } finally {
      pendingRef.current = false
    }
  }, [future])

  return {
    execute,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    lastAction: past.length > 0 ? past[past.length - 1] : null,
  }
}
