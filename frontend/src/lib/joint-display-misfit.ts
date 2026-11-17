/**
 * Joint display slice 2 — a row's "cases that don't fit" (D173), as the document stores it
 * (C4) and as a researcher reads it: the tolerant reader, the rule as a sentence, the case
 * read's request, and the lines the export's note prints.
 *
 * 🔴 The app never decides misfit: a row's list is a RULE the researcher states (conditions
 * joined by AND, r3-1, evaluated by `POST …/joint-display/cases`) and the cases they ADD or
 * REMOVE, each with their reason (r3-9, r3-12) — with no rule, what they added. Every word a researcher reads is in `joint-display-vocabulary.ts`
 * (C7); this module only arranges them.
 */
import {
  CASE_OPERATOR_TEXT,
  MISFIT_HEADING,
  MISFIT_ADDED_LABEL,
  MISFIT_NO_REASON_TEXT,
  MISFIT_REMOVED_LABEL,
  MISFIT_RULE_LABEL,
  SERVER_VOCABULARY,
  type AttributionMode,
} from './joint-display-vocabulary'

export type MisfitCondition =
  | { kind: 'group'; group: string }
  | { kind: 'variable'; column_id: number | null; op: string; value: string | number | null }
  | { kind: 'code'; strand_key: string; code_id: number | null; present: boolean }
  /** A condition this version cannot read — kept VERBATIM and sent as it is, so the server
   *  answers `condition_invalid` and the view says so; never dropped, which would quietly
   *  change what the researcher's rule selects. */
  | { kind: 'unreadable'; raw: Record<string, unknown> }

export interface MisfitCase {
  /** Null only in a hand-edited file: an import drops an unresolved case (r3-5). */
  participant_id: number | null
  reason: string
}

/** r3-12 — a stated rule PLUS the researcher's recorded additions and removals. */
export interface JointDisplayMisfit {
  rule: { conditions: MisfitCondition[] } | null
  added: MisfitCase[]
  removed: MisfitCase[]
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
const id = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
/**
 * Joint display slice 2 (the combine, r1-9 at this level too): the members this build does not
 * know, kept so an edit here does not erase a later release's plain addition to the misfit, its
 * rule, a case or a condition. (A local copy: `joint-display.ts` imports this module.)
 */
function unknown(o: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !known.includes(k)))
}

function readCondition(v: unknown): MisfitCondition | null {
  const c = obj(v)
  if (!c) return null
  if (c.kind === 'group' && typeof c.group === 'string') {
    return { ...unknown(c, ['kind', 'group']), kind: 'group', group: c.group }
  }
  if (c.kind === 'variable' && typeof c.op === 'string') {
    const value = typeof c.value === 'string' || typeof c.value === 'number' ? c.value : null
    return { ...unknown(c, ['kind', 'column_id', 'op', 'value']), kind: 'variable', column_id: id(c.column_id), op: c.op, value }
  }
  if (c.kind === 'code' && typeof c.strand_key === 'string' && typeof c.present === 'boolean') {
    return {
      ...unknown(c, ['kind', 'strand_key', 'code_id', 'present']),
      kind: 'code', strand_key: c.strand_key, code_id: id(c.code_id), present: c.present,
    }
  }
  return { kind: 'unreadable', raw: c }
}

/** C6 member — the row's `misfit`, every member defaulted. Never throws; null when absent. */
export function readMisfit(raw: unknown): JointDisplayMisfit | null {
  const m = obj(raw)
  if (!m) return null
  const rule = obj(m.rule)
  const conditions = rule && Array.isArray(rule.conditions)
    ? rule.conditions.map(readCondition).filter((c): c is MisfitCondition => c != null)
    : null
  const cases = (v: unknown): MisfitCase[] => Array.isArray(v)
    ? v.map(obj).filter((c): c is Record<string, unknown> => c != null).map(c => ({
      ...unknown(c, ['participant_id', 'reason']),
      participant_id: id(c.participant_id),
      reason: typeof c.reason === 'string' ? c.reason : '',
    }))
    : []
  return {
    ...unknown(m, ['rule', 'added', 'removed']),
    rule: conditions && rule ? { ...unknown(rule, ['conditions']), conditions } : null,
    added: cases(m.added),
    removed: cases(m.removed),
  }
}

/** The condition as the server reads it (the `unreadable` kind goes back as it came). */
export function conditionRequest(c: MisfitCondition): Record<string, unknown> {
  // Only the members the server reads: a kept unknown member is the STORED shape's, not the wire's.
  switch (c.kind) {
    case 'unreadable': return c.raw
    case 'group': return { kind: c.kind, group: c.group }
    case 'variable': return { kind: c.kind, column_id: c.column_id, op: c.op, value: c.value }
    case 'code': return { kind: c.kind, strand_key: c.strand_key, code_id: c.code_id, present: c.present }
  }
}

/** How many ids a misfit holds that an import could not resolve (D202) — conditions only;
 *  an unresolved CASE is dropped on import (r3-5), so a null one is a hand-edited file's. */
