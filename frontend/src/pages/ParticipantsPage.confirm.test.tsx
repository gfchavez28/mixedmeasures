/**
 * Batch 4b — the Participants page's two confirmations (#1139 #1152).
 *
 * 🔴 Rendered with the APP's QueryClient defaults (`main.tsx`: 60 s `staleTime`,
 * `retry: 1`; `retryDelay: 0` so a failure settles here). A freshness test under
 * the library's 0 s default cannot fail (`list-load-state.md` §4): every cached
 * report is stale there, so any confirm refetches whatever its key.
 *
 * The server is a small mutable model, and the scenario is the one reproduced live
 * (Batch 4 review §5): the panel is opened (caching the person's report), a
 * document is made ABOUT them on another page, and within the 60 s the withdrawal
 * and the delete confirm are opened. Both used to list nothing about the document —
 * the delete's sentence said they had "no linked transcript turns, responses or
 * documents" — and the withdrawal's button enabled at once.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Participant, WithdrawalReport } from '@/lib/api/participants'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'

const listParticipants = vi.fn()
const getDetail = vi.fn()
const withdrawalReport = vi.fn()
const withdraw = vi.fn()
const updateParticipant = vi.fn()

vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<object>('@/lib/api/error-utils'),
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    delete: () => Promise.resolve(),
    getDetail: (...a: unknown[]) => getDetail(...a),
    withdrawalReport: (...a: unknown[]) => withdrawalReport(...a),
    withdraw: (...a: unknown[]) => withdraw(...a),
    update: (...a: unknown[]) => updateParticipant(...a),
  },
  datasetsApi: { list: () => Promise.resolve({ datasets: [] }), linkableRows: vi.fn() },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
// #1608 — the profile's read follows blind mode (`useBlindScope`); here it is every coder's.
vi.mock('@/hooks/useBlindScope', () => ({ useBlindScope: () => ({ coderScope: undefined, scopeReady: true }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import ParticipantsPage from './ParticipantsPage'
import { toast } from 'sonner'

/** The server: one person, Jonas Berg (J-03), linked to a survey record. */
let jonas: Participant

function reportFor(p: Participant): WithdrawalReport {
  return {
    participant_id: p.id, identifier: p.identifier, display_name: p.display_name, role: null,
    has_demographics: false, speaker_names: [], conversations: [], datasets: [],
    documents: p.linked_documents.map(d => ({
      document_id: d.id, name: d.name, segments: 2, code_applications: 0, excerpts: 0, notes: 0, canvas_quotes: 0,
    })),
    total_items: 1 + p.linked_documents.length * 2,
    unlinked_records_with_identifier: 0,
    canvas_quotes_unplaced: { quotes: 0, sections: [], snapshots: [] },
    canvas_misfit_cases: 0,  // joint display slice 2 (r3-6)
    canvas_drift_stamps: 0,  // #1674 (D357)
    ...NOWHERE_ELSE,
  }
}

/** #1606 — no other project holds their ID, and the backup folder has no update copy. */
const NOWHERE_ELSE = {
  other_projects_with_identifier: { projects: [], total: 0 },
  pre_update_copies: { count: 0, folder: '/home/r/backups' },
} satisfies Pick<WithdrawalReport, 'other_projects_with_identifier' | 'pre_update_copies'>

beforeEach(() => {
  jonas = {
    id: 3, project_id: 1, identifier: 'J-03', display_name: 'Jonas Berg', role: null,
    demographics: null, role_auto_filled_from: null, created_at: '', updated_at: '',
    linked_speakers: [], linked_documents: [],
    dataset_rows: [{
      id: 9, dataset_id: 5, dataset_name: 'Survey', row_identifier: 'R001', submitted_at: null,
      link_refusal: null,
    }],
  }
  listParticipants.mockImplementation(() => Promise.resolve({ participants: [{ ...jonas }], total: 1 }))
  getDetail.mockImplementation(() => Promise.resolve({ ...jonas, linked_demographics: [] }))
  withdrawalReport.mockImplementation(() => Promise.resolve(reportFor(jonas)))
})

afterEach(() => {
  cleanup()
  vi.mocked(toast.success).mockClear()
  for (const m of [listParticipants, getDetail, withdrawalReport, withdraw, updateParticipant]) m.mockReset()
})

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, retry: 1, retryDelay: 0 },
      mutations: { onError: () => toast.error('Something went wrong. Please try again.') },
    },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ParticipantsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const row = () => screen.getByText('Jonas Berg').closest('tr') as HTMLTableRowElement

/** Open the panel (which caches the report), close it, and make a document about
 *  Jonas "on the Documents page" — a door this page never hears of. */
