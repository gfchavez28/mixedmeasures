/**
 * #515 — the all-notes response's `documents` group must actually render.
 * The backend has always returned it (all_notes.py) and the type declared it,
 * but the panel consumed only conversations + texts, so document notes were
 * invisible on the Memos & Notes page.
 */
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const list = vi.fn()
vi.mock('@/lib/api', () => ({
  allNotesApi: { list: (...a: unknown[]) => list(...a) },
}))
vi.mock('@/lib/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}))

import AllNotesPanel from './AllNotesPanel'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const DOC_NOTE = {
  id: 41,
  content: 'Check the fidelity rubric wording',
  sequence_number: 3,
  segment_id: 12,
  segment_text: 'Teachers receive 24 hours of training',
  created_at: '2026-07-01T10:00:00+00:00',
}

const RESPONSE = {
  conversations: [
    {
      conversation_id: 5,
      conversation_name: 'PI – Jefferson',
      general_notes: [{
        id: 7, content: 'Follow up on pacing', sequence_number: 1,
        segment_id: null, segment_text: null, created_at: '2026-07-01T09:00:00+00:00',
      }],
      speakers: [],
    },
  ],
  texts: [],
  documents: [
    { document_id: 2, document_name: 'Implementation Guide', notes: [DOC_NOTE] },
  ],
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AllNotesPanel projectId={1} />
    </QueryClientProvider>,
  )
}

it('renders the documents group with its notes and count', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()

  const docGroup = await screen.findByRole('button', { name: /Implementation Guide/ })
  expect(docGroup).toHaveTextContent('1 note')
  docGroup.click()
  await screen.findByText('Check the fidelity rubric wording')
  // Total count includes the document note (1 conversation + 1 document).
  expect(screen.getByText('2')).toBeInTheDocument()
})

it('offers a Documents source filter that isolates document notes', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()
  await screen.findByRole('button', { name: /Implementation Guide/ })

  const docsFilter = screen.getByRole('button', { name: 'Documents' })
  docsFilter.click()
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /PI – Jefferson/ })).toBeNull()
  })
  expect(screen.getByRole('button', { name: /Implementation Guide/ })).toBeInTheDocument()

  // Conversations filter hides the document group again.
  screen.getByRole('button', { name: 'Conversations' }).click()
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /Implementation Guide/ })).toBeNull()
  })
  expect(screen.getByRole('button', { name: /PI – Jefferson/ })).toBeInTheDocument()
})

it('empty-state copy names documents as a note source', async () => {
  list.mockResolvedValue({ conversations: [], texts: [], documents: [] })
  renderPanel()
  await screen.findByText('No notes yet')
  expect(
    screen.getByText('Notes are created in conversations, documents, and the Text Coding tab'),
  ).toBeInTheDocument()
})
