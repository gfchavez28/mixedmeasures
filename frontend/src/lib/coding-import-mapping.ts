import type {
  Coder, CodingImportCoderCandidate, CodingImportDecision, ProjectColumnInfo,
} from '@/lib/api'
import { isMachineCoder } from '@/lib/coding-layers'
import { MATCH_KEY_COLUMN_TYPES } from '@/lib/dataset-constants'
import { provenanceFromDraft, type MachineAccess } from '@/lib/machine-coder'

/**
 * The coding import's mapping step, as data (Batch 6): one draft per name in the
 * file, the decision it becomes, and why it cannot be sent yet.
 *
 * Out of the page so the rules are testable without a Radix `Select`, which jsdom
 * cannot drive — every rule below had been reachable only by clicking.
 */

/** The longest coder name any door accepts (`schemas/auth.py`, `max_length=50`). */
export const CODER_NAME_MAX_LENGTH = 50

export interface CoderDraft {
  action: 'match' | 'create' | 'skip'
  targetUserId: number | null
  /**
   * `match` onto an ARCHIVED coder: bring them back (#1031 c). Pre-set when the
   * name's own match is archived, and whenever an archived coder is picked — the
   * merge's shape — so the choice is visible and one click to undo.
   */
  unarchive: boolean
  newUsername: string
  /**
   * 🔴 `null` until chosen — there is NO default (#1038 h). A coder's kind cannot
   * be changed afterwards, and it decides whether their codings enter
   * reliability at all: defaulting to *A person* made a model's labels a
   * colleague's votes on one missed click, and the other default would do the
   * opposite to a colleague.
   */
  coderType: 'human' | 'ai' | null
  model: string
  access: MachineAccess | ''
  prompt: string
  parameters: string
}

export function initialDraft(candidate: CodingImportCoderCandidate): CoderDraft {
  return {
    // 🔴 A confident local match is PRE-SELECTED but never applied on its own —
    // the researcher still presses Import, which is what makes the mapping a
    // decision rather than a default (the merge's R3 rule).
    // ⚠️ A name with NOTHING to import starts at skip (found by driving): it was
    // asked for a kind, and "create" added an empty coder to the roster — or, on
    // an archived match, brought a coder back for no codings at all.
    action: candidate.rows_to_apply === 0 ? 'skip'
      : candidate.local_user_id != null ? 'match' : 'create',
    targetUserId: candidate.local_user_id,
    unarchive: candidate.local_user_id != null && candidate.local_archived,
    newUsername: candidate.name,
    coderType: null,
    model: '',
    access: '',
    prompt: '',
    parameters: '',
  }
}

/**
 * The mapping step's introduction — true of what `initialDraft` did (#1158).
 *
 * 🔴 It read *"Nothing is matched by name on your behalf"* above a card that had a
 * same-name coder ALREADY CHOSEN, on the screen that exists to get attribution right
 * (provenance, STRATEGY's question 3). The pre-selection is deliberate — pressing
 * Import is what makes it a decision (the merge's R3 rule) — so for 1.5.6 the COPY
 * changes, and whether to drop the default stays open. Counted from `initialDraft`
 * itself, so the sentence cannot disagree with the radios it introduces.
 */
export function mappingIntro(candidates: readonly CodingImportCoderCandidate[]): string {
  const preselected = candidates.filter(c => initialDraft(c).action === 'match').length
  const lead = 'Every name in the file needs an answer.'
  if (preselected === 0) {
    return `${lead} Nothing is matched by name on your behalf — a name that looks like a `
      + 'colleague’s is not evidence that it is theirs.'
  }
  if (preselected === 1) {
    return `${lead} One name is the same as an existing coder’s, so that coder is chosen for `
      + 'it to start with. Check it before you import — a name that looks like a colleague’s '
      + 'is not evidence that the codings are theirs, and pressing Import confirms it.'
  }
  return `${lead} ${preselected} names are the same as existing coders’, so those coders are `
    + 'chosen for them to start with. Check each one before you import — a name that looks '
    + 'like a colleague’s is not evidence that the codings are theirs, and pressing Import '
    + 'confirms each choice.'
}

