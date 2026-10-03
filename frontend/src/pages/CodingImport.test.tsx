/**
 * The bulk coding-import page (queue row 49).
 *
 * What these pin is the SEAM, not the arithmetic: that the same scope reaches
 * both calls, that a coder decision becomes the payload the server expects, and
 * that the two facts a researcher must not miss — "nothing matched" and "these
 * rows were skipped" — reach the screen.
 *
 * ⚠️ Radix `Select` cannot be driven in jsdom, so the column pickers are left at
 * their defaults and the segment arm (which needs no picker) carries the
 * end-to-end cases.
 *
 * ⚠️ **`fireEvent`, never `user-event` — it is NOT a dependency of this repo**,
 * and importing it is a trap the internal design notes already records
 * costing a run.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  run: vi.fn(),
  columns: vi.fn(),
  listCoders: vi.fn(),
  allColumns: vi.fn(),
  downloadBlob: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  codingImportApi: { preview: api.preview, run: api.run },
  textCodingApi: { columns: api.columns },
  authApi: { listCoders: api.listCoders },
  datasetsApi: { allColumns: api.allColumns },
}))
vi.mock('@/lib/api/download', () => ({ downloadBlob: api.downloadBlob }))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import CodingImport from './CodingImport'

afterEach(() => {
  cleanup()
  for (const fn of Object.values(api)) fn.mockReset()
  navigate.mockReset()
  toasts.error.mockReset()
})

const PREVIEW = {
  target_kind: 'segments' as const,
  column_id: null,
  rows_read: 3,
  will_apply: 3,
  units_in_file: 3,
  units_matched: 3,
  codes_in_file: 1,
  codes_matched: 1,
  grouped_passages: 0,
  coders: [{
    name: 'GPT-4o',
    row_count: 3,
    rows_to_apply: 3,
    local_user_id: null,
    local_coder_type: null,
    local_archived: false,
    local_application_count: 0,
    local_machine_provenance: null,
  }],
  problems: [],
  reason_counts: {},
}

let client: QueryClient

function setup(roster: object[] = [{ id: 1, username: 'Alice', coder_type: 'human' }]) {
  api.columns.mockResolvedValue({ columns: [] })
  api.allColumns.mockResolvedValue({ columns: [], total: 0 })
  api.listCoders.mockResolvedValue(roster)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CodingImport />
    </QueryClientProvider>,
  )
}

/** A finished import's body, with every field the page reads. */
const RESULT = {
  rows_read: 3, applied: 3, already_present: 0, selections: 0, replaced: 0,
  ratings_set: 0, coders_matched: 0, coders_created: 1, coders_unarchived: 0,
  skipped: 0, problems: [], reason_counts: {},
}

/**
 * A NEW coder has no kind until one is chosen (#1038 h) — so every test that
 * creates one and imports says which, as a researcher now must.
 */
function choosePerson() {
  fireEvent.click(screen.getByRole('radio', { name: /A person/ }))
}

/** The file input is `hidden`, so it is addressed directly rather than clicked. */
function upload(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

function csv(name = 'codings.csv') {
  return new File(['unit_id,coder,code\nseg-1,GPT-4o,Trust\n'], name, { type: 'text/csv' })
}

async function reachMapStep() {
  fireEvent.click(screen.getByLabelText(/A segment’s Unit ID/))
  upload(csv())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Check the file/ })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: /Check the file/ }))
  await screen.findByText(/Whose codings are these/)
}

describe('the upload step', () => {
  it('will not check a file until one is chosen', async () => {
    setup()
    expect(await screen.findByRole('button', { name: /Check the file/ })).toBeDisabled()
  })

  it('refuses a file the importer cannot read, by its own gate', async () => {
    setup()
    upload(new File(['x'], 'notes.xlsx', { type: 'application/vnd.ms-excel' }))
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('CSV'))
  })

  it('sends the DECLARED target kind, never a guess', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    await reachMapStep()
    await waitFor(() => expect(api.preview).toHaveBeenCalled())
    expect(api.preview.mock.calls[0][2]).toMatchObject({ targetKind: 'segments' })
  })
})

