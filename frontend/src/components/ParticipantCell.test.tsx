/**
 * #532 — ParticipantCell "New participant from this row": creates a participant
 * whose identifier is the row's identifier-column value (threaded in as
 * suggestedIdentifier) and links it in one gesture; the backend's 409 on a
 * duplicate identifier becomes link-to-existing, unless that participant is
 * already linked to another row in this dataset.
 */
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const list = vi.fn()
const create = vi.fn()
vi.mock('@/lib/api', () => ({
  participantsApi: {
    list: (...a: unknown[]) => list(...a),
    create: (...a: unknown[]) => create(...a),
  },
  // #963 — the component passes this as its `retry` policy; without it here the
  // mock hands React Query `undefined` and the test is measuring the client
  // default rather than the component's own choice.
  retryUnanswered: () => false,
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

import { ParticipantCell } from './DatasetGridComponents'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ROW = {
  id: 5,
  participant_id: null,
  participant_display_name: null,
  row_identifier: 'r1',
  submitted_at: null,
  values: {},
}

function renderCell({
  suggestedIdentifier = 'P-07',
  linkedMap = new Map<number, string>(),
}: {
  suggestedIdentifier?: string | null
  linkedMap?: Map<number, string>
} = {}) {
  const onLink = vi.fn(
    (_rowId: number, _participantId: number | null, _participantName: string | null) => {},
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <table>
        <tbody>
          <tr>
            <ParticipantCell
              row={ROW}
              projectId={1}
              linkedParticipantMap={linkedMap}
              onLink={onLink}
              suggestedIdentifier={suggestedIdentifier}
            />
          </tr>
        </tbody>
      </table>
    </QueryClientProvider>,
  )
  return { onLink }
}

async function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: /link/i }))
  await screen.findByPlaceholderText('Search participants...')
}

it('creates a participant from the row identifier and links it', async () => {
  list.mockResolvedValue({ participants: [], total: 0 })
  create.mockResolvedValue({
    id: 42, identifier: 'P-07', display_name: null, role: null, linked_speakers: [],
  })
  const { onLink } = renderCell()
  await openPopover()
  fireEvent.click(await screen.findByRole('button', { name: /new participant .P-07./i }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(1, { identifier: 'P-07' }))
  await waitFor(() => expect(onLink).toHaveBeenCalledWith(5, 42, 'P-07'))
})

it('409 duplicate: links to the existing participant instead', async () => {
  const existing = {
    id: 9, identifier: 'P-07', display_name: 'Maria', role: null, linked_speakers: [],
  }
  list.mockResolvedValue({ participants: [existing], total: 1 })
  create.mockRejectedValue(Object.assign(new Error('dup'), { status: 409 }))
  const { onLink } = renderCell()
  await openPopover()
  // Wait for the participants list to land so the 409 handler can find it.
  await screen.findByText('Maria')
  fireEvent.click(screen.getByRole('button', { name: /new participant .P-07./i }))
  await waitFor(() => expect(onLink).toHaveBeenCalledWith(5, 9, 'Maria'))
  expect(toastError).not.toHaveBeenCalled()
})

it('409 duplicate linked to ANOTHER row: errors instead of stealing the link', async () => {
  const existing = {
    id: 9, identifier: 'P-07', display_name: 'Maria', role: null, linked_speakers: [],
  }
  list.mockResolvedValue({ participants: [existing], total: 1 })
  create.mockRejectedValue(Object.assign(new Error('dup'), { status: 409 }))
  const { onLink } = renderCell({ linkedMap: new Map([[9, 'r3']]) })
  await openPopover()
  await screen.findByText(/Already linked to r3/)
  fireEvent.click(screen.getByRole('button', { name: /new participant .P-07./i }))
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/already linked to record r3/i)))
  expect(onLink).not.toHaveBeenCalled()
})

it('renders no create affordance without a suggested identifier', async () => {
  list.mockResolvedValue({ participants: [], total: 0 })
  renderCell({ suggestedIdentifier: null })
  await openPopover()
  expect(screen.queryByRole('button', { name: /new participant/i })).toBeNull()
})

/**
 * #963 — what this picker may CLAIM and OFFER before the participant list
 * answers. Its query is `enabled: open`, so EVERY cold open is an unanswered
 * one: driven on the running app against a project with 30 participants, the
 * popover read "No participants found" beside an enabled
 * *New participant "R00001"*.
 *
 * ⚠️ Unlike the code and category pickers, the SERVER refuses a duplicate
 * identifier (409), so no twin can be created. What the unanswered list breaks
 * is the RECOVERY: `handleCreateFromRow` resolves that 409 by finding the
 * existing participant and linking to it, and over an empty list it falls to
 * the last arm — "already exists — pick it from the list" — pointing at a list
 * with nothing in it. These cases pin the words and the wasted round trip.
 */
it('#963 while loading: says so, claims no absence, and offers no create', async () => {
  list.mockReturnValue(new Promise(() => {}))
  renderCell()
  await openPopover()
  expect(await screen.findByText(/Loading participants…/)).toBeInTheDocument()
  expect(screen.queryByText('No participants found')).not.toBeInTheDocument()
  const createBtn = screen.getByRole('button', { name: /new participant/i })
  expect(createBtn).toBeDisabled()
  expect(createBtn).toHaveAttribute('title', expect.stringMatching(/Still loading/i))
  fireEvent.click(createBtn)
  expect(create).not.toHaveBeenCalled()
})

it('#963 after a failure: says the load failed, offers Retry, and creates nothing', async () => {
  list.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
  renderCell()
  await openPopover()
  expect(await screen.findByText(/participants could not be loaded/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.queryByText('No participants found')).not.toBeInTheDocument()
  const createBtn = screen.getByRole('button', { name: /new participant/i })
  expect(createBtn).toBeDisabled()
  fireEvent.click(createBtn)
  expect(create).not.toHaveBeenCalled()
})

it('#963 POSITIVE CONTROL: an answered EMPTY list says so and still creates', async () => {
  list.mockResolvedValue({ participants: [], total: 0 })
  create.mockResolvedValue({ id: 42, identifier: 'P-07', display_name: null, role: null, linked_speakers: [] })
  renderCell()
  await openPopover()
  expect(await screen.findByText('No participants found')).toBeInTheDocument()
  expect(screen.queryByText(/Loading participants/)).not.toBeInTheDocument()
  const createBtn = screen.getByRole('button', { name: /new participant .P-07./i })
  expect(createBtn).toBeEnabled()
  fireEvent.click(createBtn)
  await waitFor(() => expect(create).toHaveBeenCalledWith(1, { identifier: 'P-07' }))
})
