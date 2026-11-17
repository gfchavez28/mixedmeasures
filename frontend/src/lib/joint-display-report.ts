/**
 * The joint display's REPORT table (D174, D176; mockups `6-word-export.html`, `8-report-view.html`)
 * — layout A's shape: one row per construct, a column per group, the difference between two
 * groups, the fit, the meta-inference and (when on) the implication, a labelled note under it.
 *
 * 🔴 **ONE pure function feeds four readers** — the Report view on the Canvas, and the Markdown,
 * HTML/PDF and Word exports — so the preview and the file cannot say different things (D176.2;
 * the canvas rule that a new embed's export is taught with its renderer, #817/#832, applied once
 * instead of twice). Its cells are therefore plain text, as Word's are (D174: no italics in a
 * Word cell in slice 1). Every number is printed by `lib/joint-display.ts`'s formatters — the
 * Compact view's and the drift baseline's — and every word by `lib/joint-display-vocabulary.ts`.
 *
 * What it states and where (D174):
 * - the table TITLE names the display type (Younas, Pedersen & Durante 2020 advise labelling it);
 * - each group's heading gives its size; each cell its own n (D168.1);
 * - a different-unit result stands BESIDE its construct on a row of its own, never in a group's
 *   cell (D165), and its own table follows the display (`appendix`);
 * - the NOTE: the groups and their unit, the bases, the rating basis, how a difference is
 *   read and that no test is reported (D172), the fit and meta-inference-type definitions, the
 *   quotes' roles and attribution, the coder scope while blind (`exports-wire.md` §6), the
 *   references that did not travel (D202), and the date the numbers were read (the display in
 *   the app is live, a file is not).
 *
 * While blind (D170, #964) a colleague's authorship reads "a colleague"; otherwise the author is
 * named — a file is read by people who are not "you".
 */
import { loadFailureReason } from '@/lib/list-status'
import type { JointDisplayComputeResponse, JointDisplayPinFact, JointDisplayRowResult, JointDisplayStrandResult } from '@/lib/api'
import type { ExportTable } from '@/lib/canvas-export'
import { mdBlock, mdLine } from '@/lib/markdown-text'
import {
  primaryFit,
  codeCellNote, codeDifferenceNote, effectNote, formatCodeDifference, formatEffect,
  formatObservationCode, formatRatingCell, formatStrandCodeCell, formatVariableCell, ratingCellNote, unresolvedReferenceCount, variableCellNote,
  type JointDisplay, type JointDisplayPin, type JointDisplayRow,
} from '@/lib/joint-display'
import {
  ATTRIBUTION_MODES, FORMED_GROUPS_HELP, FORMED_GROUPS_NOTE, IMPLICATION_CITATION,
  OBSERVATION_ABSENT_TEXT, OBSERVATION_BASIS_TEXT, OBSERVATION_BESIDE_TEXT, OBSERVATION_CLIPS_AGREED_TEXT, OBSERVATION_CLIPS_OPEN_TEXT,
  OBSERVATION_RATING_TEXT,
  observationClipsMixedText,
  CODED_COUNT_BASIS_TEXT, PAIR_NOT_APPLICABLE_LABEL, SURVEY_CELL_BASIS_TEXT, TEXT_CODES_BASIS_TEXT, STRAND_KIND_TERMS, STRAND_OVERVIEW_CELL, STRAND_OVERVIEW_NOTE, STRAND_OVERVIEW_TITLE, fitPairText,
  META_INFERENCE_CITATION, META_INFERENCE_LEVELS, META_INFERENCE_TYPES, NOT_SUMMARISABLE_TEXT, RATING_WITHHELD_TEXT,
  PIN_ROLES, RATED_LINE_TAG, RATING_BASIS_TEXT, SERVER_VOCABULARY as V, STRAND_NOT_MEASURED_TEXT, fitTerm,
  fitVocabulary, metaInferenceTypeLabel, GROUPING_GONE_TEXT, inactiveCodeText, notMeasuredClause,
  otherDatasetVariablesText,
} from '@/lib/joint-display-vocabulary'
import type { DisplayResult } from '@/lib/joint-display-results'
import {
  codeStrandNoCoding, displayStrands, isImplicitPair, pairNotApplicable, rowFits, rowRatedCodes, rowStrands, strandTag,
  type ResolvedStrand,
} from '@/lib/joint-display-strands'
import { boundResultIds } from '@/lib/joint-display-results'
import { NO_VALUE } from '@/lib/stat-format'
import { noCodingNote, noCodingScope } from '@/lib/coding-completeness'
import { withheldAttributionNote } from '@/lib/blind-rating-columns'
import { misfitNoteLine, ruleSentence } from '@/lib/joint-display-misfit'
import { hasMisfit, misfitNoteInputs, ruleNamesFrom, type MisfitReportFacts } from '@/lib/joint-display-cases'
import { formatWrittenDate, pinAttribution } from '@/components/canvas/joint-display/display-helpers'

// ── The shape every reader renders ───────────────────────────────────────────────────