export function misfitUnresolvedCount(m: JointDisplayMisfit | null): number {
  if (!m) return 0
  let n = [...m.added, ...m.removed].filter(c => c.participant_id == null).length
  for (const c of m.rule?.conditions ?? []) {
    if ((c.kind === 'variable' || c.kind === 'code') && (c.kind === 'variable' ? c.column_id : c.code_id) == null) n++
  }
  return n
}

export interface RuleNames {
  /** The grouping variable's name — a group condition reads "Gain group is “High”". */
  groupBy: string
  column: (id: number) => string | null
  code: (id: number) => string | null
  /** A code strand's label — said only when the display has more than one code strand. */
  strand: (key: string) => string | null
  codeStrandCount: number
}

function quote(s: string): string {
  return `“${s}”`
}

/** r3-10 — one condition as a clause of the rule's sentence. */
export function conditionText(c: MisfitCondition, names: RuleNames): string {
  switch (c.kind) {
    case 'group':
      return `${names.groupBy} is ${quote(c.group)}`
    case 'variable': {
      const name = (c.column_id != null && names.column(c.column_id)) || 'a variable this row no longer binds'
      const op = CASE_OPERATOR_TEXT[c.op] ?? 'compared in a way this version cannot read'
      if (c.op === SERVER_VOCABULARY.CASE_OP_MISSING) return `${name} ${op}`
      const value = typeof c.value === 'number' ? String(c.value) : quote(c.value ?? '')
      return `${name} ${op} ${value}`
    }
    case 'code': {
      const name = (c.code_id != null && names.code(c.code_id)) || 'a code this row no longer binds'
      const strand = names.codeStrandCount > 1 ? names.strand(c.strand_key) : null
      return `${c.present ? 'used' : 'did not use'} ${quote(name)}${strand ? ` (${strand})` : ''}`
    }
    default:
      return 'a condition this version cannot read'
  }
}

/** r3-10 — the whole rule, its clauses joined by "and" (r3-1: AND only). No full stop. */
export function ruleSentence(conditions: MisfitCondition[], names: RuleNames): string {
  return conditions.map(c => conditionText(c, names)).join(' and ')
}

/**
 * r3-7 — what names a case in an export: the participant identifier while the display
 * attributes quotes by it (the default, D163.4), else a numbered case — the display's one
 * choice of how identifying its file is, applied to cases as to quotes.
 */
export function exportCaseLabel(attribution: AttributionMode, identifier: string, index: number): string {
  return attribution === 'participant' && identifier ? identifier : `Case ${index + 1}`
}

export interface MisfitExportInput {
  construct: string
  misfit: JointDisplayMisfit
  attribution: AttributionMode
  /** The rule's sentence (`ruleSentence`), when there is a rule. */
  sentence?: string
  /** The count (`misfitCountText`) from the case read under the export's lens — or why the
   *  rule was not evaluated (the vocabulary's sentence), in its place. */
  countText?: string
  /** participant id → identifier (absent = no longer in the project). */
  identifier: (participantId: number) => string | null
}

/**
 * D174 + r3-11 — the note's line for one row's misfit list, or null when it has none. The
 * RULE and its COUNT, then each added and removed case with its reason (D173: the rule's
 * text and each reason are printed) — never the identifiers of the cases the rule selects
 * (r3-11, Kaiser 2009: a list adds identifying detail and no claim the rule does not make).
 */
export function misfitNoteLine(x: MisfitExportInput): string | null {
  const { misfit } = x
  const rule = misfit.rule && misfit.rule.conditions.length ? misfit.rule : null
  if (!rule && !misfit.added.length && !misfit.removed.length) return null
  let n = 0
  // A reason is the researcher's sentence: its own full stop goes (the list's separators and the
  // closing stop are the note's), its ? or ! stays — "any source.." printed in the build's drive.
  const items = (cases: MisfitCase[]) => cases.map(c => {
    const who = c.participant_id != null ? x.identifier(c.participant_id) : null
    const label = who == null ? 'a participant no longer in the project' : exportCaseLabel(x.attribution, who, n++)
    return `${label}: ${(c.reason.trim() || MISFIT_NO_REASON_TEXT).replace(/\.$/, '')}`
  }).join('; ')
  const closed = (s: string) => (/[!?…]$/.test(s) ? s : `${s}.`)
  const parts = [`${MISFIT_HEADING} — ${x.construct || 'Untitled construct'}.`]
  if (rule) parts.push(`${MISFIT_RULE_LABEL}: ${x.sentence ?? ''}. ${x.countText ?? ''}`.trim())
  if (misfit.added.length) parts.push(closed(`${MISFIT_ADDED_LABEL}: ${items(misfit.added)}`))
  if (misfit.removed.length) parts.push(closed(`${MISFIT_REMOVED_LABEL}: ${items(misfit.removed)}`))
  return parts.join(' ')
}
