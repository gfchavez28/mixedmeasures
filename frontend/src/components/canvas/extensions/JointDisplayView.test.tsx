/**
 * The joint display's Compact view, mounted (session B): what it draws, what it sends, and what
 * a read-only surface withholds (#893). The server's payload shape is `schemas/joint_display.py`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import '@testing-library/jest-dom/vitest'
import type { NodeViewProps } from '@tiptap/core'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 1 } }) }))
const blindState = { blind: false, withholding: false, settled: true }
vi.mock('@/hooks/useBlindMode', () => ({ useBlindMode: () => blindState }))
const NO_MACHINES = new Set<number>()
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ coderMap: new Map([[1, { id: 1, username: 'Me' }], [2, { id: 2, username: 'Colleague' }]]) }),
  useMachineCoderIds: () => NO_MACHINES,
}))
vi.mock('@/hooks/useListLoad', () => ({ useListLoad: () => ({ status: 'loading', error: null, retry: () => {}, retrying: false }) }))

const api = vi.hoisted(() => ({
  compute: vi.fn(),
  pinFacts: vi.fn(),
  passages: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  jointDisplayApi: api,
  excerptsApi: { wholePassage: vi.fn() },
  codesApi: { list: vi.fn() }, conversationsApi: { list: vi.fn() }, documentsApi: { list: vi.fn() },
  metricsApi: { analysisColumns: vi.fn(), quickCompute: vi.fn(), crossTabulation: vi.fn() },
  materialsApi: { listAllMaterials: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
}))

import JointDisplayView from './JointDisplayView'
import { DialogsContext, commitDisplay } from '../joint-display/display-store'

/** Each mount its own display key: the kept store (open rows, drafts) is per key, page-long. */
let mountCount = 0

function payload(low = 0) {
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11 }, { key: 'Low', participants: 11 }],
    unavailable_reason: null,
    scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 2 },
    rating: null,
    rows: [{
      key: 'r1',
      codes: [{
        code_id: 31, name: 'Planning time', unit: 'participants', rated: false, formed_groups: null,
        cells: [
          { group: 'High', count: 7, n: 11, share: 7 / 11, share_undefined_reason: null, passages: 12, rating: null },
          { group: 'Low', count: low, n: 11, share: low / 11, share_undefined_reason: null, passages: 3, rating: null },
        ],
        difference: { value: (7 - low) / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
      }],
      variables: [],
      missing_code_ids: [], missing_column_ids: [],
      strands: { codes: 'covers', variables: 'not_measured' },
    }],
  }
}

const DISPLAY = {
  title: 'Teachers by gain group',
  group_by_column_id: 11,
  conversation_ids: null,
  document_ids: null,
  rows: [{
    key: 'r1', construct: 'Protected planning time', code_ids: [31], column_ids: [],
    pins: [{ excerptId: 41, displayText: 'We plan on Fridays.', sourceContext: 'Focus group',
      conversationId: 21, observationId: null, group: 'High', role: 'typical', purpose: '' }],
  }],
}

function mount(opts: { editable?: boolean; display?: unknown; host?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const updateAttributes = vi.fn()
  const openDialog = vi.fn()
  const displayKey = `k-${++mountCount}`
  const props = {
    node: { attrs: { displayKey, figureEpoch: 3, display: opts.display ?? DISPLAY } },
    updateAttributes,
    deleteNode: vi.fn(),
    selected: false,
    editor: { isEditable: opts.editable ?? true },
  } as unknown as NodeViewProps
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={opts.host === false ? null : openDialog}>
          <JointDisplayView {...props} />
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { updateAttributes, openDialog, displayKey }
}

const openConstruct = () => fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
const lastDisplay = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0].display

