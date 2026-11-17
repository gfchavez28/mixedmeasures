/**
 * #1474 — what a withdrawal leaves in the client cache, and what it costs the page
 * the researcher is on.
 *
 * A withdrawal DELETES their dataset rows and quotes, BLANKS their turns, rewrites
 * the canvas copies, deletes stored metric results and writes a backup
 * (`backend-invariants.md` §5) — so nearly every page in the project read something
 * that is now gone. The handler named a hand list of keys, and nine readers of their
 * answers and words were not on it (the 2026-10-29 audit's F7 probe, re-run here):
 * straight after "P001 removed" the Data grid, Text Coding and Content › by code still
 * showed them. A list cannot be kept complete — `['segments', cid]`,
 * `['notes', cid]` and `['participant-detail', id]` carry no project id at all — so
 * the act forgets every page that is not on screen and refetches the ones that are
 * (`lib/project-cache.ts::forgetCachedProjectPages`, Merge's shape).
 *
 * The keys seeded below are the readers' own shapes (file:line at the time of
 * writing); the assertion is shape-independent, which is the point.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Participant, WithdrawalReport } from '@/lib/api/participants'

const listParticipants = vi.fn()
const getDetail = vi.fn()
const withdrawalReport = vi.fn()
const withdraw = vi.fn()
const listDatasets = vi.fn()

vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<object>('@/lib/api/error-utils'),
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    delete: () => Promise.resolve(),
    getDetail: (...a: unknown[]) => getDetail(...a),
    withdrawalReport: (...a: unknown[]) => withdrawalReport(...a),
    withdraw: (...a: unknown[]) => withdraw(...a),
    update: () => Promise.resolve(),
  },
  datasetsApi: { list: () => listDatasets(), linkableRows: () => Promise.resolve({ rows: [], total: 0 }) },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
// #1608 — the profile's read follows blind mode (`useBlindScope`); here it is every coder's.
vi.mock('@/hooks/useBlindScope', () => ({ useBlindScope: () => ({ coderScope: undefined, scopeReady: true }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import ParticipantsPage from './ParticipantsPage'

beforeEach(() => {
  listDatasets.mockImplementation(() => Promise.resolve({ datasets: [{ id: 5, name: 'Survey' }] }))
  withdraw.mockResolvedValue({
    identifier: 'P001', backup_filename: 'b.mmbackup', documents_unlinked: 0,
    other_projects_with_identifier: { projects: [], total: 0 },
    pre_update_copies: { count: 0, folder: '/home/r/backups' },
  })
})

afterEach(() => {
  cleanup()
  listDatasets.mockReset()
  listParticipants.mockReset()
  getDetail.mockReset()
  withdrawalReport.mockReset()
  withdraw.mockReset()
})

function person(id: number, over: Partial<Participant> = {}): Participant {
  return {
    id, project_id: 1, identifier: `P${String(id).padStart(3, '0')}`, display_name: null,
    role: null, demographics: null, role_auto_filled_from: null, created_at: '', updated_at: '',
    linked_speakers: [], dataset_rows: [], linked_documents: [],
    ...over,
  }
}

const report = (over: Partial<WithdrawalReport> = {}): WithdrawalReport => ({
  participant_id: 0, identifier: '', display_name: null, role: null, has_demographics: false,
  speaker_names: [], conversations: [], datasets: [], documents: [], total_items: 1,
  unlinked_records_with_identifier: 0,
  canvas_quotes_unplaced: { quotes: 0, sections: [], snapshots: [] },
  canvas_misfit_cases: 0,  // joint display slice 2 (r3-6)
  other_projects_with_identifier: { projects: [], total: 0 },
  pre_update_copies: { count: 0, folder: '/home/r/backups' }, ...over,
})

const P1 = person(1, {
  dataset_rows: [{ id: 9, dataset_id: 5, dataset_name: 'Survey', row_identifier: 'R001', submitted_at: null, link_refusal: null }],
  linked_speakers: [{
    speaker_id: 1, speaker_name: 'P001', is_facilitator: false, color_index: 0, color: null,
    conversations: [{ id: 31, name: 'Interview A' }],
  }],
})
const P2 = person(2)

let client: QueryClient

/** The page with the app's own query defaults (`main.tsx`: 60 s fresh, one retry). */
function renderPage() {
  getDetail.mockImplementation((_pid: number, id: number) =>
    Promise.resolve({ ...(id === 1 ? P1 : P2), linked_demographics: [] }))
  withdrawalReport.mockImplementation((_pid: number, id: number) =>
    Promise.resolve(report({ participant_id: id, identifier: id === 1 ? 'P001' : 'P002' })))
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ParticipantsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const row = (identifier: string) =>
  screen.getByText(identifier).closest('tr') as HTMLTableRowElement

/** Opens P001's panel, withdraws them and waits for the request. */
async function withdrawP001() {
  fireEvent.click(row('P001'))
  await screen.findByRole('heading', { level: 2, name: 'P001' })
  fireEvent.click(screen.getByRole('button', { name: "Remove P001's data (withdrawal request)" }))
  const confirm = await screen.findByRole('button', { name: /Back up and remove/ })
  await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
  fireEvent.click(confirm)
  await waitFor(() => expect(withdraw).toHaveBeenCalled())
}

/**
 * A page no one is showing holds NO data afterwards — removed, not merely marked
 * stale. An invalidated query still paints its old copy on the next mount until the
 * refetch lands (#1206), and the entry's "an inline edit there addresses a deleted
 * value" is that window.
 */
const forgotten = (key: unknown[]) => client.getQueryData(key) === undefined

describe('#1474 — after a withdrawal no cached page serves what it removed', () => {
  it('every reader of their answers, words and results is forgotten — whatever its key carries', async () => {
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    const keys: unknown[][] = [
      // The audit's nine (F7), as their readers build them.
      ['dataset-data', 1, 5, 0],                        // DatasetView.tsx:269 — their rows are DELETED
      ['text-data', 1, '12', '', false, '', 0, false],  // TextCodingView.tsx:218 — their answers
      ['text-column-readonly', 1, 12, ''],              // ContentBySource.tsx:681
      ['code-texts-context', 1, 3, '', '', '', ''],      // ContentByCode.tsx:847
      ['code-segments-context', 1, 3, false],           // ContentByCode.tsx — their blanked turns
      ['conversation-segments-readonly', 1, 31],        // ContentBySource.tsx:358
      ['column-frequencies', 1, 5, 12],                 // ColumnDictionaryEditor.tsx:147 — a unique answer
      ['metrics', 1],                                   // AnalysisView.tsx:401 — D10 deleted the results
      ['canvas-chart', 1, 4, {}],                       // InlineChartRenderer.tsx:171
      // Wider than filed: more readers the act moves.
      ['text-progress', 1, '12', null],                 // TextCodingView.tsx:385 — N responded
      ['record-context', 1, 9],                         // ByRecordPanel.tsx:86 — their other answers
      ['correlation-matrix', 1, '12', '', 'pearson', false], // AnalysisView.tsx:296
      ['document-segments-readonly', 1, 8],             // ContentBySource.tsx:525
      ['backup-list'],                                  // BackupHistorySection.tsx:64 — the act wrote a backup
      // Keys with NO project id — a project-scoped list could never name them.
      ['segments', 31], ['notes', 31],
      // What #1320's list already covered must stay covered.
      ['canvas', 1, 4], ['snapshot-detail', 1, 4, 9], ['excerpts', 1], ['search', 1, 'maria', '', null, false],
    ]
    for (const k of keys) client.setQueryData(k, { cached: true })
    // ON SCREEN elsewhere in the layout (ProjectLayout.tsx:134 — the TopRail's counts):
    // kept, and asked again.
    let projectReads = 0
    client.setQueryData(['project', 1], { participant_count: 2 })
    const unsubscribe = new QueryObserver(client, {
      queryKey: ['project', 1],
      queryFn: () => { projectReads++; return Promise.resolve({ participant_count: 1 }) },
    }).subscribe(() => {})

    await withdrawP001()

    await waitFor(() => expect(keys.filter(k => !forgotten(k)).map(k => JSON.stringify(k))).toEqual([]))
    await waitFor(() => expect(projectReads).toBeGreaterThan(0))
    expect(client.getQueryData(['project', 1])).toEqual({ participant_count: 1 })
    unsubscribe()
  })

  it('#1320: cached canvas content is GONE, not merely marked — the next Writing view cannot bind their words', async () => {
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    client.setQueryData(['canvas', 1, 4], { cached: true })
    client.setQueryData(['snapshot-detail', 1, 4, 9], { cached: true })
    await withdrawP001()
    await waitFor(() => {
      expect(client.getQueryData(['canvas', 1, 4])).toBeUndefined()
      expect(client.getQueryData(['snapshot-detail', 1, 4, 9])).toBeUndefined()
    })
  })

  /**
   * The case forgetting alone gets wrong: a canvas still ON SCREEN when the act lands
   * (the request has no client timeout, #1025) is only invalidated by `refreshActive`,
   * and an invalidated query keeps serving its old content until the refetch lands.
   */
  it('#1320: a canvas still on screen is RESET — no old content while the server is asked again', async () => {
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    client.setQueryData(['canvas', 1, 4], { themes: ['their words'] })
    let canvasReads = 0
    const unsubscribe = new QueryObserver(client, {
      queryKey: ['canvas', 1, 4],
      queryFn: () => { canvasReads++; return new Promise(() => {}) },  // the server's version, not yet back
    }).subscribe(() => {})
    await withdrawP001()
    await waitFor(() => expect(canvasReads).toBeGreaterThan(0))
    expect(client.getQueryData(['canvas', 1, 4])).toBeUndefined()
    unsubscribe()
  })
})

describe('joint display slice 2 (D314) — a plain DELETE rewrites the canvas too', () => {
  /**
   * The delete endpoint removes the person from every list of cases that don't fit (ids are
   * reused, so an entry must not outlive its person). A cached canvas bound by the editor
   * would autosave the old entry, and the researcher's reason, straight back — so the delete
   * resets canvas content as the withdrawal does. Found by the build's drive.
   */
  it('cached canvas content is gone after a delete', async () => {
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P002')
    client.setQueryData(['canvas', 1, 4], { cached: true })
    client.setQueryData(['snapshot-detail', 1, 4, 9], { cached: true })
    fireEvent.click(screen.getByRole('button', { name: "Delete P002's participant record but keep their data" }))
    const confirm = await screen.findByRole('button', { name: 'Delete record' })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(client.getQueryData(['canvas', 1, 4])).toBeUndefined()
      expect(client.getQueryData(['snapshot-detail', 1, 4, 9])).toBeUndefined()
    })
  })
})

