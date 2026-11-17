/**
 * Joint display slice 2 — the display's STRANDS as every reader draws them (r2's part of
 * ROADMAP row 56's slice 2: three or more strands per row, and observation strands).
 *
 * The stored strands are r1's model (`lib/joint-display.ts::JointDisplay.strands` — always
 * materialised: a slice-1 display reads as its implicit pair, keyed `codes` / `variables`); a
 * row's answer per strand is r1's wire (`resultStrands`, the server's `rows[].by_strand`), and a
 * strand's display-level facts are `response.strands[i]`. This module is the ONE place that
 * decides, for the Compact view, the open construct, the Report view and the three exports
 * (`lib/joint-display-report.ts`):
 * - which strands a display draws, in what order — explicit, or slice 1's IMPLICIT PAIR (survey,
 *   then codes: slice 1's drawing order, so a slice-1 display draws exactly as it did);
 * - where a strand is drawn (`strandPlacement`, DERIVED from its kind, r1-1 — never stored):
 *   per group, or beside the groups (observations have no participant link, D165);
 * - what a strand is CALLED in a line, a cell, a status and the fit (`strandTag`, r2-2);
 * - the fits a row shows, each over its NAMED pair (`rowFits`, r2-3 / r1-8 — the stored shape is
 *   always `row.fits`, R2; the model's `MAX_FITS_PER_ROW` is the one switch to shape (i)).
 *
 * Each contestable choice is one function or constant, so a switch is one edit:
 * `strandPlacement`, `strandTag`, the model's `defaultFitPair`, `MAX_FITS_PER_ROW`,
 * `MAX_STRANDS_IN_BUILDER` (vocabulary).
 */
import type {
  JointDisplayCodeStrand, JointDisplayComputeResponse, JointDisplayRowResult, JointDisplayRowStrand, JointDisplayStrandResult,
} from '@/lib/api'
import {
  bindingOf, defaultFitPair, IMPLICIT_CODES_KEY, IMPLICIT_VARIABLES_KEY, isKnownKind, MAX_FITS_PER_ROW, resultStrands,
  type JointDisplay, type JointDisplayBinding, type JointDisplayFit, type JointDisplayRow, type JointDisplayStrand,
  type StrandKind,
} from '@/lib/joint-display'
import {
  IMPLICIT_STRAND_TAG, SERVER_VOCABULARY as V, UNNAMED_STRAND_TAG,
} from '@/lib/joint-display-vocabulary'

// ONE implementation of removing a strand: the model's (r1-8 — its bindings, statuses and every
// fit naming it go with it). Re-exported so the builder's edits read from one module.
export { removeStrand } from '@/lib/joint-display'

export type StrandPlacement = 'per_group' | 'beside'

/** r1-1: placement is DERIVED from the kind — an observation has no participant link (D165). */
export function strandPlacement(kind: string): StrandPlacement {
  return kind === 'observation_codes' ? 'beside' : 'per_group'
}

/**
 * True for a slice-1 display — r1's reader materialises it as exactly two UNNAMED strands keyed
 * `codes` and `variables`, the survey over any dataset (R5: `dataset_id: null`). The builder draws
 * slice 1's controls for it until the first strand edit (`makeStrandsExplicit`, r2-1).
 */
export function isImplicitPair(display: JointDisplay): boolean {
  const s = display.strands
  if (s.length !== 2) return false
  const codes = s.find(x => x.key === IMPLICIT_CODES_KEY)
  const vars = s.find(x => x.key === IMPLICIT_VARIABLES_KEY)
  return codes != null && vars != null && codes.kind === 'codes' && vars.kind === 'variables'
    && !codes.label.trim() && !vars.label.trim() && vars.dataset_id == null
}

/**
 * The display's strands in DRAWING order. Explicit: as stored (r2-1's order). The implicit pair:
 * survey, then codes — slice 1's order. A strand of a kind this build cannot draw (a later
 * release's, r1-9) is kept in the document and never drawn.
 */
export function displayStrands(display: JointDisplay): JointDisplayStrand[] {
  if (!isImplicitPair(display)) return display.strands.filter(s => isKnownKind(s.kind))
  return [...display.strands].sort((a, b) => (a.kind === 'variables' ? -1 : 0) - (b.kind === 'variables' ? -1 : 0))
}

/**
 * r2-2 — what a strand is called wherever it is named: the researcher's label; slice 1's own
 * words ("Coded", "Survey") on the implicit pair; the kind's word for a named strand left blank.
 */
export function strandTag(display: JointDisplay, strand: JointDisplayStrand): string {
  if (isImplicitPair(display) && (strand.kind === 'codes' || strand.kind === 'variables')) return IMPLICIT_STRAND_TAG[strand.kind]
  return strand.label.trim() || UNNAMED_STRAND_TAG[strand.kind as StrandKind] || strand.kind
}