beforeEach(() => {
  Object.assign(blindState, { blind: false, withholding: false, settled: true })
  api.compute.mockResolvedValue(payload())
  api.pinFacts.mockResolvedValue({ pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04',
    speaker_label: 'Robert', source_name: 'Focus group', column_value: null }] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the Compact view draws the live numbers', () => {
  it('a real table: groups with their sizes, the construct, its measures and "not measured"', async () => {
    mount()
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('columnheader', { name: /High · 11/ })).toBeInTheDocument()
    expect(within(table).getByRole('rowheader', { name: /Protected planning time/ })).toBeInTheDocument()
    expect(within(table).getByText('7 of 11')).toBeInTheDocument()
    // #1659: this slice-1 wire carries no reason, so no cause is claimed (the server's reason is
    // `JointDisplayView.not-measured-1659.test.tsx`'s)
    const none = within(table).getByText(/Not measured/)
    expect(none).toHaveTextContent(/Not measured$/)
    expect(none).not.toHaveTextContent(/bound/)
    expect(screen.getByText(/2 participants have no Gain group/)).toBeInTheDocument()
  })

  it('asks for every coder when not blind — and for the viewer alone while withholding, waiting to settle (D175)', async () => {
    mount()
    await waitFor(() => expect(api.compute).toHaveBeenCalled())
    expect(api.compute.mock.calls[0][1]).toMatchObject({ group_by_column_id: 11, coder_ids: null, layer_scope: 'human' })
    cleanup(); vi.clearAllMocks(); api.compute.mockResolvedValue(payload())
    Object.assign(blindState, { blind: true, withholding: true, settled: true })
    mount()
    await waitFor(() => expect(api.compute).toHaveBeenCalled())
    expect(api.compute.mock.calls[0][1].coder_ids).toEqual([1])
    expect(screen.getByText(/Blind mode: coding counts are yours only/)).toBeInTheDocument()
    cleanup(); vi.clearAllMocks()
    Object.assign(blindState, { blind: false, withholding: true, settled: false })
    mount()
    expect(screen.getByText(/Computing the joint display/)).toBeInTheDocument()
    expect(api.compute).not.toHaveBeenCalled()
  })

  it('says what is missing rather than drawing nothing', async () => {
    mount({ display: { rows: [{ key: 'a', construct: 'X' }] } })
    // #1639 (r1-5): a stored display never lacks a grouping variable by choice (the builder needs one).
    expect(screen.getByText(/The variable that formed this display’s groups is not in this project/)).toBeInTheDocument()
    cleanup()
    api.compute.mockRejectedValueOnce(new Error('boom'))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be computed/)
  })
})

describe('#1639 — what the display says when a bound thing is gone or inactive', () => {
  const refusal = (detail: unknown) =>
    Object.assign(new Error('404'), { status: 404, response: { status: 404, data: { detail } } })

  it('r1-5: the grouping variable gone (the compute\'s GROUPING_GONE 404) is said in the display\'s words', async () => {
    api.compute.mockRejectedValueOnce(refusal({ code: 'grouping_gone', message: 'That variable is not in this project.' }))
    mount()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The variable that formed this display’s groups is not in this project: it was deleted, or not brought in by an import. Edit the display to choose another.')
    expect(alert).not.toHaveTextContent(/could not be computed/)
  })

  it('control: any other refusal is still "could not be computed", with the server\'s words', async () => {
    api.compute.mockRejectedValueOnce(refusal('That variable cannot form groups.'))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The joint display could not be computed. That variable cannot form groups.')
  })

  it('r1-8: a bound code made inactive is named under its construct, with where a merge moved it', async () => {
    const p = payload()
    api.compute.mockResolvedValue({ ...p, rows: [{ ...p.rows[0], inactive_codes: [
      { strand_key: 'codes', code_id: 32, name: 'Trust', merged_into_id: 31, merged_into_name: 'Planning time' }] }] })
    mount()
    const table = await screen.findByRole('table')
    expect(within(table).getByText(
      '“Trust” was merged into “Planning time”, so it has no coding of its own to show here. Edit the row to bind “Planning time”.',
    )).toBeInTheDocument()
    cleanup()
    api.compute.mockResolvedValue(payload())
    mount()  // control: with none inactive, nothing is said
    expect(within(await screen.findByRole('table')).queryByText(/was merged into|inactive in the codebook/)).toBeNull()
  })
})

