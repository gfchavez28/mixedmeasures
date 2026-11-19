/**
 * The joint display's document model (ROADMAP row 56, D162) — what its canvas node stores,
 * how it is read back, and what it asks the server.
 *
 * The node (`components/canvas/extensions/joint-display.ts`) carries ONE JSON attribute,
 * `display`, whose key space is declared server-side in
 * `backend/app/services/joint_display_node.py` — the extractors, the withdrawal scrub and the
 * `.mmproject` remap read it there. 🔴 **A new key that holds an id must be added to that
 * module's remap tables in the same change** (the JSON-id class): this file is the client's
 * statement of the same shape, not a second authority.
 *
 * What is NEVER stored here, on purpose:
 * - a pin's speaker or site (D163.4 — derived at render through `jointDisplayApi.pinFacts`);
 * - the Compact | Report choice (D176.3 — per person, in the browser, keyed by `displayKey`);
 * - any number (D168 — the numbers are live; only a row's drift BASELINE is a snapshot, and
 *   only of what the row drew when its meta-inference was saved).
 */
import type { LayerScope } from '@/lib/coding-layers'
import type {
  JointDisplayCodeCell,
  JointDisplayCodeStrand,
  JointDisplayComputeRequest,
  JointDisplayObservationCode,
  JointDisplayPassagesRequest,
  JointDisplayRowResult,
  JointDisplayRowStrand,
  JointDisplayVariableCell,
  JointDisplayVariableStrand,
} from '@/lib/api/joint-display'
import { ciLabel } from '@/lib/ci-label'
import { describeUndefined, formatDescriptive, NO_VALUE } from '@/lib/stat-format'
import {
  DEFAULT_ATTRIBUTION,
  EFFECT_ABSENT_TEXT,
  RATING_ABSENT_TEXT,
  SERVER_VOCABULARY as V,
  type AttributionMode,
  type FitVocabularyKey,
  type PinRole,
} from '@/lib/joint-display-vocabulary'

import { readMisfit, misfitUnresolvedCount, type JointDisplayMisfit } from './joint-display-misfit'

export const JOINT_DISPLAY_NODE = 'joint-display'

// ── The stored shape ─────────────────────────────────────────────────────────────────

/** A pinned quote: EXACTLY an excerpt-embed's five attributes plus `group`, `role`, `purpose`. */
export interface JointDisplayPin {
  excerptId: number | null
  displayText: string
  sourceContext: string
  conversationId: number | null
  observationId: number | null
  group: string
  role: PinRole | null
  /** D163.5 — the researcher's one line on why a discrepant quote is there. */
  purpose: string
  /** Slice 2 (r2-5): the strand it was picked from — one conversation can sit in two strands. */
  strand?: string
}

export interface JointDisplayMetaInference {
  text: string
  /** An install-global `users.id` — remapped through the import's coder table. */
  author_id: number | null
  /** ISO date (YYYY-MM-DD) the text was last saved. */
  written_at: string | null
  level: 'global' | 'specific' | null
  type: string | null
}

/**
 * #1672 D353 — the coder view a stamp's numbers were read under: every coder (`'all'`), or one
 * coder's own while withholding (their `users.id`) — exactly `displayCoderScope`'s two cases. A
 * stamp from before D353, or whose coder did not travel in an import, has none (null): unknown.
 */
export type BaselineScope = 'all' | number

/** D168.5 — what the row DREW when its meta-inference was saved: the cells as printed. */
export interface JointDisplayRowBaseline {
  hash: string
  cells: Record<string, string>
  stamped_at: string
  /** #1672 D353 — under whose coder view the cells were read; null = unknown. */
  scope: BaselineScope | null
  /** #1674 D357 — a withdrawal cleared the figures (`hash` and `cells` empty; the date kept). */
  cleared: 'withdrawal' | null
}

export type RecordedStrandStatus = 'covers' | 'silent' | null

/** Joint display slice 2 (r1-1): a strand's kind — its placement is DERIVED from it. */
export type StrandKind = 'codes' | 'text_codes' | 'variables' | 'observation_codes'
const KNOWN_KINDS: ReadonlySet<string> = new Set<StrandKind>(['codes', 'text_codes', 'variables', 'observation_codes'])
/** A strand of a kind this build cannot compute (a later release's) is KEPT and not drawn (r1-9). */
export function isKnownKind(kind: string): kind is StrandKind { return KNOWN_KINDS.has(kind) }

/**
 * r1-8 (L1): one researcher-recorded fit over a NAMED pair of strands. Every published fit
 * vocabulary is defined over a pair (Tonkin-Crine 2016: named pairwise comparisons; Farmer's
 * silence: "the other set of results is silent"), so a fit is stored WITH its pair — zero or more
 * per row, never every pair generated. Slice 1's one `fit` reads as one fit over the default pair.
 */
export interface JointDisplayFit {
  strands: [string, string]
  fit: string | null
}
/** r1-8's switch: shape (i) "one fit per row" is this shape capped at ONE pair (the builder's cap). */
export const MAX_FITS_PER_ROW = 6

/**
 * Joint display slice 2 (r1-1): one strand of the display, explicit and named. Its sources by
 * kind; each list: null = every source of the kind, a list = exactly those ([] = none, #1297).
 * Ids may be null where an import could not resolve one (D202).
 */
export interface JointDisplayStrand {
  /** Stable, never an id: rows bind, record a status and name a fit pair by it. */
  key: string
  /** A `StrandKind`, or a later release's kind kept verbatim (`isKnownKind`). */
  kind: string
  /** The researcher's name for it ("Interviews", "Baseline survey") — '' = the kind's default. */
  label: string
  conversation_ids: (number | null)[] | null
  document_ids: (number | null)[] | null
  /** Open-text columns as a code source — r4's C5 decides; the key's REMAP ships either way (r1-6). */
  text_column_ids: (number | null)[] | null
  observation_ids: (number | null)[] | null
  /** D205 — a variables strand reads ONE dataset; null = any (slice 1's implicit strand). */
  dataset_id: number | null
}

/** What a row binds from one strand (slice 2). */
export interface JointDisplayBinding {
  code_ids: (number | null)[]
  column_ids: (number | null)[]
  /** D171, per strand — only the researcher can see this link. */
  marked_formed: boolean
}

