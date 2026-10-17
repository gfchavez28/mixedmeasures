/**
 * #1203 — the Codebook page's import has a busy state and refuses a second import
 * while one runs. The toolbar's own behaviour is `CodebookToolbar.import.test.tsx`;
 * this is the page's half: the state that drives `aria-busy`, and the handler's
 * REF guard (its `useCallback` would read a stale state).
 *
 * Harness from `CodebookView.load-state.test.tsx`: the tree stays unanswered, so
 * the SVG tree view never renders.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const importCodebook = vi.fn()
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    codebookApi: { ...actual.codebookApi, tree: () => new Promise(() => {}) },
    conversationsApi: { ...actual.conversationsApi, list: () => Promise.resolve({ conversations: [], total: 0 }) },
    textCodingApi: { ...actual.textCodingApi, columns: () => Promise.resolve({ columns: [] }) },
    projectsApi: { ...actual.projectsApi, get: () => Promise.resolve({ id: 1, name: 'P', codebook_frozen_at: null }) },
    projectPortabilityApi: { ...actual.projectPortabilityApi, importCodebook: (...a: unknown[]) => importCodebook(...a) },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, project: { id: 1, name: 'P', codebook_frozen_at: null } }),
}))

import CodebookView from './CodebookView'

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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/analysis/codebook']}>
        <CodebookView />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  return (f: File) => fireEvent.change(input, { target: { files: [f] } })
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('#1203 — one codebook import at a time', () => {
  it('busy while it runs, a second pick imports nothing, and the button rests again after', async () => {
    let finish!: (v: unknown) => void
    importCodebook.mockReturnValue(new Promise(r => { finish = r }))
    const pick = renderPage()
    const button = screen.getByRole('button', { name: 'Import codebook' })
    pick(new File(['{}'], 'codes.mmcodebook'))
    await flush()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-disabled', 'true')

    pick(new File(['{}'], 'other.mmcodebook'))
    await flush()
    expect(importCodebook).toHaveBeenCalledTimes(1)

    await act(async () => {
      finish({ codes_created: 2, scales_imported: 0, categories_created: 0, codes_skipped: 0, codes_uncategorized: 0 })
    })
    expect(button).not.toHaveAttribute('aria-busy')
    expect(toast.success).toHaveBeenCalledWith('2 codes created')
  })

  it('#1222 — the toast says how many code sets the import created', async () => {
    importCodebook.mockResolvedValue({
      codes_created: 2, scales_imported: 0, categories_created: 0, codes_skipped: 0,
      codes_uncategorized: 0, code_sets_created: 1,
    })
    const pick = renderPage()
    pick(new File(['{}'], 'codes.mmcodebook'))
    await flush()
    expect(toast.success).toHaveBeenCalledWith('2 codes created. 1 code set created')
  })

  it('a refused import rests the button too', async () => {
    importCodebook.mockRejectedValue(new Error('nope'))
    const pick = renderPage()
    pick(new File(['{}'], 'codes.qdc'))
    await flush()
    expect(screen.getByRole('button', { name: 'Import codebook' })).not.toHaveAttribute('aria-busy')
    // Held as long as the toolbar's own refusal: the server's says the same two sentences.
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), { duration: 10_000 })
  })
})
