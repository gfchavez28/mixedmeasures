/**
 * #1661 — the rule editor's sentence is the DRAFT's while it is edited: a line not yet finished
 * is left out and COUNTED, never printed as `“”` (a group line was both "missing" and returned
 * as `{group: ''}`) and never dropped unsaid (a variable line was); and it never falls back to
 * the SAVED rule's sentence above lines that no longer hold it. Saving an unfinished line is
 * still refused. Real Radix dialog; the read mocked (the harness of `CaseView-slice2.test.tsx`).
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JointDisplayCasesResponse } from '@/lib/api'
import { displayCoderScope, readDisplay } from '@/lib/joint-display'
import type { JointDisplayMisfit } from '@/lib/joint-display-misfit'
import * as W from '@/lib/joint-display-vocabulary'

const api = vi.hoisted(() => ({ cases: vi.fn() }))
vi.mock('@/lib/api', () => ({ jointDisplayApi: { cases: api.cases } }))

import CaseView, { type MisfitUpdate } from './CaseView'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const DISPLAY = {
  group_by_column_id: 7, conversation_ids: null, document_ids: null,
  rows: [{ key: 'r1', construct: 'Planning', code_ids: [3], column_ids: [8] }],
}

function resp(): JointDisplayCasesResponse {
  return {
    groups: ['High', 'Low'], total: 0, listed: 0, matched: null, unknown: null, rule_unavailable_reason: null,
    rule_withheld_columns: [], list_size: 0, added_outside: 0,
    codes: [{ code_id: 3, name: 'Positive response' }],
    variables: [{ column_id: 8, name: 'Training hours', dataset_id: 1, withheld: false, operators: ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'missing'] }],
    cases: [], named_cases: [], unavailable_reason: null,
  }
}

function renderView(misfit: unknown = null) {
  const display = readDisplay({ ...DISPLAY, rows: [{ ...DISPLAY.rows[0], misfit }] })
  let stored: JointDisplayMisfit | null = display.rows[0].misfit
  const onCommit = vi.fn((update: MisfitUpdate) => { stored = update(stored); return true })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CaseView open onOpenChange={vi.fn()} projectId={9} display={display} rowKey="r1"
        scope={displayCoderScope(false, 1)} noViewer={false} groupBy="Gain group" onCommit={onCommit} />
    </QueryClientProvider>,
  )
  return { onCommit }
}

/** The rule section's sentence: the paragraph right under its heading. */
async function sentence(): Promise<string> {
  const section = (await screen.findByRole('heading', { name: W.RULE_HEADING })).closest('section')!
  return section.querySelector('h3 + p')!.textContent ?? ''
}

const add = async () => fireEvent.click(await screen.findByRole('button', { name: W.RULE_ADD_CONDITION_TEXT }))
const what = (i: number, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: W.ruleFieldLabel(i, 'what') }), { target: { value } })
const group = (i: number, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: W.ruleFieldLabel(i, 'group') }), { target: { value } })

const SAVED = { rule: { conditions: [{ kind: 'group', group: 'High' }] }, added: [], removed: [] }

describe('#1661 — an unfinished line is counted, never printed as “” and never dropped unsaid', () => {
  it('a new group line with no group chosen: "No rule stated yet (1 condition not finished)", no “”', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    await add()
    expect(await sentence()).toBe(`${W.RULE_NONE_FINISHED_TEXT} (1 condition not finished)`)
    expect(screen.getByRole('dialog').textContent).not.toContain('“”')
  })

  it('a variable line with no comparison: counted, where it used to read as no rule at all', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    await add()
    what(1, 'v:8')
    expect(await sentence()).toBe(`${W.RULE_NONE_FINISHED_TEXT} (1 condition not finished)`)
    expect(await sentence()).not.toBe(W.RULE_EMPTY_TEXT)
  })

  it('a finished line and two unfinished: the finished clause, then the count (plural)', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    await add()
    group(1, 'High')
    await add()
    await add()
    what(3, 'v:8')
    expect(await sentence()).toBe('Gain group is “High” (2 conditions not finished)')
  })

  it('finishing the line drops the count (the positive control)', async () => {
    api.cases.mockResolvedValue(resp())
    renderView()
    await add()
    expect(await sentence()).toContain('not finished')
    group(1, 'Low')
    expect(await sentence()).toBe('Gain group is “Low”')
  })

  it('Save still refuses an unfinished line, and writes nothing', async () => {
    api.cases.mockResolvedValue(resp())
    const { onCommit } = renderView()
    await add()
    fireEvent.click(screen.getByRole('button', { name: W.RULE_SAVE_TEXT }))
    expect(screen.getByRole('alert')).toHaveTextContent(W.ruleNeedsValueText(1))
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('#1661 — the sentence is the DRAFT’s, never the saved rule’s, once the lines are drawn', () => {
  it('a saved rule reads as itself before any edit', async () => {
    api.cases.mockResolvedValue(resp())
    renderView(SAVED)
    await screen.findByRole('combobox', { name: W.ruleFieldLabel(1, 'group') })
    expect(await sentence()).toBe('Gain group is “High”')
  })

  it('removing the saved rule’s only line: "No rule stated", not the saved rule above an empty list', async () => {
    api.cases.mockResolvedValue(resp())
    renderView(SAVED)
    fireEvent.click(await screen.findByRole('button', { name: W.ruleRemoveLabel(1) }))
    expect(screen.queryByRole('combobox', { name: W.ruleFieldLabel(1, 'what') })).toBeNull()
    expect(await sentence()).toBe(W.RULE_EMPTY_TEXT)
  })

  it('turning the saved line into an unfinished one: counted, not the saved rule', async () => {
    api.cases.mockResolvedValue(resp())
    renderView(SAVED)
    await screen.findByRole('combobox', { name: W.ruleFieldLabel(1, 'group') })
    what(1, 'v:8')
    expect(await sentence()).toBe(`${W.RULE_NONE_FINISHED_TEXT} (1 condition not finished)`)
    // Discard brings the saved rule back, lines and sentence together
    fireEvent.click(screen.getByRole('button', { name: W.RULE_DISCARD_TEXT }))
    expect(await sentence()).toBe('Gain group is “High”')
    expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: W.ruleFieldLabel(1, 'group') })).toHaveValue('High')
  })
})

describe('#1661 — the words', () => {
  it('ruleDraftSentence: null with no line, the clause alone when every line is finished', () => {
    expect(W.ruleDraftSentence(null, 0)).toBeNull()
    expect(W.ruleDraftSentence('A is “x”', 0)).toBe('A is “x”')
    expect(W.ruleDraftSentence(null, 1)).toBe('No rule stated yet (1 condition not finished)')
    expect(W.ruleDraftSentence('A is “x”', 3)).toBe('A is “x” (3 conditions not finished)')
  })
})
