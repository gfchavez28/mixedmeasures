import type {
  OtherProjectsWithIdentifier, PreUpdateCopies, UnplacedCanvasPlace, WithdrawalOutcome,
  WithdrawalReport,
} from '@/lib/api/participants'
import { isServerRefusal, serverDetailMessage } from '@/lib/api/error-utils'

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
    // #1320 — the turns their words reached by a merge or a split.
    if (c.combined_turns) parts.push(n(c.combined_turns, 'merged or split turn'))
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
  // #1320 — a merged or split turn holding their words survives a delete too.
  const turns = report.conversations.reduce((t, c) => t + c.segments + c.combined_turns, 0)
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

  // Joint display slice 2 (D314): a delete also removes their entries from the lists of cases
  // that don't fit (each names them, with the researcher's reason; when D314 was decided their id
  // could also come back as someone else — D319 has since stopped that), so "the record only"
  // would be false — said, and why. The row's button says what stays instead (#1648).
  const misfit = misfitCasesNote(report)
  const only = misfit ? '' : ' only'
  const also = misfit ? ` ${misfit}` : ''
  if (survives.length === 0) {
    return 'This participant has no linked transcript turns, responses or documents, so '
      + `deleting the record removes the record${only}.${also}`
  }
  const texts = survives.map(s => s.text)
  const list = texts.length === 1
    ? texts[0]
    : `${texts.slice(0, -1).join(', ')} and ${texts[texts.length - 1]}`
  const verb = survives.length === 1 && survives[0].one ? 'remains' : 'remain'

  return `This removes the participant record${only} — ${list} ${verb} `
    + 'in the project, no longer linked to anyone. Deleting the record first makes a '
    + 'withdrawal request HARDER to honour, because it destroys the link used to find '
    + `their data.${also}`
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
 *
 * #1320 (D12) — and what it does not reach at all: recordings, and every copy made
 * before it (backups, safety copies, exported files). It said nothing of either.
 *
 * #1546 (D158) — and a canvas quote whose source was deleted before it: an embed names
 * no speaker, so nothing says whose words it holds, and it stays. "When it cannot
 * tell", because a quote whose words equal one of the person's answers is still
 * theirs to the withdrawal (`canvas_embed_scrub._Judge`) — the sentence must not
 * promise it leaves every such quote.
 *
 * #1606 (D233) — and two more copies that hold everything: the database copies taken
 * before each update (in the backup folder, which Settings does not list) and projects
 * duplicated from this one. "Safety copies" stays — the accepted draft omitted it, but
 * D233 adds the two missing kinds and removes none.
 */
export const WITHDRAWAL_SCOPE_NOTE =
  'The withdrawal button in this participant’s row blanks their conversation turns, '
  + 'deletes their survey responses and this record, and unlinks documents about them. '
  + 'It does not edit recordings, and backups, safety copies, database copies taken before '
  + 'an update, projects duplicated from this one and files exported before the withdrawal '
  + 'still hold their data. '
  + 'Quotes on a canvas taken from a conversation or dataset deleted before the '
  + 'withdrawal stay when it cannot tell whose words they hold. '
  + 'It cannot find their name in other people’s turns, in free-text answers, or in '
  + 'notes and memos — search for those yourself. This describes the software; it is '
  + 'not compliance advice.'