describe('#1474 — what the act costs the Participants page itself', () => {
  it('the list keeps its rows while it refetches: no loading line, no "No participants yet", the check survives', async () => {
    let answer!: (v: unknown) => void
    listParticipants
      .mockResolvedValueOnce({ participants: [P1, P2], total: 2 })
      .mockImplementationOnce(() => new Promise((r) => { answer = r }))
    renderPage()
    await screen.findByText('P001')
    fireEvent.click(within(row('P002')).getByRole('checkbox'))
    await withdrawP001()
    await waitFor(() => expect(listParticipants).toHaveBeenCalledTimes(2))
    // While the refetch is out: the old answer stays on screen, nothing claims "none".
    expect(screen.getByText('P002')).toBeInTheDocument()
    expect(screen.queryByText('Loading participants…')).toBeNull()
    expect(screen.queryByText('No participants yet')).toBeNull()
    await act(async () => { answer({ participants: [P2], total: 1 }) })
    await waitFor(() => expect(screen.queryByText('P001')).toBeNull())
    expect(within(row('P002')).getByRole('checkbox')).toHaveAttribute('data-state', 'checked')
  })

  it('nothing asks the server about the person who is gone (their panel and confirm were open)', async () => {
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    fireEvent.click(row('P001'))
    await screen.findByRole('heading', { level: 2, name: 'P001' })
    fireEvent.click(screen.getByRole('button', { name: "Remove P001's data (withdrawal request)" }))
    const confirm = await screen.findByRole('button', { name: /Back up and remove/ })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    // Counted BEFORE the press: the act's own refetches start inside its success handler.
    const detailBefore = getDetail.mock.calls.filter(([, id]) => id === 1).length
    const reportBefore = withdrawalReport.mock.calls.filter(([, id]) => id === 1).length
    fireEvent.click(confirm)
    await waitFor(() => expect(withdraw).toHaveBeenCalled())
    // Let every refetch the act started run out.
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect({
      detail: getDetail.mock.calls.filter(([, id]) => id === 1).length - detailBefore,
      report: withdrawalReport.mock.calls.filter(([, id]) => id === 1).length - reportBefore,
    }).toEqual({ detail: 0, report: 0 })
    // And nothing of theirs is left cached to answer a later read.
    // #1608 — the profile's key carries its blind scope; an EXACT read must name it, or this
    // absence could never fail (every-coder here: `useBlindScope` is mocked so).
    expect(client.getQueryData(['participant-detail', 1, 'every-coder'])).toBeUndefined()
    expect(client.getQueriesData({ queryKey: ['withdrawal-report', 1, 1] }).filter(([, d]) => d !== undefined)).toEqual([])
  })

  /**
   * The positive control for the line above: the act DOES refresh what is on screen,
   * so the absence of a request about the withdrawn person is a decision, not a
   * refresh that never ran. Another person's open panel stays open and is asked
   * again (one request — the cost of not enumerating).
   */
  it('another person\'s open panel stays open and is asked again', async () => {
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    fireEvent.click(row('P002'))
    await screen.findByRole('heading', { level: 2, name: 'P002' })
    const before = getDetail.mock.calls.filter(([, id]) => id === 2).length
    // Withdraw P001 from their ROW's action while P002's panel is open.
    fireEvent.click(within(row('P001')).getByRole('button', { name: /Remove P001's data/ }))
    const confirm = await screen.findByRole('button', { name: /Back up and remove/ })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(confirm)
    await waitFor(() => expect(withdraw).toHaveBeenCalled())
    await waitFor(() => expect(getDetail.mock.calls.filter(([, id]) => id === 2).length).toBeGreaterThan(before))
    expect(screen.getByRole('heading', { level: 2, name: 'P002' })).toBeInTheDocument()
  })
})

/**
 * #1474 — a withdrawal that FAILS still forgets (`mm-file-doors.md` §1b's reason):
 * the request has no client timeout (#1025), but a connection that drops after the
 * server committed reaches `onError`, and the act may have finished. A real refusal
 * costs only first-visit loads. Their own panel and confirm are NOT dropped on a
 * failure — the person may still exist, and both stay open on them.
 */
describe('#1474 — a withdrawal that fails', () => {
  it('still forgets the pages no one is showing, and refreshes the ones on screen', async () => {
    withdraw.mockReset()
    withdraw.mockRejectedValue(new Error('Network Error'))
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    const inactive: unknown[][] = [['dataset-data', 1, 5, 0], ['text-data', 1, '12', '', false, '', 0, false], ['segments', 31]]
    for (const k of inactive) client.setQueryData(k, { cached: true })
    const listCalls = listParticipants.mock.calls.length
    await withdrawP001()
    await waitFor(() => expect(inactive.filter(k => client.getQueryData(k) !== undefined).map(k => JSON.stringify(k))).toEqual([]))
    await waitFor(() => expect(listParticipants.mock.calls.length).toBeGreaterThan(listCalls))
  })

  it('their panel and the confirm stay open on them, with their answers on screen, and focus stays on the confirm', async () => {
    withdraw.mockReset()
    withdraw.mockRejectedValue(new Error('Network Error'))
    listParticipants.mockResolvedValue({ participants: [P1, P2], total: 2 })
    renderPage()
    await screen.findByText('P001')
    fireEvent.click(row('P001'))
    await screen.findByRole('heading', { level: 2, name: 'P001' })
    fireEvent.click(screen.getByRole('button', { name: "Remove P001's data (withdrawal request)" }))
    const confirm = await screen.findByRole('button', { name: /Back up and remove/ })
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'))
    const detailBefore = getDetail.mock.calls.filter(([, id]) => id === 1).length
    // The re-reads the forget starts are held OPEN, so what shows WHILE they run is seen.
    getDetail.mockImplementation(() => new Promise(() => {}))
    withdrawalReport.mockImplementation(() => new Promise(() => {}))
    confirm.focus()
    fireEvent.click(confirm)
    await waitFor(() => expect(withdraw).toHaveBeenCalled())
    // The forget refreshed their panel (it is on screen) — asked again, never emptied.
    await waitFor(() => expect(getDetail.mock.calls.filter(([, id]) => id === 1).length).toBeGreaterThan(detailBefore))
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'))
    expect(screen.getByRole('heading', { level: 2, name: 'P001', hidden: true })).toBeInTheDocument()
    expect(screen.queryByText('Loading participant…')).toBeNull()
    expect(screen.queryByText('Checking what would be removed…')).toBeNull()
    expect(confirm).not.toHaveAttribute('aria-disabled')
    expect(document.activeElement).toBe(confirm)
    expect(client.getQueryData(['participant-detail', 1, 'every-coder'])).toBeDefined()
  })
})
