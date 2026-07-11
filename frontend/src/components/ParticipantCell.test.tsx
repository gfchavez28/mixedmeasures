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
