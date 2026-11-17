/**
 * #1653 (D346) — on screen: a gone or retyped *Also show* variable keeps every quote's who and
 * where (it read "Its attribution could not be read." on every pin), the Compact view says why
 * once, and the builder's *Also show* select shows what the display holds (it read "Nothing more"
 * over an id the display still held). The export's half is `canvas-export-attribution-1653.test.ts`.
 * Mocks as `JointDisplayView.test.tsx` and `joint-display-limits-1644.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

const api = vi.hoisted(() => ({ compute: vi.fn(), pinFacts: vi.fn(), passages: vi.fn(), analysisColumns: vi.fn() }))
vi.mock('@/lib/api', () => ({
  jointDisplayApi: api,
  excerptsApi: { wholePassage: vi.fn() },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 1, codes: [{ id: 31, name: 'Planning time', is_active: true, is_universal: false }] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 0, conversations: [] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  metricsApi: { analysisColumns: (...a: unknown[]) => api.analysisColumns(...a), quickCompute: vi.fn(), crossTabulation: vi.fn() },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  comparisonsApi: { groupComparison: vi.fn() },
  textCodingApi: { columns: vi.fn().mockResolvedValue({ columns: [] }) },
  observationsApi: { list: vi.fn().mockResolvedValue([]) },
}))

import JointDisplayView from './JointDisplayView'
import JointDisplayBuilder from '../joint-display/JointDisplayBuilder'
import { DialogsContext } from '../joint-display/display-store'
import { readDisplay } from '@/lib/joint-display'
import {
  ATTRIBUTION_GONE_TEXT, ATTRIBUTION_OPTION_UNOFFERED_TEXT, attributionOptionIneligibleText,
} from '@/lib/joint-display-vocabulary'

let mountCount = 0
const DISPLAY = {
  title: 'Teachers', group_by_column_id: 11, conversation_ids: null, document_ids: null,
  attribution: { label: 'participant', column_id: 51 },
  rows: [{ key: 'r1', construct: 'Protected planning time', code_ids: [31], column_ids: [],
    pins: [{ excerptId: 41, displayText: 'We plan on Fridays.', sourceContext: 'Focus group',
      conversationId: 21, observationId: null, group: 'High', role: 'typical', purpose: '' }] }],
}
const PAYLOAD = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11 }, { key: 'Low', participants: 11 }],
  unavailable_reason: null,
  scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 0 },
  rating: null,
  rows: [{ key: 'r1', codes: [{ code_id: 31, name: 'Planning time', unit: 'participants', rated: false, formed_groups: null,
    cells: [{ group: 'High', count: 7, n: 11, share: 7 / 11, share_undefined_reason: null, passages: 12, rating: null },
      { group: 'Low', count: 2, n: 11, share: 2 / 11, share_undefined_reason: null, passages: 3, rating: null }],
    difference: { value: 5 / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null } }],
  variables: [], missing_code_ids: [], missing_column_ids: [], strands: { codes: 'covers', variables: 'not_measured' } }],
}
const FACT = { excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert',
  source_name: 'Focus group', column_value: null }

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    node: { attrs: { displayKey: `attr-${++mountCount}`, figureEpoch: 3, display: DISPLAY } },
    updateAttributes: vi.fn(), deleteNode: vi.fn(), selected: false, editor: { isEditable: true },
  } as unknown as NodeViewProps
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={vi.fn()}>
          <JointDisplayView {...props} />
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const col = (id: number, name: string, column_type: string) => ({ id, dataset_id: 1, dataset_name: 'Roster', column_code: null,
  column_name: name, column_text: name, column_type, scale_labels: null, equivalence_group_id: null, domain_ids: [] })

function mountBuilder(columns: ReturnType<typeof col>[]) {
  api.analysisColumns.mockResolvedValue({ domains: [], demographics: [], datasets: [{ id: 1, name: 'Roster', columns }] })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={readDisplay(DISPLAY)} mode="edit" onSubmit={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => { api.compute.mockResolvedValue(PAYLOAD) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1653 (D346) — the Compact view', () => {
  it('a gone variable: one note, and the quote still says who and where', async () => {
    api.pinFacts.mockResolvedValue({ pins: [FACT], column_withheld: false, column_name: null, column_unusable: 'gone' })
    mountView()
    expect(await screen.findByTestId('jd-attribution-unusable')).toHaveTextContent(ATTRIBUTION_GONE_TEXT)
    fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
    expect(await screen.findByText('T-04 · Focus group')).toBeInTheDocument()
    expect(screen.queryByText('Its attribution could not be read.')).toBeNull()
  })

  it('control: a variable that was read says nothing', async () => {
    api.pinFacts.mockResolvedValue({ pins: [{ ...FACT, column_value: 'North' }] })
    mountView()
    await screen.findByRole('table')
    expect(screen.queryByTestId('jd-attribution-unusable')).toBeNull()
  })
})

describe('#1653 (D346) — the builder’s Also show shows what the display holds', () => {
  const select = () => screen.findByRole('combobox', { name: 'Also show a participant variable beside each quote' })

  it('a variable the list no longer has is shown as held, never as "Nothing more"', async () => {
    mountBuilder([col(11, 'Gain group', 'nominal')])
    const s = await select() as HTMLSelectElement
    expect(s.value).toBe('51')
    expect(s.selectedOptions[0]).toHaveTextContent(ATTRIBUTION_OPTION_UNOFFERED_TEXT)
    expect(s.selectedOptions[0]).toBeDisabled()
    // Choosing Nothing more replaces it.
    fireEvent.change(s, { target: { value: '' } })
    expect(s.value).toBe('')
  })

  it('a variable retyped so it cannot form groups is shown by name', async () => {
    mountBuilder([col(11, 'Gain group', 'nominal'), col(51, 'School', 'numeric')])
    const s = await select() as HTMLSelectElement
    expect(s.selectedOptions[0]).toHaveTextContent(attributionOptionIneligibleText('School'))
  })

  it('control: an offered variable is just itself', async () => {
    mountBuilder([col(11, 'Gain group', 'nominal'), col(51, 'School', 'nominal')])
    const s = await select() as HTMLSelectElement
    expect(s.selectedOptions[0]).toHaveTextContent('School')
    expect(screen.queryByText(ATTRIBUTION_OPTION_UNOFFERED_TEXT)).toBeNull()
  })
})
