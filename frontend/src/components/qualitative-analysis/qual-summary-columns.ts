/**
 * #1528 D87 (1.5.9) — the Descriptives summary table's code columns, declared ONCE for the
 * table (`QualSummaryTable`) and the file written from it (the Frequencies CSV).
 *
 * Until 1.5.9 the Frequencies CSV was a SERVER file built on `get_code_frequencies`, the payload
 * #749 moved this table off: it had no Texts column (every count 0 from the Text source, no
 * survey answer under All), counted every source of a kind the researcher selected nothing from,
 * divided its shares by conversations carrying ANY coding, and its text counts would still have
 * disagreed with this table had it written them (a coded "N/A" answer, #1526 D80). The file is
 * now THIS table's rows, from this table's payload (`get_source_frequencies`), shaped by the
 * same functions — so it cannot count a different thing from what the screen shows.
 *
 * Each column states its header, what the TABLE shows, what the FILE writes and its total, side
 * by side — #679's "one list drives the header, the body and the totals", one step further, and
 * #732's lesson (a label and its value defined thirty lines apart is the defect). The two media
 * differ in FORMAT only, on purpose: the table draws 0 as "—" to keep a wide table readable and
 * "3/5" for a reach, while a file keeps a number a number and writes "3 of 5" (Excel reads
 * "3/5" as a date); a share it cannot state is blank, never 0 (#689).
 */
import type { SourceFrequenciesResponse, SourceKind } from '@/lib/api'
import { LAYER_SCOPE_META } from '@/lib/coding-layers'
import { PARTICIPANT_FILTER_RULE, participantFilterScopeBit } from '@/lib/participant-filter'
import type { ParticipantFilterFileScope } from '@/lib/participant-filter'
import type { LayerScope } from '@/lib/coding-layers'
import { toCsv, UTF8_BOM } from '@/lib/csv'
import { UNIVERSAL_SHARE_NOTE } from '@/lib/universal-share'
import { WORD_COUNT_NOTE } from '@/lib/word-count-basis'
import {
  codedSharePercent, presentSourceKinds, shapeQualCodeSummary, sharePercent, summaryKindTotals,
} from './qual-chart-data'
import type { QualCodeSummaryRow } from './qual-chart-data'

/** A code (or, in category mode, a category) with its reach into each kind, and each share. */
export interface EnrichedCodeRow extends QualCodeSummaryRow {
  conversationPercentage: number | null
  participantPercentage: number | null
  documentPercentage: number | null
  observationPercentage: number | null
  textPercentage: number | null
  recordPercentage: number | null
}

/**
 * The rows — #679/#745/#749: every count AND every percentage on a row is computed from `data`,
 * so the pairs cannot disagree. #1526 D79: `% Texts` divides by the CODED texts, so it is a
 * coded share; the other kinds divide by what the selection holds and stay shares on every row.
 */
export function enrichCodeRows(data: SourceFrequenciesResponse): EnrichedCodeRow[] {
  const kindTotals = summaryKindTotals(data)
  return shapeQualCodeSummary(data).map(row => ({
    ...row,
    conversationPercentage: sharePercent(row.conversationCount, kindTotals.conversation),
    documentPercentage: sharePercent(row.documentCount, kindTotals.document),
    observationPercentage: sharePercent(row.observationCount, kindTotals.observation),
    participantPercentage: sharePercent(row.participantCount, kindTotals.participant),
    textPercentage: codedSharePercent(row.isUniversal, row.textCount, kindTotals.text),
    recordPercentage: sharePercent(row.recordCount, kindTotals.record),
  }))
}

/** The numeric fields of a row — the only ones a kind column may point at. Typed this way a
 *  mistyped field is a compile error instead of a column that silently renders 0. */
export type NumericRowField = {
  [K in keyof EnrichedCodeRow]: EnrichedCodeRow[K] extends number | null ? K : never
}[keyof EnrichedCodeRow]

/** #1526 D79 — a universal row's share of a coded total: the table draws "—" and says why. */
export const WITHHELD_SHARE = { withheld: true } as const

/** What a table cell shows: text, or a withheld share. */
export type SummaryCell = string | typeof WITHHELD_SHARE

export interface SummaryColumn {
  /** The row field it shows — also the field the table sorts on. */
  field: 'codeName' | 'categoryName' | NumericRowField
  label: string
  /** The kind group of a kind column (#679); `null` for the columns every table has. */
  kind: SourceKind | null
  /** The columns that NAME the row; the totals row's "Totals" spans them. */
  names?: true
  /** The header's explanation (the table's info tooltip). */
  hint?: string
  /** What the table shows. */
  cell: (row: EnrichedCodeRow) => SummaryCell
  /** What the file writes. */
  fileCell: (row: EnrichedCodeRow) => string
  /** The totals row's number — the base the column is read against — or none. */
  total: number | null
}

