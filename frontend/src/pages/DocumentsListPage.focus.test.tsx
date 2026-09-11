/**
 * #932 — where focus goes after a document's subject is set.
 *
 * Row 46's subject affordance is context-menu-only (deliberate: the card is a
 * `<Link>`), and the dialog it opens is a sibling of the card. Measured on the
 * real page: after choosing a subject, focus landed on `<body>`, so the first
 * `Tab` hit *Skip to main content* — a keyboard user was returned to the top of
 * the page on a flow whose whole point is labelling several documents in a row.
 *
 * The ordering half of #932 is pinned in `lib/source-list-sort.test.ts`; this is
 * the focus half, driven through the real gesture (right-click, menu item,
 * dialog, choose) because the bug lives in the seam between three overlays and
 * asserting the wiring from source would not have caught it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const listDocuments = vi.fn()
const updateDocument = vi.fn()
const listParticipants = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    // ⚠️ The factory is HOISTED above the `const`s above, so it must not
    // reference a spy directly — it wraps each one in a lambda that resolves at
    // CALL time. Same shape as `DocumentCodingWorkbench.test.tsx`.
    documentsApi: {
      ...actual.documentsApi,
      list: (...a: unknown[]) => listDocuments(...a),
      update: (...a: unknown[]) => updateDocument(...a),
    },
    participantsApi: {
      ...actual.participantsApi,
      list: (...a: unknown[]) => listParticipants(...a),
    },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, openCodebook: vi.fn() }),
}))

import DocumentsListPage from './DocumentsListPage'

/** Two documents sharing ONE `created_at`, which is what a batch import gives. */
const documents = [
  {
    id: 11, name: 'Workplan A', created_at: '2026-09-08 14:40:28',
    segment_count: 4, coded_segment_count: 0, participant_id: null,
    page_count: 1, word_count: 100, extraction_warning: null, source_format: 'docx',
  },
  {
    id: 12, name: 'Workplan B', created_at: '2026-09-08 14:40:28',
    segment_count: 4, coded_segment_count: 0, participant_id: null,
    page_count: 1, word_count: 100, extraction_warning: null, source_format: 'docx',
  },
]

// `participantsApi.list` answers `{ participants: [...] }`, not a bare array.
const participants = {
  participants: [
    { id: 7, identifier: 'E-01', display_name: 'Amara Okafor', role: null },
  ],
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DocumentsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const card = (id: number) =>
  document.querySelector<HTMLElement>(`[data-document-card="${id}"]`)

beforeEach(() => {
  listDocuments.mockResolvedValue(documents)
  listParticipants.mockResolvedValue(participants)
  updateDocument.mockResolvedValue({ ...documents[1], participant_id: 7 })
  // The refetch that follows the mutation returns the UPDATED row, as a server
  // would. ⚠️ Without this the payload is deeply equal to the previous one and
  // React Query hands back the SAME array reference — which is how the first
  // version of the fix was caught depending on the list re-rendering.
  listDocuments
    .mockResolvedValueOnce(documents)
    .mockResolvedValue([documents[0], { ...documents[1], participant_id: 7 }])
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('setting a document subject', () => {
  it('🔴 returns focus to the card it was opened from', async () => {
    renderPage()
    await screen.findByText('Workplan B')

    // The real gesture: right-click the card, choose the menu item.
    fireEvent.contextMenu(card(12)!)
    fireEvent.click(await screen.findByText('Set subject…'))

    // ...then pick a participant in the dialog.
    fireEvent.click(await screen.findByText('Amara Okafor'))

    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith(
      1, 12, { participant_id: 7 },
    ))
    await waitFor(() => expect(document.activeElement).toBe(card(12)))
  })

  it('does not steal focus to a DIFFERENT card', async () => {
    // The restore is by identity. A positional one lands on whichever document
    // now occupies that slot, which is exactly what the reorder used to do.
    renderPage()
    await screen.findByText('Workplan B')

    fireEvent.contextMenu(card(12)!)
    fireEvent.click(await screen.findByText('Set subject…'))
    fireEvent.click(await screen.findByText('Amara Okafor'))

    await waitFor(() => expect(document.activeElement).toBe(card(12)))
    expect(document.activeElement).not.toBe(card(11))
    expect(document.activeElement).not.toBe(document.body)
  })
})
