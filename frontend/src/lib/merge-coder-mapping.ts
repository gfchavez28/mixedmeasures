// Track J · J3-2: pure coder-mapping helpers for the merge confirm step.
// Kept out of the page component so the match/create/un-archive/rename logic that
// builds the `coder_mapping` wire payload is unit-testable.

import type { MergeCoderPreview, CoderMapping, CoderMappingDecision } from './api'
import { isMachineCoder, MACHINE_CODER_TYPE } from './coding-layers'

/**
 * The default per incoming coder — #1352 replaced R3 ("pre-select any name match").
 *
 * - **The SAME coder** (`local_match.basis === 'identity'`: their `users.uuid` — they came
 *   from this install, or an earlier merge added them) is pre-selected, un-archived by
 *   default when archived here (an archived coder does not vote; the user can opt out).
 * - **A coder who only shares the NAME starts UNANSWERED (`null`)** — #1193's rule for
 *   Coding Import, now the merge's too. Every install's first coder is "Researcher", so
 *   R3 put a colleague's codings on the lead's own coder and reliability compared a coder
 *   with themselves. The same-name coder is one click away in the list.
 * - No local match: add as new.
 */
export function defaultDecision(c: MergeCoderPreview): CoderMappingDecision | null {
  const m = c.local_match
  if (m && m.basis === 'identity') {
    return m.archived
      ? { action: 'match', target_user_id: m.id, unarchive: true }
      : { action: 'match', target_user_id: m.id }
  }
  if (m) return null
  return { action: 'create' }
}

/** Only ANSWERED coders get an entry — an absent key is "not answered yet". */
export function defaultDecisions(coders: MergeCoderPreview[]): Record<number, CoderMappingDecision> {
  const out: Record<number, CoderMappingDecision> = {}
  for (const c of coders) {
    const d = defaultDecision(c)
    if (d) out[c.original_id] = d
  }
  return out
}

/** The coders still waiting for an answer, in file order. */
export function unansweredCoders(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
): MergeCoderPreview[] {
  return coders.filter(c => !decisions[c.original_id])
}

/**
 * Why the confirm step cannot continue yet, or null. 🔴 Load-bearing, not cosmetic: a
 * coder with no decision is LEFT OUT of the payload, and the server then falls back to its
 * silent rule for them — the step must never send a mapping with a gap in it.
 */
export function confirmBlocker(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
): string | null {
  const open = unansweredCoders(coders, decisions)
  if (open.length === 0) return null
  const names = open.map(c => `“${c.username}”`)
  const list = names.length === 1 ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return open.length === 1
    ? `Choose whether ${list} is a coder already here or a new coder.`
    : `Choose whether ${list} are coders already here or new coders.`
}

/**
 * What the row says about its proposal (#1352): the SAME coder is named as such; a coder
 * who only shares the name is described with what a wrong answer would merge into.
 */
export function matchNote(c: MergeCoderPreview): string | null {
  const m = c.local_match
  if (!m) return null
  if (m.basis === 'identity') {
    return m.username === c.username
      ? `The same coder as “${m.username}” here.`
      : `The same coder as “${m.username}” here — the copy called them “${c.username}”.`
  }
  const n = m.local_app_count
  return `A coder called “${m.username}” is already here, with ${n} coding${n === 1 ? '' : 's'}. `
    + `Choose Map to ${m.username} only if these codings are theirs.`
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
    // 🔴 #1352 — never a gap: the server's silent rule would answer for this coder.
    // `confirmBlocker` holds the step first, so reaching here is a wiring bug.
    if (!d) throw new Error(`No decision for coder ${c.original_id} — confirmBlocker must hold the step`)
    if (d.action === 'match') {
      out[String(c.original_id)] = d.unarchive
        ? { action: 'match', target_user_id: d.target_user_id, unarchive: true }
        : { action: 'match', target_user_id: d.target_user_id }
    } else {
      const renamed = renames[c.original_id]?.trim()
      // #1246 — the field is pre-filled with `create_username` (the numbered name a
      // taken one becomes); sending that unchanged is the server's own choice anyway.
      out[String(c.original_id)] = renamed && renamed !== c.username && renamed !== c.create_username
        ? { action: 'create', new_username: renamed }
        : { action: 'create' }
    }
  }
  return out
}