/** A strand key → its tag (the drift line's names); an unknown key reads "a removed strand". */
export function strandTagOf(display: JointDisplay): (key: string) => string {
  const byKey = new Map(displayStrands(display).map(s => [s.key, strandTag(display, s)]))
  return key => byKey.get(key) ?? 'a removed strand'
}

/** What a row binds from a strand (r1's `bindings`, the implicit pair's included). */
export function rowBinding(_display: JointDisplay, row: JointDisplayRow, strand: JointDisplayStrand): JointDisplayBinding {
  return bindingOf(row, strand.key)
}

export interface ResolvedStrand {
  strand: JointDisplayStrand
  tag: string
  placement: StrandPlacement
  /** The row's answer for this strand (`by_strand[key]`) — null before the numbers arrive. */
  result: JointDisplayRowStrand | null
  /** The strand's display-level facts (`response.strands[i]`: a codes strand's groups and scope,
   *  an observation strand's observations) — null on a response that predates them. */
  facts: JointDisplayStrandResult | null
  /** D169.2 — DERIVED by the server: the row draws nothing from this strand (nothing bound, or
   *  nothing bound can be drawn — #1659: never read this as "binds nothing"). */
  notMeasured: boolean
  /** #1659 — the server's reason when `notMeasured` (`notMeasuredText` words it); else null. */
  notMeasuredReason: string | null
}

/** A row's strands, in drawing order, each with its answer and its display-level facts. */
export function rowStrands(
  display: JointDisplay, result: JointDisplayRowResult | null, facts?: JointDisplayStrandResult[] | null,
): ResolvedStrand[] {
  const answers = result ? resultStrands(result) : {}
  return displayStrands(display).map(strand => {
    const r = answers[strand.key] ?? null
    return {
      strand,
      tag: strandTag(display, strand),
      placement: strandPlacement(strand.kind),
      result: r,
      facts: facts?.find(f => f.key === strand.key) ?? null,
      notMeasured: r?.status === V.STRAND_NOT_MEASURED,
      notMeasuredReason: r?.status === V.STRAND_NOT_MEASURED ? (r.not_measured_reason ?? null) : null,
    }
  })
}

/**
 * #1645 — a row's RATED codes, each ONCE, in the order the per-group strands first draw them.
 * A rated cell is the mean of the group's PARTICIPANT scores over every rated passage of each
 * person in the project (D204), so it belongs to no strand: the server computes it per code and
 * group only (`services/joint_display.py::_rating`), the same number under every strand binding
 * the code. Drawn under each strand it read as that strand's ("Comments · rated" as if the
 * survey comments were rated), so the Compact view and the report draw it once, as "Rated". A
 * code strand's entry carries the cells, each with its `rating`.
 */
export function rowRatedCodes(strands: ResolvedStrand[]): JointDisplayCodeStrand[] {
  const seen = new Map<number, JointDisplayCodeStrand>()
  for (const rs of strands) {
    if (rs.placement !== 'per_group' || rs.notMeasured || !rs.result) continue
    for (const s of rs.result.codes) if (s.rated && !seen.has(s.code_id)) seen.set(s.code_id, s)
  }
  return [...seen.values()]
}

/** One code strand's "· N with no coding" for one group header (R3 — r2's found-beside 2). */
export interface GroupCodingCount { tag: string | null; withoutCoding: number | null }

/**
 * Joint display slice 2 (R3): each group header's "with no coding" count, from EACH code strand's
 * own denominators (`response.strands[i].groups`) — with two code strands over different sources,
 * the first strand's count (slice 1's top-level `groups`) is wrong for the second. One code strand
 * (or a response without per-strand facts): slice 1's one count, untagged. Two or more: one count
 * per strand, tagged with its name.
 */
export function groupCodingCounts(
  display: JointDisplay, data: Pick<JointDisplayComputeResponse, 'groups' | 'strands'>, groupKey: string,
): GroupCodingCount[] {
  const codeStrands = displayStrands(display).filter(s => s.kind === 'codes' || s.kind === 'text_codes')
  const perStrand = codeStrands.map(s => ({ s, facts: data.strands?.find(f => f.key === s.key) ?? null }))
  if (perStrand.length < 2 || perStrand.some(p => p.facts?.groups == null)) {
    return [{ tag: null, withoutCoding: data.groups.find(g => g.key === groupKey)?.without_coding ?? null }]
  }
  return perStrand.map(({ s, facts }) => ({
    tag: strandTag(display, s),
    withoutCoding: facts!.groups!.find(g => g.key === groupKey)?.without_coding ?? null,
  }))
}

