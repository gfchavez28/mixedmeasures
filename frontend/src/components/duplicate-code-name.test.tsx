/**
 * #963's last item — the three create surfaces that refused NO duplicate code
 * name, even with the code list answered.
 *
 * **The population was enumerated by what the surface DOES** (create a code from a
 * typed name) rather than from the entry's list — and this time the entry was
 * RIGHT. A sweep of `codesApi.create`'s callers found NINE; six already checked,
 * and the three that did not were these two plus `codebook/CreateCodeDialog.tsx`,
 * which turned out to have had **no importer since `c215d8ca` replaced the modal
 * dialogs with panels**. It and its orphaned sibling `CreateCategoryDialog` were
 * deleted rather than fixed. ⚠️ **The sweep still paid** — not by widening the
 * list, but by finding two dead components, one of which had drawn maintenance as
 * recently as #911b. *A sweep that confirms the filed list is not a wasted sweep.*
 *
 * **What is asserted here is the AFFORDANCE, not the guarantee.** The guarantee is
 * `routers/codes.py::_refuse_duplicate_code_name` (see
 * `backend/tests/test_code_name_uniqueness.py`), which is why these surfaces do
 * NOT block while the list is unanswered — the last describe block pins that
 * deliberately, because it is the thing a later "make this consistent with
 * CodebookSlideOut" edit would change.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'
import type { Code, CodebookTreeResponse } from '@/lib/api'

const listCodes = vi.fn()
const createCode = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codesApi: { list: (...a: unknown[]) => listCodes(...a), create: (...a: unknown[]) => createCode(...a), update: vi.fn() },
    categoriesApi: { list: vi.fn(), create: vi.fn() },
  }
})

import CreateCodePanel from './codebook/CreateCodePanel'
import FloatingCreateCode from './FloatingCreateCode'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  createCode.mockResolvedValue({ id: 99, name: 'Created' })
})

const code = (id: number, name: string, over: Partial<Code> = {}): Code => ({
  id, project_id: 1, numeric_id: id + 1, name, description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null,
  category_order: null, ...over,
})

const EXISTING = [code(10, 'Pacing'), code(11, 'Enthusiasm'), code(12, 'Retired', { is_active: false })]

const EMPTY_TREE: CodebookTreeResponse = {
  universal_codes: [], tree: [], uncategorized_codes: [],
}

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

const type = (input: HTMLElement, value: string) =>
  fireEvent.change(input, { target: { value } })

/** The three surfaces, each rendered with its own props, keyed by name. */
const SURFACES: { name: string; render: () => void; nameField: string | RegExp }[] = [
  {
    name: 'CreateCodePanel',
    nameField: 'Code name...',
    render: () => wrap(
      <CreateCodePanel projectId={1} treeData={EMPTY_TREE} onClose={vi.fn()} />,
    ),
  },
  {
    name: 'FloatingCreateCode',
    nameField: 'Code name',
    render: () => wrap(
      <FloatingCreateCode
        position={{ x: 10, y: 10 }} projectId={1} categories={[]}
        categoriesLoad={{ status: 'ready', error: null, retry: vi.fn(), retrying: false }}
        onCreated={vi.fn()} onClose={vi.fn()}
      />,
    ),
  },
]

function nameInput(placeholder: string | RegExp) {
  return screen.getByPlaceholderText(placeholder)
}