const pctText = (v: number | null): string => (v == null ? '' : `${v.toFixed(1)}%`)

/** A share: "—" when it has no denominator (#689 — not 0%), withheld on a universal row when it
 *  is a share of a CODED total (#1526 D79).
 *
 *  ⚠️ The file needs no withheld branch of its own: a universal row's coded share is already
 *  `null` (`codedSharePercent` decides it), so it is blank like any share with no base, and the
 *  note above the table says why. A check here was a mutant that survived — it could not fire. */
function shareColumn(
  field: NumericRowField, label: string, kind: SourceKind | null,
  opts: { codedShare?: boolean; hint?: string } = {},
): SummaryColumn {
  return {
    field, label, kind, hint: opts.hint, total: null,
    cell: r => (opts.codedShare && r.isUniversal ? WITHHELD_SHARE : pctText(r[field]) || '—'),
    fileCell: r => pctText(r[field]),
  }
}

/** A count. `dash`: the table draws 0 as "—" (a wide table stays readable); the file writes 0. */
function countColumn(
  field: NumericRowField, label: string, kind: SourceKind | null, total: number | null, dash = false,
): SummaryColumn {
  return {
    field, label, kind, total,
    cell: r => (dash && !r[field] ? '—' : String(r[field] ?? 0)),
    fileCell: r => String(r[field] ?? 0),
  }
}

/**
 * The summary table's code columns for `data`, in order. The kind groups follow the SELECTION
 * (`presentSourceKinds`, #679): a kind the payload holds no source of has no columns.
 *
 * ⚠️ A `Record<SourceKind, …>`, not an array, so tsc fails until a newly added kind is given its
 * columns (the cast that once defeated this check is why documents and clips went missing, #679).
 */
export function summaryCodeColumns(data: SourceFrequenciesResponse, categoryMode: boolean): SummaryColumn[] {
  const kt = summaryKindTotals(data)
  const kinds: Record<SourceKind, SummaryColumn[]> = {
    conversation: [
      countColumn('conversationCount', 'Conv.', 'conversation', kt.conversation),
      shareColumn('conversationPercentage', '% Conv.', 'conversation'),
      // Participants hang off the conversation spine (documents and clips have no speaker),
      // so they belong to this group — the backend computes them from the conversation arm.
      countColumn('participantCount', 'Participants', 'conversation', kt.participant, true),
      shareColumn('participantPercentage', '% Part.', 'conversation'),
    ],
    document: [
      countColumn('documentCount', 'Docs', 'document', kt.document, true),
      shareColumn('documentPercentage', '% Docs', 'document'),
    ],
    observation: [
      countColumn('observationCount', 'Obs.', 'observation', kt.observation, true),
      shareColumn('observationPercentage', '% Obs.', 'observation'),
    ],
    text_column: [
      countColumn('textCount', 'Texts', 'text_column', kt.text, true),
      shareColumn('textPercentage', '% Texts', 'text_column', { codedShare: true }),
      countColumn('recordCount', 'Records', 'text_column', kt.record, true),
      shareColumn('recordPercentage', '% Rec.', 'text_column'),
    ],
  }
  const present = presentSourceKinds(data)
  const nameColumn: SummaryColumn = {
    field: 'codeName', label: categoryMode ? 'Category' : 'Code', kind: null, names: true, total: null,
    cell: r => r.codeName, fileCell: r => r.codeName,
  }
  const categoryColumn: SummaryColumn = {
    field: 'categoryName', label: 'Category', kind: null, names: true, total: null,
    cell: r => r.categoryName ?? '–', fileCell: r => r.categoryName ?? '',
  }
  return [
    nameColumn,
    ...(categoryMode ? [] : [categoryColumn]),
    // #745: the SELECTION's coded segments, from the same payload as the column above it.
    countColumn('totalCount', 'Count', null, data.totals.coded_segments),
    shareColumn('segmentPercentage', '% of Coded', null, {
      codedShare: true,
      hint: 'Percentage of coded segments (excludes segments with only universal codes)',
    }),
    {
      field: 'textCoverage', label: '% Words', kind: null, total: null,
      hint: `Proportion of total words in segments coded with this code. ${WORD_COUNT_NOTE}`,
      cell: r => `${(r.textCoverage * 100).toFixed(1)}%`,
      fileCell: r => `${(r.textCoverage * 100).toFixed(1)}%`,
    },
    {
      field: 'sourceCount', label: 'Sources', kind: null, total: null,
      cell: r => `${r.sourceCount}/${r.totalSources}`,
      fileCell: r => `${r.sourceCount} of ${r.totalSources}`,
    },
    ...(Object.keys(kinds) as SourceKind[]).filter(k => present.has(k)).flatMap(k => kinds[k]),
  ]
}

