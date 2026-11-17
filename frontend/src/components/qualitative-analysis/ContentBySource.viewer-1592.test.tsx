/**
 * #1592 — the *By Source* readers offer *Remove code* only on a code the VIEWER applied.
 *
 * Each reader shows DISTINCT codes, and every one of its four payloads names each code's coder,
 * so the reader can tell: Alice (the viewer) and Bob both coded T one, Bob alone coded T three.
 * With nothing withheld (colleagues shown) both readers drew a "Remove code Bob theme" on T three
 * that removed nothing — the door deletes the caller's application only (#879's rule). Fixture
 * and mocks are `ContentBySource.blind-1531.test.tsx`'s, so the two files read the same passages.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({
  listSegments: vi.fn(),
  getDetail: vi.fn(),
  listObservationSegments: vi.fn(),
  listTexts: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  segmentsApi: { list: api.listSegments },
  documentsApi: { getDetail: api.getDetail },
  observationsApi: { listSegments: api.listObservationSegments },
  textCodingApi: { list: api.listTexts },
  TEXT_PAGE_SIZE: 200,
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 2, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import ContentBySource from './ContentBySource'
import type { Code } from '@/lib/api'
import type { ListLoad, ListStatus } from '@/lib/list-status'

const ALICE = 2
const BOB = 3
const READY: ListLoad = { status: 'ready', error: null, retry: () => {}, retrying: false }
const CODES = [
  { id: 10, name: 'Alice theme', color: '#16a34a', is_active: true, is_universal: false },
  { id: 11, name: 'Bob theme', color: '#dc2626', is_active: true, is_universal: false },
] as unknown as Code[]
/** T one: both coders' codes; T three: only Bob's. */
const details = (pairs: [number, number][]) =>
  pairs.map(([code_id, user_id]) => ({ code_id, user_id, attribution: null, is_universal: false, magnitude: null, magnitude_conflict: null }))
const T_ONE = [[10, ALICE], [11, BOB]] as [number, number][]
const T_THREE = [[11, BOB]] as [number, number][]

beforeEach(() => {
  api.listSegments.mockResolvedValue({
    coded_count: 2,
    segments: [
      { id: 1, text: 'T one', speaker_name: 'Ana', is_facilitator: false, applied_codes: [10, 11], applied_code_details: details(T_ONE) },
      { id: 3, text: 'T three', speaker_name: 'Ana', is_facilitator: false, applied_codes: [11], applied_code_details: details(T_THREE) },
    ],
  })
  api.getDetail.mockResolvedValue({
    id: 8, name: 'Handbook', coded_segment_count: 2,
    segments: [
      { id: 21, text: 'T one', sequence_order: 0, heading_level: null, codes: T_ONE.map(([id, user_id]) => ({ id, user_id, name: '', color: null, is_universal: false })) },
      { id: 23, text: 'T three', sequence_order: 1, heading_level: null, codes: T_THREE.map(([id, user_id]) => ({ id, user_id, name: '', color: null, is_universal: false })) },
    ],
  })
  api.listObservationSegments.mockResolvedValue([
    { id: 31, text: 'T one', start_time: 0, end_time: 5, applied_codes: [10, 11], applied_code_details: details(T_ONE) },
    { id: 33, text: 'T three', start_time: 5, end_time: 9, applied_codes: [11], applied_code_details: details(T_THREE) },
  ])
  api.listTexts.mockResolvedValue({
    total_texts: 2, has_more: false,
    texts: [
      { dataset_value_id: 41, dataset_row_id: 1, row_identifier: 'R1', value_text: 'T one', applied_code_ids: [10, 11], applied_code_details: details(T_ONE) },
      { dataset_value_id: 43, dataset_row_id: 2, row_identifier: 'R2', value_text: 'T three', applied_code_ids: [11], applied_code_details: details(T_THREE) },
    ],
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderReader(source: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContentBySource
          projectId={1} codes={CODES} codesStatus={'ready' as ListStatus} sourcesLoad={READY}
          conversations={[{ id: 5, name: 'Interview 1' }] as never}
          textColumns={[{ column_id: 7, column_name: 'Why', column_text: 'Why?', dataset_id: 2, dataset_name: 'Survey', coded_count: 2 }] as never}
          documents={[{ id: 8, name: 'Handbook' }] as never}
          observations={[{ id: 9, name: 'Playground' }] as never}
          selectedSourceId={source} onSourceSelect={() => {}} source="all"
          coderLens={null} viewerId={ALICE} blind={false}
          onCodeChange={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const READERS = [['a conversation', 'c:5'], ['a document', 'd:8'], ['an observation', 'o:9'], ['a text column', 'cc:7']] as const

describe('By Source: a remove only on the viewer’s own code (#1592)', () => {
  for (const [what, source] of READERS) {
    it(`${what}: Bob’s code is drawn on both passages and carries no remove; Alice’s keeps hers`, async () => {
      renderReader(source)
      // Colleagues shown: both of Bob's chips are drawn — the fix removes a control, not a coding.
      expect(await screen.findAllByText('Bob theme')).toHaveLength(2)
      expect(screen.queryAllByRole('button', { name: 'Remove code Bob theme' })).toHaveLength(0)
      // Positive control: the viewer's own code keeps its remove.
      expect(screen.getAllByRole('button', { name: 'Remove code Alice theme' })).toHaveLength(1)
    })
  }
})
