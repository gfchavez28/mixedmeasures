import type {
  CodeAnalysisFilterParams, CodeComparisonEntry, DemographicComparisonResponse, SourceFrequenciesRequest,
} from '@/lib/api'
import type { ChartDataRow } from '@/lib/chart-types'

/** The four source kinds a qualitative selection can hold. */
export interface QualSourceSelection {
  conversations: Iterable<number>
  textColumns: Iterable<number>
  documents: Iterable<number>
  observations: Iterable<number>
}

export interface ComparisonSources {
  conversation_ids?: number[]
  text_column_ids?: number[]
  document_ids?: number[]
  observation_ids?: number[]
}

/**
 * #1297 / #1298 — what the comparison counts, decided ONCE for the view, its CSV and
 * the Canvas (embed + export).
 *
 * Nothing selected → every source of every kind (the comparison has always opened
 * on the whole project). Anything selected → EXACTLY the selection, so an unselected
 * kind is sent as `[]` ("none of that kind"). The old builders sent `undefined` for
 * an empty kind, which the server reads as ALL — a text-only selection counted every
 * conversation (#1297).
 */
export function comparisonSources(sel: QualSourceSelection): ComparisonSources {
  const conversation_ids = [...sel.conversations]
  const text_column_ids = [...sel.textColumns]
  const document_ids = [...sel.documents]
  const observation_ids = [...sel.observations]
  const any = conversation_ids.length + text_column_ids.length + document_ids.length + observation_ids.length > 0
  return any ? { conversation_ids, text_column_ids, document_ids, observation_ids } : {}
}

/**
 * The query names the comparison and Source Data CSV routes declare, as a TYPE (#1534 D110,
 * 1.5.9): these were `Record<string, string>`, which hid every key from the request-contract
 * test (`lib/api/request-contract.test.ts`) — the class where a client name the route does not
 * declare is dropped without a word. A key here is a route's own name.
 */
export type QualCsvParams = Partial<Record<
  keyof ComparisonSources | 'code_ids' | 'participant_ids' | 'exclude_facilitator'
  | 'coder_ids' | 'layer_scope' | 'group_by_subtype'
  // #1545: the panel's description of the chosen filter values, for the file's scope line.
  | 'participant_filter_label',
  string
>>

/** The same lists as CSV query parameters — an empty kind is `''`, never omitted
 *  (the server keeps "present and empty" apart from "absent"). */
export function comparisonSourceParams(sources: ComparisonSources): Pick<QualCsvParams, keyof ComparisonSources> {
  const out: Pick<QualCsvParams, keyof ComparisonSources> = {}
  for (const [key, ids] of Object.entries(sources) as [keyof ComparisonSources, number[] | undefined][]) {
    if (ids) out[key] = ids.join(',')
  }
  return out
}

/**
 * #1527 D84 — the co-occurrence figure counts what the comparison counts: `base` with its
 * four source lists replaced by the selection, by the rule above. Nothing selected → no
 * list (every source); anything selected → exactly the selection, an unselected kind as
 * `''` (none of it).
 *
 * The page's `filterParams` cannot carry this: they also feed `/frequencies`, whose
 * "absent = all" reading `hasCoding` needs (#749). Until 1.5.9 the figure took those
 * params as they were, so selecting one interview still counted every document and clip
 * (code A on 4 units where the Descriptives screen said 1). ONE builder for the page's
 * figure, its CSV and the Canvas embed and export (`buildQualCooccurrenceParams`).
 */
export function cooccurrenceFilterParams(
  base: CodeAnalysisFilterParams, sel: QualSourceSelection,
): CodeAnalysisFilterParams {
  const out: CodeAnalysisFilterParams = { ...base }
  delete out.conversation_ids
  delete out.text_column_ids
  delete out.document_ids
  delete out.observation_ids
  return { ...out, ...comparisonSourceParams(comparisonSources(sel)) }
}

/** The analysis sidebar's *Conversations / Text / All* mode — which kinds it OFFERS. */
export type QualSourceMode = 'all' | 'conversations' | 'text'

/** The kinds a mode does not offer, as "none of them" (`[]`). */
function kindsTheModeLeavesOut(mode: QualSourceMode): ComparisonSources {
  if (mode === 'text') return { conversation_ids: [], document_ids: [], observation_ids: [] }
  if (mode === 'conversations') return { text_column_ids: [] }
  return {}
}

