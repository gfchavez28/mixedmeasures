import { codingApi, textCodingApi } from '@/lib/api'
import type { RatingQueueEntry } from '@/lib/api/coding'

/**
 * Commit a rating for ONE queue entry, whatever kind of thing it sits on
 * (#35 variant B).
 *
 * 🔴 **A rating has TWO endpoints and this is the only place that chooses.**
 * A segment rating is path-keyed (`PATCH /segments/{id}/codes/{id}/magnitude`)
 * and a dataset-cell rating is BODY-keyed on a different router
 * (`PATCH /projects/{id}/text-coding/code/magnitude`) — the text-coding router
 * keys its coding endpoints on the cell rather than on a path. The sweep is
 * the first surface whose queue spans both, so the branch exists exactly once
 * rather than at each caller; a second copy is how one of the two silently
 * stops being reachable.
 *
 * ⚠️ **`null` is an explicit UNRATE and is SENT as `null`.** Both endpoints
 * distinguish "field absent" (leave the rating alone) from "field null"
 * (clear it), so dropping the key turns a deliberate skip into a no-op. The
 * queue never needs the absent form: an entry is here because it is unrated.
 *
 * ⚠️ **A segment entry may cover a GROUP.** The server fans the rating across
 * every visible sibling, so the representative id is enough and the caller
 * must not loop over members it cannot see.
 */
export function commitRating(
  projectId: number,
  entry: RatingQueueEntry,
  magnitude: number | null,
): Promise<unknown> {
  if (entry.target_kind === 'dataset_value') {
    if (entry.dataset_value_id == null) {
      throw new Error('dataset_value entry has no dataset_value_id')
    }
    return textCodingApi.setMagnitude(projectId, {
      dataset_value_id: entry.dataset_value_id,
      code_id: entry.code_id,
      magnitude,
    })
  }
  if (entry.segment_id == null) {
    throw new Error('segment entry has no segment_id')
  }
  return codingApi.setMagnitude(entry.segment_id, entry.code_id, magnitude)
}

/**
 * A stable identity for a queue entry, for React keys and for the strip's
 * mount key.
 *
 * ⚠️ **The strip must be keyed on the TARGET (#870 c)** — its arrow cursor and
 * focus effect initialise once per mount, so a target swap on a live mount
 * keeps the previous cursor and leaves focus where the last click put it. The
 * code id alone is not enough: the sweep walks many targets carrying the same
 * code, which is the whole point of it.
 */
export function entryKey(entry: RatingQueueEntry): string {
  const target = entry.target_kind === 'dataset_value'
    ? `val:${entry.dataset_value_id}`
    : `seg:${entry.segment_id}`
  return `${target}:${entry.code_id}`
}
