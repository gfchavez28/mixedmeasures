/**
 * #584's death arm — the re-key plan's status vocabulary, and what may be acted on.
 *
 * Mirrors `services/recode_rekey.py`'s `STATUS_*`. Split out of the dialog for
 * the reason `rederive-status.ts` is: a predicate deciding whether a control may
 * rewrite a definition is not a rendering detail.
 *
 * ⚠️ **There is no `no_change` here, unlike the re-derive arm.** The population
 * is definitions that already match NOTHING, so every row is either translatable
 * or refused — a distinction worth keeping in the type rather than assuming the
 * two vocabularies stay the same shape.
 */

export const STATUS_READY = 'ready'
export const STATUS_BLOCKED = 'blocked'

/**
 * Only a `ready` row may be selected.
 *
 * ⚠️ An allow-list on purpose, same as `rederive-status.ts`: a status the
 * backend adds later defaults to NOT selectable, which is the safe direction.
 */
export function isSelectable(item: { status: string }): boolean {
  return item.status === STATUS_READY
}
