/**
 * #961 — no surface may offer to CREATE a code against a code list that has not
 * answered.
 *
 * **The defect.** Every surface that creates a code by typing a name decides
 * "does this name already exist?" by searching its `codes` prop — and every
 * page passed `data?.codes ?? []`, which is EMPTY before the list answers. So
 * for as long as the list took (6–19 s on a large project), typing an existing
 * code's name offered to create it, and Enter did. The codebook panel showed
 * "No codes yet. Add your first code below." beside the box while doing it.
 *
 * ⚠️ **This paragraph used to end "— the server does not refuse a duplicate
 * name". Since #963 it DOES** (`routers/codes.py::_refuse_duplicate_code_name`).
 * These cases are unchanged and still worth running: a surface that offers an
 * act against an unanswered list is wrong whether or not the server catches the
 * result, and the CATEGORY half of this file has no server backstop at all.
 *
 * **Why one file.** This is a POPULATION, enumerated by what the surface DOES
 * (create a code from a typed name), not by the one the issue named — the
 * #771/#785 lesson that a rule fixed per surface ships partially. Each surface
 * is checked in all three states, and the `ready` case is the positive control:
 * a guard that passes by making creation impossible would pass every negative
 * assertion here.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'
import type { Code } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'
import { ApiError } from '@/lib/api/client'

const listCodes = vi.fn()
const createCode = vi.fn()
const listCategories = vi.fn()
const createCategory = vi.fn()
const getProject = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codesApi: { list: (...a: unknown[]) => listCodes(...a), create: (...a: unknown[]) => createCode(...a), update: vi.fn(), reorderInCategory: vi.fn() },
    categoriesApi: { list: (...a: unknown[]) => listCategories(...a), create: (...a: unknown[]) => createCategory(...a), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
    projectsApi: { get: (...a: unknown[]) => getProject(...a), setCodebookFreeze: vi.fn() },
    codingApi: { applyCode: vi.fn(), removeCode: vi.fn() },
    textCodingApi: { applyCode: vi.fn(), removeCode: vi.fn() },
  }
})

import TextCodePanel from './TextCodePanel'
import CodePanel from './CodePanel'
import InlineCodeActions from './qualitative-analysis/InlineCodeActions'
import CodebookSlideOut from './CodebookSlideOut'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  getProject.mockResolvedValue({ id: 1, name: 'P', codebook_frozen_at: null })
  createCode.mockResolvedValue({ id: 99, name: 'x' })
})

const code = (id: number, name: string): Code => ({
  id, project_id: 1, numeric_id: id + 1, name, description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
})
const EXISTING = [code(10, 'Pacing'), code(11, 'Enthusiasm')]

const loadOf = (status: ListLoad['status'], over: Partial<ListLoad> = {}): ListLoad => ({
  status, error: status === 'failed' ? new ApiError(500, { detail: 'Internal Server Error' }, {}) : null,
  retry: vi.fn(), retrying: false, ...over,
})

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

// ── TextCodePanel (the Text Coding view) ─────────────────────────────────────

function renderTextPanel(codes: Code[], codesLoad: ListLoad, onCreateCode = vi.fn()) {
  wrap(
    <TextCodePanel
      codes={codes} codesLoad={codesLoad} categories={[]} projectId={1}
      appliedCodeIds={[]} onToggleCode={vi.fn()} onCreateCode={onCreateCode}
      selectedCount={1} isFocused={false} onFocusChange={vi.fn()}
    />,
  )
  return onCreateCode
}

describe('TextCodePanel', () => {
  it('while the list loads: says so, never "No codes yet", and Enter creates nothing', () => {
    const onCreate = renderTextPanel([], loadOf('loading'))
    expect(screen.getByRole('status')).toHaveTextContent('Loading codes…')
    expect(screen.queryByText('No codes yet')).not.toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'Search or add codes' })
    type(input, 'Pacing')
    expect(screen.getByRole('button', { name: 'Add code' })).toBeDisabled()
    expect(screen.queryByText(/to create/)).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    // Tab is ordinary focus movement while nothing can be created.
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
  })

  it('when the list failed: says the load failed, with a Retry', () => {
    const l = loadOf('failed')
    renderTextPanel([], l)
    expect(screen.getByRole('alert')).toHaveTextContent('Codes could not be loaded.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(l.retry).toHaveBeenCalled()
  })

  it('once answered: a new name creates, an existing one does not (positive control)', () => {
    const onCreate = renderTextPanel(EXISTING, loadOf('ready'))
    const input = screen.getByRole('textbox', { name: 'Search or add codes' })

    type(input, 'pacing')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()

    type(input, 'Fidelity')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('Fidelity')
  })

  it('an answered EMPTY list says "No codes yet" — the true claim survives', () => {
    renderTextPanel([], loadOf('ready'))
    expect(screen.getByText('No codes yet')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

// ── CodePanel (conversation, document and observation workbenches) ──────────

function renderCodePanel(codes: Code[], codesLoad: ListLoad, onCreateCode = vi.fn()) {
  wrap(
    <CodePanel
      codes={codes} codesLoad={codesLoad} projectId={1} selectedCodesMap={new Map()}
      onCodeToggle={vi.fn()} onCreateCode={onCreateCode} disabled={false}
    />,
  )
  return onCreateCode
}

describe('CodePanel', () => {
  it('while the list loads: says so, never "No codes yet", and Enter creates nothing', () => {
    const onCreate = renderCodePanel([], loadOf('loading'))
    expect(screen.getByRole('status')).toHaveTextContent('Loading codes…')
    expect(screen.queryByText(/No codes yet/)).not.toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'Search or add codes' })
    type(input, 'Pacing')
    expect(screen.getByRole('button', { name: 'Add code' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
  })

  it('when the list failed: says the load failed, with a Retry', () => {
    const l = loadOf('failed')
    renderCodePanel([], l)
    expect(screen.getByRole('alert')).toHaveTextContent('Codes could not be loaded.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(l.retry).toHaveBeenCalled()
  })

  it('once answered: a new name creates, an existing one does not (positive control)', () => {
    const onCreate = renderCodePanel(EXISTING, loadOf('ready'))
    const input = screen.getByRole('textbox', { name: 'Search or add codes' })

    type(input, 'Pacing')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()

    type(input, 'Fidelity')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('Fidelity')
  })

  it('a search that matches nothing is not an empty codebook', () => {
    renderCodePanel(EXISTING, loadOf('ready'))
    type(screen.getByRole('textbox', { name: 'Search or add codes' }), 'zzz')
    expect(screen.getByText('No matching codes.')).toBeInTheDocument()
    expect(screen.queryByText(/No codes yet/)).not.toBeInTheDocument()
  })

  it('an answered EMPTY codebook still says "No codes yet"', () => {
    renderCodePanel([], loadOf('ready'))
    expect(screen.getByText('No codes yet. Create one above.')).toBeInTheDocument()
  })
})

// ── InlineCodeActions (the row "+ Add code" popover) ─────────────────────────

function renderInline(allCodes: Code[], codesStatus: ListLoad['status']) {
  wrap(
    <InlineCodeActions
      projectId={1} itemType="segment" itemId={5} appliedCodeIds={[]}
      codeMap={new Map(allCodes.map(c => [c.id, c]))} allCodes={allCodes}
      codesStatus={codesStatus} onCodeChange={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add code' }))
  return screen.getByPlaceholderText('Search or create code…')
}

describe('InlineCodeActions', () => {
  it('while the list loads: no "Create" row for a name, and Enter creates nothing', async () => {
    const input = renderInline([], 'loading')
    type(input, 'Pacing')
    const popover = screen.getByRole('dialog', { name: 'Add a code' })
    expect(within(popover).queryByText(/Create/)).not.toBeInTheDocument()
    expect(within(popover).getByRole('status')).toHaveTextContent('Loading codes…')
    fireEvent.keyDown(input, { key: 'Enter' })
    await Promise.resolve()
    expect(createCode).not.toHaveBeenCalled()
  })

  it('when the list failed: says so instead of "No codes found"', () => {
    renderInline([], 'failed')
    const popover = screen.getByRole('dialog', { name: 'Add a code' })
    expect(within(popover).getByRole('status')).toHaveTextContent('Codes could not be loaded.')
    expect(within(popover).queryByText('No codes found')).not.toBeInTheDocument()
  })

  it('once answered — even EMPTY — a new name gets its Create row (positive control)', async () => {
    const input = renderInline([], 'ready')
    type(input, 'Fidelity')
    const create = within(screen.getByRole('dialog', { name: 'Add a code' })).getByRole('button', { name: /Create “Fidelity”/ })
    fireEvent.click(create)
    await waitFor(() => expect(createCode).toHaveBeenCalledWith(1, { name: 'Fidelity' }))
  })
})

// ── CodebookSlideOut (the codebook panel the issue named) ───────────────────

function renderSlideOut() {
  wrap(<CodebookSlideOut projectId={1} onClose={vi.fn()} />)
}

describe('CodebookSlideOut', () => {
  it('while the codebook loads: no count, no "No codes yet", and nothing can be created', async () => {
    listCodes.mockReturnValue(new Promise(() => {}))
    // A category that ANSWERS first — the usual order, and the case a fixture
    // with no categories missed: the panel lists empty categories on purpose, so
    // each one rendered "0 · Drop codes here" while the codes were outstanding.
    // Found by driving the panel live, not by this file's first draft.
    listCategories.mockResolvedValue({ categories: [
      { id: 91, project_id: 1, name: 'Implementation', color: null, display_order: 0, parent_id: null },
    ] })
    renderSlideOut()

    // By its text: dnd-kit mounts its own `role="status"` announcer in this panel.
    expect((await screen.findByText('Loading codes…')).closest('[role="status"]')).not.toBeNull()
    // The categories HAVE answered (the new-code form's category picker lists it)…
    expect(await screen.findByRole('option', { name: 'Implementation' })).toBeInTheDocument()
    // …and still no category section claims to hold nothing.
    expect(screen.queryByRole('button', { name: /category Implementation/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Drop codes here/)).not.toBeInTheDocument()
    expect(screen.queryByText(/0 codes/)).not.toBeInTheDocument()
    expect(screen.queryByText(/No codes yet/)).not.toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'New code name' })
    type(input, 'Pacing')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'New Category' })).toBeDisabled()
    await Promise.resolve()
    expect(createCode).not.toHaveBeenCalled()
  })

  it('when the codebook failed: says the load failed, with a Retry that asks again', async () => {
    listCodes.mockRejectedValueOnce(new ApiError(500, { detail: 'Internal Server Error' }, {}))
    listCategories.mockResolvedValue({ categories: [] })
    renderSlideOut()

    expect(await screen.findByRole('alert')).toHaveTextContent('The codebook could not be loaded.')
    listCodes.mockResolvedValueOnce({ codes: EXISTING, total: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('2 codes')).toBeInTheDocument()
    expect(listCodes).toHaveBeenCalledTimes(2)
  })

  it('once answered: refuses an existing name (any case) and SAYS so; a new one creates', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: 2 })
    listCategories.mockResolvedValue({ categories: [] })
    renderSlideOut()
    expect(await screen.findByText('2 codes')).toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'New code name' })
    type(input, 'pacing')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    expect(input).toHaveAccessibleDescription('A code named “pacing” already exists.')
    fireEvent.keyDown(input, { key: 'Enter' })
    await Promise.resolve()
    expect(createCode).not.toHaveBeenCalled()

    type(input, 'Fidelity')
    expect(input).not.toHaveAttribute('aria-invalid')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createCode).toHaveBeenCalledWith(1, { name: 'Fidelity' }))
  })

  it('an answered EMPTY codebook still invites the first code', async () => {
    listCodes.mockResolvedValue({ codes: [], total: 0 })
    listCategories.mockResolvedValue({ categories: [] })
    renderSlideOut()
    expect(await screen.findByText('No codes yet. Add your first code below.')).toBeInTheDocument()
    expect(screen.getByText('0 codes')).toBeInTheDocument()
  })
})