export interface JointDisplayRow {
  key: string
  construct: string
  /** Slice 2: strand key → what the row binds from it. A strand it names nothing from is absent. */
  bindings: Record<string, JointDisplayBinding>
  /** Ids may be null where an import could not resolve one (D202) — kept in place, drawn as missing. */
  result_material_ids: (number | null)[]
  /** D171 for the different-unit strand (D165): only the researcher can see this link. */
  results_marked_formed: boolean
  /** r1-8 (L1): the researcher's fits, each over a named pair (`JointDisplayFit`). */
  fits: JointDisplayFit[]
  /** Slice 2: strand key → the researcher's recorded status (D169; "not measured" is derived). */
  status: Record<string, RecordedStrandStatus>
  meta_inference: JointDisplayMetaInference | null
  implication: string
  pins: JointDisplayPin[]
  baseline: JointDisplayRowBaseline | null
  /** Joint display slice 2 (D173, C4) — the row's "cases that don't fit"; null = none. */
  misfit: JointDisplayMisfit | null
}

export interface JointDisplaySettings {
  fit_vocabulary: FitVocabularyKey
  implication: boolean
  newcombe: boolean
}

export interface JointDisplay {
  title: string
  group_by_column_id: number | null
  /** Slice 2 (r1-1): the strands, in display order. A slice 1 display reads as its implicit pair. */
  strands: JointDisplayStrand[]
  attribution: { label: AttributionMode; column_id: number | null }
  settings: JointDisplaySettings
  rows: JointDisplayRow[]
}

// ── Reading it back (tolerant IN: an import, an older shape, a hand-edited file) ────────

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try { return asObject(JSON.parse(v)) } catch { return {} }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function asIdList(v: unknown): (number | null)[] {
  return Array.isArray(v) ? v.map(asId) : []
}

function asSourceList(v: unknown): (number | null)[] | null {
  return v == null ? null : asIdList(v)
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asStatus(v: unknown): RecordedStrandStatus {
  return v === 'covers' || v === 'silent' ? v : null
}

function asRole(v: unknown): PinRole | null {
  return v === 'typical' || v === 'illustrative' || v === 'discrepant' ? v : null
}

function readPin(v: unknown): JointDisplayPin {
  const p = asObject(v)
  return {
    excerptId: asId(p.excerptId),
    displayText: asText(p.displayText),
    sourceContext: asText(p.sourceContext),
    conversationId: asId(p.conversationId),
    observationId: asId(p.observationId),
    group: asText(p.group),
    role: asRole(p.role),
    purpose: asText(p.purpose),
    ...(typeof p.strand === 'string' && p.strand ? { strand: p.strand } : {}),
  }
}

function readMeta(v: unknown): JointDisplayMetaInference | null {
  if (v == null) return null
  const m = asObject(v)
  return {
    text: asText(m.text),
    author_id: asId(m.author_id),
    written_at: typeof m.written_at === 'string' ? m.written_at : null,
    level: m.level === 'global' || m.level === 'specific' ? m.level : null,
    type: typeof m.type === 'string' ? m.type : null,
  }
}

function readBaselineScope(v: unknown): BaselineScope | null {
  if (v === 'all') return 'all'
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function readBaseline(v: unknown): JointDisplayRowBaseline | null {
  const b = asObject(v)
  const scope = readBaselineScope(b.scope)
  // #1674 D357: the server's withdrawal scrub keeps only the date (and the scope) of a stamp.
  if (b.cleared === 'withdrawal') {
    return { hash: '', cells: {}, stamped_at: asText(b.stamped_at), scope, cleared: 'withdrawal' }
  }
  if (typeof b.hash !== 'string') return null
  const cells: Record<string, string> = {}
  for (const [k, val] of Object.entries(asObject(b.cells))) {
    if (typeof val === 'string') cells[k] = val
  }
  return { hash: b.hash, cells, stamped_at: asText(b.stamped_at), scope, cleared: null }
}

// ── Forward compatibility (r1-9) ──────────────────────────────────────────────────────

/**
 * The members of a stored object this build does not know, kept so that its next edit writes
 * them back. Every edit goes `readDisplay` → `commit({ ...display, … })`, so a reader that
 * dropped them would erase, on the first edit, whatever a LATER release added. It saves a later
 * release's plain additions only: an id key this build's import does not remap is still copied
 * verbatim (the server's `joint_display_node.py` tables), and this build still draws without it.
 * 🔴 Slice 1's members (`LEGACY_*`) are known and superseded — consumed by the migration, never kept.
 */
function unknownMembers(o: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!known.has(k)) out[k] = v
  return out
}
const LEGACY_DISPLAY_KEYS = ['conversation_ids', 'document_ids'] as const
const LEGACY_ROW_KEYS = ['code_ids', 'column_ids', 'codes_marked_formed', 'variables_marked_formed'] as const
const DISPLAY_KEYS = new Set(['title', 'group_by_column_id', 'strands', 'attribution', 'settings', 'rows', ...LEGACY_DISPLAY_KEYS])
const STRAND_KEYS = new Set(['key', 'kind', 'label', 'conversation_ids', 'document_ids', 'text_column_ids', 'observation_ids', 'dataset_id'])
const ROW_KEYS = new Set(['key', 'construct', 'bindings', 'result_material_ids', 'results_marked_formed', 'fit',
  'fits', 'fit_strands', 'status', 'meta_inference', 'implication', 'pins', 'baseline', 'misfit', ...LEGACY_ROW_KEYS])
const BINDING_KEYS = new Set(['code_ids', 'column_ids', 'marked_formed'])

/** Slice 1's two strands, as every display without a `strands` key reads (r1-2). */
export const IMPLICIT_CODES_KEY = 'codes'
export const IMPLICIT_VARIABLES_KEY = 'variables'


function readStrand(v: unknown, index: number): JointDisplayStrand | null {
  const s = asObject(v)
  // r1-9: a kind this build cannot compute is KEPT (so an edit here does not erase it) and is
  // never asked of the server nor drawn as another kind (`isKnownKind`).
  const kind = typeof s.kind === 'string' && s.kind ? s.kind : null
  if (kind == null) return null
  return {
    ...unknownMembers(s, STRAND_KEYS),
    key: asText(s.key) || `strand-${index + 1}`,
    kind,
    label: asText(s.label),
    conversation_ids: asSourceList(s.conversation_ids),
    document_ids: asSourceList(s.document_ids),
    text_column_ids: asSourceList(s.text_column_ids),
    observation_ids: asSourceList(s.observation_ids),
    dataset_id: asId(s.dataset_id),
  }
}

function readBinding(v: unknown): JointDisplayBinding {
  const b = asObject(v)
  return {
    ...unknownMembers(b, BINDING_KEYS),
    code_ids: asIdList(b.code_ids),
    column_ids: asIdList(b.column_ids),
    marked_formed: b.marked_formed === true,
  }
}

/** r1-2: slice 1's implicit pair — ONE codes strand over the display's sources, ONE variables strand. */
function implicitStrands(d: Record<string, unknown>): JointDisplayStrand[] {
  return [
    { key: IMPLICIT_CODES_KEY, kind: 'codes', label: '', conversation_ids: asSourceList(d.conversation_ids),
      document_ids: asSourceList(d.document_ids), text_column_ids: [], observation_ids: null, dataset_id: null },
    { key: IMPLICIT_VARIABLES_KEY, kind: 'variables', label: '', conversation_ids: null, document_ids: null,
      text_column_ids: null, observation_ids: null, dataset_id: null },
  ]
}

const FIT_KEYS = new Set(['strands', 'fit'])

/**
 * r1-8: the row's fits. Slice 1's `fit` (one string, no pair) reads as ONE fit over the implicit
 * pair. A pair naming a strand the display lacks, naming one strand twice, or repeating a pair
 * already read, is dropped: a fit is meaningful only between the two strands it names.
 */
function readFits(r: Record<string, unknown>, keys: ReadonlySet<string>, legacy: boolean,
  perGroupKeys: string[] = []): JointDisplayFit[] {
  if (legacy) {
    return typeof r.fit === 'string' ? [{ strands: [IMPLICIT_CODES_KEY, IMPLICIT_VARIABLES_KEY], fit: r.fit }] : []
  }
  // Reconciled with r2: one pair stored in slice 1's shape (`fit` + `fit_strands`) on an explicit
  // display reads as that one fit; with no `fit_strands`, over the first two per-group strands.
  if (!Array.isArray(r.fits) && typeof r.fit === 'string') {
    const fs = Array.isArray(r.fit_strands) ? r.fit_strands : []
    const pair = fs.length === 2 && fs.every(k => typeof k === 'string' && keys.has(k)) && fs[0] !== fs[1]
      ? fs as [string, string] : perGroupKeys.length >= 2 ? [perGroupKeys[0], perGroupKeys[1]] as [string, string] : null
    return pair ? [{ strands: pair, fit: r.fit }] : []
  }
  const out: JointDisplayFit[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(r.fits) ? r.fits : []) {
    const f = asObject(raw)
    const pair: unknown[] = Array.isArray(f.strands) ? f.strands : []
    const [a, b] = pair
    if (pair.length !== 2 || typeof a !== 'string' || typeof b !== 'string' || a === b || !keys.has(a) || !keys.has(b)) continue
    const id = [a, b].sort().join('|')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ...unknownMembers(f, FIT_KEYS), strands: [a, b], fit: typeof f.fit === 'string' ? f.fit : null })
  }
  return out
}

