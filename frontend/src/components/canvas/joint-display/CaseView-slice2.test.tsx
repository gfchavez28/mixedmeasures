/**
 * Joint display slice 2, round 2 (r5) — the case view dialog, the open construct's "Cases that
 * don't fit" section, and the withdrawal confirm's misfit line. Real Radix dialog, keyboard-ish
 * presses; the read mocked. Each surface in its three states (`list-load-state.md` §4: `ready`
 * is the positive control), a reason REQUIRED (r3-9), the draft never read before it is saved.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JointDisplayCasesResponse, WithdrawalReport } from '@/lib/api'
import { displayCoderScope, readDisplay } from '@/lib/joint-display'
import type { JointDisplayMisfit } from '@/lib/joint-display-misfit'
import * as W from '@/lib/joint-display-vocabulary'

const api = vi.hoisted(() => ({ cases: vi.fn() }))
vi.mock('@/lib/api', () => ({ jointDisplayApi: { cases: api.cases } }))

import CaseView, { type MisfitUpdate } from './CaseView'
import ConstructDetail from './ConstructDetail'
import WithdrawParticipantDialog from '@/components/WithdrawParticipantDialog'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const DISPLAY = {
  group_by_column_id: 7, conversation_ids: null, document_ids: null,
  rows: [{ key: 'r1', construct: 'Planning', code_ids: [3], column_ids: [8] }],
}
const facts = (used: boolean | null, hours: number | null) => ({
  codes: { has_material: used !== null, coded: used !== null, values: [], codes: [{ code_id: 3, passages: used ? 2 : 0, used }] },
  variables: { has_material: null, coded: null, codes: [], values: [{ column_id: 8, value: hours, label: null, reason: hours == null ? 'missing' : null }] },
})
function resp(over: Partial<JointDisplayCasesResponse> = {}): JointDisplayCasesResponse {
  return {
    groups: ['High', 'Low'], total: 3, listed: 3, matched: null, unknown: null, rule_unavailable_reason: null,
    rule_withheld_columns: [], list_size: 0, added_outside: 0,
    codes: [{ code_id: 3, name: 'Positive response' }],
    variables: [{ column_id: 8, name: 'Training hours', dataset_id: 1, withheld: false, operators: ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'missing'] }],
    cases: [
      { participant_id: 1, label: 'T1', group: 'High', facts: facts(true, 30), matches: null, listed_by: null, removed: false },
      { participant_id: 5, label: 'T5', group: 'Low', facts: facts(null, null), matches: null, listed_by: null, removed: false },
    ],
    named_cases: [], unavailable_reason: null, ...over,
  }
}

function client() { return new QueryClient({ defaultOptions: { queries: { retry: false } } }) }

function renderView(misfit: unknown = null, over: { noViewer?: boolean; scope?: ReturnType<typeof displayCoderScope> } = {}) {
  const display = readDisplay({ ...DISPLAY, rows: [{ ...DISPLAY.rows[0], misfit }] })
  let stored: JointDisplayMisfit | null = display.rows[0].misfit
  const onCommit = vi.fn((update: MisfitUpdate) => { stored = update(stored); return true })
  render(
    <QueryClientProvider client={client()}>
      <CaseView open onOpenChange={vi.fn()} projectId={9} display={display} rowKey="r1"
        scope={over.scope ?? displayCoderScope(false, 1)} noViewer={over.noViewer ?? false} groupBy="Gain group" onCommit={onCommit} />
    </QueryClientProvider>,
  )
  return { onCommit, stored: () => stored }
}

describe('the case view — its states (never a "0 cases" before an answer)', () => {
  it('loading: says so, and nothing claims the list is empty', async () => {
    api.cases.mockReturnValue(new Promise(() => {}))
    renderView()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(W.CASES_LOADING_TEXT)).toBeInTheDocument()
    expect(within(dialog).queryByText(W.CASES_EMPTY_LIST_TEXT)).toBeNull()
    expect(within(dialog).queryByText(W.CASES_NO_GROUPS_TEXT)).toBeNull()
  })

  it('failed: the shared notice with a Retry, no table', async () => {
    api.cases.mockRejectedValue(new Error('boom'))
    renderView()
    expect(await screen.findByText(W.CASES_FAILED_TEXT)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('ready (positive control): one row per case, each code and value said — no material is never "not used"', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    const table = await screen.findByRole('table')
    const t5 = within(table).getByRole('rowheader', { name: 'T5' }).closest('tr')!
    expect(within(t5).getByText(W.CASE_NO_MATERIAL_TEXT)).toBeInTheDocument()
    expect(within(t5).getByText('no answer')).toBeInTheDocument()
    const t1 = within(table).getByRole('rowheader', { name: 'T1' }).closest('tr')!
    expect(within(t1).getByText('used (2 passages)')).toBeInTheDocument()
    // r3-13 b, in the dialog's description
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(`${W.MISFIT_PRINCIPLE_TEXT} ${W.CASE_VIEW_DISCLOSURE_TEXT}`)
    // the read is the compute's: its scope and the row's bindings
    expect(api.cases.mock.calls[0][1]).toMatchObject({ coder_ids: null, row_key: 'r1', limit: 50, offset: 0, only: 'all' })
  })

  it('blind with no viewer (D96): no read, one sentence', async () => {
    renderView(null, { noViewer: true, scope: displayCoderScope(true, null) })
    expect(await screen.findByText(W.CASES_NO_VIEWER_TEXT)).toBeInTheDocument()
    expect(api.cases).not.toHaveBeenCalled()
  })

  it('blind: a rule over a rating score is not run, and the variable is named (r3-3)', async () => {
    api.cases.mockResolvedValue(resp({ rule_withheld_columns: ['Rating score'], rule_unavailable_reason: 'rating_withheld_blind' }))
    renderView({ rule: { conditions: [{ kind: 'variable', column_id: 8, op: 'lt', value: 3 }] }, added: [], removed: [] })
    expect(await screen.findByText(W.misfitRuleWithheldText(['Rating score']))).toBeInTheDocument()
  })
})

describe('adding a case takes a reason (r3-9)', () => {
  it('an empty reason is refused and nothing is written; a reason adds the case, and focus lands on its list', async () => {
    api.cases.mockResolvedValue(resp())
    const { onCommit, stored } = renderView()
    fireEvent.click(await screen.findByRole('button', { name: W.caseAddLabel('T5') }))
    const field = screen.getByRole('textbox', { name: W.caseReasonLabel('add', 'T5') })
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(W.MISFIT_DISCLOSURE_TEXT)   // r3-13 a, beside it
    fireEvent.click(screen.getByRole('button', { name: W.CASE_ADD_CONFIRM_TEXT }))
    expect(screen.getByRole('alert')).toHaveTextContent(W.MISFIT_REASON_REQUIRED_TEXT)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'Moved schools mid-year' } })
    fireEvent.click(screen.getByRole('button', { name: W.CASE_ADD_CONFIRM_TEXT }))
    expect(stored()).toEqual({ rule: null, added: [{ participant_id: 5, reason: 'Moved schools mid-year' }], removed: [] })
    expect(screen.getByRole('heading', { name: `${W.MISFIT_ADDED_LABEL} (1)` })).toHaveFocus()
    // the list's entry is editable, and an emptied reason is never stored
    const reason = screen.getByRole('textbox', { name: W.caseReasonLabel('add', 'T5') })
    fireEvent.change(reason, { target: { value: '  ' } })
    fireEvent.blur(reason)
    expect(stored()!.added[0].reason).toBe('Moved schools mid-year')
    expect(screen.getByText(W.MISFIT_REASON_KEPT_TEXT)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: W.caseUndoLabel('add', 'T5') }))
    expect(stored()).toBeNull()
  })
})

describe('the rule editor (r3-1, r3-10)', () => {
  it('a condition per line; the sentence above; saving writes the rule through onCommit, and the read follows the SAVED rule', async () => {
    api.cases.mockResolvedValue(resp())
    const { stored } = renderView()
    fireEvent.click(await screen.findByRole('button', { name: W.RULE_ADD_CONDITION_TEXT }))
    expect(screen.getByRole('combobox', { name: W.ruleFieldLabel(1, 'what') })).toHaveFocus()
    fireEvent.change(screen.getByRole('combobox', { name: W.ruleFieldLabel(1, 'group') }), { target: { value: 'High' } })
    expect(screen.getByText('Gain group is “High”')).toBeInTheDocument()
    // a draft is never evaluated: still the first read only
    expect(api.cases.mock.calls.every(c => c[1].rule == null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: W.RULE_SAVE_TEXT }))
    expect(stored()!.rule).toEqual({ conditions: [{ kind: 'group', group: 'High' }] })
    await waitFor(() => expect(api.cases.mock.calls.some(c => c[1].rule?.conditions?.[0]?.group === 'High')).toBe(true))
  })

  it('a variable condition needs a value before it saves', async () => {
    api.cases.mockResolvedValue(resp())
    const { onCommit } = renderView()
    fireEvent.click(await screen.findByRole('button', { name: W.RULE_ADD_CONDITION_TEXT }))
    fireEvent.change(screen.getByRole('combobox', { name: W.ruleFieldLabel(1, 'what') }), { target: { value: 'v:8' } })
    fireEvent.change(screen.getByRole('combobox', { name: W.ruleFieldLabel(1, 'comparison') }), { target: { value: 'lt' } })
    fireEvent.click(screen.getByRole('button', { name: W.RULE_SAVE_TEXT }))
    expect(screen.getByRole('alert')).toHaveTextContent(W.ruleNeedsValueText(1))
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('paging (r3-8)', () => {
  it('50 a page; Next asks the next page and keeps focus', async () => {
    api.cases.mockResolvedValue(resp({ listed: 120, total: 120 }))
    renderView()
    expect(await screen.findByText(W.casesRangeText(1, 50, 120))).toBeInTheDocument()
    const next = screen.getByRole('button', { name: W.CASES_NEXT_TEXT })
    next.focus()
    fireEvent.click(next)
    await waitFor(() => expect(api.cases.mock.calls.some(c => c[1].offset === 50)).toBe(true))
    expect(next).toHaveFocus()
    expect(screen.getByRole('button', { name: W.CASES_PREVIOUS_TEXT })).not.toHaveAttribute('aria-disabled')
  })
})

describe('the open construct’s section (r5-1)', () => {
  function renderDetail(misfit: unknown, onCasesRequest: (() => void) | null = vi.fn()) {
    const display = readDisplay({ ...DISPLAY, rows: [{ ...DISPLAY.rows[0], misfit }] })
    render(
      <QueryClientProvider client={client()}>
        <ConstructDetail id="d" display={display} row={display.rows[0]} result={null} groups={[]} isEditable self={1}
          withholding={false} authorName={() => null} facts={new Map()} factsState="ready"
          results={{ status: 'none', results: new Map(), tables: new Map() } as never} draftKey="k-detail"
          onChange={vi.fn()} onPinRequest={null}
          cases={{ projectId: 9, scope: displayCoderScope(false, 1), settled: true, noViewer: false, groupBy: 'Gain group' }}
          onCasesRequest={onCasesRequest} />
      </QueryClientProvider>,
    )
  }

  it('nothing yet: says so, and offers the case view', () => {
    const open = vi.fn()
    renderDetail(null, open)
    expect(screen.getByText(W.MISFIT_NONE_TEXT)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: W.caseViewOpenLabel('Planning') }))
    expect(open).toHaveBeenCalled()
    expect(api.cases).not.toHaveBeenCalled()
  })

  it('a rule and an added case: the sentence, then the count and the case by identifier, from a count-only read', async () => {
    api.cases.mockResolvedValue(resp({ matched: 3, unknown: 2, total: 22, named_cases: [{ participant_id: 11, label: 'T11', group: 'Low' }] }))
    renderDetail({ rule: { conditions: [{ kind: 'group', group: 'High' }] }, added: [{ participant_id: 11, reason: 'Moved' }], removed: [] })
    expect(screen.getByText(/Gain group is “High”/)).toBeInTheDocument()
    expect(await screen.findByText(W.misfitCountText(3, 22, 2))).toBeInTheDocument()
    expect(screen.getByText('T11 — Moved')).toBeInTheDocument()
    expect(api.cases.mock.calls[0][1]).toMatchObject({ limit: 0, added_participant_ids: [11] })
  })

  it('a failed count is said, never a number', async () => {
    api.cases.mockRejectedValue(new Error('boom'))
    renderDetail({ rule: { conditions: [{ kind: 'group', group: 'High' }] }, added: [], removed: [] })
    expect(await screen.findByText(new RegExp(W.MISFIT_COUNT_FAILED_TEXT))).toBeInTheDocument()
    expect(screen.queryByText(/meet the rule/)).toBeNull()
  })

  it('blind with no viewer (D96): no read, the sentence in the count’s place', () => {
    const display = readDisplay({ ...DISPLAY, rows: [{ ...DISPLAY.rows[0], misfit: { rule: { conditions: [{ kind: 'group', group: 'High' }] }, added: [], removed: [] } }] })
    render(
      <QueryClientProvider client={client()}>
        <ConstructDetail id="d" display={display} row={display.rows[0]} result={null} groups={[]} isEditable self={null}
          withholding authorName={() => null} facts={new Map()} factsState="ready"
          results={{ status: 'none', results: new Map(), tables: new Map() } as never} draftKey="k-detail-2"
          onChange={vi.fn()} onPinRequest={null}
          cases={{ projectId: 9, scope: displayCoderScope(true, null), settled: true, noViewer: true, groupBy: 'Gain group' }}
          onCasesRequest={null} />
      </QueryClientProvider>,
    )
    expect(screen.getByText(W.CASES_NO_VIEWER_TEXT)).toBeInTheDocument()
    expect(api.cases).not.toHaveBeenCalled()
  })

  it('Q2 (round-2 combine): after the evidence, before the judgement — the section, then Fit, then the meta-inference', () => {
    renderDetail(null)
    const heads = screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent ?? '')
    expect(heads.indexOf(W.MISFIT_HEADING)).toBeGreaterThan(-1)
    expect(heads.indexOf(W.MISFIT_HEADING)).toBeLessThan(heads.indexOf('Fit'))
    expect(heads.indexOf('Fit')).toBeLessThan(heads.indexOf('Meta-inference'))
  })

  it('read-only (no host): no button', () => {
    renderDetail(null, null)
    expect(screen.queryByRole('button', { name: W.caseViewOpenLabel('Planning') })).toBeNull()
  })
})

describe('the withdrawal confirm (r3-6, wired in round 2)', () => {
  const report = (n: number) => ({
    participant_id: 1, identifier: 'P07', display_name: 'Maria', role: null, has_demographics: true,
    speaker_names: [], total_items: 1, unlinked_records_with_identifier: 0,
    canvas_quotes_unplaced: { quotes: 0, sections: [], snapshots: [] }, canvas_misfit_cases: n,
    other_projects_with_identifier: { projects: [], total: 0 }, pre_update_copies: { count: 0, folder: '/b' },
    conversations: [], datasets: [], documents: [],
  }) as unknown as WithdrawalReport
  const load = { status: 'ready' as const, error: null, retry: vi.fn(), retrying: false }
  it('says their entries go, inside the description — and nothing when there are none', () => {
    render(<WithdrawParticipantDialog open participant={{ identifier: 'P07', display_name: null }} report={report(2)}
      reportLoad={load} isPending={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/named, with your reason, in 2 lists of cases that don’t fit/)
    cleanup()
    render(<WithdrawParticipantDialog open participant={{ identifier: 'P07', display_name: null }} report={report(0)}
      reportLoad={load} isPending={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('alertdialog')).not.toHaveAccessibleDescription(/cases that don’t fit/)
  })
})
