/**
 * #630 regression: the Materials drawer must not render a clip excerpt blank.
 *
 * The reported symptom was a button whose `innerText` was `""` — both the
 * excerpt line and the attribution line empty — because the row rendered
 * `{excerpt_text}` over `[speaker_name, conversation_name]` and a clip has
 * none of the three (its `Segment` parent is an Observation, and a time-range
 * quote carries no text of its own).
 *
 * ⚠️ These tests must assert against the MOUNTED COMPONENT, not the helpers.
 * `canvas-excerpt.test.ts` covers the helpers, and those tests pass whether or
 * not this drawer actually calls them — which is the whole shape of the
 * #624/#626/#627/#630 class: the piece shipped, one consuming surface never
 * wired it up.
 *
 * ⚠️ Every fixture here must include a CLIP. A conversation-only fixture passes
 * before AND after the fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import MaterialsDrawer from './MaterialsDrawer'
import type { ExcerptResponse } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  excerptsApi: { list: vi.fn() },
  materialsApi: { listAllMaterials: vi.fn() },
  memosApi: { list: vi.fn() },
}))

import { excerptsApi, materialsApi, memosApi } from '@/lib/api'

function excerpt(over: Partial<ExcerptResponse> = {}): ExcerptResponse {
  return {
    id: 5, segment_id: 2001, dataset_value_id: null,
    start_offset: null, end_offset: null, start_time: null, end_time: null,
    excerpt_text: '', conversation_id: null, conversation_name: null,
    observation_id: 7, observation_name: 'nasa_collins_apollo11_interview',
    speaker_name: null, segment_timestamp: null,
    note: null, has_note: false, created_at: '2026-07-25T00:00:00+00:00',
    ...over,
  }
}

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MaterialsDrawer
          projectId={1}
          onCanvasSourceIds={{
            onCanvasExcerptIds: new Set(),
            onCanvasMaterialIds: new Set(),
            onCanvasMemoIds: new Set(),
          }}
          open
          initialSection="excerpts"
          onClose={() => {}}
          onInsertExcerpt={() => {}}
          onInsertMaterial={() => {}}
          onInsertMemo={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(materialsApi.listAllMaterials).mockResolvedValue([])
  vi.mocked(memosApi.list).mockResolvedValue({ memos: [] } as never)
})

describe('MaterialsDrawer — clip excerpts (#630)', () => {
  it('renders a visible label and attribution for an unlabeled clip', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({
      excerpts: [excerpt({ start_time: 60, end_time: 61 })],
    } as never)

    renderDrawer()

    // The literal repro: the row's text content was "".
    const row = await screen.findByRole('button', { name: /Insert Clip/ })
    expect(row.textContent).not.toBe('')
    expect(row.textContent).toContain('Clip 1:00.0–1:01.0')
    expect(row.textContent).toContain('nasa_collins_apollo11_interview')
  })

  it('gives the row an accessible name a screen reader can announce', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({
      excerpts: [excerpt({ start_time: 60, end_time: 61 })],
    } as never)

    renderDrawer()

    expect(
      await screen.findByRole('button', {
        name: 'Insert Clip 1:00.0–1:01.0 — nasa_collins_apollo11_interview · 1:00.0–1:01.0',
      }),
    ).toBeInTheDocument()
  })

  it('finds a clip by its observation name in the filter', async () => {
    // Sibling defect: the filter tested excerpt_text/speaker/conversation, so a
    // clip was unfindable by the one name its own row displays.
    vi.mocked(excerptsApi.list).mockResolvedValue({
      excerpts: [
        excerpt({ id: 5, start_time: 60, end_time: 61 }),
        excerpt({
          id: 6, observation_id: null, observation_name: null,
          conversation_id: 3, conversation_name: 'Interview 1',
          speaker_name: 'P04', excerpt_text: 'we tried that',
        }),
      ],
    } as never)

    renderDrawer()
    await screen.findByRole('button', { name: /Insert Clip/ })

    fireEvent.change(screen.getByPlaceholderText(/filter/i), {
      target: { value: 'apollo' },
    })

    expect(screen.getByRole('button', { name: /Insert Clip/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /we tried that/ })).not.toBeInTheDocument()
  })

  it('still shows speaker · conversation for a conversation excerpt', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({
      excerpts: [excerpt({
        observation_id: null, observation_name: null,
        conversation_id: 3, conversation_name: 'Interview 1',
        speaker_name: 'P04', excerpt_text: 'we tried that',
      })],
    } as never)

    renderDrawer()

    const row = await screen.findByRole('button', { name: /we tried that/ })
    expect(row.textContent).toContain('P04 · Interview 1')
  })
})
