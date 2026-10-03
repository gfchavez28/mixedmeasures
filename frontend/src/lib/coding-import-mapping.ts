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
      return `Say whether “${name}” is a person or a model.`
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
 * Names mapped onto ONE existing coder — `name → the other names` (#1039 i).
 *
 * Legitimate ("Alice" and "Alice Smith" are one person), and the server now judges
 * their rows together, so a passage they disagree about imports neither. The page
 * says so beside each row rather than letting the result screen be the first word.
 */
export function namesSharingACoder(drafts: Record<string, CoderDraft>): Map<string, string[]> {
  const byTarget = new Map<number, string[]>()
  for (const [name, draft] of Object.entries(drafts)) {
    if (draft.action !== 'match' || draft.targetUserId == null) continue
    byTarget.set(draft.targetUserId, [...(byTarget.get(draft.targetUserId) ?? []), name])
  }
  const out = new Map<string, string[]>()
  for (const names of byTarget.values()) {
    if (names.length < 2) continue
    for (const name of names) out.set(name, names.filter(n => n !== name))
  }
  return out
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
