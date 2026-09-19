/**
 * #963 Tier 3 — the Content tab's two panels, and the eight claims they made
 * about requests that had failed.
 *
 * `ContentByCode` rendered *"No data available."* for conversation segments and
 * for coded texts, and *"No … found for this code with current filters."* for
 * documents and observation clips — the second wording being the worse of the
 * two, because it names the researcher's FILTERS as the cause. `ContentBySource`
 * said the bare *"No data available."* in all four of its readers. Every one was
 * reached the same way: the gate above it read `isLoading`, which is
 * `isPending && isFetching` and therefore false the moment a failure settles.
 *
 * 🔴 **The interesting part is the SHAPE, not the count.** Three of
 * `ContentByCode`'s four sections are drawn from ONE request — each declared the
 * same query key, which React Query deduplicated — and they render
 * SIMULTANEOUSLY, so a per-section fix would have put three `role="alert"`
 * notices and three Retry buttons on screen for one failure. The load is hoisted
 * to the parent, which is the only thing that knows which of the three are
 * showing. `ContentBySource`'s four readers are genuinely four requests of which
 * exactly one is mounted at a time, so there they stay per-reader.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

const api = vi.hoisted(() => ({
  segmentsWithContext: vi.fn(),
  textsWithContext: vi.fn(),
  listSegments: vi.fn(),
  getDetail: vi.fn(),
  listObservationSegments: vi.fn(),
  listTexts: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  codeAnalysisApi: {
    segmentsWithContext: api.segmentsWithContext,
    textsWithContext: api.textsWithContext,
  },
  segmentsApi: { list: api.listSegments },
  documentsApi: { getDetail: api.getDetail },
  observationsApi: { listSegments: api.listObservationSegments },
  textCodingApi: { list: api.listTexts },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Ada' }, refreshAuth: vi.fn() }),
}))

import ContentByCode from './ContentByCode'
import ContentBySource from './ContentBySource'
import type { Code } from '@/lib/api'
import type { ListLoad, ListStatus } from '@/lib/list-status'

const READY: ListLoad = { status: 'ready', error: null, retry: () => {}, retrying: false }
const CODES = [
  { id: 10, name: 'Pacing', color: '#3b82f6', is_active: true, is_universal: false },
] as unknown as Code[]

/** An ANSWERED refusal — duck-typed on `status`, like the real predicates. */
const answered500 = () => Object.assign(new Error('boom'), { status: 500 })

/** The three-source payload, ANSWERED and empty in every arm. */
const EMPTY_SEGMENTS = {
  conversations: [], documents: [], observations: [],
  total_segments: 0, has_more: false,
}

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderByCode(over: Record<string, unknown> = {}) {
  return wrap(
    <ContentByCode
      projectId={1}
      codes={CODES}
      codesStatus={'ready' as ListStatus}
      frequencies={[]}
      selectedContentCodeId={10}
      onCodeSelect={() => {}}
      filterParams={{ source: 'all' }}
      source="all"
      hasConversations
      hasCommentColumns
      hasDocuments
      hasObservations
      {...over}
    />,
  )
}

function renderBySource(selectedSourceId: string, over: Record<string, unknown> = {}) {
  return wrap(
    <ContentBySource
      projectId={1}
      codes={CODES}
      codesStatus={'ready' as ListStatus}
      sourcesLoad={READY}
      conversations={[{ id: 5, name: 'Interview 1' }] as never}
      textColumns={[{ column_id: 7, column_name: 'Why', column_text: 'Why?', dataset_id: 2, dataset_name: 'Survey', coded_count: 1 }] as never}
      documents={[{ id: 8, name: 'Handbook' }] as never}
      observations={[{ id: 9, name: 'Playground' }] as never}
      selectedSourceId={selectedSourceId}
      onSourceSelect={() => {}}
      source="all"
      {...over}
    />,
  )
}

afterEach(cleanup)
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.segmentsWithContext.mockResolvedValue(EMPTY_SEGMENTS)
  api.textsWithContext.mockResolvedValue({ datasets: [], total_texts: 0, has_more: false })
  api.listSegments.mockResolvedValue({ segments: [] })
  api.getDetail.mockResolvedValue({ id: 8, name: 'Handbook', segments: [] })
  api.listObservationSegments.mockResolvedValue([])
  api.listTexts.mockResolvedValue({ texts: [], total_texts: 0, has_more: false })
})

