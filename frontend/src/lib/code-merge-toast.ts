import { describeMergeContradictions } from '@/lib/code-sets'

/**
 * What the Codebook page says after merging codes — moved out of the page so the
 * wording can be tested (no page harness can drive a merge: the tree is an SVG
 * jsdom does not lay out).
 *
 * 🔴 **A merge that left a coder holding two values of a code set is a WARNING,
 * not a success line (#1081 a).** A merge is the one coding write that does not
 * go through the swap, and the set's agreement figures leave those passages out
 * until the coder chooses; the server counts them, the toast says so.
 */
export interface MergedTally {
  sourceCount: number
  targetName: string
  /** Duplicates the merge dropped (same coder, same unit). */
  skipped: number
  ratingsCarried: number
  ratingConflicts: number
  targetHasScale: boolean
  setContradictions: number
  contradictionSet: string | null
}

export interface MergedToast {
  kind: 'success' | 'warning'
  message: string
  description?: string
}

export function mergedToast(t: MergedTally): MergedToast {
  const details: string[] = []
  if (t.skipped > 0) details.push(`${t.skipped} duplicate${t.skipped !== 1 ? 's' : ''} skipped`)
  if (t.ratingConflicts > 0) {
    details.push(`${t.ratingConflicts} rating difference${t.ratingConflicts !== 1 ? 's' : ''} flagged for reconciliation`)
  }
  if (t.ratingsCarried > 0 && !t.targetHasScale) {
    details.push(`${t.ratingsCarried} rating${t.ratingsCarried !== 1 ? 's' : ''} kept but not shown until "${t.targetName}" has a rating scale`)
  }
  const detail = details.length > 0 ? ` (${details.join(' · ')})` : ''
  const message = `Merged ${t.sourceCount} code${t.sourceCount !== 1 ? 's' : ''} into "${t.targetName}"${detail}`
  if (t.setContradictions > 0) {
    return { kind: 'warning', message, description: describeMergeContradictions(t.setContradictions, t.contradictionSet) }
  }
  return { kind: 'success', message }
}