async function cacheThenLinkADocumentElsewhere() {
  renderPage()
  await screen.findByText('Jonas Berg')
  fireEvent.click(row())
  const panel = await screen.findByRole('complementary', { name: 'Participant details' })
  await within(panel).findByText('Nothing else in this project is linked to this participant.')
  expect(withdrawalReport).toHaveBeenCalledTimes(1)
  fireEvent.click(within(panel).getByRole('button', { name: 'Close participant details' }))
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
  jonas.linked_documents = [{ id: 11, name: 'Workplan J', source_format: 'txt' }]
}

/** The next report request waits until the test releases it. */
function holdNextReport() {
  let release!: () => void
  withdrawalReport.mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve(reportFor(jonas))
  }))
  return () => release()
}

describe('#1152 — the withdrawal confirm reads the report for THIS opening', () => {
  it('says it is checking, refuses, asks the server again — then lists the new document', async () => {
    await cacheThenLinkADocumentElsewhere()
    const release = holdNextReport()
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog')

    // The cached "nothing linked" report is NOT shown as this opening's answer.
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking what would be removed…')
    const confirm = within(dialog).getByRole('button', { name: 'Back up and remove' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(confirm)
    expect(withdraw).not.toHaveBeenCalled()
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(2))

    release()
    expect(await within(dialog).findByText(/The document “Workplan J” stays, no longer linked to them/))
      .toBeInTheDocument()
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
  })

  it('re-opened, it asks again: its own answer from the last opening is not kept (`gcTime: 0`)', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    const withdrawButton = screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" })
    fireEvent.click(withdrawButton)
    let dialog = await screen.findByRole('alertdialog')
    await within(dialog).findByText('This will be removed')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    jonas.linked_documents = [{ id: 11, name: 'Workplan J', source_format: 'txt' }]
    const release = holdNextReport()
    fireEvent.click(withdrawButton)
    dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking what would be removed…')
    release()
    expect(await within(dialog).findByText(/The document “Workplan J” stays/)).toBeInTheDocument()
  })

  it('while it is open, coming back to the window asks again (`staleTime: 0`)', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog')
    await within(dialog).findByText('This will be removed')
    const asked = withdrawalReport.mock.calls.length

    // The researcher looks something up in another window, where the document
    // is made; back here, the open confirm must not go on listing the old set.
    jonas.linked_documents = [{ id: 11, name: 'Workplan J', source_format: 'txt' }]
    act(() => { focusManager.setFocused(false) })
    act(() => { focusManager.setFocused(true) })
    await waitFor(() => expect(withdrawalReport.mock.calls.length).toBeGreaterThan(asked))
    expect(await within(dialog).findByText(/The document “Workplan J” stays/)).toBeInTheDocument()
    act(() => { focusManager.setFocused(undefined) })
  })

  it('a report that could not be read says so, and the confirm still refuses', async () => {
    await cacheThenLinkADocumentElsewhere()
    // Both tries fail (the app's `retry: 1`).
    withdrawalReport.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('What would be removed could not be checked.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back up and remove' }))
    expect(withdraw).not.toHaveBeenCalled()
  })
})

describe('#1152 — the delete confirm reads the report for THIS opening', () => {
  it('waits, then names the document — the sentence no longer says nothing is linked', async () => {
    await cacheThenLinkADocumentElsewhere()
    const release = holdNextReport()
    fireEvent.click(screen.getByRole('button', { name: "Delete Jonas Berg's participant record but keep their data" }))
    const dialog = await screen.findByRole('alertdialog')

    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking what would be removed…')
    expect(dialog).toHaveAccessibleDescription(/Checking what would be removed…/)
    const confirm = within(dialog).getByRole('button', { name: 'Delete record' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(2))

    release()
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(/1 document about them remains in the project/))
    expect(dialog).not.toHaveAccessibleDescription(/no linked transcript turns, responses or documents/)
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
  })
})

describe('#1139 — the delete confirm', () => {
  it('fits the window, names the person, and its list of what stays is IN the description', async () => {
    jonas.linked_documents = [{ id: 11, name: 'Workplan J', source_format: 'txt' }]
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Delete Jonas Berg's participant record but keep their data" }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Jonas Berg’s record? (J-03)' })
    for (const c of DIALOG_FITS_VIEWPORT.split(' ')) expect(dialog).toHaveClass(c)
    // #955 d — as `children` the list was on screen and silent.
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(/Data that stays in the project:/))
    expect(dialog).toHaveAccessibleDescription(/Workplan J — a document about them, 2 passages/)
  })

  it('the bulk delete fits the window too', async () => {
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Jonas Berg' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
    const dialog = await screen.findByRole('alertdialog')
    for (const c of DIALOG_FITS_VIEWPORT.split(' ')) expect(dialog).toHaveClass(c)
  })
})