/** The draft → the payload. Call only once `draftBlocker` is null. */
export function toDecision(draft: CoderDraft): CodingImportDecision {
  if (draft.action === 'skip') return { action: 'skip' }
  if (draft.action === 'match') {
    return {
      action: 'match',
      target_user_id: draft.targetUserId,
      ...(draft.unarchive ? { unarchive: true } : {}),
    }
  }
  const coderType = draft.coderType ?? 'human'
  return {
    action: 'create',
    new_username: draft.newUsername.trim() || undefined,
    coder_type: coderType,
    // #1006 — the ONE draft → provenance builder the machine-coder dialog uses too.
    machine_provenance: coderType === 'ai' ? provenanceFromDraft(draft) : null,
  }
}

/** The name a `create` will use — the typed one, else the file's. */
export function effectiveNewName(name: string, draft: CoderDraft): string {
  return draft.newUsername.trim() || name
}

/**
 * Why this name's row cannot be imported yet, in words — or null.
 *
 * Each is something the server would refuse or silently default, said BEFORE the
 * request: the Import button is off, and the reason is on screen beside it and in
 * its description (the upload step's `previewBlocker` shape).
 */
export function draftBlocker(name: string, draft: CoderDraft): string | null {
  if (draft.action === 'match' && draft.targetUserId == null) {
    return `Choose which coder “${name}” is.`
  }
  if (draft.action === 'create') {
    if (draft.coderType == null) {
      // #1164 (e) — the radios this answers read *A person* / *A machine*.
      return `Say whether “${name}” is a person or a machine.`
    }
    if (effectiveNewName(name, draft).length > CODER_NAME_MAX_LENGTH) {
      return `The new coder’s name for “${shorten(name)}” is longer than ${CODER_NAME_MAX_LENGTH} characters.`
    }
  }
  return null
}

function shorten(name: string): string {
  return name.length > 30 ? `${name.slice(0, 30)}…` : name
}

/**
 * Which coder a draft lands on, as a key two drafts can share — or null for a skip
 * or an unfinished match. A `create` lands on the coder its NEW NAME makes (#1082 b):
 * the server creates one coder per name, so two names typed alike are one coder.
 */
function landingKey(name: string, draft: CoderDraft): string | null {
  if (draft.action === 'match') {
    return draft.targetUserId == null ? null : `match:${draft.targetUserId}`
  }
  if (draft.action === 'create') return `create:${effectiveNewName(name, draft)}`
  return null
}

/**
 * Names that land on ONE coder — `name → the other names` (#1039 i, #1082 b).
 *
 * Matched onto one existing coder, or created under one new name. Legitimate
 * ("Alice" and "Alice Smith" are one person), and the server judges their rows
 * together, so a passage they disagree about imports neither. The page says so
 * beside each row rather than letting the result screen be the first word.
 */
export function namesSharingACoder(drafts: Record<string, CoderDraft>): Map<string, string[]> {
  const byLanding = new Map<string, string[]>()
  for (const [name, draft] of Object.entries(drafts)) {
    const key = landingKey(name, draft)
    if (key == null) continue
    byLanding.set(key, [...(byLanding.get(key) ?? []), name])
  }
  const out = new Map<string, string[]>()
  for (const names of byLanding.values()) {
    if (names.length < 2) continue
    for (const name of names) out.set(name, names.filter(n => n !== name))
  }
  return out
}

/**
 * Why names created under ONE new name cannot be one coder — or nothing (#1082 b).
 *
 * The server makes them one coder only when they agree on what it IS: a person and a
 * model, or two model configurations, are different coders (`machine_coder.py`), and
 * it refuses the pair naming both. Said here first, as an Import blocker. A name whose
 * kind is not chosen yet is left to its own blocker (`draftBlocker`).
 */
export function sharedCreateConflicts(drafts: Record<string, CoderDraft>): string[] {
  const groups = new Map<string, string[]>()
  for (const [name, draft] of Object.entries(drafts)) {
    if (draft.action !== 'create') continue
    const newName = effectiveNewName(name, draft)
    groups.set(newName, [...(groups.get(newName) ?? []), name])
  }
  const out: string[] = []
  for (const [newName, names] of groups) {
    if (names.length < 2) continue
    const chosen = names.filter(n => drafts[n].coderType != null)
    const [first, ...rest] = [...chosen].sort()
    if (first === undefined) continue
    const other = rest.find(n => drafts[n].coderType !== drafts[first].coderType)
    if (other !== undefined) {
      out.push(`“${first}” and “${other}” are both to become a new coder called “${newName}”, `
        + 'but one is a person and the other a machine. Give them different names.')
      continue
    }
    if (drafts[first].coderType === 'ai') {
      const config = (n: string) => JSON.stringify(provenanceFromDraft(drafts[n]))
      const differs = rest.find(n => config(n) !== config(first))
      if (differs !== undefined) {
        out.push(`“${first}” and “${differs}” are both to become a new model called “${newName}”, `
          + 'with different model configurations — two configurations of one model are two '
          + 'coders. Give them different names, or the same configuration.')
      }
    }
  }
  return out
}

