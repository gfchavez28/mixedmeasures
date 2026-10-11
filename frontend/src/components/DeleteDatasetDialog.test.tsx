/**
 * #1175 — the Datasets list's delete confirm says what else the delete removes,
 * and a pairing refusal before the click. The dataset twin of
 * `DeleteVariableDialog.test.tsx`, through `ConfirmDialog`'s two new props.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RemovalPlan } from '@/lib/api'

const api = vi.hoisted(() => ({ getDatasetRemovalPlan: vi.fn() }))
vi.mock('@/lib/api', () => ({ datasetsApi: { getDatasetRemovalPlan: api.getDatasetRemovalPlan } }))

import { DeleteDatasetDialog } from './DeleteDatasetDialog'

afterEach(() => {
  cleanup()
  api.getDatasetRemovalPlan.mockReset()
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

function mount(onConfirm = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeleteDatasetDialog
        projectId={3}
        dataset={{ id: 11, name: 'Wave 2' }}
        isPending={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    </QueryClientProvider>,
  )
  return { onConfirm, dialog: screen.getByRole('alertdialog') }
}

describe('#1175 — the removal plan in the dataset delete confirm', () => {
  it('names what else goes, in the description, and Delete deletes THIS dataset', async () => {
    api.getDatasetRemovalPlan.mockResolvedValue(plan({
      saved_metrics_removed: ['Wellbeing score', 'Trust score'],
      groups_removed: [{ id: 4, name: 'Trust' }],
    }))
    const { onConfirm, dialog } = mount()
    const paragraph =
      'Also removes 2 saved statistics (Wellbeing score and Trust score) that use it. '
      + '1 variable group (Trust) will be removed.'
    expect(await screen.findByText(paragraph)).toBeInTheDocument()
    expect(api.getDatasetRemovalPlan).toHaveBeenCalledWith(3, 11)
    expect(dialog).toHaveAccessibleDescription(new RegExp(paragraph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledWith(11)
  })

  it('while the plan loads: no paragraph, a loading line, and Delete WAITS', () => {
    api.getDatasetRemovalPlan.mockReturnValue(new Promise(() => {}))
    const { onConfirm } = mount()
    expect(screen.getByRole('status')).toHaveTextContent(/Checking what else this delete removes/)
    expect(screen.queryByText(/Also removes|will be removed/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('after a failure: no paragraph, the failure said, and Delete PROCEEDS', async () => {
    api.getDatasetRemovalPlan.mockRejectedValue({ status: 500 })
    const { onConfirm } = mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/)
    expect(screen.queryByText(/Also removes|will be removed/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledWith(11)
  })

  it('a pairing refusal: said before the click, Delete held with the reason in its NAME', async () => {
    const refusal = "Cannot complete this operation: it would leave the analysis domain 'W' with unpaired cross-dataset members."
    api.getDatasetRemovalPlan.mockResolvedValue(plan({ refusal, tests_removed: 3 }))
    const { onConfirm } = mount()
    expect(await screen.findByText(refusal)).toBeInTheDocument()
    expect(screen.queryByText(/Also removes/)).toBeNull()
    const del = screen.getByRole('button', { name: `Delete — unavailable: ${refusal}` })
    expect(del).toHaveAttribute('aria-disabled', 'true')
    expect(del).not.toBeDisabled()
    fireEvent.click(del)
    expect(onConfirm).not.toHaveBeenCalled()
    // The guard's preventDefault is also what keeps Radix's Action from closing.
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument())
  })
})