function readRow(v: unknown, index: number, strandKeys: ReadonlySet<string>, legacy: boolean,
  perGroupKeys: string[] = []): JointDisplayRow {
  const r = asObject(v)
  const status = asObject(r.status)
  const bindings: Record<string, JointDisplayBinding> = {}
  if (legacy) {
    bindings[IMPLICIT_CODES_KEY] = { code_ids: asIdList(r.code_ids), column_ids: [], marked_formed: r.codes_marked_formed === true }
    bindings[IMPLICIT_VARIABLES_KEY] = { code_ids: [], column_ids: asIdList(r.column_ids), marked_formed: r.variables_marked_formed === true }
  } else {
    for (const [k, b] of Object.entries(asObject(r.bindings))) if (strandKeys.has(k)) bindings[k] = readBinding(b)
  }
  const recorded: Record<string, RecordedStrandStatus> = {}
  for (const k of strandKeys) { const st = asStatus(status[k]); if (st) recorded[k] = st }
  return {
    ...unknownMembers(r, ROW_KEYS),
    key: asText(r.key) || `row-${index + 1}`,
    construct: asText(r.construct),
    bindings,
    result_material_ids: asIdList(r.result_material_ids),
    results_marked_formed: r.results_marked_formed === true,
    fits: readFits(r, strandKeys, legacy, perGroupKeys),
    status: recorded,
    meta_inference: readMeta(r.meta_inference),
    implication: asText(r.implication),
    pins: Array.isArray(r.pins) ? r.pins.map(readPin) : [],
    baseline: readBaseline(r.baseline),
    misfit: readMisfit(r.misfit),
  }
}

/**
 * The node's `display` attribute → the model, every member defaulted. Never throws.
 * r1-2: a display with no `strands` key is slice 1's and reads as its implicit pair; the model
 * (and so every write) is slice 2's shape only. r1-9: members this build does not know are kept.
 */
export function readDisplay(raw: unknown): JointDisplay {
  const d = asObject(raw)
  const attribution = asObject(d.attribution)
  const settings = asObject(d.settings)
  const label = attribution.label
  const legacy = !Array.isArray(d.strands)
  const strands = legacy
    ? implicitStrands(d)
    : (d.strands as unknown[]).map(readStrand).filter((s): s is JointDisplayStrand => s != null)
  // Two strands with one key would bind as one — the second is not drawn.
  const seen = new Set<string>()
  const unique = strands.filter(s => (seen.has(s.key) ? false : (seen.add(s.key), true)))
  const keys = new Set(unique.map(s => s.key))
  return {
    ...unknownMembers(d, DISPLAY_KEYS),
    title: asText(d.title),
    group_by_column_id: asId(d.group_by_column_id),
    strands: unique,
    attribution: {
      label: label === 'participant' || label === 'speaker' || label === 'source' || label === 'none'
        ? label : DEFAULT_ATTRIBUTION,
      column_id: asId(attribution.column_id),
    },
    settings: {
      fit_vocabulary: settings.fit_vocabulary === 'farmer' ? 'farmer' : 'fetters',
      implication: settings.implication === true,
      newcombe: settings.newcombe === true,
    },
    rows: Array.isArray(d.rows)
      ? d.rows.map((r, i) => readRow(r, i, keys, legacy, unique.filter(isPerGroupStrand).map(s => s.key))) : [],
  }
}