/**
 * #1528 D87 (1.5.9) — the request the Frequencies CSV is written from: the Descriptives summary
 * table's request (`POST …/source-frequencies`), with the codes and the sources each read by the
 * rule above. Anything selected → exactly that, an unselected kind as `[]` (none of it) — the
 * table's own request. Nothing selected → every code, and every source the sidebar OFFERS under
 * its *Conversations / Text / All* mode: what *Select all* would choose, so the file is still a
 * table the researcher can put on screen (with All, every source of every kind).
 *
 * ⚠️ The mode is read ONLY for "nothing selected", decided at build (2026-11-04, driving the
 * record's §6 interaction): reading every kind there put a Text-mode file's interviews beside
 * the co-occurrence CSV in the same *Exports* list, which counts only answers in that mode
 * (session A keeps the mode on its request). With a selection the table's request applies, and
 * the table does not read the mode.
 */
export function codeFrequenciesFileRequest(
  codes: Iterable<number>,
  sel: QualSourceSelection,
  mode: QualSourceMode,
  base: Pick<SourceFrequenciesRequest,
    'exclude_facilitator' | 'participant_ids' | 'aggregation' | 'coder_ids' | 'layer_scope'>,
): SourceFrequenciesRequest {
  const code_ids = [...codes]
  const selected = comparisonSources(sel)
  const sources = Object.keys(selected).length ? selected : kindsTheModeLeavesOut(mode)
  return { ...base, ...(code_ids.length ? { code_ids } : {}), ...sources }
}

/**
 * #1528 D88 (1.5.9) — the Source Data CSV's query, by #1297's two rules: the selection through
 * `comparisonSourceParams` (an unselected kind is a present `''`, which the route reads as none —
 * it used to be omitted, which reads as EVERY source of that kind), and `exclude_facilitator`
 * ALWAYS sent (the route defaults to `true`, so sending it only when true dropped the
 * researcher's *include interviewer turns*).
 */
export function sourceDataCsvParams(
  codes: Iterable<number>,
  sel: QualSourceSelection,
  opts: {
    excludeFacilitator: boolean; participantIds: number[]; coderIdsCsv?: string; layerScope?: string
    /** #1545: `participantFilterFileScope(…).label` — the file names the values on its scope line. */
    participantFilterLabel?: string | null
  },
): QualCsvParams {
  const out: QualCsvParams = {
    ...comparisonSourceParams(comparisonSources(sel)),
    exclude_facilitator: String(opts.excludeFacilitator),
  }
  const code_ids = [...codes]
  if (code_ids.length) out.code_ids = code_ids.join(',')
  if (opts.participantIds.length) {
    out.participant_ids = opts.participantIds.join(',')
    if (opts.participantFilterLabel) out.participant_filter_label = opts.participantFilterLabel
  }
  // #499: the EFFECTIVE (blind-forced) coder/layer scope, so the file matches the screen.
  if (opts.coderIdsCsv) out.coder_ids = opts.coderIdsCsv
  if (opts.layerScope) out.layer_scope = opts.layerScope
  return out
}

/** The query names `GET …/export/coded-segments` declares (#1535 D111): the passage kinds only —
 *  the file has no survey answers (D114) — and no layer (the file is the human layer, J2-B). */
export type CodedSegmentsParams = Pick<QualCsvParams,
  'conversation_ids' | 'document_ids' | 'observation_ids'
  | 'code_ids' | 'participant_ids' | 'exclude_facilitator' | 'coder_ids'>

/** The Segments CSV door's state, decided with its request (#1535 D114). */
export type CodedSegmentsFile =
  | { passages: true; params: CodedSegmentsParams; answersLeftOut: boolean }
  | { passages: false }

/** D114 — why the door does nothing: the selection holds no passage (the *Text* source, or
 *  questions alone). Shown as the door's visible reason, tied to it by `aria-describedby`. */
export const SEGMENTS_FILE_NO_PASSAGE_REASON =
  'This file lists coded passages (interviews, documents, clips). The selection holds none.'

/** D114 — questions selected beside passages: the file still works, and says what it leaves out. */
export const SEGMENTS_FILE_ANSWERS_NOTE = 'Survey answers are not in this file.'