describe('#893 — a read-only surface offers no mutation control', () => {
  it('editable: Edit and Remove; read-only: neither, and an open construct holds no input', async () => {
    mount({ editable: true })
    await screen.findByRole('table')
    expect(screen.getByLabelText('Edit joint display')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove from canvas')).toBeInTheDocument()
    cleanup()
    mount({ editable: false })
    await screen.findByRole('table')
    expect(screen.queryByLabelText('Edit joint display')).toBeNull()
    expect(screen.queryByLabelText('Remove from canvas')).toBeNull()
    openConstruct()
    expect(screen.queryByRole('textbox')).toBeNull()
    // The only radios are the View switch's — a VIEW choice, written nowhere (D176.3), so it is
    // offered read-only too; the construct's fit, status and type radios are not.
    const viewSwitch = screen.getByRole('group', { name: 'View' })
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getAllByRole('radio').every(r => viewSwitch.contains(r))).toBe(true)
    expect(screen.queryByRole('button', { name: /Pin a quote/ })).toBeNull()
    expect(screen.queryByLabelText('Unpin this quote')).toBeNull()
  })
})

describe('the dialogs live outside the node view, which ProseMirror re-creates (display-store.ts)', () => {
  it('Edit and Pin ask the page’s host; with no host neither is offered', async () => {
    const { openDialog, displayKey } = mount()
    await screen.findByRole('table')
    fireEvent.click(screen.getByLabelText('Edit joint display'))
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ kind: 'edit', displayKey }))
    openConstruct()
    fireEvent.click(screen.getByRole('button', { name: 'Pin a quote for High, Protected planning time' }))
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'pin', displayKey, rowKey: 'r1', group: 'High', codes: [{ id: 31, name: 'Planning time' }], pinnedExcerptIds: [41],
    }))
    cleanup()
    mount({ host: false })
    await screen.findByRole('table')
    expect(screen.queryByLabelText('Edit joint display')).toBeNull()
    openConstruct()
    expect(screen.queryByRole('button', { name: /Pin a quote/ })).toBeNull()
  })

  it('a hosted dialog writes back through the LIVE view, to the display as it is now', async () => {
    const { updateAttributes, displayKey } = mount()
    await screen.findByRole('table')
    expect(commitDisplay(displayKey, d => ({ ...d, title: 'Renamed' }))).toBe(true)
    const written = lastDisplay(updateAttributes)
    expect(written.title).toBe('Renamed')
    expect(written.rows[0].pins).toHaveLength(1)   // the rest of the display is the current one
    cleanup()
    expect(commitDisplay(displayKey, d => d)).toBe(false)   // an unmounted view no longer applies
    const readOnly = mount({ editable: false })
    await screen.findByRole('table')
    expect(commitDisplay(readOnly.displayKey, d => d)).toBe(false)   // a read-only view never registers
  })

  it('an open construct stays open when the view is re-created (the kept store)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const props = {
      node: { attrs: { displayKey: 'kept-1', figureEpoch: 3, display: DISPLAY } },
      updateAttributes: vi.fn(), deleteNode: vi.fn(), selected: false, editor: { isEditable: true },
    } as unknown as NodeViewProps
    const tree = (k: number) => (
      <MemoryRouter><QueryClientProvider client={qc}><JointDisplayView key={k} {...props} /></QueryClientProvider></MemoryRouter>
    )
    const { rerender } = render(tree(1))
    await screen.findByRole('table')
    openConstruct()
    fireEvent.change(screen.getByLabelText('Meta-inference for Protected planning time'), { target: { value: 'Half written' } })
    rerender(tree(2))   // a new key: React mounts a new instance, as a re-created node view does
    expect(screen.getByRole('button', { name: /Protected planning time/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Meta-inference for Protected planning time')).toHaveValue('Half written')
  })
})

