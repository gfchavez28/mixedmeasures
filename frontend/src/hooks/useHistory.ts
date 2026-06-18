import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'

export interface HistoryAction {
  type: 'code_apply' | 'code_remove' | 'note_create' | 'note_associate' | 'note_delete' | 'segment_merge' | 'segment_split' | 'segment_edit' | 'quote_create' | 'quote_delete' | 'segment_group' | 'column_name_edit' | 'column_text_edit' | 'text_code_apply' | 'text_code_remove' | 'text_note_create' | 'text_note_delete' | 'canvas_theme_create' | 'canvas_theme_delete' | 'canvas_relationship_create' | 'canvas_relationship_delete' | 'computed_column_create' | 'computed_column_update'
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
    } catch {
      toast.error('Action failed')
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
    } catch {
      toast.error('Undo failed')
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
    } catch {
      toast.error('Redo failed')
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
