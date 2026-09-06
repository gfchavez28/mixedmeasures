/**
 * #875 — the chip's `×` and its `+ Add code` apply DELEGATE to a host that owns a
 * history stack, and fall back to their own mutations where none exists.
 *
 * The defect this pins was measured at the database level: rate 7 → `×` → press
 * the toast's *Undo* → `magnitude` is NULL. The chip ran its own mutation whose
 * toast-level undo re-applied BARE — #868 (f)'s exact defect in the one removal
 * door that fix did not enumerate, sitting beside doors on the same row that were
 * undoable, so which recovery you got depended on which pixel you clicked.
 *
 * ⚠️ The fallback arm is as load-bearing as the delegating one: four of the seven
 * call sites are analysis surfaces with NO history stack, and for them the toast
 * action is the only recovery there is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InlineCodeActions from './InlineCodeActions'
import type { Code } from '@/lib/api'

const removeCode = vi.fn(() => Promise.resolve({}))
const applyCode = vi.fn(() => Promise.resolve({}))

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  codingApi: {
    removeCode: (...a: unknown[]) => removeCode(...(a as [])),
    applyCode: (...a: unknown[]) => applyCode(...(a as [])),
  },
  textCodingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  codesApi: { create: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const CODE = {
  id: 3, name: 'Curriculum fidelity', color: '#4477aa', is_active: true, is_universal: false,
  magnitude_scale: { min: 0, max: 10, step: 1, anchors: [] },
} as unknown as Code

const codeMap = new Map([[CODE.id, CODE]])

function renderActions(over: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InlineCodeActions
        projectId={1}
        itemType="segment"
        itemId={335}
        appliedCodeIds={[CODE.id]}
        codeMap={codeMap}
        allCodes={[CODE]}
        onCodeChange={vi.fn()}
        appliedCodeDetails={[{ code_id: CODE.id, user_id: 1, magnitude: 7, magnitude_conflict: null }]}
        {...over}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => { removeCode.mockClear(); applyCode.mockClear() })

describe('InlineCodeActions — the host owns the gesture when it can (#875)', () => {
  it('🔴 the × calls the host and does NOT run its own remove mutation', async () => {
    const onRemoveCode = vi.fn()
    renderActions({ onRemoveCode })
    fireEvent.click(screen.getByLabelText(`Remove code ${CODE.name}`))
    expect(onRemoveCode).toHaveBeenCalledWith(CODE.id)
    // The whole point: the bare re-apply never happens, because the host
    // captures the rating and records an undoable entry instead.
    expect(removeCode).not.toHaveBeenCalled()
  })

  it('the × keeps its own mutation where no host owns it — the analysis surfaces', async () => {
    renderActions()
    fireEvent.click(screen.getByLabelText(`Remove code ${CODE.name}`))
    // react-query's mutate() is async; fireEvent does not flush it.
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(335, CODE.id))
  })

  it('the + Add code apply calls the host, so the rating strip can open (#868 e)', async () => {
    const onApplyCode = vi.fn()
    const other = { ...CODE, id: 9, name: 'Pacing adherence' } as Code
    renderActions({
      onApplyCode,
      allCodes: [CODE, other],
      codeMap: new Map([[CODE.id, CODE], [other.id, other]]),
    })
    const trigger = screen.getByLabelText('Add code')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByText(other.name))
    expect(onApplyCode).toHaveBeenCalledWith(other.id)
    expect(applyCode).not.toHaveBeenCalled()
  })

  it('the + Add code apply keeps its own mutation with no host', async () => {
    const other = { ...CODE, id: 9, name: 'Pacing adherence' } as Code
    renderActions({ allCodes: [CODE, other], codeMap: new Map([[CODE.id, CODE], [other.id, other]]) })
    const trigger = screen.getByLabelText('Add code')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByText(other.name))
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(335, other.id))
  })
})