/**
 * #1190 — what the withdrawal LEAVES behind on purpose: a record of it (the removal
 * tombstones, `services/tombstones.py`), and what that record does and does not do.
 *
 * Says no more than the design guarantees, each clause checked against the code:
 * - **merging a copy** skips her participant, speakers, records, quotes and notes, and
 *   **importing one** that still holds her is refused — both read the tombstones kept
 *   under the project's identity, which outlive the project row (D8);
 * - **linking records or speakers** never links to or creates her (Link by column, the
 *   import's own linking and Append share `plan_identifier_links`; a conversation
 *   import's speaker linking is `ensure_participant_for_speaker`);
 * - **adding her ID by hand asks first** (D12, `lib/withdrawn-identifier.ts`);
 * - **a transcript naming her by her ID or a name the project knew her by** does not
 *   make her a participant again, and the import's warnings say so (#1472 / #1391,
 *   D73–D74: the `participant_name` kind, read only by that door) — since #1605 (D228,
 *   D229) also in other capitals or spacing, or with accents encoded the other way
 *   (NFD), never with the accents themselves changed; a name she was never given in
 *   the project is not recognised;
 * - **an ID elsewhere** (linking, a typed add, every file door) is recognised with its
 *   accents encoded either way and its capitals counting — DEC-2, #1605 D227;
 * - **an older withdrawal** recognises the names it kept as they were written (#1605
 *   D230: the update rebuilt only the ID, which the audit trail keeps), and one made
 *   before the names were remembered kept the ID only (D76 — no backfill: her rows are
 *   gone). No version number is named: the record has outlived two, and the next
 *   release's number is not decided;
 * - **files exported afterwards carry the record** (`project.json`'s `tombstones`, D10).
 * Copies made BEFORE are the earlier sentence's — they still hold her, and another
 * install that never saw the record imports one as it is.
 *
 * 🔴 D9 — the record keeps her identifier, and since #1472 her names, as one-way codes
 * (SHA-256 over the trimmed text). Short codes and names are recoverable from such a
 * code by guessing, so it is NOT anonymisation, and the sentence says so: a researcher
 * reporting that a request was honoured must know that a coded trace of the ID and the
 * names stays in the project and travels in every file exported from it.
 *
 * #1606 (D233) — and the ID in PLAIN text: the `withdrawn` audit entry keeps it on
 * purpose (D9), and the Excel *Audit Trail* sheet carries entries' details. "Keeps their
 * ID … as one-way codes" alone read as if the ID were kept plainly nowhere.
 */
export const WITHDRAWAL_RECORD_NOTE =
  'Afterwards this project keeps a record of the withdrawal: merging or importing a copy '
  + 'of it, or linking records or speakers to participants, does not bring them back, and '
  + 'adding a participant with their ID asks first. A transcript that names a speaker with '
  + 'their ID, or with a name this project knew them by, does not make them a participant '
  + 'again — even written with different capitals or spacing, or with its accents encoded '
  + 'differently — and its import says so; a name this project never used for them is not '
  + 'recognised. Elsewhere their ID is recognised with its accents encoded either way, but '
  + 'its capitals count (P01 and p01 can be two people). Project files exported afterwards '
  + 'carry that record. It keeps their ID and those names as one-way codes, which is not '
  + 'anonymisation — anyone who can guess one can confirm it from the code, and the audit '
  + 'trail records the withdrawal under their ID. A withdrawal made '
  + 'in an earlier version of Mixed Measures recognises the names it kept only as they were '
  + 'written, and the oldest versions kept their ID only.'

/**
 * #1320 (D12) — what the confirm says BEFORE it lists anything: the backup, every
 * other copy that still holds the data, recordings, and that there is no
 * per-person undo. Here rather than in the dialog so a test can hold the wording
 * and the dialog can be tested for WHERE it sits (inside the description).
 *
 * #1606 (D233, the developer's wording) — and the two kinds it left out: a project
 * duplicated from this one before the withdrawal (it keeps everything, and its own record
 * is empty), and the copies of the whole database taken before each update
 * (`database._backup_database`: five kept, in the backup folder, which Settings does not
 * list — so "delete them in Settings" has no door for them). The report's own lines name
 * which projects and how many copies (`otherProjectsNote`, `preUpdateCopiesNote`).
 */
export const WITHDRAWAL_RESIDUAL_NOTE =
  'For honouring a withdrawal request. A full backup is taken first. That backup, your '
  + 'earlier backups, the safety copies kept before a merge or overwrite, any project '
  + 'duplicated from this one before now, and any file already exported or shared still '
  + 'hold everything this removes until they are deleted. So do the copies of the whole '
  + 'database taken before each update; they are in the backup folder, which Settings '
  + 'does not list, and the five most recent are kept. Automatic and On quit backups are '
  + 'replaced over time; the others stay until you delete them in Settings › Backup & '
  + 'Data. A duplicated project is a project of its own: withdraw them there too. '
  + 'Recordings are not edited — their voice stays in the audio or video. There is no '
  + 'per-person undo: restoring a backup also undoes any work done after it. '
  + WITHDRAWAL_RECORD_NOTE

