import type { MergeReport } from '@/lib/api'
import { plural } from '@/lib/format'

/**
 * What the Merge page's report step says the merge DID — its rows and the sentences
 * under them. Pure, so the zero / non-zero rule of each row is testable without the
 * page (`MergeProject.tsx::ReportStep` renders it).
 *
 * The first eight rows always show, as they did. Every row after them is shown only
 * when it is not zero, so a project without rating scales, or without a withdrawal,
 * never meets the row.
 *
 * 🔴 #1190 — a withdrawn person is COUNTED, never named: the report reaches the
 * screen and any screenshot of it, and the name is exactly what the withdrawal
 * removed.
 */
export type MergeReportRow = [label: string, count: number]

/** A count that is shown only when there is something to show; `undefined` (a server
 *  that predates the field) is none. */
const some = (n: number | undefined): n is number => n !== undefined && n > 0

export function mergeReportRows(report: MergeReport): MergeReportRow[] {
  const rows: MergeReportRow[] = [
    ['Codings added', report.applications_added],
    ['Duplicate codings skipped', report.duplicates_skipped],
    ['Shared sources matched', report.sources_matched],
    ['Coders matched', report.coders_matched],
    ['New coders added', report.coders_created],
    ['Codes added', report.codes_created],
    ['Codes linked', report.codes_linked],
    ['Codes folded in', report.codes_collapsed],
  ]
  // #35 — the merge kept this project's ratings; the differences wait in Reconciliation.
  if (some(report.magnitude_conflicts)) {
    rows.push(['Rating differences flagged for reconciliation', report.magnitude_conflicts])
  }
  // #869 (c): a colleague's rating that does not fit the code's scale here arrives
  // unrated, with the number kept as a merge difference to adjudicate.
  if (some(report.ratings_out_of_range)) {
    rows.push(['Ratings outside a code’s scale, kept as differences', report.ratings_out_of_range])
  }
  // #1190 — what the file still held of someone who withdrew from this project.
  if (some(report.withdrawn_participants_skipped)) {
    rows.push(['Participants who withdrew, left out', report.withdrawn_participants_skipped])
  }
  if (some(report.withdrawn_items_skipped)) {
    rows.push(['Their records, speakers, quotes and notes, left out', report.withdrawn_items_skipped])
  }
  // #1190 (D13) — re-inserted WITHOUT a link; `mergeReportNotes` says why.
  if (some(report.records_reinserted_unlinked)) {
    rows.push(['Records added without a participant link', report.records_reinserted_unlinked])
  }
  return rows
}

/**
 * The sentences under the rows, for the two #1190 outcomes a number alone does not
 * explain. Empty when neither happened.
 */
export function mergeReportNotes(report: MergeReport): string[] {
  const out: string[] = []
  const people = report.withdrawn_participants_skipped
  if (some(people)) {
    out.push(
      `The file held ${people.toLocaleString()} ${plural(people, 'participant', 'participants')} `
      + 'who withdrew from this project; nothing of theirs was brought back.',
    )
  }
  const unlinked = report.records_reinserted_unlinked
  if (some(unlinked)) {
    const one = unlinked === 1
    out.push(
      `${unlinked.toLocaleString()} ${plural(unlinked, 'record', 'records')} from the file `
      + `${one ? 'is' : 'are'} not in this project, and ${one ? 'its participant is' : 'their participants are'} `
      + 'now linked to another record of the same dataset, so '
      + `${one ? 'it was' : 'they were'} added without a link. `
      + `If you deleted ${one ? 'it' : 'them'} on purpose, delete ${one ? 'it' : 'them'} again in that dataset.`,
    )
  }
  return out
}
