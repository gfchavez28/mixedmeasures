/**
 * #1077 (a) — the document reader on the Content tab says how many segments are
 * CODED, and "coded" means coded by a PERSON (#1029).
 *
 * It computed `segments.filter(s => s.codes.length > 0)` on the client, which
 * counts a model's labels, a universal-only marker ("Unclear", #400) and every
 * coder at once — measured by the audit as 3 where the server's people-only
 * count on the same payload said 1. The fix reads that server count
 * (`coded_segment_count`, `coding_counts`' figure), the way the conversation
 * reader beside it already reads `coded_count`.
 *
 * ⚠️ The fixture is built so the two answers DIFFER: three coded-looking
 * segments, of which only one was coded by a person.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({ getDetail: vi.fn() }))

vi.mock('@/lib/api', () => ({
  codeAnalysisApi: {},
  segmentsApi: { list: vi.fn() },
  documentsApi: { getDetail: api.getDetail },
  observationsApi: { listSegments: vi.fn() },
  textCodingApi: { list: vi.fn() },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Ada' }, refreshAuth: vi.fn() }),
}))

import ContentBySource from './ContentBySource'
import type { Code } from '@/lib/api'
import type { ListLoad, ListStatus } from '@/lib/list-status'

const READY: ListLoad = { status: 'ready', error: null, retry: () => {}, retrying: false }
const CODES = [
  { id: 10, name: 'Pacing', color: '#3b82f6', is_active: true, is_universal: false },
  { id: 11, name: 'Unclear', color: '#6b7280', is_active: true, is_universal: true },
] as unknown as Code[]

const seg = (id: number, codes: { id: number; user_id: number }[]) => ({
  id, sequence_order: id, text: `paragraph ${id}`, word_count: 2, page_number: null,
  heading_level: null, has_note: false, attached_notes: [], excerpt_info: null,
  merged_into_id: null, is_merge_result: false, split_into_id: null, is_split_result: false,
  codes: codes.map(c => ({
    id: c.id, name: CODES.find(k => k.id === c.id)!.name, color: null,
    is_universal: c.id === 11, user_id: c.user_id, magnitude: null, magnitude_conflict: null,
  })),
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1077 (a) — the document reader counts people', () => {
  it('reads the server count, not the codes on the payload', async () => {
    api.getDetail.mockResolvedValue({
      id: 8, name: 'Handbook', segment_count: 4,
      // The server's people-only figure: only paragraph 3 was coded by a person.
      coded_segment_count: 1,
      segments: [
        seg(1, [{ id: 10, user_id: 99 }]),   // a MODEL's label
        seg(2, [{ id: 11, user_id: 1 }]),    // a universal marker only
        seg(3, [{ id: 10, user_id: 1 }]),    // a person's coding
        seg(4, []),
      ],
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ContentBySource
            projectId={1}
            codes={CODES}
            codesStatus={'ready' as ListStatus}
            sourcesLoad={READY}
            conversations={[] as never}
            textColumns={[] as never}
            documents={[{ id: 8, name: 'Handbook' }] as never}
            observations={[] as never}
            selectedSourceId="d:8"
            onSourceSelect={() => {}}
            source="all"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // The client arithmetic this replaced would say "3 coded" on this payload.
    expect(await screen.findByText(/4 segments · 1 coded/)).toBeInTheDocument()
  })
})