describe.each(SURFACES)('$name', ({ render: renderSurface, nameField }) => {
  it('refuses a duplicate name once the code list has answered', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: EXISTING.length })
    renderSurface()

    const input = await waitFor(() => nameInput(nameField))
    await waitFor(() => expect(listCodes).toHaveBeenCalled())

    type(input, 'Pacing')

    await waitFor(() =>
      expect(screen.getByText(/A code named .*Pacing.* already exists/)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    // ⚠️ The button's native `disabled` does NOT cover this path — Enter in the
    // name field calls the submit handler directly — so the handler needs its own
    // guard and this is what holds it.
    //
    // ⚠️ **And the assertion must be AWAITED.** `mutate()` reaches its
    // `mutationFn` in a microtask, so a synchronous `not.toHaveBeenCalled()` here
    // passes whether or not the mutation fired: measured — with the handler's
    // guard removed, the synchronous form survived the mutant and this form kills
    // it. (#770's rule: a negative assertion carries the burden of proving it
    // COULD fail.)
    fireEvent.keyDown(input, { key: 'Enter' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(createCode).not.toHaveBeenCalled()
  })

  it('is case- and whitespace-insensitive, like the server', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: EXISTING.length })
    renderSurface()
    const input = await waitFor(() => nameInput(nameField))
    await waitFor(() => expect(listCodes).toHaveBeenCalled())

    type(input, '  pAcInG  ')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(),
    )
  })

  it('counts an INACTIVE code — deactivating does not release the name', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: EXISTING.length })
    renderSurface()
    const input = await waitFor(() => nameInput(nameField))
    await waitFor(() => expect(listCodes).toHaveBeenCalled())

    type(input, 'Retired')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(),
    )
  })

  it('asks for the list INCLUDING inactive codes', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: EXISTING.length })
    renderSurface()
    await waitFor(() => expect(listCodes).toHaveBeenCalledWith(1, true))
  })

  // The POSITIVE CONTROL: a guard that passes by making creation impossible would
  // pass every negative assertion above.
  it('creates a name that is NOT taken', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: EXISTING.length })
    renderSurface()
    const input = await waitFor(() => nameInput(nameField))
    await waitFor(() => expect(listCodes).toHaveBeenCalled())

    type(input, 'Scaffolding')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled(),
    )
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createCode).toHaveBeenCalled())
  })

  it('says nothing, and blocks nothing, while the list is unanswered', async () => {
    // DELIBERATE (see the file docstring): the hint is advisory and the server is
    // the guard, so an unanswered list must not withhold the act the researcher
    // opened this surface to perform. What it must not do is CLAIM anything.
    listCodes.mockReturnValue(new Promise(() => {}))   // never resolves
    renderSurface()
    const input = await waitFor(() => nameInput(nameField))

    type(input, 'Pacing')

    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled(),
    )
  })

  it('says nothing, and blocks nothing, after the list FAILED', async () => {
    listCodes.mockRejectedValue(new Error('network'))
    renderSurface()
    const input = await waitFor(() => nameInput(nameField))
    await waitFor(() => expect(listCodes).toHaveBeenCalled())

    type(input, 'Pacing')

    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled(),
    )
  })

  it('names the field invalid and points at the reason', async () => {
    listCodes.mockResolvedValue({ codes: EXISTING, total: EXISTING.length })
    renderSurface()
    const input = await waitFor(() => nameInput(nameField))
    await waitFor(() => expect(listCodes).toHaveBeenCalled())

    type(input, 'Pacing')

    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'))
    // The sentence must be the field's DESCRIPTION, not merely nearby text —
    // #911's channel: a reader meets the reason with the control.
    expect(input).toHaveAccessibleDescription(/already exists/)
  })
})

describe('the population this closes', () => {
  it('covers every LIVE create surface that had no check', () => {
    // Derived by sweeping `codesApi.create`'s callers, minus the six that already
    // checked (CodePanel, TextCodePanel, CodebookSlideOut, InlineCodeActions, and
    // the two workbench mutations behind the panels) and minus the one that was
    // dead code. A new unchecked surface should fail this until it is added here.
    expect(SURFACES.map(s => s.name).sort()).toEqual([
      'CreateCodePanel', 'FloatingCreateCode',
    ])
  })

  it('the two orphaned modal dialogs are gone, not merely unused', () => {
    // They had no importer since `c215d8ca` and were still being maintained
    // (#911b edited one of them). Deleted here; this asserts they do not come
    // back as dead files, since nothing else would notice.
    //
    // ⚠️ Asserted on DISK, not with `import()`: a static import of a deleted
    // module is a tsc error, so the obvious form of this test cannot compile.
    const dir = dirname(fileURLToPath(import.meta.url))
    const live = join(dir, 'codebook', 'CreateCodePanel.tsx')
    expect(existsSync(live)).toBe(true)   // the path is right (self-check)
    expect(existsSync(join(dir, 'codebook', 'CreateCodeDialog.tsx'))).toBe(false)
    expect(existsSync(join(dir, 'codebook', 'CreateCategoryDialog.tsx'))).toBe(false)
  })
})
