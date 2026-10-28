// #1321 — what the project list's import dialog decides when NO local project shares the
// file's identity: keep it (a coding copy, mergeable with the project it came from) or
// re-mint it (an independent project). And, for a copy that keeps it, D2: WHICH of the
// file's people is the researcher importing it. Pure, so the dialog's question, its gate
// and the payload it sends are unit-tested apart from the page.

import type { CoderMapping, ImportValidationResult, MergeCoderPreview } from './api'

/**
 * The file can be imported KEEPING its identity: it carries one, and no project here has
 * it (with a local copy the dialog offers Merge / Overwrite / new instead). The server
 * refuses a file from before the per-entity uuids (v1.0.x) with its own sentence.
 */
export function canKeepIdentity(v: ImportValidationResult): boolean {
  return v.existing_project == null && !!v.manifest?.project_uuid
}

/**
 * The stored `coder_type` of a PERSON. The server normalizes every coder's kind (#989) to
 * one of four (`backend/app/auth.py`: human · ai · unattributed · consensus) and leaves the
 * two system kinds out of this preview, so the positive test is the narrow one: a kind
 * this file does not know is NOT asked about, and that coder takes the server's no-answer
 * rule (a new coder) — never a false "this is me".
 */
const PERSON_CODER_TYPE = 'human'

/** The researcher's answer to "which of these people is you?" — `null` is unanswered. */
export type WhoIsYou = { kind: 'person'; originalId: number } | { kind: 'none' }

/**
 * 🔴 D2 (#1321 / #1352) — the file's people the question lists: PEOPLE (not a machine; the
 * server already leaves "Unattributed" and the consensus layer out of the preview) who
 * CODED something in the file, and whom this install does not already know by IDENTITY
 * (`local_match.basis === 'identity'` — the same coder, who needs no answer). A coder whose
 * only link to someone here is a shared NAME is listed: a name never answers it (every
 * install's first coder is "Researcher"). In file order.
 */
export function codingCopyCandidates(
  fileCoders: MergeCoderPreview[] | null | undefined,
): MergeCoderPreview[] {
  if (!fileCoders) return []
  return fileCoders.filter(c =>
    c.coder_type === PERSON_CODER_TYPE
    && c.file_app_count > 0
    && c.local_match?.basis !== 'identity',
  )
}

/**
 * Whether the dialog asks at all. Skipped when nobody is listed, and when some coder in
 * the file IS the active coder by identity (`{basis: 'identity', id: <you>}` — you made
 * this file, or an earlier import brought you here): you are already identified, so no
 * one else in the file can be you. Also skipped with no active coder known — there is no
 * one to map an answer onto, and the server's no-answer rule (each file person a coder of
 * their own) is the safe outcome; the dialog is reached only signed in.
 */
export function shouldAskWhoYouAre(
  fileCoders: MergeCoderPreview[] | null | undefined,
  activeCoderId: number | null | undefined,
): boolean {
  if (activeCoderId == null) return false
  if (codingCopyCandidates(fileCoders).length === 0) return false
  return !(fileCoders ?? []).some(c =>
    c.local_match?.basis === 'identity' && c.local_match.id === activeCoderId,
  )
}

/**
 * The `coder_mapping` a coding copy sends: AT MOST ONE entry — the person chosen as you,
 * matched onto the active coder (`useAuth().user`; switching coder re-points the
 * session). "None of them", an unasked question, or an answer naming nobody the question
 * lists sends NO mapping, so every file coder takes the server's no-answer rule: identity
 * first, then — in a coding copy — never by name (a new coder, numbered if the name is
 * taken).
 */
export function codingCopyMapping(
  fileCoders: MergeCoderPreview[] | null | undefined,
  activeCoderId: number | null | undefined,
  answer: WhoIsYou | null,
): CoderMapping | undefined {
  if (activeCoderId == null || answer?.kind !== 'person') return undefined
  if (!shouldAskWhoYouAre(fileCoders, activeCoderId)) return undefined
  const chosen = codingCopyCandidates(fileCoders).find(c => c.original_id === answer.originalId)
  if (!chosen) return undefined
  return { [String(chosen.original_id)]: { action: 'match', target_user_id: activeCoderId } }
}

/**
 * Why *Import* (the copy that keeps the identity) cannot run yet, or null. The answer is
 * REQUIRED when the question is asked: an unanswered question would send no mapping, and
 * the researcher's own earlier coding would arrive as somebody else's.
 */
export function whoIsYouBlocker(asked: boolean, answer: WhoIsYou | null): string | null {
  return asked && answer === null
    ? 'Choose which of these people is you, or None of them, before importing.'
    : null
}
