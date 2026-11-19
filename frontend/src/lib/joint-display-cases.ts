/**
 * Joint display slice 2, round 2 (r5) — the case view's model: the case read's request, the
 * writers of a row's misfit (the rule, the added and removed cases, each reason), what a case's
 * cell says, and the facts the report's note prints. Pure — the dialog, the open construct, the
 * Report view and the export all ask it, so the screen and the file cannot disagree.
 *
 * 🔴 The app never decides misfit (D173): it evaluates the researcher's rule and keeps their
 * additions and removals, each with the reason they wrote (r3-9). Nothing here proposes a case.
 * Words come from `joint-display-vocabulary.ts` (C7); `joint-display-misfit.ts` reads the stored
 * shape and writes the rule's sentence. (A module of its own: `joint-display.ts` imports
 * `joint-display-misfit.ts`, so the request builder, which needs `computeRequest`, lives here.)
 */
import type { JointDisplayCaseFacts, JointDisplayCasesRequest, JointDisplayCasesResponse } from './api/joint-display'
import { computeRequest, type DisplayCoderScope, type JointDisplay, type JointDisplayRow } from './joint-display'
import { conditionRequest, type JointDisplayMisfit, type MisfitCase, type MisfitCondition, type RuleNames } from './joint-display-misfit'
import { displayStrands, strandTag } from './joint-display-strands'
import {
  CASE_LISTED_TEXT, CASE_NO_ANSWER_TEXT, CASE_NO_MATERIAL_TEXT, CASE_NOT_CODED_TEXT, CASE_NOT_USED_TEXT,
  CASE_USED_TEXT, CASE_VALUE_ABSENT_TEXT, MISFIT_COUNT_UNREAD_TEXT, MISFIT_RULE_UNAVAILABLE_TEXT,
  misfitCountText, misfitRuleWithheldText, misfitRuleGroupMissingText, casePassagesText,
  SERVER_VOCABULARY,
} from './joint-display-vocabulary'
import { NO_VALUE } from './stat-format'

/** r3-8 — a page of the case view. */
export const CASE_PAGE_SIZE = 50
/** r5-4 — the server's bound (`joint_display_cases.py::MAX_RULE_CONDITIONS`). */
export const MAX_RULE_CONDITIONS = 8
/** The server's bound on each list (`MAX_LISTED_CASES`). */
export const MAX_LISTED_CASES = 100

export type CaseListView = 'all' | 'list'
export type CaseListName = 'added' | 'removed'

/** A row has a misfit worth reading: a rule with a condition, or a case added or removed. */
export function hasMisfit(row: JointDisplayRow): boolean {
  const m = row.misfit
  return m != null && ((m.rule?.conditions.length ?? 0) > 0 || m.added.length > 0 || m.removed.length > 0)
}

const ids = (cases: MisfitCase[]) => cases.map(c => c.participant_id).filter((x): x is number => x != null)

/**
 * The case read for one row (C3, `POST …/joint-display/cases`), built from the compute's own
 * request so the case view reads exactly the display's strands, sources and coder scope
 * (D175: `scope` is the compute's, from `useBlindMode().withholding`). Null while the display
 * has no grouping variable or the row is gone. `rule` is the one to evaluate — the SAVED rule
 * everywhere (the dialog's draft is never read before it is saved).
 */
export function caseRequest(
  display: JointDisplay, rowKey: string, scope: DisplayCoderScope | null,
  opts: { only: CaseListView; offset: number; limit: number },
): JointDisplayCasesRequest | null {
  const base = computeRequest(display, scope)
  const row = display.rows.find(r => r.key === rowKey)
  const rowReq = base?.rows.find(r => r.key === rowKey)
  if (!base || !row || !rowReq) return null
  const m = row.misfit
  const conditions = m?.rule?.conditions ?? []
  return {
    group_by_column_id: base.group_by_column_id,
    // The strands carry every source; the display-level lists are slice 1's and unread here.
    conversation_ids: null,
    document_ids: null,
    strands: base.strands,
    coder_ids: base.coder_ids,
    layer_scope: base.layer_scope,
    row_key: rowKey,
    bindings: Object.fromEntries(Object.entries(rowReq.bindings)
      .map(([k, b]) => [k, { code_ids: b.code_ids, column_ids: b.column_ids }])),
    rule: conditions.length ? { conditions: conditions.map(conditionRequest) } : null,
    only: opts.only,
    added_participant_ids: ids(m?.added ?? []),
    removed_participant_ids: ids(m?.removed ?? []),
    offset: opts.offset,
    limit: opts.limit,
  }
}

