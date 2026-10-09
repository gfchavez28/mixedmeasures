/**
 * #1052 — the Participants page rendered one table row per participant.
 *
 * A survey imported with identifier linking makes one participant per record,
 * so the page is reached with tens of thousands of them: MEASURED at 20,000,
 * 25.9 s to open and 640,162 DOM nodes (the BES file's 122,382 would be six
 * times that — #1045's white window). The table now renders at most
 * `PARTICIPANT_LIST_LIMIT` rows, says so, widens on request, and search reaches
 * any one person.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { PARTICIPANT_LIST_LIMIT } from '@/lib/participant-search'

const listParticipants = vi.fn()
const deleteParticipant = vi.fn()

vi.mock('@/lib/api', () => ({
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    delete: (...a: unknown[]) => deleteParticipant(...a),
    getDetail: () => new Promise(() => {}),
    withdrawalReport: () => new Promise(() => {}),
  },
  datasetsApi: { list: () => Promise.resolve({ datasets: [] }) },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// A table row here is a checkbox, three icon buttons and a popover: at the real
// limit the "Show more" case (200 rows, then 400) took 7.0 s in jsdom, past the
// 5 s default (#1040's class). The rule is the same at any limit, so this file
// runs it at 20.
vi.mock('@/lib/participant-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/participant-search')>()),
  PARTICIPANT_LIST_LIMIT: 20,
}))

import ParticipantsPage from './ParticipantsPage'

afterEach(() => {
  cleanup()
  listParticipants.mockReset()
  deleteParticipant.mockReset()
})

function participants(n: number, orphans = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    project_id: 1,
    identifier: `P${String(i + 1).padStart(5, '0')}`,
    display_name: null,
    role: null,
    demographics: null,
    role_auto_filled_from: null,
    created_at: '',
    updated_at: '',
    // One dataset row each — i.e. NOT orphans, as after a linked import — except
    // the last `orphans`, which have no linked source at all.
    linked_speakers: [],
    dataset_rows: i >= n - orphans
      ? []
      : [{ id: i + 1, dataset_id: 1, dataset_name: 'Survey', row_identifier: `r${i}` }],
    linked_documents: [],
  }))
}

function renderPage(n: number, orphans = 0) {
  listParticipants.mockResolvedValue({ participants: participants(n, orphans), total: n })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ParticipantsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const rows = () => view.container.querySelectorAll<HTMLTableRowElement>('tr[data-participant-row]')
  return { rows }
}

describe('#1052 — the Participants table is bounded', () => {
  it('renders the first PARTICIPANT_LIST_LIMIT rows of a large list and says the table stops early', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    expect(rows()).toHaveLength(PARTICIPANT_LIST_LIMIT)
    expect(screen.getByText(
      `Showing the first ${PARTICIPANT_LIST_LIMIT} of 45 participants. Search to find a particular person.`,
    )).toBeInTheDocument()
    // Select-all says what it will select when that is not everyone.
    expect(screen.getByRole('checkbox', { name: `Select the ${PARTICIPANT_LIST_LIMIT} participants shown` }))
      .toBeInTheDocument()
    // #908's rule: a margin is not a space — the name read "Participants(45)"
    // (a11y-name-sweep run 9).
    expect(screen.getByRole('heading', { level: 1, name: 'Participants (45)' })).toBeInTheDocument()
  })

  it('"Show more" widens the table and hands focus to the first row it revealed — never to <body>', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('button', { name: `Show ${PARTICIPANT_LIST_LIMIT} more` }))
    await waitFor(() => expect(rows()).toHaveLength(2 * PARTICIPANT_LIST_LIMIT))
    expect(document.activeElement).toBe(rows()[PARTICIPANT_LIST_LIMIT])

    // The last press reveals the rest and unmounts the button it was on.
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }))
    await waitFor(() => expect(rows()).toHaveLength(45))
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull()
    expect(screen.queryByText(/Showing the first/)).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(rows()[2 * PARTICIPANT_LIST_LIMIT])
  })

  it('a new search starts again from the first page, however far "Show more" had widened it', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('button', { name: `Show ${PARTICIPANT_LIST_LIMIT} more` }))
    await waitFor(() => expect(rows()).toHaveLength(2 * PARTICIPANT_LIST_LIMIT))
    // "p0" matches all 45, so only the reset keeps the table at one page.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search participants by name, ID or role' }), {
      target: { value: 'p0' },
    })
    await waitFor(() => expect(rows()).toHaveLength(PARTICIPANT_LIST_LIMIT))
    expect(screen.getByText(`Showing the first ${PARTICIPANT_LIST_LIMIT} of 45 matching participants.`)).toBeInTheDocument()
  })

  it('select-all takes the rows SHOWN, not the ones nobody can see', async () => {
    renderPage(45)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('checkbox', { name: `Select the ${PARTICIPANT_LIST_LIMIT} participants shown` }))
    expect(await screen.findByText(`${PARTICIPANT_LIST_LIMIT} selected`)).toBeInTheDocument()
  })

  it('search finds a participant far outside the first page, and says when nothing matches', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    const search = screen.getByRole('textbox', { name: 'Search participants by name, ID or role' })
    fireEvent.change(search, { target: { value: 'p00044' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.getByText('P00044')).toBeInTheDocument()
    expect(screen.queryByText(/Showing the first/)).toBeNull()

    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(await screen.findByText('No participants match “zzz”.')).toBeInTheDocument()
  })

  // a11y-name-sweep run 10 — the name keyed on the page's CAP alone, so a search
  // that fit on one page read "Select all participants" over 10 rows of 257, and
  // the box selects only the rows shown.
  it('a search that fits on one page still names select-all as the rows shown', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    const search = screen.getByRole('textbox', { name: 'Search participants by name, ID or role' })
    fireEvent.change(search, { target: { value: 'p0001' } })
    await waitFor(() => expect(rows()).toHaveLength(10))
    expect(screen.getByRole('checkbox', { name: 'Select the 10 participants shown' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'p00044' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.getByRole('checkbox', { name: 'Select the 1 participant shown' })).toBeInTheDocument()
  })

  it('POSITIVE CONTROL: a small project shows everyone, with no note and the plain select-all', async () => {
    const { rows } = renderPage(5)
    await screen.findByText('P00005')
    expect(rows()).toHaveLength(5)
    expect(screen.queryByText(/Showing the first/)).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Select all participants' })).toBeInTheDocument()
  })
})

/**
 * #1072 — a selection survived a search, and *Delete selected* deleted what the
 * search had hidden: select-all on the first 20, search to one other row, and the
 * bar still said "20 selected" over one unchecked row; confirming deleted twenty
 * people nobody could see. Every act now reads the checked rows that are SHOWN.
 */
