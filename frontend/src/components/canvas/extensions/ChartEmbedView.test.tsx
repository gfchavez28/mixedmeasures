import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import '@testing-library/jest-dom/vitest'

/**
 * #795 — the embed's stale-input warning RENDERS.
 *
 * 🔴 **A mount, not a scan, and that distinction is the whole issue.** The
 * indicator this replaces was declared, styled, and unit-testable, and its only
 * consumer never passed the prop that drove it — so it had never rendered once,
 * on any canvas, since the feature shipped. A test that hands the prop to the
 * component proves the markup and nothing about whether anything reaches it.
 * This mounts the CONSUMER against a payload with a stale column and asserts
 * the words a researcher would actually see.
 *
 * `NodeViewWrapper` is mocked to a plain div: it needs a live ProseMirror
 * NodeView context that no unit test has, and it is Tiptap's plumbing rather
 * than anything this file decides.
 */

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
}))

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1 }),
}))

// The chart itself is not under test — mocking it keeps the whole recharts /
// quickCompute stack out of this file, which is about the warning above it.
vi.mock('../InlineChartRenderer', () => ({
  default: () => <div data-testid="chart" />,
}))

vi.mock('@/lib/api', () => ({
  materialsApi: { listAllMaterials: vi.fn() },
  metricsApi: { analysisColumns: vi.fn() },
}))

import type { NodeViewProps } from '@tiptap/core'
import { materialsApi, metricsApi } from '@/lib/api'
import ChartEmbedView from './ChartEmbedView'

const column = (o: { id: number; stale?: boolean; domain_ids?: number[]; name?: string | null }) => ({
  id: o.id,
  dataset_id: 1,
  dataset_name: 'Student Assessments',
  column_code: null,
  column_name: o.name === undefined ? `Col ${o.id}` : o.name,
  column_text: `Column ${o.id}`,
  column_type: 'numeric',
  scale_labels: null,
  equivalence_group_id: null,
  domain_ids: o.domain_ids ?? [],
  stale: o.stale ?? false,
})

function renderEmbed(config: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // ONE cast, to the real prop type. `NodeViewProps` carries a dozen fields
  // ProseMirror supplies at runtime (editor, getPos, decorations, …) and this
  // component reads exactly four; spelling out the rest would be fabricating a
  // ProseMirror internal, which is worse evidence than an honest cast.
  const props = {
    node: {
      attrs: {
        materialId: 5,
        config: JSON.stringify(config),
        title: 'Score gain by school',
        materialTag: null,
        tagNote: null,
      },
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    selected: false,
  } as unknown as NodeViewProps

  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ChartEmbedView {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(materialsApi.listAllMaterials).mockResolvedValue([] as never)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the chart embed warns when a variable it reads needs recomputing', () => {
  it('names the stale variable, and says what is actually wrong', async () => {
    vi.mocked(metricsApi.analysisColumns).mockResolvedValue({
      datasets: [{ id: 1, name: 'Student Assessments', columns: [
        column({ id: 9, stale: true, name: 'Score Gain' }),
        column({ id: 2 }),
      ] }],
      domains: [],
      demographics: [],
    } as never)

    renderEmbed({ column_ids: [9, 2], metric_type: 'mean' })

    await waitFor(() => {
      expect(screen.getByText(/Needs recomputing/)).toBeInTheDocument()
    })
    expect(screen.getByText(/Score Gain has changed since it was last computed/)).toBeInTheDocument()
    // 🔴 The wording the dead prop used would have been FALSE here: the chart
    // re-fetches on every render, so its figures are not old.
    expect(screen.queryByText(/Data stale/)).toBeNull()
  })

  it('links to the variable so the fix is one click away', async () => {
    vi.mocked(metricsApi.analysisColumns).mockResolvedValue({
      datasets: [{ id: 1, name: 'Student Assessments', columns: [column({ id: 9, stale: true, name: 'Score Gain' })] }],
      domains: [], demographics: [],
    } as never)

    renderEmbed({ column_ids: [9], metric_type: 'mean' })

    const link = await screen.findByRole('link', { name: /open the variable/i })
    // The Variables view carries Recompute per variable — deep-linked to the
    // one that needs it, not the dataset's front door.
    expect(link).toHaveAttribute('href', '/projects/1/datasets/1/variables?column=9')
  })

  it('says nothing when every variable it reads is current', async () => {
    vi.mocked(metricsApi.analysisColumns).mockResolvedValue({
      datasets: [{ id: 1, name: 'Student Assessments', columns: [column({ id: 9 }), column({ id: 2 })] }],
      domains: [], demographics: [],
    } as never)

    renderEmbed({ column_ids: [9, 2], metric_type: 'mean' })

    await screen.findByTestId('chart')
    expect(screen.queryByText(/Needs recomputing/)).toBeNull()
  })

  it('ignores a stale variable this chart does not read', async () => {
    // Otherwise one un-recomputed column makes every chart on the canvas cry
    // wolf, which is worse than the silence it replaces.
    vi.mocked(metricsApi.analysisColumns).mockResolvedValue({
      datasets: [{ id: 1, name: 'Student Assessments', columns: [
        column({ id: 2 }),
        column({ id: 99, stale: true, name: 'Something Else' }),
      ] }],
      domains: [], demographics: [],
    } as never)

    renderEmbed({ column_ids: [2], metric_type: 'mean' })

    await screen.findByTestId('chart')
    expect(screen.queryByText(/Needs recomputing/)).toBeNull()
  })

  it('never asks for columns on a qualitative embed', async () => {
    // A qualitative chart reads codes and sources; it has no dataset column
    // that can be stale, so the query must not fire at all.
    renderEmbed({ tab: 'descriptives', chart_type: 'heatmap', code_ids: [1, 2] })

    await screen.findByTestId('chart')
    expect(metricsApi.analysisColumns).not.toHaveBeenCalled()
  })
})