describe('an open construct is where the researcher writes', () => {
  it('the fit is chosen from the vocabulary and saved on the node (one transaction)', async () => {
    const { updateAttributes } = mount()
    await screen.findByRole('table')
    openConstruct()
    fireEvent.click(screen.getByRole('radio', { name: /Confirmation/ }))
    // Joint display slice 2 (r1-8): a fit is stored WITH its pair — slice 1's implicit one here.
    expect(lastDisplay(updateAttributes).rows[0].fits).toEqual([{ strands: ['codes', 'variables'], fit: 'confirmation' }])
  })

  it('saving a meta-inference records the author and date and stamps the row’s numbers (D170, D168.5)', async () => {
    const { updateAttributes } = mount()
    await screen.findByRole('table')
    openConstruct()
    fireEvent.change(screen.getByLabelText('Meta-inference for Protected planning time'), { target: { value: 'Only high gain plan.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save meta-inference' }))
    const row = lastDisplay(updateAttributes).rows[0]
    expect(row.meta_inference).toMatchObject({ text: 'Only high gain plan.', author_id: 1 })
    expect(row.meta_inference.written_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(row.baseline.cells['code:31:Low']).toBe('0 of 11')
  })

  it('a moved number is marked on the closed construct and named in the open one', async () => {
    const display = structuredClone(DISPLAY) as typeof DISPLAY & { rows: Record<string, unknown>[] }
    display.rows[0].baseline = { hash: 'old', cells: { 'code:31:High': '7 of 11', 'code:31:Low': '0 of 11', 'code:31:difference': '+64 pp' }, stamped_at: '2026-11-06' }
    api.compute.mockResolvedValue(payload(1))
    const { updateAttributes } = mount({ display })
    expect(await screen.findByText('numbers moved')).toBeInTheDocument()
    openConstruct()
    expect(screen.getByText(/Planning time, Low: 0 of 11 → 1 of 11/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Accept the new numbers' }))
    expect(lastDisplay(updateAttributes).rows[0].baseline.cells['code:31:Low']).toBe('1 of 11')
  })

  it('a colleague’s meta-inference is named — and reads "A colleague" while withholding (D170, #964)', async () => {
    const display = structuredClone(DISPLAY) as typeof DISPLAY & { rows: Record<string, unknown>[] }
    display.rows[0].meta_inference = { text: 'Rival explanation.', author_id: 2, written_at: '2026-11-05', level: null, type: null }
    mount({ display })
    await screen.findByRole('table')
    openConstruct()
    expect(screen.getByText(/^Colleague · /)).toBeInTheDocument()
    cleanup()
    Object.assign(blindState, { blind: true, withholding: true, settled: true })
    mount({ display })
    await screen.findByRole('table')
    openConstruct()
    expect(screen.getByText(/^A colleague · /)).toBeInTheDocument()
    expect(screen.queryByText(/Colleague ·/)).toBeNull()
  })

  it('a pin’s attribution is derived from the live quote, by the display’s setting (D163.4)', async () => {
    mount()
    await screen.findByRole('table')
    openConstruct()
    expect(await screen.findByText('T-04 · Focus group')).toBeInTheDocument()
    // #1615: the display's blind scope rides the request (null = every coder, not blind).
    expect(api.pinFacts).toHaveBeenCalledWith(1, { excerpt_ids: [41], column_id: null, coder_ids: null })
    expect(screen.queryByText(/Robert/)).toBeNull()
  })

  it('an unanswered facts read never says the quote is gone — and a failed one says it could not be read', async () => {
    let answer: (v: unknown) => void = () => {}
    api.pinFacts.mockReturnValueOnce(new Promise(r => { answer = r }))
    mount()
    await screen.findByRole('table')
    openConstruct()
    expect(screen.getByText('“We plan on Fridays.”')).toBeInTheDocument()
    expect(screen.queryByText(/no longer in the project/)).toBeNull()
    answer({ pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'Focus group', column_value: null }] })
    expect(await screen.findByText('T-04 · Focus group')).toBeInTheDocument()
    cleanup()
    api.pinFacts.mockRejectedValueOnce(new Error('down'))
    mount()
    await screen.findByRole('table')
    openConstruct()
    expect(await screen.findByText('Its attribution could not be read.')).toBeInTheDocument()
    expect(screen.queryByText(/no longer in the project/)).toBeNull()
  })

  it('D214: a kind of insight is offered under either level, and kept with a global one', async () => {
    const { updateAttributes } = mount()
    await screen.findByRole('table')
    openConstruct()
    fireEvent.change(screen.getByLabelText('Meta-inference for Protected planning time'), { target: { value: 'Beyond these schools.' } })
    expect(screen.queryByLabelText('Kind of insight for Protected planning time')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Global' }))
    fireEvent.change(screen.getByLabelText('Kind of insight for Protected planning time'), { target: { value: 'causal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save meta-inference' }))
    expect(lastDisplay(updateAttributes).rows[0].meta_inference).toMatchObject({ level: 'global', type: 'causal' })
  })
})

describe('the Report view (D176): the export’s own table, read only, per viewer', () => {
  const report = () => screen.getByRole('radio', { name: 'Report' })

  it('a radio group named View switches without writing the node, and is remembered by displayKey', async () => {
    const { updateAttributes, displayKey } = mount()
    await screen.findByRole('table')
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked()
    fireEvent.click(report())
    expect(report()).toBeChecked()
    expect(updateAttributes).not.toHaveBeenCalled()
    expect(localStorage.getItem(`mm-joint-display-view:${displayKey}`)).toBe('report')
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }))
    expect(localStorage.getItem(`mm-joint-display-view:${displayKey}`)).toBeNull()
  })

  it('renders the report table — caption, column and row headers, the cells as the export prints them, the note', async () => {
    mount()
    await screen.findByRole('table')
    fireEvent.click(report())
    const table = await screen.findByRole('table', { name: /Side-by-side joint display by construct: Teachers by gain group/ })
    expect(within(table).getByRole('columnheader', { name: 'High (11 participants)' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'High − Low' })).toBeInTheDocument()
    const row = within(table).getByRole('rowheader', { name: /Protected planning time/ })
    expect(row).toBeInTheDocument()
    expect(within(table).getByText(/Coded: Planning time 7 of 11\. “We plan on Fridays\.” \(T-04 · Focus group, typical\)/)).toBeInTheDocument()
    expect(within(table).getByText('Planning time: +64 pp.')).toBeInTheDocument()
    expect(screen.getByText(/Groups: the participants with each value of Gain group \(Roster\)/)).toBeInTheDocument()
    // Read only: the construct links are its only controls (D176's build note).
    expect(within(table).queryAllByRole('textbox')).toHaveLength(0)
    expect(within(table).getAllByRole('button').map(b => b.getAttribute('aria-label')))
      .toEqual(['Edit “Protected planning time” in Compact view'])
  })

  it('a construct link goes back to Compact with that construct open (D176.6); read-only it says Open', async () => {
    mount()
    await screen.findByRole('table')
    fireEvent.click(report())
    fireEvent.click(await screen.findByRole('button', { name: 'Edit “Protected planning time” in Compact view' }))
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked()
    expect(screen.getByRole('button', { name: /Protected planning time/, expanded: true })).toBeInTheDocument()
    cleanup()
    mount({ editable: false })
    await screen.findByRole('table')
    fireEvent.click(report())
    expect(await screen.findByRole('button', { name: 'Open “Protected planning time” in Compact view' })).toBeInTheDocument()
  })

  it('waits for the pins’ facts before printing an attribution, rather than printing a wrong one', async () => {
    let answer: (v: unknown) => void = () => {}
    api.pinFacts.mockReturnValueOnce(new Promise(r => { answer = r }))
    mount()
    await screen.findByRole('table')
    fireEvent.click(report())
    expect(screen.getByText('Preparing the report…')).toBeInTheDocument()
    answer({ pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'Focus group', column_value: null }] })
    expect(await screen.findByText(/\(T-04 · Focus group, typical\)/)).toBeInTheDocument()
  })
})

