import type { MergeAdditions } from '@/lib/api/project-portability'
import { plural } from '@/lib/format'

/**
 * #1190 (D15) — what the Merge page's Review step says the merge will ALSO add, before
 * the researcher merges (`ImportValidationResult.merge_additions`, built by
 * `services/merge_additions.py`).
 *
 * 🔴 **Why it exists: a plain delete leaves no trace until 1.5.9**, so a colleague's
 * copy made before the delete brings the deleted thing back on merge, silently. The
 * server cannot tell "their new work" from "something deleted here", so this says what
 * arrives — by NAME where a researcher would recognise it (sources, participants,
 * datasets), by COUNT otherwise — and leaves the recognising to them.
 *
 * 🔴 A withdrawn person is never named: `withdrawn_participants` / `withdrawn_items`
 * are counts of what the merge will LEAVE OUT.
 */
export interface MergeAdditionsCopy {
  /** The sentence above the list, or null when the file adds nothing. */
  lead: string | null
  lines: string[]
  /** What the merge leaves out of a withdrawn person's, or null. */
  withdrawn: string | null
}

const n = (count: number) => count.toLocaleString()
const noun = (count: number, one: string, many: string) => `${n(count)} ${plural(count, one, many)}`

/** "A, B, C" plus "and N more" when the server capped the names. */
function named(names: string[], total: number): string {
  const shown = names.join(', ')
  const more = total - names.length
  return more > 0 ? `${shown}, and ${n(more)} more` : shown
}

export const MERGE_ADDITIONS_LEAD =
  'The file also holds these, which this project does not have. Each is either your '
  + 'colleague’s new work or something deleted here since their copy was made — a merge '
  + 'cannot tell which. If you deleted one on purpose, delete it again after merging.'

export const MERGE_ADDS_NOTHING =
  'The file brings no sources, participants, datasets, records, quotes, notes or memos '
  + 'that this project does not already have.'

export function mergeAdditionsLines(a: MergeAdditions): MergeAdditionsCopy {
  const lines: string[] = []
  if (a.source_count > 0) {
    lines.push(`${noun(a.source_count, 'source', 'sources')}: ${named(a.sources.map(s => s.name), a.source_count)}`)
  }
  if (a.participant_count > 0) {
    lines.push(`${noun(a.participant_count, 'participant', 'participants')}: ${named(a.participants, a.participant_count)}`)
  }
  if (a.dataset_count > 0) {
    const each = a.datasets.map(d => `${d.name} (${noun(d.records, 'record', 'records')})`)
    lines.push(`${noun(a.dataset_count, 'dataset', 'datasets')}: ${named(each, a.dataset_count)}`)
  }
  if (a.record_count > 0) {
    const each = a.records.map(r => `${r.dataset} (${n(r.count)})`)
    lines.push(
      `${noun(a.record_count, 'record', 'records')} in datasets this project has: `
      + named(each, each.length),
    )
  }
  const notes: string[] = []
  if (a.quotes > 0) notes.push(noun(a.quotes, 'quote', 'quotes'))
  if (a.notes > 0) notes.push(noun(a.notes, 'note', 'notes'))
  if (a.memos > 0) notes.push(noun(a.memos, 'memo', 'memos'))
  if (notes.length > 0) {
    lines.push(notes.length === 1
      ? notes[0]
      : `${notes.slice(0, -1).join(', ')} and ${notes[notes.length - 1]}`)
  }

  let withdrawn: string | null = null
  if (a.withdrawn_participants > 0) {
    withdrawn = `The file holds ${noun(a.withdrawn_participants, 'participant', 'participants')} `
      + 'who withdrew from this project'
      + (a.withdrawn_items > 0 ? `, and ${noun(a.withdrawn_items, 'item', 'items')} of theirs` : '')
      + '. The merge leaves them out.'
  } else if (a.withdrawn_items > 0) {
    withdrawn = `The file holds ${noun(a.withdrawn_items, 'item', 'items')} of someone who withdrew `
      + 'from this project. The merge leaves them out.'
  }

  return { lead: lines.length > 0 ? MERGE_ADDITIONS_LEAD : null, lines, withdrawn }
}
