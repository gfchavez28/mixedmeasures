/**
 * Batch 13 — the Participants page (#1088 #1090 #1091 #1110 #1123 #1124).
 *
 * Rendered with a detail payload that RESOLVES (the bounded-table file's mock
 * never does), because most of these are about the panel: where focus goes when
 * it opens and closes, what its controls are called, and whether it knows a
 * document can be about a participant.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'
import type { Participant, WithdrawalReport } from '@/lib/api/participants'

const listParticipants = vi.fn()
const getDetail = vi.fn()
const withdrawalReport = vi.fn()
const withdraw = vi.fn()
const linkDatasetRow = vi.fn()
const unlinkDatasetRow = vi.fn()
const linkableRows = vi.fn()
const DEFAULT_DATASETS = [{ id: 5, name: 'Survey' }, { id: 6, name: 'Census' }]
const listDatasets = vi.fn()

vi.mock('@/lib/api', () => ({
  participantsApi: {
    list: (...a: unknown[]) => listParticipants(...a),
    delete: () => Promise.resolve(),
    getDetail: (...a: unknown[]) => getDetail(...a),
    withdrawalReport: (...a: unknown[]) => withdrawalReport(...a),
    withdraw: (...a: unknown[]) => withdraw(...a),
    update: () => Promise.resolve(),
    linkDatasetRow: (...a: unknown[]) => linkDatasetRow(...a),
    unlinkDatasetRow: (...a: unknown[]) => unlinkDatasetRow(...a),
  },
  datasetsApi: {
    list: () => listDatasets(),
    linkableRows: (...a: unknown[]) => linkableRows(...a),
  },
  speakersApi: {},
  retryUnanswered: () => false,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import ParticipantsPage from './ParticipantsPage'

beforeEach(() => {
  listDatasets.mockImplementation(() => Promise.resolve({ datasets: DEFAULT_DATASETS }))
})

afterEach(() => {
  cleanup()
  listDatasets.mockReset()
  listParticipants.mockReset()
  getDetail.mockReset()
  withdrawalReport.mockReset()
  withdraw.mockReset()
  linkDatasetRow.mockReset()
  unlinkDatasetRow.mockReset()
  linkableRows.mockReset()
})

function person(id: number, over: Partial<Participant> = {}): Participant {
  return {
    id, project_id: 1, identifier: `P${String(id).padStart(3, '0')}`, display_name: null,
    role: null, demographics: null, role_auto_filled_from: null, created_at: '', updated_at: '',
    linked_speakers: [], dataset_rows: [], linked_documents: [],
    ...over,
  }
}

const speakerIn = (conversation: string) => [{
  speaker_id: 1, speaker_name: 'P001', is_facilitator: false, color_index: 0, color: null,
  conversations: [{ id: 3, name: conversation }],
}]
const rowIn = (dataset: string) => [{
  id: 9, dataset_id: 5, dataset_name: dataset, row_identifier: 'R001', submitted_at: null,
  link_refusal: null,
}]
/** #1157 — a row of the table the tool keeps; the server sends its refusal. */
const LINK_REFUSAL = 'Every record here is already one participant, so links are maintained for you and cannot be changed by hand.'
const managedRowIn = () => [{
  id: 12, dataset_id: 7, dataset_name: 'Participants', row_identifier: 'P001', submitted_at: null,
  link_refusal: LINK_REFUSAL,
}]
const docAbout = (name: string, id = 11) => [{ id, name, source_format: 'txt' }]

const report = (over: Partial<WithdrawalReport> = {}): WithdrawalReport => ({
  participant_id: 0, identifier: '', display_name: null, role: null, has_demographics: false,
  speaker_names: [], conversations: [], datasets: [], documents: [], total_items: 1, ...over,
})

let lastClient: QueryClient

