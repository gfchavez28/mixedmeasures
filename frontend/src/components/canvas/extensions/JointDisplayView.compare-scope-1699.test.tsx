/**
 * #1699 (D379) — Canvas Compare mounts a snapshot's copy and the live copy of ONE display under
 * one `displayKey` (a snapshot keeps its key by design, D348). They shared the view switch's
 * native radio group (named by the key) and the kept state (keyed by it): pressing Compact on
 * the snapshot switched both figures and left the snapshot's group with no checked radio.
 *
 * Each mount now names its radio group itself (`useId`), and Compare's two editors scope the
 * kept state by side (`JointDisplay.configure({ stateScope })`). Mocks as
 * `JointDisplayView-focus-1660.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
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

const PAYLOAD = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 1, with_material: 1, without_coding: 0 },
    { key: 'Low', participants: 1, with_material: 1, without_coding: 0 }],
  unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
  rating: null, strands: [], rows: [],
}
const DISPLAY = { title: 'Teachers', group_by_column_id: 11, rows: [] }

let k = 0
/** Two node views of ONE display (one key), as Compare's two panes mount them. */
function mountBothSides(scopes: [string, string]) {
  const key = `compare-${++k}`
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (scope: string) => {
    const props = {
      node: { attrs: { displayKey: key, figureEpoch: 3, display: DISPLAY } },
      updateAttributes: vi.fn(), deleteNode: vi.fn(), selected: false,
      editor: { isEditable: false }, extension: { options: { stateScope: scope } },
    } as unknown as NodeViewProps
    return <section aria-label={`side ${scope || 'canvas'}`}><JointDisplayView {...props} /></section>
  }
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={vi.fn()}>
          {view(scopes[0])}
          {view(scopes[1])}
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const side = (scope: string) => screen.getByRole('region', { name: `side ${scope || 'canvas'}` })
const radio = (scope: string, name: 'Compact' | 'Report') =>
  within(side(scope)).getByRole('radio', { name }) as HTMLInputElement

beforeEach(() => {
  api.compute.mockResolvedValue(PAYLOAD)
  api.pinFacts.mockResolvedValue({ pins: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

/** Two DIFFERENT displays (two requests), each its own key, as a canvas holds them. */
function mountDisplays(groupings: number[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={vi.fn()}>
          {groupings.map(g => {
            const props = {
              node: { attrs: { displayKey: `queue-${g}-${++k}`, figureEpoch: 3, display: { ...DISPLAY, group_by_column_id: g } } },
              updateAttributes: vi.fn(), deleteNode: vi.fn(), selected: false,
              editor: { isEditable: false }, extension: { options: { stateScope: '' } },
            } as unknown as NodeViewProps
            return <section key={g} aria-label={`display ${g}`}><JointDisplayView {...props} /></section>
          })}
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/**
 * #1705 (b) (D387) — the server computes one display at a time (D368), and every waiting display
 * said "Computing the joint display…" like the one running. While others are in flight in this
 * window, each says it may be waiting.
 */
describe('#1705 (b) (D387) — a display queued behind others says it may be waiting', () => {
  it('three computing at once: each may wait for 2 others', async () => {
    api.compute.mockReturnValue(new Promise(() => {}))   // never answers: all three stay in flight
    mountDisplays([11, 12, 13])
    for (const g of [11, 12, 13]) {
      const region = screen.getByRole('region', { name: `display ${g}` })
      expect(await within(region).findByText(
        'Computing the joint display… Displays compute one at a time, so this may wait for 2 others.')).toBeInTheDocument()
    }
  })

  it('CONTROL: one display alone keeps the plain words', async () => {
    api.compute.mockReturnValue(new Promise(() => {}))
    mountDisplays([11])
    expect(await screen.findByText('Computing the joint display…')).toBeInTheDocument()
    expect(screen.queryByText(/compute one at a time/)).toBeNull()
  })
})

describe('#1699 (D379) — Compare’s two copies of one display', () => {
  it('each side has its own view switch: choosing Report on one leaves the other Compact and checked', async () => {
    mountBothSides(['compare-left', 'compare-right'])
    await within(side('compare-left')).findByRole('radio', { name: 'Compact' })
    expect(radio('compare-left', 'Compact').name).not.toBe(radio('compare-right', 'Compact').name)

    fireEvent.click(radio('compare-left', 'Report'))
    expect(radio('compare-left', 'Report')).toBeChecked()
    expect(radio('compare-right', 'Compact')).toBeChecked()   // untouched, and still checked
    expect(radio('compare-right', 'Report')).not.toBeChecked()
  })

  it('a scoped view does not write the stored view preference', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    mountBothSides(['compare-left', 'compare-right'])
    await within(side('compare-left')).findByRole('radio', { name: 'Report' })
    fireEvent.click(radio('compare-left', 'Report'))
    expect(setItem.mock.calls.filter(([key]) => String(key).startsWith('mm-joint-display-view:'))).toEqual([])
    setItem.mockRestore()
  })
})
