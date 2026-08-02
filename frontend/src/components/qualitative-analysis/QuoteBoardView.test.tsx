/**
 * QuoteBoardView — the FIRST tests for this component (slab 5c).
 *
 * Scoped to what 5c changed: the group-by-source bucket key (clips used to
 * shatter into one bucket per clip, because `source_name` carried a per-clip
 * timecode suffix), the per-observation exclude filter, and the CSV's clip
 * time columns — which are load-bearing, not decoration: dropping the suffix
 * without them would have exported every clip of one observation identically.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { QuotedExcerptItem, QuotedExcerptsResponse } from '@/lib/api'

const getConfig = vi.fn()
const updateConfig = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    quoteBoardApi: { getConfig: (...a: unknown[]) => getConfig(...a), updateConfig: (...a: unknown[]) => updateConfig(...a) },
    excerptsApi: { ...actual.excerptsApi, delete: vi.fn(), create: vi.fn(), listQuoted: vi.fn() },
  }
})

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

import QuoteBoardView from './QuoteBoardView'

function clip(over: Partial<QuotedExcerptItem> & { excerpt_id: number }): QuotedExcerptItem {
  return {
    source_type: 'segment', segment_id: 2000 + over.excerpt_id, dataset_value_id: null,
    text: 'A clip', full_segment_text: 'A clip',
    is_sub_segment: false, start_offset: null, end_offset: null,
    start_time: null, end_time: null,
    segment_start_time: 65, segment_end_time: 92.4,
    speaker_name: null, speaker_is_facilitator: false,
    participant_id: null, participant_name: null,
    source_name: 'Classroom', sequence_order: 1,
    conversation_id: null, conversation_date: null, conversation_sort_key: null,
    document_id: null, document_name: null,
    observation_id: 7, observation_name: 'Classroom',
    dataset_id: null, dataset_name: null, column_id: null, column_name: null,
    applied_code_ids: [], applied_codes: [],
    excerpt_note: null, context_before: null, context_before_speaker: null,
    created_at: '2026-07-18T00:00:00+00:00',
    ...over,
  }
}

function quoteData(excerpts: QuotedExcerptItem[]): QuotedExcerptsResponse {
  return {
    excerpts,
    total_excerpts: excerpts.length,
    total_conversation_excerpts: 0,
    total_comment_excerpts: 0,
    total_document_excerpts: 0,
    total_observation_excerpts: excerpts.length,
  }
}

function renderBoard(excerpts: QuotedExcerptItem[], props: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <QuoteBoardView
          projectId={1}
          codes={[]}
          filterParams={{}}
          quoteData={quoteData(excerpts)}
          groupBy="source"
          sortMode="source"
          density="quote"
          setSrAnnouncement={vi.fn()}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getConfig.mockResolvedValue({ custom_orders: {} })
})
afterEach(cleanup)

describe('group-by-source bucketing', () => {
  it('gathers every clip of one observation into ONE bucket', async () => {
    // The shatter: the bucket key was `src-${source_name}`, and source_name
    // carried a per-clip timecode, so each clip became its own group.
    renderBoard([
      clip({ excerpt_id: 1, segment_start_time: 65 }),
      clip({ excerpt_id: 2, segment_start_time: 300 }),
      clip({ excerpt_id: 3, segment_start_time: 900 }),
    ])
    const headings = await screen.findAllByText('Classroom')
    expect(headings).toHaveLength(1)
  })

  it('keeps two observations that share a NAME apart', async () => {
    // Keying on the de-suffixed name alone would have merged these — trading
    // the shatter for a silent collision.
    renderBoard([
      clip({ excerpt_id: 1, observation_id: 7, observation_name: 'Classroom', source_name: 'Classroom' }),
      clip({ excerpt_id: 2, observation_id: 8, observation_name: 'Classroom', source_name: 'Classroom' }),
    ])
    const headings = await screen.findAllByText('Classroom')
    expect(headings).toHaveLength(2)
  })
})

describe('the per-observation exclude filter', () => {
  it('hides an excluded observation’s clips and keeps the others', async () => {
    renderBoard(
      [
        clip({ excerpt_id: 1, observation_id: 7, text: 'Kept clip' }),
        clip({ excerpt_id: 2, observation_id: 8, observation_name: 'Hallway', source_name: 'Hallway', text: 'Hidden clip' }),
      ],
      { hiddenObservationIds: new Set([8]) },
    )
    expect(await screen.findByText('Kept clip')).toBeInTheDocument()
    expect(screen.queryByText('Hidden clip')).not.toBeInTheDocument()
  })
})

describe('CSV export', () => {
  it('emits the clip and quote time columns', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    let captured = ''
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.stubGlobal('Blob', class {
      constructor(parts: string[]) { captured = parts.join('') }
    } as unknown as typeof globalThis.Blob)

    renderBoard([clip({ excerpt_id: 1, start_time: 70.5, end_time: 80 })])
    fireEvent.click(await screen.findByRole('button', { name: /export/i }))

    await waitFor(() => expect(captured).toContain('clip_start'))
    const [header, row] = captured.replace(/^\uFEFF/, '').split('\r\n')
    expect(header.split(',')).toEqual(expect.arrayContaining([
      'clip_start', 'clip_end', 'clip_duration', 'quote_start', 'quote_end',
    ]))
    // The clip's own span, its duration, and the quote's sub-range — the data
    // the dropped source_name suffix used to smuggle in.
    expect(row).toContain('1:05.0')
    expect(row).toContain('1:32.4')
    expect(row).toContain('0:27.4')
    expect(row).toContain('1:10.5')
    expect(row).toContain('1:20.0')

    vi.unstubAllGlobals()
  })
})