// ── Strands: lookups and the fit pair ────────────────────────────────────────────────

const PER_GROUP: ReadonlySet<StrandKind> = new Set(['codes', 'text_codes', 'variables'])

export function isPerGroupStrand(s: JointDisplayStrand): boolean {
  return isKnownKind(s.kind) && PER_GROUP.has(s.kind)
}

export function strandOfKind(display: JointDisplay, kind: StrandKind): JointDisplayStrand | undefined {
  return display.strands.find(s => s.kind === kind)
}

export const EMPTY_BINDING: JointDisplayBinding = Object.freeze({ code_ids: [], column_ids: [], marked_formed: false }) as JointDisplayBinding

export function bindingOf(row: JointDisplayRow, strandKey: string): JointDisplayBinding {
  return row.bindings[strandKey] ?? EMPTY_BINDING
}

/** A row patch setting part of one strand's binding. */
export function withBinding(row: JointDisplayRow, strandKey: string, patch: Partial<JointDisplayBinding>): Partial<JointDisplayRow> {
  return { bindings: { ...row.bindings, [strandKey]: { ...bindingOf(row, strandKey), ...patch } } }
}

/** A display patch setting part of one strand. */
export function withStrand(display: JointDisplay, strandKey: string, patch: Partial<JointDisplayStrand>): Partial<JointDisplay> {
  return { strands: display.strands.map(s => (s.key === strandKey ? { ...s, ...patch } : s)) }
}

/**
 * r1-8: the pair a row's FIRST fit is over by default — the first two per-group strands the row
 * binds, in display order, else the display's first two per-group strands (slice 1: codes beside
 * the survey). null with fewer than two per-group strands: there is no pair to name.
 */
export function defaultFitPair(display: JointDisplay, row: JointDisplayRow): [string, string] | null {
  const perGroup = display.strands.filter(isPerGroupStrand).map(s => s.key)
  const bound = perGroup.filter(k => strandBound(row, k))
  const pick = bound.length >= 2 ? bound : perGroup
  return pick.length >= 2 ? [pick[0], pick[1]] : null
}

function strandBound(row: JointDisplayRow, key: string): boolean {
  const b = row.bindings[key]
  return b != null && (b.code_ids.length > 0 || b.column_ids.length > 0)
}

/**
 * r1-8 (L1, Tonkin-Crine's "not applicable"): a pair NEITHER of whose strands binds anything has
 * no fit to record — DERIVED from the bindings like "not measured", never stored as silence.
 */
export function pairApplicable(row: JointDisplayRow, pair: [string, string]): boolean {
  return strandBound(row, pair[0]) || strandBound(row, pair[1])
}

/** Slice 1's single fit, for the views that still draw one (r2 draws each pair). */
export function primaryFit(row: JointDisplayRow): string | null {
  return row.fits[0]?.fit ?? null
}

/** A row patch setting the first fit — over its pair, or the default pair when it has none. */
export function withPrimaryFit(display: JointDisplay, row: JointDisplayRow, fit: string | null): Partial<JointDisplayRow> {
  const pair = row.fits[0]?.strands ?? defaultFitPair(display, row)
  if (!pair) return {}
  return { fits: [{ ...row.fits[0], strands: pair, fit }, ...row.fits.slice(1)] }
}

/** How many recorded fits compare a strand — what removing it would drop (r1-8). */
export function fitsNamingStrand(display: JointDisplay, strandKey: string): number {
  return display.rows.reduce((n, r) => n + r.fits.filter(f => f.strands.includes(strandKey) && f.fit != null).length, 0)
}

/**
 * r1-8: removing a strand — its bindings, its recorded status and every fit over a pair naming it
 * go with it (a fit means nothing without both its strands); the builder asks first, naming
 * `fitsNamingStrand`. The meta-inference, the researcher's prose, is untouched.
 */
export function removeStrand(display: JointDisplay, strandKey: string): JointDisplay {
  return {
    ...display,
    strands: display.strands.filter(s => s.key !== strandKey),
    rows: display.rows.map(r => {
      const { [strandKey]: _b, ...bindings } = r.bindings
      const { [strandKey]: _s, ...status } = r.status
      return { ...r, bindings, status, fits: r.fits.filter(f => !f.strands.includes(strandKey)) }
    }),
  }
}

/** #1665 (D335) — how many constructs have chosen variables for a survey strand: what changing
 *  its dataset would clear, so the builder asks first when it is more than none. */
export function constructsBindingStrandVariables(display: JointDisplay, strandKey: string): number {
  return display.rows.filter(r => bindingOf(r, strandKey).column_ids.length > 0).length
}

/**
 * #1665 (D335) — a survey strand's new dataset starts the strand over in every construct (D205:
 * one dataset per survey strand — slice 1's per-construct picker already clears on a change).
 * Kept, the old dataset's variables were left out by the compute and could not be unticked in
 * the builder (the picker offers only the new dataset's). The formed-groups mark stays.
 */
export function changeStrandDataset(display: JointDisplay, strandKey: string, datasetId: number | null): JointDisplay {
  return {
    ...display,
    strands: display.strands.map(s => (s.key === strandKey ? { ...s, dataset_id: datasetId } : s)),
    rows: display.rows.map(r => (bindingOf(r, strandKey).column_ids.length === 0 ? r
      : { ...r, ...withBinding(r, strandKey, { column_ids: [] }) })),
  }
}

/** #1671 D350 — what a display holds that was chosen under its CURRENT groups. */
export interface RegroupHolds {
  pins: number
  /** Rules with a condition naming a group. */
  groupRules: number
  /** Cases the researcher added or removed by hand. */
  pickedCases: number
  /** Drift stamps — their cells are keyed by the current groups. */
  stamps: number
  /**
   * #1688 (D370) — the groups the pins and the rules' group conditions sit under, first seen
   * first. The display records a group's NAME, never the variable it was chosen under, so the
   * warning names these rather than guessing a variable.
   */
  groups: string[]
}