export interface ReportConstructRow {
  kind: 'construct'
  /** The display row's key — the Report view's link back to Compact (D176.6). */
  rowKey: string
  construct: string
  /** One per header after the first. */
  cells: string[]
}

/** A different-unit result, beside its construct across every column (D165). */
export interface ReportBesideRow {
  kind: 'beside'
  rowKey: string
  text: string
}

export type ReportRow = ReportConstructRow | ReportBesideRow

/** A saved result's own table, printed after the display it stands beside. */
export interface ReportAppendix {
  title: string
  table: ExportTable
}

export interface JointDisplayReport {
  title: string
  /** Set when there is nothing to tabulate — the ONE sentence every format prints instead. */
  message: string | null
  headers: string[]
  rows: ReportRow[]
  note: string
  appendix: ReportAppendix[]
}

/** A bound result as the report reads it: what it is, and its own table (null: none shaped). */
export type ReportResult = DisplayResult & { table: ExportTable | null }

export interface ReportContext {
  /** A coder's name by `users.id` — a meta-inference's author (D170). */
  coderName: (id: number) => string | null
  /** True while blind mode withholds (#964, fails closed) — never the display flag `blind`. */
  withholding: boolean
  self: number | null
  /** When the numbers were read, as printed ("12 Nov 2026"). */
  asOf: string
}

export interface ReportInputs {
  display: JointDisplay
  /** The live numbers — null when there are none; `unavailable` then says why. */
  data: JointDisplayComputeResponse | null
  unavailable: string | null
  /** The pins' live facts; null when they could not be read (then said, never "gone"). */
  facts: Map<number, JointDisplayPinFact> | null
  /**
   * #1615 D286 — the attribution column's NAME when the pins' answer said its value was left
   * out while blind (`column_withheld`), else null. REQUIRED so every reader decides it.
   */
  attributionWithheld: string | null
  /**
   * #1653 (D346) — the sentence when the attribution column could not be read (gone, or retyped),
   * from `attributionUnusableNote`, else null. REQUIRED, as `attributionWithheld` is.
   */
  attributionUnusable: string | null
  /** Bound saved results by Material id; an id absent here is no longer in the project. */
  results: Map<number, ReportResult>
  /**
   * True when the saved results could not be READ (their list failed) — then every bound one
   * says so, never "no longer in this project", which would be a false claim (`list-load-state.md`).
   */
  resultsUnread: boolean
  /**
   * Joint display slice 2, round 2 (r5-8, r3-11): each row's "cases that don't fit" facts, by
   * row key — the count and the added and removed cases' identifiers, read under the SAME lens
   * as `data`, or 'unread'. REQUIRED so every reader decides it (the Report view from its
   * queries, the export from its own reads); a row with no misfit needs no entry.
   */
  misfits: Map<string, MisfitReportFacts>
}

// ── The sentences a display prints when it has no table (shared with the Compact view) ──

/** #1639 (r1-5): a stored display with no grouping variable lost it (the builder never saves one
 *  without) — it was "This display has no grouping variable yet.", false for every stored one. */
export const NO_GROUPING_TEXT = GROUPING_GONE_TEXT

/** Why a compute failed, in words — ONE function for the Compact view, the Report view and the
 *  Canvas export. #1639 (r1-5): the server's `GROUPING_GONE` refusal is the display's own
 *  sentence, not "could not be computed. That variable is not in this project." */
export function computeFailureText(error: unknown): string {
  if (isGroupingGone(error)) return GROUPING_GONE_TEXT
  return `The joint display could not be computed. ${loadFailureReason(error)}`
}

/** The grouping variable is gone — keyed on the server's code, never its text. The compute sends
 *  it (D324), and since #1653 (D347) the pin picker's passages and the case view's cases too, so
 *  each says `GROUPING_GONE_TEXT` with no Retry (nothing to retry). */
export function isGroupingGone(error: unknown): boolean {
  const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail
  return (detail as { code?: unknown } | null)?.code === V.GROUPING_GONE
}

/** Why a computed display drew no groups — the server's reason in words. */
export function unavailableGroupsText(data: JointDisplayComputeResponse): string {
  return data.unavailable_reason === 'no_group_values'
    ? `Nobody has a value for ${data.group_by.name} — check that ${data.group_by.dataset_name ?? 'its dataset'}’s rows are linked to participants.`
    : 'The groups could not be formed.'
}

// ── Building it ──────────────────────────────────────────────────────────────────────

const DISPLAY_TYPE = 'Side-by-side joint display by construct'

function sentence(s: string): string {
  const t = s.trim()
  return t === '' || /[.!?…]$/.test(t) ? t : `${t}.`
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s
}

function bare(s: string): string {
  return s.trim().replace(/[.]$/, '')
}

/** A reason in parentheses after a value — its own full stop dropped ("(Too few values.)." read twice). */
function aside(reason: string | null): string {
  return reason ? ` (${bare(reason)})` : ''
}

