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
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
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

import JointDisplayView, { DETAIL_CELL_BOX } from './JointDisplayView'
import { DialogsContext } from '../joint-display/display-store'
import { ADD_FIT_PAIR_TEXT, DRIFT_ACCEPT_CURRENT_TEXT } from '@/lib/joint-display-vocabulary'

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
    // #1714 (b), D397: each Unpin names its quote.
    const unpins = await screen.findAllByRole('button', { name: /^Unpin “/ })
    expect(unpins.map(b => b.getAttribute('aria-label'))).toEqual(['Unpin “We get an hour.”', 'Unpin “Fridays are ours.”'])
    press(unpins[0])
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Unpin “/ })).toHaveLength(1))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Unpin “Fridays are ours.”' })))

    press(screen.getByRole('button', { name: 'Unpin “Fridays are ours.”' }))
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
    // #1714 (a), D396: the button names its construct, its visible words first.
    const addName = `${ADD_FIT_PAIR_TEXT} for Protected planning time`
    const add = await screen.findByRole('button', { name: addName })
    press(add)  // the 2nd of 3 pairs: the button stays and keeps focus
    await screen.findByRole('combobox', { name: 'First strand of fit 2 for Protected planning time' })
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(add).toHaveFocus()
    press(add)  // the 3rd and last: the button unmounts
    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(`^${ADD_FIT_PAIR_TEXT}`) })).toBeNull())
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('combobox', { name: 'First strand of fit 3 for Protected planning time' })))
  })
})

/**
 * #1690 (D376) — TECHNIQUE only (jsdom computes no layout; the drive measures the widths): the
 * open construct sits in a width-0, full-min-width box inside its `colSpan` cell, so a bound
 * result's wide table cannot widen the display's own columns.
 */
describe('#1690 (D376) — the open construct’s box', () => {
  it('wraps the construct detail in DETAIL_CELL_BOX, inside the cell', async () => {
    mount()
    await openConstruct()
    const box = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-construct-detail-box]')
      if (!el) throw new Error('no detail box yet')
      return el
    })
    for (const cls of DETAIL_CELL_BOX.split(' ')) expect(box).toHaveClass(cls)
    expect(box.parentElement?.tagName).toBe('TD')
    expect(within(box).getByRole('textbox', { name: 'Meta-inference for Protected planning time' })).toBeInTheDocument()
  })
})

/**
 * #1704 (a) (D383) — a fit's strand selects offer no pair ANOTHER fit records. Choosing one made
 * two fits of one pair, and `rowFits`' de-duplication silently dropped the fit being edited.
 * The fixture's fits: (Interviews, Focus groups) and (Interviews, Workplans).
 */
describe('#1704 (a) (D383) — a recorded pair is not offered again', () => {
  const opts = (sel: HTMLElement) => within(sel).getAllByRole('option').map(o => o.textContent)

  it('fit 1 cannot become fit 2’s pair, and fit 2 cannot become fit 1’s', async () => {
    mount()
    await openConstruct()
    const second1 = await screen.findByRole('combobox', { name: 'Second strand of fit 1 for Protected planning time' })
    expect(opts(second1)).toEqual(['Focus groups'])   // not Workplans: fit 2 records Interviews · Workplans
    const second2 = screen.getByRole('combobox', { name: 'Second strand of fit 2 for Protected planning time' })
    expect(opts(second2)).toEqual(['Workplans'])      // not Focus groups: fit 1 records it
    // The first strand may move to a pair no fit records (Workplans · Focus groups), and keeps its own.
    const first1 = screen.getByRole('combobox', { name: 'First strand of fit 1 for Protected planning time' })
    expect(opts(first1)).toEqual(['Interviews', 'Focus groups', 'Workplans'])
  })

  it('CONTROL: with one fit, every pair is offered', async () => {
    mount(display({ fits: [{ strands: ['s-int', 's-fg'], fit: null }] }))
    await openConstruct()
    const second1 = await screen.findByRole('combobox', { name: 'Second strand of fit 1 for Protected planning time' })
    expect(opts(second1)).toEqual(['Focus groups', 'Workplans'])
  })
})

/**
 * #1689 (D375) — three more presses take their own control away: *Save meta-inference*
 * disables itself, and both *Accept …* buttons unmount with their note when the stamp is
 * re-made. Each lands on the meta-inference text box, never on `<body>`.
 */