describe('the upload limit (#1007)', () => {
  it('turns away a file over 50 MB at selection, naming it, and never uploads it', async () => {
    setup()
    const big = csv('huge.csv')
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 + 1 })
    fireEvent.click(screen.getByLabelText(/A segment’s Unit ID/))
    upload(big)
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/“huge\.csv” .* was not added.*50 MB or smaller/))
    // POSITIVE control on the same screen: a file at the limit IS taken.
    expect(screen.queryByText('huge.csv')).not.toBeInTheDocument()
    const ok = csv('fine.csv')
    Object.defineProperty(ok, 'size', { value: 50 * 1024 * 1024 })
    upload(ok)
    expect(await screen.findByText('fine.csv')).toBeInTheDocument()
    expect(api.preview).not.toHaveBeenCalled()
  })

  it('states the limit before any file is chosen', async () => {
    setup()
    expect(await screen.findByText(/can import coding files of up to 50 MB each/)).toBeInTheDocument()
  })
})

describe('the mapping step', () => {
  it('🔴 SAYS when the file matched nothing', async () => {
    // A file addressed with the wrong key is not a coding problem, and the two
    // match counts are the only things on screen that can say so.
    setup()
    api.preview.mockResolvedValue({ ...PREVIEW, units_matched: 0, will_apply: 0 })
    await reachMapStep()
    expect(await screen.findByRole('alert')).toHaveTextContent(/None of the ids in this file matched/)
  })

  it('shows each half of the addressing against what the file named (#1004)', async () => {
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW, units_matched: 3, units_in_file: 500, codes_matched: 2, codes_in_file: 2,
    })
    await reachMapStep()
    const ids = (await screen.findByText('Ids found')).closest('div')!
    expect(ids).toHaveTextContent('3 of 500')
    expect(screen.getByText('Code names found').closest('div')).toHaveTextContent('2 of 2')
  })

  it('🔴 a WRONG KEY no longer reads as wrong codes: the code half is said on its own (#1004)', async () => {
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW, units_matched: 0, will_apply: 0, codes_matched: 1, codes_in_file: 1,
    })
    await reachMapStep()
    const alerts = await screen.findAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent(/ids/)
    expect(screen.getByText('Code names found').closest('div')).toHaveTextContent('1 of 1')
  })

  it('SAYS when none of the code names is a code here', async () => {
    setup()
    api.preview.mockResolvedValue({ ...PREVIEW, codes_matched: 0, codes_in_file: 4, will_apply: 0 })
    await reachMapStep()
    expect(await screen.findByRole('alert')).toHaveTextContent(/None of the code names/)
  })

  it('says how many passages a GROUP adds (#1031 a)', async () => {
    setup()
    api.preview.mockResolvedValue({ ...PREVIEW, grouped_passages: 2 })
    await reachMapStep()
    expect(await screen.findByText(/2 more passages will be coded because they are grouped/))
      .toBeInTheDocument()
  })

  it('defaults an unknown name to CREATE, and a known one to MATCH', async () => {
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      coders: [
        PREVIEW.coders[0],
        { ...PREVIEW.coders[0], name: 'Alice', local_user_id: 1, local_coder_type: 'human' },
      ],
    })
    await reachMapStep()
    const groups = screen.getAllByRole('group')
    const machineGroup = groups.find(g => g.textContent?.includes('GPT-4o'))!
    const aliceGroup = groups.find(g => g.textContent?.includes('Alice'))!
    expect(
      within(machineGroup).getByRole('radio', { name: /A new coder/ }),
    ).toBeChecked()
    expect(
      within(aliceGroup).getByRole('radio', { name: /An existing coder/ }),
    ).toBeChecked()
    // The picker carries the note about who that coder already is — the fact the
    // choice turns on — as its DESCRIPTION, not as a paragraph a reader moving
    // by form control never reaches (2026-09-23 sweep).
    expect(
      within(aliceGroup).getByRole('combobox', { name: 'Which coder' }),
    ).toHaveAccessibleDescription(/already exists, with 0 codings across your projects/)
  })

  it('🔴 sends the model PROVENANCE with a machine it creates', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue(RESULT)
    await reachMapStep()
    fireEvent.click(screen.getByRole('radio', { name: /A machine/ }))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-4o-2024-08-06' } })
    fireEvent.change(screen.getByLabelText('Settings'), { target: { value: 'temperature=0' } })
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))

    await waitFor(() => expect(api.run).toHaveBeenCalled())
    expect(api.run.mock.calls[0][3]).toEqual({
      'GPT-4o': {
        action: 'create',
        new_username: 'GPT-4o',
        coder_type: 'ai',
        machine_provenance: {
          model: 'gpt-4o-2024-08-06',
          parameters: { temperature: '0' },
        },
      },
    })
  })

  it('sends the SAME scope to the import as to the preview', async () => {
    // A different scope would apply the researcher's decisions to other units —
    // the shape `source_column_indices` carries on the dataset path (#973 (c)).
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue(RESULT)
    await reachMapStep()
    choosePerson()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    await waitFor(() => expect(api.run).toHaveBeenCalled())
    expect(api.run.mock.calls[0][2]).toEqual(api.preview.mock.calls[0][2])
  })

  it('🔴 LOCKS the scope while the file is being checked (#1038 h)', async () => {
    // A change made during the check reached the import while the screen showed
    // the preview of the old scope — the two calls must carry the same one.
    setup()
    let answer: (v: unknown) => void = () => {}
    api.preview.mockReturnValue(new Promise(resolve => { answer = resolve }))
    fireEvent.click(screen.getByLabelText(/A segment’s Unit ID/))
    upload(csv())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Check the file/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /Check the file/ }))
    await waitFor(() => expect(screen.getByLabelText(/A record in a dataset/)).toBeDisabled())
    expect(screen.getByLabelText(/A segment’s Unit ID/)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select file' })).toBeDisabled()
    // A file dropped meanwhile is not taken either.
    upload(csv('other.csv'))
    expect(screen.queryByText('other.csv')).not.toBeInTheDocument()
    answer(PREVIEW)
    expect(await screen.findByText(/Whose codings are these/)).toBeInTheDocument()
  })

  it('lists the rows that will not be imported, with their own sentence', async () => {
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      will_apply: 2,
      problems: [{ line: 4, reason: 'unit_not_found', detail: 'Nothing is identified by “nope”.' }],
      reason_counts: { unit_not_found: 1 },
    })
    await reachMapStep()
    expect(await screen.findByText('Nothing is identified by “nope”.')).toBeInTheDocument()
    expect(screen.getByText(/1 row will not be imported/)).toBeInTheDocument()
    // The summary is WORDS, not the reason's slug.
    expect(screen.getByText('1 no such passage or record')).toBeInTheDocument()
  })

  it('🔴 renders a BOUNDED problem list, and the whole list is a download away', async () => {
    // A wrong key refuses every row — up to 200,000 — and the table rendered all
    // of them (#1045's class: a list built in full, in the DOM).
    setup()
    const problems = Array.from({ length: 250 }, (_, i) => ({
      line: i + 2, reason: 'unit_not_found', detail: `Nothing is identified by “x${i}”.`,
    }))
    api.preview.mockResolvedValue({
      ...PREVIEW, will_apply: 0, units_matched: 0, problems, reason_counts: { unit_not_found: 250 },
    })
    await reachMapStep()
    expect(await screen.findByText('Showing the first 200 of 250.')).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(201)   // + the header row
    fireEvent.click(screen.getByRole('button', { name: /Download the list/ }))
    expect(api.downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, name] = api.downloadBlob.mock.calls[0]
    const text = await (blob as Blob).text()
    expect(text.trim().split('\r\n')).toHaveLength(251)            // every row, + header
    expect(name).toBe('codings - rows not imported.csv')
  })

  it('the capped table’s NAME counts as the note beside it does', async () => {
    // The caption wrote "3000" beside a note saying "3,000" (a11y-name-sweep run 9).
    setup()
    const problems = Array.from({ length: 1500 }, (_, i) => ({
      line: i + 2, reason: 'unit_not_found', detail: `Nothing is identified by “x${i}”.`,
    }))
    api.preview.mockResolvedValue({
      ...PREVIEW, will_apply: 0, units_matched: 0, problems, reason_counts: { unit_not_found: 1500 },
    })
    await reachMapStep()
    const total = (1500).toLocaleString()
    expect(total).not.toBe('1500')   // the locale must separate thousands, or this proves nothing
    expect(await screen.findByRole('table', { name: new RegExp(`the first 200 of ${total}$`) }))
      .toBeInTheDocument()
  })
})

