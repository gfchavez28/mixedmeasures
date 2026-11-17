/**
 * #1660 (D345) — the open construct's presses that take their own control away land focus on
 * the control that acts next. The construct detail mounts INSIDE the node view, with no dialog
 * around it, so a removed button dropped focus to `<body>` — the top of the page:
 *
 * - *Unpin this quote* → the next pin's Unpin in that group, else the previous one's, else that
 *   group's *Pin a quote*;
 * - a fit's *Remove* → the fit now in its place (at two fits, both Remove buttons go);
 * - *Compare another pair* that adds the LAST pair (its button unmounts) → the new fit.
 *
 * A STATEFUL node: `updateAttributes` writes the attrs back, so a press really removes what it
 * removes (with the plain mock the card stays and nothing is ever lost). Mocks as
 * `JointDisplayView-five-1646-1664-1665.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import '@testing-library/jest-dom/vitest'
import type { NodeViewProps } from '@tiptap/core'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 1 } }) }))
vi.mock('@/hooks/useBlindMode', () => ({ useBlindMode: () => ({ blind: false, withholding: false, settled: true }) }))
const NO_MACHINES = new Set<number>()
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ coderMap: new Map([[1, { id: 1, username: 'Me' }]]) }),
  useMachineCoderIds: () => NO_MACHINES,
}))
vi.mock('@/hooks/useListLoad', () => ({ useListLoad: () => ({ status: 'loading', error: null, retry: () => {}, retrying: false }) }))

const api = vi.hoisted(() => ({ compute: vi.fn(), pinFacts: vi.fn(), passages: vi.fn(), cases: vi.fn() }))
vi.mock('@/lib/api', () => ({
  jointDisplayApi: api,
  excerptsApi: { wholePassage: vi.fn() },
  codesApi: { list: vi.fn() }, conversationsApi: { list: vi.fn() }, documentsApi: { list: vi.fn() },
  metricsApi: { analysisColumns: vi.fn(), quickCompute: vi.fn(), crossTabulation: vi.fn() },
  materialsApi: { listAllMaterials: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
}))

import JointDisplayView from './JointDisplayView'
import { DialogsContext } from '../joint-display/display-store'
import { ADD_FIT_PAIR_TEXT } from '@/lib/joint-display-vocabulary'

let mountCount = 0

function codeStrand(name: string, passages: number) {
  return {
    code_id: 31, name, unit: 'participants', rated: false, formed_groups: null,
    cells: [
      { group: 'High', count: 3, n: 11, share: 3 / 11, share_undefined_reason: null, passages, rating: null },
      { group: 'Low', count: 1, n: 10, share: 0.1, share_undefined_reason: null, passages: 1, rating: null },
    ],
    difference: { value: 0.17, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
  }
}
const strandOf = (kind: string, status: string, lists: Record<string, unknown> = {}) =>
  ({ kind, status, codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [], ...lists })
const facts = (key: string, kind: string) => ({ key, kind, unit: 'participants', dataset_id: null, observations: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
  groups: [{ key: 'High', with_material: 11, without_coding: 0, surveyed: null },
    { key: 'Low', with_material: 10, without_coding: 0, surveyed: null }] })

const PAYLOAD = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 },
    { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
  unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
  rating: null,
  strands: [facts('s-int', 'codes'), facts('s-fg', 'codes'), facts('s-doc', 'codes')],
  rows: [{ key: 'r1', codes: [codeStrand('Planning time', 9)], variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' },
    by_strand: {
      's-int': strandOf('codes', 'covers', { codes: [codeStrand('Planning time', 9)] }),
      's-fg': strandOf('codes', 'covers', { codes: [codeStrand('Planning time', 4)] }),
      's-doc': strandOf('codes', 'covers', { codes: [codeStrand('Planning time', 2)] }),
    } }],
}

const pin = (text: string) => ({ excerptId: null, displayText: text, sourceContext: '', conversationId: null,
  observationId: null, group: 'High', role: null, purpose: '', strand: 's-int' })

/** Three code strands — so three pairs; two recorded, so Remove shows and one pair is left to add. */
const display = (over: Record<string, unknown> = {}) => ({
  title: 'Teachers', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-fg', kind: 'codes', label: 'Focus groups', conversation_ids: [6], document_ids: [] },
    { key: 's-doc', kind: 'codes', label: 'Workplans', conversation_ids: [], document_ids: [7] },
  ],
  rows: [{ key: 'r1', construct: 'Protected planning time',
    bindings: { 's-int': { code_ids: [31] }, 's-fg': { code_ids: [31] }, 's-doc': { code_ids: [31] } },
    fits: [{ strands: ['s-int', 's-fg'], fit: null }, { strands: ['s-int', 's-doc'], fit: null }],
    pins: [pin('We get an hour.'), pin('Fridays are ours.')], ...over }],
})