/** r5-7 — the count alone (no person's facts): the open construct, the Report view, the export. */
export function caseCountRequest(display: JointDisplay, rowKey: string, scope: DisplayCoderScope | null): JointDisplayCasesRequest | null {
  const row = display.rows.find(r => r.key === rowKey)
  if (!row || !hasMisfit(row)) return null
  return caseRequest(display, rowKey, scope, { only: 'all', offset: 0, limit: 0 })
}

// ── Writing a row's misfit (every edit one `commitDisplay`, D213) ────────────────────────

const EMPTY: JointDisplayMisfit = { rule: null, added: [], removed: [] }

/** An empty misfit is stored as null, as a row that never had one — unless a later release's
 *  member rides on it (the reader keeps those, R1), which only null would drop. */
function settle(m: JointDisplayMisfit): JointDisplayMisfit | null {
  const extra = Object.keys(m).some(k => !['rule', 'added', 'removed'].includes(k))
  return !extra && !m.rule && m.added.length === 0 && m.removed.length === 0 ? null : m
}

/** Save the rule (null or no condition = no rule). r3-1: the conditions are joined by AND. */
export function withRule(m: JointDisplayMisfit | null, conditions: MisfitCondition[] | null): JointDisplayMisfit | null {
  const cur = m ?? EMPTY
  return settle({ ...cur, rule: conditions && conditions.length ? { ...(cur.rule ?? {}), conditions } : null })
}

/** r3-9 / r3-12 — add a case to a list with its (required, trimmed) reason. A case is on ONE
 *  list: adding it takes it off the other. Null when the reason is empty — never stored. */
export function withCase(
  m: JointDisplayMisfit | null, list: CaseListName, participantId: number, reason: string,
): JointDisplayMisfit | null | undefined {
  const why = reason.trim()
  if (!why) return undefined
  const cur = m ?? EMPTY
  const other: CaseListName = list === 'added' ? 'removed' : 'added'
  return settle({
    ...cur,
    [other]: cur[other].filter(c => c.participant_id !== participantId),
    [list]: [...cur[list].filter(c => c.participant_id !== participantId), { participant_id: participantId, reason: why }],
  })
}

/** Undo an add or a removal — the case and its reason go. */
export function withoutCase(m: JointDisplayMisfit | null, list: CaseListName, participantId: number | null): JointDisplayMisfit | null {
  const cur = m ?? EMPTY
  return settle({ ...cur, [list]: cur[list].filter(c => c.participant_id !== participantId) })
}

/** Edit a reason in place (undefined = refused: a reason is required, r3-9). */
export function withReason(
  m: JointDisplayMisfit | null, list: CaseListName, participantId: number | null, reason: string,
): JointDisplayMisfit | null | undefined {
  const why = reason.trim()
  if (!why || !m) return undefined
  return settle({ ...m, [list]: m[list].map(c => (c.participant_id === participantId ? { ...c, reason: why } : c)) })
}

// ── What a case's cell says ───────────────────────────────────────────────────────────

/** One code of one code strand, for one case: used / not used / no material (r3-2). */
export function caseCodeText(facts: JointDisplayCaseFacts | undefined, codeId: number, kind: string): string {
  if (!facts) return NO_VALUE
  // r3-2: no material is "cannot be checked", never "not used".
  if (facts.has_material !== true) return kind === 'text_codes' ? CASE_NO_ANSWER_TEXT : CASE_NO_MATERIAL_TEXT
  const c = facts.codes.find(x => x.code_id === codeId)
  if (!c) return NO_VALUE
  if (c.used) return kind === 'text_codes' ? CASE_USED_TEXT : `${CASE_USED_TEXT} (${casePassagesText(c.passages)})`
  // #1626 D243: material and no coding in scope — "did not use" is not yet a finding.
  return facts.coded ? CASE_NOT_USED_TEXT : CASE_NOT_CODED_TEXT
}

