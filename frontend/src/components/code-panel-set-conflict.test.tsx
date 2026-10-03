/**
 * #1028 — a multi-code apply of two values of ONE code set is refused, with the
 * set's name, at the one door every multi-code apply comes through.
 *
 * Each selected code goes out as its own request and the server keeps whichever
 * lands last (it holds a passage to one value per set since #1028), so applying
 * "Positive" and "Negative" together would record one of them with nothing in
 * the gesture saying which the researcher meant.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Code, CodeSet, CodeSetMember } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'

const listSets = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), reorderInCategory: vi.fn() },
    categoriesApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
    projectsApi: { get: vi.fn().mockResolvedValue({ id: 1, codebook_frozen_at: null }), setCodebookFreeze: vi.fn() },
    codeSetsApi: { list: (...a: unknown[]) => listSets(...a) },
  }
})
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }))

import CodePanel from './CodePanel'

afterEach(cleanup)
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })

const code = (id: number, name: string): Code => ({
  id, project_id: 1, numeric_id: id, name, description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
})
// List order: Positive, Negative, Policy — so Shift+Down from the top selects
// two values of the set, and from the second row one value and an ordinary code.
const CODES = [code(21, 'Positive'), code(22, 'Negative'), code(30, 'Policy')]
const READY: ListLoad = { status: 'ready', error: null, retry: vi.fn(), retrying: false }
const member = (id: number, name: string): CodeSetMember => ({
  id, numeric_id: id, name, description: null, color: null, is_active: true, is_universal: false,
})
const STANCE: CodeSet = {
  id: 7, project_id: 1, label: 'Stance', description: null, exhaustive: false,
  members: [member(21, 'Positive'), member(22, 'Negative')],
  set_basis: 'inclusive_with_none', composition_warnings: [], created_at: '', updated_at: '',
  claimants: [21, 22].map((id) => ({ code_id: id, value_id: id })),
}

beforeEach(() => {
  vi.clearAllMocks()
  listSets.mockResolvedValue({ sets: [STANCE], total: 1 })
})

async function renderPanel() {
  const onMultiCodeToggle = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CodePanel
          codes={CODES} codesLoad={READY} projectId={1} selectedCodesMap={new Map()}
          onCodeToggle={vi.fn()} onMultiCodeToggle={onMultiCodeToggle} onCreateCode={vi.fn()}
          disabled={false} isFocused
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(listSets).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 0))
  const container = screen.getByText('Positive').closest('[tabindex="0"]')!
  return { container, onMultiCodeToggle }
}

describe('a multi-code apply (Shift+Arrow, then Enter)', () => {
  it('two values of one set are REFUSED, naming the set and both values', async () => {
    const { container, onMultiCodeToggle } = await renderPanel()
    fireEvent.keyDown(container, { key: 'ArrowDown' })
    fireEvent.keyDown(container, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(onMultiCodeToggle).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      '“Positive” and “Negative” are values of “Stance”, and a passage takes only one — apply one of them.',
    )
  })

  it('POSITIVE CONTROL — one value and an ordinary code go through', async () => {
    const { container, onMultiCodeToggle } = await renderPanel()
    fireEvent.keyDown(container, { key: 'ArrowDown' })
    fireEvent.keyDown(container, { key: 'ArrowDown' })
    fireEvent.keyDown(container, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(onMultiCodeToggle).toHaveBeenCalledWith([CODES[1], CODES[2]])
    expect(toastError).not.toHaveBeenCalled()
  })
})
