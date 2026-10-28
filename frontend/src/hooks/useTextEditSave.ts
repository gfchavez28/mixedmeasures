import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { serverDetailMessage } from '@/lib/api/error-utils'
import type { HistoryAction } from '@/hooks/useHistory'
import type { TextEditAnswer, TextEditPlan } from '@/lib/api/segments'
import {
  buildTextEditEntry,
  keepAsShownAnswer,
  removeFlaggedAnswer,
  type TextEditDoor,
} from '@/lib/text-edit-quotes'
import type { TextEditChoice } from '@/components/TextEditQuotesDialog'

/** How a save ended: written · the researcher went back to editing · refused or
 *  failed (already toasted) · another save of this passage is still running. */
export type TextEditSaveResult = 'saved' | 'cancelled' | 'failed' | 'busy'

/**
 * #1319 — the ONE save flow for a passage's text, on both text workbenches.
 *
 * 1. **Preview** (writes nothing). A failure is toasted and the editor stays open
 *    with the typed text: nothing was saved, so nothing may close.
 * 2. **Confirm** when the edit touches, crosses or removes a quote (D5) — the
 *    dialog's choice becomes the save's answer; Cancel goes back to the editor.
 * 3. **Save through the page's `history.execute`** (pass the function — it is stable;
 *    the `history` object is a fresh literal every render), as an entry that captured every quote's
 *    offsets at the act (`buildTextEditEntry`). `execute` swallows a failure (it
 *    toasts the server's words), so the result is read from the entry itself:
 *    `'saved'` only once the server answered.
 *
 * Before #1319 both workbenches closed the editor and showed "Saved" BEFORE the
 * request resolved, and a failed save lost the typed text.
 *
 * ⚠️ One save per passage at a time: the document editor saves on BLUR, and the
 * dialog opening blurs it, so a second call arrives mid-flow — it is `'busy'`.
 */
export function useTextEditSave(execute: (action: HistoryAction) => Promise<void>) {
  const [plan, setPlan] = useState<TextEditPlan | null>(null)
  const resolverRef = useRef<((choice: TextEditChoice) => void) | null>(null)
  const inFlightRef = useRef<Set<number>>(new Set())

  const onChoose = useCallback((choice: TextEditChoice) => {
    // The first answer wins: an Action's click is followed by the Root's close.
    const resolve = resolverRef.current
    resolverRef.current = null
    setPlan(null)
    resolve?.(choice)
  }, [])

  const ask = useCallback((p: TextEditPlan) => new Promise<TextEditChoice>(resolve => {
    resolverRef.current = resolve
    setPlan(p)
  }), [])

  const isSaving = useCallback((segmentId: number) => inFlightRef.current.has(segmentId), [])

  const save = useCallback(async ({
    segmentId,
    oldText,
    newText,
    door,
  }: {
    segmentId: number
    oldText: string
    newText: string
    door: TextEditDoor
  }): Promise<TextEditSaveResult> => {
    if (inFlightRef.current.has(segmentId)) return 'busy'
    inFlightRef.current.add(segmentId)
    try {
      let preview: TextEditPlan
      try {
        preview = await door.preview(newText)
      } catch (e) {
        toast.error(
          serverDetailMessage(e)
            ?? 'The edit could not be checked against this passage’s quotes, so it was not saved.',
        )
        return 'failed'
      }
      let answer: TextEditAnswer = {}
      if (preview.needs_confirmation) {
        const choice = await ask(preview)
        if (choice === 'cancel') return 'cancelled'
        answer = choice === 'keep' ? keepAsShownAnswer(preview) : removeFlaggedAnswer(preview)
      }
      let saved = false
      await execute(buildTextEditEntry({
        door,
        oldText,
        newText,
        firstAnswer: answer,
        onApplied: () => { saved = true },
      }))
      return saved ? 'saved' : 'failed'
    } finally {
      inFlightRef.current.delete(segmentId)
    }
  }, [ask, execute])

  return { save, isSaving, dialogProps: { plan, onChoose } }
}
