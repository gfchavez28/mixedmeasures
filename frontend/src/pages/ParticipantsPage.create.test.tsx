/**
 * #1190 (D12) — the Participants page's *Add Participant* form, for an ID that belongs
 * to someone who WITHDREW from this project.
 *
 * The server refuses it with a 409 whose `detail` is an OBJECT
 * (`{ error: 'withdrawn_identifier', message }`); the page asks with the server's
 * sentence and sends `confirm_withdrawn: true` only on "Create anyway". Every other
 * failure is shown as before — and through `serverDetailMessage`, because React cannot
 * render the object the raw `detail` now can be.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const listParticipants = vi.fn()
const create = vi.fn()

vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<object>('@/lib/api/error-utils'),
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    create: (...a: unknown[]) => create(...a),
    delete: () => Promise.resolve(),
    update: () => Promise.resolve(),
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
  create.mockReset()
})

const SENTENCE = 'This ID belongs to a participant who withdrew from this project.'
const refusal = () => Object.assign(new Error('409'), {
  status: 409,
  response: { status: 409, data: { detail: { error: 'withdrawn_identifier', message: SENTENCE } } },
})

async function fillTheForm(name = 'P07') {
  listParticipants.mockResolvedValue({ participants: [], total: 0 })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ParticipantsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click((await screen.findAllByRole('button', { name: /Add Participant/ }))[0])
  fireEvent.change(screen.getByPlaceholderText('Participant name'), { target: { value: name } })
  return screen.getByRole('button', { name: 'Create' })
}

describe('#1190 (D12) — Add Participant with a withdrawn person’s ID', () => {
  it('asks with the server’s sentence; "Create anyway" sends the override', async () => {
    create.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ id: 3, identifier: 'P07' })
    fireEvent.click(await fillTheForm())
    const dialog = await screen.findByRole('alertdialog', { name: 'Add a participant who withdrew?' })
    expect(dialog).toHaveAccessibleDescription(SENTENCE)
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls).toEqual([
      [1, { identifier: 'P07', display_name: 'P07' }],
      [1, { identifier: 'P07', display_name: 'P07', confirm_withdrawn: true }],
    ])
    // The form closes on success, as it always did.
    await waitFor(() => expect(screen.queryByPlaceholderText('Participant name')).toBeNull())
  })

  it('Cancel creates nothing and keeps the form, with no error under it', async () => {
    create.mockRejectedValueOnce(refusal())
    const button = await fillTheForm()
    fireEvent.click(button)
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.getByPlaceholderText('Participant name')).toHaveValue('P07')
    expect(screen.queryByText(/Failed to create participant/)).toBeNull()
  })

  it('CONTROL: a duplicate 409 asks nothing and shows the server’s sentence, as before', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('dup'), {
      status: 409, response: { status: 409, data: { detail: "Participant with identifier 'P07' already exists in this project" } },
    }))
    fireEvent.click(await fillTheForm())
    expect(await screen.findByText("Participant with identifier 'P07' already exists in this project")).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Create stays focusable while the request runs (aria-disabled + its guard)', async () => {
    let release: (v: unknown) => void = () => {}
    create.mockImplementation(() => new Promise(r => { release = r }))
    const button = await fillTheForm()
    fireEvent.click(button)
    const busy = await screen.findByRole('button', { name: 'Creating...' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toBeDisabled()
    fireEvent.click(busy)
    expect(create).toHaveBeenCalledTimes(1)
    release({ id: 3, identifier: 'P07' })
  })
})