describe('a new coder’s kind (#1038 h)', () => {
  it('🔴 is NOT pre-chosen, and the import waits for it with the reason on screen', async () => {
    // It defaulted to "A person": one missed click made a model's labels a
    // colleague's votes, and a coder's kind cannot be changed afterwards.
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue(RESULT)
    await reachMapStep()
    const importButton = screen.getByRole('button', { name: /^Import 3 codings$/ })
    expect(importButton).toBeDisabled()
    expect(importButton).toHaveAccessibleDescription('Say whether “GPT-4o” is a person or a model.')
    choosePerson()
    expect(importButton).toBeEnabled()
    fireEvent.click(importButton)
    await waitFor(() => expect(api.run).toHaveBeenCalled())
    expect(api.run.mock.calls[0][3]['GPT-4o']).toMatchObject({ action: 'create', coder_type: 'human' })
  })

  it('refuses a new name longer than a coder’s name can be, before the request', async () => {
    setup()
    const long = 'x'.repeat(60)
    api.preview.mockResolvedValue({ ...PREVIEW, coders: [{ ...PREVIEW.coders[0], name: long }] })
    await reachMapStep()
    choosePerson()
    const importButton = screen.getByRole('button', { name: /^Import 3 codings$/ })
    expect(importButton).toHaveAccessibleDescription(/longer than 50 characters/)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Short' } })
    expect(importButton).toBeEnabled()
  })
})

