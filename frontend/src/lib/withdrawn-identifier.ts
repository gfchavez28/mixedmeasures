/**
 * #1190 (D12) — creating a participant whose ID belongs to someone who WITHDREW.
 *
 * A withdrawal leaves a record of the person's identifier (`services/tombstones.py`),
 * and `POST /projects/{id}/participants` refuses that identifier with a **409 whose
 * `detail` is `{ error: 'withdrawn_identifier', message }`** — one sentence, no name —
 * unless the body says `confirm_withdrawn: true`. The grid's create is ONE click, so the
 * override must be a decision the researcher makes having read the server's sentence,
 * never a retry the client makes for them.
 *
 * This is the one place that recognises the refusal and runs the ask-then-retry, so
 * every create caller behaves the same (the Participants page's form and the Data
 * grid's *New participant from this row*). The dialog is
 * `hooks/useWithdrawnIdentifierConfirm.tsx`.
 *
 * 🔴 **Any OTHER 409 is not this one and is rethrown untouched** — a duplicate
 * identifier is still a 409 with a STRING detail, and the grid turns that into "link to
 * the existing participant". Folding the two together would link a researcher to a
 * participant who does not exist, or re-create a withdrawn person silently.
 *
 * ⚠️ Duck-typed on `status` and `response.data.detail`, like `serverDetailMessage`:
 * callers' tests build the error as a plain object, and importing `@/lib/api` here would
 * tie every caller's API mock to this module.
 */

export const WITHDRAWN_IDENTIFIER_ERROR = 'withdrawn_identifier'

export const WITHDRAWN_CONFIRM_TITLE = 'Add a participant who withdrew?'
export const WITHDRAWN_CONFIRM_LABEL = 'Create anyway'

/** What the dialog says for one ask: a create (the default) or a rename. */
export interface WithdrawnConfirmWording {
  title: string
  confirmLabel: string
}

/** `PATCH /participants/{id}` refuses a RENAME to a withdrawn person's ID the same way
 *  (same 409 body, `confirm_withdrawn` on the update), so the same helper runs it — but
 *  "Create anyway" would name an act the researcher is not taking. */
export const WITHDRAWN_RENAME_WORDING: WithdrawnConfirmWording = {
  title: 'Rename to the ID of a participant who withdrew?',
  confirmLabel: 'Rename anyway',
}

/** Said if the server named the refusal but sent no sentence — never expected. */
export const WITHDRAWN_FALLBACK_MESSAGE =
  'This ID belongs to a participant who withdrew from this project.'

/**
 * The server's sentence when `err` is the withdrawn-identifier refusal, else null.
 * Only a 409 qualifies, and only one whose `detail.error` names this refusal.
 */
export function withdrawnIdentifierMessage(err: unknown): string | null {
  const e = err as { status?: unknown; response?: { status?: unknown; data?: { detail?: unknown } } } | null
  const status = e?.status ?? e?.response?.status
  if (status !== 409) return null
  const detail = e?.response?.data?.detail
  if (!detail || typeof detail !== 'object') return null
  if ((detail as { error?: unknown }).error !== WITHDRAWN_IDENTIFIER_ERROR) return null
  const message = (detail as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message : WITHDRAWN_FALLBACK_MESSAGE
}

/**
 * Create, and on the withdrawn-identifier refusal ASK, then create again with the
 * override only if the researcher said yes.
 *
 * - `create(false)` is the ordinary request — the caller sends no `confirm_withdrawn`
 *   key at all; `create(true)` adds `confirm_withdrawn: true`.
 * - Resolves to the created entity, or `null` when the researcher declined (nothing was
 *   created; the caller leaves its form or picker as it was).
 * - Any other failure — of either request — is thrown as it came.
 */
export async function createConfirmingWithdrawn<T>(
  create: (confirmWithdrawn: boolean) => Promise<T>,
  ask: (message: string) => Promise<boolean>,
): Promise<T | null> {
  try {
    return await create(false)
  } catch (err) {
    const message = withdrawnIdentifierMessage(err)
    if (message === null) throw err
    if (!(await ask(message))) return null
    return create(true)
  }
}