function renderPage(people: Participant[]) {
  listParticipants.mockResolvedValue({ participants: people, total: people.length })
  getDetail.mockImplementation((_pid: number, id: number) => {
    const p = people.find(x => x.id === id)!
    return Promise.resolve({ ...p, linked_demographics: [] })
  })
  withdrawalReport.mockImplementation((_pid: number, id: number) => {
    const p = people.find(x => x.id === id)!
    return Promise.resolve(report({
      participant_id: id, identifier: p.identifier,
      documents: p.linked_documents.map(d => ({
        document_id: d.id, name: d.name, segments: 2, code_applications: 0, excerpts: 0, notes: 0,
      })),
      total_items: 1 + p.linked_documents.length * 2,
    }))
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  lastClient = qc
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ParticipantsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const row = (identifier: string) =>
  screen.getByText(identifier).closest('tr') as HTMLTableRowElement

describe('#1110 — a document can be about a participant', () => {
  const people = () => [
    person(1, { linked_speakers: speakerIn('Interview A') }),
    person(2, { dataset_rows: rowIn('Survey') }),
    person(3, { linked_documents: docAbout('Workplan P003') }),
    person(4),
  ]

  it('the subject of a document is NOT listed under "No linked sources"', async () => {
    renderPage(people())
    await screen.findByText('P001')
    // One true orphan (P004), not two.
    const filter = screen.getByRole('button', { name: 'No linked sources (1)' })
    fireEvent.click(filter)
    await waitFor(() => expect(screen.queryByText('P003')).toBeNull())
    expect(screen.getByText('P004')).toBeInTheDocument()
  })

  it('the table says what each person is linked to, documents included', async () => {
    renderPage(people())
    await screen.findByText('P001')
    expect(row('P001')).toHaveTextContent('Conversation: Interview A')
    expect(row('P002')).toHaveTextContent('Dataset: Survey')
    expect(row('P003')).toHaveTextContent('Document: Workplan P003')
    expect(row('P004')).toHaveTextContent('No linked sources')
  })

  it('the panel lists the documents about them, and its report is not "nothing else"', async () => {
    renderPage(people())
    await screen.findByText('P003')
    fireEvent.click(row('P003'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    const docLink = await within(panel).findByRole('link', { name: 'Workplan P003' })
    expect(docLink).toHaveAttribute('href', '/projects/1/documents/11')
    // #1123 — the server's document list now reaches the page.
    expect(await within(panel).findByText('Workplan P003 — a document about them, 2 passages'))
      .toBeInTheDocument()
    expect(within(panel).queryByText(/Nothing else in this project is linked/)).toBeNull()
  })

  it('the bulk delete says how many documents lose their subject', async () => {
    renderPage(people())
    await screen.findByText('P003')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P003' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('1 document will no longer say who it is about.')
  })
})

describe('#1090 — the filter row', () => {
  it('no orphan: selecting a row shows the selection bar and NO lone filter button', async () => {
    renderPage([person(1, { dataset_rows: rowIn('Survey') }), person(2, { dataset_rows: rowIn('Survey') })])
    await screen.findByText('P001')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P001' }))
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^All \(/ })).toBeNull()
  })

  it('choosing a filter keeps the selection; re-choosing the one in force does nothing', async () => {
    renderPage([person(1, { dataset_rows: rowIn('Survey') }), person(2), person(3)])
    await screen.findByText('P001')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P002' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P001' }))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    const all = screen.getByRole('button', { name: 'All (3)' })
    all.focus()
    fireEvent.click(all)                                     // already in force
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(document.activeElement).toBe(all)

    fireEvent.click(screen.getByRole('button', { name: 'No linked sources (2)' }))
    // P001 is linked, so only P002 of the two is SHOWN — and still selected.
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'All (3)' }))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })

  it('the filter stays while it is ON, even once nobody is left in it', async () => {
    const people = [person(1, { dataset_rows: rowIn('Survey') }), person(2)]
    renderPage(people)
    await screen.findByText('P001')
    fireEvent.click(screen.getByRole('button', { name: 'No linked sources (1)' }))
    await waitFor(() => expect(screen.queryByText('P001')).toBeNull())
    // The orphan is deleted elsewhere and the list refreshes.
    listParticipants.mockResolvedValue({ participants: [people[0]], total: 1 })
    await act(() => lastClient.invalidateQueries({ queryKey: ['participants', 1] }))
    expect(await screen.findByText('No participants without linked sources.')).toBeInTheDocument()
    const all = screen.getByRole('button', { name: 'All (1)' })
    expect(screen.getByRole('button', { name: 'No linked sources (0)' })).toHaveAttribute('aria-pressed', 'true')
    // Leaving it removes both buttons, so focus goes to the search box.
    fireEvent.click(all)
    await screen.findByText('P001')
    expect(screen.queryByRole('button', { name: /^All \(/ })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search participants by name, ID or role' }))
  })

  it('Clear hands focus to select-all rather than to <body>', async () => {
    renderPage([person(1, { dataset_rows: rowIn('Survey') }), person(2, { dataset_rows: rowIn('Survey') })])
    await screen.findByText('P001')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select P001' }))
    const clear = await screen.findByRole('button', { name: 'Clear' })
    clear.focus()
    fireEvent.click(clear)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull())
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Select all participants' }))
  })
})

