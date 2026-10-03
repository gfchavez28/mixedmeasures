/**
 * The machine-coder dialog's save (#999) — what it refreshes (#1038 d).
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ updateCoder: vi.fn() }))
vi.mock('@/lib/api', () => ({ authApi: { updateCoder: api.updateCoder } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import MachineCoderDialog from './MachineCoderDialog'

afterEach(() => {
  cleanup()
  api.updateCoder.mockReset()
})

describe('saving a machine coder', () => {
  it('🔴 refreshes the Model comparison as well as the roster (#1038 d)', async () => {
    // The comparison table carries the model's NAME and configuration in its own
    // payload, so a rename read stale there until the cache aged out.
    api.updateCoder.mockResolvedValue({})
    const client = new QueryClient()
    client.setQueryData(['machine-agreement', 3, 'all'], { rows: [] })
    client.setQueryData(['coders'], [])
    client.setQueryData(['codes', 3], [])          // unrelated — must stay fresh
    render(
      <QueryClientProvider client={client}>
        <MachineCoderDialog
          coder={{ id: 9, username: 'GPT', coder_type: 'ai' } as never}
          open
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GPT-4o run A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(client.getQueryState(['machine-agreement', 3, 'all'])?.isInvalidated).toBe(true))
    expect(client.getQueryState(['coders'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['codes', 3])?.isInvalidated).toBe(false)
    expect(api.updateCoder).toHaveBeenCalledWith(9, expect.objectContaining({ username: 'GPT-4o run A' }))
  })
})

describe('a configuration that can no longer change (a11y-name-sweep run 9)', () => {
  function renderDialog(locked: boolean) {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MachineCoderDialog
          coder={{ id: 9, username: 'GPT', coder_type: 'ai', provenance_locked: locked } as never}
          open
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    )
    return screen.getByRole('dialog')
  }

  it('🔴 is said in the dialog’s DESCRIPTION, heard when it opens', () => {
    // The sentence sat between the Name field and the fields it explains,
    // attached to nothing — and those fields are disabled, so Tab went Name →
    // Cancel → Save and a keyboard user never met the configuration at all.
    expect(renderDialog(true)).toHaveAccessibleDescription(/its configuration is fixed/)
  })

  it('POSITIVE CONTROL: an editable one is not described as fixed', () => {
    const dialog = renderDialog(false)
    expect(dialog).toHaveAccessibleDescription(/Which model produced these labels/)
    expect(dialog).not.toHaveAccessibleDescription(/fixed/)
  })
})
