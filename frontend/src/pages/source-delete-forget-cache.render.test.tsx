/**
 * #1226 — a source delete forgets the cached project pages, rendered on three of
 * the four list pages (the population guard is `source-delete-forget-cache.test.ts`).
 *
 * The fixture is the driven shape: the deleted source's own pages are cached, and
 * the source ids (2, 12, 31, 5) are NOT the project id (1), so a removal keyed on
 * the project would pass by coincidence. The list on screen must survive — the fix
 * is "forget what no page shows", never "forget everything". The QueryClient uses
 * the app's 60 s staleTime, as in `Dashboard.forget-cache.test.tsx`.
 *
 * The TopRail's counts come from `['project', pid]`, which the layout keeps ACTIVE,
 * so the forget leaves it alone: the conversation and dataset deletes never
 * refreshed it, so the count stayed at the old number. The tests hold an observer
 * on it, as the layout does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({
  listDocuments: vi.fn(), removeDocument: vi.fn(),
  listConversations: vi.fn(), deleteConversation: vi.fn(),
  listDatasets: vi.fn(), deleteDataset: vi.fn(),
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    documentsApi: {
      ...actual.documentsApi,
      list: (...a: unknown[]) => api.listDocuments(...a),
      remove: (...a: unknown[]) => api.removeDocument(...a),
    },
    conversationsApi: {
      ...actual.conversationsApi,
      list: (...a: unknown[]) => api.listConversations(...a),
      delete: (...a: unknown[]) => api.deleteConversation(...a),
    },
    datasetsApi: {
      ...actual.datasetsApi,
      list: (...a: unknown[]) => api.listDatasets(...a),
      delete: (...a: unknown[]) => api.deleteDataset(...a),
      // The confirm waits for the removal plan (#1175); this dataset takes nothing else.
      getDatasetRemovalPlan: () => Promise.resolve({
        saved_metrics_removed: [], tests_removed: 0, groups_recalculated: [], groups_removed: [],
        refusal: null, blocked_by: [],
      }),
    },
    domainsApi: { ...actual.domainsApi, list: () => Promise.resolve({ domains: [] }) },
    textCodingApi: { ...actual.textCodingApi, columns: () => Promise.resolve({ columns: [] }) },
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, openCodebook: vi.fn() }),
}))

import DocumentsListPage from './DocumentsListPage'
import ConversationsListPage from './ConversationsListPage'
import DatasetsListPage from './DatasetsListPage'

afterEach(() => { cleanup(); Object.values(api).forEach(f => f.mockReset()) })

/** The TopRail's project query, observed as the layout observes it; the server
 *  now counts one source fewer. */
function observeProject(qc: QueryClient) {
  qc.setQueryData(['project', 1], { id: 1, count: 'before the delete' })
  const observer = new QueryObserver(qc, {
    queryKey: ['project', 1],
    queryFn: () => Promise.resolve({ id: 1, count: 'after the delete' }),
  })
  return observer.subscribe(() => {})
}

function renderPage(page: React.ReactNode, seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } },
  })
  seed(qc)
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  )
  return qc
}

const doc = (id: number, name: string) => ({
  id, name, created_at: '2026-10-15 10:00:00', segment_count: 2, coded_segment_count: 0,
  participant_id: null, page_count: 1, word_count: 10, extraction_warning: null, source_format: 'txt',
})

const conv = (id: number, name: string) => ({
  id, project_id: 1, name, subject_id: null, conversation_date: null, status: 'imported',
  created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z', segment_count: 2,
  coded_segment_count: 0, speaker_count: 2, code_count: 0, media_filename: null, media_format: null,
  media_type: null, media_duration_seconds: null, media_offset_seconds: 0, media_is_vbr: null,
  has_media: false, media_size_bytes: null, media_version: null,
})

