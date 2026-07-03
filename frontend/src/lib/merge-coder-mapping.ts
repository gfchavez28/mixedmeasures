// Track J · J3-2: pure coder-mapping helpers for the merge confirm step.
// Kept out of the page component so the match/create/un-archive/rename logic that
// builds the `coder_mapping` wire payload is unit-testable.

import type { MergeCoderPreview, CoderMapping, CoderMappingDecision } from './api'

/**
 * Smart default per incoming coder (R3): map onto a confident name-match, else add as
 * new. When the match is an archived local coder, default to un-archiving it — the point
 * of attributing work to a coder is to have them count toward consensus/IRR (archived
 * coders don't vote), so the merge is meaningful by default; the user can opt out.
 */
export function defaultDecision(c: MergeCoderPreview): CoderMappingDecision {
  if (c.local_match) {
    return c.local_match.archived
      ? { action: 'match', target_user_id: c.local_match.id, unarchive: true }
      : { action: 'match', target_user_id: c.local_match.id }
  }
  return { action: 'create' }
}

export function defaultDecisions(coders: MergeCoderPreview[]): Record<number, CoderMappingDecision> {
  return Object.fromEntries(coders.map(c => [c.original_id, defaultDecision(c)]))
}

export function decisionToValue(d: CoderMappingDecision): string {
  return d.action === 'match' ? `match:${d.target_user_id}` : 'create'
}

export function parseDecisionValue(value: string): CoderMappingDecision {
  return value === 'create'
    ? { action: 'create' }
    : { action: 'match', target_user_id: parseInt(value.slice('match:'.length)) }
}

/**
 * Build the `coder_mapping` wire payload from the per-coder decisions. Keyed by the file
 * coder's `original_id` (as a string — JSON object keys). For 'create', only send
 * `new_username` when the user actually renamed (else the backend uses the file username,
 * suffixing on collision). For 'match', carry `unarchive` only when set.
 */
export function buildCoderMapping(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
  renames: Record<number, string>,
): CoderMapping {
  const out: CoderMapping = {}
  for (const c of coders) {
    const d = decisions[c.original_id]
    if (!d) continue
    if (d.action === 'match') {
      out[String(c.original_id)] = d.unarchive
        ? { action: 'match', target_user_id: d.target_user_id, unarchive: true }
        : { action: 'match', target_user_id: d.target_user_id }
    } else {
      const renamed = renames[c.original_id]?.trim()
      out[String(c.original_id)] = renamed && renamed !== c.username
        ? { action: 'create', new_username: renamed }
        : { action: 'create' }
    }
  }
  return out
}

/**
 * How many distinct coders the file's codings will span once mapped: each `match`
 * resolves to its target coder id, each `create` is a new distinct coder. Optionally
 * union in coders already known to be present (e.g. a target roster). Drives the
 * single-vs-multi-coder note on the confirm step (#444): the prior check counted only
 * NEW coders, so the default "N file coders → N distinct existing coders" mapping —
 * which preserves multi-coder — was wrongly flagged as single-coder.
 *
 * Note: this counts only what the merge reliably knows (the file side). The confirm
 * step has no project-scoped view of who already coded the target, so it deliberately
 * does not guess from the instance-global roster (that would over-claim).
 */
export function resultingCoderCount(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
  existingCoderIds: number[] = [],
): number {
  const ids = new Set<string>(existingCoderIds.map(id => `u:${id}`))
  for (const c of coders) {
    const d = decisions[c.original_id]
    if (!d) continue
    ids.add(d.action === 'match' ? `u:${d.target_user_id}` : `new:${c.original_id}`)
  }
  return ids.size
}