/** Every kind column's field, present or not — the table's sort fallback needs to tell "sorted
 *  by a hidden column" from "sorted by a column that is always there". */
export const KIND_FIELDS: ReadonlySet<string> = new Set([
  'conversationCount', 'conversationPercentage', 'participantCount', 'participantPercentage',
  'documentCount', 'documentPercentage', 'observationCount', 'observationPercentage',
  'textCount', 'textPercentage', 'recordCount', 'recordPercentage',
])

/** The unlinked-speaker sentence the table prints under itself — an unlinked speaker is in
 *  neither the participant counts nor their denominator (#749), never "counted as Unknown". */
export function unlinkedSpeakerNote(n: number): string {
  return `${n} coded speaker${n !== 1 ? 's are' : ' is'} not linked to a participant, so `
    + `${n !== 1 ? 'they are' : 'it is'} excluded from the participant counts and percentages above.`
}

/** The table's notes, in its order: why a universal row has no coded share (#1526 D79), and the
 *  unlinked speakers (only when the conversation columns are on the table). */
export function codeSummaryNotes(data: SourceFrequenciesResponse, rows: EnrichedCodeRow[]): string[] {
  const notes: string[] = []
  if (rows.some(r => r.isUniversal)) notes.push(UNIVERSAL_SHARE_NOTE)
  if (presentSourceKinds(data).has('conversation') && data.totals.unlinked_speaker_count > 0) {
    notes.push(unlinkedSpeakerNote(data.totals.unlinked_speaker_count))
  }
  return notes
}

export type SortDir = 'asc' | 'desc'

function sortValue(row: object, field: string): string | number {
  const v = (row as Record<string, unknown>)[field]
  if (typeof v === 'string') return v
  if (typeof v === 'number') return v
  // ⚠️ A `null` share (no denominator, or a universal row's withheld share) sorts as 0 —
  // load-bearing for #1526 D79, whose withheld rows must not sort by the number they do not show.
  return 0
}

/** The table's ordering, which the file opens in too (Count, descending). Stable. */
export function sortSummaryRows<T extends object>(rows: T[], field: string, dir: SortDir): T[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    const av = sortValue(a, field)
    const bv = sortValue(b, field)
    if (typeof av === 'string' && typeof bv === 'string') {
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    }
    return dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
  return sorted
}

/**
 * The file's scope line, when a coder, layer or participant filter narrows its numbers (#499 —
 * otherwise the file reads as everyone's coding; #1545 — or as everyone's). Names the layer (the
 * consensus or the machine one) and the coders, as the screen's effective scope has them: while
 * blind, that is the researcher alone; then the participant filter
 * (`participantFilterScopeBit`), followed by the panel's rule line — which passages a filter
 * keeps, and that clips are left out (#1536). The server's files say the same through
 * `routers/export_helpers.py::file_scope_line`.
 */
export function frequencyFileScope(
  layerScope: LayerScope | null | undefined, coderNames: string[],
  participantFilter: ParticipantFilterFileScope | null = null,
): string | null {
  const bits: string[] = []
  if (layerScope && layerScope !== 'human') bits.push(`${LAYER_SCOPE_META[layerScope].label.toLowerCase()} layer`)
  if (coderNames.length) bits.push(`coders: ${coderNames.join(', ')}`)
  if (participantFilter) bits.push(participantFilterScopeBit(participantFilter))
  if (!bits.length) return null
  return participantFilter
    ? `Scope: ${bits.join('; ')}. ${PARTICIPANT_FILTER_RULE}`
    : `Scope: ${bits.join('; ')}`
}

/**
 * The Frequencies CSV: the summary table's code rows in its opening order, its notes first (the
 * files' convention — the scope, then what a reader needs before the numbers), then the header,
 * the rows and the totals row. Every field passes through `lib/csv.ts` (formula defang + quoting).
 */
export function codeSummaryCsv(
  data: SourceFrequenciesResponse,
  opts: { categoryMode: boolean; scope: string | null },
): string {
  const rows = sortSummaryRows(enrichCodeRows(data), 'totalCount', 'desc')
  const columns = summaryCodeColumns(data, opts.categoryMode)
  const lines: string[][] = []
  if (opts.scope) lines.push([opts.scope])
  for (const note of codeSummaryNotes(data, rows)) lines.push([note])
  lines.push(columns.map(c => c.label))
  for (const row of rows) lines.push(columns.map(c => c.fileCell(row)))
  lines.push(columns.map((c, i) => (i === 0 ? 'Totals' : c.total == null ? '' : String(c.total))))
  return UTF8_BOM + toCsv(lines)
}