describe('#1072 — a bulk delete acts only on rows the researcher can see', () => {
  const search = () => screen.getByRole('textbox', { name: 'Search participants by name, ID or role' })

  it('a search that hides every selected row offers no delete at all', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select the 20 participants shown' }))
    expect(await screen.findByText('20 selected')).toBeInTheDocument()

    fireEvent.change(search(), { target: { value: 'p00044' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.queryByText(/\d+ selected/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull()
  })

  it('a search that keeps some selected rows deletes exactly those — and names them', async () => {
    deleteParticipant.mockResolvedValue(undefined)
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select the 20 participants shown' }))
    fireEvent.change(search(), { target: { value: 'p0001' } })   // P00010–P00019 of the selected 20
    await waitFor(() => expect(rows()).toHaveLength(10))
    expect(screen.getByText('10 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('P00010, P00011, P00012 and 7 more')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteParticipant).toHaveBeenCalledTimes(10))
    const deleted = deleteParticipant.mock.calls.map((c) => c[1]).sort((a, b) => a - b)
    expect(deleted).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('a row checked, hidden by a search and shown again is still checked', async () => {
    const { rows } = renderPage(45)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select the 20 participants shown' }))
    fireEvent.change(search(), { target: { value: 'p00044' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(search(), { target: { value: '' } })
    expect(await screen.findByText('20 selected')).toBeInTheDocument()
  })
})

/**
 * a11y-name-sweep run 10 — the two filter buttons showed which one is on by
 * colour alone, so a screen reader heard two plain buttons.
 */
describe('the participant filter says which filter is on', () => {
  it('marks the active filter pressed, and moves the mark when the other is chosen', async () => {
    renderPage(12, 5)
    await screen.findByText('P00001')
    const all = screen.getByRole('button', { name: 'All (12)' })
    const unlinked = screen.getByRole('button', { name: 'No linked sources (5)' })
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(unlinked).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(unlinked)
    await waitFor(() => expect(unlinked).toHaveAttribute('aria-pressed', 'true'))
    expect(all).toHaveAttribute('aria-pressed', 'false')
  })

  // #1090 — the filter in force is not a control that does something: pressing
  // it again used to clear the selection, and must not re-collapse a table
  // "Show more" widened.
  it('re-choosing the filter in force changes nothing', async () => {
    const { rows } = renderPage(45, 5)
    await screen.findByText('P00001')
    fireEvent.click(screen.getByRole('button', { name: `Show ${PARTICIPANT_LIST_LIMIT} more` }))
    await waitFor(() => expect(rows()).toHaveLength(2 * PARTICIPANT_LIST_LIMIT))
    fireEvent.click(screen.getByRole('button', { name: 'All (45)' }))
    expect(rows()).toHaveLength(2 * PARTICIPANT_LIST_LIMIT)
  })
})