/**
 * How many distinct PEOPLE the file's codings will span once mapped: each `match`
 * resolves to its target coder id, each `create` is a new distinct coder. Optionally
 * union in coders already known to be present (e.g. a target roster). Drives the
 * single-vs-multi-coder note on the confirm step (#444): the prior check counted only
 * NEW coders, so the default "N file coders → N distinct existing coders" mapping —
 * which preserves multi-coder — was wrongly flagged as single-coder.
 *
 * 🔴 **People only (#1034).** The note says consensus and agreement become available,
 * and a MACHINE coder votes in neither — so a person and a model mapped in read as
 * "consensus + agreement (IRR) stay available" over a project where both are off
 * (`multiHumanCoder`'s rule, #989). A match target has the file coder's kind, because
 * `match_options` offers no other.
 *
 * `existingCoderIds` is the PROJECT's people (#1273: `agreementNote` passes the target's
 * coder coverage — non-archived, non-machine), never the instance-global roster, which
 * would over-claim: a coder on the roster need not have coded this project.
 */
export function resultingCoderCount(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
  existingCoderIds: number[] = [],
): number {
  const ids = new Set<string>(existingCoderIds.map(id => `u:${id}`))
  for (const c of coders) {
    if (isMachineCoder(c)) continue
    const d = decisions[c.original_id]
    if (!d) continue
    ids.add(d.action === 'match' ? `u:${d.target_user_id}` : `new:${c.original_id}`)
  }
  return ids.size
}

/**
 * The coders a merge will ADD, split by kind (#1034): a new PERSON is what turns on
 * consensus and agreement; a new MODEL joins the machine layer and the Model
 * comparison, and turns on nothing. One number for both was the claim that a model
 * "enables consensus + agreement (IRR)".
 */
export function newCoderCounts(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
): { people: number; models: number } {
  let people = 0
  let models = 0
  for (const c of coders) {
    if (decisions[c.original_id]?.action !== 'create') continue
    if (isMachineCoder(c)) models++
    else people++
  }
  return { people, models }
}

/**
 * What the confirm step says when the file coder's name is taken by a coder it may
 * NOT land on (#1034) — so an added coder's suffixed name is explained, not a surprise.
 */
export function nameInUseNote(c: MergeCoderPreview): string | null {
  const n = c.name_in_use
  if (!n) return null
  const self = isMachineCoder(c) ? 'this machine coder' : 'this person'
  if (n.reason === 'configuration') {
    return `A machine coder called “${n.username}” is already here, run with a different `
      + `configuration — two configurations of one model are two coders, so ${self} `
      + `joins as “${n.new_username}”.`
  }
  const holder = n.coder_type === MACHINE_CODER_TYPE ? 'A machine coder' : 'A person'
  return `${holder} called “${n.username}” is already here, and a person and a model `
    + `cannot stand in for each other — so ${self} joins as “${n.new_username}”.`
}

/**
 * #1273 — the one sentence about agreement, decided against the people ALREADY coding the
 * target project (`existingPeopleIds`: its non-archived, non-machine coders, from the
 * project's coder coverage). It said a new person "enables" agreement whenever one was
 * added, including when two people already coded the project. `null` until the coverage
 * answers — absence makes no claim (`list-load-state.md` §6).
 */
export function agreementNote(
  coders: MergeCoderPreview[],
  decisions: Record<number, CoderMappingDecision>,
  existingPeopleIds: number[] | undefined,
): string | null {
  if (existingPeopleIds === undefined) return null
  const before = new Set(existingPeopleIds).size
  const after = resultingCoderCount(coders, decisions, existingPeopleIds)
  const added = newCoderCounts(coders, decisions).people
  if (after < 2) return 'Fewer than two people will have coded this project, so there are no agreement stats yet.'
  if (before >= 2) {
    return added > 0
      ? `${added} more ${added === 1 ? 'person' : 'people'} — consensus + agreement (IRR) are already available here.`
      : 'Every person maps onto someone already here — consensus + agreement (IRR) stay available.'
  }
  return `After this merge ${after} people have coded this project — consensus + agreement (IRR) become available.`
}