describe('#1615 D286 — a withheld attribution column is SAID, by name, in both views', () => {
  const NOTE = "Score band is left out of the quotes' attribution while blind: it comes from participant scores, which combine every coder's ratings."
  const withheld = () => api.pinFacts.mockResolvedValue({
    pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'Focus group', column_value: null }],
    column_withheld: true, column_name: 'Score band',
  })

  it('the Compact view says it beside its other notes', async () => {
    Object.assign(blindState, { blind: true, withholding: true, settled: true })
    withheld()
    mount()
    expect(await screen.findByTestId('jd-attribution-withheld')).toHaveTextContent(NOTE)
  })

  it('the Report view carries it in the report’s note (the export’s own words)', async () => {
    Object.assign(blindState, { blind: true, withholding: true, settled: true })
    withheld()
    mount()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('radio', { name: 'Report' }))
    expect(await screen.findByText(new RegExp(NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument()
    // One statement on screen: the Compact line is not drawn over the report's note.
    expect(screen.queryByTestId('jd-attribution-withheld')).toBeNull()
  })

  it('POSITIVE CONTROL: nothing withheld, no sentence', async () => {
    mount()
    await screen.findByRole('table')
    expect(screen.queryByTestId('jd-attribution-withheld')).toBeNull()
    expect(screen.queryByText(/left out of the quotes/)).toBeNull()
  })
})