function Node({ initial }: { initial: unknown }) {
  const [attrs, setAttrs] = useState({ displayKey: `focus-${mountCount}`, figureEpoch: 3, display: initial })
  const props = {
    node: { attrs },
    updateAttributes: (patch: Record<string, unknown>) => setAttrs(a => ({ ...a, ...patch })),
    deleteNode: vi.fn(), selected: false, editor: { isEditable: true },
  } as unknown as NodeViewProps
  return <JointDisplayView {...props} />
}

function mount(initial: unknown = display()) {
  mountCount += 1
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={vi.fn()}>
          <Node initial={initial} />
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const openConstruct = async () => {
  await screen.findByRole('table')
  fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
}

/** A keyboard press: focus first (the landing acts only after a press made WITH focus). */
const press = (el: HTMLElement) => { el.focus(); fireEvent.click(el) }

beforeEach(() => {
  api.compute.mockResolvedValue(PAYLOAD)
  api.pinFacts.mockResolvedValue({ pins: [] })
  api.cases.mockResolvedValue({ groups: [], total: 0, listed: 0, matched: null, unknown: null,
    rule_unavailable_reason: null, rule_withheld_columns: [], list_size: 0, added_outside: 0, heads: [], cases: [], named_cases: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1660 (D345) — Unpin', () => {
  it('lands on the next pin’s Unpin, then on the group’s Pin a quote', async () => {
    mount()
    await openConstruct()
    const unpins = await screen.findAllByRole('button', { name: 'Unpin this quote' })
    expect(unpins).toHaveLength(2)
    press(unpins[0])
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Unpin this quote' })).toHaveLength(1))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Unpin this quote' })))

    press(screen.getByRole('button', { name: 'Unpin this quote' }))
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Pin a quote for High, Protected planning time' })))
    expect(document.activeElement).not.toBe(document.body)
  })
})

describe('#1660 (D345) — a fit’s Remove and Compare another pair', () => {
  it('Remove lands on the fit now in its place — whose own Remove is gone at one fit', async () => {
    mount()
    await openConstruct()
    const removes = await screen.findAllByRole('button', { name: /^Remove the .* fit for Protected planning time$/ })
    expect(removes).toHaveLength(2)
    press(removes[0])
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Remove the .* fit for/ })).toHaveLength(0))
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('combobox', { name: 'First strand of fit 1 for Protected planning time' })))
  })

  it('adding the LAST pair lands on the new fit; CONTROL: an add below it keeps focus', async () => {
    mount(display({ fits: [{ strands: ['s-int', 's-fg'], fit: null }] }))
    await openConstruct()
    const add = await screen.findByRole('button', { name: ADD_FIT_PAIR_TEXT })
    press(add)  // the 2nd of 3 pairs: the button stays and keeps focus
    await screen.findByRole('combobox', { name: 'First strand of fit 2 for Protected planning time' })
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(add).toHaveFocus()
    press(add)  // the 3rd and last: the button unmounts
    await waitFor(() => expect(screen.queryByRole('button', { name: ADD_FIT_PAIR_TEXT })).toBeNull())
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('combobox', { name: 'First strand of fit 3 for Protected planning time' })))
  })
})