describe('an archived coder (#1031 c)', () => {
  const ROSTER = [
    { id: 1, username: 'Alice', coder_type: 'human' },
    { id: 5, username: 'Old run', coder_type: 'ai', archived: true },
  ]
  const ARCHIVED_MATCH = {
    ...PREVIEW,
    coders: [{
      ...PREVIEW.coders[0], name: 'Old run', local_user_id: 5,
      local_coder_type: 'ai', local_archived: true,
    }],
  }

  it('🔴 is SHOWN in the picker, said to be archived, and offered back', async () => {
    // The picker listed the ACTIVE roster only, so a pre-selected archived match
    // showed the placeholder — and the import wrote onto a coder hidden by
    // default and left out of reliability and the model table.
    setup(ROSTER)
    api.preview.mockResolvedValue(ARCHIVED_MATCH)
    await reachMapStep()
    expect(await screen.findByRole('combobox', { name: 'Which coder' }))
      .toHaveTextContent('Old run · model (archived)')
    // The ARCHIVE-INCLUSIVE roster was asked for — the mock ignores arguments,
    // so without this a revert to the active roster would still pass.
    expect(api.listCoders).toHaveBeenCalledWith(true)
    const back = screen.getByRole('checkbox', { name: /Bring “Old run” back from the archive/ })
    expect(back).toBeChecked()
    expect(back).toHaveAccessibleDescription(/listed again/)
  })

  it('sends the choice either way, and says what leaving them archived means', async () => {
    setup(ROSTER)
    api.preview.mockResolvedValue(ARCHIVED_MATCH)
    api.run.mockResolvedValue({ ...RESULT, coders_unarchived: 1 })
    await reachMapStep()
    fireEvent.click(await screen.findByRole('checkbox', { name: /Bring “Old run” back/ }))
    expect(screen.getByRole('checkbox', { name: /Bring “Old run” back/ }))
      .toHaveAccessibleDescription(/hidden by default and left out of reliability/)
    fireEvent.click(screen.getByRole('checkbox', { name: /Bring “Old run” back/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    await waitFor(() => expect(api.run).toHaveBeenCalled())
    expect(api.run.mock.calls[0][3]['Old run'])
      .toEqual({ action: 'match', target_user_id: 5, unarchive: true })
    expect(await screen.findByText('Coders brought back')).toBeInTheDocument()
  })

  it('names a MODEL as a model, and what that means for its codings', async () => {
    setup(ROSTER)
    api.preview.mockResolvedValue(ARCHIVED_MATCH)
    await reachMapStep()
    expect(await screen.findByRole('combobox', { name: 'Which coder' }))
      .toHaveAccessibleDescription(/is a model: its codings are compared on the Model comparison tab/)
  })
})

describe('two names onto one coder (#1039 i)', () => {
  it('says so beside each, before the import rather than after', async () => {
    // Both rows arrive pointing at coder 1 (a Radix Select cannot be driven in
    // jsdom, so the two drafts are seeded through the preview's own matches);
    // the rule itself is `namesSharingACoder`, unit-tested beside it.
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      coders: [
        { ...PREVIEW.coders[0], name: 'Alice', local_user_id: 1, local_coder_type: 'human' },
        { ...PREVIEW.coders[0], name: 'alice', local_user_id: 1, local_coder_type: 'human' },
      ],
    })
    await reachMapStep()
    const pickers = await screen.findAllByRole('combobox', { name: 'Which coder' })
    expect(pickers).toHaveLength(2)
    expect(pickers[0]).toHaveAccessibleDescription(/“alice” also goes to this coder/)
    expect(pickers[1]).toHaveAccessibleDescription(/“Alice” also goes to this coder/)
    expect(pickers[0]).toHaveAccessibleDescription(/neither row is imported/)
  })

  it('🔴 the picker’s note is ONE text node, so the space between its sentences cannot drop out', async () => {
    // As sibling JSX fragments, the space was a text node of its own, and Chrome
    // left it out of the tree once the second sentence arrived after the first:
    // "…across your projects.“Model A” also goes…" (a11y-name-sweep run 9). jsdom
    // computes the space either way, so the MECHANISM is what this pins.
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      coders: [
        { ...PREVIEW.coders[0], name: 'Alice', local_user_id: 1, local_coder_type: 'human' },
        {
          ...PREVIEW.coders[0], name: 'alice', local_user_id: 1, local_coder_type: 'human',
          local_application_count: 1,
        },
      ],
    })
    await reachMapStep()
    const pickers = await screen.findAllByRole('combobox', { name: 'Which coder' })
    const note = (i: number) => document.getElementById(pickers[i].getAttribute('aria-describedby')!)!
    expect(note(0).childNodes).toHaveLength(1)
    expect(note(0).textContent).toBe(
      'A coder called “Alice” already exists, with 0 codings across your projects. '
      + '“alice” also goes to this coder — where the names disagree about a passage, neither row is imported.',
    )
    // …and one coding is one CODING.
    expect(note(1).textContent).toMatch(/^A coder called “alice” already exists, with 1 coding across/)
  })
})

