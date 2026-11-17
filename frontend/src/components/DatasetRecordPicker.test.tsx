/**
 * #1053 — the participant panel's record picker, searching on the server.
 *
 * Rendered (jsdom can), so these replace the source-scan entry the old inline
 * picker had in `list-load-state-wiring.test.ts`. What is pinned: the three load
 * states and the two empty sentences; the debounce; the "old answer" treatment
 * while a new term loads; the count line's role and its link to the box; *Show
 * more* and where focus goes after it; the arrow keys; the refusal arm; and the
 * query key's prefix, which the shared link refresh depends on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { LinkableRow, LinkableRowsPage } from '@/lib/api'

const linkableRows = vi.fn()
vi.mock('@/lib/api', () => ({
  datasetsApi: { linkableRows: (...a: unknown[]) => linkableRows(...a) },
  retryUnanswered: () => false,
}))

import { DatasetRecordPicker } from './DatasetRecordPicker'
import { RECORD_PAGE_SIZE, RECORD_SEARCH_DEBOUNCE_MS } from '@/lib/linkable-rows'

afterEach(() => {
  cleanup()
  linkableRows.mockReset()
})

function rec(id: number, over: Partial<LinkableRow> = {}): LinkableRow {
  return {
    row_id: id, row_identifier: `R${String(id).padStart(3, '0')}`, linked_participant_id: null,
    linked_participant_name: null, display_values: [`Name ${id}`], matched: null, ...over,
  }
}

function page(rows: LinkableRow[], total = rows.length, over: Partial<LinkableRowsPage> = {}): LinkableRowsPage {
  return { rows, total, limit: RECORD_PAGE_SIZE, offset: 0, link_refusal: null, ...over }
}

let client: QueryClient
function renderPicker(over: Partial<Parameters<typeof DatasetRecordPicker>[0]> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    projectId: 1, datasetId: 6, datasetName: 'Census', onPick: vi.fn(), busy: false,
    linkError: null, onClose: vi.fn(), ...over,
  }
  // #1625: the open-dataset control is a router <Link> now, so it needs a router.
  const tree = (extra: Partial<typeof props> = {}) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DatasetRecordPicker {...props} {...extra} />
      </QueryClientProvider>
    </MemoryRouter>
  )
  const { rerender } = render(tree())
  return { ...props, rerender: (extra: Partial<typeof props>) => rerender(tree(extra)) }
}

const box = () => screen.getByRole('textbox', { name: 'Search Census records' })
const wait = (ms: number) => act(() => new Promise(r => setTimeout(r, ms)))

describe('#1053 — what the picker may claim, and when', () => {
  it('says it is loading, and makes no claim about the records, until the server answers', async () => {
    linkableRows.mockReturnValue(new Promise(() => {}))
    renderPicker()
    expect(await screen.findByText('Loading records…')).toBeInTheDocument()
    expect(screen.queryByText(/no records/i)).toBeNull()
    expect(box()).not.toHaveAttribute('aria-describedby')
  })

  it('says the LOAD failed, never that the dataset is empty', async () => {
    linkableRows.mockRejectedValue(new Error('boom'))
    renderPicker()
    expect(await screen.findByText("This dataset's records could not be loaded")).toBeInTheDocument()
    expect(screen.queryByText(/no records/i)).toBeNull()
  })

  it('POSITIVE CONTROL: an answered empty dataset says so', async () => {
    linkableRows.mockResolvedValue(page([]))
    renderPicker()
    // (The loading notice is a status too, until the answer replaces it.)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('This dataset has no records.'))
  })

  it('tells a search that matched nothing from an empty dataset, and echoes the term', async () => {
    linkableRows.mockImplementation((_p, _d, { q }) =>
      Promise.resolve(q ? page([]) : page([rec(1)])))
    renderPicker()
    await screen.findByRole('button', { name: 'R001 Name 1' })
    fireEvent.change(box(), { target: { value: 'zz' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No records in Census match “zz”.'))
  })

  it('the count line is the one status, and it describes the search box', async () => {
    linkableRows.mockResolvedValue(page([rec(1), rec(2)], 120))
    renderPicker()
    await screen.findByRole('button', { name: 'R001 Name 1' })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Showing 2 of 120 records. Search to find the others.')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(box()).toHaveAttribute('aria-describedby', status.id)
  })
})

describe('#1053 — the search', () => {
  it('asks the server once per pause in typing, with the trimmed term', async () => {
    linkableRows.mockResolvedValue(page([rec(1)]))
    renderPicker()
    await screen.findByRole('button', { name: 'R001 Name 1' })
    expect(linkableRows).toHaveBeenLastCalledWith(1, 6, { q: '', limit: RECORD_PAGE_SIZE, offset: 0 }, expect.anything())
    // Keystrokes a third of the pause apart: none of the partial terms is asked.
    fireEvent.change(box(), { target: { value: 'a' } })
    await wait(RECORD_SEARCH_DEBOUNCE_MS / 3)
    fireEvent.change(box(), { target: { value: 'an' } })
    await wait(RECORD_SEARCH_DEBOUNCE_MS / 3)
    fireEvent.change(box(), { target: { value: ' ana ' } })
    await wait(RECORD_SEARCH_DEBOUNCE_MS + 100)
    const terms = linkableRows.mock.calls.map(c => c[2].q)
    expect(terms).toEqual(['', 'ana'])
  })

  it('keeps the previous answer on screen while a new search loads, and says it is the old one', async () => {
    linkableRows.mockImplementation((_p, _d, { q }) =>
      q ? new Promise(() => {}) : Promise.resolve(page([rec(1), rec(2)], 120)))
    renderPicker()
    await screen.findByText('Show 50 more')
    fireEvent.change(box(), { target: { value: 'ana' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Searching…'))
    // The old rows stay (no flash), but nothing claims they answer "ana".
    expect(screen.getByRole('button', { name: 'R001 Name 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'R001 Name 1' }).parentElement).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText(/Show \d+ more/)).toBeNull()
    expect(screen.queryByText(/no records/i)).toBeNull()
  })

  it('keeps the ["linkable-rows", projectId] prefix the shared link refresh invalidates', async () => {
    linkableRows.mockResolvedValue(page([rec(1)]))
    renderPicker()
    await screen.findByRole('button', { name: 'R001 Name 1' })
    expect(client.getQueryCache().findAll({ queryKey: ['linkable-rows', 1] })).toHaveLength(1)
    linkableRows.mockClear()
    await act(() => client.invalidateQueries({ queryKey: ['linkable-rows', 1] }))
    expect(linkableRows).toHaveBeenCalledTimes(1)
  })

  it('shows which value matched, and a taken record says by whom', async () => {
    linkableRows.mockResolvedValue(page([
      rec(1, { matched: { column_id: 4, column_label: 'Marital status', excerpt: '…never married…' } }),
      rec(2, { linked_participant_id: 9, linked_participant_name: 'P009' }),
    ]))
    renderPicker()
    expect(await screen.findByRole('button', { name: 'R001 Name 1 matched in Marital status: …never married…' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'R002 Name 2 (already linked to P009)' })).toBeDisabled()
  })
})

describe('#1053 — Show more', () => {
  it('asks for the next page and moves focus to the first record it revealed that can be linked', async () => {
    const first = Array.from({ length: RECORD_PAGE_SIZE }, (_, i) => rec(i + 1))
    linkableRows.mockImplementation((_p, _d, { offset }) => Promise.resolve(offset === 0
      ? page(first, 53)
      : page([rec(51, { linked_participant_id: 3, linked_participant_name: 'P003' }), rec(52), rec(53)], 53, { offset })))
    renderPicker()
    const more = await screen.findByRole('button', { name: 'Show 3 more' })
    more.focus()
    fireEvent.click(more)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'R052 Name 52' })))
    expect(linkableRows).toHaveBeenLastCalledWith(1, 6, { q: '', limit: RECORD_PAGE_SIZE, offset: 50 }, expect.anything())
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('53 records.')
  })

  it('a next page that fails is said on the count line, and the button stays to try again', async () => {
    const first = Array.from({ length: RECORD_PAGE_SIZE }, (_, i) => rec(i + 1))
    linkableRows.mockImplementation((_p, _d, { offset }) =>
      offset === 0 ? Promise.resolve(page(first, 60)) : Promise.reject(new Error('down')))
    renderPicker()
    fireEvent.click(await screen.findByRole('button', { name: 'Show 10 more' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not be loaded. Press Show more'))
    expect(screen.getByRole('button', { name: 'Show 10 more' })).toBeInTheDocument()
  })
})

describe('#1053 — the keys', () => {
  async function openWith(rows: LinkableRow[]) {
    linkableRows.mockResolvedValue(page(rows))
    const props = renderPicker()
    await screen.findByRole('button', { name: /^R002/ })
    return props
  }

  it('ArrowDown from the box reaches the first record that can be linked; Up from it returns', async () => {
    await openWith([rec(1, { linked_participant_id: 9, linked_participant_name: 'P009' }), rec(2), rec(3)])
    box().focus()
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('R002 Name 2')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('R003 Name 3')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('R003 Name 3')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toHaveAccessibleName('R002 Name 2')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(box())
  })

  it('Space and Enter in the box are never claimed', async () => {
    await openWith([rec(1), rec(2)])
    expect(fireEvent.keyDown(box(), { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true)
  })

  it('Escape leaves the picker from the box or a record, and is marked so the panel stays', async () => {
    const props = await openWith([rec(1), rec(2)])
    expect(fireEvent.keyDown(box(), { key: 'Escape' })).toBe(false)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    const record = screen.getByRole('button', { name: 'R002 Name 2' })
    record.focus()
    expect(fireEvent.keyDown(record, { key: 'Escape' })).toBe(false)
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})

describe('#1053 — picking, busy and refused', () => {
  it('a press links that record; while busy it is aria-disabled and refuses a second press', async () => {
    linkableRows.mockResolvedValue(page([rec(1)]))
    const props = renderPicker()
    fireEvent.click(await screen.findByRole('button', { name: 'R001 Name 1' }))
    expect(props.onPick).toHaveBeenCalledWith(expect.objectContaining({ row_id: 1 }))
    cleanup()
    const busy = renderPicker({ busy: true })
    const record = await screen.findByRole('button', { name: 'R001 Name 1' })
    expect(record).toHaveAttribute('aria-disabled', 'true')
    expect(record).not.toBeDisabled()
    fireEvent.click(record)
    expect(busy.onPick).not.toHaveBeenCalled()
  })

  it('a refused link takes focus to its sentence before the refresh can disable the pressed record', async () => {
    // Driven: the record had been taken a moment before, the refresh disabled it,
    // and the focus it held fell to <body>.
    linkableRows.mockResolvedValue(page([rec(1), rec(2)]))
    const props = renderPicker()
    const record = await screen.findByRole('button', { name: 'R001 Name 1' })
    record.focus()
    props.rerender({ linkError: 'Row already linked to Cy' })
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it('POSITIVE CONTROL: a refusal leaves focus alone when it is in the search box', async () => {
    linkableRows.mockResolvedValue(page([rec(1)]))
    const props = renderPicker()
    await screen.findByRole('button', { name: 'R001 Name 1' })
    box().focus()
    props.rerender({ linkError: 'Row already linked to Cy' })
    await screen.findByRole('alert')
    await wait(20)
    expect(document.activeElement).toBe(box())
  })

  it("shows the server's sentence for a refused link as an alert", async () => {
    linkableRows.mockResolvedValue(page([rec(1)]))
    renderPicker({ linkError: 'Record R001 is already linked to P009.' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Record R001 is already linked to P009.')
  })

  it('a table the tool keeps shows its refusal and no search', async () => {
    linkableRows.mockResolvedValue(page([], 0, { link_refusal: 'Links are maintained for you.' }))
    renderPicker()
    const panel = await screen.findByText('Links are maintained for you.')
    expect(panel).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(within(document.body).queryByRole('status')).toBeNull()
  })
})

describe('the open-dataset control stays in the app (#1625, D238/D239)', () => {
  it('is a router link to the dataset, with no target, named without a new tab', async () => {
    linkableRows.mockResolvedValue(page([rec(1)]))
    renderPicker()
    const link = screen.getByRole('link', { name: 'Open dataset "Census"' })
    expect(link).toHaveAttribute('href', '/projects/1/datasets/6')
    // The desktop shell denies every new window, so a target here did nothing.
    expect(link).not.toHaveAttribute('target')
    await waitFor(() => expect(linkableRows).toHaveBeenCalled())
  })
})