describe('#1139 — the withdrawal names the person, and so does its toast', () => {
  it('"Remove Jonas Berg’s data? (J-03)", then "Jonas Berg (J-03) removed"', async () => {
    withdraw.mockResolvedValue({
      identifier: 'J-03', backup_filename: 'b.mmbackup', documents_unlinked: 0, ...NOWHERE_ELSE,
    })
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Jonas Berg’s data? (J-03)' })
    const confirm = within(dialog).getByRole('button', { name: 'Back up and remove' })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(confirm)
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith(1, 3))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Jonas Berg (J-03) removed. Backup saved as b.mmbackup.', expect.anything(),
    ))
  })

  it('#1546 (D158): the done note says how many canvas quotes it left', async () => {
    withdraw.mockResolvedValue({
      identifier: 'J-03', backup_filename: 'b.mmbackup', documents_unlinked: 0,
      canvas_quotes_unplaced: 2, ...NOWHERE_ELSE,
    })
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Jonas Berg’s data? (J-03)' })
    const confirm = within(dialog).getByRole('button', { name: 'Back up and remove' })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Jonas Berg (J-03) removed. Backup saved as b.mmbackup.',
      expect.objectContaining({
        description: expect.stringContaining(
          ' 2 quotes on a canvas stay because their source was deleted or changed'),
      }),
    ))
  })
})

describe('#1606 (D234, D235) — where their data still is that the withdrawal does not reach', () => {
  const ELSEWHERE = {
    other_projects_with_identifier: {
      projects: [{ project_id: 8, name: 'Wave 2', copy_relation: 'copy' as const }], total: 1,
    },
    pre_update_copies: { count: 2, folder: '/home/r/backups' },
  }

  it('the confirm lists them under what stays, and the note after says them again', async () => {
    withdrawalReport.mockImplementation(() => Promise.resolve({ ...reportFor(jonas), ...ELSEWHERE }))
    withdraw.mockResolvedValue({
      identifier: 'J-03', backup_filename: 'b.mmbackup', documents_unlinked: 0, ...ELSEWHERE,
    })
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(screen.getByRole('button', { name: "Remove Jonas Berg's data (withdrawal request)" }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Jonas Berg’s data? (J-03)' })
    const other = await within(dialog).findByText(
      'Another project here holds a participant with this ID: “Wave 2” (a copy of this project). '
      + 'Check whether it is the same person, and withdraw them there too')
    expect(other.closest('li')).not.toBeNull()
    expect(within(dialog).getByText(
      '2 copies of the whole database taken before updates are in /home/r/backups')).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Back up and remove' })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Jonas Berg (J-03) removed. Backup saved as b.mmbackup.',
      expect.objectContaining({
        description: expect.stringContaining(
          ' Another project here holds a participant with this ID: “Wave 2” (a copy of this '
          + 'project). Check whether it is the same person, and withdraw them there too. 2 copies '
          + 'of the whole database taken before updates are in /home/r/backups. The “Before'),
        // The note can outgrow a short window (458 px at 640×360, driven): capped, it
        // scrolls, and starts at its top so the "… removed" line is never above the
        // edge. jsdom computes no layout, so this pins the technique.
        className: 'max-h-[calc(100dvh-3rem)] overflow-y-auto items-start!',
      }),
    ))
  })
})

describe('#1152 — the panel reads afresh each time it opens', () => {
  it('re-opened within the 60 s, it lists a document made about them elsewhere — detail AND summary', async () => {
    await cacheThenLinkADocumentElsewhere()
    fireEvent.click(row())
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    // The detail's "Documents about them" section…
    expect(await within(panel).findByRole('link', { name: 'Workplan J' })).toBeInTheDocument()
    // …and the withdrawal summary under it.
    expect(await within(panel).findByText('Workplan J — a document about them, 2 passages')).toBeInTheDocument()
  })

  it('an inline rename refreshes the open panel and the report, not only the list', async () => {
    updateParticipant.mockImplementation((_pid: number, _id: number, data: { identifier?: string; display_name?: string }) => {
      jonas = { ...jonas, ...data }
      return Promise.resolve({ ...jonas })
    })
    renderPage()
    await screen.findByText('Jonas Berg')
    fireEvent.click(row())
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    await within(panel).findByRole('heading', { level: 2, name: 'Jonas Berg' })
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Edit Jonas Berg' }))
    const name = screen.getByRole('textbox', { name: 'Name for Jonas Berg' })
    fireEvent.change(name, { target: { value: 'Jonas Bergström' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    // CONFIRMED live before: the heading stayed "Jonas Berg" over a renamed row.
    expect(await within(panel).findByRole('heading', { level: 2, name: 'Jonas Bergström' })).toBeInTheDocument()
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(2))
  })
})