function number(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

/** One variable for one case: its label (a category) or its value (a number) — or why none. */
export function caseValueText(facts: JointDisplayCaseFacts | undefined, columnId: number): string {
  const v = facts?.values.find(x => x.column_id === columnId)
  if (!v) return NO_VALUE
  if (v.reason) return CASE_VALUE_ABSENT_TEXT[v.reason] ?? NO_VALUE
  if (v.label != null && v.label !== '') return v.label
  return v.value != null ? number(v.value) : NO_VALUE
}

/** Where a case stands — read from the server's own fields, never re-derived. */
export function caseListedText(c: JointDisplayCasesResponse['cases'][number], ruleRan: boolean): string {
  if (c.removed) return CASE_LISTED_TEXT.removed
  if (c.listed_by === 'added') return CASE_LISTED_TEXT.added
  if (c.listed_by === 'rule') return CASE_LISTED_TEXT.rule
  if (ruleRan && c.matches === null) return CASE_LISTED_TEXT.unknown
  return CASE_LISTED_TEXT.no
}

/** The count line (r3-2), or why the rule was not run (r3-3 first, by name), or null (no rule). */
export function misfitStatusText(resp: JointDisplayCasesResponse, hasRule: boolean): string | null {
  if (!hasRule) return null
  if (resp.rule_withheld_columns.length > 0) return misfitRuleWithheldText(resp.rule_withheld_columns)
  if (resp.rule_unavailable_reason === SERVER_VOCABULARY.MISFIT_RULE_GROUP_MISSING) {
    return misfitRuleGroupMissingText(resp.rule_missing_groups ?? [])   // #1671 D351, by name
  }
  if (resp.rule_unavailable_reason) {
    return MISFIT_RULE_UNAVAILABLE_TEXT[resp.rule_unavailable_reason] ?? MISFIT_RULE_UNAVAILABLE_TEXT.condition_invalid
  }
  if (resp.matched == null) return null
  return misfitCountText(resp.matched, resp.total, resp.unknown ?? 0)
}

// ── The names a rule's sentence reads ──────────────────────────────────────────────────

/** A display's code strands (the kinds a code condition can name). */
export function codeStrandsOf(display: JointDisplay) {
  return displayStrands(display).filter(s => s.kind === 'codes' || s.kind === 'text_codes')
}

/**
 * RuleNames from a case read's own headers (the screen) — names only the row's bindings.
 * #1664 (D333): the row's INACTIVE bound codes are named too — a saved rule naming one is kept
 * (not run, and said), and the row still binds it, so "a code this row no longer binds" was false.
 */
export function ruleNamesFrom(
  display: JointDisplay,
  heads: {
    codes: { code_id: number; name: string }[]
    variables: { column_id: number; name: string }[]
    inactive?: { code_id: number; name: string }[]
  },
): RuleNames {
  const code = new Map([...(heads.inactive ?? []), ...heads.codes].map(c => [c.code_id, c.name]))
  const column = new Map(heads.variables.map(v => [v.column_id, v.name]))
  const strands = new Map(displayStrands(display).map(s => [s.key, strandTag(display, s)]))
  const kinds = new Map(displayStrands(display).map(s => [s.key, s.kind as string]))
  return {
    code: id => code.get(id) ?? null,
    column: id => column.get(id) ?? null,
    strand: key => strands.get(key) ?? null,
    strandKind: key => kinds.get(key) ?? null,
    codeStrandCount: codeStrandsOf(display).length,
  }
}

// ── What the report's note prints (r3-11) ──────────────────────────────────────────────

/** One row's misfit facts as the report reads them — or 'unread' (the read failed or was not
 *  made, D96): the note then says so, and names no case it could not identify. */
export type MisfitReportFacts = {
  countText: string | null
  named: Map<number, string>
  /** #1703 (d) (D374) — named cases in none of the display's groups now (`group` null). */
  outside: Set<number>
} | 'unread'

export function misfitReportFacts(resp: JointDisplayCasesResponse, hasRule: boolean): MisfitReportFacts {
  return {
    countText: misfitStatusText(resp, hasRule),
    named: new Map(resp.named_cases.map(c => [c.participant_id, c.label])),
    outside: new Set(resp.named_cases.filter(c => c.group == null).map(c => c.participant_id)),
  }
}

/** For the note: the count text and the identifier lookup, from the facts (or their absence). */
export function misfitNoteInputs(facts: MisfitReportFacts | undefined): {
  countText: string; identifier: (pid: number) => string | null; outsideGroups: (pid: number) => boolean
} {
  if (facts == null || facts === 'unread') {
    // Unknown is not "gone": '' numbers the case (exportCaseLabel) rather than calling it absent.
    return { countText: MISFIT_COUNT_UNREAD_TEXT, identifier: () => '', outsideGroups: () => false }
  }
  return {
    countText: facts.countText ?? '', identifier: pid => facts.named.get(pid) ?? null,
    outsideGroups: pid => facts.outside.has(pid),
  }
}
