/**
 * #1664 (D332–D334) — the case view with a bound code the codebook made INACTIVE (a merge).
 *
 * The server leaves the code out of `codes` (so out of the columns and the rule's menu) and names
 * it in `inactive_codes`; a saved rule naming it is not run (`code_inactive`). The view says which
 * code is out and where its coding went, names it in the saved rule's sentence, shows the saved
 * condition greyed with the reason, and offers it to no new condition. Real Radix dialog; the read
 * mocked (the harness of `CaseView.rule-draft-1661.test.tsx`).
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JointDisplayCasesResponse } from '@/lib/api'
import { displayCoderScope, readDisplay } from '@/lib/joint-display'
import * as W from '@/lib/joint-display-vocabulary'

const api = vi.hoisted(() => ({ cases: vi.fn() }))
vi.mock('@/lib/api', () => ({ jointDisplayApi: { cases: api.cases } }))

import CaseView from './CaseView'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const INACTIVE = { strand_key: 'codes', code_id: 3, name: 'Workload', merged_into_id: 4, merged_into_name: 'Barrier noted' }

function resp(over: Partial<JointDisplayCasesResponse> = {}): JointDisplayCasesResponse {
  return {
    groups: ['High', 'Low'], total: 0, listed: 0, matched: null, unknown: null,
    rule_unavailable_reason: W.SERVER_VOCABULARY.MISFIT_RULE_CODE_INACTIVE,
    rule_withheld_columns: [], rule_missing_groups: [], list_size: 0, added_outside: 0,
    codes: [{ code_id: 5, name: 'Planning time' }], inactive_codes: [INACTIVE],
    variables: [], cases: [], named_cases: [], unavailable_reason: null, ...over,
  }
}

function renderView() {
  const display = readDisplay({
    group_by_column_id: 7, conversation_ids: null, document_ids: null,
    rows: [{ key: 'r1', construct: 'Workload', code_ids: [3, 5], column_ids: [],
      misfit: { rule: { conditions: [{ kind: 'code', strand_key: 'codes', code_id: 3, present: false }] }, added: [], removed: [] } }],
  })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CaseView open onOpenChange={vi.fn()} projectId={9} display={display} rowKey="r1"
        scope={displayCoderScope(false, 1)} noViewer={false} onCommit={() => true} />
    </QueryClientProvider>,
  )
}

describe('#1664 — an inactive bound code in the case view', () => {
  it('says which code is out and where its coding went (D334), the Compact view’s sentence', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    expect(await screen.findByText(W.inactiveCodeText(INACTIVE))).toBeInTheDocument()
    expect(W.inactiveCodeText(INACTIVE)).toContain('was merged into “Barrier noted”')
  })

  it('the saved rule names it, says why it is not run, and keeps it greyed — never "no longer binds" (D333)', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    const section = (await screen.findByRole('heading', { name: W.RULE_HEADING })).closest('section')!
    await within(section).findByText('has no passage coded “Workload”')
    expect(section.textContent).not.toContain('no longer binds')
    expect(screen.getByRole('status')).toHaveTextContent(W.MISFIT_RULE_UNAVAILABLE_TEXT.code_inactive)
    // The saved condition still shows what it names: its option, greyed with the reason.
    const first = screen.getByRole('combobox', { name: W.ruleFieldLabel(1, 'what') }) as HTMLSelectElement
    expect(first.value).toBe('c:codes:3')
    const option = within(first).getByRole('option', { name: `Workload${W.RULE_INACTIVE_OPTION_SUFFIX}` })
    expect(option).toBeDisabled()
  })

  it('a NEW condition is offered the active code and the inactive one only greyed (the positive control)', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: W.RULE_ADD_CONDITION_TEXT }))
    const second = screen.getByRole('combobox', { name: W.ruleFieldLabel(2, 'what') })
    expect(within(second).getByRole('option', { name: 'Planning time' })).toBeEnabled()
    expect(within(second).getByRole('option', { name: `Workload${W.RULE_INACTIVE_OPTION_SUFFIX}` })).toBeDisabled()
  })

  it('with no inactive code nothing is said (the control)', async () => {
    api.cases.mockResolvedValue(resp({ inactive_codes: [], rule_unavailable_reason: null, matched: 0, unknown: 0 }))
    renderView()
    await screen.findByRole('heading', { name: W.RULE_HEADING })
    expect(screen.queryByTestId('case-view-inactive-codes')).toBeNull()
    expect(screen.queryByText(/inactive in the codebook/)).toBeNull()
  })
})
