/**
 * #532 — ParticipantCell "New participant from this row": creates a participant
 * whose identifier is the row's identifier-column value (threaded in as
 * suggestedIdentifier) and links it in one gesture; the backend's 409 on a
 * duplicate identifier becomes link-to-existing, unless that participant is
 * already linked to another row in this dataset.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
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
import { NO_PARTICIPANTS_YET, PARTICIPANT_LIST_LIMIT, PARTICIPANT_SEARCH_LABEL } from '@/lib/participant-search'

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
  await screen.findByRole('textbox', { name: PARTICIPANT_SEARCH_LABEL })
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
  expect(screen.queryByText(NO_PARTICIPANTS_YET)).not.toBeInTheDocument()
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
  expect(screen.queryByText(NO_PARTICIPANTS_YET)).not.toBeInTheDocument()
  const createBtn = screen.getByRole('button', { name: /new participant/i })
  expect(createBtn).toBeDisabled()
  fireEvent.click(createBtn)
  expect(create).not.toHaveBeenCalled()
})

/**
 * #1045 — the white window. On a page of the dataset grid all 200 cells built
 * the picker's full option list while every picker was CLOSED, because the list
 * was inline JSX inside the popover and its query (`enabled: open`) still
 * RETURNED whatever another surface had cached. 20,000 participants: 1,817 MB
 * and 8.4 s to open a page; 122,382: the renderer ran out of memory.
 *
 * ⚠️ The DOM cannot see this defect: a closed Radix popover mounts nothing
 * before or after the fix, so a button count over closed cells passes either
 * way. What CAN be seen is the cause — a closed cell subscribing to the list at
 * all. The fixture seeds the cache WARM, because with a cold cache the old code
 * was cheap too (that is what "after a restart it opened quickly" measured).
 */
describe('#1045 — a closed picker costs nothing, an open one is bounded', () => {
  const participants = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    identifier: `P${String(i + 1).padStart(5, '0')}`,
    display_name: null,
    role: null,
    linked_speakers: [],
  }))

  function renderWarmGrid(rows: number, cached: ReturnType<typeof participants>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(['participants', 1], { participants: cached, total: cached.length })
    list.mockResolvedValue({ participants: cached, total: cached.length })
    render(
      <QueryClientProvider client={qc}>
        <table>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i}>
                <ParticipantCell
                  row={{ ...ROW, id: 100 + i, row_identifier: `r${i}` }}
                  projectId={1}
                  linkedParticipantMap={new Map()}
                  onLink={vi.fn()}
                  suggestedIdentifier={null}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </QueryClientProvider>,
    )
    const observers = () => qc.getQueryCache().find({ queryKey: ['participants', 1] })!.getObserversCount()
    return { observers }
  }

  it('closed cells hold NO observer on the cached participant list', () => {
    const { observers } = renderWarmGrid(30, participants(500))
    expect(observers()).toBe(0)
  })

  it('POSITIVE CONTROL: opening one picker subscribes exactly one, and closing releases it', async () => {
    const { observers } = renderWarmGrid(30, participants(500))
    fireEvent.click(screen.getAllByRole('button', { name: /link/i })[0])
    await screen.findByRole('textbox', { name: PARTICIPANT_SEARCH_LABEL })
    expect(observers()).toBe(1)
    fireEvent.keyDown(screen.getByRole('textbox', { name: PARTICIPANT_SEARCH_LABEL }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: PARTICIPANT_SEARCH_LABEL })).toBeNull())
    expect(observers()).toBe(0)
  })

  it('renders at most PARTICIPANT_LIST_LIMIT options, and says the list stops early', async () => {
    renderWarmGrid(1, participants(1000))
    fireEvent.click(screen.getByRole('button', { name: /link/i }))
    const search = await screen.findByRole('textbox', { name: PARTICIPANT_SEARCH_LABEL })
    await screen.findByText('P00001')
    const options = screen.getAllByRole('button').filter(b => /^P\d{5}/.test(b.textContent ?? ''))
    expect(options).toHaveLength(PARTICIPANT_LIST_LIMIT)
    const note = `Showing the first ${PARTICIPANT_LIST_LIMIT} of ${(1000).toLocaleString()} participants. Type a name or ID to find the others.`
    expect(screen.getByText(note)).toBeInTheDocument()
    // Where a keyboard user types is where they hear it.
    expect(search).toHaveAccessibleDescription(note)
  })

  it('search reaches past the bound, exact match first, and the note goes when nothing is hidden', async () => {
    renderWarmGrid(1, participants(1000))
    fireEvent.click(screen.getByRole('button', { name: /link/i }))
    const search = await screen.findByRole('textbox', { name: PARTICIPANT_SEARCH_LABEL })
    // P00999 sits at position 999 in server order — far outside the first 200.
    fireEvent.change(search, { target: { value: 'p00999' } })
    await waitFor(() => {
      const options = screen.getAllByRole('button').filter(b => /^P\d{5}/.test(b.textContent ?? ''))
      expect(options.map(o => o.textContent)).toEqual(['P00999'])
    })
    expect(screen.queryByText(/Showing the first/)).toBeNull()
    expect(search).not.toHaveAttribute('aria-describedby')
  })

  it('🔴 marks the participant this record is linked to as CURRENT — not by its tint alone', async () => {
    // The blue tint was the only mark, so the tree could not say which one is
    // this record's (a11y-name-sweep run 9). A state, so `aria-current`.
    const people = participants(3)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    list.mockResolvedValue({ participants: people, total: people.length })
    render(
      <QueryClientProvider client={qc}>
        <table>
          <tbody>
            <tr>
              <ParticipantCell
                row={{ ...ROW, participant_id: 2, participant_display_name: 'P00002' }}
                projectId={1}
                linkedParticipantMap={new Map([[2, 'r1']])}
                onLink={vi.fn()}
                suggestedIdentifier={null}
              />
            </tr>
          </tbody>
        </table>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Change linked participant: P00002' }))
    await screen.findByText('P00003')
    // Inside the picker: the TRIGGER reads "P00002" too, and comes first.
    const picker = screen.getByRole('dialog', { name: 'Link a participant' })
    const option = (id: string) => within(picker).getAllByRole('button').find(b => b.textContent === id)!
    expect(option('P00002')).toHaveAttribute('aria-current', 'true')
    expect(option('P00001')).not.toHaveAttribute('aria-current')
    expect(option('P00003')).not.toHaveAttribute('aria-current')
  })

  it('a small list shows every participant and no note (positive control for the bound)', async () => {
    renderWarmGrid(1, participants(12))
    fireEvent.click(screen.getByRole('button', { name: /link/i }))
    await screen.findByText('P00012')
    expect(screen.getAllByRole('button').filter(b => /^P\d{5}/.test(b.textContent ?? ''))).toHaveLength(12)
    expect(screen.queryByText(/Showing the first/)).toBeNull()
  })
})

it('#963 POSITIVE CONTROL: an answered EMPTY list says so and still creates', async () => {
  list.mockResolvedValue({ participants: [], total: 0 })
  create.mockResolvedValue({ id: 42, identifier: 'P-07', display_name: null, role: null, linked_speakers: [] })
  renderCell()
  await openPopover()
  expect(await screen.findByText(NO_PARTICIPANTS_YET)).toBeInTheDocument()
  expect(screen.queryByText(/Loading participants/)).not.toBeInTheDocument()
  const createBtn = screen.getByRole('button', { name: /new participant .P-07./i })
  expect(createBtn).toBeEnabled()
  fireEvent.click(createBtn)
  await waitFor(() => expect(create).toHaveBeenCalledWith(1, { identifier: 'P-07' }))
})
