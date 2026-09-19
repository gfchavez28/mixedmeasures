/**
 * #961 — the Codebook page's status bar does not count a tree it has not got.
 *
 * Measured on a large project (production build): the status bar read "0 codes
 * · 0 categories" for 6–19 s while the tree loaded, and a FAILED tree left a
 * blank centre under those zeros — `isLoading` could say neither "failed" nor,
 * after a failure, anything at all.
 *
 * The first harness to render this page. Every case keeps the tree unanswered,
 * failed, or answered EMPTY, so the SVG tree view never renders.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { ApiError } from '@/lib/api/client'

const tree = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    codebookApi: { ...actual.codebookApi, tree: (...a: unknown[]) => tree(...a) },
    conversationsApi: { ...actual.conversationsApi, list: () => Promise.resolve({ conversations: [], total: 0 }) },
    textCodingApi: { ...actual.textCodingApi, columns: () => Promise.resolve({ columns: [] }) },
    projectsApi: { ...actual.projectsApi, get: () => Promise.resolve({ id: 1, name: 'P', codebook_frozen_at: null }) },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, project: { id: 1, name: 'P', codebook_frozen_at: null } }),
}))

import CodebookView from './CodebookView'

const EMPTY_TREE = { universal_codes: [], tree: [], uncategorized_codes: [] }

/** `retry` mirrors `main.tsx`'s client default when a test is about the retry
 * policy; `retryDelay: 0` so the automatic second ask, if any, happens at once. */
function renderPage({ clientRetry = false as boolean | number } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: clientRetry, retryDelay: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/analysis/codebook']}>
        <CodebookView />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

let store: Record<string, string> = {}

beforeEach(() => {
  store = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    },
  })
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('#961 — the Codebook page counts only an answered tree', () => {
  it('a tree still loading: the skeleton says so to a reader, and the bar counts nothing', async () => {
    tree.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(await screen.findByText('Loading the codebook…')).toBeInTheDocument()
    expect(screen.getByText('Loading the codebook…').closest('[role="status"]')).not.toBeNull()
    expect(screen.getByText('Loading codebook…')).toBeInTheDocument()
    expect(screen.queryByText(/^0 codes/)).not.toBeInTheDocument()
    expect(screen.queryByText('0 categories')).not.toBeInTheDocument()
  })

  it('a FAILED tree says so instead of a blank page under zeros; Retry asks again and lands focus', async () => {
    tree.mockRejectedValueOnce(new ApiError(500, { detail: 'Internal Server Error' }, {}))
    // The app's own client default (`retry: 1`), so the page's `retryUnanswered`
    // is what decides — a server that ANSWERED is not asked again on its own.
    renderPage({ clientRetry: 1 })

    expect(await screen.findByText('The codebook could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText('Codebook not loaded')).toBeInTheDocument()
    expect(screen.queryByText(/^0 codes/)).not.toBeInTheDocument()
    expect(tree).toHaveBeenCalledTimes(1)

    tree.mockResolvedValueOnce(EMPTY_TREE)
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)

    // Answered and empty: now "0 codes" is true, and the empty-state sentence renders.
    const empty = await screen.findByText(/Create codes in conversations or the Text Coding tab/)
    expect(screen.getByText('0 codes')).toBeInTheDocument()
    // ⚠️ `not <body>` is load-bearing: <body> CONTAINS the message too, so the
    // containment check alone passed with the landing deleted (mutant-verified).
    await waitFor(() => {
      const active = document.activeElement as HTMLElement
      expect(active).not.toBe(document.body)
      expect(active.contains(empty)).toBe(true)
    })
  })
})
