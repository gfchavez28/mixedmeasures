/**
 * #1175 — *Delete variable* says what ELSE it removes, and says a refusal before
 * the click.
 *
 * Real Radix (the dialog opens), the API barrel mocked. Three states per
 * the internal design notes, with `ready` as the POSITIVE control:
 * a guard that passed by never rendering the paragraph would satisfy every
 * negative assertion here.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RemovalPlan } from '@/lib/api'

const api = vi.hoisted(() => ({ getColumnRemovalPlan: vi.fn() }))
vi.mock('@/lib/api', () => ({ datasetsApi: { getColumnRemovalPlan: api.getColumnRemovalPlan } }))

import { DeleteVariableDialog } from './DeleteVariableDialog'

afterEach(() => {
  cleanup()
  api.getColumnRemovalPlan.mockReset()
})

const plan = (over: Partial<RemovalPlan> = {}): RemovalPlan => ({
  saved_metrics_removed: [],
  tests_removed: 0,
  groups_recalculated: [],
  groups_removed: [],
  refusal: null,
  blocked_by: [],
  ...over,
})

const column = { id: 7, source: 'manual', column_text: 'Wellbeing item 1', column_name: 'wb1' } as never

function mount(onConfirm = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeleteVariableDialog
        projectId={3}
        datasetId={5}
        column={column}
        isPending={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    </QueryClientProvider>,
  )
  return { onConfirm, dialog: screen.getByRole('alertdialog') }
}

const PARAGRAPH = /Also removes 1 saved statistic \(Wellbeing score\) and 2 saved tests that use it\. 1 variable group \(Wellbeing\) will be recalculated; 1 \(Lonely\) will be removed\./

describe('#1175 — the removal plan in the variable delete confirm', () => {
  it('asks the plan for THIS variable', async () => {
    api.getColumnRemovalPlan.mockResolvedValue(plan())
    mount()
    await waitFor(() => expect(api.getColumnRemovalPlan).toHaveBeenCalledWith(3, 5, 7))
  })

  it('names what else goes, in the dialog DESCRIPTION (heard on open)', async () => {
    api.getColumnRemovalPlan.mockResolvedValue(plan({
      saved_metrics_removed: ['Wellbeing score'],
      tests_removed: 2,
      groups_recalculated: [{ id: 1, name: 'Wellbeing' }],
      groups_removed: [{ id: 2, name: 'Lonely' }],
    }))
    const { dialog } = mount()
    expect(await screen.findByText(PARAGRAPH)).toBeInTheDocument()
    expect(dialog).toHaveAccessibleDescription(PARAGRAPH)
    expect(screen.getByRole('button', { name: 'Delete variable' })).toBeEnabled()
  })

  it('#1639 (r1-4): says what the delete does to a joint display, in the description', async () => {
    api.getColumnRemovalPlan.mockResolvedValue(plan())
    const { dialog } = mount()
    expect(dialog).toHaveAccessibleDescription(
      /cannot be undone\. A joint display that uses it will show it as no longer in the project\./)
  })

  it('an empty plan adds nothing — and Delete works (POSITIVE CONTROL for the wait)', async () => {
    api.getColumnRemovalPlan.mockResolvedValue(plan())
    const { onConfirm } = mount()
    const del = screen.getByRole('button', { name: 'Delete variable' })
    await waitFor(() => expect(del).toBeEnabled())
    expect(screen.queryByText(/Also removes|will be recalculated|will be removed/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(del)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('while the plan loads: no paragraph, a loading line, and Delete WAITS', () => {
    api.getColumnRemovalPlan.mockReturnValue(new Promise(() => {}))
    const { onConfirm } = mount()
    expect(screen.getByRole('status')).toHaveTextContent(/Checking what else this delete removes/)
    expect(screen.queryByText(/Also removes|will be removed/)).toBeNull()
    const del = screen.getByRole('button', { name: 'Delete variable' })
    expect(del).toBeDisabled()
    fireEvent.click(del)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('after a failure: no paragraph, the failure said with a Retry, and Delete PROCEEDS', async () => {
    api.getColumnRemovalPlan.mockRejectedValue({ status: 500 })
    const { onConfirm } = mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/Also removes|will be removed/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete variable' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('a computed dependent: says so, and Delete is held with the reason in its NAME', async () => {
    api.getColumnRemovalPlan.mockResolvedValue(plan({ blocked_by: ['C'], tests_removed: 2 }))
    const { onConfirm, dialog } = mount()
    const msg = "Can't delete: the computed variable C uses it. Delete or edit C first."
    expect(await screen.findByText(msg)).toBeInTheDocument()
    expect(dialog).toHaveAccessibleDescription(new RegExp(msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    // The refusal replaces the consequences — a delete that cannot happen
    // removes nothing.
    expect(screen.queryByText(/Also removes/)).toBeNull()
    const del = screen.getByRole('button', {
      name: 'Delete variable — unavailable: the computed variable C uses it',
    })
    // The persistent-mode arm: focusable, announced unavailable, and the click
    // guard is what refuses (#754).
    expect(del).toHaveAttribute('aria-disabled', 'true')
    expect(del).not.toBeDisabled()
    fireEvent.click(del)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it("a pairing refusal: the server's sentence, and Delete held with it in its name", async () => {
    const refusal = "Cannot complete this operation: it would leave the analysis domain 'W' with unpaired cross-dataset members."
    api.getColumnRemovalPlan.mockResolvedValue(plan({ refusal }))
    const { onConfirm } = mount()
    expect(await screen.findByText(refusal)).toBeInTheDocument()
    const del = screen.getByRole('button', { name: `Delete variable — unavailable: ${refusal}` })
    expect(del).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(del)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