describe('#1689 (D375) — the meta-inference presses', () => {
  const metaBox = () => screen.getByRole('textbox', { name: 'Meta-inference for Protected planning time' })

  it('Save meta-inference disables itself and lands on the text box', async () => {
    mount()
    await openConstruct()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Meta-inference for Protected planning time' }),
      { target: { value: 'Planning time is protected where it is named.' } })
    // #1714 (a), D396: the button names its construct.
    const save = screen.getByRole('button', { name: 'Save meta-inference for Protected planning time' })
    expect(save).toBeEnabled()
    press(save)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save meta-inference for Protected planning time' })).toBeDisabled())
    await waitFor(() => expect(document.activeElement).toBe(metaBox()))
  })

  it('Accept the current numbers (a stamp a withdrawal cleared) lands on the text box', async () => {
    mount(display({ baseline: { hash: '', cells: {}, stamped_at: '2026-11-10', scope: 'all', cleared: 'withdrawal' } }))
    await openConstruct()
    // #1714 (a), D396: the button names its construct.
    const accept = await screen.findByRole('button', { name: `${DRIFT_ACCEPT_CURRENT_TEXT} for Protected planning time` })
    // #1700 (c) (D380): the sentence ends at "withdrew." — the button carries the action, once.
    expect(accept.parentElement?.textContent).toMatch(/were cleared when a participant withdrew\. Accept the current numbers$/)
    press(accept)
    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(`^${DRIFT_ACCEPT_CURRENT_TEXT}`) })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(metaBox()))
  })

  it('Accept the new numbers (they moved) lands on the text box', async () => {
    mount(display({ baseline: { hash: 'h', cells: { 'code:31:High': '1 of 11' }, stamped_at: '2026-11-10', scope: 'all' } }))
    await openConstruct()
    press(await screen.findByRole('button', { name: 'Accept the new numbers for Protected planning time' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Accept the new numbers/ })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(metaBox()))
    expect(document.activeElement).not.toBe(document.body)
  })
})

/**
 * #1714 (a)/(b), D396–D397 — the open construct's controls each say WHICH construct or quote.
 * With *Open all* on two constructs, or two pins in a group, a bare *Save meta-inference* or
 * *Unpin this quote* repeated with nothing to tell the copies apart. The sweep saw three; the
 * review counted six per-construct and three per-pin, so this is a POPULATION check over every
 * named control in the detail box, not a list of the ones found.
 */
describe('#1714 — the open construct names its construct and its quotes', () => {
  const LONG = 'My supervisor made time for the course and asked what I learned, every single week of the term.'
  const withPins = () => display({ pins: [
    { ...pin('We get an hour.'), role: 'discrepant' },
    pin(LONG),
  ] })

  it('every named control names the construct or a quote (the population)', async () => {
    mount(withPins())
    await openConstruct()
    const box = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-construct-detail-box]')
      if (!el) throw new Error('no detail box yet')
      return el
    })
    const roles = ['button', 'combobox', 'textbox', 'checkbox', 'group'] as const
    const named = roles.flatMap(role => within(box).queryAllByRole(role).map(el => ({ role, el })))
    expect(named.length).toBeGreaterThanOrEqual(12)   // the population floor: an empty census passes nothing
    const nameless = named.filter(({ el }) => {
      const label = el.getAttribute('aria-label') ?? el.querySelector('legend')?.textContent ?? el.textContent ?? ''
      return !/Protected planning time|“/.test(label)
    }).map(({ role, el }) => `${role}: ${el.getAttribute('aria-label') ?? el.textContent}`)
    expect(nameless).toEqual([])
  })

  it('names each one exactly: the visible words first, then the construct or the quote', async () => {
    mount(withPins())
    await openConstruct()
    expect(await screen.findByRole('button', { name: 'Save meta-inference for Protected planning time' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compare another pair for Protected planning time' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Type (optional) — meta-inference for Protected planning time' })).toBeInTheDocument()
    // The visible legend is unchanged: the construct is for the name only.
    expect(screen.getByText('meta-inference for Protected planning time', { exact: false })).toHaveClass('sr-only')
    expect(screen.getByRole('combobox', { name: 'Role of “We get an hour.”' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Why “We get an hour.” is here' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unpin “We get an hour.”' })).toBeInTheDocument()
    // D398: a long quote is named by its head and tail, cut at words, by code points.
    expect(screen.getByRole('button', { name: 'Unpin “My supervisor made time for…single week of the term.”' }))
      .toBeInTheDocument()
  })

  it('a pin with no words reads "this quote" (never an empty pair of quotation marks)', async () => {
    mount(display({ pins: [pin('')] }))
    await openConstruct()
    expect(await screen.findByRole('button', { name: 'Unpin this quote' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Role of this quote' })).toBeInTheDocument()
  })
})