describe('the id column (#1032 b)', () => {
  it('waits for the coded column, and says why', async () => {
    setup()
    api.columns.mockResolvedValue({
      columns: [{ column_id: 11, dataset_id: 2, dataset_name: 'Posts', column_name: 'text',
        column_text: 'Text', column_type: 'open_text', sequence_order: 1,
        total_rows: 3, non_empty_rows: 3, coded_rows: 0 }],
    })
    const trigger = await screen.findByRole('combobox', { name: /What are the ids in your file/ })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAccessibleDescription(/Choose the column being coded first/)
  })
})

describe('after the import', () => {
  it('🔴 marks EVERY query of the project stale, not the derived-count list (#1038 d)', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue(RESULT)
    client.setQueryData(['code-frequencies', 1, 'x'], { any: 1 })
    client.setQueryData(['text-coding-texts', 1], { any: 1 })
    client.setQueryData(['code-frequencies', 2], { any: 1 })   // another project
    await reachMapStep()
    choosePerson()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    await screen.findByText('Import finished')
    expect(client.getQueryState(['code-frequencies', 1, 'x'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['text-coding-texts', 1])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['code-frequencies', 2])?.isInvalidated).toBe(false)
  })
})

describe('where focus goes between steps (a11y sweep, 2026-09-23)', () => {
  // Measured in Chrome: both step-advancing buttons unmount themselves, so focus
  // fell to <body> at each transition, and a successful import raises no toast —
  // a keyboard or reader user pressed Import and heard nothing.
  const DONE = {
    ...RESULT, rows_read: 4, skipped: 1,
    problems: [{ line: 4, reason: 'unit_not_found', detail: 'Nothing is identified by “nope”.' }],
    reason_counts: { unit_not_found: 1 },
  }

  it('does NOT take focus when the page opens — under StrictMode, as the app runs', async () => {
    // POSITIVE control for the two below: the heading exists from the start, so
    // their focus assertions are about the TRANSITION, not about the mount.
    // 🔴 StrictMode is the point: it runs the mount effect twice, and the first
    // version of this fix passed without it and took focus on arrival in the app.
    api.columns.mockResolvedValue({ columns: [] })
    api.listCoders.mockResolvedValue([{ id: 1, username: 'Alice', coder_type: 'human' }])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <StrictMode>
        <QueryClientProvider client={client}><CodingImport /></QueryClientProvider>
      </StrictMode>,
    )
    const heading = await screen.findByRole('heading', { level: 2, name: /Step 1 of 3/ })
    expect(document.activeElement).not.toBe(heading)
  })

  it('lands on the next step’s heading after "Check the file"', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    await reachMapStep()
    const heading = screen.getByRole('heading', { level: 2, name: /Step 2 of 3/ })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('lands on the result after the import, and says what was NOT imported in the past tense', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue(DONE)
    await reachMapStep()
    choosePerson()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    const heading = await screen.findByRole('heading', { level: 2, name: /Step 3 of 3/ })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText('1 row was not imported')).toBeInTheDocument()
    expect(screen.queryByText(/will not be imported/)).not.toBeInTheDocument()
    // The finished screen carries the reason summary too — it passed `{}` before.
    expect(screen.getByText('1 no such passage or record')).toBeInTheDocument()
  })
})

