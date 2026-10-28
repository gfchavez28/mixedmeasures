/**
 * #1190 (D12) — renaming a participant to the ID of someone who WITHDREW from this project.
 *
 * `PATCH /participants/{id}` refuses it with the create's 409 body
 * (`{ error: 'withdrawn_identifier', message }`) unless `confirm_withdrawn: true`, so the
 * row's rename goes through the same ask-then-retry as *Add Participant* — in a rename's
 * words. Before, the row closed its editor and the refusal went nowhere: the rename simply
 * did not happen, and nothing said why.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Participant } from '@/lib/api/participants'

const listParticipants = vi.fn()
const update = vi.fn()

vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<object>('@/lib/api/error-utils'),
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    create: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    update: (...a: unknown[]) => update(...a),
  },
  datasetsApi: { list: () => Promise.resolve({ datasets: [] }) },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import ParticipantsPage from './ParticipantsPage'

afterEach(() => {
  cleanup()
  listParticipants.mockReset()
  update.mockReset()
})

const SENTENCE = 'This identifier belonged to a participant who withdrew from this project.'
const refusal = () => Object.assign(new Error('409'), {
  status: 409,
  response: { status: 409, data: { detail: { error: 'withdrawn_identifier', message: SENTENCE } } },
})

const someone: Participant = {
  id: 4, project_id: 1, identifier: 'P004', display_name: null, role: null, demographics: null,
  role_auto_filled_from: null, created_at: '', updated_at: '',
  linked_speakers: [], dataset_rows: [], linked_documents: [],
}

async function renameTo(name: string) {
  listParticipants.mockResolvedValue({ participants: [someone], total: 1 })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ParticipantsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Edit P004' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name for P004' }), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

describe('#1190 (D12) — renaming to a withdrawn person’s ID', () => {
  it('asks in a rename’s words; "Rename anyway" sends the override', async () => {
    update.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ ...someone, identifier: 'P07' })
    await renameTo('P07')
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Rename to the ID of a participant who withdrew?',
    })
    expect(dialog).toHaveAccessibleDescription(SENTENCE)
    expect(screen.queryByRole('button', { name: 'Create anyway' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rename anyway' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls).toEqual([
      [1, 4, { identifier: 'P07', display_name: 'P07' }],
      [1, 4, { identifier: 'P07', display_name: 'P07', confirm_withdrawn: true }],
    ])
  })

  it('Cancel renames nothing', async () => {
    update.mockRejectedValueOnce(refusal())
    await renameTo('P07')
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('CONTROL: an ordinary rename asks nothing', async () => {
    update.mockResolvedValueOnce({ ...someone, identifier: 'P005' })
    await renameTo('P005')
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
