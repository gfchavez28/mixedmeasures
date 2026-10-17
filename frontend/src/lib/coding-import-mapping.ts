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
  /**
   * 🔴 `null` = not answered yet (#1193). A name that is the same as an existing
   * coder's starts here — never at `match` — and Import waits for the answer.
   */
  action: 'match' | 'create' | 'skip' | null
  /**
   * The coder a `match` lands on. Pre-set to the same-name coder when one exists,
   * so choosing *An existing coder* is one click — but nothing is chosen until then.
   */
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
    // 🔴 #1193 (decided 2026-10-13) — a same-name coder is NOT pre-selected. It was
    // (the merge's R3 rule, "pressing Import confirms it"), and every install's
    // default coder is called "Researcher", so a colleague's file chose the
    // importing researcher's OWN coder — and a wrong match replaces that coder's
    // code-set values and ratings, with no safety copy on this path. The name
    // starts unanswered; the same-name coder is one click away (`targetUserId`).
    // ⚠️ A name with NOTHING to import starts at skip (found by driving): it was
    // asked for a kind, and "create" added an empty coder to the roster — or, on
    // an archived match, brought a coder back for no codings at all.
    action: candidate.rows_to_apply === 0 ? 'skip'
      : candidate.local_user_id != null ? null : 'create',
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
 * The mapping step's introduction (#1158, #1193).
 *
 * #1158 shipped the copy route in 1.5.6: the page pre-selected a same-name coder
 * under *"Nothing is matched by name on your behalf"*, so the sentence was
 * counted from `initialDraft` to say what it had chosen. #1193 dropped the
 * pre-selection itself, which makes the original sentence TRUE again — and
 * `initialDraft` never starts a name at `match` (pinned by its test), so there is
 * nothing left to count.
 */
export const MAPPING_INTRO =
  'Every name in the file needs an answer. Nothing is matched by name on your behalf — '
  + 'a name that looks like a colleague’s is not evidence that the codings are theirs.'

/** The draft → the payload. Call only once `draftBlocker` is null. */
export function toDecision(draft: CoderDraft): CodingImportDecision {
  if (draft.action === null) {
    // `draftBlocker` refuses an unanswered name first, so this is a wiring bug.
    throw new Error('toDecision: this name has not been answered')
  }
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
  if (draft.action === null) {
    // #1193 — the radios this answers read *An existing coder* / *A new coder* /
    // *Do not import these*.
    return `Choose whether “${name}” is an existing coder, a new coder, or not imported.`
  }
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
      const config = (n: string) => canonicalJson(provenanceFromDraft(drafts[n]))
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
 *
 * 🔴 **`typedNewNames` — every name typed for a NEW coder on this page (#1150 c).** The
 * server reserves them all before numbering any (`coding_import.resolve_coders`, the
 * `.mmproject` merge's #1071 rule), so "Alice" skips "Alice (3)" when another card typed
 * it. This card's own name is not reserved against itself, as the server's is not.
 */
export function takenNameSuffix(
  newName: string, roster: readonly Coder[], typedNewNames: ReadonlySet<string> = new Set(),
): string | null {
  const taken = new Set(roster.map(c => c.username))
  if (!taken.has(newName)) return null
  const unavailable = (name: string) => taken.has(name) || (name !== newName && typedNewNames.has(name))
  let n = 2
  while (unavailable(`${newName} (${n})`)) n += 1
  return `${newName} (${n})`
}

/** The names typed for a NEW coder across the page — what `takenNameSuffix` reserves. */
export function typedNewCoderNames(drafts: Record<string, CoderDraft>): Set<string> {
  return new Set(
    Object.entries(drafts)
      .filter(([, draft]) => draft.action === 'create')
      .map(([name, draft]) => effectiveNewName(name, draft)),
  )
}

/**
 * A value as JSON with every object's keys SORTED, recursively — so two configurations
 * compare as the server compares them (dicts, #1150 b). `parseParameters` keeps the
 * order a researcher typed, and `JSON.stringify` keeps it too.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
      : v)
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