describe('the exits', () => {
  it('🔴 every exit names a FIXED destination — none is history-relative', async () => {
    // The header Back was `navigate(-1)`: on the mapping step it sat above a
    // second "Back" that meant "previous step" while it meant "leave and discard",
    // and opened from a link it left the app. Cancel now goes somewhere named.
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(navigate).toHaveBeenCalledWith('/projects/1/overview')
    expect(navigate).not.toHaveBeenCalledWith(-1)
  })

  it('the mapping step has exactly ONE Back, and it returns to the upload step', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    await reachMapStep()
    const backs = screen.getAllByRole('button', { name: /^Back$/ })
    expect(backs).toHaveLength(1)
    fireEvent.click(backs[0])
    expect(await screen.findByRole('button', { name: /Check the file/ })).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('the finish offers the analysis where the codings can be seen, then a plain exit', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue(RESULT)
    await reachMapStep()
    choosePerson()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Qualitative Analysis' }))
    expect(navigate).toHaveBeenLastCalledWith('/projects/1/analysis/qualitative')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(navigate).toHaveBeenLastCalledWith('/projects/1/overview')
    expect(navigate).not.toHaveBeenCalledWith(-1)
  })
})

describe('what the upload step says about itself', () => {
  it('says WHY "Check the file" is off, and stops saying it once it is on', async () => {
    setup()
    const button = await screen.findByRole('button', { name: /Check the file/ })
    expect(button).toHaveAccessibleDescription('Choose a file to continue.')
    fireEvent.click(screen.getByLabelText(/A segment’s Unit ID/))
    upload(csv())
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).not.toHaveAccessibleDescription()
    expect(screen.queryByText('Choose a file to continue.')).not.toBeInTheDocument()
  })

  it('names the missing column on the dataset arm', async () => {
    setup()
    upload(csv())
    expect(
      await screen.findByText('Choose which column these codings are on.'),
    ).toBeInTheDocument()
  })
})