/**
 * R3 — the note's "with no coding" sentence per code strand: slice 1's one sentence (untagged)
 * for one code strand, else one per strand over ITS groups and scope, tagged with its name.
 */
export function codeStrandNoCoding(
  display: JointDisplay, data: Pick<JointDisplayComputeResponse, 'groups' | 'strands' | 'scope'>,
): { tag: string | null; counts: (readonly [string, number])[]; scope: string }[] {
  const codeStrands = displayStrands(display).filter(s => s.kind === 'codes' || s.kind === 'text_codes')
  const perStrand = codeStrands.map(s => ({ s, facts: data.strands?.find(f => f.key === s.key) ?? null }))
  if (perStrand.length < 2 || perStrand.some(p => p.facts?.groups == null)) {
    return [{ tag: null, counts: data.groups.map(g => [g.key, g.without_coding ?? 0] as const),
      scope: data.scope.no_coding_scope }]
  }
  return perStrand.map(({ s, facts }) => ({
    tag: strandTag(display, s),
    counts: facts!.groups!.map(g => [g.key, g.without_coding ?? 0] as const),
    scope: facts!.scope?.no_coding_scope ?? data.scope.no_coding_scope,
  }))
}

// ── The builder's edits (r2-1, r2-4) — pure, so the rules are tested without a dialog ──────

