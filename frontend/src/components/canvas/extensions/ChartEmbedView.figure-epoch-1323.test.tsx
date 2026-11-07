import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import '@testing-library/jest-dom/vitest'
import type { NodeViewProps } from '@tiptap/core'

/**
 * #1323 D12 — an embed placed before its chart kind had a fingerprint says its
 * figures changed, instead of silently adopting the new ones as its baseline.
 *
 * 1.5.9 changed every number the code-by-group comparison draws, and before it the
 * comparison had no fingerprint — so every existing comparison embed carries no
 * baseline. The #808 seed adopts the first figures it sees for such an embed, which
 * would have recorded 1.5.9's numbers as if nothing had moved. Mounted, not scanned:
 * the seed and the notice are two readers of one predicate, and only a mount shows
 * both at once.
 */

const emitted = vi.hoisted(() => ({ figure: null as unknown }))

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
// The chart reports the fingerprint the test chooses, as the real renderer reports
// what it drew.
vi.mock('../InlineChartRenderer', () => {
  function MockChart({ onFigure }: { onFigure: (f: unknown) => void }) {
    useEffect(() => { onFigure(emitted.figure) }, [onFigure])
    return <div data-testid="chart" />
  }
  return { default: MockChart }
})
vi.mock('@/lib/api', () => ({
  materialsApi: { listAllMaterials: vi.fn() },
  metricsApi: { analysisColumns: vi.fn() },
}))

import { materialsApi } from '@/lib/api'
import ChartEmbedView from './ChartEmbedView'
import { CURRENT_FIGURE_EPOCH, fingerprintComparison, fingerprintQualComparison } from '../figure-baseline'

const QUAL = fingerprintQualComparison({
  groups: ['Board', 'Staff'],
  group_totals: { Board: { n: 6 }, Staff: { n: 6 } },
  codes: [{
    code_id: 1,
    by_group: { Board: { count: 6, proportion: 1 }, Staff: { count: 0, proportion: 0 } },
    delta_proportion: 1,
    test: { p_value: 0.0022, p_adjusted: 0.0368, significant: true, effect_size: null },
  }],
  basis: { unit: 'participant', correction: 'discrete_holm', family_size: 40 },
})
const QUANT = fingerprintComparison({
  groups: ['A', 'B'],
  rows: [{ label: 'x', group_stats: [{ group: 'A', n: 3, mean: 1 }, { group: 'B', n: 3, mean: 2 }],
           test: { test_type: 't_test', statistic: 2.5, p: 0.04 } }],
})

function renderEmbed(attrs: Record<string, unknown>) {
  const updateAttributes = vi.fn()
  const props = {
    node: { attrs: { materialId: 5, config: JSON.stringify({ code_ids: [1], tab: 'relationships' }),
                     title: 'Codes by role', materialTag: null, tagNote: null, ...attrs } },
    updateAttributes,
    deleteNode: vi.fn(),
    selected: false,
  } as unknown as NodeViewProps
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}><ChartEmbedView {...props} /></QueryClientProvider>
    </MemoryRouter>,
  )
  return updateAttributes
}

beforeEach(() => { vi.mocked(materialsApi.listAllMaterials).mockResolvedValue([] as never) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('a comparison embed from before its fingerprint (#1323 D12)', () => {
  it('says its figures changed and does NOT adopt them as its baseline', async () => {
    emitted.figure = QUAL
    const update = renderEmbed({})                 // no figureHash, no figureEpoch
    expect(await screen.findByText('The figures have changed')).toBeInTheDocument()
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(/counts participants, not passages/)
    expect(notice).toHaveTextContent('It now shows 1 of 40 codes starred.')
    expect(update).not.toHaveBeenCalled()         // HEAD: seeded silently with 1.5.9's numbers
  })

  it('records the reviewed figures, and the generation, when marked reviewed', async () => {
    emitted.figure = QUAL
    const update = renderEmbed({})
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as reviewed' }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      figureHash: QUAL.hash, figureHeadline: '1 of 40 codes starred', figureEpoch: CURRENT_FIGURE_EPOCH,
    }))
  })
})

describe('a change that moves no headline (#1529 D94)', () => {
  // A withheld share (or counts that keep the coded total) changes the hash and not the headline;
  // the notice read "5 coded is now 5 coded" until the drive found it.
  it('says the figures changed, with no "X is now X"', async () => {
    emitted.figure = QUAL
    renderEmbed({ figureHash: 'deadbeef', figureHeadline: QUAL.headline, figureStampedAt: '2026-11-04',
                  figureEpoch: CURRENT_FIGURE_EPOCH })
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('The figures have changed since 2026-11-04.')
    expect(notice).not.toHaveTextContent(/is now/)
  })

  it('control — a headline that moved still says before and after', async () => {
    emitted.figure = QUAL
    renderEmbed({ figureHash: 'deadbeef', figureHeadline: '0 of 40 codes starred',
                  figureStampedAt: '2026-11-04', figureEpoch: CURRENT_FIGURE_EPOCH })
    expect(await screen.findByRole('status'))
      .toHaveTextContent('0 of 40 codes starred is now 1 of 40 codes starred.')
  })
})

describe('controls — the #808 seed is unchanged where nothing is known to have moved', () => {
  it('an embed placed under this generation seeds silently', async () => {
    emitted.figure = QUAL
    const update = renderEmbed({ figureEpoch: CURRENT_FIGURE_EPOCH })
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ figureHash: QUAL.hash })))
    expect(screen.queryByText('The figures have changed')).toBeNull()
  })

  it('an older kind with no baseline seeds silently, whatever its generation', async () => {
    emitted.figure = QUANT
    const update = renderEmbed({})
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ figureHash: QUANT.hash })))
    expect(screen.queryByText('The figures have changed')).toBeNull()
  })
})