/**
 * #1535 (1.5.9, D111–D114) — the analysis page's *Exports › Segments CSV*: exactly the passages
 * the page selected. The door used to pass the page's `filterParams`, whose "absent = every
 * source of a kind" is `/frequencies`' reading (#749), and the API dropped the document and clip
 * lists, so one selected document exported every coded passage in the project.
 *
 * - **Sources (D111):** anything selected → exactly that, an unselected passage kind as `''`
 *   (none of it); nothing selected → every passage the sidebar's mode offers (#1528 D87's
 *   refinement: *Conversations* and *All* every interview, document and clip — no list sent;
 *   *Text* none).
 * - **Codes (D112):** the selection; nothing selected → every code (no `code_ids`).
 * - **No passage (D114):** `{ passages: false }` — the door is `aria-disabled` and says
 *   `SEGMENTS_FILE_NO_PASSAGE_REASON`. Survey answers never join: the file is the coding
 *   import's segments-arm input, keyed by *Unit ID* (`coding-import.md` §2).
 * - `exclude_facilitator` ALWAYS sent (#1297's second rule) and the EFFECTIVE coder scope
 *   (#499, blind-forced), as `sourceDataCsvParams`. The participant filter is the route's to
 *   apply as the screens do (D113 — since #1536 the one rule in the server's
 *   `services/participant_filter.py`: a turn by its speaker, a document passage by the person
 *   its document is linked to, no clip).
 */
export function codedSegmentsFileRequest(
  codes: Iterable<number>,
  sel: QualSourceSelection,
  mode: QualSourceMode,
  opts: { excludeFacilitator: boolean; participantIds: number[]; coderIdsCsv?: string },
): CodedSegmentsFile {
  const selected = comparisonSources(sel)
  const anySelected = Object.keys(selected).length > 0
  const { text_column_ids: questions, ...passageKinds } = anySelected ? selected : kindsTheModeLeavesOut(mode)
  // A kind that is absent is every source of it; one present and empty is none.
  const passages = [passageKinds.conversation_ids, passageKinds.document_ids, passageKinds.observation_ids]
    .some(ids => ids === undefined || ids.length > 0)
  if (!passages) return { passages: false }
  const params: CodedSegmentsParams = {
    ...comparisonSourceParams(passageKinds),
    exclude_facilitator: String(opts.excludeFacilitator),
  }
  const code_ids = [...codes]
  if (code_ids.length) params.code_ids = code_ids.join(',')
  if (opts.participantIds.length) params.participant_ids = opts.participantIds.join(',')
  if (opts.coderIdsCsv) params.coder_ids = opts.coderIdsCsv
  // With nothing selected, `questions` is the mode's `[]` or absent — only a selection names one.
  return { passages: true, params, answersLeftOut: (questions?.length ?? 0) > 0 }
}

/** A comparison group whose share the server declined to compute, and why. */
export interface UndefinedComparisonGroup {
  group: string
  reason: string | null
}

/**
 * #1421 — the groups of a qualitative comparison that have no share to report.
 *
 * A group with no segments in the material compared used to arrive as `0.0`, so
 * the table printed "0.0%", the difference read as the other group's whole share,
 * and every code was ranked by it. The server now sends `proportion: null` with an
 * `undefined_reason`, keyed on the group's segment total, so it is the same for
 * every code of that group.
 *
 * ⚠️ Read from the cells the server marked, never re-derived from
 * `group_totals[g].total_segments === 0` here: the reason is the server's to give
 * (`statistics.md` §1), and a second derivation is how a table and its note start
 * to disagree.
 */
export function undefinedComparisonGroups(data: DemographicComparisonResponse): UndefinedComparisonGroup[] {
  const out: UndefinedComparisonGroup[] = []
  for (const group of data.groups) {
    const cell = data.codes.find(e => e.by_group[group] != null)?.by_group[group]
    if (cell && cell.proportion == null) out.push({ group, reason: cell.undefined_reason })
  }
  return out
}

/**
 * The comparison bar chart's rows: one per code, the bar per group is the COUNT
 * (a real 0 for a group with no segments), and `_prop_<group>` feeds the tooltip.
 *
 * 🔴 #1421: `_prop_<group>` is `null` when the server sent no share — never `?? 0`.
 * This line was `stats?.proportion ?? 0`, which the compiler cannot flag (it accepts
 * the new `null` silently) and which printed "(0.0%)" for a group with no segments.
 */
export function comparisonBarRows(entries: CodeComparisonEntry[], groups: string[]): ChartDataRow[] {
  return entries.map(entry => {
    const row: ChartDataRow = {
      label: entry.code_name.length > 28
        ? entry.code_name.slice(0, 25) + '…'
        : entry.code_name,
      _fullLabel: entry.code_name,
      _codeId: entry.code_id,
    }
    for (const g of groups) {
      const stats = entry.by_group[g]
      row[g] = stats?.count ?? 0
      row[`_prop_${g}`] = stats?.proportion ?? null
    }
    return row
  })
}
