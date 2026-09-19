/**
 * The Reliability tab's scope switch (#624).
 *
 * The defect this guards against is the one that filed it: OpenCutReliability
 * shipped fully built and unit-tested but mounted NOWHERE — a component test
 * rendering it in isolation stayed green while no user could reach it. These
 * tests pin the routing seam (which child renders for which scope); the child
 * components' own behaviour lives in their own suites, so they are stubbed.
 * Radix Select can't be driven in jsdom, hence the controlled View export.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { openObservations, selectableObservations } from '@/lib/reconciliation-source'
import { RELIABILITY_EXPLAINER_OPEN } from '@/lib/source-kind-copy'
import type { ListLoad, ListStatus } from '@/lib/list-status'

const seen = vi.hoisted(() => ({
  panel: [] as Array<{ projectId: number; observationId: number; observationName: string }>,
}))

vi.mock('./IrrMatrix', () => ({
  default: () => <div data-testid="irr-matrix" />,
}))
vi.mock('./OpenCutReliability', () => ({
  default: (props: { projectId: number; observationId: number; observationName: string }) => {
    seen.panel.push(props)
    return <div data-testid="open-cut-panel">{props.observationName}</div>
  },
}))
vi.mock('@/lib/api', () => ({
  observationsApi: {
    list: vi.fn().mockResolvedValue([
      { id: 7, name: 'Playground', segmentation_frozen_at: null },
    ]),
  },
}))

import ReliabilityTab, { ReliabilityTabView } from './ReliabilityTab'

afterEach(() => { cleanup(); seen.panel.length = 0 })

// The Observation wire type has more fields; the view reads only these three.
type ObsLike = { id: number; name: string; segmentation_frozen_at: string | null }
const OPEN: ObsLike = { id: 7, name: 'Playground', segmentation_frozen_at: null }
const FROZEN: ObsLike = { id: 9, name: 'Assembly', segmentation_frozen_at: '2026-07-18T10:00:00+00:00' }
const asObs = (o: ObsLike[]) => o as never[]

/** A `ListLoad` in one of its three states — #963 Tier 3's REQUIRED prop. */
const load = (status: ListStatus, error: unknown = null): ListLoad =>
  ({ status, error, retry: () => {}, retrying: false })

function renderView(over: {
  observations?: ObsLike[]
  observationsLoad?: ListLoad
  selectedId?: number | null
} = {}) {
  return render(
    <ReliabilityTabView
      projectId={1}
      observations={asObs(over.observations ?? [])}
      observationsLoad={over.observationsLoad ?? load('ready')}
      selectedId={over.selectedId ?? null}
      onSelect={() => {}}
    />,
  )
}

describe('the open/frozen observation lenses', () => {
  it('openObservations is the exact complement of selectableObservations', () => {
    const both = [OPEN, FROZEN]
    expect(openObservations(both).map(o => o.id)).toEqual([7])
    expect(selectableObservations(both).map(o => o.id)).toEqual([9])
  })
})

