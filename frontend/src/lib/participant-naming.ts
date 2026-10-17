import { isUnnamedLabel } from '@/lib/conversation-import-utils'

/**
 * #1139 — how the Participants page's two confirmations, and the toast after a
 * withdrawal, name the person they act on.
 *
 * They named the IDENTIFIER alone: you clicked the row reading "Amara Okafor" and
 * the dialog asked "Remove E-01's data?" (the toast: "E-01 removed"), and the
 * delete confirm's title, "Delete Participant", named nobody (CONFIRMED live,
 * Batch 4 review r4 G2). On an irreversible act taken for a real person's request
 * the name the researcher clicked is what they check against — and the identifier
 * stays beside it, because two people can share a display name (an import names
 * participants from its speakers and records) and only the identifier is unique.
 *
 * Built from the record's own two fields — STABLE, never a value being edited or
 * a state that changes while the dialog is open (#770): the page takes them from
 * the row when the dialog opens.
 */
export interface ParticipantNaming {
  identifier: string
  display_name: string | null
}

/** The name the table shows them by: a real display name, else the identifier
 *  (#396 — an imported "..." placeholder is no name). */
export function participantName(p: ParticipantNaming): string {
  return p.display_name !== null && !isUnnamedLabel(p.display_name) ? p.display_name : p.identifier
}

/** " (E-01)" when the name is not already the identifier, else nothing. */
function identifierSuffix(p: ParticipantNaming): string {
  return participantName(p) === p.identifier ? '' : ` (${p.identifier})`
}

/** "Amara Okafor (E-01)", or "E-01" for a participant with no display name. */
export function participantNameWithId(p: ParticipantNaming): string {
  return `${participantName(p)}${identifierSuffix(p)}`
}

/** The withdrawal confirm's title: "Remove Amara Okafor’s data? (E-01)". */
export function withdrawConfirmTitle(p: ParticipantNaming): string {
  return `Remove ${participantName(p)}’s data?${identifierSuffix(p)}`
}

/** The delete confirm's title: "Delete Amara Okafor’s record? (E-01)". */
export function deleteConfirmTitle(p: ParticipantNaming): string {
  return `Delete ${participantName(p)}’s record?${identifierSuffix(p)}`
}
