/**
 * #963 Tier 3 — the pickers and panels that answered a failed request with a
 * claim about the researcher's project.
 *
 * 🔴 **`ColumnPicker` was MEASURED in Chrome on 2026-09-18**, on a project with
 * four datasets and 100 columns, with `/metrics/analysis-columns` failing:
 *
 *   t = 2 s   "Variables — Loading variables..."
 *   t = 9 s   "Variables / Groups / **No variables found**"
 *
 * — permanently, with nothing naming a failure and no way back but a reload.
 * The same drive showed the client asking TWICE for one settled 500, which is
 * why that query now carries `retryUnanswered`.
 *
 * The other three are the same mechanism on smaller surfaces: a failed search
 * reading as "your project does not contain this", a failed cross-tab telling
 * the researcher to select the variable they have just selected, and a failed
 * participant list telling them to go and create participants they already
 * have.
 *
 * First suite for `ColumnPicker`, `CrossTabTable` and `SearchPopover`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

const api = vi.hoisted(() => ({
  analysisColumns: vi.fn(),
  search: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    metricsApi: { ...actual.metricsApi, analysisColumns: api.analysisColumns },
    searchApi: { ...actual.searchApi, search: api.search, searchFullType: api.search },
  }
})
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Ada' }, refreshAuth: vi.fn() }),
}))

import { ColumnPicker } from './ColumnPicker'
import CrossTabTable from './CrossTabTable'
import SearchPopover from './SearchPopover'

/** An ANSWERED refusal — duck-typed on `status`, like the real predicates. */
const answered500 = () => Object.assign(new Error('boom'), { status: 500 })

function wrap(ui: React.ReactElement, clientRetry: boolean | number = false) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: clientRetry, retryDelay: 0 } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const EMPTY_COLUMNS = { datasets: [], domains: [] }

function renderPicker(clientRetry: boolean | number = false) {
  return wrap(
    <ColumnPicker
      projectId={1}
      mode="columns"
      onModeChange={() => {}}
      selectedColumnIds={new Set<number>()}
      onToggleColumn={() => {}}
      selectedDomainIds={new Set<number>()}
      onToggleDomain={() => {}}
      onSelectAllDataset={() => {}}
      expandedDatasetId={null}
      onToggleDataset={() => {}}
      domainsFull={[]}
      metrics={[]}
    />,
    clientRetry,
  )
}

afterEach(cleanup)
beforeEach(() => {
  api.analysisColumns.mockReset()
  api.search.mockReset()
  api.analysisColumns.mockResolvedValue(EMPTY_COLUMNS)
  api.search.mockResolvedValue({})
})

describe('#963 Tier 3 — ColumnPicker: "No variables found" was said of a failed request', () => {
  it('READY and genuinely empty: the claim is true, and is made (positive control)', async () => {
    renderPicker()
    expect(await screen.findByText('No variables found')).toBeInTheDocument()
  })

  it('LOADING: says so, and claims nothing about the project', async () => {
    api.analysisColumns.mockReturnValue(new Promise(() => {}))
    renderPicker()
    expect(await screen.findByText('Loading variables…')).toBeInTheDocument()
    expect(screen.queryByText('No variables found')).toBeNull()
    expect(screen.queryByText('No groups defined')).toBeNull()
  })

  it('FAILED: says the LOAD failed, with a Retry — measured as permanent before this', async () => {
    api.analysisColumns.mockRejectedValue(answered500())
    renderPicker()
    expect(await screen.findByText('Your variables could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText('No variables found')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does NOT re-ask on its own when the server ANSWERED — measured asking twice', async () => {
    // Under the app's own client default (`retry: 1`), so the query's
    // `retryUnanswered` is what decides.
    api.analysisColumns.mockRejectedValue(answered500())
    renderPicker(1)
    await screen.findByText('Your variables could not be loaded.')
    await new Promise(r => setTimeout(r, 30))
    expect(api.analysisColumns).toHaveBeenCalledTimes(1)
  })

  it('DOES re-ask once when nothing answered at all', async () => {
    api.analysisColumns.mockRejectedValue(new Error('network down'))
    renderPicker(1)
    await screen.findByText('Your variables could not be loaded.')
    expect(api.analysisColumns).toHaveBeenCalledTimes(2)
  })
})

describe('#963 Tier 3 — CrossTabTable: one nullable prop stood for three facts', () => {
  const MATRIX = {
    response_values: ['Yes', 'No'],
    matrix: [{ code_id: 1, code_name: 'Pacing', counts: { Yes: 2, No: 1 }, percentages: { Yes: 66, No: 33 }, total: 3 }],
    column_totals: { Yes: 2, No: 1 },
    total_coded_texts: 3,
    cross_column_name: 'Site',
  } as never

  it('draws an ANSWERED matrix', () => {
    render(<CrossTabTable data={MATRIX} />)
    expect(screen.getByText('Pacing')).toBeInTheDocument()
  })

  it('an ANSWERED EMPTY matrix says the cross-tabulation found nothing', () => {
    render(<CrossTabTable data={{ ...(MATRIX as object), matrix: [] } as never} />)
    expect(screen.getByText('No coded comments found for this cross-tabulation.')).toBeInTheDocument()
  })

  it('no longer has a branch that tells the researcher to select what they selected', () => {
    // The prop is REQUIRED now, so the compiler enforces that the two non-ready
    // states are the parent's. The sentence it used to render on a FAILURE —
    // "Select a cross-tab variable to see the matrix." — was also DEAD CODE at
    // the one call site, which has always wrapped this in `{crossColumnId && …}`.
    const src = readFileSync(join(SRC_DIR, 'components/CrossTabTable.tsx'), 'utf8')
    const code = stripComments(src, 'CrossTabTable.tsx')
    expect(code).toContain('export default function CrossTabTable')   // self-check
    expect(code).not.toContain('Select a cross-tab variable')
    expect(code).not.toContain('loading')
    // The PARENT owns both states now, and answers the disabled case first.
    const panel = stripComments(
      readFileSync(join(SRC_DIR, 'components/CrossAnalysisPanel.tsx'), 'utf8'),
      'CrossAnalysisPanel.tsx',
    )
    expect(panel).toContain('const crossTabLoad = useListLoad(crossTabQuery)')
    expect(panel).toMatch(/crossColumnId && \(\s*crossTabLoad\.status !== 'ready'/)
  })
})

describe('#963 Tier 3 — SearchPopover: a failed search is not an empty project', () => {
  const renderSearch = () => wrap(<SearchPopover projectId={1} open onClose={() => {}} />)

  /** Types a term and lets the 300 ms debounce elapse — the query is gated on
   *  two characters, which is also this surface's disabled-query answer. */
  function fireTerm(term: string) {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: term } })
  }

  it('READY with no matches: "No results" is true, and is said (positive control)', async () => {
    api.search.mockResolvedValue({})
    renderSearch()
    fireTerm('pacing')
    expect(await screen.findByText(/No results for/)).toBeInTheDocument()
  })

  it('LOADING: says it is searching', async () => {
    api.search.mockReturnValue(new Promise(() => {}))
    renderSearch()
    fireTerm('pacing')
    expect(await screen.findByText('Searching…')).toBeInTheDocument()
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('FAILED: says the SEARCH failed, never that the project has nothing', async () => {
    api.search.mockRejectedValue(answered500())
    renderSearch()
    fireTerm('pacing')
    expect(await screen.findByText('The search could not be run.')).toBeInTheDocument()
    expect(screen.queryByText(/No results for/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