/** #1320 (D12) — appended to the note after a withdrawal. #1606 (D233, the developer's
 *  wording) — with the update copies, which Settings does not list, and a duplicated
 *  project, which is a project of its own. */
export const WITHDRAWAL_BACKUP_RESIDUAL =
  'The “Before a withdrawal” backup taken now, every earlier backup and the database '
  + 'copies taken before each update still hold their data until you delete them — '
  + 'backups in Settings › Backup & Data, update copies in the backup folder. A project '
  + 'duplicated from this one before now still holds them; withdraw them there too.'


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
  // #1320 (D7) — a turn their words were merged or split into is blanked WHOLE,
  // so it says so: the other speaker's words in it go from view too.
  const shared = r.conversations.reduce((n, c) => n + c.combined_turns, 0)
  if (shared > 0) {
    out.push(shared === 1
      ? 'All the words of 1 merged or split turn holding theirs, including anything others said in it'
      : `All the words of ${shared} merged or split turns holding theirs, including anything others said in them`)
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
  // #1473 — a note or a code on an ANSWER hangs off it, so it goes with it (a
  // turn's stay, below). This list said nothing of them, and the kept list
  // called the notes kept, while the withdrawal deleted both.
  const answerNotes = r.datasets.reduce((n, d) => n + d.notes, 0)
  if (answerNotes > 0) {
    out.push(answerNotes === 1
      ? 'The note you wrote on one of their survey responses'
      : `${answerNotes} notes you wrote on their survey responses`)
  }
  const answerCodes = r.datasets.reduce((n, d) => n + d.code_applications, 0)
  if (answerCodes > 0) {
    out.push(`${answerCodes} code${answerCodes === 1 ? '' : 's'} applied to their survey responses`)
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
  // #1320 (D7) — what the blanked merged turn costs the other speaker: nothing
  // lost, because their own turn from before the merge is kept hidden.
  const shared = r.conversations.reduce((n, c) => n + c.combined_turns, 0)
  if (shared > 0) {
    out.push('What others said in a merged turn is still in their own turn from '
      + 'before the merge — Unmerge brings it back')
  }
  const codes = r.conversations.reduce((n, c) => n + c.code_applications, 0)
  if (codes > 0) {
    out.push(`${codes} code${codes === 1 ? '' : 's'} you applied to those turns — your analysis, not their data`)
  }
  // #1473 — a dataset's `notes` are on their ANSWERS and are deleted with them
  // (`removedSummary`); only the record's memos stay.
  const notes = r.conversations.reduce((n, c) => n + c.notes, 0)
    + r.datasets.reduce((n, d) => n + d.memos, 0)
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
  const unlinked = unlinkedRecordsNote(r)
  if (unlinked) out.push(unlinked)
  // #1546 (D158) — canvas quotes it leaves because nothing says whose they are.
  const canvas = unplacedCanvasQuotesNote(r)
  if (canvas) out.push(canvas)
  // #1606 (D234, D235) — copies of their data the withdrawal does not reach at all.
  const others = otherProjectsNote(r)
  if (others) out.push(others)
  const updates = preUpdateCopiesNote(r)
  if (updates) out.push(updates)
  return out
}

/** A list read as English: "A", "A and B", "A, B and C". */
const andList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

const placeCount = (p: UnplacedCanvasPlace) => (p.quotes > 1 ? ` (${p.quotes})` : '')

/**
 * #1546 (D158) — canvas quotes whose source was deleted or changed since they were put
 * on the canvas. An embed shows the quote's words and names its source only — no
 * speaker, no answer — so once the quote, its conversation or its dataset is gone, the
 * withdrawal cannot tell whose words it holds, and LEAVES it. Counted, never guessed:
 * matching it against their turns everywhere would blank someone else's short quote.
 * Every place is named — sections as "Canvas › Section", snapshots by name, since a
 * restore brings a snapshot's copy back. Null when there are none.
 */
export function unplacedCanvasQuotesNote(r: WithdrawalReport): string | null {
  const u = r.canvas_quotes_unplaced
  if (!(u.quotes > 0)) return null
  const places = andList([
    ...u.sections.map(p => `“${p.canvas_name} › ${p.name}”${placeCount(p)}`),
    ...u.snapshots.map(p => `the snapshot “${p.name}” of “${p.canvas_name}”${placeCount(p)}`),
  ])
  return u.quotes === 1
    ? '1 quote on a canvas comes from a quote, conversation or dataset deleted or changed '
      + 'since it was put there, so the withdrawal cannot tell whose words it holds. It stays '
      + `— read it yourself: ${places}`
    : `${u.quotes} quotes on a canvas come from quotes, conversations or datasets deleted or `
      + 'changed since they were put there, so the withdrawal cannot tell whose words they '
      + `hold. They stay — read them yourself: ${places}`
}

/**
 * #1190 (D14) — dataset records linked to no one whose ID column carries this person's
 * ID. The withdrawal acts on LINKED records only, so these stay; a matching ID is not
 * proof the record is theirs (another person can share a code, and an ID column can be
 * mistyped), so they are counted — never named, never deleted — and left to the
 * researcher. Null when there are none.
 */
export function unlinkedRecordsNote(r: WithdrawalReport): string | null {
  const count = r.unlinked_records_with_identifier
  if (!(count > 0)) return null
  return count === 1
    ? '1 dataset record linked to no one carries their ID. It stays — check it yourself: '
      + 'a matching ID does not prove the record is theirs'
    : `${count} dataset records linked to no one carry their ID. They stay — check them `
      + 'yourself: a matching ID does not prove a record is theirs'
}

const COPY_RELATION: Record<'copy' | 'source', string> = {
  copy: ' (a copy of this project)',
  source: ' (the project this one was copied from)',
}

/**
 * #1606 (D234) — other projects here holding a participant with this ID (any Unicode
 * form, capitals counting). A project duplicated from this one before the withdrawal
 * keeps everything about the person and is a project of its own; a project merely
 * sharing a short code may hold someone else, so the sentence asks the researcher to
 * check rather than claiming it is the same person. A Duplicate is named in its
 * direction — the project a copy was made FROM is not "a copy of this project". Names
 * only; the list is capped by the server and the rest are counted. Null when none.
 */
export function otherProjectsNote(
  r: { other_projects_with_identifier: OtherProjectsWithIdentifier },
): string | null {
  const { projects, total } = r.other_projects_with_identifier
  if (!(total > 0)) return null
  const named = projects.map(p =>
    `“${p.name}”${p.copy_relation ? COPY_RELATION[p.copy_relation] : ''}`)
  const more = total - projects.length
  const list = more > 0 ? `${named.join(', ')} and ${more} more` : andList(named)
  return (total === 1
    ? `Another project here holds a participant with this ID: ${list}. `
    : `Other projects here hold a participant with this ID: ${list}. `)
    + 'Check whether it is the same person, and withdraw them there too'
}

/**
 * #1606 (D235) — the copies of the whole database taken before each update, which
 * Settings does not list: how many, and the folder the server named
 * (`get_backup_dir()`, never composed here). Unknown is said as unknown — a folder that
 * could not be read is never "no copies". Null when there are none.
 */
export function preUpdateCopiesNote(r: { pre_update_copies: PreUpdateCopies }): string | null {
  const { count, folder } = r.pre_update_copies
  if (count === null) {
    return `The backup folder, ${folder}, could not be read, so whether it holds copies of `
      + 'the whole database taken before updates is not known'
  }
  if (!(count > 0)) return null
  return count === 1
    ? `1 copy of the whole database taken before an update is in ${folder}`
    : `${count} copies of the whole database taken before updates are in ${folder}`
}

/**
 * #1123 — the sentence after a withdrawal, which said nothing about documents
 * although the server returns how many it unlinked.
 *
 * #1320 (D12) — and it ends on the backups, which hold everything just removed:
 * the "Before a withdrawal" one was taken a moment ago.
 *
 * #1546 (D158) — and the canvas quotes it left. It takes the OUTCOME's fields rather
 * than numbers, so a new count the note must say cannot be forgotten at the call site.
 *
 * #1606 (D234, D235) — and the other projects holding their ID and the update copies,
 * which the endpoint read before it acted and returns beside its outcome.
 */
export function withdrawalDoneNote(
  outcome: Pick<
    WithdrawalOutcome,
    'documents_unlinked' | 'canvas_quotes_unplaced' | 'other_projects_with_identifier'
    | 'pre_update_copies'
  >,
): string {
  const base = 'Now search your transcripts and free-text answers for their name — '
    + 'that part cannot be automated.'
  const documentsUnlinked = outcome.documents_unlinked
  const documents = !documentsUnlinked
    ? ''
    : documentsUnlinked === 1
      ? ' 1 document no longer says who it is about — read it too.'
      : ` ${documentsUnlinked} documents no longer say who they are about — read them too.`
  const quotes = outcome.canvas_quotes_unplaced
  const canvas = !quotes
    ? ''
    : quotes === 1
      ? ' 1 quote on a canvas stays because its source was deleted or changed and nothing '
        + 'says whose words it holds — read it too.'
      : ` ${quotes} quotes on a canvas stay because their source was deleted or changed and `
        + 'nothing says whose words they hold — read them too.'
  const elsewhere = [otherProjectsNote(outcome), preUpdateCopiesNote(outcome)]
    .filter((s): s is string => s !== null)
    .map(s => ` ${s}.`)
    .join('')
  return `${base}${documents}${canvas}${elsewhere} ${WITHDRAWAL_BACKUP_RESIDUAL}`
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

/**
 * #1667 (D343) — WHY a bulk delete left some participants: each DISTINCT refusal the server
 * sent, in its words, for the toast's description. A canvas copy the delete cannot read
 * refuses every delete in the same sentence (#1651's, naming the copy), so it reads once; the
 * toast's count line said only "N could not be removed". A failure that is not a refusal (a
 * timeout, a 5xx) adds nothing — its body says nothing a researcher can act on (#957). Null
 * when no failure was a refusal.
 */
export function bulkDeleteRefusals(errors: unknown[]): string | null {
  const reasons: string[] = []
  for (const error of errors) {
    if (!isServerRefusal(error)) continue
    const reason = serverDetailMessage(error)
    if (reason && !reasons.includes(reason)) reasons.push(reason)
  }
  return reasons.length > 0 ? reasons.join(' ') : null
}

/** #1667 (D342) — the participant panel's *If this person withdraws*, when its report could not
 *  be read; the server's sentence (naming the canvas copy) follows it. */
export const WITHDRAWAL_SECTION_FAILED_TITLE = 'What a withdrawal would remove could not be checked.'

/**
 * Joint display slice 2 (r3-6) — the cases picked as not fitting in a joint display that name
 * them. The withdrawal REMOVES each, with the researcher's reason (which may identify them);
 * counted with snapshot copies, which a restore brings back. Null when there are none.
 */
export function misfitCasesNote(r: Pick<WithdrawalReport, 'canvas_misfit_cases'>): string | null {
  const n = r.canvas_misfit_cases
  if (!(n > 0)) return null
  // r5-9 (round 2): a case is ADDED to a list or REMOVED from a rule's list (r3-12) — both
  // name them with a reason, so the sentence says "named", never only "picked".
  return n === 1
    ? 'They are named, with your reason, in 1 list of cases that don’t fit on a canvas (a joint '
      + 'display, or a snapshot of one). The entry and your reason are removed.'
    : `They are named, with your reason, in ${n} lists of cases that don’t fit on a canvas (joint `
      + 'displays and their snapshots). Each entry and your reason are removed.'
}