describe('the coder rows', () => {
  const SPACED = 'gpt-4o zero-shot run 2'

  it('🔴 no control id is built from the coder NAME — a typed string is not an id', async () => {
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      coders: [{ ...PREVIEW.coders[0], name: SPACED }],
    })
    await reachMapStep()
    fireEvent.click(screen.getByRole('radio', { name: /A machine/ }))
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id)
    expect(ids.length).toBeGreaterThan(4)
    for (const id of ids) expect(id).not.toMatch(/\s/)
    // …and every label still reaches its control.
    expect(screen.getByLabelText('Name')).toHaveValue(SPACED)
    expect(screen.getByLabelText('Model')).toBeInTheDocument()
    expect(screen.getByLabelText('Prompt').tagName).toBe('TEXTAREA')
  })

  it('"Kind" is a labelled GROUP, so the two radios say what they choose', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    await reachMapStep()
    const kind = screen.getByRole('group', { name: 'Kind' })
    // Neither is pre-chosen (#1038 h) — see "a new coder's kind" above.
    expect(within(kind).getByRole('radio', { name: /A person/ })).not.toBeChecked()
    expect(within(kind).getByRole('radio', { name: /A machine/ })).not.toBeChecked()
    fireEvent.click(within(kind).getByRole('radio', { name: /A machine/ }))
    expect(within(kind).getByRole('radio', { name: /A machine/ })).toBeChecked()
  })

  it('🔴 the note under "Kind" DESCRIBES both radios — it is the only place the choice is said to be permanent', async () => {
    // A reader moving by form control never met it (a11y-name-sweep run 9).
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    await reachMapStep()
    const kind = screen.getByRole('group', { name: 'Kind' })
    for (const name of [/A person/, /A machine/]) {
      expect(within(kind).getByRole('radio', { name }))
        .toHaveAccessibleDescription(/never do\. This cannot be changed later\./)
    }
  })

  it('two rows never share a radio group', async () => {
    // Radio groups are formed by `name` across the document; a collision would
    // let choosing for one coder un-check the other.
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      coders: [PREVIEW.coders[0], { ...PREVIEW.coders[0], name: 'Claude' }],
    })
    await reachMapStep()
    const names = new Set(
      [...document.querySelectorAll('input[type="radio"]')].map(r => (r as HTMLInputElement).name),
    )
    // Two rows × (action + kind) = four distinct groups.
    expect(names.size).toBe(4)
  })
})

describe('the result', () => {
  it('🔴 reports a PARTIAL failure rather than looking like a success', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue({
      ...RESULT, applied: 2, skipped: 1,
      problems: [{ line: 3, reason: 'code_inactive', detail: '“Risk” is inactive.' }],
      reason_counts: { code_inactive: 1 },
    })
    await reachMapStep()
    choosePerson()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))

    expect(await screen.findByText('Import finished')).toBeInTheDocument()
    expect(screen.getByText('Rows skipped')).toBeInTheDocument()
    expect(screen.getByText('“Risk” is inactive.')).toBeInTheDocument()
  })

  it('shows the server’s own reason when the import is refused', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockRejectedValue({
      response: { data: { detail: 'Say who these codings belong to before importing: “GPT-4o”.' } },
    })
    await reachMapStep()
    choosePerson()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(
      expect.stringContaining('Say who these codings belong to'),
    ))
  })
})

describe('a name with nothing to import (found by driving)', () => {
  it('says so, starts at "Do not import these", and asks nothing of it', async () => {
    setup()
    api.preview.mockResolvedValue({
      ...PREVIEW,
      coders: [
        PREVIEW.coders[0],
        { ...PREVIEW.coders[0], name: 'Model B', row_count: 2, rows_to_apply: 0 },
      ],
    })
    await reachMapStep()
    const groups = screen.getAllByRole('group')
    const b = groups.find(g => g.querySelector('legend')?.textContent?.startsWith('Model B'))!
    expect(b.querySelector('legend')).toHaveTextContent('Model B · 2 rows, none can be imported')
    expect(within(b).getByRole('radio', { name: /Do not import these/ })).toBeChecked()
    choosePerson()   // GPT-4o's — the only kind asked for
    expect(screen.getByRole('button', { name: /^Import 3 codings$/ })).toBeEnabled()
  })
})