describe('#1091 — focus follows the panel', () => {
  const people = () => [person(1, { dataset_rows: rowIn('Survey') }), person(2, { dataset_rows: rowIn('Survey') })]

  it('opened by the keyboard, the panel takes focus; its Close returns focus to the row', async () => {
    renderPage(people())
    await screen.findByText('P002')
    const r = row('P002')
    r.focus()
    fireEvent.keyDown(r, { key: 'Enter' })
    const heading = await screen.findByRole('heading', { level: 2, name: 'P002' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(r).toHaveAttribute('aria-controls', 'participant-detail-panel')

    fireEvent.click(screen.getByRole('button', { name: 'Close participant details' }))
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
    expect(document.activeElement).toBe(row('P002'))
  })

  it('Escape closes it and returns focus to the row — unless a dialog took the Escape', async () => {
    renderPage(people())
    await screen.findByText('P001')
    fireEvent.keyDown(row('P001'), { key: 'Enter' })
    await screen.findByRole('heading', { level: 2, name: 'P001' })

    // An Escape a dialog already handled (Radix marks it) leaves the panel open.
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    document.dispatchEvent(handled)
    expect(screen.getByRole('complementary')).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
    expect(document.activeElement).toBe(row('P001'))
  })

  it('POSITIVE CONTROL: a click opens it without taking focus, and closing elsewhere moves nothing', async () => {
    renderPage(people())
    await screen.findByText('P001')
    const search = screen.getByRole('textbox', { name: 'Search participants by name, ID or role' })
    fireEvent.click(row('P001'))
    const heading = await screen.findByRole('heading', { level: 2, name: 'P001' })
    expect(document.activeElement).not.toBe(heading)
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
    expect(document.activeElement).toBe(search)
  })
})

describe('#1091 — what else the panel must survive', () => {
  const people = () => [person(1, { dataset_rows: rowIn('Survey') }), person(2, { dataset_rows: rowIn('Survey') })]

  it('cancelling an inline edit with Escape leaves the open panel alone', async () => {
    renderPage(people())
    await screen.findByText('P001')
    fireEvent.click(row('P001'))
    await screen.findByRole('heading', { level: 2, name: 'P001' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit P002' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name for P002' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name for P002' })).toBeNull())
    expect(screen.getByRole('complementary')).toBeInTheDocument()
  })

  it('switching to another person starts their panel afresh — a half-made link does not carry over', async () => {
    renderPage([person(1, { display_name: 'Ann' }), person(2, { display_name: 'Bo' })])
    await screen.findByText('Ann')
    fireEvent.click(row('Ann'))
    const picker = await screen.findByRole('combobox', { name: 'Link Ann to a dataset record' })
    fireEvent.change(picker, { target: { value: '6' } })
    await screen.findByRole('textbox', { name: 'Search Census records' })
    fireEvent.click(row('Bo'))
    await screen.findByRole('heading', { level: 2, name: 'Bo' })
    expect(screen.queryByRole('textbox', { name: 'Search Census records' })).toBeNull()
    expect(await screen.findByRole('combobox', { name: 'Link Bo to a dataset record' })).toBeInTheDocument()
  })

  it('withdrawing the person whose panel is open closes it', async () => {
    withdraw.mockResolvedValue({ identifier: 'P001', backup_filename: 'b.mmbackup', documents_unlinked: 0 })
    renderPage(people())
    await screen.findByText('P001')
    fireEvent.click(row('P001'))
    await screen.findByRole('heading', { level: 2, name: 'P001' })
    fireEvent.click(screen.getByRole('button', { name: "Remove P001's data (withdrawal request)" }))
    const confirm = await screen.findByRole('button', { name: /Back up and remove/ })
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    await waitFor(() => expect(withdraw).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
  })
})

describe('#1124 — the panel’s controls say what they act on', () => {
  it('names the dataset picker, the unlink button and the speaker colour button', async () => {
    renderPage([person(1, {
      display_name: 'Jane Doe', linked_speakers: speakerIn('Interview A'), dataset_rows: rowIn('Survey'),
    })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    await within(panel).findByRole('heading', { level: 2, name: 'Jane Doe' })
    expect(within(panel).getByRole('combobox', { name: 'Link Jane Doe to a dataset record' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Unlink R001 in Survey' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: "Change P001's color" })).toBeInTheDocument()
    // Sections sit under the panel's h2.
    expect(within(panel).getAllByRole('heading', { level: 3 }).map(h => h.textContent))
      .toEqual(expect.arrayContaining(['Speakers', 'Linked Datasets']))
  })

  it('Escape inside the record search leaves the picker, not the panel', async () => {
    renderPage([person(1, { display_name: 'Jane Doe' })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary')
    const picker = await within(panel).findByRole('combobox', { name: 'Link Jane Doe to a dataset record' })
    fireEvent.change(picker, { target: { value: '6' } })
    const search = await within(panel).findByRole('textbox', { name: 'Search Census records' })
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(within(panel).queryByRole('textbox', { name: 'Search Census records' })).toBeNull())
    expect(screen.getByRole('complementary')).toBeInTheDocument()
  })
})

/**
 * #1130 — the record picker and the two link acts (a11y-name-sweep run 11).
 * Census (id 6) holds R001 (taken by P009) and R002 (free).
 */
describe('#1130 — linking a record from the panel', () => {
  const census = {
    rows: [
      { row_id: 21, row_identifier: 'R001', display_values: ['North'], linked_participant_name: 'P009' },
      { row_id: 22, row_identifier: 'R002', display_values: ['South'], linked_participant_name: null },
    ],
  }

  async function openCensusPicker(over: Partial<Participant> = {}) {
    linkableRows.mockResolvedValue(census)
    renderPage([person(1, { display_name: 'Jane Doe', ...over })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    const picker = await within(panel).findByRole('combobox', { name: 'Link Jane Doe to a dataset record' })
    fireEvent.change(picker, { target: { value: '6' } })
    await within(panel).findByRole('textbox', { name: 'Search Census records' })
    return panel
  }

  it('each record is named with spaces between its parts, and a taken one says so', async () => {
    const panel = await openCensusPicker()
    // A margin is not a space: the name read "R001North(P009)".
    expect(await within(panel).findByRole('button', { name: 'R001 North (already linked to P009)' })).toBeDisabled()
    expect(within(panel).getByRole('button', { name: 'R002 South' })).toBeEnabled()
  })

  it('a keyboard link lands on the Linked Datasets heading AT ONCE, not after the refetch', async () => {
    linkDatasetRow.mockResolvedValue({})
    const panel = await openCensusPicker()
    // The refetch is slow (a large project): the picker is gone the moment the
    // link succeeds, and focus must not sit on <body> until the data returns.
    getDetail.mockImplementation((_pid: number, id: number) => new Promise(resolve =>
      setTimeout(() => resolve({ ...person(id, { display_name: 'Jane Doe' }), linked_demographics: [] }), 400)))
    const record = await within(panel).findByRole('button', { name: 'R002 South' })
    record.focus()
    fireEvent.click(record)
    await waitFor(() => expect(linkDatasetRow).toHaveBeenCalledWith(1, 1, 6, 22))
    const heading = within(panel).getByRole('heading', { level: 3, name: 'Linked Datasets' })
    await waitFor(() => expect(document.activeElement).toBe(heading), { timeout: 250 })
  })

  it('the landing does not ride a frame: it holds when a frame fires BEFORE React commits', async () => {
    // Driven live in Chrome, a `requestAnimationFrame` landing raced the commit
    // that removes the picker, saw the pressed record still there and stood down.
    // jsdom's frames are slow enough to hide that, so here a frame runs AT ONCE.
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 0 })
    try {
      linkDatasetRow.mockResolvedValue({})
      const panel = await openCensusPicker()
      const record = await within(panel).findByRole('button', { name: 'R002 South' })
      record.focus()
      fireEvent.click(record)
      await waitFor(() => expect(linkDatasetRow).toHaveBeenCalled())
      const heading = within(panel).getByRole('heading', { level: 3, name: 'Linked Datasets' })
      await waitFor(() => expect(document.activeElement).toBe(heading))
    } finally {
      raf.mockRestore()
    }
  })

  it('while the link runs the pressed record stays focusable — busy, not disabled', async () => {
    linkDatasetRow.mockReturnValue(new Promise(() => {}))
    const panel = await openCensusPicker()
    const record = await within(panel).findByRole('button', { name: 'R002 South' })
    record.focus()
    fireEvent.click(record)
    await waitFor(() => expect(record).toHaveAttribute('aria-disabled', 'true'))
    expect(record).not.toBeDisabled()
    expect(document.activeElement).toBe(record)
    fireEvent.click(record)
    // TanStack starts a mutation's request a turn AFTER `mutate`: counted
    // synchronously this passes with the guard deleted (mutation-proven, run 11).
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(linkDatasetRow).toHaveBeenCalledTimes(1)
  })

  it('a link refreshes the withdrawal summary, which lists what is linked', async () => {
    linkDatasetRow.mockResolvedValue({})
    const panel = await openCensusPicker()
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(1))
    fireEvent.click(await within(panel).findByRole('button', { name: 'R002 South' }))
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(2))
  })

  it('an unlink lands on the heading when its row goes, and refreshes the summary', async () => {
    const jane = person(1, { display_name: 'Jane Doe', dataset_rows: rowIn('Survey') })
    // The server's answer after the unlink: the row is gone from the detail.
    unlinkDatasetRow.mockImplementation(() => { jane.dataset_rows = []; return Promise.resolve({}) })
    renderPage([jane])
    // 🔴 The detail REFETCH lands well after a frame, as it does in Chrome — that
    // is when the row (and the focused Unlink) goes. Driven live, a landing made
    // one frame after the unlink saw the button still there, stood down, and focus
    // then fell to <body>; an instant mock hid it (run 11).
    getDetail.mockImplementation((_pid: number, id: number) => new Promise(resolve => {
      const p = [jane].find(x => x.id === id)!
      setTimeout(() => resolve({ ...p, linked_demographics: [] }), jane.dataset_rows.length ? 0 : 80)
    }))
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    const unlink = await within(panel).findByRole('button', { name: 'Unlink R001 in Survey' })
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(1))
    unlink.focus()
    fireEvent.click(unlink)
    await waitFor(() => expect(unlinkDatasetRow).toHaveBeenCalledWith(1, 1, 9))
    await waitFor(() => expect(withdrawalReport).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Unlink R001 in Survey' })).toBeNull())
    const heading = within(panel).getByRole('heading', { level: 3, name: 'Linked Datasets' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('while an unlink runs its button stays focusable — busy, not disabled — and refuses a second press', async () => {
    unlinkDatasetRow.mockReturnValue(new Promise(() => {}))
    renderPage([person(1, { display_name: 'Jane Doe', dataset_rows: rowIn('Survey') })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    const unlink = await within(panel).findByRole('button', { name: 'Unlink R001 in Survey' })
    unlink.focus()
    fireEvent.click(unlink)
    await waitFor(() => expect(unlink).toHaveAttribute('aria-disabled', 'true'))
    expect(unlink).not.toBeDisabled()
    expect(document.activeElement).toBe(unlink)
    fireEvent.click(unlink)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(unlinkDatasetRow).toHaveBeenCalledTimes(1)
  })

  it('POSITIVE CONTROL: focus that is somewhere real is not moved', async () => {
    linkDatasetRow.mockResolvedValue({})
    const panel = await openCensusPicker()
    const close = within(panel).getByRole('button', { name: 'Close participant details' })
    fireEvent.click(await within(panel).findByRole('button', { name: 'R002 South' }))
    close.focus()
    await waitFor(() => expect(linkDatasetRow).toHaveBeenCalled())
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(document.activeElement).toBe(close)
  })
})

describe('#1157 — a link the tool keeps is not offered for unlinking', () => {
  // Measured on a scratch install before this: the panel's Unlink on the participant
  // table answered 200, and the next refresh deleted the row and the value typed
  // into it. The server now refuses (409); the panel shows the server's sentence.
  it('a managed row shows the server’s sentence and no Unlink; an ordinary row keeps it', async () => {
    renderPage([person(1, {
      display_name: 'Jane Doe',
      dataset_rows: [...managedRowIn(), ...rowIn('Survey')],
    })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    await within(panel).findByRole('button', { name: 'Unlink R001 in Survey' })
    expect(within(panel).queryByRole('button', { name: /Unlink P001 in Participants/ })).toBeNull()
    expect(within(panel).getByText(LINK_REFUSAL)).toBeInTheDocument()
  })

  it('the link picker never offers a table the tool keeps', async () => {
    listDatasets.mockImplementation(() => Promise.resolve({
      datasets: [...DEFAULT_DATASETS, { id: 7, name: 'Participants', managed_kind: 'participants' }],
    }))
    renderPage([person(1, { display_name: 'Jane Doe' })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    const picker = await within(panel).findByRole('combobox', { name: 'Link Jane Doe to a dataset record' })
    const offered = Array.from(picker.querySelectorAll('option')).map(o => o.textContent)
    // Positive control: the ordinary ones ARE offered, so an empty picker cannot pass.
    expect(offered).toEqual(expect.arrayContaining(['Survey', 'Census']))
    expect(offered).not.toContain('Participants')
  })
})

describe('#1136 — the withdrawal section says what the software does', () => {
  it('names the withdrawal and its residual, never "no erase function"', async () => {
    renderPage([person(1, { display_name: 'Jane Doe', linked_documents: docAbout('Workplan') })])
    await screen.findByText('Jane Doe')
    fireEvent.click(row('Jane Doe'))
    const panel = await screen.findByRole('complementary', { name: 'Participant details' })
    await within(panel).findByText(/trace back to this participant/)
    expect(within(panel).queryByText(/no erase function|removed by hand/)).toBeNull()
    expect(within(panel).getByText(/cannot find their name in other people’s turns/)).toBeInTheDocument()
  })
})

describe('#1088 — the layout (technique only: jsdom computes no layout)', () => {
  const src = stripComments(readFileSync(join(SRC_DIR, 'pages/ParticipantsPage.tsx'), 'utf8'), 'ParticipantsPage.tsx')

  it('the table scrolls in its own box', () => {
    expect(src).toMatch(/<ScrollableTable[^>]*>\s*<table/)
  })

  it('the panel sits beside the table only when the CONTAINER has room, and is never capped by a window guess', () => {
    expect(src).toContain('@container/participants')
    expect(src).toMatch(/DETAIL_LAYOUT\s*=\s*\n?\s*'flex flex-col gap-4 @min-\[960px\]\/participants:flex-row/)
    expect(src).toMatch(/@min-\[960px\]\/participants:sticky/)
    expect(src).not.toContain('100vh-200px')
    expect(src).not.toMatch(/className="w-96 flex-shrink-0 sticky/)
  })
})