export function regroupHolds(display: Pick<JointDisplay, 'rows'>): RegroupHolds {
  const out: RegroupHolds = { pins: 0, groupRules: 0, pickedCases: 0, stamps: 0, groups: [] }
  const seen = new Set<string>()
  const note = (g: string) => { if (!seen.has(g)) { seen.add(g); out.groups.push(g) } }
  for (const r of display.rows) {
    out.pins += r.pins.length
    r.pins.forEach(p => note(p.group))
    const groupConditions = (r.misfit?.rule?.conditions ?? []).filter(c => c.kind === 'group')
    if (groupConditions.length > 0) out.groupRules += 1
    groupConditions.forEach(c => { if (c.kind === 'group') note(c.group) })
    out.pickedCases += (r.misfit?.added.length ?? 0) + (r.misfit?.removed.length ?? 0)
    if (r.baseline != null) out.stamps += 1
  }
  return out
}

/** #1671 D350 — does changing the grouping variable need asking first? */
export function regroupNeedsAsking(display: Pick<JointDisplay, 'rows' | 'group_by_column_id'>): boolean {
  if (display.group_by_column_id == null) return false
  const h = regroupHolds(display)
  return h.pins + h.groupRules + h.pickedCases + h.stamps > 0
}

/**
 * #1671 D352 — the row's pins the display cannot PLACE: pinned under a group it does not have now
 * (a regroup, a relabel, a group that lost its last member). KEPT, never dropped — grouping back
 * places them again — so they are counted and named, by the one function each reader asks.
 */
export function pinsOutsideGroups(row: JointDisplayRow, groupKeys: readonly string[]): { count: number; groups: string[] } {
  const present = new Set(groupKeys)
  const outside = row.pins.filter(p => !present.has(p.group))
  return { count: outside.length, groups: [...new Set(outside.map(p => p.group))] }
}

/**
 * #1673 D355 — does a construct HOLD anything the researcher would lose? Bound codes or variables
 * (or saved results), pins, a fit or a meta-inference, an implication, a rule or picked cases, a
 * drift stamp. A new, empty, nameless row holds nothing and may still be dropped on save.
 */
export function rowHoldsWork(row: JointDisplayRow): boolean {
  const bound = Object.values(row.bindings).some(b => b.code_ids.length > 0 || b.column_ids.length > 0)
  const misfit = row.misfit != null
    && ((row.misfit.rule?.conditions.length ?? 0) > 0 || row.misfit.added.length > 0 || row.misfit.removed.length > 0)
  return bound
    || row.result_material_ids.length > 0
    || row.pins.length > 0
    || row.fits.some(f => f.fit != null)
    || !!row.meta_inference?.text?.trim()
    || !!row.implication.trim()
    || misfit
    || row.baseline != null
}

/**
 * #1673 D355 — the 1-based position of the first construct that has NO NAME and holds work, or
 * null. The builder's *Save changes* drops nameless rows, so it is unavailable while one holds
 * anything — *Remove construct* is the way to delete one; clearing its name is not.
 */
export function unnamedConstructHoldingWork(display: Pick<JointDisplay, 'rows'>): number | null {
  const i = display.rows.findIndex(r => !r.construct.trim() && rowHoldsWork(r))
  return i < 0 ? null : i + 1
}

