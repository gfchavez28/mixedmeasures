/**
 * #1184 — a screen the rail does not list is placed on it, not lost from it.
 *
 * A single-transcript import that returns warnings lands on `results`, which is
 * on the rail only for several files. `findIndex` gave −1 there, so the rail read
 * as NOT STARTED on the screen that says the import finished. The wizard now maps
 * every step; this one sits past the last.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'

const api = vi.hoisted(() => ({
  conversations: { list: vi.fn(), preview: vi.fn(), import: vi.fn() },
  participants: { list: vi.fn() },
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    conversationsApi: { ...actual.conversationsApi, ...api.conversations },
    participantsApi: { ...actual.participantsApi, ...api.participants },
  }
})
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ setBreadcrumbLabel: () => {} }),
}))

import ConversationImport from './ConversationImport'

const preview = {
  headers: ['Speaker', 'Text'],
  sample_rows: [{ Speaker: 'A', Text: 'hello' }],
  total_rows: 1,
  unique_speakers: ['A'],
  detected_columns: { speaker: 'Speaker', text: 'Text' },
  unique_values_by_column: { Speaker: ['A'], Text: ['hello'] },
  overlong_records: { count: 0, header_width: 2, examples: [] },
}

beforeEach(() => {
  api.conversations.list.mockResolvedValue({ conversations: [], total: 0 })
  api.participants.list.mockResolvedValue([])
  api.conversations.preview.mockResolvedValue(preview)
  api.conversations.import.mockResolvedValue({
    conversation: { id: 9, segment_count: 1 },
    warnings: ['One row had no speaker and was skipped.'],
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1184 — the transcript wizard places an off-rail screen', () => {
  it('a single-file import that warns: every rail step is done, none current', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/projects/1/conversations/import']}>
          <Routes><Route path="/projects/:projectId/conversations/import" element={<ConversationImport />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const file = new File(['Speaker,Text\nA,hello\n'], 'a.csv', { type: 'text/csv' })
    fireEvent.change(container.querySelector('#file-input')!, { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }))
    expect(await screen.findByText('One row had no speaker and was skipped.')).toBeInTheDocument()

    const rail = screen.getByRole('navigation', { name: 'Import progress' })
    const items = within(rail).getAllByRole('listitem')
    expect(items.map(li => li.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done'])
    expect(rail.querySelector('[aria-current="step"]')).toBeNull()
  })
})