describe('#963 Tier 3 — ContentByCode: three sections, ONE request, ONE notice', () => {
  it('READY and empty: each section makes its own true claim (positive control)', async () => {
    renderByCode()
    // Documents and observations name the filters — correct about an ANSWER.
    expect(await screen.findByText('No document segments found for this code with current filters.'))
      .toBeInTheDocument()
    expect(screen.getByText('No coded clips found for this code with current filters.'))
      .toBeInTheDocument()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })

  it('LOADING: one notice, not three, and no claim about filters', async () => {
    api.segmentsWithContext.mockReturnValue(new Promise(() => {}))
    renderByCode()
    expect(await screen.findAllByText('Loading coded passages…')).toHaveLength(1)
    expect(screen.queryByText(/with current filters/)).toBeNull()
  })

  it('FAILED: ONE alert and ONE Retry for the three sections that share the request', async () => {
    api.segmentsWithContext.mockRejectedValue(answered500())
    renderByCode()
    expect(await screen.findByText('The coded passages for this code could not be loaded.'))
      .toBeInTheDocument()
    // 🔴 The whole reason the query was hoisted: one failure, one notice.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    // ⚠️ Scoped to the three sections that share the request. The Coded Texts
    // section legitimately still says "…with current filters" — ITS query
    // answered — and asserting on the phrase alone failed against correct code.
    expect(screen.queryByText('No document segments found for this code with current filters.')).toBeNull()
    expect(screen.queryByText('No coded clips found for this code with current filters.')).toBeNull()
    expect(screen.queryByText('No data available.')).toBeNull()
  })

  it('the Coded Texts section keeps its OWN load — a different endpoint', async () => {
    // Its failure must not blank the three beside it, and theirs must not
    // blank it.
    api.textsWithContext.mockRejectedValue(answered500())
    renderByCode()
    expect(await screen.findByText('The coded texts for this code could not be loaded.'))
      .toBeInTheDocument()
    // The segments payload answered, so its sections still speak.
    expect(screen.getByText('No document segments found for this code with current filters.'))
      .toBeInTheDocument()
  })

  it('does not even ASK for the payload when no section reads it', async () => {
    // 🔴 A regression this round introduced and then caught by re-reading its
    // own diff. Hoisting moved the query ABOVE the early return, so it fired on
    // the Text source view — where none of the three sections mounts — which
    // the per-section version never did, because an unmounted section runs no
    // query. `needsSegments` is the `enabled` flag, not only a render gate.
    renderByCode({ source: 'text', hasConversations: false, hasDocuments: false, hasObservations: false })
    expect(await screen.findByText('No coded texts found for this code with current filters.'))
      .toBeInTheDocument()
    expect(api.segmentsWithContext).not.toHaveBeenCalled()
  })

  it('DOES ask when any one of the three is showing', async () => {
    // The positive control for the line above: a gate that disables the query
    // altogether passes every negative assertion.
    renderByCode({ hasConversations: true, hasDocuments: false, hasObservations: false })
    await screen.findByText('No coded texts found for this code with current filters.')
    expect(api.segmentsWithContext).toHaveBeenCalled()
  })

  it('says nothing about the shared request when no section reads it', async () => {
    // With only text columns on screen the segments payload is nobody's
    // business, and a notice about it would be a claim about a request nothing
    // here depends on.
    api.segmentsWithContext.mockRejectedValue(answered500())
    renderByCode({ hasConversations: false, hasDocuments: false, hasObservations: false })
    expect(await screen.findByText('No coded texts found for this code with current filters.'))
      .toBeInTheDocument()
    expect(screen.queryByText('The coded passages for this code could not be loaded.')).toBeNull()
  })
})

describe('#963 Tier 3 — ContentBySource: four readers, four requests', () => {
  const CASES = [
    { id: 'c:5', mock: () => api.listSegments, loading: 'Loading conversation…', failed: 'This conversation could not be loaded.' },
    { id: 'd:8', mock: () => api.getDetail, loading: 'Loading document…', failed: 'This document could not be loaded.' },
    { id: 'cc:7', mock: () => api.listTexts, loading: 'Loading texts…', failed: 'These texts could not be loaded.' },
    { id: 'o:9', mock: () => api.listObservationSegments, loading: 'Loading observation…', failed: 'This observation could not be loaded.' },
  ]

  for (const c of CASES) {
    it(`${c.id} — LOADING says so, never "No data available."`, async () => {
      c.mock().mockReturnValue(new Promise(() => {}))
      renderBySource(c.id)
      expect(await screen.findByText(c.loading)).toBeInTheDocument()
      expect(screen.queryByText('No data available.')).toBeNull()
    })

    it(`${c.id} — FAILED names the source, with a Retry`, async () => {
      c.mock().mockRejectedValue(answered500())
      renderBySource(c.id)
      expect(await screen.findByText(c.failed)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
      expect(screen.queryByText('No data available.')).toBeNull()
    })
  }

  it('READY and empty: the reader draws its own honest empty state (positive control)', async () => {
    renderBySource('c:5')
    expect(await screen.findByText('Interview 1')).toBeInTheDocument()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })

  it('the phrase this tier removed is gone from both files’ CODE', () => {
    // A population check rather than a per-reader one: "No data available." was
    // the same four words in eight places across two files, and the risk is a
    // ninth. ⚠️ Stripped through `lib/strip-comments.ts`, never a hand-rolled
    // filter — the first draft of this case used `startsWith('*')` and reported
    // its own explanatory JSDoc as a defect, which is #772's phantom class
    // inside a guard written to prevent it.
    for (const file of ['ContentBySource.tsx', 'ContentByCode.tsx']) {
      const src = readFileSync(join(SRC_DIR, 'components/qualitative-analysis', file), 'utf8')
      // Self-check per file (#814): a stripper that blanked everything would
      // otherwise pass by finding nothing.
      const code = stripComments(src, file)
      expect(code).toContain('export default function')
      expect(code).not.toContain('No data available.')
      // …and the prose that explains the removal survives in the ORIGINAL.
      expect(src).toContain('No data available.')
    }
  })
})
