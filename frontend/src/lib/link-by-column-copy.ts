import type { ParticipantLinkReport } from '@/lib/api'
import { isRequestTimeout, serverDetailMessage } from '@/lib/api'
import { plural } from '@/lib/format'

/**
 * What Link by column will do, said BEFORE it does it (#1054 review §4 #11, D6).
 *
 * One click could create a participant per record — 122,382 on BES — and undoing
 * that is a delete per participant. The server plans the link without writing it
 * (`POST …/link-by-column/preview`, the same plan the act writes), and these
 * sentences are what the confirmation says about that plan. Future tense; the
 * past-tense report after the act is `components/ParticipantLinkNote`.
 */

const n = (count: number) => count.toLocaleString()

function records(count: number) {
  return `${n(count)} ${plural(count, 'record', 'records')}`
}

/**
 * #1190 — records whose ID belongs to a participant who WITHDREW from this project. The
 * server never links them and never creates a participant for them (the withdrawal's
 * tombstone). `?? 0`: a server that predates the field sends none.
 */
export function skippedWithdrawn(plan: ParticipantLinkReport): number {
  return plan.skipped_withdrawn ?? 0
}

/** The past-tense sentence after a link or an import (`components/ParticipantLinkNote`). */
export function withdrawnLinkSentence(count: number): string {
  return `${records(count)} ${plural(count, 'carries', 'carry')} the ID of a participant who `
    + `withdrew from this project, so ${plural(count, 'it was', 'they were')} not linked and no `
    + 'participant was created.'
}

/** Every record the plan leaves unlinked, for a reason the sentences name. */
function staying(plan: ParticipantLinkReport): number {
  return plan.skipped_duplicate + plan.skipped_missing + plan.skipped_conflict + skippedWithdrawn(plan)
}

/** The confirmation's main sentence. Only for a plan that links something. */
export function linkPreviewSentence(plan: ParticipantLinkReport, columnLabel: string): string {
  const from = `the IDs in “${columnLabel}”`
  if (plan.created > 0 && plan.matched > 0) {
    return `This will link ${records(plan.linked)} to participants by ${from}: `
      + `${n(plan.matched)} to ${plural(plan.matched, 'a participant', 'participants')} already in this project, `
      + `and ${n(plan.created)} to new ${plural(plan.created, 'participant', 'participants')} created from ${plural(plan.created, 'its ID', 'their IDs')}.`
  }
  if (plan.created > 0) {
    return `This will create ${n(plan.created)} new ${plural(plan.created, 'participant', 'participants')} from ${from} `
      + `and link each record to one.`
  }
  return `This will link ${records(plan.matched)} to ${plural(plan.matched, 'a participant', 'participants')} `
    + `already in this project, by ${from}.`
}

/** The sentences under it: what stays unlinked and why, and what cannot be undone. */
export function linkPreviewDetails(plan: ParticipantLinkReport): string[] {
  const out: string[] = []
  const reasons: string[] = []
  if (plan.skipped_duplicate > 0) {
    const examples = plan.duplicate_values.slice(0, 3).join(', ')
    reasons.push(`${n(plan.skipped_duplicate)} with an ID that appears more than once${examples ? ` (${examples})` : ''}`)
  }
  if (plan.skipped_missing > 0) reasons.push(`${n(plan.skipped_missing)} with a blank or N/A ID`)
  if (plan.skipped_conflict > 0) {
    reasons.push(`${n(plan.skipped_conflict)} whose participant is already linked to another record`)
  }
  // #1190 — counted, never named: the ID is the withdrawn person's.
  const withdrawn = skippedWithdrawn(plan)
  if (withdrawn > 0) {
    reasons.push(`${n(withdrawn)} with the ID of a participant who withdrew from this project (no participant is created for ${plural(withdrawn, 'it', 'them')})`)
  }
  if (reasons.length > 0) {
    out.push(`${records(staying(plan))} will stay unlinked: ${reasons.join('; ')}.`)
  }
  if (plan.already_linked > 0) {
    out.push(`${records(plan.already_linked)} ${plural(plan.already_linked, 'is', 'are')} already linked and will not change.`)
  }
  if (plan.created > 0) {
    out.push('There is no undo: a participant created here is removed by deleting it on the Participants page.')
  }
  return out
}

/** Why there is nothing to confirm. */
export function linkNothingToDoSentence(plan: ParticipantLinkReport): string {
  const stay = staying(plan)
  if (stay === 0) return 'Every record is already linked to a participant — there is nothing to link.'
  // #1190 — a withdrawn person's ID is a reason too, or "every record is already
  // linked" / "a blank or duplicated ID" would be said of records that are neither.
  const withdrawn = skippedWithdrawn(plan) > 0 ? ', or the ID of a participant who withdrew' : ''
  return `No record can be linked: ${records(stay)} ${plural(stay, 'has', 'have')} a blank, duplicated or already-linked ID${withdrawn}.`
}

/**
 * A link that did not answer or was refused. The server's own sentence when it gave one.
 *
 * #1231: an answer with no sentence (a plain-text 500) is NOT "could not be linked" —
 * the link commits in batches, so one that fails part-way has linked everything before
 * the failure (measured: 5,000 of 12,000). The server now answers a stop after a commit
 * with a 409 and the count, so this arm is what is left: an error before the first
 * batch committed (#1231's D14 keeps a lock there a 500). "May" is true of it, and of any
 * failure the server could not put in words.
 */
export function linkFailureSentence(err: unknown): string {
  const server = serverDetailMessage(err)
  if (server) return server
  if (isRequestTimeout(err) || (err as { status?: unknown } | null)?.status === undefined) {
    return 'Mixed Measures did not answer, so whether the link finished is not known. '
      + 'The data has been refreshed: a record that shows a participant was linked. '
      + 'Running Link by column again finishes the rest.'
  }
  return 'Linking stopped with an error, so some records may already be linked. '
    + 'The data has been refreshed: a record that shows a participant was linked. '
    + 'Running Link by column again finishes the rest.'
}