describe('ReliabilityTabView routing', () => {
  it('renders the pooled matrix with no picker when nothing is open-cut', () => {
    renderView({ observations: [FROZEN] })
    expect(screen.getByTestId('irr-matrix')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Reliability scope' })).not.toBeInTheDocument()
  })

  it('offers the picker once an open observation exists, still pooled by default', () => {
    renderView({ observations: [OPEN] })
    expect(screen.getByRole('combobox', { name: 'Reliability scope' })).toBeInTheDocument()
    expect(screen.getByTestId('irr-matrix')).toBeInTheDocument()
    expect(screen.queryByTestId('open-cut-panel')).not.toBeInTheDocument()
  })

  it('routes an open selection to the open-cut panel, with the fork explainer verbatim', () => {
    renderView({ observations: [OPEN, FROZEN], selectedId: 7 })
    expect(screen.getByTestId('open-cut-panel')).toHaveTextContent('Playground')
    expect(seen.panel).toEqual([{ projectId: 1, observationId: 7, observationName: 'Playground' }])
    // Identity with the import fork's copy — the same words on both surfaces.
    expect(screen.getByText(RELIABILITY_EXPLAINER_OPEN)).toBeInTheDocument()
    expect(screen.queryByTestId('irr-matrix')).not.toBeInTheDocument()
  })

  it('falls back to pooled when the selection was frozen out from under it', () => {
    // Revocable eligibility (D18): a picked observation can be frozen (or
    // deleted) by the time the tab re-renders; a stale id must not strand the
    // tab on an empty panel.
    renderView({ observations: [FROZEN], selectedId: 9 })
    expect(screen.getByTestId('irr-matrix')).toBeInTheDocument()
    expect(screen.queryByTestId('open-cut-panel')).not.toBeInTheDocument()
  })

  it('tells the pooled view when frozen observations are inside its numbers', () => {
    renderView({ observations: [FROZEN] })
    expect(screen.getByText(/Frozen observations are included/)).toBeInTheDocument()
  })

  it('omits the frozen note when no observation is frozen', () => {
    renderView({ observations: [OPEN] })
    expect(screen.queryByText(/Frozen observations are included/)).not.toBeInTheDocument()
  })
})

describe('ReliabilityTab (stateful wiring)', () => {
  it('loads the observation list and offers the picker', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ReliabilityTab projectId={1} />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Reliability scope' })).toBeInTheDocument())
    expect(screen.getByTestId('irr-matrix')).toBeInTheDocument()
  })
})

/**
 * #963 Tier 3 — a failed observation list withdraws the capability AND the
 * sentence that announces it.
 *
 * The picker and #859's signpost are the only two things on this tab that say
 * open-cut reliability exists. Both are derived from `observations`, which was
 * read out of a `data: observations = []` destructuring default — so a failed
 * request produced exactly the state #859 was filed to fix, silently and for
 * the life of the page.
 */
describe('#963 Tier 3 — the scope list is a claim about what this tab offers', () => {
  it('READY with an open observation: picker and signpost, no notice (positive control)', () => {
    renderView({ observations: [OPEN] })
    expect(screen.getByRole('combobox', { name: 'Reliability scope' })).toBeInTheDocument()
    expect(screen.getByText(/open cuts, so it is not part of the pooled/)).toBeInTheDocument()
    expect(screen.queryByText(/scope list could not be loaded/)).toBeNull()
  })

  it('LOADING: stays silent — IrrMatrix below already mounts a status line', () => {
    // Tier 2's one-region rule: a second "loading" for a list whose only job is
    // to add a picker is a duplicate on screen and a second announcement. The
    // picker simply appears when the list answers.
    renderView({ observations: [], observationsLoad: load('loading') })
    expect(screen.queryByText(/scope list could not be loaded/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByTestId('irr-matrix')).toBeInTheDocument()
  })

  it('FAILED: says so, says what is missing, and keeps the pooled figures', () => {
    renderView({ observations: [], observationsLoad: load('failed', { status: 500 }) })
    expect(screen.getByText('The reliability scope list could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText(/not offered here until the list loads/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // The pooled matrix is a different request and must survive this one.
    expect(screen.getByTestId('irr-matrix')).toBeInTheDocument()
  })

  it('FAILED never claims there are no open observations', () => {
    renderView({ observations: [], observationsLoad: load('failed', { status: 500 }) })
    expect(screen.queryByText(/open cuts, so/)).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Reliability scope' })).toBeNull()
  })

  it('the stateful wiring hands the view a real load, not a literal', async () => {
    // The `data: observations = []` default is what made "no answer" and "none"
    // the same value; a `useMemo` over `?? []` keeps the identity stable AND
    // leaves the query as the thing asked about.
    const { observationsApi } = await import('@/lib/api')
    ;(observationsApi.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('boom'), { status: 500 }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ReliabilityTab projectId={1} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('The reliability scope list could not be loaded.')).toBeInTheDocument()
  })
})