export function newStrandKey(): string {
  const c = globalThis.crypto
  return typeof c?.randomUUID === 'function'
    ? `s-${c.randomUUID()}`
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function emptyStrand(kind: StrandKind, label = ''): JointDisplayStrand {
  return {
    key: newStrandKey(), kind, label, conversation_ids: null, document_ids: null, observation_ids: null,
    dataset_id: null, text_column_ids: kind === 'text_codes' ? [] : null,
  }
}

/**
 * A slice-1 display made explicit — the FIRST edit that names, adds or removes a strand (r2-1;
 * R5: never on read). The implicit pair KEEPS its keys (`codes`, `variables`), so its drift
 * baselines and its fit pair still match; its rows' bindings stay where they are. ⚠️ Slice 1
 * chose a survey dataset PER ROW (D205's builder rule), slice 2 per STRAND: a display whose rows
 * used two datasets becomes one survey strand per dataset — new keys, so those cells' drift
 * stamps read "moved" once, at this conversion (r1's addendum 3).
 */
export function makeStrandsExplicit(
  display: JointDisplay, datasetOf: (columnId: number) => number | null,
): JointDisplay {
  if (!isImplicitPair(display)) return display
  const codeStrand = display.strands.find(s => s.key === IMPLICIT_CODES_KEY)!
  const datasets: number[] = []
  for (const r of display.rows) {
    for (const id of bindingOf(r, IMPLICIT_VARIABLES_KEY).column_ids) {
      const ds = id != null ? datasetOf(id) : null
      if (ds != null && !datasets.includes(ds)) datasets.push(ds)
    }
  }
  const variableStrands: JointDisplayStrand[] = (datasets.length ? datasets : [null]).map((ds, i) => ({
    key: i === 0 ? IMPLICIT_VARIABLES_KEY : newStrandKey(), kind: 'variables', label: '',
    conversation_ids: null, document_ids: null, observation_ids: null, dataset_id: ds, text_column_ids: null,
  }))
  const strandOfColumn = (id: number | null) => {
    const ds = id != null ? datasetOf(id) : null
    return variableStrands.find(s => s.dataset_id === ds) ?? variableStrands[0]
  }
  return {
    ...display,
    strands: [...variableStrands, codeStrand],
    rows: display.rows.map(r => {
      const old = bindingOf(r, IMPLICIT_VARIABLES_KEY)
      const bindings: Record<string, JointDisplayBinding> = { ...r.bindings }
      for (const s of variableStrands) bindings[s.key] = { code_ids: [], column_ids: [], marked_formed: old.marked_formed }
      for (const id of old.column_ids) bindings[strandOfColumn(id).key].column_ids.push(id)
      return { ...r, bindings }
    }),
  }
}

/** Move a strand one place up (-1) or down (+1) in display order (r2-1). */
export function moveStrand(display: JointDisplay, key: string, by: -1 | 1): JointDisplay {
  const i = display.strands.findIndex(s => s.key === key)
  const j = i + by
  if (i < 0 || j < 0 || j >= display.strands.length) return display
  const strands = [...display.strands]
  ;[strands[i], strands[j]] = [strands[j], strands[i]]
  return { ...display, strands }
}

/**
 * Why the builder will not insert yet, or null (r2-4): at least two strands, each named, a survey
 * strand's dataset chosen, and (R12's client half) a survey comments strand's questions chosen —
 * the server derives "not measured" for one with none, never "covers" over 0 of 0.
 */
export function strandsProblem(display: JointDisplay): string | null {
  if (isImplicitPair(display)) return null
  if (display.strands.length < 2) return 'A joint display compares at least two strands.'
  if (display.strands.some(s => !s.label.trim())) return 'Name every strand.'
  if (display.strands.some(s => s.kind === 'variables' && s.dataset_id == null)) return 'Choose a dataset for every survey strand.'
  if (display.strands.some(s => s.kind === 'text_codes' && !(s.text_column_ids ?? []).some(id => id != null))) {
    return 'Choose at least one question for every survey comments strand.'
  }
  return null
}

// ── Fit per NAMED pair — shape (ii), the literature's L1 (r1-8, r2-3, r2-8) ───────────────

/** True while more than one fit per row may be recorded — `MAX_FITS_PER_ROW` set to 1 is shape (i). */
export function namedPairs(): boolean {
  return MAX_FITS_PER_ROW > 1
}

export interface ResolvedPairFit {
  pair: [JointDisplayStrand, JointDisplayStrand]
  fit: string | null
}

/**
 * A row's recorded fits, each with its pair (`row.fits`, already checked against the display's
 * strands by r1's reader), at most `MAX_FITS_PER_ROW`; with none recorded, ONE unset fit over the
 * model's default pair (`defaultFitPair`). A row of a display with fewer than two per-group
 * strands has no default pair until the researcher names one.
 */
export function rowFits(display: JointDisplay, row: JointDisplayRow): ResolvedPairFit[] {
  const strands = displayStrands(display)
  const out: ResolvedPairFit[] = []
  for (const f of row.fits.slice(0, MAX_FITS_PER_ROW)) {
    const [a, b] = f.strands.map(k => strands.find(s => s.key === k))
    if (a && b && a.key !== b.key && !out.some(o => samePair(o.pair, [a, b]))) out.push({ pair: [a, b], fit: f.fit })
  }
  if (out.length > 0) return out
  const d = defaultFitPair(display, row)
  const [a, b] = d ? d.map(k => strands.find(s => s.key === k)) : []
  return a && b ? [{ pair: [a, b], fit: null }] : []
}

function samePair(p: [JointDisplayStrand, JointDisplayStrand], q: [JointDisplayStrand, JointDisplayStrand]): boolean {
  return (p[0].key === q[0].key && p[1].key === q[1].key) || (p[0].key === q[1].key && p[1].key === q[0].key)
}

/** Every pair of the display's strands, in display order — what a pair's selects offer. */
export function allPairs(display: JointDisplay): [JointDisplayStrand, JointDisplayStrand][] {
  const s = displayStrands(display)
  const out: [JointDisplayStrand, JointDisplayStrand][] = []
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.push([s[i], s[j]])
  return out
}

/** The first pair not yet recorded — the next "Compare another pair" (never all of them at once). */
export function nextPair(display: JointDisplay, row: JointDisplayRow): [JointDisplayStrand, JointDisplayStrand] | null {
  const have = rowFits(display, row)
  if (!namedPairs() || have.length >= MAX_FITS_PER_ROW) return null
  return allPairs(display).find(p => !have.some(f => samePair(f.pair, p))) ?? null
}

/**
 * The stored patch for a row's fits — ALWAYS `row.fits` (R2: r1-8's shape; slice 1's `fit` /
 * `fit_strands` are read, never written), capped at `MAX_FITS_PER_ROW`.
 */
export function writeFits(_display: JointDisplay, _row: JointDisplayRow, fits: { strands: [string, string]; fit: string | null }[]): Partial<JointDisplayRow> {
  const out: JointDisplayFit[] = fits.slice(0, MAX_FITS_PER_ROW).map(f => ({ strands: f.strands, fit: f.fit }))
  return { fits: out }
}

/**
 * r2-8 — DERIVED "not applicable" for a pair: NEITHER strand has evidence here (each is not
 * measured — the server's fact — or recorded silent — the researcher's). Tonkin-Crine et al.
 * (2016): "not applicable when neither data set in a paired comparison contained data", never
 * silence. Then there is no fit to record for the pair, so none is offered. (The model's
 * `pairApplicable` is the bindings-only half, for a row before its numbers arrive.)
 */
export function pairNotApplicable(
  display: JointDisplay, row: JointDisplayRow, result: JointDisplayRowResult | null, pair: [JointDisplayStrand, JointDisplayStrand],
): boolean {
  if (!result) return false
  const strands = rowStrands(display, result)
  return pair.every(p => {
    const rs = strands.find(x => x.strand.key === p.key)
    return rs != null && (rs.notMeasured || row.status[p.key] === 'silent')
  })
}