describe('#1226 — Documents: deleting the newest document', () => {
  const seed = (qc: QueryClient) => {
    qc.setQueryData(['document', 1, 12], { id: 12, name: 'Document C', segments: [{ text: 'OLD DOCUMENT C' }] })
    qc.setQueryData(['document-notes', 1, 12], [])
    qc.setQueryData(['segments', 31], [{ id: 501, text: 'a conversation page elsewhere' }])
  }

  async function deleteDocument12() {
    fireEvent.contextMenu(document.querySelector('[data-document-card="12"]')!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.removeDocument).toHaveBeenCalledWith(1, 12))
  }

  it('forgets the deleted document’s cached reader, and keeps the list on screen', async () => {
    api.listDocuments.mockResolvedValue([doc(11, 'Filler doc'), doc(12, 'Document C')])
    api.removeDocument.mockResolvedValue(undefined)
    const qc = renderPage(<DocumentsListPage />, seed)
    await screen.findByText('Document C')
    await deleteDocument12()
    await waitFor(() => expect(qc.getQueryData(['document', 1, 12]), 'the deleted reader').toBeUndefined())
    expect(qc.getQueryData(['document-notes', 1, 12])).toBeUndefined()
    expect(qc.getQueryData(['segments', 31]), 'an entity-first key (31 ≠ pid 1)').toBeUndefined()
    expect(qc.getQueryData(['documents', 1]), 'the list on screen is kept').toBeDefined()
  })

  it('a delete with no answer may still have finished — the cache is forgotten too', async () => {
    api.listDocuments.mockResolvedValue([doc(11, 'Filler doc'), doc(12, 'Document C')])
    api.removeDocument.mockRejectedValue(new TypeError('Failed to fetch'))
    const qc = renderPage(<DocumentsListPage />, seed)
    await screen.findByText('Document C')
    await deleteDocument12()
    await waitFor(() => expect(qc.getQueryData(['document', 1, 12])).toBeUndefined())
  })
})

describe('#1226 — Conversations: the driven case', () => {
  it('forgets the deleted interview’s workbench (conversation, segments, notes), and refreshes the TopRail count', async () => {
    api.listConversations.mockResolvedValue({ conversations: [conv(1, 'Filler'), conv(2, 'Interview A')] })
    api.deleteConversation.mockResolvedValue(undefined)
    const qc = renderPage(<ConversationsListPage />, (c) => {
      c.setQueryData(['conversation', 1, 2], conv(2, 'Interview A'))
      c.setQueryData(['segments', 2], [{ id: 2, text: 'OLD TRANSCRIPT A first turn about apples' }])
      c.setQueryData(['notes', 2], [])
    })
    const unsubscribe = observeProject(qc)
    await screen.findByText('Interview A')
    fireEvent.contextMenu(screen.getByText('Interview A'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete Conversation' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith(1, 2))
    await waitFor(() => expect(qc.getQueryData(['segments', 2])).toBeUndefined())
    expect(qc.getQueryData(['conversation', 1, 2])).toBeUndefined()
    expect(qc.getQueryData(['notes', 2])).toBeUndefined()
    expect(qc.getQueryData(['conversations', 1])).toBeDefined()
    await waitFor(() => expect(qc.getQueryData(['project', 1])).toEqual({ id: 1, count: 'after the delete' }))
    unsubscribe()
  })
})

describe('#1226 — Datasets: the other page whose count stayed', () => {
  const dataset = (id: number, name: string) => ({
    id, name, source: 'survey.csv', row_count: 10, column_count: 4, open_ended_count: 0,
    created_at: '2026-10-15T10:00:00Z', color: null, managed_kind: null,
  })

  it('forgets the deleted dataset’s grid, keeps the list, and refreshes the TopRail count', async () => {
    api.listDatasets.mockResolvedValue({ datasets: [dataset(4, 'Survey A'), dataset(5, 'Survey B')] })
    api.deleteDataset.mockResolvedValue(undefined)
    const qc = renderPage(<DatasetsListPage />, (c) => {
      c.setQueryData(['dataset', 1, 5], dataset(5, 'Survey B'))
      c.setQueryData(['dataset-data', 1, 5, 0], { rows: [{ id: 900, values: ['OLD SURVEY B'] }] })
    })
    const unsubscribe = observeProject(qc)
    await screen.findByText('Survey B')
    fireEvent.contextMenu(screen.getByText('Survey B'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete Survey B' }))
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    await waitFor(() => expect(api.deleteDataset).toHaveBeenCalledWith(1, 5))
    await waitFor(() => expect(qc.getQueryData(['dataset-data', 1, 5, 0])).toBeUndefined())
    expect(qc.getQueryData(['dataset', 1, 5])).toBeUndefined()
    expect(qc.getQueryData(['datasets', 1])).toBeDefined()
    await waitFor(() => expect(qc.getQueryData(['project', 1])).toEqual({ id: 1, count: 'after the delete' }))
    unsubscribe()
  })
})
