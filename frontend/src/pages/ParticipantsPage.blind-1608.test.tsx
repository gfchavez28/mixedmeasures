/**
 * #1608 — the Participants page's profile follows blind mode.
 *
 * A person's profile lists their linked rows' values, the participant table's rating
 * columns among them, and each score combines every coder's ratings. So while blind the
 * panel asks the server for the viewer's scope (`coder_ids`), which leaves those columns
 * out (`test_blind_file_scope_1530.py::test_the_participant_profile_leaves_them_out`),
 * and it does not ask at all until the scope is known — fail closed, as the Data view.
 *
 * The scope comes from `useBlindScope`, mocked here per test (its own rule — settled,
 * withholding, a self id — is one hook, read by the Data view too).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Participant } from '@/lib/api/participants'

const listParticipants = vi.fn()
const getDetail = vi.fn()
const scope = vi.hoisted(() => ({ value: { coderScope: undefined as string | undefined, scopeReady: true } }))

vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<object>('@/lib/api/error-utils'),
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    delete: () => Promise.resolve(),
    getDetail: (...a: unknown[]) => getDetail(...a),
    withdrawalReport: () => new Promise(() => {}),
    withdraw: () => Promise.resolve(),
    update: () => Promise.resolve(),
    linkDatasetRow: () => Promise.resolve(),
    unlinkDatasetRow: () => Promise.resolve(),
  },
  datasetsApi: { list: () => Promise.resolve({ datasets: [] }), linkableRows: () => Promise.resolve({ rows: [] }) },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useBlindScope', () => ({ useBlindScope: () => scope.value }))

import ParticipantsPage from './ParticipantsPage'

afterEach(() => {
  cleanup()
  listParticipants.mockReset()
  getDetail.mockReset()
  scope.value = { coderScope: undefined, scopeReady: true }
})

const ana: Participant = {
  id: 1, project_id: 1, identifier: 'P001', display_name: null, role: null, demographics: null,
  role_auto_filled_from: null, created_at: '', updated_at: '',
  linked_speakers: [], dataset_rows: [], linked_documents: [],
}

function openPanel() {
  listParticipants.mockResolvedValue({ participants: [ana], total: 1 })
  getDetail.mockImplementation(() => Promise.resolve({ ...ana, linked_demographics: [] }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ParticipantsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.findByText('P001').then(cell => {
    fireEvent.click(cell.closest('tr') as HTMLTableRowElement)
    return screen.findByRole('heading', { level: 2, name: 'P001' })
  })
}

describe('the profile while blind (#1608)', () => {
  it('asks for the viewer’s own scope while withholding', async () => {
    scope.value = { coderScope: '2', scopeReady: true }
    await openPanel()
    await waitFor(() => expect(getDetail).toHaveBeenCalled())
    expect(getDetail).toHaveBeenCalledWith(1, 1, '2')
  })

  it('does not ask at all before the scope is known (fail closed)', async () => {
    scope.value = { coderScope: undefined, scopeReady: false }
    await openPanel()
    // The heading is the list's name (`fallbackName`); the detail must not be read.
    await new Promise(r => setTimeout(r, 50))
    expect(getDetail).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: not blind, it asks for every coder', async () => {
    await openPanel()
    await waitFor(() => expect(getDetail).toHaveBeenCalled())
    expect(getDetail).toHaveBeenCalledWith(1, 1, undefined)
  })
})
