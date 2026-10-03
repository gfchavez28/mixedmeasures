import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { serverDetailMessage, isServerRefusal } from '@/lib/api'

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
 *
 * @param note an optional second line naming a consequence the user cannot see
 *   on screen — currently only "this step left the history" (#874). Passed ONLY
 *   when there is such a consequence: sonner receives one argument otherwise,
 *   and the toast stays a single line for the ordinary retryable failure.
 */
function failureToast(fallback: string, e: unknown, note?: string): void {
  const message = serverDetailMessage(e) ?? fallback
  if (note) toast.error(message, { description: note })
  else toast.error(message)
}

/** The second line shown when a step is dropped rather than kept for a retry. */
const DROPPED_NOTE =
  'That step can no longer be reversed, so it was removed from the history. Earlier steps are still available.'

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

/**
 * Undo/redo for the coding, dataset, canvas and variables workbenches.
 *
 * 🔴 **THE STACKS LIVE IN REFS, AND THAT IS LOAD-BEARING (#877).** They used to
 * be `useState`, read through each callback's closure — which is only safe while
 * no two actions can be in flight at once. Serialising them (below) makes a
 * second call run against a `past` React has not re-rendered yet, so two quick
 * `undo()`s would have undone the SAME entry twice. The refs are the source of
 * truth; the three pieces of state exist purely so the toolbar re-renders.
 *
 * 🔴 **ACTIONS ARE SERIALISED, NEVER DROPPED (#877).** A `pendingRef` guard used
 * to `return` early whenever anything was in flight — silently. **Measured live
 * 2026-09-03: pressing `0` then `1` on a document segment applied ONE universal
 * code and discarded the other**, with no error, no toast and no request. That
 * is the normal speed of coding, so it is loss of the researcher's intent on the
 * hot path. Every call now queues behind the one before it and runs in order.
 *
 * ⚠️ **Ordering is the reason it is a queue and not just a lock.** These actions
 * drive optimistic cache patches on shared query keys; running two concurrently
 * would interleave a patch with its own rollback. FIFO keeps the cache
 * consistent and keeps the stack in the order the user acted.
 *
 * ⚠️ **An action's `redo`/`undo` must never call back into `execute`/`undo`/
 * `redo`** — it would wait on the chain it is itself a link of, and deadlock.
 * No call site does; keep it that way.
 *
 * 🔴 **`scope` — a stack belongs to ONE CODER on the four coding surfaces
 * (#1042).** Every coding endpoint acts as the SESSION coder, and a workbench
 * stays mounted across a coder switch, so an entry made as coder A replayed as
 * coder B: undoing A's *Pacing* removed B's *Pacing* if B had one, and silently
 * did nothing if not; a code-set undo re-selected A's old value in B's layer.
 * When `scope` changes both stacks are CLEARED and the researcher is told —
 * never tagged per entry, which would leave N entries a Ctrl+Z could only
 * refuse one at a time. ⚠️ **Omit it where the work is not per coder**: the
 * dataset, variables and canvas stacks must keep their history across a switch.
 * ⚠️ A step still in flight when the scope changes completed as the OLD coder,
 * so it is not recorded into the new coder's stack (`generationRef`).
 */
export function useHistory(scope?: string | number | null): UseHistoryReturn {
  const pastRef = useRef<HistoryAction[]>([])
  const futureRef = useRef<HistoryAction[]>([])
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const scopeRef = useRef(scope)
  const generationRef = useRef(0)

  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [lastAction, setLastAction] = useState<HistoryAction | null>(null)

  /** Publish the refs to React. Called only after a stack actually changes. */
  const sync = useCallback(() => {
    setCanUndo(pastRef.current.length > 0)
    setCanRedo(futureRef.current.length > 0)
    setLastAction(pastRef.current[pastRef.current.length - 1] ?? null)
  }, [])

  useEffect(() => {
    if (Object.is(scopeRef.current, scope)) return
    scopeRef.current = scope
    generationRef.current += 1
    const hadSteps = pastRef.current.length > 0 || futureRef.current.length > 0
    pastRef.current = []
    futureRef.current = []
    sync()
    // Only when something was actually lost: the first answer of the session
    // (no coder → a coder) clears nothing and says nothing.
    if (hadSteps) {
      toast.info('Undo history cleared', {
        description: 'Those steps were made as another coder, so undoing them now would change your codings instead.',
      })
    }
  }, [scope, sync])

  /**
   * Run `job` after everything already queued, and resolve when IT is done.
   *
   * The returned promise is what the caller awaits, so `await execute(...)`
   * still means "my action finished". The stored chain swallows rejections so
   * one failure can never poison the queue for every later action — the jobs
   * catch their own errors anyway, and this is the belt to that braces.
   */
  const enqueue = useCallback((job: () => Promise<void>): Promise<void> => {
    const next = chainRef.current.then(job, job)
    chainRef.current = next.catch(() => {})
    return next
  }, [])

  const execute = useCallback((action: HistoryAction) => enqueue(async () => {
    const generation = generationRef.current
    try {
      await action.redo()
      // #1042: it ran as the coder who was active when it started; after a
      // switch it belongs to no stack this page can replay.
      if (generation !== generationRef.current) return
      // `.slice(-MAX)` unconditionally: on a shorter array it returns the whole
      // array, so the old length test bought nothing.
      pastRef.current = [...pastRef.current, action].slice(-MAX_HISTORY_SIZE)
      futureRef.current = []
      sync()
    } catch (e) {
      // Nothing happened, so nothing is recorded and nothing is dropped — the
      // redo stack survives a failed new action deliberately.
      failureToast('Action failed', e)
    }
  }), [enqueue, sync])

  /**
   * 🔴 **A REFUSED UNDO DROPS ITS ENTRY; A FAILED ONE KEEPS IT (#874).**
   *
   * The pointer used to advance only on success, so an inverse that THREW left
   * it parked forever: every later Ctrl+Z re-ran the same impossible action and
   * the whole stack behind it became unreachable for the life of the page.
   * Driven live — apply a rated code, rate it, remove it by another door, then
   * press Ctrl+Z three times for three identical refusals and no movement.
   *
   * The fix is not "advance anyway", because a *transient* failure (offline, a
   * 5xx, a timeout) must stay retryable — undoing is the user's protection and
   * we must not throw it away over a dropped packet. So the two cases split on
   * `isServerRefusal`: the server settled it → the entry can never be reversed,
   * so it LEAVES the timeline and the user is told; anything else → today's
   * behaviour, the entry stays and Ctrl+Z tries again.
   *
   * ⚠️ **A dropped entry is NOT pushed to `future`.** Offering "redo" for a step
   * whose undo just failed would be a button that claims to reverse something it
   * demonstrably cannot.
   */
  const undo = useCallback(() => enqueue(async () => {
    const action = pastRef.current[pastRef.current.length - 1]
    if (!action) return
    const generation = generationRef.current
    try {
      await action.undo()
      // #1042: the stacks were cleared under it; its entry is already gone.
      if (generation !== generationRef.current) return
      pastRef.current = pastRef.current.slice(0, -1)
      futureRef.current = [action, ...futureRef.current]
      sync()
    } catch (e) {
      if (isServerRefusal(e) && generation === generationRef.current) {
        pastRef.current = pastRef.current.slice(0, -1)
        sync()
        failureToast('Undo failed', e, DROPPED_NOTE)
      } else {
        failureToast('Undo failed', e)
      }
    }
  }), [enqueue, sync])

  /** The mirror of `undo` — a settled refusal drops the entry off `future`. */
  const redo = useCallback(() => enqueue(async () => {
    const action = futureRef.current[0]
    if (!action) return
    const generation = generationRef.current
    try {
      await action.redo()
      if (generation !== generationRef.current) return
      futureRef.current = futureRef.current.slice(1)
      pastRef.current = [...pastRef.current, action].slice(-MAX_HISTORY_SIZE)
      sync()
    } catch (e) {
      if (isServerRefusal(e) && generation === generationRef.current) {
        futureRef.current = futureRef.current.slice(1)
        sync()
        failureToast('Redo failed', e, DROPPED_NOTE)
      } else {
        failureToast('Redo failed', e)
      }
    }
  }), [enqueue, sync])

  return { execute, undo, redo, canUndo, canRedo, lastAction }
}