/**
 * A vocabulary as a note lists it: "Label: Definition." per term — each definition VERBATIM from
 * `lib/joint-display-vocabulary.ts`, the words the Compact view shows beside the same choice.
 * (Joined into one "a, b; c, d" list, a definition holding a semicolon ran into the next term.)
 */
function definitions(terms: { label: string; definition: string }[]): string {
  return terms.map(t => `${t.label}: ${sentence(t.definition)}`).join(' ')
}

/** D174's note: "Strands: Interviews and Focus groups (codes); Baseline survey (survey variables); …". */
export function strandsSentence(display: JointDisplay): string {
  const parts = STRAND_KIND_TERMS.map(k => {
    const tags = displayStrands(display).filter(s => s.kind === k.key).map(s => strandTag(display, s))
    if (tags.length === 0) return null
    const list = tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`
    return `${list} (${k.label.toLowerCase()})`
  }).filter((x): x is string => x != null)
  return `Strands: ${parts.join('; ')}.`
}

export function reportTitle(display: JointDisplay, data: JointDisplayComputeResponse | null): string {
  const t = display.title.trim()
  if (t) return `${DISPLAY_TYPE}: ${t}`
  return data ? `${DISPLAY_TYPE}, by ${data.group_by.name}` : DISPLAY_TYPE
}

function strandLabel(name: string, formed: string | null): string {
  return formed ? `${name} (formed the groups)` : name
}

function pinText(
  pin: JointDisplayPin,
  facts: Map<number, JointDisplayPinFact> | null,
  attribution: JointDisplay['attribution'],
): string {
  let who: string
  if (pin.excerptId == null) who = ''
  else if (facts == null) who = 'attribution could not be read'
  else who = pinAttribution(pin, facts.get(pin.excerptId), attribution)
  const role = PIN_ROLES.find(r => r.key === pin.role)?.label.toLowerCase() ?? ''
  const meta = [who, role].filter(Boolean).join(', ')
  let text = `“${pin.displayText}”${meta ? ` (${meta})` : ''}`
  if (pin.role === 'discrepant' && pin.purpose.trim()) text += ` — ${pin.purpose.trim()}`
  return text
}

/** #1659 — "not measured (<why>)" inside a cell's sentence; the bare words with no reason. */
function notMeasuredInCell(rs: ResolvedStrand): string {
  const clause = notMeasuredClause(rs.notMeasuredReason, rs.strand.kind)
  return clause ? `not measured (${clause})` : 'not measured'
}

/**
 * One group's cell: each PER-GROUP strand in display order (joint display slice 2 — r2-2: each
 * line tagged with its strand, "Survey:"/"Coded:" on a slice-1 display), then its quotes.
 */
function groupCell(
  display: JointDisplay,
  row: JointDisplayRow,
  result: JointDisplayRowResult,
  group: string,
  facts: Map<number, JointDisplayPinFact> | null,
  strandFacts: JointDisplayStrandResult[] | undefined,
): string {
  const parts: string[] = []
  const strands = rowStrands(display, result, strandFacts)
  for (const rs of strands) {
    if (rs.placement !== 'per_group' || !rs.result) continue
    const tag = rs.tag
    if (rs.notMeasured) { parts.push(`${tag}: ${notMeasuredInCell(rs)}.`); continue }
    if (rs.result.kind === 'variables') {
      for (const s of rs.result.variables) {
        const name = strandLabel(s.name, s.formed_groups)
        if (s.unavailable_reason === V.VARIABLE_RATING_WITHHELD) {  // #1615 — before the generic arm
          parts.push(`${tag}: ${name}: ${lowerFirst(RATING_WITHHELD_TEXT)}`)
          continue
        }
        if (s.summary == null || s.summary === V.VARIABLE_NOT_SUMMARISABLE) {
          parts.push(`${tag}: ${name}: ${lowerFirst(NOT_SUMMARISABLE_TEXT)}`)
          continue
        }
        const c = s.cells.find(x => x.group === group)
        const note = c ? variableCellNote(c) : null
        parts.push(sentence(`${tag}: ${name} ${c ? formatVariableCell(s, c) : NO_VALUE}${aside(note)}`))
      }
    } else if (rs.result.kind === 'codes' || rs.result.kind === 'text_codes') {
      const kind = rs.result.kind
      for (const s of rs.result.codes) {
        const c = s.cells.find(x => x.group === group)
        const note = c ? codeCellNote(c) : null
        // r2-12: a survey comments cell carries its group's surveyed count (the strand's facts).
        const surveyed = rs.facts?.groups?.find(g => g.key === group)?.surveyed
        parts.push(sentence(`${tag}: ${strandLabel(s.name, s.formed_groups)} ${c ? formatStrandCodeCell(kind, c, surveyed) : NO_VALUE}${aside(note)}`))
      }
    }
  }
  // #1645 — a rated code ONCE, after the strands and under no strand's name (it was "; rated …"
  // after each strand's line, the same person-level number under each): `rowRatedCodes`.
  for (const s of rowRatedCodes(strands)) {
    const c = s.cells.find(x => x.group === group)
    const rn = c ? ratingCellNote(c) : null
    parts.push(sentence(`${RATED_LINE_TAG}: ${s.name} ${c ? (formatRatingCell(c) ?? NO_VALUE) : NO_VALUE}${aside(rn)}`))
  }
  for (const p of row.pins.filter(x => x.group === group)) parts.push(pinText(p, facts, display.attribution))
  return parts.length ? parts.join(' ') : NO_VALUE
}

/**
 * Joint display slice 2 (r2-6) — an observation strand's line BESIDE its construct: drawn once
 * across the groups, never split by group (D165), with the reason in the same sentence.
 */
export function observationBesideText(construct: string, tag: string, rs: ResolvedStrand): string {
  if (rs.notMeasured || !rs.result || rs.result.kind !== 'observation_codes') {
    return `Beside “${construct}”: ${tag}: ${notMeasuredInCell(rs)}.`
  }
  const codes = rs.result.observation_codes.map(c => `${c.name} ${formatObservationCode(c)}`).join('; ')
  // R6: the strand's observations are its display-level facts (`response.strands[i].observations`).
  const chosen = rs.facts?.observations?.chosen
  const over = chosen != null ? ` (${chosen} ${chosen === 1 ? 'observation' : 'observations'})` : ''
  // D304: a RATED code on clips draws no rating, and says why (the server's `RATING_NOT_ON_CLIPS`;
  // the prototype defined the sentence and rendered it nowhere — found by the build's drive).
  // Here, the ONE beside sentence, so the Compact view, the Report view and every file carry it.
  const unrated = rs.result.observation_codes.some(c => c.rating_unavailable_reason === V.RATING_NOT_ON_CLIPS)
  // A time share drawn as "—" says why (the server's `time_share_undefined_reason`; the prototype
  // left `OBSERVATION_ABSENT_TEXT` unread). A clip count's absence is the note's open-cuts sentence.
  const absent = [...new Set(rs.result.observation_codes.map(c => c.time_share_undefined_reason))]
    .flatMap(r => (r && OBSERVATION_ABSENT_TEXT[r] ? [` ${OBSERVATION_ABSENT_TEXT[r]}`] : []))
  return `Beside “${construct}”: ${tag}${over}: ${codes || NO_VALUE}.${absent.join('')} ${OBSERVATION_BESIDE_TEXT}${unrated ? ` ${OBSERVATION_RATING_TEXT}` : ''}`
}

/** A between-group number, or — where there is none — the sentence saying why. */
function differenceLine(name: string, value: string, note: string | null): string {
  if (value === NO_VALUE && note) return sentence(`${name}: ${note}`)
  return sentence(`${name}: ${value}${aside(note)}`)
}

/** A between-group line's name — the strand's tag after it on a display with named strands (r2-2). */
function strandItemName(display: JointDisplay, name: string, tag: string): string {
  return isImplicitPair(display) ? name : `${name} (${tag})`
}

function differencesCell(display: JointDisplay, result: JointDisplayRowResult): string {
  const lines: string[] = []
  for (const rs of rowStrands(display, result)) {
    if (rs.placement !== 'per_group' || !rs.result || rs.notMeasured) continue
    if (rs.result.kind === 'variables') {
      for (const s of rs.result.variables) lines.push(differenceLine(strandItemName(display, s.name, rs.tag), formatEffect(s), effectNote(s)))
    } else if (rs.result.kind === 'codes' || rs.result.kind === 'text_codes') {
      for (const s of rs.result.codes) lines.push(differenceLine(strandItemName(display, s.name, rs.tag), formatCodeDifference(s), codeDifferenceNote(s)))
    }
  }
  return lines.length ? lines.join(' ') : NO_VALUE
}

/**
 * Each strand's status as the fit cell lists it (D169.2): "survey not measured" on a slice-1
 * display (its words, unchanged), "Focus groups silent" on a display with named strands.
 */
export function strandStatusList(display: JointDisplay, row: JointDisplayRow, result: JointDisplayRowResult | null): string[] {
  const out: string[] = []
  for (const rs of rowStrands(display, result)) {
    const name = isImplicitPair(display) ? rs.tag.toLowerCase() : rs.tag
    if (rs.notMeasured) out.push(`${name} not measured`)
    else if (row.status[rs.strand.key] === 'silent') out.push(`${name} silent`)
  }
  return out
}

/**
 * r2-3 — each recorded fit WITH its pair on a display with named strands ("Interviews · Survey:
 * expansion"; the literature's L1: a fit is defined over a pair), a derived "not applicable" for
 * a pair where neither strand has evidence (r2-8); slice 1's one label on a slice-1 display.
 * Shared by the Compact view's Fit column, so the two print the same words.
 */
export function fitText(display: JointDisplay, row: JointDisplayRow, result: JointDisplayRowResult | null): string {
  const vocabulary = fitVocabulary(display.settings.fit_vocabulary)
  if (isImplicitPair(display)) return fitTerm(vocabulary, primaryFit(row))?.label ?? 'Not set'
  return rowFits(display, row).map(({ pair, fit }) => {
    const label = pairNotApplicable(display, row, result, pair)
      ? lowerFirst(PAIR_NOT_APPLICABLE_LABEL)
      : lowerFirst(fitTerm(vocabulary, fit)?.label ?? 'Not set')
    return `${fitPairText(strandTag(display, pair[0]), strandTag(display, pair[1]))}: ${label}`
  }).join('; ') || 'Not set'
}

function fitCell(row: JointDisplayRow, result: JointDisplayRowResult | null, display: JointDisplay): string {
  const statuses = strandStatusList(display, row, result)
  const label = fitText(display, row, result)
  return statuses.length ? `${label} (${statuses.join('; ')})` : label
}

/**
 * r2-9 — the extended Pillar Integration Process's write-up overview (Gauly et al. 2024): each
 * construct against each strand, identified or not. Printed after the display when it has three
 * or more strands (with two, the fit cell already says it); derived from what the rows draw.
 */
function strandOverview(display: JointDisplay, byKey: Map<string, JointDisplayRowResult>): ReportAppendix | null {
  const strands = displayStrands(display)
  if (isImplicitPair(display) || strands.length < 3) return null
  const rows = display.rows.map(row => {
    const result = byKey.get(row.key) ?? null
    const resolved = rowStrands(display, result)
    return [row.construct.trim() || 'Untitled construct', ...strands.map(st => {
      const rs = resolved.find(x => x.strand.key === st.key)
      if (!result || !rs?.result) return NO_VALUE
      if (rs.notMeasured) return STRAND_OVERVIEW_CELL.not_measured
      return row.status[st.key] === 'silent' ? STRAND_OVERVIEW_CELL.silent : STRAND_OVERVIEW_CELL.covers
    })]
  })
  return {
    title: STRAND_OVERVIEW_TITLE,
    table: { headers: ['Construct', ...strands.map(st => strandTag(display, st))], rows, note: STRAND_OVERVIEW_NOTE },
  }
}

function authorLabel(authorId: number | null, ctx: ReportContext): string {
  if (authorId == null) return 'a coder not on this install'
  if (ctx.withholding && authorId !== ctx.self) return 'a colleague'
  return ctx.coderName(authorId) ?? 'a coder not on this install'
}

function metaCell(row: JointDisplayRow, ctx: ReportContext): string {
  const m = row.meta_inference
  if (!m || !m.text.trim()) return 'Not written.'
  const type = metaInferenceTypeLabel(m.level, m.type)
  const byline = [authorLabel(m.author_id, ctx), formatWrittenDate(m.written_at)].filter(Boolean).join(', ')
  return `${type ? `(${type}) ` : ''}${m.text.trim()} — ${byline}`
}

/**
 * The sentence a different-unit result stands beside its construct with (D165) — in the report's
 * beside row AND in the Compact view's open construct, so the two say it in the same words.
 */
export function besideSentence(
  construct: string, id: number | null, results: Map<number, ReportResult>, unread: boolean, formed: boolean,
  /** Where its own table is: after the whole display (the report) or right under the sentence (Compact). */
  tablePlace: 'after the display' | 'below' = 'after the display',
): string {
  if (id == null) return `Beside “${construct}”: a saved result that did not travel with the project.`
  if (unread) return `Beside “${construct}”: a saved result that could not be read just now.`
  const r = results.get(id)
  if (!r) return `Beside “${construct}”: a saved result that is no longer in this project.`
  if (r.unit == null) {
    return `Beside “${construct}”: ${r.name}, a saved result that cannot stand beside a construct here (a comparison, a cross-tabulation or a summary of survey data can).`
  }
  // ⚠️ "May not be": MM states the unit from the result's own settings, and cannot tell from them
  // whether its rows are the same people (a result over the participant-linked dataset, grouped
  // otherwise) — so the sentence claims the unit, never that it differs (driven, session C).
  let text = `Beside “${construct}”: ${r.name}, ${r.kindText} (${r.unit}). It stands beside the row as saved: its unit is stated from its source and may not be the display's participants, so it is drawn once across the groups and never split by group.`
  if (formed) text += ` It was marked as the source of the groups: ${lowerFirst(FORMED_GROUPS_NOTE)}`
  text += r.table
    ? (tablePlace === 'below' ? ' Its own table is below.' : ' Its own table follows the display.')
    : ' It has no table to show.'
  return text
}

/**
 * The report table for one display. Pure: every input is passed in, so the Report view (from
 * its queries) and the export (from its own reads, under the export's lens) build the same one.
 */
export function buildJointDisplayReport(inputs: ReportInputs, ctx: ReportContext): JointDisplayReport {
  const { display, data, facts, results } = inputs
  const title = reportTitle(display, data)
  const empty = (message: string): JointDisplayReport =>
    ({ title, message, headers: [], rows: [], note: '', appendix: [] })
  if (!data) return empty(inputs.unavailable ?? NO_GROUPING_TEXT)
  if (data.unavailable_reason) return empty(unavailableGroupsText(data))

  const groups = data.groups
  const two = groups.length === 2
  const implication = display.settings.implication
  const headers = [
    'Construct',
    ...groups.map(g => `${g.key} (${g.participants} ${g.participants === 1 ? 'participant' : 'participants'})`),
    ...(two ? [`${groups[0].key} − ${groups[1].key}`] : []),
    'Fit',
    'Meta-inference (type)',
    ...(implication ? ['Implication'] : []),
  ]
  const byKey = new Map(data.rows.map(r => [r.key, r]))
  const rows: ReportRow[] = []
  const appendix: ReportAppendix[] = []
  const appended = new Set<number>()
  let anyCodes = false, anyVariables = false, anyFormed = false, anyNotMeasured = false, anyPins = false
  let missingItems = 0
  let otherDatasetItems = 0  // #1665 (D336): in the project, so never counted as missing
  let anyObservations = false
  let anyText = false
  const observationSegmentation = new Set<string>()
  const mixedClipsTexts = new Set<string>()
  const typesUsed = new Set<string>()
  const levelsUsed = new Set<string>()

  for (const row of display.rows) {
    const result = byKey.get(row.key) ?? null
    const construct = row.construct.trim() || 'Untitled construct'
    const groupCells = groups.map(g =>
      result ? groupCell(display, row, result, g.key, facts, data.strands) : 'Not computed.')
    rows.push({
      kind: 'construct',
      rowKey: row.key,
      construct,
      cells: [
        ...groupCells,
        ...(two ? [result ? differencesCell(display, result) : NO_VALUE] : []),
        fitCell(row, result, display),
        metaCell(row, ctx),
        ...(implication ? [row.implication.trim() || 'Not written.'] : []),
      ],
    })
    // Joint display slice 2 (r2-6): an observation strand stands beside its construct.
    for (const rs of rowStrands(display, result, data.strands)) {
      if (rs.placement !== 'beside' || !result) continue
      rows.push({ kind: 'beside', rowKey: row.key, text: observationBesideText(construct, rs.tag, rs) })
      anyObservations = true
      const obs = rs.facts?.observations
      if (rs.result?.kind === 'observation_codes' && !rs.notMeasured && obs?.segmentation) {
        observationSegmentation.add(obs.segmentation)
        // R6: with mixed segmentation, clips count in the AGREED observations only — say how many.
        if (obs.segmentation === V.STRAND_SEGMENTATION_MIXED) mixedClipsTexts.add(observationClipsMixedText(obs.agreed, obs.chosen))
      }
    }
    for (const id of boundResultIds(row.result_material_ids)) {
      rows.push({
        kind: 'beside', rowKey: row.key,
        text: besideSentence(construct, id, results, inputs.resultsUnread, row.results_marked_formed),
      })
      const r = id != null && !inputs.resultsUnread ? results.get(id) : undefined
      if (r?.table && r.unit != null && !appended.has(r.materialId)) {
        appended.add(r.materialId)
        appendix.push({ title: `${r.name} (${r.kindText}; ${r.unit})`, table: r.table })
      }
    }
    if (result) {
      for (const rs of rowStrands(display, result)) {
        if (rs.result?.kind === 'text_codes') {
          anyText ||= rs.result.codes.length > 0
          anyFormed ||= rs.result.codes.some(s => s.formed_groups)
        } else if (rs.result?.kind === 'codes') {
          anyCodes ||= rs.result.codes.length > 0
          anyFormed ||= rs.result.codes.some(s => s.formed_groups)
        } else if (rs.result?.kind === 'variables') {
          anyVariables ||= rs.result.variables.length > 0
          anyFormed ||= rs.result.variables.some(s => s.formed_groups)
        }
        anyNotMeasured ||= rs.notMeasured
      }
      missingItems += result.missing_code_ids.length + result.missing_column_ids.length
      otherDatasetItems += (result.other_dataset_column_ids ?? []).length
    }
    anyFormed ||= row.results_marked_formed && row.result_material_ids.length > 0
    anyPins ||= row.pins.length > 0
    const m = row.meta_inference
    if (m?.text.trim()) {
      if (m.level) levelsUsed.add(m.level)
      if (m.level && m.type) typesUsed.add(m.type)
    }
  }

  // ── The note (D174) ────────────────────────────────────────────────────────────────
  const s: string[] = []
  const ds = data.group_by.dataset_name ? ` (${data.group_by.dataset_name})` : ''
  s.push(`Groups: the participants with each value of ${data.group_by.name}${ds}; each heading gives the group's size.`)
  // Joint display slice 2 (r2-2, D174's "each strand and its unit"): the named strands, by kind.
  if (!isImplicitPair(display)) s.push(strandsSentence(display))
  const without = data.scope.participants_without_group
  if (without > 0) {
    s.push(`${without} ${without === 1 ? 'participant has' : 'participants have'} no ${data.group_by.name} and ${without === 1 ? 'is' : 'are'} in no group.`)
  }
  if (anyCodes) {
    s.push(CODED_COUNT_BASIS_TEXT)
    // #1626 (D244): who of them has no coding in scope, and what that does to a share —
    // here, so the Report view and every export say it (the one function they read).
    // R3: with two or more code strands, each strand's own denominators, named.
    for (const n of codeStrandNoCoding(display, data)) {
      const noCoding = noCodingNote(n.counts, noCodingScope(n.scope))
      if (noCoding) s.push(n.tag ? `${n.tag}: ${noCoding}` : noCoding)
    }
  }
  if (anyVariables) {
    s.push(SURVEY_CELL_BASIS_TEXT)
  }
  if (anyText) s.push(TEXT_CODES_BASIS_TEXT)
  if (data.rating) s.push(RATING_BASIS_TEXT)
  if (anyObservations) {
    s.push(OBSERVATION_BASIS_TEXT)
    if (observationSegmentation.has(V.STRAND_SEGMENTATION_OPEN)) s.push(OBSERVATION_CLIPS_OPEN_TEXT)
    if (observationSegmentation.has(V.STRAND_SEGMENTATION_AGREED)) s.push(OBSERVATION_CLIPS_AGREED_TEXT)
    for (const text of mixedClipsTexts) s.push(text)
    s.push(OBSERVATION_BESIDE_TEXT)
  }
  if (anyCodes || anyVariables || anyText) {
    if (two) {
      const coded = display.settings.newcombe
        ? 'a coded difference is in percentage points, its interval unadjusted, over the participants in these groups'
        : 'a coded difference is in percentage points with no interval, because coded passages come from a chosen sample, not one built for estimation'
      s.push(`Differences are ${groups[0].key} − ${groups[1].key}: d is Cohen's d, with its interval labelled beside it; ${coded}. No significance tests are reported.`)
    } else {
      s.push('A difference is stated between two groups only, so none is shown. No significance tests are reported.')
    }
  }
  if (anyFormed) s.push(FORMED_GROUPS_HELP)
  const vocabulary = fitVocabulary(display.settings.fit_vocabulary)
  s.push(`Fit, after ${bare(vocabulary.citation)}. ${definitions(vocabulary.terms)}`)
  if (anyNotMeasured) s.push(STRAND_NOT_MEASURED_TEXT)
  if (levelsUsed.size > 0) {
    // Only the types the display USES — a note defining every term would bury the bases.
    const used = [
      ...META_INFERENCE_LEVELS.filter(t => levelsUsed.has(t.key)),
      ...META_INFERENCE_TYPES.filter(t => typesUsed.has(t.key)),
    ]
    s.push(`Meta-inference types used here. ${definitions(used)} ${META_INFERENCE_CITATION}`)
  }
  if (anyPins) {
    const by = ATTRIBUTION_MODES.find(m => m.key === display.attribution.label)?.label.toLowerCase() ?? 'participant identifier'
    s.push(`Quotes are chosen by the researcher and labelled with their role. ${definitions(PIN_ROLES)} Each is attributed by ${by}.`)
    // #1615 D286: the value beside each quote was left out while blind — said, never a gap.
    if (inputs.attributionWithheld) s.push(withheldAttributionNote(inputs.attributionWithheld))
    // #1653 (D346): the value beside each quote could not be read — who and where still are.
    if (inputs.attributionUnusable) s.push(inputs.attributionUnusable)
  }
  // Joint display slice 2, round 2 (r5-8, r3-11): each row's cases that don't fit — the rule,
  // its count, each added and removed case with its reason; NEVER a rule-selected case's
  // identifier (Kaiser 2009), and a case named only as the display names a quote (r3-7).
  for (const r of display.rows) {
    if (!hasMisfit(r)) continue
    const facts = inputs.misfits.get(r.key)
    const { countText, identifier } = misfitNoteInputs(facts)
    const conditions = r.misfit!.rule?.conditions ?? []
    const res = byKey.get(r.key) ?? null
    const strands = rowStrands(display, res)
    const names = ruleNamesFrom(display, data.group_by.name, {
      codes: strands.flatMap(rs => rs.result?.codes ?? []),
      variables: strands.flatMap(rs => rs.result?.variables ?? []),
      inactive: res?.inactive_codes,  // #1664 (D333): a rule naming one names it
    })
    const line = misfitNoteLine({
      construct: r.construct.trim(), misfit: r.misfit!, attribution: display.attribution.label,
      sentence: conditions.length ? ruleSentence(conditions, names) : undefined, countText, identifier,
    })
    if (line) s.push(line)
    // With no rule there is no count to carry the unread sentence: say it after the cases.
    if (line && !conditions.length && (facts == null || facts === 'unread')) s.push(countText)
  }
  if (implication) s.push(IMPLICATION_CITATION)
  if (ctx.withholding) {
    const me = ctx.self != null ? ctx.coderName(ctx.self) : null
    s.push(`Scope: coders: ${me ?? 'the exporting coder'} (blind mode). Coded counts and ratings are this coder's own, and a colleague's authorship is not named.`)
  }
  const unresolved = unresolvedReferenceCount(display)
  if (unresolved > 0) {
    s.push(`${unresolved} ${unresolved === 1 ? 'reference' : 'references'} in this display did not travel with the project and ${unresolved === 1 ? 'is' : 'are'} shown as missing.`)
  }
  // #1639 follow-up (r1-8): each construct's inactive codes, by name (the Report view and every
  // export read this one note).
  for (const r of display.rows) {
    for (const c of byKey.get(r.key)?.inactive_codes ?? []) {
      s.push(`${r.construct.trim() || 'Untitled construct'}: ${inactiveCodeText(c)}`)
    }
  }
  if (missingItems > 0) {
    s.push(`${missingItems} bound ${missingItems === 1 ? 'item is' : 'items are'} no longer in this project and ${missingItems === 1 ? 'is' : 'are'} left out.`)
  }
  if (otherDatasetItems > 0) s.push(otherDatasetVariablesText(otherDatasetItems))
  s.push(`Numbers as computed on ${ctx.asOf}; in the app the display is live.`)

  const overview = strandOverview(display, byKey)
  return { title, message: null, headers, rows, note: s.map(sentence).join(' '), appendix: overview ? [overview, ...appendix] : appendix }
}

// ── Plain renderings (the Markdown and HTML exports) ────────────────────────────────

// #1422 — the Canvas export's ONE Markdown escape (`lib/markdown-text.ts`), not a second copy:
// this one escaped `\`, `|` and a newline, so a construct named `*Trust*` printed in italics and a
// meta-inference holding `<Trust>` lost the word.
const mdCell = mdLine

function mdGrid(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(mdCell).join(' | ')} |`
  return [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
}

/**
 * Markdown: the title in bold, the table, the note, then each beside result's own table.
 * ⚠️ A Markdown table cannot span columns, so a beside row puts its sentence in the first cell
 * and leaves the others empty; HTML and Word span it.
 */
export function reportToMarkdown(report: JointDisplayReport): string {
  let md = `**${mdCell(report.title)}**\n\n`
  if (report.message) return md + `*${mdCell(report.message)}*\n\n`
  const width = report.headers.length
  const rows = report.rows.map(r => r.kind === 'construct'
    ? [r.construct, ...r.cells]
    : [r.text, ...Array.from({ length: width - 1 }, () => '')])
  md += mdGrid(report.headers, rows) + '\n\n'
  // The notes name coders, groups and codes — user text, escaped as it enters (#1422).
  if (report.note) md += `${mdBlock(report.note)}\n\n`
  for (const a of report.appendix) {
    md += `**${mdCell(a.title)}**\n\n${mdGrid(a.table.headers, a.table.rows)}\n\n`
    if (a.table.note) md += `${mdBlock(a.table.note)}\n\n`
  }
  return md
}

/** HTML: escaped by the caller's `esc` (the export's one escape, #1339). */
export function reportToHtml(report: JointDisplayReport, esc: (s: unknown) => string): string {
  let html = `<div class="chart joint-display"><h4>${esc(report.title)}</h4>\n`
  if (report.message) return html + `<p><em>${esc(report.message)}</em></p></div>\n`
  const width = report.headers.length
  html += '<table>\n<thead><tr>' + report.headers.map(h => `<th scope="col">${esc(h)}</th>`).join('') + '</tr></thead>\n<tbody>\n'
  for (const r of report.rows) {
    html += r.kind === 'construct'
      ? `<tr><th scope="row">${esc(r.construct)}</th>${r.cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>\n`
      : `<tr class="beside"><td colspan="${width}">${esc(r.text)}</td></tr>\n`
  }
  html += '</tbody>\n</table>\n'
  if (report.note) html += `<p class="note">${esc(report.note)}</p>\n`
  for (const a of report.appendix) {
    html += `<h5>${esc(a.title)}</h5>\n<table>\n<thead><tr>${a.table.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>\n<tbody>\n`
    html += a.table.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n')
    html += '\n</tbody>\n</table>\n'
    if (a.table.note) html += `<p class="note">${esc(a.table.note)}</p>\n`
  }
  return html + '</div>\n'
}

/**
 * The Word payload (`POST …/export-docx`'s `display_tables`): the same report, as strings. A
 * beside row is a one-cell row named in `span_rows`, which the server merges across the table.
 */
export interface DocxDisplayTable {
  title: string
  message: string | null
  headers: string[]
  rows: string[][]
  span_rows: number[]
  note: string
  appendix: { title: string; headers: string[]; rows: string[][]; note: string }[]
}

export function reportToDocx(report: JointDisplayReport): DocxDisplayTable {
  const span_rows: number[] = []
  const rows = report.rows.map((r, i) => {
    if (r.kind === 'construct') return [r.construct, ...r.cells]
    span_rows.push(i)
    return [r.text]
  })
  return {
    title: report.title,
    message: report.message,
    headers: report.headers,
    rows,
    span_rows,
    note: report.note,
    appendix: report.appendix.map(a => ({ title: a.title, headers: a.table.headers, rows: a.table.rows, note: a.table.note ?? '' })),
  }
}
