/**
 * #1592 — a chip offers *Remove code* only when it is the VIEWER's own application, and the
 * `+ Add code` list marks a code applied only when the viewer applied it.
 *
 * Driven before (name-sweep run 16, scratch install A): with colleagues shown, segment 252 held
 * only test2's *Curriculum fidelity*; its "Remove code Curriculum fidelity", pressed, sent
 * `DELETE /api/segments/252/codes/3` → 200 and removed nothing (the door deletes the CALLER's
 * application only — `routers/coding.py::remove_code`, #879's rule), with no word said; on
 * segment 255, where both coders hold it, the row carried two identical "Remove code
 * Curriculum fidelity" buttons. The add list read the bare per-application ids (any coder's),
 * so a code only a colleague applied showed a check and could not be added — and while blind,
 * that check showed a coding the chips hide.
 *
 * Fixture: the viewer is coder 1 (`ME`), the colleague coder 2. A = both, B = the colleague
 * only, C = an UNATTRIBUTED coding (merged legacy data — no door can remove it). Every case has
 * its positive control: the viewer's own chip keeps its remove, and a single-coder install keeps
 * every remove.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api', () => ({
  codingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  textCodingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  codesApi: { create: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import InlineCodeActions from './InlineCodeActions'
import type { Code } from '@/lib/api'
import type { ChipViewer } from '@/lib/coding-progress'

const ME = 1
const COLLEAGUE = 2
const code = (id: number, name: string) =>
  ({ id, name, color: '#4477aa', is_active: true, is_universal: false, magnitude_scale: null }) as unknown as Code
const A = code(3, 'Curriculum fidelity')
const B = code(4, 'Teacher voice')
const C = code(5, 'Legacy theme')
const CODES = [A, B, C]
const codeMap = new Map(CODES.map(c => [c.id, c]))
const detail = (code_id: number, user_id: number | null) => ({ code_id, user_id, magnitude: null, magnitude_conflict: null })
/** A by both, B by the colleague only, C unattributed. */
const MIXED = [detail(A.id, ME), detail(A.id, COLLEAGUE), detail(B.id, COLLEAGUE), detail(C.id, null)]

afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderActions(over: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InlineCodeActions
        projectId={1}
        itemType="segment"
        itemId={252}
        appliedCodeIds={[A.id, A.id, B.id, C.id]}
        codeMap={codeMap}
        allCodes={CODES}
        codesStatus="ready"
        viewer={{ coderId: ME }}
        onCodeChange={vi.fn()}
        {...over}
      />
    </QueryClientProvider>,
  )
}

const removes = (c: Code) => screen.queryAllByRole('button', { name: `Remove code ${c.name}` })

/** Opens `+ Add code` and returns each code's option button. */
function openAddList() {
  fireEvent.click(screen.getByRole('button', { name: 'Add code' }))
  const list = screen.getByRole('dialog', { name: 'Add a code' })
  return (c: Code) => within(list).getByRole('button', { name: c.name })
}

describe('a chip carries a remove only when it is the viewer’s own application (#1592)', () => {
  it('per-application chips: ONE remove for A (the viewer’s chip), none for B (colleague) or C (unattributed)', () => {
    const onRemoveCode = vi.fn()
    renderActions({ appliedCodeDetails: MIXED, onRemoveCode })
    // Every chip is still drawn — the fix removes a control, never a coding from view.
    expect(screen.getAllByText(A.name)).toHaveLength(2)
    expect(screen.getByText(B.name)).toBeInTheDocument()
    expect(screen.getByText(C.name)).toBeInTheDocument()
    expect(removes(A)).toHaveLength(1)
    expect(removes(B)).toHaveLength(0)
    expect(removes(C)).toHaveLength(0)
    // Positive control: the one remaining remove still acts, through the host.
    fireEvent.click(removes(A)[0])
    expect(onRemoveCode).toHaveBeenCalledWith(A.id)
  })

  it('single-coder install (every application is the viewer’s): every chip keeps its remove', () => {
    renderActions({ appliedCodeIds: [A.id, B.id], appliedCodeDetails: [detail(A.id, ME), detail(B.id, ME)] })
    expect(removes(A)).toHaveLength(1)
    expect(removes(B)).toHaveLength(1)
  })

  it('a viewer not known (`coderId: null`) is offered no remove — the door could only act as nobody', () => {
    renderActions({ appliedCodeDetails: MIXED, viewer: { coderId: null } })
    expect(screen.queryAllByRole('button', { name: /^Remove code/ })).toHaveLength(0)
    expect(screen.getAllByText(A.name)).toHaveLength(2)
  })

  it('distinct-code chips (By Source): the remove follows who applied the code', () => {
    const viewer: ChipViewer = { coderId: ME, applications: MIXED }
    renderActions({ appliedCodeIds: [A.id, B.id, C.id], viewer })
    expect(removes(A)).toHaveLength(1)
    expect(removes(B)).toHaveLength(0)
    expect(removes(C)).toHaveLength(0)
  })

  it('distinct-code chips with no applications given read as not the viewer’s (fail closed)', () => {
    renderActions({ appliedCodeIds: [A.id, B.id] })
    expect(screen.queryAllByRole('button', { name: /^Remove code/ })).toHaveLength(0)
  })
})

describe('the add list marks a code applied only when the viewer applied it (#1592)', () => {
  it('a colleague-only code (B) and an unattributed one (C) can be added; the viewer’s own (A) cannot', () => {
    renderActions({ appliedCodeDetails: MIXED })
    const option = openAddList()
    expect(option(B)).toBeEnabled()
    expect(option(C)).toBeEnabled()
    expect(option(A)).toBeDisabled() // positive control: the viewer's own code is applied
  })

  it('while blind (colleagues hidden), the list shows no check on a code only a colleague applied', () => {
    // The lens hides the colleague's chips; the list must not reveal them either.
    renderActions({ appliedCodeDetails: MIXED, hiddenCoderIds: new Set([COLLEAGUE]) })
    expect(screen.queryByText(B.name)).toBeNull()
    const option = openAddList()
    expect(option(B)).toBeEnabled()
    expect(option(A)).toBeDisabled()
  })

  it('distinct-code chips (By Source): the list follows who applied the code', () => {
    renderActions({ appliedCodeIds: [A.id, B.id, C.id], viewer: { coderId: ME, applications: MIXED } })
    const option = openAddList()
    expect(option(B)).toBeEnabled()
    expect(option(A)).toBeDisabled()
  })
})
