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
    excerpt_text: '',
    source_kind: 'observation', source_name: 'nasa_collins_apollo11_interview',
    conversation_id: null, conversation_name: null,
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
          source_kind: 'conversation', source_name: 'Interview 1',
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
        source_kind: 'conversation', source_name: 'Interview 1',
      conversation_id: 3, conversation_name: 'Interview 1',
        speaker_name: 'P04', excerpt_text: 'we tried that',
      })],
    } as never)

    renderDrawer()

    const row = await screen.findByRole('button', { name: /we tried that/ })
    expect(row.textContent).toContain('P04 · Interview 1')
  })
})

/**
 * #963 Tier 2 — each section speaks for its OWN list, and the closed pane says
 * nothing at all.
 *
 * Measured in Chrome before the fix: the three section headers read `0` over
 * three requests still in flight, and the empty bodies named a place to go and
 * make some — while the CLOSED pane (`w-0`) kept five focusable controls in the
 * Tab order with no `inert` and no `aria-hidden`, so `.focus()` landed on a 24px
 * button inside a 0px pane.
 */
function renderDrawerWith(props: Partial<React.ComponentProps<typeof MaterialsDrawer>> = {}) {
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
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const header = (label: string) =>
  screen.getAllByRole('button', { expanded: true }).concat(screen.getAllByRole('button', { expanded: false }))
    .find(b => b.textContent?.startsWith(label))!

describe('#963 — the Materials drawer sections wait for their own lists', () => {
  it('READY: each header states its count and the empty body names where to make some', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({ excerpts: [], total: 0 } as never)
    renderDrawerWith()

    expect(await screen.findByText('Create excerpts in a Coding Workbench to embed them here.')).toBeInTheDocument()
    expect(header('Excerpts')).toHaveTextContent('Excerpts0')
  })

  it('LOADING: no count on the header, and the body says it is loading', async () => {
    vi.mocked(excerptsApi.list).mockReturnValue(new Promise(() => {}) as never)
    renderDrawerWith()

    expect(await screen.findByText('Loading excerpts…')).toBeInTheDocument()
    expect(screen.queryByText(/Create excerpts in a Coding Workbench/)).not.toBeInTheDocument()
    expect(header('Excerpts')).toHaveTextContent('Excerpts')
    expect(header('Excerpts').textContent).not.toMatch(/\d/)
  })

  it('FAILED: says the LOAD failed, and offers a Retry', async () => {
    vi.mocked(excerptsApi.list).mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    renderDrawerWith()

    expect(await screen.findByText('Your excerpts could not be loaded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/Create excerpts in a Coding Workbench/)).not.toBeInTheDocument()
  })

  it('one section failing leaves the other two alone', async () => {
    // A failure is a statement about ONE request. Three combined loads would
    // have blanked the Charts and Memos counts alongside it.
    vi.mocked(excerptsApi.list).mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    renderDrawerWith()

    await screen.findByText('Your excerpts could not be loaded')
    expect(header('Charts')).toHaveTextContent('Charts0')
    expect(header('Memos')).toHaveTextContent('Memos0')
  })

  it('the CLOSED pane is inert AND aria-hidden — the two travel together', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({ excerpts: [], total: 0 } as never)
    const { container } = renderDrawerWith({ open: false })

    const panel = container.querySelector('[data-materials-panel]')!
    expect(panel).toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
  })

  it('the OPEN pane is neither (positive control)', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({ excerpts: [], total: 0 } as never)
    const { container } = renderDrawerWith({ open: true })

    const panel = container.querySelector('[data-materials-panel]')!
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).not.toHaveAttribute('aria-hidden')
  })

  it('closing returns focus to the control that owns the pane', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({ excerpts: [], total: 0 } as never)
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    const closeReturnRef = { current: opener as HTMLElement | null }

    const { rerender } = renderDrawerWith({ open: true, closeReturnRef })
    const close = await screen.findByRole('button', { name: 'Close materials panel' })
    close.focus()
    expect(document.activeElement).toBe(close)

    // jsdom does not implement `inert`, so the blur it causes in Chrome is
    // simulated: what is under test is the ladder, not the attribute.
    close.blur()
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <MaterialsDrawer
            projectId={1}
            onCanvasSourceIds={{
              onCanvasExcerptIds: new Set(),
              onCanvasMaterialIds: new Set(),
              onCanvasMemoIds: new Set(),
            }}
            open={false}
            initialSection="excerpts"
            onClose={() => {}}
            onInsertExcerpt={() => {}}
            onInsertMaterial={() => {}}
            onInsertMemo={() => {}}
            closeReturnRef={closeReturnRef}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(document.activeElement).toBe(opener)
    expect(document.activeElement).not.toBe(document.body)
    opener.remove()
  })

  it('does NOT steal focus from somewhere else on the page', async () => {
    vi.mocked(excerptsApi.list).mockResolvedValue({ excerpts: [], total: 0 } as never)
    const opener = document.createElement('button')
    const elsewhere = document.createElement('input')
    document.body.append(opener, elsewhere)
    const closeReturnRef = { current: opener as HTMLElement | null }

    // Focused BEFORE the mount, deliberately: the effect runs on mount too, so
    // a version keyed on `!open` alone — rather than on the open→closed
    // TRANSITION — steals focus on every load of a canvas whose drawer is shut.
    // Focusing after the render cannot reach that, and the mutant survived it.
    elsewhere.focus()
    renderDrawerWith({ open: false, closeReturnRef })

    expect(document.activeElement).toBe(elsewhere)
    opener.remove(); elsewhere.remove()
  })

  it('a canvas that OPENS with the pane shut does not pull focus into the toolbar', async () => {
    // The sharper form of the case above, and the one the `lost` check cannot
    // answer on its own: with nothing focused, `document.activeElement` IS
    // `<body>`, so "focus was lost" is true on the very first render. Only the
    // open→closed TRANSITION distinguishes "the pane just closed under you"
    // from "the pane has been shut since the page loaded".
    vi.mocked(excerptsApi.list).mockResolvedValue({ excerpts: [], total: 0 } as never)
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    const closeReturnRef = { current: opener as HTMLElement | null }

    expect(document.activeElement).toBe(document.body)
    renderDrawerWith({ open: false, closeReturnRef })

    expect(document.activeElement).not.toBe(opener)
    opener.remove()
  })
})
