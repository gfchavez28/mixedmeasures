import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CodeSetsPanel } from '@/components/codebook/CodeSetsPanel'

const listSets = vi.fn()
const listCodes = vi.fn()
const createSet = vi.fn()

vi.mock('@/lib/api', () => ({
  codeSetsApi: {
    list: (...a: unknown[]) => listSets(...a),
    create: (...a: unknown[]) => createSet(...a),
    update: vi.fn(),
    remove: vi.fn(),
    addCodes: vi.fn(),
    removeCodes: vi.fn(),
  },
  codesApi: { list: (...a: unknown[]) => listCodes(...a) },
  serverDetailMessage: () => null,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// Radix's Checkbox measures itself; jsdom has no ResizeObserver (the same stub
// `QualitativeAnalysisView.load-state.test.tsx` carries, for the same reason).
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => { vi.stubGlobal('ResizeObserver', NoopResizeObserver) })

afterEach(() => { cleanup(); vi.clearAllMocks() })

const SET = {
  id: 7, project_id: 1, label: 'Stance', description: null, exhaustive: false,
  members: [
    { id: 11, numeric_id: 11, name: 'Positive', description: null, color: null, is_active: true, is_universal: false },
    { id: 23, numeric_id: 23, name: 'Negative', description: null, color: null, is_active: true, is_universal: false },
  ],
  set_basis: 'inclusive_with_none', composition_warnings: [],
  created_at: '', updated_at: '',
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CodeSetsPanel projectId={1} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('while the lists are unanswered', () => {
  it('says it is loading, and STOPS saying it once they answer', async () => {
    // 🔴 The defect this file exists for: `LoadState` never returns null, so a
    // panel that renders it unconditionally shows "Loading…" forever. The
    // positive control is the second half — a test that only asserted the
    // loading line would pass against exactly that bug.
    let resolveSets: (v: unknown) => void = () => {}
    listSets.mockReturnValue(new Promise((r) => { resolveSets = r }))
    listCodes.mockResolvedValue({ codes: [] })
    renderPanel()

    expect(await screen.findByText(/loading code sets/i)).toBeInTheDocument()
    resolveSets({ sets: [SET], total: 1 })
    await waitFor(() => {
      expect(screen.queryByText(/loading code sets/i)).not.toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: 'Stance' })).toBeInTheDocument()
  })

  it('offers no create affordance and claims no emptiness', async () => {
    listSets.mockReturnValue(new Promise(() => {}))
    listCodes.mockReturnValue(new Promise(() => {}))
    renderPanel()
    await screen.findByText(/loading code sets/i)
    // "No code sets yet" from an unanswered list is a false claim (#961), and a
    // Create button against one is an act that depends on it.
    expect(screen.queryByText(/no code sets yet/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
  })

  it('says so when a list FAILS, rather than reading as empty', async () => {
    listSets.mockRejectedValue(new Error('boom'))
    listCodes.mockResolvedValue({ codes: [] })
    renderPanel()
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByText(/no code sets yet/i)).not.toBeInTheDocument()
  })
})

describe('once answered', () => {
  it('states the CONSEQUENCE of exhaustiveness, not just the setting', async () => {
    listSets.mockResolvedValue({ sets: [SET], total: 1 })
    listCodes.mockResolvedValue({ codes: [] })
    renderPanel()
    // The basis sentence comes from the shared vocabulary — the same words the
    // reliability table states — so a reader meets one account of it.
    expect(await screen.findByText(/counts as the real answer/i)).toBeInTheDocument()
  })

  it('warns that a one-value set cannot be measured', async () => {
    listSets.mockResolvedValue({
      sets: [{ ...SET, members: [SET.members[0]] }], total: 1,
    })
    listCodes.mockResolvedValue({ codes: [] })
    renderPanel()
    expect(
      await screen.findByText(/needs at least two values/i),
    ).toBeInTheDocument()
  })

  it('surfaces a composition warning verbatim', async () => {
    listSets.mockResolvedValue({
      sets: [{ ...SET, composition_warnings: ['“Neg” is grouped with “Raw”.'] }],
      total: 1,
    })
    listCodes.mockResolvedValue({ codes: [] })
    renderPanel()
    expect(await screen.findByText(/“Neg” is grouped with “Raw”\./)).toBeInTheDocument()
  })

  // ── #997 — no two controls in this panel share an accessible name ──────────
  //
  // ⚠️ The DEFECT was measured in Chrome's accessibility tree and the FIX was
  // re-measured there. jsdom can see the names, which is why this guard exists;
  // it cannot see whether a reader ANNOUNCES the group on entry, which is the
  // stated residual (no screen-reader passes — `frontend-a11y.md`).
  describe('#997 — every control names what it acts on', () => {
    const SECOND = { ...SET, id: 9, label: 'Tone', members: SET.members }

    async function renderTwoSets() {
      listSets.mockResolvedValue({ sets: [SET, SECOND], total: 2 })
      listCodes.mockResolvedValue({ codes: [{ id: 31, name: 'Mixed', is_active: true, is_universal: false }] })
      renderPanel()
      await screen.findByRole('group', { name: 'Stance' })
    }

    it('gives NO two controls the same name — the whole panel, not a list of the known ones', async () => {
      // A POPULATION assertion: the per-control form is what let this ship with
      // two of four controls in one block already following the rule (#771/#785).
      await renderTwoSets()
      fireEvent.click(screen.getByRole('button', { name: 'Add a value to Stance' }))
      // The picker's own rows were a FIFTH instance the entry did not name —
      // enumerated by what the control DOES (every control inside a set's
      // block), not by the list the finding happened to carry. A bare code name
      // is unique, so the population check below cannot see this one.
      expect(screen.getByRole('button', { name: 'Add Mixed to Stance' })).toBeInTheDocument()
      const names = screen.getAllByRole('button')
        .concat(screen.getAllByRole('checkbox'))
        .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '')
        .filter(Boolean)
      expect(names.length).toBeGreaterThan(8)
      const dupes = names.filter((n, i) => names.indexOf(n) !== i)
      expect(dupes, `these names are shared by more than one control: ${dupes}`).toEqual([])
    })

    it('names each set a GROUP, because a heading says nothing to someone tabbing', async () => {
      await renderTwoSets()
      expect(screen.getByRole('group', { name: 'Stance' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Tone' })).toBeInTheDocument()
    })

    it('the exhaustiveness name CONTAINS its visible words (WCAG 2.5.3)', async () => {
      // An `aria-label` REPLACES the visible label (#907), so the two must not
      // drift — which is why the sentence is one constant.
      await renderTwoSets()
      const visible = 'Every passage must take one of these values'
      for (const owner of ['Stance', 'Tone', 'new code set']) {
        const box = screen.getByRole('checkbox', { name: `${visible} — ${owner}` })
        expect(box).toBeInTheDocument()
      }
      expect(screen.getAllByText(visible).length).toBe(3)
    })
  })

  it('creates a set from the typed label', async () => {
    listSets.mockResolvedValue({ sets: [], total: 0 })
    listCodes.mockResolvedValue({ codes: [] })
    createSet.mockResolvedValue(SET)
    renderPanel()
    const field = await screen.findByLabelText('New code set')
    fireEvent.change(field, { target: { value: 'Stance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(createSet).toHaveBeenCalledWith(1, { label: 'Stance', exhaustive: false })
    })
  })
})
