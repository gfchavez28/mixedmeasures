/**
 * #1667 (D340, D342, D343) — a canvas copy the withdrawal report cannot read, on every surface
 * of the Participants page that reads the report or deletes past it.
 *
 * The server now REFUSES the report (409) in a sentence naming the copy (D340, D341); it was a
 * 500, so both confirms said only "Something went wrong while loading." and the copy reached the
 * server log alone (the 2026-11-16d drive). Here:
 * - both confirms show the sentence through their `LoadState`, keep the act unavailable, and
 *   send nothing — the confirms needed no change (a refusal's detail is `loadFailureReason`'s);
 * - the panel's *If this person withdraws* says it, with a Retry, instead of vanishing (D342);
 * - the bulk delete's toast carries each distinct refusal once (D343).
 *
 * Rendered with `retry: 1`, `retryDelay: 0` (the confirm test's defaults), so a failure settles.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Participant, WithdrawalReport } from '@/lib/api/participants'
import { WITHDRAWAL_SECTION_FAILED_TITLE } from '@/lib/withdrawal-copy'

const listParticipants = vi.fn()
const getDetail = vi.fn()
const withdrawalReport = vi.fn()
const withdraw = vi.fn()
const deleteParticipant = vi.fn()

vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<object>('@/lib/api/error-utils'),
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    delete: (...a: unknown[]) => deleteParticipant(...a),
    getDetail: (...a: unknown[]) => getDetail(...a),
    withdrawalReport: (...a: unknown[]) => withdrawalReport(...a),
    withdraw: (...a: unknown[]) => withdraw(...a),
    update: () => Promise.resolve(),
  },
  datasetsApi: { list: () => Promise.resolve({ datasets: [] }), linkableRows: vi.fn() },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('@/hooks/useBlindScope', () => ({ useBlindScope: () => ({ coderScope: undefined, scopeReady: true }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import ParticipantsPage from './ParticipantsPage'
import { toast } from 'sonner'

/** The server's D341 sentence for a snapshot it cannot read, as the report words it. */
const REPORT_REFUSAL = 'The canvas snapshot “Before the cleanup” of “Write-up” could not be read, '
  + 'so what it holds of this person cannot be checked.'
/** …and as the delete words it (#1651's refusal, the copy named since D341). */
const DELETE_REFUSAL = 'Could not delete this participant, so nothing was changed. The canvas snapshot '
  + '“Before the cleanup” of “Write-up” could not be read, so it cannot be checked whether a joint '
  + 'display there lists this person among its cases that don\'t fit.'

/** An `ApiError`'s shape: `status` + `response.data.detail` (`lib/api/client.ts`). */
const refusal = (detail: string) =>
  Object.assign(new Error(detail), { status: 409, response: { status: 409, data: { detail }, headers: {} } })

function person(id: number, identifier: string, name: string): Participant {
  return {
    id, project_id: 1, identifier, display_name: name, role: null, demographics: null,
    role_auto_filled_from: null, created_at: '', updated_at: '',
    linked_speakers: [], linked_documents: [], dataset_rows: [],
  }
}
const JONAS = person(3, 'J-03', 'Jonas Berg')
const ANA = person(4, 'A-04', 'Ana Ruiz')

const report = (p: Participant): WithdrawalReport => ({
  participant_id: p.id, identifier: p.identifier, display_name: p.display_name, role: null,
  has_demographics: false, speaker_names: [], conversations: [], datasets: [], documents: [],
  total_items: 1, unlinked_records_with_identifier: 0,
  canvas_quotes_unplaced: { quotes: 0, sections: [], snapshots: [] }, canvas_misfit_cases: 0,
  canvas_drift_stamps: 0,  // #1674 (D357)
  other_projects_with_identifier: { projects: [], total: 0 },
  pre_update_copies: { count: 0, folder: '/home/r/backups' },
})

beforeEach(() => {
  listParticipants.mockImplementation(() => Promise.resolve({ participants: [{ ...JONAS }, { ...ANA }], total: 2 }))
  getDetail.mockImplementation((_pid: number, id: number) =>
    Promise.resolve({ ...(id === 3 ? JONAS : ANA), linked_demographics: [] }))
  withdrawalReport.mockRejectedValue(refusal(REPORT_REFUSAL))
  deleteParticipant.mockRejectedValue(refusal(DELETE_REFUSAL))
})

afterEach(() => {
  cleanup()
  vi.mocked(toast.error).mockClear()
  for (const m of [listParticipants, getDetail, withdrawalReport, withdraw, deleteParticipant]) m.mockReset()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1, retryDelay: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ParticipantsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('#1667 (D340) — both confirms say which copy, and remove nothing', () => {
  it('the delete confirm', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Delete Jonas Berg's participant record but keep their data" }))
    const dialog = await screen.findByRole('alertdialog')
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('What would be removed could not be checked.')
    expect(alert).toHaveTextContent(REPORT_REFUSAL)
    expect(alert).not.toHaveTextContent('Something went wrong')
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete record' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(confirm)
    expect(deleteParticipant).not.toHaveBeenCalled()
  })

  it('the withdrawal confirm', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog')
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(REPORT_REFUSAL)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back up and remove' }))
    expect(withdraw).not.toHaveBeenCalled()
  })
})

describe('#1667 (D342) — the panel says it could not check, never vanishes', () => {
  it('says why with a Retry, and a Retry that answers lands on the section heading', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByText('Jonas Berg').closest('tr')!)
    const heading = await screen.findByRole('heading', { name: 'If this person withdraws' })
    const section = heading.parentElement as HTMLElement
    const alert = await within(section).findByRole('alert')
    expect(alert).toHaveTextContent(WITHDRAWAL_SECTION_FAILED_TITLE)
    expect(alert).toHaveTextContent(REPORT_REFUSAL)

    withdrawalReport.mockImplementation((_pid: number, id: number) => Promise.resolve(report(id === 3 ? JONAS : ANA)))
    const retry = within(section).getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)
    expect(await within(section).findByText('Nothing else in this project is linked to this participant.')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('control: while it loads, the section says nothing (the detail has the one loading line)', async () => {
    withdrawalReport.mockImplementation(() => new Promise(() => {}))
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByText('Jonas Berg').closest('tr')!)
    await screen.findByRole('heading', { name: /Jonas Berg/ })
    expect(screen.queryByRole('heading', { name: 'If this person withdraws' })).not.toBeInTheDocument()
  })
})

describe('#1667 (D343) — the bulk delete says why, once', () => {
  it('two refusals in the same words read once, under the count line', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Jonas Berg' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ana Ruiz' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const [title, options] = vi.mocked(toast.error).mock.calls[0] as [string, { description?: string }]
    expect(title).toBe('Deleted 0 of 2; 2 could not be removed.')
    expect(options?.description).toBe(DELETE_REFUSAL)
  })

  it('control: a failure that is not a refusal adds no description', async () => {
    deleteParticipant.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Jonas Berg' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][1]).toBeUndefined()
  })
})
