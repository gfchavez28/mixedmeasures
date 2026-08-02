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

function renderView(over: {
  observations?: ObsLike[]
  selectedId?: number | null
} = {}) {
  return render(
    <ReliabilityTabView
      projectId={1}
      observations={asObs(over.observations ?? [])}
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
