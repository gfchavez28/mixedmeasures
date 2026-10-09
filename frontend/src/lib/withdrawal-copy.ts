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
  // 🔴 #1123 — row 46's third link. The server reported these from the start and
  // its response schema dropped them, so this list had nothing to say about a
  // document's subject, and the headline below told the researcher NOTHING else
  // was linked to them.
  for (const doc of report.documents) {
    const parts = ['a document about them']
    if (doc.segments) parts.push(n(doc.segments, 'passage'))
    if (doc.code_applications) parts.push(n(doc.code_applications, 'code'))
    if (doc.excerpts) parts.push(n(doc.excerpts, 'quote'))
    if (doc.notes) parts.push(n(doc.notes, 'note'))
    lines.push(`${doc.name} — ${parts.join(', ')}`)
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
      + 'turns, responses, speaker name and any document about them remain in the project, '
      + 'no longer linked to anyone.'
  }
  const turns = report.conversations.reduce((t, c) => t + c.segments, 0)
  const responses = report.datasets.reduce((t, d) => t + d.responses, 0)
  const documents = report.documents.length

  // Each survivor carries its own number, because the verb agrees with the
  // list: "1 survey response remains", "34 survey responses remain". The verb
  // used to be chosen by whether the ONE survivor's text began with "the", which
  // read "34 survey responses remains" and "the speaker name … remain".
  const survives: Array<{ text: string; one: boolean }> = []
  if (turns) survives.push({ text: n(turns, 'transcript turn'), one: turns === 1 })
  if (responses) survives.push({ text: n(responses, 'survey response'), one: responses === 1 })
  if (documents) {
    survives.push({ text: `${n(documents, 'document')} about them`, one: documents === 1 })
  }
  if (report.speaker_names.length) {
    survives.push({
      text: `the speaker name ${report.speaker_names.map(s => `"${s}"`).join(' / ')}`,
      one: report.speaker_names.length === 1,
    })
  }

  if (survives.length === 0) {
    return 'This participant has no linked transcript turns, responses or documents, so '
      + 'deleting the record removes the record only.'
  }
  const texts = survives.map(s => s.text)
  const list = texts.length === 1
    ? texts[0]
    : `${texts.slice(0, -1).join(', ')} and ${texts[texts.length - 1]}`
  const verb = survives.length === 1 && survives[0].one ? 'remains' : 'remain'

  return `This removes the participant record only — ${list} ${verb} `
    + 'in the project, no longer linked to anyone. Deleting the record first makes a '
    + 'withdrawal request HARDER to honour, because it destroys the link used to find '
    + 'their data.'
}

/**
 * The one-line headline for the report panel.
 *
 * Counts the participant record itself, so the number matches what the delete
 * button is about to act on — and says so, since the record is not "linked to"
 * itself.
 *
 * 🔴 #1136 — it said these items *"would have to be removed by hand to honour a
 * withdrawal"*, written for #702(2) three days before #702(3) shipped the button
 * that removes them, and never revisited: a false sentence about the software on
 * the surface a researcher reads when deciding how to honour a request.
 */
export function withdrawalHeadline(report: WithdrawalReport): string {
  const sources = report.conversations.length + report.datasets.length + report.documents.length
  if (sources === 0) {
    return 'Nothing else in this project is linked to this participant.'
  }
  return `${n(report.total_items, 'item')} across ${n(sources, 'source')}, counting this `
    + `record, ${report.total_items === 1 ? 'traces' : 'trace'} back to this participant.`
}

/**
 * #1136 — the closing line under the report: what the withdrawal DOES, and the part
 * it cannot do. It said *"Mixed Measures has no erase function — removing this data
 * is manual"*, beside the button that removes it. The residual is the one the
 * confirm's warning states (`withdrawal_redaction.py`'s ⛔ section): finding the
 * name in someone else's words is reading, by a person.
 */
export const WITHDRAWAL_SCOPE_NOTE =
  'The withdrawal button in this participant’s row blanks their conversation turns, '
  + 'deletes their survey responses and this record, and unlinks documents about them. '
  + 'It cannot find their name in other people’s turns, in free-text answers, or in '
  + 'notes and memos — search for those yourself. This describes the software; it is '
  + 'not compliance advice.'


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
    // #1131 — the verb and the noun agree with the count ("Their 1 turn stay in
    // place as empty placeholders" was the singular).
    out.push(
      (turns === 1
        ? 'Their 1 turn stays in place as an empty placeholder, '
        : `Their ${turns} turns stay in place as empty placeholders, `)
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
  // #1123 — the withdrawal UNLINKS a document about this person and keeps it,
  // because "about them" is equally true of a workplan they wrote and a policy
  // that names them, and only a person reading it can tell which
  // (`withdrawal_redaction.apply_withdrawal`). The confirm never said so.
  const docs = r.documents
  if (docs.length === 1) {
    out.push(`The document “${docs[0].name}” stays, no longer linked to them — `
      + 'read it yourself: a document about someone can also be their own words')
  } else if (docs.length > 1) {
    out.push(`${docs.length} documents about them stay, no longer linked to them — `
      + 'read them yourself: a document about someone can also be their own words')
  }
  return out
}

/**
 * #1123 — the sentence after a withdrawal, which said nothing about documents
 * although the server returns how many it unlinked.
 */
export function withdrawalDoneNote(documentsUnlinked: number): string {
  const base = 'Now search your transcripts and free-text answers for their name — '
    + 'that part cannot be automated.'
  if (!documentsUnlinked) return base
  return documentsUnlinked === 1
    ? `${base} 1 document no longer says who it is about — read it too.`
    : `${base} ${documentsUnlinked} documents no longer say who they are about — read them too.`
}

/**
 * The bulk delete's sentence. #1110: it said "Any remaining speaker or
 * dataset-row links will be cleared" — and said nothing of a DOCUMENT, whose
 * subject the delete clears too (`Document.participant_id` is SET NULL).
 */
export function bulkDeleteDescription(count: number, names: string, documents: number): string {
  const people = `${count} selected participant${count === 1 ? '' : 's'}`
  const docs = documents === 0
    ? ''
    : documents === 1
      ? ' 1 document will no longer say who it is about.'
      : ` ${documents} documents will no longer say who they are about.`
  return `Permanently delete ${people} (${names})? Their transcripts, responses and documents `
    + `stay in the project, no longer linked to anyone.${docs} This cannot be undone.`
}
