import type { WithdrawalReport } from '@/lib/api/participants'

/**
 * Copy for the withdrawal report — #702(2).
 *
 * Pure and single-sourced for the `lib/missing-values-copy.ts` reason: two
 * surfaces say this (the detail panel and the delete confirm) and they must not
 * drift, because the whole point is that the app currently says the reassuring
 * half at the moment the decision is made.
 *
 * 🔴 **What the delete confirm said before this: "Speaker links will be
 * removed."** True, and it reads as tidy-up. What actually happens is that the
 * transcript survives verbatim, the speaker NAME survives independently, the
 * responses survive unlinked — and the link a researcher would use to find any
 * of it is destroyed. A researcher honouring a withdrawal request read that
 * sentence and had every reason to think they were done.
 */

const n = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** Per-source lines: where the data actually is. */
export function withdrawalLocations(report: WithdrawalReport): string[] {
  const lines: string[] = []
  for (const c of report.conversations) {
    const parts = [n(c.segments, 'turn')]
    if (c.code_applications) parts.push(n(c.code_applications, 'code'))
    if (c.excerpts) parts.push(n(c.excerpts, 'quote'))
    if (c.notes) parts.push(n(c.notes, 'note'))
    lines.push(`${c.name} — ${parts.join(', ')}`)
  }
  for (const d of report.datasets) {
    const parts = [n(d.responses, 'response')]
    if (d.code_applications) parts.push(n(d.code_applications, 'code'))
    if (d.excerpts) parts.push(n(d.excerpts, 'quote'))
    if (d.notes) parts.push(n(d.notes, 'note'))
    if (d.memos) parts.push(n(d.memos, 'memo'))
    if (d.row_scores) parts.push(n(d.row_scores, 'computed score'))
    lines.push(`${d.name} — ${parts.join(', ')}`)
  }
  return lines
}

/**
 * What deleting this participant record does NOT do.
 *
 * ⚠️ Names the SURVIVING data, not the removed link. "Speaker links will be
 * removed" is the same fact stated so that it sounds like completion.
 */
export function describeDeleteConsequence(report: WithdrawalReport | null): string {
  if (!report) {
    return 'Deleting a participant removes only the participant record. Their transcript '
      + 'turns, responses and speaker name remain in the project, no longer linked to anyone.'
  }
  const turns = report.conversations.reduce((t, c) => t + c.segments, 0)
  const responses = report.datasets.reduce((t, d) => t + d.responses, 0)

  const survives: string[] = []
  if (turns) survives.push(n(turns, 'transcript turn'))
  if (responses) survives.push(n(responses, 'survey response'))
  if (report.speaker_names.length) {
    survives.push(`the speaker name ${report.speaker_names.map(s => `"${s}"`).join(' / ')}`)
  }

  if (survives.length === 0) {
    return 'This participant has no linked transcript turns or responses, so deleting the '
      + 'record removes the record only.'
  }
  const list = survives.length === 1
    ? survives[0]
    : `${survives.slice(0, -1).join(', ')} and ${survives[survives.length - 1]}`

  return `This removes the participant record only — ${list} `
    + `${survives.length === 1 && !survives[0].startsWith('the') ? 'remains' : 'remain'} `
    + 'in the project, no longer linked to anyone. Deleting the record first makes a '
    + 'withdrawal request HARDER to honour, because it destroys the link used to find '
    + 'their data.'
}

/**
 * The one-line headline for the report panel.
 *
 * Counts the participant record itself, so the number matches what the delete
 * button is about to act on.
 */
export function withdrawalHeadline(report: WithdrawalReport): string {
  const sources = report.conversations.length + report.datasets.length
  if (sources === 0) {
    return 'Nothing else in this project is linked to this participant.'
  }
  return `${n(report.total_items, 'item')} across ${n(sources, 'source')} `
    + 'would have to be removed by hand to honour a withdrawal.'
}


/**
 * #702(3) — what the withdrawal confirm says will happen.
 *
 * Lives here rather than in the dialog because these are the sentences a
 * researcher acts on and records, and they are worth testing without mounting a
 * component. Same reason the rest of this file exists.
 */
/** What the operation removes, in the researcher's terms. */
export function removedSummary(r: WithdrawalReport | null): string[] {
  if (!r) return []
  // Name the PERSON when we know it. This is an irreversible action taken on
  // behalf of a real request, and "P-WITHDRAW" alone makes it easy to act on the
  // wrong row; the identifier is in the title, the human name belongs here.
  const out: string[] = [
    r.display_name
      ? `Their participant record — ${r.display_name} — including demographics`
      : 'Their participant record, including any name and demographics',
  ]
  const turns = r.conversations.reduce((n, c) => n + c.segments, 0)
  if (turns > 0) {
    out.push(`The words of their ${turns} conversation turn${turns === 1 ? '' : 's'}`)
  }
  const responses = r.datasets.reduce((n, d) => n + d.responses, 0)
  if (responses > 0) {
    // "All 1 of their survey response" is what the naive template produced.
    out.push(responses === 1
      ? 'Their one survey response'
      : `All ${responses} of their survey responses`)
  }
  const quotes = r.conversations.reduce((n, c) => n + c.excerpts, 0)
    + r.datasets.reduce((n, d) => n + d.excerpts, 0)
  if (quotes > 0) {
    out.push(`${quotes} quote${quotes === 1 ? '' : 's'} taken from their data`)
  }
  return out
}

/** What deliberately stays, and why — so the researcher is not surprised later. */
export function keptSummary(r: WithdrawalReport | null): string[] {
  if (!r) return []
  const out: string[] = []
  const turns = r.conversations.reduce((n, c) => n + c.segments, 0)
  if (turns > 0) {
    out.push(
      `Their ${turns} turn${turns === 1 ? '' : 's'} stay in place as empty placeholders, `
      + 'so the other participants’ conversation still reads correctly',
    )
  }
  const codes = r.conversations.reduce((n, c) => n + c.code_applications, 0)
  if (codes > 0) {
    out.push(`${codes} code${codes === 1 ? '' : 's'} you applied to those turns — your analysis, not their data`)
  }
  const notes = r.conversations.reduce((n, c) => n + c.notes, 0)
    + r.datasets.reduce((n, d) => n + d.notes + d.memos, 0)
  if (notes > 0) {
    out.push(`${notes} note${notes === 1 ? '' : 's'} and memo${notes === 1 ? '' : 's'} you wrote — review these yourself`)
  }
  return out
}