export function newRowKey(): string {
  const c = globalThis.crypto
  return typeof c?.randomUUID === 'function'
    ? c.randomUUID()
    : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function emptyRow(construct = ''): JointDisplayRow {
  return {
    key: newRowKey(),
    construct,
    bindings: {},
    result_material_ids: [],
    results_marked_formed: false,
    fits: [],
    status: {},
    meta_inference: null,
    implication: '',
    pins: [],
    baseline: null,
    misfit: null,
  }
}

export function emptyDisplay(): JointDisplay {
  return {
    title: '',
    group_by_column_id: null,
    strands: implicitStrands({}),
    attribution: { label: DEFAULT_ATTRIBUTION, column_id: null },
    settings: { fit_vocabulary: 'fetters', implication: false, newcombe: false },
    rows: [emptyRow()],
  }
}

/** How many ids the display holds that an import could not resolve (D202 — null in place). */
export function unresolvedReferenceCount(display: JointDisplay): number {
  let n = 0
  const count = (ids: (number | null)[] | null) => { for (const id of ids ?? []) if (id == null) n++ }
  for (const s of display.strands) {
    count(s.conversation_ids)
    count(s.document_ids)
    count(s.text_column_ids)
    count(s.observation_ids)
    if (s.kind === 'variables' && s.dataset_id == null && s.key !== IMPLICIT_VARIABLES_KEY) n++
  }
  for (const r of display.rows) {
    for (const b of Object.values(r.bindings)) { count(b.code_ids); count(b.column_ids) }
    count(r.result_material_ids)
    n += misfitUnresolvedCount(r.misfit)
  }
  return n
}

// ── What it asks the server ──────────────────────────────────────────────────────────

/**
 * The coder scope a display reads under — blind mode as the comparison does it (D175).
 * 🔴 From `useBlindMode().withholding`, never `blind` (#964: it fails closed while the roster
 * is unanswered), and the viewer alone while withholding.
 */
export interface DisplayCoderScope {
  coderIds: number[] | null
  layerScope: LayerScope
  /** True while withholding — the passage chips follow `coderIds` too (D102). */
  chipsFollow: boolean
}

/**
 * 🔴 #1675 D361: while withholding with NO viewer id there is no scope — null, and every request
 * builder below answers null for it, so no read is made (D96), as `analysisScope` does. It was
 * `coder_ids: []`, which the server reads as EVERY coder; the callers' gates were all that kept it
 * from being sent.
 */
export function displayCoderScope(withholding: boolean, self: number | null): DisplayCoderScope | null {
  if (withholding) return self != null ? { coderIds: [self], layerScope: 'human', chipsFollow: true } : null
  return { coderIds: null, layerScope: 'human', chipsFollow: false }
}

/** #1672 D353 — the stamp's name for a display scope: `'all'`, the one coder, or null (no scope). */
export function baselineScopeOf(scope: DisplayCoderScope | null): BaselineScope | null {
  if (scope == null) return null
  if (scope.coderIds == null) return 'all'
  return scope.coderIds.length === 1 ? scope.coderIds[0] : null
}

const ids = (list: (number | null)[]) => list.filter((x): x is number => x != null)

/** Sources as the server reads them: null stays null, a list loses its unresolved entries. */
export function requestSources(list: (number | null)[] | null): number[] | null {
  return list == null ? null : ids(list)
}

/** The compute call for this display — null while it has no grouping variable, or no scope (D361). */
export function computeRequest(display: JointDisplay, scope: DisplayCoderScope | null): JointDisplayComputeRequest | null {
  if (display.group_by_column_id == null || scope == null) return null
  return {
    group_by_column_id: display.group_by_column_id,
    coder_ids: scope.coderIds,
    layer_scope: scope.layerScope,
    newcombe: display.settings.newcombe,
    // Slice 2 (r1-1): every display asks in strands — a slice 1 one as its implicit pair.
    // r1-9: a later release's kind is kept in the document and never asked of this server.
    strands: display.strands.filter(s => isKnownKind(s.kind)).map(s => ({
      key: s.key,
      kind: s.kind as StrandKind,
      conversation_ids: requestSources(s.conversation_ids),
      document_ids: requestSources(s.document_ids),
      observation_ids: requestSources(s.observation_ids),
      // text_codes (r4-1): null and [] are both NONE — never sent as "every column".
      ...(s.kind === 'text_codes' ? { text_column_ids: requestSources(s.text_column_ids) ?? [] } : {}),
      dataset_id: s.dataset_id,
    })),
    rows: display.rows.map(r => ({
      key: r.key,
      bindings: Object.fromEntries(display.strands.filter(s => isKnownKind(s.kind) && r.bindings[s.key]).map(s => {
        const b = r.bindings[s.key]
        return [s.key, { code_ids: ids(b.code_ids), column_ids: ids(b.column_ids), marked_formed: b.marked_formed }]
      })),
    })),
  }
}

/** The codes strand a pin's suggestions are read from (D209) when the pin names none: the first. */
export function pinSourceStrand(display: JointDisplay): JointDisplayStrand | undefined {
  return strandOfKind(display, 'codes')
}

/**
 * The strand a pin is chosen from: the named codes or survey comments strand, else the first codes
 * strand. ONE rule for the picker's request (`pinPassagesRequest`) and its words (#1668, D344:
 * `pinPoolUnit`), so the picker cannot list answers while it says "passages".
 */
export function pinStrand(display: JointDisplay, strandKey: string | undefined): JointDisplayStrand | undefined {
  const named = display.strands.find(s => s.key === strandKey && (s.kind === 'codes' || s.kind === 'text_codes'))
  return named ?? pinSourceStrand(display)
}

/** #1668 (D344): what the pin picker lists for a strand — a survey comments strand's coded ANSWERS
 *  (its request reads only its questions), else coded passages. */
export function pinPoolUnit(display: JointDisplay, strandKey: string | undefined): 'passages' | 'answers' {
  return pinStrand(display, strandKey)?.kind === 'text_codes' ? 'answers' : 'passages'
}

/**
 * The pin picker's suggestion call (D209) for one group and code, from the PIN'S STRAND (joint
 * display slice 2, r2-5 / R9): a `codes` strand's conversations and documents, or a `text_codes`
 * strand's open-text questions (r4-1) — the SAME sources that strand's count reads, so a suggested
 * passage or answer is one its numbers count. A key naming no code strand falls back to the first
 * `codes` strand (a pin picked before slice 2 has none).
 */
export function pinPassagesRequest(
  display: JointDisplay, strandKey: string | undefined, group: string, codeId: number, scope: DisplayCoderScope | null,
): JointDisplayPassagesRequest | null {
  if (display.group_by_column_id == null || scope == null) return null
  const strand = pinStrand(display, strandKey)
  const answers = strand?.kind === 'text_codes'
  return {
    group_by_column_id: display.group_by_column_id,
    group,
    code_id: codeId,
    conversation_ids: answers ? [] : requestSources(strand?.conversation_ids ?? null),
    document_ids: answers ? [] : requestSources(strand?.document_ids ?? null),
    // r4-2: a codes strand reads no answers; null and [] are both NONE (never every column).
    text_column_ids: answers ? ids(strand?.text_column_ids ?? []) : [],
    coder_ids: scope.coderIds,
    layer_scope: scope.layerScope,
    chips_follow_coder_ids: scope.chipsFollow,
    limit: 50,
    offset: 0,
  }
}

// ── A row's answer, per strand (C2 — r1's wire) ───────────────────────────────────────

/**
 * A row's answer BY STRAND KEY (joint display slice 2, R3): the server's `rows[].by_strand`.
 * ⚠️ The fallback reads slice 1's top-level `codes` / `variables` and their status map as the
 * implicit pair — the server always sends `by_strand`, so only a response recorded before it
 * (a test fixture) takes it. Every reader (the views, the report, drift) asks this ONE function.
 */
export function resultStrands(result: JointDisplayRowResult): Record<string, JointDisplayRowStrand> {
  if (result.by_strand) {
    const out: Record<string, JointDisplayRowStrand> = {}
    for (const [k, s] of Object.entries(result.by_strand)) {
      // ⚠️ A field-by-field copy: a new member of `by_strand[key]` is DROPPED here unless listed
      // (#1659's reason was, until its own tests read it through the view).
      out[k] = { kind: s.kind ?? '', status: s.status ?? '', codes: s.codes, variables: s.variables,
        observation_codes: s.observation_codes, missing_code_ids: s.missing_code_ids ?? [],
        missing_column_ids: s.missing_column_ids ?? [],
        other_dataset_column_ids: s.other_dataset_column_ids ?? [],  // #1665 (D336)
        not_measured_reason: s.not_measured_reason ?? null }
    }
    return out
  }
  return {
    [IMPLICIT_CODES_KEY]: { kind: 'codes', status: result.strands.codes, codes: result.codes, variables: [],
      observation_codes: [], missing_code_ids: result.missing_code_ids, missing_column_ids: [] },
    [IMPLICIT_VARIABLES_KEY]: { kind: 'variables', status: result.strands.variables, codes: [],
      variables: result.variables, observation_codes: [], missing_code_ids: [], missing_column_ids: result.missing_column_ids,
      other_dataset_column_ids: result.other_dataset_column_ids ?? [] },
  }
}

// ── What a cell PRINTS — one formatter for the view, the drift baseline and the export ──

export function formatCodeCell(cell: JointDisplayCodeCell): string {
  return `${cell.count} of ${cell.n}`
}

/**
 * r2-12 (r4-1): an open-text strand's cell — "4 of 9 answered (30 surveyed)"; n is those in the
 * group who ANSWERED, the surveyed count beside it (`response.strands[i].groups[].surveyed`).
 */
export function formatTextCodeCell(cell: JointDisplayCodeCell, surveyed?: number | null): string {
  return `${cell.count} of ${cell.n} answered${surveyed != null ? ` (${surveyed} surveyed)` : ''}`
}

/** A code cell by its strand's kind — the ONE choice the view, the report and drift share. */
export function formatStrandCodeCell(kind: string, cell: JointDisplayCodeCell, surveyed?: number | null): string {
  return kind === 'text_codes' ? formatTextCodeCell(cell, surveyed) : formatCodeCell(cell)
}

export function codeCellNote(cell: JointDisplayCodeCell): string | null {
  return cell.share == null ? describeUndefined(cell.share_undefined_reason) : null
}

export function formatRatingCell(cell: JointDisplayCodeCell): string | null {
  const r = cell.rating
  if (!r) return null
  if (r.mean == null) return NO_VALUE
  return `${formatDescriptive(r.mean)} (${r.n} ${r.n === 1 ? 'score' : 'scores'})`
}

export function ratingCellNote(cell: JointDisplayCodeCell): string | null {
  const reason = cell.rating?.undefined_reason
  return reason ? (RATING_ABSENT_TEXT[reason] ?? describeUndefined(reason)) : null
}

/** Percentage points, signed: 0.45 → "+45 pp". */
function pp(v: number): string {
  const x = Math.round(v * 100)
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x)} pp`
}

export function formatCodeDifference(strand: JointDisplayCodeStrand): string {
  const d = strand.difference
  if (d.value == null) return NO_VALUE
  const ci = d.ci_lower != null && d.ci_upper != null
    ? ` [${pp(d.ci_lower)}, ${pp(d.ci_upper)}] ${ciLabel(d.ci_method, d.ci_level)}`
    : ''
  return `${pp(d.value)}${ci}`
}

export function codeDifferenceNote(strand: JointDisplayCodeStrand): string | null {
  const reason = strand.difference.unavailable_reason
  return reason ? (EFFECT_ABSENT_TEXT[reason] ?? describeUndefined(reason)) : null
}

export function formatVariableCell(strand: JointDisplayVariableStrand, cell: JointDisplayVariableCell): string {
  if (strand.summary === V.SUMMARY_MEAN) {
    const sd = cell.sd != null ? ` (SD ${formatDescriptive(cell.sd)})` : ''
    return `${formatDescriptive(cell.mean)}${sd}, n ${cell.n}`
  }
  if (strand.summary === V.SUMMARY_DISTRIBUTION) {
    // The categories this group HOLDS — a category absent from the list is a 0, and listing
    // every category in every group made five groups unreadable (driven 2026-11-12e).
    const parts = cell.distribution.filter(c => c.count > 0).map(c => `${c.label} ${c.count}`)
    return `${parts.length ? parts.join(' · ') : NO_VALUE}, n ${cell.n}`
  }
  return NO_VALUE
}

export function variableCellNote(cell: JointDisplayVariableCell): string | null {
  if (cell.mean_undefined_reason) return describeUndefined(cell.mean_undefined_reason)
  // The mean is printed and its SD is not: say WHICH number is missing.
  const sd = describeUndefined(cell.sd_undefined_reason)
  return sd ? `SD: ${sd}` : null
}

export function formatEffect(strand: JointDisplayVariableStrand): string {
  const e = strand.effect
  if (!e || e.d == null) return NO_VALUE
  const ci = e.ci_lower != null && e.ci_upper != null
    ? ` [${formatDescriptive(e.ci_lower)}, ${formatDescriptive(e.ci_upper)}] ${ciLabel(e.ci_method, e.ci_level)}`
    : ''
  return `d = ${formatDescriptive(e.d)}${ci}`
}

export function effectNote(strand: JointDisplayVariableStrand): string | null {
  if (strand.effect == null && strand.summary === V.SUMMARY_DISTRIBUTION && !strand.formed_groups) {
    return 'A categorical variable has no single difference; compare its distributions.'
  }
  const reason = strand.effect?.unavailable_reason
  return reason ? (EFFECT_ABSENT_TEXT[reason] ?? describeUndefined(reason)) : null
}

// ── Drift (D168.5): the cells as printed, keyed stably ───────────────────────────────

/**
 * What the row DRAWS, as printed, keyed by strand and group. The ONE projection both the
 * baseline stamp and the "numbers moved" line read, so a change the view cannot show is not
 * a change, and one it can show is never missed (#808's rule: project what is drawn).
 */
export function rowCells(row: JointDisplayRowResult): Record<string, string> {
  const out: Record<string, string> = {}
  // Slice 2 (r1-7): keyed per strand — two codes strands may bind ONE code, and keyed by code
  // alone the second overwrote the first. Slice 1's two strands keep slice 1's keys (no suffix),
  // so a stamped slice 1 row still matches. The id stays the key's SECOND part: the import
  // remaps it there (`joint_display_node.py::BASELINE_KEY_TABLES`).
  for (const [key, st] of Object.entries(resultStrands(row))) {
    const at = key === IMPLICIT_CODES_KEY || key === IMPLICIT_VARIABLES_KEY ? '' : `@${key}`
    for (const s of st.codes) {
      for (const c of s.cells) {
        out[`code:${s.code_id}${at}:${c.group}`] = formatStrandCodeCell(st.kind, c)
        // #1645: drawn ONCE per row (`rowRatedCodes`) but still keyed per strand — each strand's
        // copy is the same person-level number (`_rating` takes no strand), so they move together
        // and a stamped baseline's keys stay valid.
        const r = formatRatingCell(c)
        if (r != null) out[`rating:${s.code_id}${at}:${c.group}`] = r
      }
      out[`code:${s.code_id}${at}:difference`] = formatCodeDifference(s)
    }
    for (const s of st.variables) {
      for (const c of s.cells) out[`variable:${s.column_id}${at}:${c.group}`] = formatVariableCell(s, c)
      out[`variable:${s.column_id}${at}:effect`] = formatEffect(s)
    }
    for (const o of st.observation_codes) out[`observation:${o.code_id}${at}:beside`] = formatObservationCode(o)
  }
  return out
}

/** "8 min", "45 s", "1 h 12 min" — an observation's time as a cell prints it (r2-6). */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/**
 * An observation code's line (r1-4's measures, r2-6's words; the literature's L2): in the
 * observation's OWN unit, never a participant share — "2 of 3 observations · 15% of observed
 * time (9 min)", plus "· 5 clips" only where clips are counted (R6: in the AGREED observations
 * only; while each coder cuts their own, a split would double a count). "<1%" under half a percent.
 */
export function formatObservationCode(o: JointDisplayObservationCode): string {
  const of = `${o.observations} of ${o.of_observations} ${o.of_observations === 1 ? 'observation' : 'observations'}`
  let time: string = NO_VALUE
  if (o.time_share != null) {
    const pct = o.time_share * 100
    time = `${o.seconds > 0 && pct < 0.5 ? '<1' : Math.round(pct)}% of observed time (${formatDuration(o.seconds)})`
  }
  const clips = o.clips != null ? ` · ${o.clips} ${o.clips === 1 ? 'clip' : 'clips'}` : ''
  return `${of} · ${time}${clips}`
}

/**
 * A readable name for a `rowCells` key, from the row's current strands. `strandLabel` names a
 * named strand ("Planning time (Focus groups), High"); the group is everything after the second
 * colon (r2's found-beside 1: a group's label may hold a colon — "Band: 6" read "Band").
 */
export function cellLabel(row: JointDisplayRowResult, key: string, strandLabel?: (strandKey: string) => string): string {
  const first = key.indexOf(':')
  const second = key.indexOf(':', first + 1)
  const kind = key.slice(0, first)
  const idPart = key.slice(first + 1, second < 0 ? undefined : second)
  const group = second < 0 ? '' : key.slice(second + 1)
  const [idText, strandKey] = idPart.split('@')
  const n = Number(idText)
  const strands = resultStrands(row)
  const scoped = strandKey != null ? [strands[strandKey]].filter(Boolean) : Object.values(strands)
  let name: string | undefined
  for (const sr of scoped) {
    if (kind === 'variable') name ??= sr.variables.find(s => s.column_id === n)?.name
    if (kind === 'code' || kind === 'rating') name ??= sr.codes.find(s => s.code_id === n)?.name
    if (kind === 'observation') name ??= sr.observation_codes.find(c => c.code_id === n)?.name
  }
  const what = (name ?? (kind === 'variable' ? 'A variable' : 'A code'))
    + (strandKey != null && strandLabel ? ` (${strandLabel(strandKey)})` : '')
  const rated = kind === 'rating' ? ' (rated)' : ''
  if (group === 'difference') return `${what}, difference`
  if (group === 'effect') return `${what}, effect`
  if (group === 'beside') return `${what}, beside the groups`
  return `${what}${rated}, ${group}`
}

export interface RowDriftChange { key: string; label: string; was: string | null; now: string | null }

/**
 * What a row's drift stamp lets the viewer be told (#1672 D354, #1674 D357) — the ONE reading
 * the construct detail, the Compact view and the Report view share:
 * - `none` — no stamp, or nothing moved (silence is the signal);
 * - `moved` — the cells that moved, compared within ONE coder view;
 * - `other_scope` — the stamp was read under another coder view, or an unrecorded one: no
 *   figures and no "moved" mark. 🔴 It fails closed both ways round: a blind viewer is never
 *   shown a colleague-scoped stamp (a colleague's counts and rating means), and a viewer who
 *   sees every coder is never told numbers moved because a blind coder saved;
 * - `cleared` — a withdrawal cleared the figures (D357); the date is kept.
 * `viewer` is `baselineScopeOf(scope)`; null (no scope, D361) compares nothing.
 */
export type RowDriftState =
  | { kind: 'none' }
  | { kind: 'moved'; changes: RowDriftChange[]; stampedAt: string }
  | { kind: 'other_scope'; stampedAt: string }
  | { kind: 'cleared'; stampedAt: string }

export function rowDriftState(
  baseline: JointDisplayRowBaseline | null, row: JointDisplayRowResult, viewer: BaselineScope | null,
  strandLabel?: (strandKey: string) => string,
): RowDriftState {
  if (!baseline) return { kind: 'none' }
  if (baseline.cleared === 'withdrawal') return { kind: 'cleared', stampedAt: baseline.stamped_at }
  if (viewer == null || baseline.scope == null || baseline.scope !== viewer) {
    return { kind: 'other_scope', stampedAt: baseline.stamped_at }
  }
  const changes = rowDrift(baseline, row, strandLabel)
  return changes.length > 0 ? { kind: 'moved', changes, stampedAt: baseline.stamped_at } : { kind: 'none' }
}

/** Is the row's "moved" mark drawn (the Compact and Report views)? Only for `moved`. */
export function rowMoved(baseline: JointDisplayRowBaseline | null, row: JointDisplayRowResult, viewer: BaselineScope | null): boolean {
  return rowDriftState(baseline, row, viewer).kind === 'moved'
}

/**
 * The cells that moved since the baseline — empty when nothing did. A raw comparison, scope-blind:
 * screens read `rowDriftState`, never this (#1672).
 */
export function rowDrift(
  baseline: JointDisplayRowBaseline | null, row: JointDisplayRowResult, strandLabel?: (strandKey: string) => string,
): RowDriftChange[] {
  if (!baseline) return []
  const now = rowCells(row)
  const keys = new Set([...Object.keys(baseline.cells), ...Object.keys(now)])
  const changes: RowDriftChange[] = []
  for (const key of [...keys].sort()) {
    const was = baseline.cells[key] ?? null
    const cur = now[key] ?? null
    if (was !== cur) changes.push({ key, label: cellLabel(row, key, strandLabel), was, now: cur })
  }
  return changes
}
