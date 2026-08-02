/**
 * OverviewPage (#627) — the project's inventory surface.
 *
 * The load-bearing pin is `isEmpty`: an observation-only project is NOT empty,
 * and treating it as empty told the researcher to "import something to begin"
 * while ALSO hiding the stats bar and the secondary links, which are gated on
 * the same flag. The backend has shipped `observations` + `recent_observations`
 * since slab 1b; this page was the last consumer missing them, which is why the
 * defect was invisible to every green suite (the #624/#626 class).
 *
 * The other tests cover the Observations card itself and the source ORDER,
 * which must be identical across the cards, the stats bar and the empty state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { ProjectSummary } from '@/lib/api'

const summary = vi.fn()
const storage = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      summary: (...a: unknown[]) => summary(...a),
      storage: (...a: unknown[]) => storage(...a),
    },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({
    project: { id: 1, name: 'Playground Interaction Study', description: null },
    projectId: 1,
  }),
}))

import OverviewPage from './OverviewPage'

const EMPTY: ProjectSummary = {
  conversations: 0, datasets: 0, documents: 0, observations: 0,
  participants: 0, codes: 0, categories: 0, coded_segments: 0,
  document_segments: 0, observation_clips: 0, materials: 0,
  statistical_tests: 0, memos: 0, total_records: 0, total_variables: 0,
  open_ended_columns: 0, notes_count: 0, canvas_count: 0,
  recent_conversations: [], recent_datasets: [], recent_documents: [],
  recent_observations: [],
}

/** A project whose ONLY source is an Observation — the state the bug lived in. */
const OBSERVATION_ONLY: ProjectSummary = {
  ...EMPTY,
  observations: 4,
  observation_clips: 31,
  coded_segments: 118,
  participants: 12,
  recent_observations: [
    { id: 7, name: 'Site A — Morning Free Play', updated_at: '2026-07-20T10:00:00+00:00', segment_count: 9, coded_segment_count: 9, has_media: true },
    { id: 8, name: 'Site C — Afternoon', updated_at: '2026-07-19T10:00:00+00:00', segment_count: 7, coded_segment_count: 5, has_media: true },
  ],
}

function renderPage(data: ProjectSummary) {
  summary.mockResolvedValue(data)
  storage.mockResolvedValue({ media_bytes: 0, video_bytes: 0, documents_bytes: 0 })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><OverviewPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('OverviewPage — isEmpty (#627)', () => {
  it('does NOT show the empty state for an observation-only project', async () => {
    renderPage(OBSERVATION_ONLY)
    // The card is the proof the page rendered its normal body.
    expect(await screen.findByRole('group', { name: 'Observations' })).toBeInTheDocument()
    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
  })

  it('keeps the stats bar and secondary links, which share the isEmpty gate', async () => {
    renderPage(OBSERVATION_ONLY)
    // Both were suppressed by the bug even though the numbers were correct —
    // the readout that would reassure the user is what disappeared.
    expect(await screen.findByText('Coded Segments')).toBeInTheDocument()
    expect(screen.getByText('118')).toBeInTheDocument()
    expect(screen.getByText(/participants/)).toBeInTheDocument()
  })

  it('still shows the empty state when there is genuinely nothing', async () => {
    renderPage(EMPTY)
    expect(await screen.findByText('Get started')).toBeInTheDocument()
    expect(screen.queryByText('Coded Segments')).not.toBeInTheDocument()
  })
})

describe('OverviewPage — the Observations card (#627)', () => {
  it('summarises observations and clips, and lists the recent ones with coded counts', async () => {
    renderPage(OBSERVATION_ONLY)
    const card = await screen.findByRole('group', { name: 'Observations' })
    expect(within(card).getByText('4 observations · 31 clips')).toBeInTheDocument()
    expect(within(card).getByText('Site A — Morning Free Play')).toBeInTheDocument()
    expect(within(card).getByText('9/9 coded')).toBeInTheDocument()
    expect(within(card).getByText('5/7 coded')).toBeInTheDocument()
  })

  it('shows its own empty note rather than vanishing when there are none', async () => {
    renderPage({ ...EMPTY, conversations: 1 })  // not empty overall, no observations
    const card = await screen.findByRole('group', { name: 'Observations' })
    expect(within(card).getByText('No observations yet')).toBeInTheDocument()
  })
})

describe('OverviewPage — one source order everywhere (#627)', () => {
  const EXPECTED = ['Conversations', 'Datasets', 'Documents', 'Observations']

  it('orders the source cards Conversations · Datasets · Documents · Observations', async () => {
    const { container } = renderPage(OBSERVATION_ONLY)
    await screen.findByRole('group', { name: 'Observations' })
    const titles = [...container.querySelectorAll('[role="group"]')]
      .map(el => el.getAttribute('aria-label'))
    // Analysis follows the four sources, in its own full-width row.
    expect(titles).toEqual([...EXPECTED, 'Analysis'])
  })

  it('orders the stats bar the same way', async () => {
    const { container } = renderPage(OBSERVATION_ONLY)
    await screen.findByText('Coded Segments')
    // Scope to the stats grid — the labels collide with the card titles.
    const bar = container.querySelector('.divide-x') as HTMLElement
    expect(bar).toBeTruthy()
    const labels = [...bar.children].map(c => c.querySelector('div:nth-child(2)')?.textContent)
    expect(labels.slice(0, 4)).toEqual(EXPECTED)
  })

  it('orders the empty state buttons the same way', async () => {
    renderPage(EMPTY)
    await screen.findByText('Get started')
    const names = EXPECTED.map(l => screen.getByRole('button', { name: l }))
    for (let i = 1; i < names.length; i++) {
      expect(names[i - 1].compareDocumentPosition(names[i]) & 4).toBeTruthy()
    }
  })
})
