/**
 * #1319 — a text edit carries the passage's char-range quotes, and this module is
 * the client's half of that, shared by both text workbenches.
 *
 * The server plans every quote (`segment_operations.py::plan_text_edit_rebase`):
 * `silent` ones are followed automatically; `edge` (a change touches the quote's
 * edge from inside), `straddle` (a change crosses an edge) and `gone` (none of its
 * words survive) are shown BEFORE saving (D5) and the save must say what to do with
 * each — or the server refuses it. The functions below turn the researcher's
 * choice, or an undo's captured facts, into that answer.
 *
 * ⚠️ Offsets here are the SERVER's, in code points, and are only ever copied back
 * to it — this module never slices text and never measures a string (#687).
 */
import { toast } from 'sonner'
import type { HistoryAction } from '@/hooks/useHistory'
import { isServerRefusal } from '@/lib/api/error-utils'
import type {
  ExcerptOffsetsPayload,
  TextEditAnswer,
  TextEditOutcome,
  TextEditPlan,
  TextEditQuote,
} from '@/lib/api/segments'

/** The outcomes D5 shows before saving. */
export const NEEDS_CONFIRMATION: ReadonlySet<TextEditOutcome> = new Set(['edge', 'straddle', 'gone'])

export function flaggedQuotes(plan: TextEditPlan): TextEditQuote[] {
  return plan.quotes.filter(q => NEEDS_CONFIRMATION.has(q.outcome))
}

/** "Keep as shown" exists only when there is something to keep at a proposed span
 *  and keeping it all would not put two quotes on the same words. */
export function canKeepAsShown(plan: TextEditPlan): boolean {
  return plan.collisions.length === 0 && flaggedQuotes(plan).some(q => q.outcome !== 'gone')
}

function placedAt(q: TextEditQuote, which: 'old' | 'new'): ExcerptOffsetsPayload {
  const start = which === 'old' ? q.old_start : q.new_start
  const end = which === 'old' ? q.old_end : q.new_end
  if (start == null || end == null) {
    throw new Error(`Quote ${q.excerpt_id} has no ${which} position`)
  }
  return { excerpt_id: q.excerpt_id, start_offset: start, end_offset: end }
}

/** Keep every edge/straddle quote at the span the dialog showed; a gone quote has
 *  none, so it is removed. */
export function keepAsShownAnswer(plan: TextEditPlan): TextEditAnswer {
  const flagged = flaggedQuotes(plan)
  return {
    excerpt_offsets: flagged.filter(q => q.outcome !== 'gone').map(q => placedAt(q, 'new')),
    remove_excerpt_ids: flagged.filter(q => q.outcome === 'gone').map(q => q.excerpt_id),
  }
}

/** Remove every quote the dialog listed. */
export function removeFlaggedAnswer(plan: TextEditPlan): TextEditAnswer {
  return { remove_excerpt_ids: flaggedQuotes(plan).map(q => q.excerpt_id), excerpt_offsets: [] }
}

/** The quotes an apply deleted — what an undo re-creates. */
export function removedQuotes(report: TextEditPlan): TextEditQuote[] {
  return report.quotes.filter(q => q.removed)
}

/** Undo: every quote the act KEPT goes back to its pre-edit offsets, exactly. The
 *  planner alone would not put it there (re-adding a deleted letter AT a quote's
 *  edge stays outside it), which is why the act's report is captured. */
export function undoAnswer(report: TextEditPlan): TextEditAnswer {
  return {
    excerpt_offsets: report.quotes.filter(q => !q.removed).map(q => placedAt(q, 'old')),
    remove_excerpt_ids: [],
  }
}

/** Redo: the act's own result — every kept quote at its post-edit offsets, and the
 *  quotes the undo re-created removed again (they are the flagged ones). */
export function redoAnswer(report: TextEditPlan, recreatedIds: number[]): TextEditAnswer {
  return {
    excerpt_offsets: report.quotes.filter(q => !q.removed).map(q => placedAt(q, 'new')),
    remove_excerpt_ids: [...recreatedIds],
  }
}

/** One door's three calls, bound to ONE passage when the act happens (#1023). */
export interface TextEditDoor {
  preview: (text: string) => Promise<TextEditPlan>
  apply: (text: string, answer: TextEditAnswer) => Promise<TextEditPlan>
  /** Re-create a removed quote at its pre-edit offsets; returns the new id. */
  recreateQuote: (q: TextEditQuote) => Promise<number>
  /** The host's refresh, captured with the passage — a stack outlives the source
   *  it was built on (undo-history.md). */
  refresh: () => void
}

/**
 * The undo entry for one text edit. Every fact the inverse needs is captured when
 * the act runs — the act's own report — never read at replay time.
 *
 * - `redo` (first run = the act) applies `firstAnswer`; later runs replay the act's
 *   offsets and remove the quotes an undo re-created.
 * - `undo` restores the old text with every kept quote on its captured offsets, then
 *   re-creates the removed ones. If the text landed and a re-creation is REFUSED,
 *   the undo finishes and says so (undo-history.md: the first half already
 *   landed); a transient failure throws, so the step stays for a retry, which skips
 *   the quotes already back.
 */
export function buildTextEditEntry({
  door,
  oldText,
  newText,
  firstAnswer,
  onApplied,
}: {
  door: TextEditDoor
  oldText: string
  newText: string
  firstAnswer: TextEditAnswer
  /** Called once the FIRST apply succeeds — the caller's "Saved". */
  onApplied?: () => void
}): HistoryAction {
  let forward: TextEditPlan | null = null
  let recreated = new Map<number, number>()
  return {
    type: 'segment_edit',
    description: 'Edit segment text',
    redo: async () => {
      const first = forward === null
      const answer = first ? firstAnswer : redoAnswer(forward!, [...recreated.values()])
      const report = await door.apply(newText, answer)
      forward = report
      recreated = new Map()
      door.refresh()
      if (first) onApplied?.()
    },
    undo: async () => {
      if (!forward) return
      await door.apply(oldText, undoAnswer(forward))
      door.refresh()
      const notBack: TextEditQuote[] = []
      for (const q of removedQuotes(forward)) {
        if (recreated.has(q.excerpt_id)) continue
        try {
          recreated.set(q.excerpt_id, await door.recreateQuote(q))
        } catch (e) {
          if (!isServerRefusal(e)) throw e
          notBack.push(q)
        }
      }
      door.refresh()
      if (notBack.length > 0) {
        toast.warning(
          notBack.length === 1
            ? 'The text was restored, but one removed quote could not be put back.'
            : `The text was restored, but ${notBack.length} removed quotes could not be put back.`,
        )
      }
    },
  }
}