/**
 * What a new coder will really be called when its name is TAKEN — or null (#1082 b).
 *
 * The server adds a number (`unique_username`: "Alice (2)", "Alice (3)", …), which the
 * page never said, so a researcher who typed a colleague's name got a second coder and
 * did not know it. Predicted from the roster the picker already holds.
 * ⚠️ The roster lists people and models, not the two system layers, so a new coder
 * named "Consensus" or "Unattributed" is numbered without this saying so.
 */
export function takenNameSuffix(newName: string, roster: readonly Coder[]): string | null {
  const taken = new Set(roster.map(c => c.username))
  if (!taken.has(newName)) return null
  let n = 2
  while (taken.has(`${newName} (${n})`)) n += 1
  return `${newName} (${n})`
}

/**
 * How many of the file's importable ROWS the current decisions will send (#1099).
 *
 * The button read the PLAN's count (`will_apply`), which is decided before any
 * coder decision, so a 10-row file with two names set to *Do not import* read
 * "Import 10 codings" and added 6. A name's `rows_to_apply` is its share of
 * `will_apply` — rows that are not importable anyway are already out of both —
 * so a skipped name takes exactly that many away.
 *
 * ⚠️ **ROWS, not codings.** A row on a grouped passage writes one coding per
 * sibling, and a row the coder already holds writes none, so a coding count is
 * only known after the import (its finished screen says it). And when two names
 * go to one coder this is an UPPER bound — the server judges their rows together
 * and may refuse a passage they disagree about (`upToBound`).
 */
export function rowsToImport(
  candidates: readonly CodingImportCoderCandidate[],
  willApply: number,
  drafts: Record<string, CoderDraft>,
): { rows: number; skippedRows: number; upToBound: boolean } {
  const skippedRows = candidates
    .filter(c => drafts[c.name]?.action === 'skip')
    .reduce((n, c) => n + c.rows_to_apply, 0)
  return {
    rows: Math.max(0, willApply - skippedRows),
    skippedRows,
    upToBound: namesSharingACoder(drafts).size > 0,
  }
}

/** How a roster coder is described in the picker: name, kind, archived. */
export function coderOptionLabel(coder: Coder): string {
  return coder.username
    + (isMachineCoder(coder) ? ' · model' : '')
    + (coder.archived ? ' (archived)' : '')
}

/** What a column's type is called in the id picker. */
const MATCH_KEY_TYPE_LABEL: Record<string, string> = {
  identifier: 'identifier',
  numeric: 'number',
  open_text: 'text',
  nominal: 'category',
}

export interface MatchKeyOption {
  id: number
  label: string
}

/**
 * The columns that can hold the file's ids — the CODED column's dataset only
 * (#1032 a/b), key-shaped types only, the coded column itself excluded, and the
 * identifiers first. The server refuses a column from any other dataset.
 */
export function matchKeyOptions(
  columns: readonly ProjectColumnInfo[],
  codedColumnId: number | null,
): MatchKeyOption[] {
  if (codedColumnId == null) return []
  const coded = columns.find(c => c.id === codedColumnId)
  if (!coded) return []
  return columns
    .filter(c =>
      c.dataset_id === coded.dataset_id
      && c.id !== codedColumnId
      && MATCH_KEY_COLUMN_TYPES.includes(c.column_type),
    )
    .sort((a, b) =>
      Number(b.column_type === 'identifier') - Number(a.column_type === 'identifier'))
    .map(c => ({
      id: c.id,
      label: `${c.column_name ?? c.column_text} · ${MATCH_KEY_TYPE_LABEL[c.column_type] ?? c.column_type}`,
    }))
}
