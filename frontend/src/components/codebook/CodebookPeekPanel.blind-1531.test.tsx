/**
 * #1531 (1.5.9, decided 2026-11-05c) — the Codebook peek's sample passages follow blind mode.
 *
 * Measured before (the blind-exports review kit, build session B): blind Alice peeking *Bob theme*
 * read T1 and T3 under *Sample Segments* — the turns Bob coded with it. The developer: "the codebook
 * sample passages should follow blind mode". While blind mode WITHHOLDS the samples come from the
 * viewer's own coding and the panel says so; the usage counts stay every coder's (#454). Every
 * scoped case has its unscoped twin.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { CodebookTreeResponse } from '@/lib/api'

const h = vi.hoisted(() => ({
  blind: { blind: true, withholding: true, settled: true },
  user: { id: 2, username: 'Alice' } as { id: number; username: string } | null,
  segmentsWithContext: (() => {}) as (...a: unknown[]) => unknown,
}))
const BOB_PASSAGE = 'I waited three hours for the forms.'
const segmentsWithContext = vi.fn((_pid: number, _code: number, params: { coder_ids?: string }) =>
  Promise.resolve({
    conversations: params.coder_ids
      ? []   // Alice never applied Bob's code
      : [{ conversation_id: 1, conversation_name: 'Interview 1', segment_count: 1, segments: [{ id: 4, text: BOB_PASSAGE }] }],
  }))

vi.mock('@/lib/api', () => ({
  codesApi: { update: vi.fn() },
  categoriesApi: { update: vi.fn(), delete: vi.fn() },
  codeAnalysisApi: { segmentsWithContext: (...a: unknown[]) => segmentsWithContext(...(a as [number, number, { coder_ids?: string }])) },
  memosApi: { list: vi.fn(() => Promise.resolve({ memos: [] })) },
}))
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ ...h.blind, blindLens: new Set<number>(), toggleReveal: () => {} }),
}))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: h.user }) }))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ openMemos: vi.fn(), openCodebook: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

import CodebookPeekPanel, { BLIND_SAMPLES_NOTE } from './CodebookPeekPanel'

const TREE = {
  universal_codes: [], tree: [],
  uncategorized_codes: [{
    id: 5, numeric_id: 4, name: 'Bob theme', description: null, color: '#dc2626', is_active: true,
    is_universal: false, segment_count: 3, source_count: 2, excerpt_count: 1, category_id: null,
  }],
} as unknown as CodebookTreeResponse

const BLIND = { blind: true, withholding: true, settled: true }
beforeEach(() => { h.blind = { ...BLIND }; h.user = { id: 2, username: 'Alice' } })
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderPeek() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CodebookPeekPanel projectId={1} selection="code:5" treeData={TREE} onSelect={() => {}} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const r = render(ui())
  return { rerenderPeek: () => r.rerender(ui()) }
}

describe('the Codebook peek while blind (#1531)', () => {
  it('asks for the viewer’s own passages, shows none of the colleague’s, and says why', async () => {
    renderPeek()
    await waitFor(() => expect(segmentsWithContext).toHaveBeenCalled())
    expect(segmentsWithContext.mock.calls[0][2]).toMatchObject({ coder_ids: '2' })
    expect(await screen.findByText(BLIND_SAMPLES_NOTE)).toBeInTheDocument()
    expect(screen.queryByText(BOB_PASSAGE)).toBeNull()
  })

  it('…and with nothing withheld it asks for every coder and shows the passage, with no note (the twin)', async () => {
    h.blind = { blind: false, withholding: false, settled: true }
    renderPeek()
    expect(await screen.findByText(BOB_PASSAGE)).toBeInTheDocument()
    expect(segmentsWithContext.mock.calls[0][2]).not.toHaveProperty('coder_ids')
    expect(screen.queryByText(BLIND_SAMPLES_NOTE)).toBeNull()
  })

  it('a reveal is a NEW key — the samples are asked again for every coder (#454)', async () => {
    const { rerenderPeek } = renderPeek()
    await waitFor(() => expect(segmentsWithContext).toHaveBeenCalledTimes(1))
    h.blind = { blind: false, withholding: false, settled: true }
    rerenderPeek()
    expect(await screen.findByText(BOB_PASSAGE)).toBeInTheDocument()
    expect(segmentsWithContext).toHaveBeenCalledTimes(2)
  })

  it('waits while the blind state is unsettled, and while withholding with no viewer id (fail closed)', async () => {
    h.blind = { blind: false, withholding: true, settled: false }
    renderPeek()
    await new Promise(r => setTimeout(r, 50))
    expect(segmentsWithContext).not.toHaveBeenCalled()
    cleanup()
    h.blind = { ...BLIND }
    h.user = null
    renderPeek()
    await new Promise(r => setTimeout(r, 50))
    expect(segmentsWithContext).not.toHaveBeenCalled()
    expect(screen.queryByText(BOB_PASSAGE)).toBeNull()
  })
})
