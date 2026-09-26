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
}))

vi.mock('@/lib/api', () => ({
  codingImportApi: { preview: api.preview, run: api.run },
  textCodingApi: { columns: api.columns },
  authApi: { listCoders: api.listCoders },
}))

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
  units_matched: 3,
  codes_matched: 1,
  coders: [{
    name: 'GPT-4o',
    row_count: 3,
    local_user_id: null,
    local_coder_type: null,
    local_archived: false,
    local_application_count: 0,
    local_machine_provenance: null,
  }],
  problems: [],
  reason_counts: {},
}

function setup() {
  api.columns.mockResolvedValue({ columns: [] })
  api.listCoders.mockResolvedValue([{ id: 1, username: 'Alice', coder_type: 'human' }])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CodingImport />
    </QueryClientProvider>,
  )
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
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing in this file matched/)
  })

  it('shows the units and codes it reached', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    await reachMapStep()
    expect(await screen.findByText('Units matched')).toBeInTheDocument()
    expect(screen.getByText('Codes matched')).toBeInTheDocument()
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
    ).toHaveAccessibleDescription(/already exists here with 0 codings/)
  })

  it('🔴 sends the model PROVENANCE with a machine it creates', async () => {
    setup()
    api.preview.mockResolvedValue(PREVIEW)
    api.run.mockResolvedValue({
      rows_read: 3, applied: 3, already_present: 0, selections: 0, replaced: 0,
      ratings_set: 0, coders_matched: 0, coders_created: 1, skipped: 0, problems: [],
    })
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
    api.run.mockResolvedValue({
      rows_read: 3, applied: 3, already_present: 0, selections: 0, replaced: 0,
      ratings_set: 0, coders_matched: 0, coders_created: 1, skipped: 0, problems: [],
    })
    await reachMapStep()
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    await waitFor(() => expect(api.run).toHaveBeenCalled())
    expect(api.run.mock.calls[0][2]).toEqual(api.preview.mock.calls[0][2])
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
  })
})

describe('where focus goes between steps (a11y sweep, 2026-09-23)', () => {
  // Measured in Chrome: both step-advancing buttons unmount themselves, so focus
  // fell to <body> at each transition, and a successful import raises no toast —
  // a keyboard or reader user pressed Import and heard nothing.
  const DONE = {
    rows_read: 4, applied: 3, already_present: 0, selections: 0, replaced: 0,
    ratings_set: 0, coders_matched: 0, coders_created: 1, skipped: 1,
    problems: [{ line: 4, reason: 'unit_not_found', detail: 'Nothing is identified by “nope”.' }],
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
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    const heading = await screen.findByRole('heading', { level: 2, name: /Step 3 of 3/ })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText('1 row was not imported')).toBeInTheDocument()
    expect(screen.queryByText(/will not be imported/)).not.toBeInTheDocument()
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
    api.run.mockResolvedValue({
      rows_read: 3, applied: 3, already_present: 0, selections: 0, replaced: 0,
      ratings_set: 0, coders_matched: 0, coders_created: 1, skipped: 0, problems: [],
    })
    await reachMapStep()
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
    expect(within(kind).getByRole('radio', { name: /A person/ })).toBeChecked()
    expect(within(kind).getByRole('radio', { name: /A machine/ })).not.toBeChecked()
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
      rows_read: 3, applied: 2, already_present: 0, selections: 0, replaced: 0,
      ratings_set: 0, coders_matched: 0, coders_created: 1, skipped: 1,
      problems: [{ line: 3, reason: 'code_inactive', detail: '“Risk” is inactive.' }],
    })
    await reachMapStep()
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
    fireEvent.click(screen.getByRole('button', { name: /^Import 3 codings$/ }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(
      expect.stringContaining('Say who these codings belong to'),
    ))
  })
})
